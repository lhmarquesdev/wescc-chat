// Integrações com Jira e Microsoft Teams no chat: estado de integrations.me, chamadas à API e os modais pedidos
// pelas respostas efêmeras, pelo menu da mensagem e pelo cabeçalho da sala.
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { useEffect } from 'react';
import type { EphemeralModal, IntegrationsMe, JiraAssignable, JiraCreateInput, JiraCreateMeta, JiraIssueSnapshot, JiraProjectRef, JiraSearchResult, JiraStatusCategory, JiraTypeKind, ExternalPresence, LinkedAccount, MessageMeeting } from '@shared/integrations';
import { EPHEMERAL_API_ENDPOINTS } from '@shared/integrations';
import type { IconName } from '../components/icons';
import { confirmDialog } from '../components/ui';
import { api, ApiError, getCredentials } from './api';

// ---------- integrations.me ----------

interface IntegrationsState {
  me: IntegrationsMe | null;
  presence: Record<string, ExternalPresence>;
}

// Estado de GET integrations.me (zustand próprio; store.ts não muda). Zerado no logout e recarregado no login.
export const useIntegrations: UseBoundStore<StoreApi<IntegrationsState>> = create<IntegrationsState>(() => ({ me: null, presence: {} }));

const CACHE_MS = 60_000;
let loadedAt = 0;
let inflight: Promise<IntegrationsMe | null> | null = null;
// Cada logout troca a geração: uma resposta que chega depois não grava o estado da pessoa anterior.
let generation = 0;
// Pedidos forçados seguidos (permissões e papéis mudando em sequência): só o último grava, nunca uma resposta mais velha.
let latest = 0;

// Cache de 60 s; force ignora.
export async function loadIntegrationsMe(force?: boolean): Promise<IntegrationsMe | null> {
  if (!getCredentials()) return null;
  if (!force && useIntegrations.getState().me && Date.now() - loadedAt < CACHE_MS) return useIntegrations.getState().me;
  if (inflight && !force) return inflight;
  const gen = generation;
  const seq = ++latest;
  const p = api
    .get<IntegrationsMe & { success?: boolean }>('integrations.me')
    .then((r) => {
      if (gen !== generation) return null;
      if (seq !== latest) return useIntegrations.getState().me;
      const { success: _ok, ...me } = r;
      loadedAt = Date.now();
      useIntegrations.setState({ me: me as IntegrationsMe });
      return me as IntegrationsMe;
    })
    .catch(() => (gen === generation ? useIntegrations.getState().me : null))
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

// Logout: apaga me e presence.
export function resetIntegrations(): void {
  generation++;
  loadedAt = 0;
  inflight = null;
  useIntegrations.setState({ me: null, presence: {} });
  useModal.setState({ req: null });
}

// Carrega na primeira montagem.
export function useIntegrationsMe(): IntegrationsMe | null {
  const me = useIntegrations((s) => s.me);
  useEffect(() => {
    void loadIntegrationsMe();
  }, []);
  return me;
}

export function setExternalPresence(userId: string, p: ExternalPresence | null): void {
  const presence = { ...useIntegrations.getState().presence };
  if (p) presence[userId] = p;
  else delete presence[userId];
  useIntegrations.setState({ presence });
}

// ---------- API ----------

const tzOffset = () => -new Date().getTimezoneOffset();

export const jiraApi = {
  search: (q: string, mode: 'text' | 'jql' = 'text', nextPageToken?: string | null) => api.get<JiraSearchResult>('jira.search', { q, mode, nextPageToken: nextPageToken || undefined }),
  issue: (key: string) => api.get<{ issue: JiraIssueSnapshot; canComment: boolean; canAssign: boolean }>('jira.issue', { key }),
  projects: (forCreate: boolean, query?: string) => api.get<{ projects: JiraProjectRef[]; identity: 'user' | 'integration' }>('jira.projects', { forCreate: forCreate ? 'true' : undefined, query: query || undefined }),
  createMeta: (projectKey: string, roomId: string) => api.get<JiraCreateMeta>('jira.createMeta', { projectKey, roomId }),
  create: (input: JiraCreateInput) => api.post<{ issue: JiraIssueSnapshot; messageId?: string }>('jira.issue.create', input as unknown as Record<string, unknown>),
  comment: async (key: string, text: string, isPublic?: boolean): Promise<void> => {
    await api.post('jira.issue.comment', { key, text, public: isPublic === true });
  },
  assign: (key: string, accountId: string | 'me' | null) => api.post<{ issue: JiraIssueSnapshot }>('jira.issue.assign', { key, accountId }),
  // 409 error-jira-share-confirm: a issue é restrita; shareIssueWithConfirm pergunta e reenvia com confirmed.
  share: (key: string, roomId: string, tmid?: string | null, confirmed?: boolean) => api.post<{ messageId: string }>('jira.issue.share', { key, roomId, tmid: tmid || undefined, confirmed: confirmed === true || undefined }),
  assignable: (p: { key?: string; projectKey?: string; query: string }) => api.get<{ users: JiraAssignable[] }>('jira.users.assignable', { key: p.key || undefined, projectKey: p.projectKey || undefined, query: p.query }),
  removePreview: async (messageId: string): Promise<void> => {
    await api.post('jira.preview.remove', { messageId });
  },
  linkToken: (email: string, token: string, expiresAt?: string | null) => api.post<{ account: LinkedAccount }>('jira.link.token', { email, token, expiresAt: expiresAt || null }),
  linkStart: (returnTo: string) => api.post<{ url: string }>('jira.link.start', { returnTo }),
};

// Compartilhar com a confirmação de §4.8: pergunta com confirmDialog quando o servidor responde 409.
// Devolve o id da mensagem, ou null quando a pessoa desiste. Outros erros sobem para quem chamou (toast).
export async function shareIssueWithConfirm(key: string, roomId: string, tmid?: string | null): Promise<string | null> {
  try {
    return (await jiraApi.share(key, roomId, tmid)).messageId;
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 409 || e.errorType !== 'error-jira-share-confirm') throw e;
    const ok = await confirmDialog({ title: `Compartilhar ${key} na sala?`, body: e.message, confirmLabel: 'Compartilhar mesmo assim' });
    if (!ok) return null;
    return (await jiraApi.share(key, roomId, tmid, true)).messageId;
  }
}

export const teamsApi = {
  // tmid (opcional, além do contrato do §8.1): /teams dentro de um tópico anuncia a reunião no próprio tópico.
  create: (p: { roomId: string; subject?: string; minutes?: number; tmid?: string | null }) => api.post<{ meeting: MessageMeeting; messageId: string }>('msteams.meeting.create', { ...p, tzOffset: tzOffset() }),
  link: (p: { roomId: string; url: string; subject?: string; tmid?: string | null }) => api.post<{ meeting: MessageMeeting; messageId: string }>('msteams.meeting.link', p),
  scheduleLink: (p: { roomId: string; subject: string; startsAt: string; minutes: number; includeMembers: boolean }) => api.post<{ url: string; skipped: string[] }>('msteams.meeting.scheduleLink', { ...p, tzOffset: tzOffset() }),
  presence: (userIds: string[]) => api.get<{ presence: Record<string, ExternalPresence> }>('msteams.presence', { userIds }),
};

export const linkedApi = {
  list: () => api.get<{ accounts: LinkedAccount[] }>('integrations.linked.list'),
  remove: async (provider: 'jira' | 'microsoft'): Promise<void> => {
    await api.post('integrations.linked.remove', { provider });
  },
  update: (p: { provider: 'microsoft'; busySync: boolean }) => api.post<{ account: LinkedAccount }>('integrations.linked.update', p),
};

// ---------- Modais ----------

// Modais abertos por respostas efêmeras, pelo menu da mensagem e pelo cabeçalho da sala.
export interface IntegrationModalRequest {
  modal: EphemeralModal;
  rid: string;
  tmid?: string | null;
  messageId?: string | null;
  params?: Record<string, string>;
  ephemeralId?: string | null; // resposta efêmera que pediu o modal: sai quando o modal termina bem
}

const useModal = create<{ req: IntegrationModalRequest | null }>(() => ({ req: null }));

export function openIntegrationModal(req: IntegrationModalRequest): void {
  useModal.setState({ req });
}

export function useIntegrationModal(): [IntegrationModalRequest | null, () => void] {
  const req = useModal((s) => s.req);
  return [req, closeIntegrationModal];
}

function closeIntegrationModal() {
  useModal.setState({ req: null });
}

// ---------- Aparência ----------

export const JIRA_TYPE_ICON: Record<JiraTypeKind, IconName> = {
  bug: 'jira-type-bug',
  task: 'jira-type-task',
  story: 'jira-type-story',
  epic: 'jira-type-epic',
  subtask: 'jira-type-subtask',
  other: 'jira-type-other',
};

// Status pela forma e pelo texto, com cor semântica (nunca o acento). Sem .pill.info no design system, "em andamento"
// usa a pílula neutra com o círculo tracejado, e a barra neutra mais escura (--info é o próprio acento no design system).
export const JIRA_STATUS: Record<JiraStatusCategory, { pill: string; icon: IconName; bar: string }> = {
  new: { pill: 'pill', icon: 'jira-status-new', bar: 'var(--border-strong)' },
  indeterminate: { pill: 'pill', icon: 'jira-status-progress', bar: 'var(--fg-muted)' },
  done: { pill: 'pill ok', icon: 'success', bar: 'var(--ok)' },
};

// A mesma lista do servidor.
export function canRunApiAction(endpoint: string): boolean {
  return (EPHEMERAL_API_ENDPOINTS as readonly string[]).includes(endpoint);
}

// Jira ligado, use-jira e create-jira-issue (com ou sem conta vinculada).
export function jiraCreateAvailable(me: IntegrationsMe | null): boolean {
  return !!me && me.jira.enabled && me.jira.canUse && me.jira.canCreate;
}

// Teams ligado, modo ≠ off, start-msteams-meeting.
export function meetingAvailable(me: IntegrationsMe | null): boolean {
  return !!me && me.msteams.enabled && me.msteams.meetings !== 'off' && me.msteams.canMeet;
}

export function isIntegrationBot(me: IntegrationsMe | null, userId: string): boolean {
  return !!me && me.bots.includes(userId);
}

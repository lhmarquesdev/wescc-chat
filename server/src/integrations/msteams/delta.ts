// Modo leitura periódica (§5.4, D13): delta dos canais, só com o aceite por escrito do dono. A lista de mensagens
// (GET …/messages) nunca é lida em ciclo: a Microsoft só permite isso uma vez por dia.
import { ApiError } from '../../lib/errors';
import { getSetting } from '../../services/settings';
import { alertText, clearAlert, raiseAlert } from '../alerts';
import type { Lease } from '../runtime';
import { activity, markRule, mergeState, publishChanged } from '../state';
import { CONFIG_TEXT, getPolling, inboundMode, teamsOn } from './config';
import { graph, MsError } from './graph';
import { channelError, enabledInRows, getInState, processOrSkip, stateKey, type InRow, type InState } from './incoming';
import { changedAt } from './notifications';

const g = encodeURIComponent;
const SLACK_MS = 2 * 60_000;
const IDLE_MS = 3600_000;
const IDLE_EVERY_MS = 10 * 60_000;
const MAX_PAGES = 500; // trava de segurança contra um nextLink que nunca acaba
const FAIL_ALERT_MS = 3600_000;

const time = (v: unknown) => {
  const t = v ? new Date(String(v)).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};
const byCreated = (a: any, b: any) => (time(a?.createdDateTime) ?? 0) - (time(b?.createdDateTime) ?? 0);

export const pollMinutes = () => Math.min(15, Math.max(1, Math.round(Number(getSetting('MSTeams_Poll_Minutes') ?? 2)) || 2));
export const pollIntervalMs = () => pollMinutes() * 60_000;
export const pollEnabled = () => teamsOn() && inboundMode() === 'polling';

// Regra sem mensagem nova há 1 hora: lida a cada 10 minutos até voltar a ter movimento.
function skipIdle(rule: InRow, st: InState): boolean {
  const last = time(st.lastEventAt) ?? time(rule.config.startedAt) ?? 0;
  if (Date.now() - last < IDLE_MS) return false;
  const read = time(st.lastReadAt);
  return read !== null && Date.now() - read < IDLE_EVERY_MS;
}

const serviceProblem = (e: unknown) => e instanceof ApiError && (e.errorType === 'error-msteams-service' || e.errorType === 'error-msteams-not-configured');

async function ruleFailed(rule: InRow, e: unknown) {
  const err = e instanceof MsError && (e.msStatus === 403 || e.msStatus === 404) ? await channelError(e) : e;
  const text = (err instanceof Error ? err.message : String(err)) || 'Erro desconhecido.';
  await markRule(rule.id, false, text);
  const st = await getInState(rule.id);
  const since = st.subFailingSince ?? new Date().toISOString();
  if (!st.subFailingSince) await mergeState(stateKey(rule.id), { subFailingSince: since });
  if (Date.now() - new Date(since).getTime() > FAIL_ALERT_MS) {
    const where = rule.config.channelName ? `${rule.config.teamName} › ${rule.config.channelName}` : rule.config.teamName || rule.name;
    await raiseAlert({
      key: `msteams.in:${rule.id}`,
      provider: 'msteams',
      tone: 'err',
      text: alertText(`As mensagens do canal ${where} não estão chegando ao chat`, text),
      href: '/admin/integrations/teams/recebimento',
      to: 'managers',
    }).catch(() => {});
  }
}

// 400/404 no primeiro delta: se o canal existe, este locatário não oferece a leitura por delta. true: parar a rodada.
async function deltaRefused(rule: InRow): Promise<boolean> {
  try {
    await graph('service', 'GET', `/teams/${g(rule.config.teamId)}/channels/${g(rule.config.channelId)}?$select=id`, undefined, { interactive: false, permission: 'Channel.ReadBasic.All' });
  } catch (e) {
    if (e instanceof MsError && (e.msStatus === 403 || e.msStatus === 404)) {
      await ruleFailed(rule, e);
      return false;
    }
    throw e;
  }
  await mergeState('msteams.polling', { unavailable: CONFIG_TEXT.pollingUnavailable });
  await activity({ provider: 'msteams', integrationId: rule.id, tone: 'err', text: CONFIG_TEXT.pollingUnavailable });
  for (const r of await enabledInRows()) await markRule(r.id, false, CONFIG_TEXT.pollingUnavailable);
  publishChanged('config');
  return true;
}

// Respostas de uma raiz que mudou: as 50 mais novas, só as que mudaram desde a última mensagem − 2 min.
async function readReplies(rule: InRow, rootId: string, since: number) {
  const r = await graph<any>(
    'service',
    'GET',
    `/teams/${g(rule.config.teamId)}/channels/${g(rule.config.channelId)}/messages/${g(rootId)}/replies?$top=50`,
    undefined,
    { interactive: false, permission: 'ChannelMessage.Read.All' },
  );
  const replies: any[] = (Array.isArray(r?.value) ? r.value : []).filter((x: any) => changedAt(x) >= since).sort(byCreated);
  for (const reply of replies) await processOrSkip(rule, reply, rootId);
}

// Uma regra: segue o delta até o deltaLink e só então grava o link (uma falha no meio relê o mesmo conjunto).
// true: a leitura periódica ficou indisponível e a rodada para.
export async function pollRule(rule: InRow, lease: Lease): Promise<boolean> {
  const st = await getInState(rule.id);
  const first = !st.deltaLink;
  const startedAt = time(rule.config.startedAt) ?? 0;
  const lastEvent = time(st.lastEventAt);
  const since = Math.max(startedAt, lastEvent !== null ? lastEvent - SLACK_MS : startedAt);
  let link =
    st.deltaLink ??
    `/teams/${g(rule.config.teamId)}/channels/${g(rule.config.channelId)}/messages/delta?$filter=${g(`lastModifiedDateTime gt ${new Date(since).toISOString()}`)}&$top=50`;
  const items: any[] = [];
  let deltaLink: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    let r: any;
    try {
      r = await graph<any>('service', 'GET', link, undefined, { interactive: false, permission: 'ChannelMessage.Read.All' });
    } catch (e) {
      if (e instanceof MsError && [400, 404, 410].includes(e.msStatus ?? 0)) {
        if (first) return deltaRefused(rule);
        // O link guardado venceu: a próxima rodada recomeça da última mensagem.
        await mergeState(stateKey(rule.id), { deltaLink: null });
        return false;
      }
      throw e;
    }
    if (Array.isArray(r?.value)) items.push(...r.value);
    const next = typeof r?.['@odata.nextLink'] === 'string' ? r['@odata.nextLink'] : null;
    if (next) {
      link = next;
      await lease.renew();
      continue;
    }
    deltaLink = typeof r?.['@odata.deltaLink'] === 'string' ? r['@odata.deltaLink'] : null;
    break;
  }

  // Uma mensagem que o chat recusa de vez fica na atividade e a leitura segue até gravar o deltaLink (processOrSkip).
  for (const m of items.sort(byCreated)) {
    await processOrSkip(rule, m, null);
    if (rule.config.replies && !m?.deletedDateTime && m?.id) await readReplies(rule, String(m.id), since);
  }
  await mergeState(stateKey(rule.id), { deltaLink: deltaLink ?? st.deltaLink ?? null, lastReadAt: new Date().toISOString(), subFailingSince: null });
  if (st.subFailingSince) await clearAlert(`msteams.in:${rule.id}`).catch(() => {});
  return false;
}

export async function pollTeams(lease: Lease): Promise<void> {
  if (!pollEnabled()) return;
  const polling = await getPolling();
  if (!polling.acceptedAt || polling.unavailable) return;
  for (const rule of await enabledInRows()) {
    const st = await getInState(rule.id);
    if (skipIdle(rule, st)) continue;
    await lease.renew();
    try {
      if (await pollRule(rule, lease)) return;
    } catch (e) {
      await ruleFailed(rule, e);
      // Conta de serviço parada ou conexão desfeita: as outras regras falhariam igual.
      if (serviceProblem(e)) throw e;
    }
  }
}


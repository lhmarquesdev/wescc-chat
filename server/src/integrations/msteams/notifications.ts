// Modo notificações (§5.4, D13): assinaturas do Microsoft Graph, a rota /hooks/msteams/:token, renovação e a
// recuperação depois de falhas (uma leitura de até 50 mensagens, no máximo uma vez por hora por regra).
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { many, one, query } from '../../db/pool';
import { ApiError } from '../../lib/errors';
import { randomToken, sha256 } from '../../lib/ids';
import { getSecret, integrationsPaused, keyReady } from '../../lib/secrets';
import { alertText, clearAlert, raiseAlert } from '../alerts';
import { enqueue, PermanentError, type JobRow } from '../jobs';
import type { Lease } from '../runtime';
import { activity, markRule, mergeState, once } from '../state';
import { inboundMode, notificationsTarget, presenceOn, setInboundChangeHandler, teamsOn } from './config';
import { graph, MsError, toJobError } from './graph';
import {
  channelError,
  enabledInRows,
  getInRow,
  getInState,
  listInRows,
  mirrorDelete,
  processOrSkip,
  processTeamsMessage,
  setSubscriptionHooks,
  stateKey,
  type InConfig,
  type InRow,
} from './incoming';
import { setServiceLinkedHandler } from './serviceAccount';

export const NOTIFY_TEXT = {
  mismatch: 'Chegou uma notificação do Microsoft 365 que não confere.',
  notReady: 'As notificações do Microsoft 365 não estão disponíveis neste endereço.',
  presenceFailed: (detail: string) => `Não foi possível renovar a assinatura de presença do Teams: ${detail}`,
};

const SUB_MS = 55 * 60_000;
const RENEW_WITHIN_MS = 15 * 60_000;
const FAIL_ALERT_MS = 3600_000;
const CATCHUP_EVERY_MS = 3600_000;
const SLACK_MS = 2 * 60_000;

export type SubPurpose = 'messages' | 'presence';

export interface SubRow {
  id: string;
  purpose: SubPurpose;
  integration_id: string | null;
  resource: string;
  client_state_hash: string;
  expires_at: string;
  last_notified_at: string | null;
}

const g = encodeURIComponent;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest();
const sameHash = (a: string, b: string) => crypto.timingSafeEqual(sha(a), sha(b));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)) || 'Erro desconhecido.';

export const messagesResource = (c: Pick<InConfig, 'teamId' | 'channelId'>) => `/teams/${c.teamId}/channels/${c.channelId}/messages`;

// ---------- Assinaturas ----------

// Cria a assinatura (conta de serviço). O clientState vai só para o Graph; no banco fica o hash.
export async function createSubscription(purpose: SubPurpose, resource: string, integrationId: string | null, o: { interactive?: boolean } = {}): Promise<SubRow> {
  const target = await notificationsTarget();
  if (!target.url) throw new PermanentError(target.problem ?? NOTIFY_TEXT.notReady);
  const clientState = randomToken(32);
  const wanted = new Date(Date.now() + SUB_MS);
  const r = await graph<any>(
    'service',
    'POST',
    '/subscriptions',
    {
      changeType: purpose === 'messages' ? 'created,updated,deleted' : 'updated',
      notificationUrl: target.url,
      lifecycleNotificationUrl: `${target.url}/lifecycle`,
      resource,
      expirationDateTime: wanted.toISOString(),
      clientState,
      includeResourceData: false,
    },
    { interactive: o.interactive ?? false, permission: purpose === 'messages' ? 'ChannelMessage.Read.All' : 'Presence.Read.All' },
  );
  const id = String(r?.id ?? '');
  if (!id) throw new PermanentError(NOTIFY_TEXT.notReady);
  const expires = r?.expirationDateTime && Number.isFinite(Date.parse(r.expirationDateTime)) ? new Date(r.expirationDateTime) : wanted;
  const row = await one(
    `INSERT INTO msteams_subscriptions (id, purpose, integration_id, resource, client_state_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET resource = EXCLUDED.resource, client_state_hash = EXCLUDED.client_state_hash, expires_at = EXCLUDED.expires_at
     RETURNING *`,
    [id, purpose, integrationId, resource, sha256(clientState), expires.toISOString()],
  );
  return row as SubRow;
}

// Apaga no Graph (erros ignorados: a assinatura vence sozinha em menos de 1 hora) e no banco.
export async function deleteSubscription(id: string): Promise<void> {
  await graph('service', 'DELETE', `/subscriptions/${g(id)}`, undefined, { interactive: false }).catch(() => {});
  await query(`DELETE FROM msteams_subscriptions WHERE id = $1`, [id]);
}

export async function deleteRuleSubscriptions(ruleId: string): Promise<void> {
  for (const s of await many(`SELECT id FROM msteams_subscriptions WHERE integration_id = $1`, [ruleId])) await deleteSubscription(s.id);
}

async function deleteAll(purpose: SubPurpose): Promise<void> {
  for (const s of await many(`SELECT id FROM msteams_subscriptions WHERE purpose = $1`, [purpose])) await deleteSubscription(s.id);
}

export async function renewSubscription(id: string): Promise<string> {
  const until = new Date(Date.now() + SUB_MS);
  const r = await graph<any>('service', 'PATCH', `/subscriptions/${g(id)}`, { expirationDateTime: until.toISOString() }, { interactive: false });
  const expires = r?.expirationDateTime && Number.isFinite(Date.parse(r.expirationDateTime)) ? new Date(r.expirationDateTime) : until;
  await query(`UPDATE msteams_subscriptions SET expires_at = $2 WHERE id = $1`, [id, expires.toISOString()]);
  return expires.toISOString();
}

// Uma assinatura viva por regra. true quando foi preciso criar (houve um intervalo sem notificações).
export async function ensureRuleSubscription(rule: InRow, o: { interactive?: boolean } = {}): Promise<boolean> {
  const resource = messagesResource(rule.config);
  const subs = await many(`SELECT * FROM msteams_subscriptions WHERE integration_id = $1 AND purpose = 'messages' ORDER BY expires_at DESC`, [rule.id]);
  const live = subs.find((s) => s.resource === resource && new Date(s.expires_at).getTime() > Date.now() + 60_000);
  for (const s of subs) if (s !== live) await deleteSubscription(s.id);
  if (live) return false;
  try {
    await createSubscription('messages', resource, rule.id, o);
  } catch (e) {
    if (e instanceof MsError && (e.msStatus === 403 || e.msStatus === 404)) throw await channelError(e);
    throw e;
  }
  return true;
}

// Leitura de recuperação na fila da regra (mantém o lugar entre as notificações). No máximo uma vez por hora.
export async function scheduleCatchup(rule: InRow): Promise<void> {
  if (!(await once(`msteams.catchup:${rule.id}`, CATCHUP_EVERY_MS))) return;
  await enqueue('msteams.catchup', { ruleId: rule.id }, { integrationId: rule.id, groupKey: `msteams.in:${rule.id}` });
}

const alertWhere = (rule: InRow) => (rule.config.channelName ? `${rule.config.teamName} › ${rule.config.channelName}` : rule.config.teamName || rule.name);

// Assinatura que não renova: erro na regra; depois de 1 hora, alerta para quem configura.
async function subFailed(rule: InRow, e: unknown) {
  const text = errText(e);
  await markRule(rule.id, false, text);
  const st = await getInState(rule.id);
  const since = st.subFailingSince ?? new Date().toISOString();
  if (!st.subFailingSince) await mergeState(stateKey(rule.id), { subFailingSince: since });
  if (Date.now() - new Date(since).getTime() > FAIL_ALERT_MS) {
    await raiseAlert({
      key: `msteams.in:${rule.id}`,
      provider: 'msteams',
      tone: 'err',
      text: alertText(`As mensagens do canal ${alertWhere(rule)} não estão chegando ao chat`, text),
      href: '/admin/integrations/teams/recebimento',
      to: 'managers',
    }).catch(() => {});
  }
}

async function subRecovered(rule: InRow) {
  const st = await getInState(rule.id);
  if (!st.subFailingSince) return;
  await mergeState(stateKey(rule.id), { subFailingSince: null });
  await clearAlert(`msteams.in:${rule.id}`).catch(() => {});
}

const serviceProblem = (e: unknown) => e instanceof ApiError && (e.errorType === 'error-msteams-service' || e.errorType === 'error-msteams-not-configured');

// Todas as regras ligadas com assinatura viva (troca para notificações, conta de serviço conectada de novo, boot).
export async function resubscribeAll(o: { catchup: boolean }): Promise<void> {
  if (!teamsOn() || inboundMode() !== 'notifications') return;
  for (const rule of await enabledInRows()) {
    try {
      const created = await ensureRuleSubscription(rule);
      await subRecovered(rule);
      if (created && o.catchup) await scheduleCatchup(rule);
    } catch (e) {
      await subFailed(rule, e);
      if (serviceProblem(e)) return;
    }
  }
}

// ---------- Renovação (a cada 5 minutos, sob lease) ----------

export async function renewAll(lease: Lease): Promise<void> {
  if (!teamsOn()) return;
  const mode = inboundMode();
  const rules = new Map((await listInRows()).map((r) => [r.id, r]));
  const subs = (await many(`SELECT * FROM msteams_subscriptions ORDER BY expires_at`)) as SubRow[];

  // Assinaturas que ninguém usa mais: regra removida ou desligada, modo trocado, presença desligada.
  for (const s of subs) {
    const rule = s.integration_id ? rules.get(s.integration_id) : null;
    const unused = s.purpose === 'messages' ? mode !== 'notifications' || !rule?.enabled : !presenceOn();
    if (unused) await deleteSubscription(s.id);
  }

  const live = (await many(`SELECT * FROM msteams_subscriptions ORDER BY expires_at`)) as SubRow[];
  for (const s of live) {
    if (new Date(s.expires_at).getTime() - Date.now() > RENEW_WITHIN_MS) continue;
    await lease.renew();
    const rule = s.integration_id ? rules.get(s.integration_id) ?? null : null;
    try {
      await renewSubscription(s.id);
      if (rule) await subRecovered(rule);
    } catch (e) {
      if (e instanceof MsError && e.msStatus === 404) {
        // O Graph apagou a assinatura: cria outra e lê o que passou.
        await query(`DELETE FROM msteams_subscriptions WHERE id = $1`, [s.id]);
        if (rule && s.purpose === 'messages') {
          try {
            await ensureRuleSubscription(rule);
            await subRecovered(rule);
            await scheduleCatchup(rule);
          } catch (err) {
            await subFailed(rule, err);
          }
        }
        continue;
      }
      if (rule) await subFailed(rule, e);
      else await activity({ provider: 'msteams', tone: 'err', text: NOTIFY_TEXT.presenceFailed(errText(e)), onceKey: 'msteams.presence.renew', oncePerMs: 3600_000 });
      if (serviceProblem(e)) return;
    }
  }

  // Regra sem assinatura viva (boot depois de uma parada, falha anterior): cria e recupera o intervalo.
  if (mode === 'notifications') {
    await lease.renew();
    await resubscribeAll({ catchup: true });
  }
}

// ---------- Rota /hooks/msteams/:token ----------

const WINDOW = 60_000;
const LIMIT = 600;
const hits = new Map<string, { n: number; since: number }>();
function over(key: string): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.since >= WINDOW) {
    if (hits.size > 5000) hits.clear();
    hits.set(key, { n: 1, since: now });
    return false;
  }
  h.n++;
  return h.n > LIMIT;
}

const LIFECYCLE_EVENTS = ['reauthorizationRequired', 'subscriptionRemoved', 'missed'];

// Ids de usuários numa notificação de presença: communications/presences('id').
function presenceIdOf(item: any): string | null {
  const fromData = item?.resourceData?.id;
  if (typeof fromData === 'string' && fromData) return fromData;
  const m = /presences\('([^']+)'\)/i.exec(String(item?.resource ?? ''));
  return m ? m[1] : null;
}

async function handleItems(items: any[]): Promise<void> {
  const subs = new Map<string, SubRow | null>();
  const touched = new Set<string>();
  const presenceIds = new Set<string>();
  let mismatch = false;
  for (const item of items.slice(0, 1000)) {
    const subId = typeof item?.subscriptionId === 'string' ? item.subscriptionId.slice(0, 200) : '';
    if (!subs.has(subId)) subs.set(subId, subId ? ((await one(`SELECT * FROM msteams_subscriptions WHERE id = $1`, [subId])) as SubRow | null) : null);
    const sub = subs.get(subId);
    const state = typeof item?.clientState === 'string' ? item.clientState : '';
    if (!sub || !sameHash(sha256(state), sub.client_state_hash)) {
      mismatch = true;
      continue;
    }
    touched.add(sub.id);
    const lifecycle = typeof item?.lifecycleEvent === 'string' ? item.lifecycleEvent : null;
    if (lifecycle) {
      if (!LIFECYCLE_EVENTS.includes(lifecycle)) continue;
      // Grupo próprio: renovar a assinatura não espera atrás das notificações da regra (uma delas presa em nova
      // tentativa segurava a renovação até a assinatura vencer).
      await enqueue(
        'msteams.lifecycle',
        { subscriptionId: sub.id, event: lifecycle },
        sub.integration_id ? { integrationId: sub.integration_id, groupKey: `msteams.life:${sub.integration_id}` } : { groupKey: 'msteams.life:presence' },
      );
      continue;
    }
    if (sub.purpose === 'presence') {
      const id = presenceIdOf(item);
      if (id) presenceIds.add(id);
      continue;
    }
    if (!sub.integration_id) continue;
    await enqueue(
      'msteams.notify',
      { ruleId: sub.integration_id, resource: String(item?.resource ?? '').slice(0, 1000), changeType: String(item?.changeType ?? '').slice(0, 40) },
      { integrationId: sub.integration_id, groupKey: `msteams.in:${sub.integration_id}` },
    );
  }
  if (presenceIds.size) await enqueue('msteams.presence', { ids: [...presenceIds].slice(0, 650) }, { groupKey: 'msteams.presence' });
  if (touched.size) await query(`UPDATE msteams_subscriptions SET last_notified_at = now() WHERE id = ANY($1)`, [[...touched]]);
  if (mismatch) await activity({ provider: 'msteams', tone: 'warn', text: NOTIFY_TEXT.mismatch, onceKey: 'msteams.notify.mismatch', oncePerMs: 3600_000 }).catch(() => {});
}

export function registerMsteamsHooks(app: FastifyInstance) {
  // Plugin encapsulado: corpo cru e limitado a 1 MB; resposta imediata, o trabalho fica na fila.
  app.register(async (sub) => {
    sub.removeAllContentTypeParsers();
    sub.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));
    const handler = async (req: any, reply: any) => {
      if (!teamsOn()) return reply.status(404).send({});
      await keyReady();
      if (integrationsPaused()) return reply.status(503).send({});
      const token = String(req.params?.token ?? '');
      const stored = await getSecret('msteams.notifyToken').catch(() => null);
      if (!stored || !sameHash(token, stored)) return reply.status(404).send({});
      if (over(`t:${token}`) || over(`ip:${req.ip}`)) return reply.status(429).send({});

      // Aperto de mão da assinatura: devolve o token como texto, só num caminho válido.
      const validation = (req.query ?? {}).validationToken;
      if (typeof validation === 'string') {
        if (!validation || validation.length > 1024) return reply.status(400).send({});
        return reply.status(200).header('content-type', 'text/plain; charset=utf-8').header('x-content-type-options', 'nosniff').send(validation);
      }

      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '');
      let body: any;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply.status(400).send({});
      }
      const items = Array.isArray(body?.value) ? body.value : [];
      await handleItems(items);
      return reply.status(202).send();
    };
    sub.post('/hooks/msteams/:token', { bodyLimit: 1024 * 1024 }, handler);
    sub.post('/hooks/msteams/:token/lifecycle', { bodyLimit: 1024 * 1024 }, handler);
  });
}

// ---------- Tarefas ----------

const time = (v: unknown) => {
  const t = v ? new Date(String(v)).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};
// Mudança mais recente de uma mensagem (criação, edição, exclusão, reação).
export const changedAt = (m: any) => Math.max(time(m?.createdDateTime) ?? 0, time(m?.lastEditedDateTime) ?? 0, time(m?.deletedDateTime) ?? 0, time(m?.lastModifiedDateTime) ?? 0);
const byCreated = (a: any, b: any) => (time(a?.createdDateTime) ?? 0) - (time(b?.createdDateTime) ?? 0);

// teams('…')/channels('…')/messages('…')[/replies('…')] (ou com barras) → as partes.
const RES_QUOTED = /^\/?teams\('([^']+)'\)\/channels\('([^']+)'\)\/messages\('([^']+)'\)(?:\/replies\('([^']+)'\))?$/i;
const RES_SLASH = /^\/?teams\/([^/]+)\/channels\/([^/]+)\/messages\/([^/]+)(?:\/replies\/([^/]+))?$/i;
export function parseMessageResource(resource: string): { teamId: string; channelId: string; messageId: string; replyId: string | null } | null {
  const m = RES_QUOTED.exec(resource) ?? RES_SLASH.exec(resource);
  if (!m) return null;
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  return { teamId: dec(m[1]), channelId: dec(m[2]), messageId: dec(m[3]), replyId: m[4] ? dec(m[4]) : null };
}

async function jobError(e: unknown): Promise<Error> {
  if (e instanceof MsError && e.msStatus === 403) return channelError(e);
  return toJobError(e);
}

// msteams.notify: relê a mensagem com a conta de serviço (a notificação não traz conteúdo) e processa.
export async function notifyJob(job: JobRow): Promise<void> {
  const p = job.payload ?? {};
  const rule = await getInRow(String(p.ruleId ?? ''));
  if (!rule || !rule.enabled || inboundMode() !== 'notifications') return;
  const res = parseMessageResource(String(p.resource ?? ''));
  if (!res) return;
  if (res.teamId.toLowerCase() !== rule.config.teamId.toLowerCase() || res.channelId !== rule.config.channelId) return;
  const teamsId = res.replyId ?? res.messageId;
  const rootId = res.replyId ? res.messageId : null;
  if (p.changeType === 'deleted') {
    await mirrorDelete(rule, teamsId);
    await markRule(rule.id, true);
    return;
  }
  const path = `/teams/${g(rule.config.teamId)}/channels/${g(rule.config.channelId)}/messages/${g(res.messageId)}${res.replyId ? `/replies/${g(res.replyId)}` : ''}`;
  let m: any;
  try {
    m = await graph<any>('service', 'GET', path, undefined, { interactive: false, permission: 'ChannelMessage.Read.All' });
  } catch (e) {
    if (e instanceof MsError && e.msStatus === 404) {
      await mirrorDelete(rule, teamsId);
      await markRule(rule.id, true);
      return;
    }
    throw await jobError(e);
  }
  await processTeamsMessage(rule, m, rootId);
}

// msteams.catchup: uma página (50 mensagens com as respostas), só o que mudou desde a última mensagem − 2 min.
export async function catchupJob(job: JobRow): Promise<void> {
  const rule = await getInRow(String(job.payload?.ruleId ?? ''));
  if (!rule || !rule.enabled || inboundMode() === 'off') return;
  const st = await getInState(rule.id);
  const since = Math.max(time(rule.config.startedAt) ?? 0, (time(st.lastEventAt) ?? 0) - SLACK_MS);
  let r: any;
  try {
    r = await graph<any>('service', 'GET', `/teams/${g(rule.config.teamId)}/channels/${g(rule.config.channelId)}/messages?$top=50&$expand=replies`, undefined, {
      interactive: false,
      permission: 'ChannelMessage.Read.All',
    });
  } catch (e) {
    throw await jobError(e);
  }
  const roots: any[] = (Array.isArray(r?.value) ? r.value : []).slice().sort(byCreated);
  // Uma mensagem recusada de vez não para a recuperação (processOrSkip).
  for (const root of roots) {
    if (changedAt(root) >= since) await processOrSkip(rule, root, null);
    if (!rule.config.replies || root?.deletedDateTime) continue;
    const replies: any[] = (Array.isArray(root?.replies) ? root.replies : []).filter((x: any) => changedAt(x) >= since).sort(byCreated);
    for (const reply of replies) await processOrSkip(rule, reply, String(root.id));
  }
  await mergeState(stateKey(rule.id), { catchupAt: new Date().toISOString() });
}

// Quem lida com a perda de notificações de presença (presence.ts registra).
let onPresenceMissed: (() => Promise<void>) | null = null;
export function setPresenceMissedHandler(fn: () => Promise<void>) {
  onPresenceMissed = fn;
}

// msteams.lifecycle: renovar a autorização, recriar a assinatura removida, recuperar notificações perdidas.
export async function lifecycleJob(job: JobRow): Promise<void> {
  const p = job.payload ?? {};
  const sub = (await one(`SELECT * FROM msteams_subscriptions WHERE id = $1`, [String(p.subscriptionId ?? '')])) as SubRow | null;
  if (!sub) return;
  const rule = sub.integration_id ? await getInRow(sub.integration_id) : null;
  try {
    if (p.event === 'reauthorizationRequired') {
      try {
        await renewSubscription(sub.id);
        return;
      } catch (e) {
        if (!(e instanceof MsError && e.msStatus === 404)) throw e;
        await query(`DELETE FROM msteams_subscriptions WHERE id = $1`, [sub.id]);
        if (rule?.enabled && sub.purpose === 'messages' && inboundMode() === 'notifications') {
          await ensureRuleSubscription(rule);
          await scheduleCatchup(rule);
        }
        return;
      }
    }
    if (p.event === 'subscriptionRemoved') {
      await query(`DELETE FROM msteams_subscriptions WHERE id = $1`, [sub.id]);
      if (sub.purpose === 'presence') return; // a próxima rodada da presença cria outra
      if (rule?.enabled && inboundMode() === 'notifications') {
        await ensureRuleSubscription(rule);
        await scheduleCatchup(rule);
      }
      return;
    }
    if (p.event === 'missed') {
      if (sub.purpose === 'presence') await onPresenceMissed?.();
      else if (rule?.enabled) await scheduleCatchup(rule);
    }
  } catch (e) {
    throw await jobError(e);
  }
}

// ---------- Ligações com config.ts, incoming.ts e serviceAccount.ts ----------

setSubscriptionHooks({
  async created(rule) {
    if (inboundMode() !== 'notifications') return;
    await ensureRuleSubscription(rule, { interactive: true });
    await subRecovered(rule);
  },
  async removed(ruleId) {
    await deleteRuleSubscriptions(ruleId);
  },
});

setInboundChangeHandler(async (from, to) => {
  if (from === 'notifications') await deleteAll('messages');
  if (from === 'polling') {
    // O link de delta guardado não vale para uma volta futura à leitura periódica depois de outro modo.
    for (const rule of await listInRows()) await mergeState(stateKey(rule.id), { deltaLink: null });
  }
  if (to === 'notifications') await resubscribeAll({ catchup: true });
});

setServiceLinkedHandler(async () => {
  await resubscribeAll({ catchup: true });
});

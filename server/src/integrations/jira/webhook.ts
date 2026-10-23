// POST /hooks/jira/:token: webhook do Jira Cloud (assinado com HMAC) e a tarefa que relê cada issue antes de avisar (§4.3).
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import type { FastifyInstance } from 'fastify';
import { jiraSiteAllowed } from '@shared/integrations';
import { query } from '../../db/pool';
import { integrationAllowedHosts } from '../../lib/safeFetch';
import { truncate } from '../../lib/text';
import { getSecret, integrationsPaused, keyReady } from '../../lib/secrets';
import { getSetting } from '../../services/settings';
import { internalAddress } from '../../oauth/login';
import { enqueue, PermanentError, type JobRow } from '../jobs';
import { activity, seen, setState } from '../state';
import { currentSite, integrationClient, JiraError, jiraOn, TtlCache, toJobError } from './client';
import { eventsMode } from './config';
import { commentRestricted, commentText, commentUrl, fromWebhook, ISSUE_FIELDS, otherJiraSite, pickIssue, type NormalizedJiraEvent } from './events';
import { notifyEvent } from './notify';
import { CONFIG_TEXT, notVisibleSkipped } from './texts';

// Portas em que o Jira Cloud entrega webhooks (a 80 nunca).
export const ATLASSIAN_WEBHOOK_PORTS = [443, 1880, 1881, 1882, 1883, 1884, 1885, 1886, 1887, 1888, 1889, 1890, 4044, 6017, 7990, 8060, 8080, 8085, 8089, 8090, 8443, 8444, 8900, 9420, 9520, 9900];

const dnsCache = new TtlCache<boolean>(60_000, 50);

// null quando o Jira Cloud consegue chamar este endereço: https, porta aceita e host que não é da rede interna.
export async function webhookProblem(site: string): Promise<string | null> {
  const problem = CONFIG_TEXT.webhookProblem(site);
  let u: URL;
  try {
    u = new URL(site);
  } catch {
    return problem;
  }
  if (u.protocol !== 'https:') return problem;
  if (!ATLASSIAN_WEBHOOK_PORTS.includes(u.port ? Number(u.port) : 443)) return problem;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) return internalAddress(host) ? problem : null;
  if (!host.includes('.') || host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return problem;
  let internal = dnsCache.get(host);
  if (internal === undefined) {
    try {
      const addrs = await dns.lookup(host, { all: true });
      internal = addrs.some((a) => internalAddress(a.address));
    } catch {
      internal = false; // sem resolução aqui não dá para afirmar que é interno
    }
    dnsCache.set(host, internal);
  }
  return internal ? problem : null;
}

// ---------- Limites por token do caminho (e por IP, só como reserva: X-Forwarded-For é aceito) ----------

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

// Uma entrega gravada (caminho, corpo e assinatura) poderia ser reenviada depois que as chaves vistas somem (7 dias):
// a identificação da entrega não entra no HMAC, mas o horário do corpo entra. As novas tentativas do Jira cabem
// com folga em 24 horas.
const MAX_AGE_MS = 24 * 3_600_000;
export function freshDelivery(timestamp: unknown, now = Date.now()): boolean {
  const ts = typeof timestamp === 'string' && /^\d{10,16}$/.test(timestamp) ? Number(timestamp) : timestamp;
  return typeof ts === 'number' && Number.isFinite(ts) && Math.abs(now - ts) <= MAX_AGE_MS;
}

const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest();
const sameSecret = (a: string, b: string) => crypto.timingSafeEqual(sha(a), sha(b));

let lastAtWrite = 0;

// Valores de um histórico (uma Descrição inteira, por exemplo) entram na fila cortados: o aviso só mostra um trecho.
const clip = (v: unknown) => (typeof v === 'string' ? truncate(v, 1000) : (v ?? null));
const trimItem = (it: any) => ({ field: clip(it?.field), fieldId: clip(it?.fieldId), from: clip(it?.from), fromString: clip(it?.fromString), to: clip(it?.to), toString: clip(it?.toString) });

// Só o necessário para a tarefa: a issue e o comentário são relidos com a conta da integração.
function trimBody(body: any) {
  const issue = body?.issue ?? {};
  return {
    webhookEvent: body?.webhookEvent,
    timestamp: body?.timestamp,
    user: body?.user ? { accountId: body.user.accountId, displayName: body.user.displayName } : undefined,
    issue: { id: issue.id, key: issue.key, fields: { security: issue.fields?.security ? { id: String(issue.fields.security.id ?? '1') } : null, project: issue.fields?.project ? { key: issue.fields.project.key } : null } },
    changelog: body?.changelog ? { id: body.changelog.id, items: (Array.isArray(body.changelog.items) ? body.changelog.items : []).slice(0, 200).map(trimItem) } : undefined,
    comment: body?.comment
      ? { id: body.comment.id, author: body.comment.author ? { accountId: body.comment.author.accountId, displayName: body.comment.author.displayName } : undefined, created: body.comment.created }
      : undefined,
  };
}

export function registerJiraWebhook(app: FastifyInstance) {
  // Plugin encapsulado: o corpo chega cru (Buffer), para conferir o HMAC sobre os bytes exatos.
  app.register(async (sub) => {
    sub.removeAllContentTypeParsers();
    sub.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    sub.post('/hooks/jira/:token', { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
      if (!jiraOn() || eventsMode() !== 'webhook') return reply.status(404).send({});
      await keyReady();
      if (integrationsPaused()) return reply.status(503).send({});
      const token = String((req.params as any).token ?? '');
      const stored = await getSecret('jira.webhookToken').catch(() => null);
      if (!stored || !sameSecret(token, stored)) return reply.status(404).send({});
      if (over(`t:${token}`) || over(`ip:${req.ip}`)) return reply.status(429).send({});

      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '');
      const secret = await getSecret('jira.webhookSecret').catch(() => null);
      const sig = String(req.headers['x-hub-signature'] ?? '');
      const expected = secret ? `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}` : '';
      if (!secret || !sig || !sameSecret(sig, expected)) {
        await activity({ provider: 'jira', tone: 'warn', text: CONFIG_TEXT.badSignature, onceKey: 'jira.webhook.signature', oncePerMs: 60_000 }).catch(() => {});
        return reply.status(401).send({});
      }

      let body: any;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply.status(400).send({});
      }
      // Antiga (ou sem horário): 200 para o Jira não tentar de novo, e nada entra na fila.
      if (!freshDelivery(body?.timestamp)) {
        await activity({ provider: 'jira', tone: 'warn', text: CONFIG_TEXT.staleDelivery, onceKey: 'jira.webhook.stale', oncePerMs: 3_600_000 }).catch(() => {});
        return reply.status(200).send({});
      }
      // Do webhook de outro Jira (o do site antigo, por exemplo): 200 para ele não tentar de novo, e nada entra na fila.
      const site = jiraSiteAllowed(String(getSetting('Jira_Site_Url') ?? ''), integrationAllowedHosts());
      const foreign = otherJiraSite(body?.issue?.self, 'origin' in site ? site.origin : null);
      if (foreign) {
        await activity({ provider: 'jira', tone: 'warn', text: CONFIG_TEXT.otherSiteDelivery(foreign), onceKey: `jira.webhook.other:${foreign}`, oncePerMs: 3_600_000 }).catch(() => {});
        return reply.status(200).send({});
      }
      const delivery = String(req.headers['x-atlassian-webhook-identifier'] ?? '').slice(0, 200) || null;
      if (delivery && (await seen('jira.delivery', delivery))) return reply.status(200).send({});
      try {
        await enqueue('jira.webhook', trimBody(body), { dedupeKey: `jira.webhook:${delivery ?? sha(raw).toString('hex')}` });
      } catch (e) {
        // Sem a tarefa na fila, o Jira precisa tentar de novo: a entrega não conta como vista.
        if (delivery) await query(`DELETE FROM integration_seen WHERE scope = 'jira.delivery' AND key = $1`, [delivery]).catch(() => {});
        throw e;
      }
      if (Date.now() - lastAtWrite > 60_000) {
        lastAtWrite = Date.now();
        await setState('jira.webhook.lastAt', { at: new Date().toISOString() }).catch(() => {});
      }
      return reply.status(200).send({});
    });
  });
}

// ---------- Tarefa jira.webhook: nada do corpo vira cartão (B6) ----------

const DAY = 86_400_000;

export async function webhookJob(job: JobRow): Promise<void> {
  const site = await currentSite();
  if ('problem' in site) throw new PermanentError(site.problem);
  const events = fromWebhook(job.payload, site.origin);
  if (!events.length) return;
  const client = await integrationClient({ job: true });
  for (const ev of events) {
    if (ev.kinds[0] !== 'deleted') {
      const ok = await reread(client, ev, site.origin);
      if (!ok) continue;
    }
    if (await seen('jira.event', ev.key)) continue;
    try {
      await notifyEvent(ev, site.origin);
    } catch (e) {
      await query(`DELETE FROM integration_seen WHERE scope = 'jira.event' AND key = $1`, [ev.key]).catch(() => {});
      throw e;
    }
  }
}

// Relê a issue (e o comentário) com a conta da integração; false quando ela não vê (nada é publicado).
// Sempre do Jira, sem cache: um webhook quer dizer que a issue acabou de mudar (pode ter ganhado nível de segurança),
// e o corpo de comment_created não traz fields.security.
async function reread(client: Awaited<ReturnType<typeof integrationClient>>, ev: NormalizedJiraEvent, origin: string): Promise<boolean> {
  let issue: any;
  try {
    issue = await client.get<any>(`/rest/api/3/issue/${encodeURIComponent(ev.issueId)}`, { fields: ISSUE_FIELDS });
    if (ev.comment) {
      const c = await client.get<any>(`/rest/api/3/issue/${encodeURIComponent(ev.issueId)}/comment/${encodeURIComponent(ev.comment.id)}`, { expand: 'properties' });
      const serviceDesk = issue?.fields?.project?.projectTypeKey === 'service_desk';
      ev.comment = { id: String(c.id ?? ev.comment.id), text: commentText(c.body), url: commentUrl(origin, String(issue.key ?? ev.issueKey), String(c.id ?? ev.comment.id)), restricted: commentRestricted(c, serviceDesk) };
    }
  } catch (e) {
    if (e instanceof JiraError && (e.jiraStatus === 404 || e.jiraStatus === 403)) {
      await activity({ provider: 'jira', tone: 'info', text: notVisibleSkipped(ev.issueKey), onceKey: `jira.notvisible:${ev.issueId}`, oncePerMs: DAY });
      return false;
    }
    throw toJobError(e);
  }
  ev.issue = pickIssue(issue);
  ev.issueKey = String(issue.key ?? ev.issueKey);
  ev.restricted = ev.restricted || !!issue?.fields?.security;
  return true;
}

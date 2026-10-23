import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FakeReply, FakeRequest, FakeServer } from './fake-http';
import { startFake } from './fake-http';

// Microsoft 365 falso para os testes do Teams: o endpoint de token do Entra (client_credentials, código + PKCE e
// refresh token rotativo), o Microsoft Graph v1.0 (conta, equipes, canais, mensagens com delta, assinaturas, usuários,
// reuniões e presença) e os gatilhos HTTP do Workflows. Um servidor só faz os três papéis: os testes põem fake.host em
// INTEGRATIONS_ALLOWED_HOSTS e MS_LOGIN_URL / MS_GRAPH_URL em fake.url. Tokens e ids são falsos (tok-teste-…).

export interface MsUser {
  id: string;
  displayName: string;
  mail: string | null;
  userPrincipalName: string;
}

export interface FakeChannel {
  id: string;
  displayName: string;
  membershipType: 'standard' | 'private' | 'shared';
  forbidden: boolean; // a conta de serviço não participa: 403
  team: FakeTeam;
  messages: FakeMessage[]; // raízes, da mais antiga para a mais nova
}

export interface FakeTeam {
  id: string;
  displayName: string;
  channels: FakeChannel[];
}

export interface FakeMessage {
  data: any; // o chatMessage do Graph
  seq: number; // última mudança (para o delta)
  channel: FakeChannel;
  root: FakeMessage | null;
  replies: FakeMessage[];
}

export interface FakeSubscription {
  id: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  lifecycleNotificationUrl: string | null;
  expirationDateTime: string;
  clientState: string;
  includeResourceData: boolean;
}

export interface FlowCall {
  flowId: string;
  card: any;
  authorization: string | null;
  at: number;
}

interface IssuedToken {
  kind: 'app' | 'service' | 'flow';
  aud: string;
}

export interface PostOptions {
  author?: MsUser;
  html?: string;
  fixture?: string; // fixtures/msteams/<nome>.json mesclado sobre a mensagem padrão
  vars?: Record<string, string>;
  at?: Date;
  patch?: Record<string, unknown>;
}

export interface FakeMicrosoft {
  server: FakeServer;
  url: string;
  host: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  appObjectId: string; // ID de objeto da entidade de serviço (oid do token do aplicativo)
  service: MsUser; // a conta de serviço
  appRoles: string[]; // permissões de aplicativo no token (roles)
  serviceScopes: string[]; // permissões delegadas no token da conta de serviço (scp)
  users: Map<string, MsUser>;
  teams: FakeTeam[];
  subscriptions: Map<string, FakeSubscription>;
  presences: Map<string, { availability: string; activity: string }>;
  meetings: { organizerId: string; body: any; id: string }[];
  deletedMeetings: string[];
  userFilters: string[]; // $filter recebidos em /users, como chegaram
  presenceRequests: string[][];
  refreshTokens: Set<string>;
  // Comportamentos ajustáveis pelos testes.
  appTokenFault: any | null; // resposta de erro do Entra para client_credentials (corpo JSON)
  refreshFault: any | null; // resposta de erro para refresh_token
  meetingPolicyBlocked: Set<string>; // organizadores sem a política de acesso de aplicativo
  deltaUnavailable: boolean; // o locatário não oferece delta de canais
  deltaPageSize: number | null; // força páginas menores que $top (testa @odata.nextLink)
  replyBumpsRoot: boolean; // uma resposta nova muda o lastModifiedDateTime da raiz (premissa do §0.5)
  validation: { from: string; to: string } | null; // aperto de mão das assinaturas: troca a origem pública pelo servidor de teste
  addUser(name: string, mail: string | null, upn?: string): MsUser;
  addTeam(name: string, channels: { name: string; membership?: FakeChannel['membershipType']; forbidden?: boolean }[]): FakeTeam;
  post(channel: FakeChannel, o?: PostOptions): FakeMessage;
  reply(root: FakeMessage, o?: PostOptions): FakeMessage;
  edit(m: FakeMessage, html: string): void;
  react(m: FakeMessage, emoji?: string): void;
  remove(m: FakeMessage): void;
  resourceOf(m: FakeMessage): string;
  notify(sub: FakeSubscription, m: FakeMessage, changeType?: 'created' | 'updated' | 'deleted', o?: { clientState?: string }): Promise<Response>;
  lifecycle(sub: FakeSubscription, event: 'reauthorizationRequired' | 'subscriptionRemoved' | 'missed'): Promise<Response>;
  presenceChanged(sub: FakeSubscription, userId: string): Promise<Response>;
  issueCode(p: { challenge: string; redirectUri: string; scope: string }): string;
  expireTokens(): void;
  flowUrl(id: string): string;
  flowCalls(id?: string): FlowCall[];
  flowAuth(id: string, mode: 'none' | 'entra'): void;
  flowReply(id: string, fn: ((req: FakeRequest) => FakeReply | Promise<FakeReply>) | null): void;
  graphCalls(match?: string | RegExp): FakeRequest[];
  tokenCalls(grant?: string): FakeRequest[];
  // Resposta forçada antes das rotas normais; devolve a função que a remove. null/undefined: segue normal.
  intercept(fn: (req: FakeRequest) => FakeReply | null | undefined): () => void;
  close(): Promise<void>;
}

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'msteams');
const cache = new Map<string, any>();

// Lê um JSON de fixtures/msteams e troca {{nome}} nos textos (o JSON nunca é montado por concatenação).
export function msFixture(name: string, vars: Record<string, string> = {}): any {
  if (!cache.has(name)) cache.set(name, JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')));
  const fill = (v: any): any => {
    if (typeof v === 'string') return v.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return fill(cache.get(name));
}

const GUID = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const graphError = (status: number, code: string, message: string): FakeReply => ({ status, body: { error: { code, message, innerError: { date: new Date().toISOString(), 'request-id': crypto.randomUUID() } } } });
const FLOW_AUDIENCE = 'https://service.flow.microsoft.com/';

let instances = 0;

export async function startFakeMicrosoft(): Promise<FakeMicrosoft> {
  const server = await startFake();
  const base = instances++ * 0x1000;
  const issued = new Map<string, IssuedToken>();
  const codes = new Map<string, { challenge: string; redirectUri: string; scope: string }>();
  const deltaTokens = new Map<string, { channel: FakeChannel; seq: number }>();
  const skipTokens = new Map<string, { channel: FakeChannel; items: FakeMessage[]; seq: number; size: number }>();
  const interceptors: ((req: FakeRequest) => FakeReply | null | undefined)[] = [];
  const flowConf = new Map<string, { auth: 'none' | 'entra'; reply: ((req: FakeRequest) => FakeReply | Promise<FakeReply>) | null }>();
  const flowLog: FlowCall[] = [];
  let seq = 0;
  let idSeq = 0;
  let lastAt = 0;
  let refreshSeq = 0;

  // Relógio que nunca repete o milissegundo: a ordem de criação fica estável.
  const stamp = (at?: Date) => {
    if (at) return at.toISOString();
    lastAt = Math.max(Date.now(), lastAt + 1);
    return new Date(lastAt).toISOString();
  };

  const m: FakeMicrosoft = {
    server,
    url: server.url,
    host: server.host,
    tenantId: GUID(base + 0x1),
    clientId: GUID(base + 0x2),
    clientSecret: 'tok-teste-segredo-do-aplicativo-123',
    appObjectId: GUID(base + 0x3),
    service: { id: GUID(base + 0x10), displayName: 'Conta de Serviço do Chat', mail: 'servico.chat@explorer-teste.com.br', userPrincipalName: 'servico.chat@explorer-teste.com.br' },
    appRoles: ['OnlineMeetings.ReadWrite.All', 'User.Read.All', 'Presence.Read.All'],
    serviceScopes: ['User.Read', 'Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Read.All', 'Presence.Read.All'],
    users: new Map(),
    teams: [],
    subscriptions: new Map(),
    presences: new Map(),
    meetings: [],
    deletedMeetings: [],
    userFilters: [],
    presenceRequests: [],
    refreshTokens: new Set(),
    appTokenFault: null,
    refreshFault: null,
    meetingPolicyBlocked: new Set(),
    deltaUnavailable: false,
    deltaPageSize: null,
    replyBumpsRoot: true,
    validation: null,

    addUser(name, mail, upn) {
      const u: MsUser = { id: GUID(base + 0x100 + m.users.size), displayName: name, mail, userPrincipalName: upn ?? mail ?? `${name.toLowerCase().replace(/\s+/g, '.')}@explorer-teste.com.br` };
      m.users.set(u.id, u);
      return u;
    },

    addTeam(name, channels) {
      const team: FakeTeam = { id: GUID(base + 0x200 + m.teams.length), displayName: name, channels: [] };
      for (const c of channels) {
        team.channels.push({
          id: `19:${crypto.randomBytes(12).toString('hex')}@thread.tacv2`,
          displayName: c.name,
          membershipType: c.membership ?? 'standard',
          forbidden: c.forbidden === true,
          team,
          messages: [],
        });
      }
      m.teams.push(team);
      return team;
    },

    post(channel, o = {}) {
      const msg = makeMessage(channel, null, o);
      channel.messages.push(msg);
      return msg;
    },

    reply(root, o = {}) {
      const msg = makeMessage(root.channel, root, o);
      root.replies.push(msg);
      if (m.replyBumpsRoot) {
        root.data.lastModifiedDateTime = msg.data.createdDateTime;
        root.seq = msg.seq;
      }
      return msg;
    },

    edit(msg, html) {
      const at = stamp();
      msg.data.body = { contentType: 'html', content: html };
      msg.data.lastEditedDateTime = at;
      touch(msg, at);
    },

    react(msg, emoji = 'like') {
      const at = stamp();
      msg.data.reactions = [...(msg.data.reactions ?? []), { reactionType: emoji, displayName: emoji, createdDateTime: at, user: { user: { id: GUID(base + 0x1ff), displayName: null, userIdentityType: 'aadUser' } } }];
      touch(msg, at);
    },

    remove(msg) {
      const at = stamp();
      msg.data.deletedDateTime = at;
      msg.data.body = { contentType: 'html', content: '' };
      msg.data.attachments = [];
      touch(msg, at);
    },

    resourceOf(msg) {
      const ch = msg.channel;
      const head = `teams('${ch.team.id}')/channels('${ch.id}')`;
      return msg.root ? `${head}/messages('${msg.root.data.id}')/replies('${msg.data.id}')` : `${head}/messages('${msg.data.id}')`;
    },

    async notify(sub, msg, changeType = 'created', o = {}) {
      const body = msFixture('notification-created', {
        subscriptionId: sub.id,
        changeType,
        clientState: o.clientState ?? sub.clientState,
        expires: sub.expirationDateTime,
        resource: m.resourceOf(msg),
        messageId: msg.data.id,
        tenantId: m.tenantId,
      });
      return deliver(sub.notificationUrl, body);
    },

    async lifecycle(sub, event) {
      const body = msFixture('notification-lifecycle', { subscriptionId: sub.id, expires: sub.expirationDateTime, tenantId: m.tenantId, clientState: sub.clientState, event });
      return deliver(sub.lifecycleNotificationUrl ?? sub.notificationUrl, body);
    },

    async presenceChanged(sub, userId) {
      const body = msFixture('notification-presence', { subscriptionId: sub.id, clientState: sub.clientState, expires: sub.expirationDateTime, userId, tenantId: m.tenantId });
      return deliver(sub.notificationUrl, body);
    },

    issueCode(p) {
      const code = `tok-teste-codigo-${crypto.randomBytes(8).toString('hex')}`;
      codes.set(code, p);
      return code;
    },

    expireTokens() {
      issued.clear();
    },

    flowUrl(id) {
      return `${server.url}/workflows/${id}/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=tok-teste-assinatura-${id}`;
    },
    flowCalls(id) {
      return flowLog.filter((c) => !id || c.flowId === id);
    },
    flowAuth(id, mode) {
      flowConf.set(id, { auth: mode, reply: flowConf.get(id)?.reply ?? null });
    },
    flowReply(id, fn) {
      flowConf.set(id, { auth: flowConf.get(id)?.auth ?? 'none', reply: fn });
    },

    graphCalls(match) {
      return server.calls.filter((c) => {
        if (!c.path.startsWith('/v1.0/')) return false;
        if (!match) return true;
        const p = decodedPath(c.path);
        return typeof match === 'string' ? p === match : match.test(p);
      });
    },
    tokenCalls(grant) {
      return server.calls.filter((c) => /\/oauth2\/v2\.0\/token$/.test(c.path) && (!grant || new URLSearchParams(c.body).get('grant_type') === grant));
    },

    intercept(fn) {
      interceptors.push(fn);
      return () => {
        const i = interceptors.indexOf(fn);
        if (i >= 0) interceptors.splice(i, 1);
      };
    },

    close: () => server.close(),
  };

  function makeMessage(channel: FakeChannel, root: FakeMessage | null, o: PostOptions): FakeMessage {
    const id = String(1792670000000 + base * 1000 + ++idSeq);
    const at = stamp(o.at);
    const author = o.author ?? { id: GUID(base + 0x1a0), displayName: 'Ana Souza', mail: null, userPrincipalName: '' };
    const vars = {
      id,
      at,
      teamId: channel.team.id,
      channelId: channel.id,
      channelIdEnc: encodeURIComponent(channel.id),
      tenantId: m.tenantId,
      authorId: author.id,
      authorName: author.displayName,
      ...(o.vars ?? {}),
    };
    const data = msFixture('message-root', vars);
    if (o.fixture) Object.assign(data, msFixture(o.fixture, vars));
    if (o.html !== undefined) data.body = { contentType: 'html', content: o.html };
    if (o.patch) Object.assign(data, clone(o.patch));
    if (root) {
      data.replyToId = root.data.id;
      data.webUrl = String(data.webUrl).replace(/parentMessageId=\d+/, `parentMessageId=${root.data.id}`);
    }
    return { data, seq: ++seq, channel, root, replies: [] };
  }

  function touch(msg: FakeMessage, at: string) {
    msg.data.lastModifiedDateTime = at;
    msg.seq = ++seq;
    if (msg.root && m.replyBumpsRoot) {
      msg.root.data.lastModifiedDateTime = at;
      msg.root.seq = msg.seq;
    }
  }

  // Entrega como o Graph faria: POST JSON no endereço da assinatura (com a origem pública trocada pela do teste).
  function localUrl(url: string) {
    return m.validation && url.startsWith(m.validation.from) ? `${m.validation.to}${url.slice(m.validation.from.length)}` : url;
  }
  async function deliver(url: string, body: unknown) {
    return fetch(localUrl(url), { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
  }

  // Aperto de mão: POST {url}?validationToken=…, resposta 200 text/plain com o token exato em até 10 s.
  async function validateEndpoint(url: string): Promise<boolean> {
    if (!m.validation) return true;
    const token = `Validation: tok-teste-validacao ${crypto.randomBytes(6).toString('hex')}`;
    try {
      const res = await fetch(`${localUrl(url)}?validationToken=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: '', signal: AbortSignal.timeout(10_000) });
      return res.status === 200 && /^text\/plain/i.test(res.headers.get('content-type') ?? '') && (await res.text()) === token;
    } catch {
      return false;
    }
  }

  // ---------- Tokens ----------

  function jwt(claims: Record<string, unknown>): string {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ typ: 'JWT', alg: 'none', kid: 'tok-teste' }));
    const body = b64url(JSON.stringify({ iss: `https://sts.windows.net/${m.tenantId}/`, tid: m.tenantId, iat: now, nbf: now, exp: now + 3600, jti: crypto.randomBytes(8).toString('hex'), ...claims }));
    return `${head}.${body}.${b64url('tok-teste-sem-assinatura')}`;
  }
  const tokenReply = (access: string, extra: Record<string, unknown> = {}): FakeReply => ({ body: { token_type: 'Bearer', expires_in: 3599, ext_expires_in: 3599, access_token: access, ...extra } });
  const entraError = (status: number, error: string, code: number, text: string): FakeReply => ({
    status,
    body: { error, error_description: `AADSTS${code}: ${text}`, error_codes: [code], timestamp: new Date().toISOString(), trace_id: GUID(0xe0), correlation_id: GUID(0xe1) },
  });

  function serviceAccess(scope: string): string {
    const token = jwt({ aud: '00000003-0000-0000-c000-000000000000', oid: m.service.id, upn: m.service.userPrincipalName, name: m.service.displayName, scp: m.serviceScopes.join(' '), appid: m.clientId, requested: scope });
    issued.set(token, { kind: 'service', aud: 'graph' });
    return token;
  }
  function newRefresh(): string {
    const rt = `tok-teste-refresh-${++refreshSeq}-${crypto.randomBytes(6).toString('hex')}`;
    m.refreshTokens.add(rt);
    return rt;
  }

  server.on('POST', /^\/[^/]+\/oauth2\/v2\.0\/token$/, (req) => {
    for (const fn of interceptors) {
      const r = fn(req);
      if (r) return r;
    }
    const form = new URLSearchParams(req.body);
    const tenant = decodeURIComponent(req.path.split('/')[1]);
    if (tenant !== m.tenantId) return entraError(400, 'invalid_request', 90002, `Tenant '${tenant}' not found.`);
    if (form.get('client_id') !== m.clientId) return entraError(400, 'unauthorized_client', 700016, `Application with identifier '${form.get('client_id')}' was not found in the directory.`);
    if (form.get('client_secret') !== m.clientSecret) return { status: 401, body: msFixture('token-error-7000215', { clientId: m.clientId }) };
    const grant = form.get('grant_type');
    const scope = form.get('scope') ?? '';
    if (grant === 'client_credentials') {
      if (m.appTokenFault) return { status: 400, body: m.appTokenFault };
      if (scope === 'https://graph.microsoft.com/.default') {
        const token = jwt({ aud: 'https://graph.microsoft.com', oid: m.appObjectId, appid: m.clientId, idtyp: 'app', roles: m.appRoles });
        issued.set(token, { kind: 'app', aud: 'graph' });
        return tokenReply(token);
      }
      // Recurso = escopo sem "/.default": com "//.default" o público sai com a barra final, com "/.default" sai sem.
      const flow = /^https:\/\/service\.flow\.microsoft\.com(\/?)\/\.default$/.exec(scope);
      if (flow) {
        const aud = flow[1] ? FLOW_AUDIENCE : 'https://service.flow.microsoft.com';
        const token = jwt({ aud, oid: m.appObjectId, appid: m.clientId, idtyp: 'app' });
        issued.set(token, { kind: 'flow', aud });
        return tokenReply(token);
      }
      return entraError(400, 'invalid_scope', 1002012, `The provided value for scope ${scope} is not valid.`);
    }
    if (grant === 'authorization_code') {
      const code = form.get('code') ?? '';
      const c = codes.get(code);
      if (!c) return entraError(400, 'invalid_grant', 70000, 'The provided authorization code is invalid or has expired.');
      codes.delete(code);
      const verifier = form.get('code_verifier') ?? '';
      if (!verifier || b64url(crypto.createHash('sha256').update(verifier).digest()) !== c.challenge) return entraError(400, 'invalid_grant', 501481, 'The Code_Verifier does not match the code_challenge supplied in the authorization request.');
      if (form.get('redirect_uri') !== c.redirectUri) return entraError(400, 'invalid_grant', 50148, 'The redirect_uri does not match the one used in the authorization request.');
      return tokenReply(serviceAccess(scope), { scope: m.serviceScopes.join(' '), refresh_token: newRefresh() });
    }
    if (grant === 'refresh_token') {
      if (m.refreshFault) return { status: 400, body: m.refreshFault };
      const rt = form.get('refresh_token') ?? '';
      if (!m.refreshTokens.has(rt)) return entraError(400, 'invalid_grant', 9002313, 'Invalid request. Request is malformed or invalid.');
      // Rotativo: o refresh token usado deixa de valer.
      m.refreshTokens.delete(rt);
      return tokenReply(serviceAccess(scope), { scope: m.serviceScopes.join(' '), refresh_token: newRefresh() });
    }
    return entraError(400, 'unsupported_grant_type', 70003, 'The app requested an unsupported grant type.');
  });

  // ---------- Graph ----------

  function decodedPath(p: string) {
    return p
      .split('/')
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      })
      .join('/');
  }

  const findTeam = (id: string) => m.teams.find((t) => t.id.toLowerCase() === id.toLowerCase()) ?? null;
  const messageOut = (msg: FakeMessage, withReplies = false) => {
    const d = clone(msg.data);
    if (withReplies) d.replies = [...msg.replies].reverse().map((r) => clone(r.data));
    return d;
  };
  const enc = encodeURIComponent;
  const deltaUrl = (ch: FakeChannel, q: string) => `${server.url}/v1.0/teams/${enc(ch.team.id)}/channels/${enc(ch.id)}/messages/delta?${q}`;

  function deltaPage(ch: FakeChannel, items: FakeMessage[], seqAtStart: number, size: number): FakeReply {
    const page = items.slice(0, size);
    const rest = items.slice(size);
    const body: any = { '@odata.context': `https://graph.microsoft.com/v1.0/$metadata#Collection(chatMessage)`, value: page.map((x) => messageOut(x)) };
    if (rest.length) {
      const st = `st-${crypto.randomBytes(6).toString('hex')}`;
      skipTokens.set(st, { channel: ch, items: rest, seq: seqAtStart, size });
      body['@odata.nextLink'] = deltaUrl(ch, `$skiptoken=${st}`);
    } else {
      const dt = `dt-${crypto.randomBytes(6).toString('hex')}`;
      deltaTokens.set(dt, { channel: ch, seq: seqAtStart });
      body['@odata.deltaLink'] = deltaUrl(ch, `$deltatoken=${dt}`);
    }
    return { body };
  }

  function delta(ch: FakeChannel, req: FakeRequest): FakeReply {
    if (m.deltaUnavailable) return graphError(404, 'NotFound', "Resource not found for the segment 'delta'.");
    const top = Math.max(1, Math.min(50, Number(req.query.$top ?? 20) || 20));
    const size = m.deltaPageSize ?? top;
    if (req.query.$skiptoken) {
      const st = skipTokens.get(req.query.$skiptoken);
      if (!st || st.channel !== ch) return graphError(400, 'BadRequest', 'Invalid skip token.');
      skipTokens.delete(req.query.$skiptoken);
      return deltaPage(ch, st.items, st.seq, st.size);
    }
    if (req.query.$deltatoken) {
      const dt = deltaTokens.get(req.query.$deltatoken);
      if (!dt || dt.channel !== ch) return graphError(410, 'SyncStateNotFound', 'The sync state generation is not found.');
      const items = ch.messages.filter((x) => x.seq > dt.seq).sort((a, b) => a.seq - b.seq);
      return deltaPage(ch, items, seq, size);
    }
    let items = [...ch.messages];
    const filter = req.query.$filter ?? '';
    if (filter) {
      const f = /^lastModifiedDateTime gt (\S+)$/.exec(filter.trim());
      if (!f || !Number.isFinite(Date.parse(f[1]))) return graphError(400, 'BadRequest', `Invalid filter clause: ${filter}`);
      const since = Date.parse(f[1]);
      items = items.filter((x) => Date.parse(x.data.lastModifiedDateTime) > since);
    }
    items.sort((a, b) => a.seq - b.seq);
    return deltaPage(ch, items, seq, size);
  }

  const SUB_MAX_MS = 60 * 60_000;
  const MESSAGES_RES = /^\/?teams\/([^/]+)\/channels\/([^/]+)\/messages$/;
  const PRESENCE_RES = /^\/?communications\/presences\?\$filter=id in \(('(?:[^']|'')+'(?:,'(?:[^']|'')+')*)\)$/;

  async function createSubscription(req: FakeRequest): Promise<FakeReply> {
    const b = req.json ?? {};
    const exp = Date.parse(String(b.expirationDateTime ?? ''));
    if (!Number.isFinite(exp) || exp <= Date.now() || exp > Date.now() + SUB_MAX_MS) return graphError(400, 'ExtensionError', 'Subscription expiration can only be 60 minutes in the future.');
    if (typeof b.notificationUrl !== 'string' || !/^https:\/\//.test(b.notificationUrl)) return graphError(400, 'ValidationError', 'NotificationUrl must be https.');
    if (typeof b.clientState !== 'string' || !b.clientState || b.clientState.length > 128) return graphError(400, 'ValidationError', 'clientState must have at most 128 characters.');
    if (b.includeResourceData !== false && b.includeResourceData !== undefined) return graphError(400, 'ValidationError', 'includeResourceData requires encryptionCertificate.');
    const resource = String(b.resource ?? '');
    const msg = MESSAGES_RES.exec(resource);
    if (msg) {
      if (b.changeType !== 'created,updated,deleted') return graphError(400, 'ValidationError', `Unexpected changeType ${b.changeType}.`);
      if (typeof b.lifecycleNotificationUrl !== 'string' || !/^https:\/\//.test(b.lifecycleNotificationUrl)) return graphError(400, 'ValidationError', 'lifecycleNotificationUrl is required.');
      const ch = findTeam(msg[1])?.channels.find((c) => c.id === msg[2]);
      if (!ch) return graphError(404, 'NotFound', 'Channel not found.');
      if (ch.forbidden) return graphError(403, 'Forbidden', 'Caller is not a member of the channel.');
    } else if (PRESENCE_RES.test(resource)) {
      if (b.changeType !== 'updated') return graphError(400, 'ValidationError', `Unexpected changeType ${b.changeType}.`);
    } else {
      return graphError(400, 'InvalidRequest', `Resource '${resource}' is not supported.`);
    }
    if (!(await validateEndpoint(b.notificationUrl)) || (b.lifecycleNotificationUrl && !(await validateEndpoint(b.lifecycleNotificationUrl)))) {
      return graphError(400, 'ValidationError', 'Subscription validation request failed. Response must exactly match validationToken query parameter.');
    }
    const sub: FakeSubscription = {
      id: crypto.randomUUID(),
      resource,
      changeType: b.changeType,
      notificationUrl: b.notificationUrl,
      lifecycleNotificationUrl: b.lifecycleNotificationUrl ?? null,
      expirationDateTime: new Date(exp).toISOString(),
      clientState: b.clientState,
      includeResourceData: false,
    };
    m.subscriptions.set(sub.id, sub);
    return {
      status: 201,
      body: { '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#subscriptions/$entity', ...sub, applicationId: m.clientId, creatorId: m.service.id, latestSupportedTlsVersion: 'v1_2', notificationUrlAppId: null },
    };
  }

  // $filter de /users: "campo eq 'valor'" ligados por "or", com '' dentro do valor.
  function usersFilter(filter: string): MsUser[] | null {
    const clauses = filter.split(/\s+or\s+(?=(?:mail|userPrincipalName)\s+eq\s+')/i);
    const parsed: { field: string; value: string }[] = [];
    for (const c of clauses) {
      const x = /^\s*(mail|userPrincipalName)\s+eq\s+'((?:[^']|'')*)'\s*$/i.exec(c);
      if (!x) return null;
      parsed.push({ field: x[1].toLowerCase() === 'mail' ? 'mail' : 'userPrincipalName', value: x[2].replace(/''/g, "'").toLowerCase() });
    }
    return [...m.users.values()].filter((u) => parsed.some((p) => String((u as any)[p.field] ?? '').toLowerCase() === p.value));
  }

  async function graphRoute(req: FakeRequest): Promise<FakeReply> {
    for (const fn of interceptors) {
      const r = fn(req);
      if (r) return r;
    }
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const tok = issued.get(auth);
    if (!tok || tok.kind === 'flow') return graphError(401, 'InvalidAuthenticationToken', 'Access token validation failure. Invalid audience.');
    const seg = decodedPath(req.path).split('/').slice(2);
    const as = (kind: IssuedToken['kind']) => (tok.kind === kind ? null : graphError(403, 'Forbidden', kind === 'service' ? 'This API needs a delegated token.' : 'This API needs an application token.'));
    const [s0, s1, s2, s3, s4, s5, s6, s7, s8] = seg;

    if (s0 === 'me' && seg.length === 1 && req.method === 'GET') return as('service') ?? { body: { ...m.service } };
    if (s0 === 'me' && s1 === 'joinedTeams' && seg.length === 2 && req.method === 'GET') {
      return as('service') ?? { body: { value: m.teams.map((t) => ({ id: t.id, displayName: t.displayName, description: null, isArchived: false, tenantId: m.tenantId })) } };
    }

    if (s0 === 'teams') {
      const denied = as('service');
      if (denied) return denied;
      const team = findTeam(s1 ?? '');
      if (!team) return graphError(404, 'NotFound', 'No team found with Group Id.');
      if (s2 !== 'channels') return graphError(400, 'BadRequest', 'Unsupported segment.');
      if (seg.length === 3 && req.method === 'GET') {
        return { body: { value: team.channels.map((c) => ({ id: c.id, displayName: c.displayName, membershipType: c.membershipType, isArchived: false })) } };
      }
      const ch = team.channels.find((c) => c.id === s3);
      if (!ch) return graphError(404, 'NotFound', 'Channel not found.');
      if (ch.forbidden) return graphError(403, 'Forbidden', 'Caller is not a member of the channel.');
      if (seg.length === 4 && req.method === 'GET') return { body: { id: ch.id, displayName: ch.displayName, membershipType: ch.membershipType, isArchived: false } };
      if (s4 !== 'messages' || req.method !== 'GET') return graphError(400, 'BadRequest', 'Unsupported segment.');
      // Lista (a Microsoft só permite ler assim uma vez por dia em ciclo): as mais novas primeiro.
      if (seg.length === 5) {
        const top = Math.max(1, Math.min(50, Number(req.query.$top ?? 20) || 20));
        const expand = /replies/.test(req.query.$expand ?? '');
        return { body: { value: [...ch.messages].reverse().slice(0, top).map((x) => messageOut(x, expand)) } };
      }
      if (s5 === 'delta' && seg.length === 6) return delta(ch, req);
      const root = ch.messages.find((x) => x.data.id === s5);
      if (!root) return graphError(404, 'NotFound', 'Message not found.');
      if (seg.length === 6) return { body: messageOut(root) };
      if (s6 === 'replies' && seg.length === 7) {
        const top = Math.max(1, Math.min(50, Number(req.query.$top ?? 20) || 20));
        return { body: { value: [...root.replies].reverse().slice(0, top).map((x) => messageOut(x)) } };
      }
      if (s6 === 'replies' && seg.length === 8) {
        const r = root.replies.find((x) => x.data.id === s7);
        return r ? { body: messageOut(r) } : graphError(404, 'NotFound', 'Reply not found.');
      }
      return graphError(400, 'BadRequest', `Unsupported segment ${s8 ?? ''}.`);
    }

    if (s0 === 'subscriptions') {
      const denied = as('service');
      if (denied) return denied;
      if (seg.length === 1 && req.method === 'POST') return createSubscription(req);
      const sub = m.subscriptions.get(s1 ?? '');
      if (!sub) return graphError(404, 'ResourceNotFound', `The object was not found.`);
      if (req.method === 'DELETE') {
        m.subscriptions.delete(sub.id);
        return { status: 204 };
      }
      if (req.method === 'PATCH') {
        const exp = Date.parse(String(req.json?.expirationDateTime ?? ''));
        if (!Number.isFinite(exp) || exp <= Date.now() || exp > Date.now() + SUB_MAX_MS) return graphError(400, 'ExtensionError', 'Subscription expiration can only be 60 minutes in the future.');
        sub.expirationDateTime = new Date(exp).toISOString();
        return { body: { ...sub } };
      }
    }

    if (s0 === 'users' && seg.length === 1 && req.method === 'GET') {
      const denied = as('app');
      if (denied) return denied;
      const filter = req.query.$filter ?? '';
      m.userFilters.push(filter);
      const found = usersFilter(filter);
      if (!found) return graphError(400, 'Request_UnsupportedQuery', `Unsupported query: ${filter}`);
      return { body: { value: found.map((u) => ({ id: u.id, displayName: u.displayName, mail: u.mail, userPrincipalName: u.userPrincipalName })) } };
    }

    if (s0 === 'users' && s2 === 'onlineMeetings') {
      const denied = as('app');
      if (denied) return denied;
      const organizer = m.users.get(s1 ?? '');
      if (!organizer) return graphError(404, 'NotFound', 'User not found.');
      if (m.meetingPolicyBlocked.has(organizer.id)) return { status: 403, body: msFixture('online-meeting-policy-403', { organizerId: organizer.id }) };
      if (seg.length === 3 && req.method === 'POST') {
        const b = req.json ?? {};
        if (!b.subject || !Number.isFinite(Date.parse(b.startDateTime)) || !Number.isFinite(Date.parse(b.endDateTime))) return graphError(400, 'BadRequest', 'Invalid meeting.');
        const id = `MSo${b64url(crypto.randomBytes(18))}`;
        m.meetings.push({ organizerId: organizer.id, body: clone(b), id });
        return {
          status: 201,
          body: msFixture('online-meeting', {
            organizerId: organizer.id,
            organizerUpn: organizer.userPrincipalName,
            meetingId: id,
            now: new Date().toISOString(),
            start: new Date(Date.parse(b.startDateTime)).toISOString(),
            end: new Date(Date.parse(b.endDateTime)).toISOString(),
            thread: crypto.randomBytes(12).toString('hex'),
            tenantId: m.tenantId,
            subject: String(b.subject),
          }),
        };
      }
      if (seg.length === 4 && req.method === 'DELETE') {
        m.deletedMeetings.push(s3 ?? '');
        return { status: 204 };
      }
    }

    if (s0 === 'communications' && s1 === 'getPresencesByUserId' && seg.length === 2 && req.method === 'POST') {
      const denied = as('app');
      if (denied) return denied;
      const ids: string[] = Array.isArray(req.json?.ids) ? req.json.ids.map(String) : [];
      if (!ids.length || ids.length > 650) return graphError(400, 'BadRequest', 'Between 1 and 650 ids.');
      m.presenceRequests.push(ids);
      return {
        body: {
          value: ids.map((id) => {
            const p = m.presences.get(id) ?? { availability: 'PresenceUnknown', activity: 'PresenceUnknown' };
            return msFixture('presence', { userId: id, availability: p.availability, activity: p.activity });
          }),
        },
      };
    }

    return graphError(400, 'BadRequest', `Unsupported request ${req.method} ${decodedPath(req.path)}.`);
  }

  server.on('*', /^\/v1\.0\//, graphRoute);

  // ---------- Workflows ----------

  server.on('POST', /^\/workflows\/[^/]+\/triggers\/manual\/paths\/invoke$/, async (req) => {
    for (const fn of interceptors) {
      const r = fn(req);
      if (r) return r;
    }
    const id = req.path.split('/')[2];
    if (req.query.sig !== `tok-teste-assinatura-${id}`) return { status: 401, body: { error: { code: 'DirectApiAuthorizationRequired', message: 'The request must be authenticated.' } } };
    const conf = flowConf.get(id) ?? { auth: 'none' as const, reply: null };
    const authorization = req.headers.authorization ?? null;
    flowLog.push({ flowId: id, card: req.json, authorization, at: Date.now() });
    if (conf.auth === 'entra') {
      const tok = issued.get(/^Bearer (.+)$/.exec(authorization ?? '')?.[1] ?? '');
      if (!tok || tok.kind !== 'flow' || tok.aud !== FLOW_AUDIENCE) {
        return { status: 401, body: { error: { code: 'MisMatchingOAuthClaims', message: 'One or more claims either missing or does not match with the open authentication access control policy.' } } };
      }
    }
    if (conf.reply) return conf.reply(req);
    return { status: 202, body: '' };
  });

  return m;
}

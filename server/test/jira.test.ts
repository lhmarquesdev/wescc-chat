import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { many, one, pool } from '../src/db/pool';
import { sessionTag } from '../src/integrations/ephemeral';
import { drainJobs, enqueue, sweepJobs } from '../src/integrations/jobs';
import { runPollerOnce } from '../src/integrations/runtime';
import { getState, mergeState, setState } from '../src/integrations/state';
import { reloadSecretsKey } from '../src/lib/secrets';
import { getSetting } from '../src/services/settings';
import { startFakeJira, type FakeAccount, type FakeJira, type IssueInput } from './fake-jira';
import { admin, api, connectWs, newUser, sleep, startServer, stopServer, urlOf, type Auth } from './helpers';

// Jira (§4, §6 e §12.2): configuração, regras, webhook, consulta periódica, avisos, prévias, issues, /jira e contas
// vinculadas, tudo contra o Jira falso (fake-jira.ts). Nada sai para a internet; os tokens são valores falsos.

process.env.SECRETS_KEY = crypto.randomBytes(32).toString('base64');

let J: FakeJira; // o Jira da empresa
let J2: FakeJira; // outro endereço liberado (troca de site, B4)
let A: Auth;
let anaU: Auth; // vinculada a J.ana
let brunoU: Auth; // vinculado a J.bruno
let reader: Auth; // sem conta do Jira
let ops: { _id: string; name: string };
let hookToken = '';
let hookSecret = '';

beforeAll(async () => {
  J = await startFakeJira();
  J2 = await startFakeJira();
  process.env.INTEGRATIONS_ALLOWED_HOSTS = `${J.host},${J2.host}`;
  process.env.JIRA_API_GATEWAY = J.origin;
  process.env.ATLASSIAN_AUTH_URL = J.origin;
  reloadSecretsKey();
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
  anaU = await newUser(A);
  brunoU = await newUser(A);
  reader = await newUser(A);
  ops = await channel(A, [anaU.username, brunoU.username, reader.username]);
  await configure();
});
afterAll(async () => {
  await stopServer();
  await J?.close();
  await J2?.close();
});

// ---------- Ajudantes ----------

const uniq = (p: string) => `${p}-${crypto.randomBytes(3).toString('hex')}`;

async function channel(owner: Auth, members: string[] = [], extra: Record<string, unknown> = {}) {
  const r = await api('POST', 'channels.create', { name: uniq('jira'), members, ...extra }, owner);
  if (!r.channel) throw new Error(JSON.stringify(r));
  return r.channel as { _id: string; name: string };
}

async function configure(extra: Record<string, unknown> = {}) {
  const r = await api(
    'POST',
    'jira.config.save',
    { siteUrl: J.origin, authType: 'scoped', accountEmail: J.service.email, apiToken: J.serviceToken, projectsVisible: ['OPS', 'SUP'], enabled: true, ...extra },
    A,
  );
  if (!r.config) throw new Error(JSON.stringify(r));
  return r;
}

const send = async (u: Auth, rid: string, msg: string, extra: Record<string, unknown> = {}) => {
  const r = await api('POST', 'chat.sendMessage', { message: { rid, msg, ...extra } }, u);
  if (!r.message) throw new Error(JSON.stringify(r));
  return r.message as { _id: string; rid: string; msg: string };
};

let acctSeq = 0;
function account(name: string): FakeAccount {
  const n = String(++acctSeq).padStart(4, '0');
  return { accountId: `712020:00000000-0000-4000-9000-00000000${n}`, displayName: name, email: `${name.toLowerCase().replace(/\s+/g, '.')}.${n}@explorer-teste.com.br` };
}

const tokenOf = (acc: FakeAccount) => `tok-teste-pessoal-${acc.accountId.slice(-6)}-abcdef`;

async function linkToken(u: Auth, acc: FakeAccount, o: { gatewayOnly?: boolean } = {}) {
  const token = tokenOf(acc);
  J.allowBasic(acc, token, o);
  const r = await api('POST', 'jira.link.token', { email: acc.email, token }, u);
  if (!r.account) throw new Error(JSON.stringify(r));
  return token;
}

async function ensureLinked(u: Auth, acc: FakeAccount) {
  const row = await one(`SELECT status FROM linked_accounts WHERE user_id = $1 AND provider = 'jira'`, [u.userId]);
  if (row?.status !== 'ok') await linkToken(u, acc);
}

let pseq = 0;
function newProject(type: 'software' | 'service_desk' = 'software') {
  const key = `P${++pseq}`;
  J.projects.push({ id: String(11000 + pseq), key, name: `Projeto ${key}`, projectTypeKey: type });
  return key;
}

let iseq = 1000;
const issue = (project: string, p: Partial<IssueInput> = {}) => J.addIssue({ key: `${project}-${++iseq}`, ...p });
const urlOfIssue = (key: string) => `${J.origin}/browse/${key}`;
const person = (a: FakeAccount) => ({ accountId: a.accountId, displayName: a.displayName, active: true, accountType: 'atlassian' });
const status = (from: string, to: string) => ({ field: 'status', fromString: from, toString: to });

const DEFAULT_EVENTS = ['created', 'status', 'resolved', 'assigned', 'commented'];

// Só esta regra fica valendo (as outras são removidas), para cada teste ver apenas os próprios avisos.
async function onlyRule(input: Record<string, unknown>) {
  const list = (await api('GET', 'jira.rules', {}, A)).rules ?? [];
  for (const r of list) await api('POST', 'jira.rules.remove', { _id: r._id }, A);
  return saveRule(input);
}
async function saveRule(input: Record<string, unknown>) {
  const r = await api('POST', 'jira.rules.save', { name: 'Regra de teste', events: DEFAULT_EVENTS, threads: true, ...input }, A);
  if (!r.rule) throw new Error(JSON.stringify(r));
  return r.rule as { _id: string; name: string };
}

const botId = async () => String((await getState<{ id: string }>('bot.jira'))?.id ?? '');

// Avisos do robô na sala (sem as mensagens de entrada e de saída de regras).
async function posts(rid: string) {
  return many(
    `SELECT id, msg, tmid, extra, mentions, attachments FROM messages
     WHERE room_id = $1 AND user_id = $2 AND t IS NULL AND msg NOT LIKE 'A partir de agora%' AND msg NOT LIKE 'O Jira deixou de avisar%'
     ORDER BY created_at, id`,
    [rid, await botId()],
  );
}

const activityTexts = async () => (await many(`SELECT text FROM integration_activity WHERE provider = 'jira' ORDER BY created_at, id`)).map((r) => String(r.text));

// Roda a fila até o fim. No modo webhook os avisos esperam 5 s (para juntar rajadas): aqui eles vencem na hora.
async function drain() {
  for (let i = 0; i < 6; i++) {
    await drainJobs();
    const r = await pool.query(`UPDATE integration_jobs SET run_at = now() WHERE status = 'queued' AND kind = 'jira.post' AND attempts = 0 AND run_at > now()`);
    if (!r.rowCount) break;
  }
}

async function poll() {
  await runPollerOnce('jira.poll');
  const st = await getState<{ failingSince?: string | null; lastError?: string | null }>('poller:jira.poll');
  if (st?.failingSince) throw new Error(`a consulta falhou: ${st.lastError}`);
  await drain();
}

const jiraOf = async (messageId: string) => (await one('SELECT extra FROM messages WHERE id = $1', [messageId]))?.extra?.jira ?? null;

// O gancho das prévias roda depois da resposta do envio: espera a tarefa aparecer (ou um instante, quando não deve aparecer).
async function waitUnfurl(messageId: string, expected = true) {
  for (let i = 0; i < 40; i++) {
    const job = await one(`SELECT id FROM integration_jobs WHERE kind = 'jira.unfurl' AND payload->>'messageId' = $1 AND status = 'queued'`, [messageId]);
    if (job) break;
    if (!expected && i >= 6) break;
    await sleep(50);
  }
  await drain();
}

const sign = (raw: string, secret = hookSecret) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;

async function hook(body: unknown, o: { token?: string; sig?: string | null; delivery?: string; headers?: Record<string, string> } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(o.headers ?? {}) };
  if (o.sig !== null) headers['x-hub-signature'] = o.sig ?? sign(raw);
  if (o.delivery) headers['x-atlassian-webhook-identifier'] = o.delivery;
  return fetch(urlOf(`/hooks/jira/${o.token ?? hookToken}`), { method: 'POST', headers, body: raw });
}

const who = (a: FakeAccount) => ({ accountId: a.accountId, displayName: a.displayName });
const updatedBody = (i: any, h: any, o: { actor?: FakeAccount; summary?: string } = {}) => ({
  timestamp: Date.now(),
  webhookEvent: 'jira:issue_updated',
  user: who(o.actor ?? J.ana),
  issue: { id: i.id, key: i.key, fields: { summary: o.summary ?? i.fields.summary, project: { key: i.fields.project.key } } },
  changelog: { id: h.id, items: h.items },
});

type Ws = ReturnType<typeof connectWs>;
async function online(u: Auth) {
  const ws = connectWs(u);
  await ws.ready;
  return ws;
}
// /jira pela API (commands.run): devolve a resposta efêmera que chega pelo WebSocket.
async function command(u: Auth, ws: Ws, rid: string, params: string) {
  const since = ws.events.length;
  const r = await api('POST', 'commands.run', { roomId: rid, command: 'jira', params }, u);
  expect(r.status).toBe(200);
  expect(r.result).toEqual({ ok: true, command: 'jira' });
  return (await ws.waitFor((e) => ws.events.indexOf(e) >= since && e.type === 'ephemeral')).message;
}

const roomMessageCount = async (rid: string) => Number((await one('SELECT count(*)::int AS n FROM messages WHERE room_id = $1', [rid]))?.n ?? 0);

async function grant(permission: string, role: string) {
  const perms = (await api('GET', 'permissions.listAll', {}, A)).update as { _id: string; roles: string[] }[];
  const roles = perms.find((p) => p._id === permission)!.roles;
  if (!roles.includes(role)) await api('POST', 'permissions.update', { permissions: [{ _id: permission, roles: [...roles, role] }] }, A);
}

const blockedText = (other: string) =>
  `Conversas diretas entre você e @${other} estão bloqueadas pela política da empresa. O histórico continua disponível, mas não é possível enviar mensagens.`;
const NOTICE_TEXT = 'Este é um canal de avisos: só os publicadores enviam mensagens.';
const webhookText = (site: string) =>
  `O Jira Cloud só chama endereços https públicos, com certificado de uma autoridade pública (não serve certificado interno da empresa), na porta 443 ou em outra aceita pela Atlassian. Este chat está em ${site}. Use a consulta periódica, ou publique o chat na internet com https.`;

// ---------- Configuração ----------

describe('Jira: configuração e teste de conexão', () => {
  it('salvar nunca devolve o token; o teste preenche o cloudId e os projetos do Service Management', async () => {
    const r = await configure();
    expect(JSON.stringify(r)).not.toContain(J.serviceToken);
    expect(r.config).toMatchObject({ enabled: true, siteUrl: J.origin, cloudId: J.cloudId, apiToken: { set: true } });
    const t = await api('POST', 'jira.config.test', {}, A);
    expect(t.status).toMatchObject({ tone: 'ok', text: 'Conectado como Conta de Serviço' });
    expect(t.status.details).toEqual(['Conta da integração: Conta de Serviço', 'A conta da integração vê 3 projetos.']);
    expect(t.account).toMatchObject({ accountId: J.service.accountId, displayName: 'Conta de Serviço', locale: 'pt_BR' });
    const c = await api('GET', 'jira.config', {}, A);
    expect(c.config.serviceDeskProjects).toEqual(['SUP']);
    expect(JSON.stringify(c)).not.toContain(J.serviceToken);
    // A chamada usou o gateway da Atlassian com o cloudId (token com escopos).
    expect(J.calls(`/ex/jira/${J.cloudId}/rest/api/3/myself`).length).toBeGreaterThan(0);
    // A visão geral (integrations.overview) mostra o mesmo estado da conexão.
    const ov = await api('GET', 'integrations.overview', undefined, A);
    expect(ov.jira).toMatchObject({ enabled: true, status: { tone: 'ok', text: 'Conectado como Conta de Serviço' } });
  });

  it('Jira Data Center → aviso', async () => {
    J.deploymentType = 'Server';
    try {
      const t = await api('POST', 'jira.config.test', {}, A);
      expect(t.status.tone).toBe('warn');
      expect(t.status.text).toBe('Conectado como Conta de Serviço, com avisos');
      expect(t.status.details).toContain('Este endereço parece ser um Jira Data Center. Esta versão do chat funciona com o Jira Cloud.');
    } finally {
      J.deploymentType = 'Cloud';
    }
  });

  it('conta da integração em inglês → aviso do idioma', async () => {
    J.service.locale = 'en_US';
    try {
      const t = await api('POST', 'jira.config.test', {}, A);
      expect(t.status.tone).toBe('warn');
      expect(t.status.details).toContain(
        'A conta da integração está em inglês. Status, tipos e prioridades vão chegar nesse idioma. Mude o idioma do perfil dessa conta para Português (Brasil).',
      );
    } finally {
      J.service.locale = 'pt_BR';
    }
  });

  it('401 → o texto do §4.2 e a dica da lista de IPs', async () => {
    const key = J.basic(J.service.email, J.serviceToken);
    const saved = J.auth.get(key)!;
    J.auth.delete(key);
    try {
      const t = await api('POST', 'jira.config.test', {}, A);
      expect(t.status.tone).toBe('err');
      expect(t.status.text).toBe('O Jira recusou o token da conta da integração. Confira o e-mail e o token (os tokens da Atlassian expiram).');
      expect(t.status.details).toContain('Se a organização da Atlassian usa lista de IPs permitidos, o IP público de saída do servidor precisa estar nela.');
    } finally {
      J.auth.set(key, saved);
    }
    expect((await api('POST', 'jira.config.test', {}, A)).status.tone).toBe('ok');
  });

  it('auditoria sem segredos', async () => {
    const rows = await many(`SELECT action, target, data FROM audit_log WHERE action LIKE 'integration.jira.%'`);
    expect(rows.some((r) => r.action === 'integration.jira.config.saved')).toBe(true);
    const saved = rows.find((r) => r.action === 'integration.jira.config.saved')!;
    expect(saved.data.fields).not.toContain('apiToken');
    expect(JSON.stringify(rows)).not.toContain(J.serviceToken);
  });

  it('B4: endereço fora da lista é recusado; trocar de site descarta o token, expira as contas e não manda Authorization ao novo host', async () => {
    const bad = await api('POST', 'settings', { settings: { Jira_Site_Url: 'https://evil.example' } }, A);
    expect(bad.status).toBe(400);
    const bad2 = await api('POST', 'jira.config.save', { siteUrl: 'https://evil.example' }, A);
    expect(bad2.status).toBe(400);
    expect(bad2.error).toBe(
      'Use o endereço do Jira Cloud (termina em .atlassian.net). Para outro servidor, o responsável pelo servidor do chat precisa liberá-lo em INTEGRATIONS_ALLOWED_HOSTS.',
    );
    expect((await api('GET', 'jira.config', {}, A)).config.siteUrl).toBe(J.origin);

    const u = await newUser(A);
    await linkToken(u, account('Gil Teste'));
    const before = J2.server.calls.length;
    const r = await api('POST', 'jira.config.save', { siteUrl: J2.origin }, A);
    expect(r.config).toMatchObject({ siteUrl: J2.origin, cloudId: '', apiToken: { set: false } });
    const linked = await one(`SELECT status, status_text, access_token FROM linked_accounts WHERE user_id = $1`, [u.userId]);
    expect(linked).toEqual({ status: 'expired', status_text: 'O endereço do Jira mudou. Conecte sua conta de novo.', access_token: null });
    expect(await activityTexts()).toContain(`O endereço do Jira mudou de ${J.origin} para ${J2.origin}. Os tokens salvos foram descartados.`);
    const audit = await one(`SELECT data FROM audit_log WHERE action = 'integration.jira.site.changed' ORDER BY created_at DESC LIMIT 1`);
    expect(audit?.data).toEqual({ from: J.origin, to: J2.origin });
    expect(await getState(`alert:jira.linked:${u.userId}`)).toMatchObject({ to: { userId: u.userId } });

    const s = await api('GET', 'jira.search', { q: 'fila' }, u);
    expect(s.status).toBe(400);
    expect(s.errorType).toBe('error-jira-not-configured');
    expect(J2.server.calls.slice(before).filter((c) => c.headers.authorization)).toEqual([]);

    await configure();
    expect((await api('GET', 'jira.config', {}, A)).config).toMatchObject({ siteUrl: J.origin, cloudId: J.cloudId, apiToken: { set: true } });
  });

  it('B4: uma conta vinculada gravada para outro endereço não é usada', async () => {
    const u = await newUser(A);
    const acc = account('Helena Teste');
    const token = await linkToken(u, acc);
    await pool.query(`UPDATE linked_accounts SET site = $2 WHERE user_id = $1`, [u.userId, J2.origin]);
    const before = J.server.calls.length;
    const s = await api('GET', 'jira.search', { q: 'nada' }, u);
    expect(s.status).toBe(200);
    expect(s.identity).toBe('integration');
    const auths = J.server.calls.slice(before).map((c) => c.headers.authorization);
    expect(auths).not.toContain(J.basic(acc.email, token));
    expect(auths).toContain(J.basic(J.service.email, J.serviceToken));
    expect((await one(`SELECT status FROM linked_accounts WHERE user_id = $1`, [u.userId]))?.status).toBe('expired');
  });

  const siteChanges = async () => Number((await one(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'integration.jira.site.changed'`))!.n);
  const lastSiteChange = () => one(`SELECT actor_username, data FROM audit_log WHERE action = 'integration.jira.site.changed' ORDER BY created_at DESC, id DESC LIMIT 1`);
  const changedLines = async () => (await activityTexts()).filter((t) => t === `O endereço do Jira mudou de ${J.origin} para ${J2.origin}. Os tokens salvos foram descartados.`).length;

  it('D25: A → vazio → A mantém o token e as contas; A → vazio → B faz a troca inteira (token, contas, auditoria, consulta)', async () => {
    const u = await newUser(A);
    await linkToken(u, account('Iara Teste'));
    const n0 = await siteChanges();
    const lines0 = await changedLines();

    expect((await api('POST', 'jira.config.save', { siteUrl: '', enabled: false }, A)).config.siteUrl).toBe('');
    expect((await api('POST', 'jira.config.save', { siteUrl: J.origin, enabled: true }, A)).config).toMatchObject({ siteUrl: J.origin, apiToken: { set: true } });
    expect(await siteChanges()).toBe(n0);
    expect((await one(`SELECT status FROM linked_accounts WHERE user_id = $1`, [u.userId]))?.status).toBe('ok');

    await setState('jira.poll', { lastRunStart: new Date(Date.now() - 30 * 60_000).toISOString() });
    try {
      expect((await api('POST', 'jira.config.save', { siteUrl: '', enabled: false }, A)).config.siteUrl).toBe('');
      expect((await api('POST', 'jira.config.save', { siteUrl: J2.origin }, A)).config).toMatchObject({ siteUrl: J2.origin, cloudId: '', apiToken: { set: false } });
      expect(await siteChanges()).toBe(n0 + 1);
      expect(await lastSiteChange()).toEqual({ actor_username: A.username, data: { from: J.origin, to: J2.origin } });
      expect(await changedLines()).toBe(lines0 + 1);
      expect(await one(`SELECT 1 FROM integration_secrets WHERE id = 'jira.apiToken'`)).toBeNull();
      expect(await one(`SELECT status, access_token FROM linked_accounts WHERE user_id = $1`, [u.userId])).toEqual({ status: 'expired', access_token: null });
      expect(await getState('jira.poll')).toEqual({});
    } finally {
      await configure();
    }
    expect((await api('GET', 'jira.config', {}, A)).config).toMatchObject({ siteUrl: J.origin, cloudId: J.cloudId, apiToken: { set: true } });
  });

  it('D25: trocar o Jira_Site_Url pelo POST settings genérico → a mesma troca na verificação periódica ou no primeiro uso, uma vez só', async () => {
    const u = await newUser(A);
    await linkToken(u, account('Joana Teste'));
    const n0 = await siteChanges();
    expect((await api('POST', 'settings', { settings: { Jira_Site_Url: J2.origin } }, A)).status).toBe(200);
    try {
      // Sem ninguém usar o Jira: a verificação de 5 em 5 minutos (jira.health) já faz a troca.
      await runPollerOnce('jira.health');
      expect(await siteChanges()).toBe(n0 + 1);
      expect(await lastSiteChange()).toEqual({ actor_username: 'system', data: { from: J.origin, to: J2.origin } });
      expect(await one(`SELECT 1 FROM integration_secrets WHERE id = 'jira.apiToken'`)).toBeNull();
      expect((await one(`SELECT status FROM linked_accounts WHERE user_id = $1`, [u.userId]))?.status).toBe('expired');
      const before = J2.server.calls.length;
      const s = await api('GET', 'jira.search', { q: 'fila' }, u);
      expect(s.errorType).toBe('error-jira-not-configured');
      expect(J2.server.calls.slice(before).filter((c) => c.headers.authorization)).toEqual([]);
      expect((await api('GET', 'jira.config', {}, A)).config).toMatchObject({ siteUrl: J2.origin, apiToken: { set: false } });
      expect(await siteChanges()).toBe(n0 + 1);

      // De volta pelo mesmo caminho, com dois usos ao mesmo tempo: só um deles faz a troca.
      expect((await api('POST', 'settings', { settings: { Jira_Site_Url: J.origin } }, A)).status).toBe(200);
      await Promise.all([api('GET', 'jira.config', {}, A), api('GET', 'jira.search', { q: 'fila' }, u), api('GET', 'jira.config', {}, A)]);
      expect(await siteChanges()).toBe(n0 + 2);
      expect(await lastSiteChange()).toEqual({ actor_username: 'system', data: { from: J2.origin, to: J.origin } });
    } finally {
      await configure();
    }
    expect((await api('GET', 'jira.config', {}, A)).config).toMatchObject({ siteUrl: J.origin, cloudId: J.cloudId, apiToken: { set: true } });
  });
});

// ---------- Regras ----------

describe('Jira: regras', () => {
  const base = () => ({ name: 'Avisos OPS', projects: ['OPS'], events: ['created', 'status'], roomIds: [ops._id] });

  it('cada erro de validação tem o seu texto', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ name: '' }, 'Dê um nome à regra (até 80 caracteres).'],
      [{ name: 'x'.repeat(81) }, 'Dê um nome à regra (até 80 caracteres).'],
      [{ projects: [] }, 'Escolha de 1 a 20 projetos.'],
      [{ events: [] }, 'Escolha pelo menos um tipo de aviso.'],
      [{ roomIds: [] }, 'Escolha de 1 a 5 salas.'],
      [{ jql: 'x'.repeat(1001) }, 'O filtro JQL tem um erro: use no máximo 1000 caracteres.'],
      [{ projects: ['NOPE'] }, 'O projeto NOPE não existe ou a conta da integração não o vê.'],
      [{ jql: 'project = = OPS' }, 'O filtro JQL tem um erro: Erro na consulta: valor esperado.'],
    ];
    for (const [patch, text] of cases) {
      const r = await api('POST', 'jira.rules.save', { ...base(), ...patch }, A);
      expect(r.status, JSON.stringify(patch)).toBe(400);
      expect(r.errorType).toBe('error-jira-rule');
      expect(r.error).toBe(text);
    }
    expect((await api('GET', 'jira.rules', {}, A)).rules).toEqual([]);
  });

  it('o anúncio é do jira.bot, sem @ e sem linhas de menção', async () => {
    const room = await channel(A, [anaU.username]);
    const rule = await onlyRule({ ...base(), roomIds: [room._id] });
    const me = await one('SELECT name, username FROM users WHERE id = $1', [A.userId]);
    const bot = await one(`SELECT id, username, type FROM users WHERE id = $1`, [await botId()]);
    expect(bot).toMatchObject({ username: 'jira.bot', type: 'bot' });
    const msgs = await many(`SELECT msg, mentions, t FROM messages WHERE room_id = $1 AND user_id = $2 AND t IS NULL`, [room._id, bot!.id]);
    expect(msgs).toEqual([
      { msg: `A partir de agora, o Jira avisa aqui sobre OPS (issue criada e mudança de status). Regra “Avisos OPS”, configurada por ${me!.name || me!.username}.`, mentions: [], t: null },
    ]);
    expect(msgs[0].msg).not.toContain('@');
    const listed = (await api('GET', 'jira.rules', {}, A)).rules;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ _id: rule._id, projects: ['OPS'], roomIds: [room._id], rooms: [{ _id: room._id, t: 'c', notice: false }] });
  });

  it('canal de avisos só com grantPublisher; o robô vira publicador', async () => {
    const notice = await channel(A, [reader.username], { extraData: { notice: true } });
    const r = await api('POST', 'jira.rules.save', { ...base(), roomIds: [notice._id] }, A);
    expect(r.status).toBe(400);
    expect(r.errorType).toBe('error-integration-room');
    expect(r.error).toBe('Este é um canal de avisos. Marque “Permitir que o Jira publique neste canal de avisos”.');
    const ok = await api('POST', 'jira.rules.save', { ...base(), roomIds: [notice._id], grantPublisher: true }, A);
    expect(ok.rule).toMatchObject({ grantPublisher: true, roomIds: [notice._id] });
    const sub = await one(`SELECT roles FROM subscriptions WHERE room_id = $1 AND user_id = $2`, [notice._id, await botId()]);
    expect(sub?.roles).toContain('publisher');
  });

  it('grupo privado do qual o administrador não participa é recusado', async () => {
    const g = await api('POST', 'groups.create', { name: uniq('privado'), members: [] }, anaU);
    const r = await api('POST', 'jira.rules.save', { ...base(), roomIds: [g.group._id] }, A);
    expect(r.status).toBe(400);
    expect(r.error).toBe('Você precisa participar do grupo privado para usá-lo numa integração.');
  });

  it('H4: discussão não pode ser destino', async () => {
    const d = await api('POST', 'rooms.createDiscussion', { prid: ops._id, t_name: 'Discussão da fila' }, A);
    const rid = d.discussion?._id ?? d.room?._id ?? d.discussion?.rid;
    expect(rid).toBeTruthy();
    const r = await api('POST', 'jira.rules.save', { ...base(), roomIds: [rid] }, A);
    expect(r.status).toBe(400);
    expect(r.error).toBe('Discussões não podem ser usadas em integrações.');
  });

  it('limite de 50 regras', async () => {
    const have = Number((await one(`SELECT count(*)::int AS n FROM integrations WHERE type = 'jira-events'`))!.n);
    const ids: string[] = [];
    for (let i = have; i < 50; i++) {
      const id = `regra-limite-${i}`;
      ids.push(id);
      await pool.query(`INSERT INTO integrations (id, type, name, enabled, token, user_id, username, config) VALUES ($1, 'jira-events', $2, false, '', $3, 'admin', '{}')`, [id, `Limite ${i}`, A.userId]);
    }
    try {
      const r = await api('POST', 'jira.rules.save', base(), A);
      expect(r.status).toBe(400);
      expect(r.errorType).toBe('error-integration-limit');
      expect(r.error).toBe('Limite de 50 regras do Jira atingido.');
    } finally {
      await pool.query(`DELETE FROM integrations WHERE id = ANY($1)`, [ids]);
    }
  });
});

// ---------- Avisos de ponta a ponta ----------

describe('Jira: avisos de ponta a ponta', () => {
  beforeAll(async () => {
    await ensureLinked(anaU, J.ana);
    await ensureLinked(brunoU, J.bruno);
  });

  it('mudança de status → aviso com o texto, extra.jira e o anexo de reserva; o segundo evento responde no tópico; resolvida aparece na sala', async () => {
    const p = newProject();
    const room = await channel(A, [anaU.username]);
    await onlyRule({ projects: [p], roomIds: [room._id] });
    const i = issue(p, { summary: 'Fila de ligações parada', status: 'Em andamento' });
    const url = urlOfIssue(i.key);
    J.addHistory(i.key, [status('Aberta', 'Em andamento')], { author: J.ana });
    await poll();
    let list = await posts(room._id);
    expect(list).toHaveLength(1);
    expect(list[0].msg).toBe(`**Ana Teste** moveu [${i.key}](${url}) de **Aberta** para **Em andamento**`);
    expect(list[0].tmid).toBeNull();
    expect(list[0].extra.jira).toMatchObject({
      kind: 'event',
      site: J.origin,
      issues: [{ key: i.key, url, summary: 'Fila de ligações parada', status: { name: 'Em andamento', category: 'indeterminate' }, type: { name: 'Tarefa', kind: 'task' } }],
      event: { kind: 'status', actor: { displayName: 'Ana Teste' }, changes: [{ field: 'status', label: 'Status', from: 'Aberta', to: 'Em andamento' }] },
    });
    expect(list[0].attachments).toEqual([{ type: 'jira', title: `${i.key}: Fila de ligações parada`, title_link: url, text: 'Em andamento · Tarefa · Média · Sem responsável', footer: 'Jira' }]);

    i.fields.assignee = person(J.bruno);
    J.addHistory(i.key, [{ field: 'assignee', to: J.bruno.accountId, toString: 'Bruno Teste' }], { author: J.ana });
    await poll();
    list = await posts(room._id);
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({ tmid: list[0].id, msg: `**Ana Teste** atribuiu [${i.key}](${url}) a **Bruno Teste**` });
    expect(list[1].extra.tshow).toBeUndefined();

    i.fields.status = { name: 'Concluído', statusCategory: { key: 'done' } };
    i.fields.resolution = { name: 'Feito' };
    J.addHistory(i.key, [status('Em andamento', 'Concluído'), { field: 'resolution', toString: 'Feito' }], { author: J.ana });
    await poll();
    list = await posts(room._id);
    expect(list).toHaveLength(3);
    expect(list[2]).toMatchObject({ tmid: list[0].id, msg: `**Ana Teste** resolveu [${i.key}](${url}) como **Feito**` });
    expect(list[2].extra.tshow).toBe(true);
  });

  it('comentário restrito e issue com nível de segurança não são avisados', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id] });
    const a = issue(p);
    J.addComment(a.key, 'Só para a equipe interna', { visibility: { type: 'role', value: 'Administrators' } });
    const b = issue(p, { security: true });
    J.addHistory(b.key, [status('Aberta', 'Em andamento')]);
    await poll();
    expect(await posts(room._id)).toEqual([]);
    const texts = await activityTexts();
    expect(texts).toContain(`${a.key}: issue ou comentário com acesso restrito no Jira não é avisado no chat.`);
    expect(texts).toContain(`${b.key}: issue ou comentário com acesso restrito no Jira não é avisado no chat.`);
  });

  it('o filtro JQL da regra deixa de fora as issues que não casam', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id], jql: 'labels = urgente' });
    const yes = issue(p, { labels: ['urgente'] });
    const no = issue(p);
    J.addHistory(yes.key, [status('Aberta', 'Em andamento')]);
    J.addHistory(no.key, [status('Aberta', 'Em andamento')]);
    await poll();
    expect((await posts(room._id)).map((m) => m.extra.jira.issues[0].key)).toEqual([yes.key]);
  });

  it('sala arquivada: a tarefa morre e a regra mostra o erro', async () => {
    const p = newProject();
    const room = await channel(A);
    const rule = await onlyRule({ projects: [p], roomIds: [room._id] });
    await api('POST', 'channels.archive', { roomId: room._id }, A);
    const i = issue(p);
    J.addHistory(i.key, [status('Aberta', 'Em andamento')]);
    await poll();
    const text = `Não foi possível publicar em #${room.name}: Esta sala está arquivada.`;
    const job = await one(`SELECT status, last_error FROM integration_jobs WHERE kind = 'jira.post' AND integration_id = $1 ORDER BY created_at DESC LIMIT 1`, [rule._id]);
    expect(job).toEqual({ status: 'dead', last_error: text });
    const listed = (await api('GET', 'jira.rules', {}, A)).rules.find((r: any) => r._id === rule._id);
    expect(listed.lastError).toBe(text);
    expect(await getState(`alert:jira.rule:${rule._id}`)).toMatchObject({ tone: 'err', text: `A regra “Regra de teste” do Jira não conseguiu publicar: ${text}` });
    // Removida a regra, o alerta dela não fica para trás.
    expect((await api('POST', 'jira.rules.remove', { _id: rule._id }, A)).success).toBe(true);
    expect(await getState(`alert:jira.rule:${rule._id}`)).toBeNull();
  });

  it('mentionAssignee com responsável vinculado → exatamente uma menção de verdade', async () => {
    const p = newProject();
    const room = await channel(A, [brunoU.username]);
    await onlyRule({ projects: [p], roomIds: [room._id], mentionAssignee: true, events: ['assigned'] });
    const i = issue(p, { summary: 'Avisar @all e @here sobre a fila', assignee: J.bruno });
    J.addHistory(i.key, [{ field: 'assignee', to: J.bruno.accountId, toString: 'Bruno Teste' }], { author: J.ana });
    await poll();
    const list = await posts(room._id);
    expect(list).toHaveLength(1);
    expect(list[0].msg).toBe(`**Ana Teste** atribuiu [${i.key}](${urlOfIssue(i.key)}) a @${brunoU.username}`);
    expect(list[0].mentions.map((m: any) => m.username)).toEqual([brunoU.username]);
    expect(list[0].extra.jira.issues[0].assignee).toMatchObject({ accountId: J.bruno.accountId, username: brunoU.username });
  });

  it('mentionAssignee: issue criada já com responsável vinculado e membro → a menção vai no aviso de criação (§4.5, passo 8)', async () => {
    const p = newProject();
    const room = await channel(A, [brunoU.username]);
    await onlyRule({ projects: [p], roomIds: [room._id], mentionAssignee: true, events: ['created', 'assigned'] });
    const i = issue(p, { summary: 'Nova issue atribuída', assignee: J.bruno, created: new Date() });
    await poll();
    const list = await posts(room._id);
    expect(list).toHaveLength(1);
    expect(list[0].msg).toBe(`**Ana Teste** criou [${i.key}](${urlOfIssue(i.key)}): Nova issue atribuída (responsável: @${brunoU.username})`);
    expect(list[0].mentions.map((m: any) => m.username)).toEqual([brunoU.username]);
    // Quem cria para si mesmo não é mencionado.
    const own = issue(p, { summary: 'Para mim', assignee: J.ana, created: new Date() });
    await poll();
    const last = (await posts(room._id)).pop()!;
    expect(last.msg).toBe(`**Ana Teste** criou [${own.key}](${urlOfIssue(own.key)}): Para mim`);
    expect(last.mentions ?? []).toEqual([]);
  });

  it('M1: removida a raiz do tópico, o próximo evento abre outra raiz e troca a linha do tópico', async () => {
    const p = newProject();
    const room = await channel(A);
    const rule = await onlyRule({ projects: [p], roomIds: [room._id] });
    const i = issue(p);
    J.addHistory(i.key, [status('Aberta', 'Em andamento')]);
    await poll();
    J.addHistory(i.key, [{ field: 'assignee', to: J.ana.accountId, toString: 'Ana Teste' }]);
    await poll();
    const [root, reply] = await posts(room._id);
    expect(reply.tmid).toBe(root.id);
    expect((await api('POST', 'chat.delete', { roomId: room._id, msgId: root.id }, A)).status).toBe(200);
    expect((await one('SELECT t FROM messages WHERE id = $1', [root.id]))?.t).toBe('rm');

    J.addHistory(i.key, [status('Em andamento', 'Em revisão')]);
    await poll();
    const list = await posts(room._id);
    const fresh = list[list.length - 1];
    expect(fresh.tmid).toBeNull();
    expect(fresh.msg).toContain('de **Em andamento** para **Em revisão**');
    const thread = await one(`SELECT message_id FROM jira_threads WHERE integration_id = $1 AND room_id = $2 AND issue_id = $3`, [rule._id, room._id, i.id]);
    expect(thread?.message_id).toBe(fresh.id);
  });

  it('M6: um evento que vai tentar de novo continua antes dos eventos mais novos da mesma sala', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id], jql: 'labels = m6' });
    let failures = 0;
    const off = J.intercept((req) =>
      req.path.endsWith('/search/jql') && String(req.query.jql ?? '').startsWith('issuekey in') && failures++ === 0 ? { status: 503, body: { errorMessages: ['indisponível'] } } : null,
    );
    try {
      const first = issue(p, { labels: ['m6'] });
      J.addHistory(first.key, [status('Aberta', 'Em andamento')]);
      await poll();
      const job = await one(`SELECT id, status, attempts FROM integration_jobs WHERE kind = 'jira.post' AND payload->'ev'->>'issueKey' = $1`, [first.key]);
      expect(job).toMatchObject({ status: 'queued', attempts: 1 });
      const second = issue(p, { labels: ['m6'] });
      J.addHistory(second.key, [status('Aberta', 'Em andamento')]);
      await poll();
      expect(await posts(room._id)).toEqual([]);
      off();
      await pool.query(`UPDATE integration_jobs SET run_at = now() WHERE id = $1`, [job!.id]);
      await drain();
      expect((await posts(room._id)).map((m) => m.extra.jira.issues[0].key)).toEqual([first.key, second.key]);
    } finally {
      off();
    }
  });

  it('UX 5.7: 15 eventos numa consulta → um resumo e uma resposta com a lista, sem avisos soltos', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id] });
    const keys: string[] = [];
    for (let n = 0; n < 15; n++) {
      const i = issue(p, { summary: `Chamado ${n + 1}`, status: 'Em análise' });
      keys.push(i.key);
      J.addHistory(i.key, [status('Aberta', 'Em análise')], { author: J.ana });
    }
    await poll();
    const list = await posts(room._id);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ tmid: null, msg: `15 issues de ${p} mudaram de status para **Em análise**.` });
    expect(list[0].extra.jira).toBeUndefined();
    expect(list[1].tmid).toBe(list[0].id);
    const lines = String(list[1].msg).split('\n');
    expect(lines).toHaveLength(15);
    expect(lines).toContain(`[${keys[0]}](${urlOfIssue(keys[0])}) Chamado 1: **Ana Teste** moveu de **Aberta** para **Em análise**`);
    expect(await activityTexts()).toContain(`15 avisos do Jira foram agrupados num resumo em #${room.name}.`);
  });

  it('UX 5.7: 12 issues concluídas no mesmo minuto (status + resolução) → "mudaram de status para **Concluído**"', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id] });
    for (let n = 0; n < 12; n++) {
      const i = issue(p, { summary: `Chamado ${n + 1}`, status: 'Concluído', statusCategory: 'done', resolution: 'Feito' });
      J.addHistory(i.key, [status('Em andamento', 'Concluído'), { field: 'resolution', toString: 'Feito' }], { author: J.ana });
    }
    await poll();
    const list = await posts(room._id);
    expect(list).toHaveLength(2);
    expect(list[0].msg).toBe(`12 issues de ${p} mudaram de status para **Concluído**.`);
    expect(String(list[1].msg).split('\n')[0]).toMatch(/ Chamado \d+: \*\*Ana Teste\*\* resolveu como \*\*Feito\*\*$/);
  });

  it('UX 5.6: issue criada a partir de uma mensagem numa sala com regra → sem aviso de criação; os eventos seguintes respondem na mensagem da pessoa', async () => {
    const p = newProject();
    J.createmeta[p] = J.createmeta.OPS;
    const carla = await newUser(A);
    await linkToken(carla, account('Carla Teste'));
    const room = await channel(A, [carla.username]);
    const rule = await onlyRule({ projects: [p], roomIds: [room._id] });
    const m = await send(carla, room._id, 'Cliente sem áudio na fila 3');
    const r = await api('POST', 'jira.issue.create', { roomId: room._id, messageId: m._id, projectKey: p, issueTypeId: '10002', summary: 'Cliente sem áudio', description: 'Desde as 9h.', replyInThread: true }, carla);
    expect(r.issue?.key).toBe(`${p}-100`);
    const reply = await one('SELECT tmid, msg, extra FROM messages WHERE id = $1', [r.messageId]);
    expect(reply).toMatchObject({ tmid: m._id, msg: `Criei a issue [${p}-100](${urlOfIssue(`${p}-100`)}): Cliente sem áudio` });
    expect(reply!.extra.jira).toMatchObject({ kind: 'created', by: { _id: carla.userId } });
    const created = J.issues.get(`${p}-100`)!;
    expect(await one(`SELECT message_id FROM jira_threads WHERE integration_id = $1 AND issue_id = $2`, [rule._id, created.id])).toEqual({ message_id: m._id });

    await poll();
    expect(await posts(room._id)).toEqual([]);
    J.addHistory(created.key, [status('Aberta', 'Em andamento')], { author: J.ana });
    await poll();
    const list = await posts(room._id);
    expect(list).toHaveLength(1);
    expect(list[0].tmid).toBe(m._id);
  });
});

// ---------- Consulta periódica ----------

describe('Jira: consulta periódica', () => {
  it('uma segunda consulta sobre a sobreposição não publica nada de novo', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id] });
    const i = issue(p);
    J.addHistory(i.key, [status('Aberta', 'Em andamento')]);
    await poll();
    expect(await posts(room._id)).toHaveLength(1);
    await poll();
    await poll();
    expect(await posts(room._id)).toHaveLength(1);
  });

  it('a primeira consulta não recupera o passado', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id] });
    await setState('jira.poll', {});
    await setState('poller:jira.poll', {});
    const old = issue(p);
    J.addHistory(old.key, [status('Aberta', 'Em andamento')], { at: new Date(Date.now() - 30 * 60_000) });
    J.addHistory(old.key, [{ field: 'Rank', toString: 'Classificado acima' }]); // atualiza a issue agora, sem aviso
    const recent = issue(p);
    J.addHistory(recent.key, [status('Aberta', 'Em andamento')], { at: new Date(Date.now() - 60_000) });
    await poll();
    expect((await posts(room._id)).map((m) => m.extra.jira.issues[0].key)).toEqual([recent.key]);
  });

  it('mais de 500 issues na janela → aviso na atividade', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id], events: ['status'] });
    const keys: string[] = [];
    for (let n = 0; n < 501; n++) keys.push(issue(p, { updated: new Date() }).key);
    try {
      await poll();
      expect(await activityTexts()).toContain('Muitas mudanças de uma vez (501 issues). Os avisos mais antigos desta janela foram pulados.');
      expect(J.calls('/search/approximate-count').length).toBeGreaterThan(0);
    } finally {
      for (const k of keys) J.issues.delete(k);
    }
  });

  it('M9: a busca não pede comentários e aceita uma página de 6 MB; os comentários vêm por issue e param no início da janela', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id], events: ['status', 'commented'] });
    const i = issue(p);
    const huge = 'x'.repeat(6 * 1024 * 1024);
    i.fields.description = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: huge }] }] };
    J.addComment(i.key, 'Comentário antigo 1', { at: new Date(Date.now() - 50 * 60_000) });
    J.addComment(i.key, 'Comentário antigo 2', { at: new Date(Date.now() - 40 * 60_000) });
    J.addHistory(i.key, [status('Aberta', 'Em andamento')]);
    J.addComment(i.key, 'Cliente retornou a ligação', { author: J.bruno });
    const before = J.server.calls.length;
    try {
      await poll();
    } finally {
      i.fields.description = null;
    }
    const calls = J.server.calls.slice(before);
    const search = calls.filter((c) => c.path.endsWith('/search/jql'));
    expect(search.length).toBeGreaterThan(0);
    for (const c of search) expect(String(c.query.fields).split(',')).not.toContain('comment');
    const comments = calls.filter((c) => c.path.endsWith(`/issue/${i.id}/comment`));
    expect(comments).toHaveLength(1);
    expect(comments[0].query).toMatchObject({ orderBy: '-created' });
    const list = await posts(room._id);
    expect(list.map((m) => m.extra.jira.event.kind)).toEqual(['status', 'commented']);
    expect(list[1].msg).toBe(`**Bruno Teste** comentou em [${i.key}](${urlOfIssue(i.key)}): “Cliente retornou a ligação”`);
  });

  it('M10: issue com 250 históricos lê primeiro a página mais nova e acha a mudança do último minuto', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id] });
    const i = issue(p);
    const old = new Date(Date.now() - 3 * 3600_000);
    for (let n = 0; n < 249; n++) J.addHistory(i.key, [{ field: 'labels', fromString: '', toString: `rotulo${n}` }], { at: old });
    J.addHistory(i.key, [status('Aberta', 'Em andamento')], { author: J.ana });
    const before = J.server.calls.length;
    await poll();
    const changelog = J.server.calls.slice(before).filter((c) => c.path.endsWith(`/issue/${i.id}/changelog`));
    expect(changelog.map((c) => c.query.startAt)).toEqual(['150']);
    const list = await posts(room._id);
    expect(list).toHaveLength(1);
    expect(list[0].msg).toBe(`**Ana Teste** moveu [${i.key}](${urlOfIssue(i.key)}) de **Aberta** para **Em andamento**`);
  });

  it('M11: lastRunStart de 3 horas atrás → aviso de lacuna', async () => {
    const past = new Date(Date.now() - 3 * 3600_000).toISOString();
    await mergeState('jira.poll', { lastRunStart: past });
    await setState('poller:jira.poll', { lastStart: past });
    await poll();
    expect(await activityTexts()).toContain('O chat ficou 180 minutos sem consultar o Jira. Avisos desse período não foram publicados.');
  });
});

// ---------- Webhook ----------

describe('Jira: webhook', () => {
  beforeAll(async () => {
    await api('POST', 'settings', { settings: { Site_Url: 'https://203.0.113.10' } }, A);
    const r = await api('POST', 'jira.config.save', { eventsMode: 'webhook' }, A);
    expect(r.config.eventsMode).toBe('webhook');
    expect(typeof r.webhookSecret).toBe('string');
    hookSecret = r.webhookSecret;
    hookToken = new URL(r.config.webhookUrl).pathname.split('/').pop()!;
    expect(r.config.webhookUrl).toBe(`https://203.0.113.10/hooks/jira/${hookToken}`);
    expect(JSON.stringify((await api('GET', 'jira.config', {}, A)).config)).not.toContain(hookSecret);
  });

  it('token errado → 404; sem assinatura ou assinatura errada → 401', async () => {
    const body = { webhookEvent: 'jira:issue_created', issue: { id: '1', key: 'OPS-1' } };
    expect((await hook(body, { token: 'token-errado-123' })).status).toBe(404);
    expect((await hook(body, { sig: null })).status).toBe(401);
    expect((await hook(body, { sig: `sha256=${'0'.repeat(64)}` })).status).toBe(401);
    expect((await hook(body, { sig: sign('{}') })).status).toBe(401);
    expect(await activityTexts()).toContain('Chegou uma chamada no webhook do Jira com assinatura inválida.');
  });

  it('assinatura certa sobre os bytes crus (com acentos) → 200 e uma tarefa; o cartão usa os campos relidos, não os do corpo (B6)', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id] });
    const i = issue(p, { summary: 'Resumo atual no Jira', status: 'Em análise' });
    const h = J.addHistory(i.key, [status('Aberta', 'Em análise')], { author: J.ana });
    const before = Number((await one(`SELECT count(*)::int AS n FROM integration_jobs WHERE kind = 'jira.webhook'`))!.n);
    const res = await hook(updatedBody(i, h, { summary: 'Ação: resumo antigo do corpo, com acentuação' }), { delivery: uniq('entrega') });
    expect(res.status).toBe(200);
    expect(Number((await one(`SELECT count(*)::int AS n FROM integration_jobs WHERE kind = 'jira.webhook'`))!.n)).toBe(before + 1);
    await drain();
    const list = await posts(room._id);
    expect(list).toHaveLength(1);
    expect(list[0].extra.jira.issues[0]).toMatchObject({ summary: 'Resumo atual no Jira', status: { name: 'Em análise' } });
    expect(JSON.stringify(list[0])).not.toContain('resumo antigo do corpo');
  });

  it('a mesma entrega duas vezes → uma tarefa só', async () => {
    const delivery = uniq('entrega');
    const body = { webhookEvent: 'jira:issue_created', timestamp: Date.now(), issue: { id: '424242', key: 'OPS-4242', fields: { project: { key: 'OPS' } } } };
    expect((await hook(body, { delivery })).status).toBe(200);
    expect((await hook(body, { delivery })).status).toBe(200);
    expect(Number((await one(`SELECT count(*)::int AS n FROM integration_jobs WHERE kind = 'jira.webhook' AND dedupe_key = $1`, [`jira.webhook:${delivery}`]))!.n)).toBe(1);
    await drain();
  });

  it('Jira desligado → 404', async () => {
    await api('POST', 'settings', { settings: { Jira_Enabled: false } }, A);
    try {
      expect((await hook({ webhookEvent: 'jira:issue_created' })).status).toBe(404);
    } finally {
      await api('POST', 'settings', { settings: { Jira_Enabled: true } }, A);
    }
    expect((await hook({ webhookEvent: 'jira:issue_created' }, { sig: null })).status).toBe(401);
  });

  it('webhookProblem: http, porta fora da lista e endereço interno; a porta 8443 serve (M12)', async () => {
    try {
      for (const site of ['http://203.0.113.10', 'https://203.0.113.10:3000', 'https://10.0.0.5', 'https://192.168.10.20']) {
        await api('POST', 'settings', { settings: { Site_Url: site } }, A);
        const c = (await api('GET', 'jira.config', {}, A)).config;
        expect(c.webhookProblem, site).toBe(webhookText(site));
        expect(c.webhookUrl).toBeNull();
      }
      const r = await api('POST', 'jira.config.save', { eventsMode: 'webhook' }, A);
      expect(r.status).toBe(400);
      expect(r.errorType).toBe('error-jira-webhook');
      await api('POST', 'settings', { settings: { Site_Url: 'https://203.0.113.10:8443' } }, A);
      const c = (await api('GET', 'jira.config', {}, A)).config;
      expect(c.webhookProblem).toBeNull();
      expect(c.webhookUrl).toBe(`https://203.0.113.10:8443/hooks/jira/${hookToken}`);
    } finally {
      await api('POST', 'settings', { settings: { Site_Url: 'https://203.0.113.10' } }, A);
    }
  });

  it('M12: o filtro JQL do webhook acompanha as regras e marca quando mudou', async () => {
    const p = newProject();
    const q = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id] });
    let c = (await api('GET', 'jira.config', {}, A)).config;
    expect(c).toMatchObject({ webhookJql: `project in (${p})`, webhookJqlChanged: true });
    await api('POST', 'jira.webhook.ack', { jql: c.webhookJql }, A);
    expect((await api('GET', 'jira.config', {}, A)).config.webhookJqlChanged).toBe(false);
    await saveRule({ projects: [q], roomIds: [room._id] });
    c = (await api('GET', 'jira.config', {}, A)).config;
    expect(c).toMatchObject({ webhookJql: `project in (${[p, q].sort().join(', ')})`, webhookJqlChanged: true });
  });

  it('B6: issue que a conta da integração não vê (404) → nada publicado e a linha info', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id] });
    const ghost = { id: '987654', key: `${p}-9876`, fields: { summary: 'Fantasma', project: { key: p } } };
    expect((await hook(updatedBody(ghost, { id: '777001', items: [status('Aberta', 'Em andamento')] }))).status).toBe(200);
    await drain();
    expect(await posts(room._id)).toEqual([]);
    expect(await activityTexts()).toContain(`${p}-9876: a conta da integração não vê esta issue; o aviso não foi publicado.`);
  });

  it('B6: 500 ao reler → a tarefa tenta de novo', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id] });
    const i = issue(p);
    const h = J.addHistory(i.key, [status('Aberta', 'Em andamento')]);
    const path = `/ex/jira/${J.cloudId}/rest/api/3/issue/${i.id}`;
    const off = J.intercept((req) => (req.method === 'GET' && req.path === path ? { status: 500, body: { errorMessages: ['falha interna'] } } : null));
    try {
      expect((await hook(updatedBody(i, h))).status).toBe(200);
      await drain();
      const job = await one(`SELECT id, status, attempts, last_error FROM integration_jobs WHERE kind = 'jira.webhook' AND payload->'issue'->>'id' = $1`, [i.id]);
      expect(job).toMatchObject({ status: 'queued', attempts: 1, last_error: 'O Jira não respondeu. Tente de novo em alguns minutos.' });
      expect(await posts(room._id)).toEqual([]);
      off();
      await pool.query(`UPDATE integration_jobs SET run_at = now() WHERE id = $1`, [job!.id]);
      await drain();
      expect(await posts(room._id)).toHaveLength(1);
    } finally {
      off();
    }
  });

  it('B6: comentário que ao ser relido tem jsdPublic: false não é publicado', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id] });
    const i = issue(p);
    const c = J.addComment(i.key, 'Nota interna da equipe', { jsdPublic: false });
    const body = {
      timestamp: Date.now(),
      webhookEvent: 'comment_created',
      user: who(J.bruno),
      issue: { id: i.id, key: i.key, fields: { project: { key: p } } },
      comment: { id: c.id, body: 'Texto público no corpo do webhook', author: who(J.bruno), created: c.created },
    };
    expect((await hook(body)).status).toBe(200);
    await drain();
    expect(await posts(room._id)).toEqual([]);
    expect(await activityTexts()).toContain(`${i.key}: issue ou comentário com acesso restrito no Jira não é avisado no chat.`);
  });

  it('B6: exclusão sem tópico não publica; com tópico publica “excluída” com o cartão guardado', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id], events: ['status', 'deleted'] });
    const x = issue(p, { summary: 'Issue que será excluída' });
    const h = J.addHistory(x.key, [status('Aberta', 'Em andamento')]);
    expect((await hook(updatedBody(x, h))).status).toBe(200);
    await drain();
    const [root] = await posts(room._id);
    expect(root).toBeTruthy();
    const y = issue(p);
    const del = (i: any) => ({ timestamp: Date.now(), webhookEvent: 'jira:issue_deleted', user: who(J.ana), issue: { id: i.id, key: i.key, fields: { summary: 'Resumo do corpo', project: { key: p } } } });
    J.issues.delete(x.key);
    J.issues.delete(y.key);
    expect((await hook(del(y))).status).toBe(200);
    expect((await hook(del(x))).status).toBe(200);
    await drain();
    const list = await posts(room._id);
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({ tmid: root.id, msg: `**Ana Teste** excluiu ${x.key}: Issue que será excluída` });
    expect(list[1].extra.tshow).toBe(true);
    expect(list[1].extra.jira.issues[0]).toMatchObject({ key: x.key, summary: 'Issue que será excluída', status: { name: 'Excluída' } });
  });

  it('B6: comentário logo depois de a issue ganhar nível de segurança não é publicado (a releitura não usa cache)', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id] });
    const i = issue(p, { summary: 'Chamado do cliente X' });
    const h = J.addHistory(i.key, [status('Aberta', 'Em andamento')], { author: J.ana });
    expect((await hook(updatedBody(i, h))).status).toBe(200);
    await drain();
    expect(await posts(room._id)).toHaveLength(1);
    // Segundos depois a issue ganha nível de segurança e recebe um comentário: o corpo de comment_created não traz
    // fields.security, então só a releitura protege.
    i.fields.security = { id: '10100', name: 'Restrito' };
    const c = J.addComment(i.key, 'Dados do contrato confidencial', { author: J.bruno });
    const reads = J.calls(`/rest/api/3/issue/${i.id}`).length;
    const body = {
      timestamp: Date.now(),
      webhookEvent: 'comment_created',
      user: who(J.bruno),
      issue: { id: i.id, key: i.key, fields: { summary: i.fields.summary, project: { key: p } } },
      comment: { id: c.id, body: 'x', author: who(J.bruno), created: c.created },
    };
    expect((await hook(body)).status).toBe(200);
    await drain();
    expect(await posts(room._id)).toHaveLength(1);
    expect(J.calls(`/rest/api/3/issue/${i.id}`).length).toBe(reads + 1);
    expect(await activityTexts()).toContain(`${i.key}: issue ou comentário com acesso restrito no Jira não é avisado no chat.`);
  });

  it('exclusão de issue criada pelo chat (UX 5.6) cuja raiz tem a prévia de outra issue → cartão da issue certa; sem cartão dela no tópico → nada', async () => {
    const p = newProject();
    J.createmeta[p] = J.createmeta.OPS;
    J.addIssue({ key: 'OPS-7001', summary: 'Issue antiga citada na mensagem' });
    const carla = await newUser(A);
    await linkToken(carla, account('Carla Rev'));
    const room = await channel(A, [carla.username]);
    await onlyRule({ projects: [p], roomIds: [room._id], events: ['created', 'status', 'deleted'] });
    const del = (i: any) => ({ timestamp: Date.now(), webhookEvent: 'jira:issue_deleted', user: who(J.ana), issue: { id: i.id, key: i.key, fields: { summary: 'Resumo do corpo', project: { key: p } } } });

    // "Criei a issue" respondeu no tópico da mensagem: a exclusão usa o cartão dessa resposta.
    const m = await send(carla, room._id, 'Parecido com OPS-7001, cliente sem áudio');
    await waitUnfurl(m._id);
    expect((await jiraOf(m._id))?.issues?.[0]?.key).toBe('OPS-7001');
    const r = await api('POST', 'jira.issue.create', { roomId: room._id, messageId: m._id, projectKey: p, issueTypeId: '10002', summary: 'Cliente sem áudio', description: 'x', replyInThread: true }, carla);
    expect(r.status).toBe(200);
    const created = J.issues.get(r.issue.key)!;
    J.issues.delete(created.key);
    expect((await hook(del(created))).status).toBe(200);
    await drain();
    let list = await posts(room._id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ tmid: m._id, msg: `**Ana Teste** excluiu ${created.key}: Cliente sem áudio` });
    expect(list[0].extra.jira.issues[0]).toMatchObject({ key: created.key, summary: 'Cliente sem áudio', status: { name: 'Excluída' } });

    // Sem resposta no tópico e com a prévia de outra issue na raiz: a sala nunca viu esta issue.
    const m2 = await send(carla, room._id, 'De novo a OPS-7001');
    await waitUnfurl(m2._id);
    const r2 = await api('POST', 'jira.issue.create', { roomId: room._id, messageId: m2._id, projectKey: p, issueTypeId: '10002', summary: 'Outra', description: '', replyInThread: false }, carla);
    expect(r2.status).toBe(200);
    const created2 = J.issues.get(r2.issue.key)!;
    J.issues.delete(created2.key);
    expect((await hook(del(created2))).status).toBe(200);
    await drain();
    list = await posts(room._id);
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain('OPS-7001');
  });

  it('exclusão em massa (12 issues já avisadas, no mesmo minuto) → resumo com as exclusões', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id], events: ['status', 'deleted'] });
    const list: any[] = [];
    for (let n = 0; n < 12; n++) {
      const i = issue(p, { summary: `Chamado ${n + 1}` });
      const h = J.addHistory(i.key, [status('Aberta', 'Em andamento')]);
      expect((await hook(updatedBody(i, h))).status).toBe(200);
      await drain();
      list.push(i);
    }
    expect(await posts(room._id)).toHaveLength(12);
    for (const i of list) {
      J.issues.delete(i.key);
      expect((await hook({ timestamp: Date.now(), webhookEvent: 'jira:issue_deleted', user: who(J.ana), issue: { id: i.id, key: i.key, fields: { project: { key: p } } } })).status).toBe(200);
    }
    await drain();
    const after = (await posts(room._id)).slice(12);
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ tmid: null, msg: `12 avisos do Jira em ${p} no último minuto.` });
    expect(after[1].tmid).toBe(after[0].id);
    const lines = String(after[1].msg).split('\n');
    expect(lines).toHaveLength(12);
    expect(lines).toContain(`${list[0].key} Chamado 1: **Ana Teste** excluiu`);
    expect(await activityTexts()).toContain(`12 avisos do Jira foram agrupados num resumo em #${room.name}.`);
  });

  it('entrega assinada com horário de mais de 24 horas (ou sem horário) → 200 sem tarefa, e a linha na atividade', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id] });
    const i = issue(p);
    const h = J.addHistory(i.key, [status('Aberta', 'Em andamento')]);
    const jobs = async () => Number((await one(`SELECT count(*)::int AS n FROM integration_jobs WHERE kind = 'jira.webhook' AND payload->'issue'->>'id' = $1`, [i.id]))!.n);
    expect((await hook({ ...updatedBody(i, h), timestamp: Date.now() - 25 * 3_600_000 }, { delivery: uniq('entrega') })).status).toBe(200);
    const { timestamp: _ts, ...noTime } = updatedBody(i, h);
    expect((await hook(noTime)).status).toBe(200);
    expect(await jobs()).toBe(0);
    expect(await activityTexts()).toContain('Chegou uma chamada no webhook do Jira com data de mais de 24 horas atrás (ou sem data). Ela foi ignorada.');
    // Dentro das 24 horas (as novas tentativas do Jira vêm em até umas 2 horas): vale.
    expect((await hook({ ...updatedBody(i, h), timestamp: Date.now() - 23 * 3_600_000 })).status).toBe(200);
    expect(await jobs()).toBe(1);
    await drain();
    expect(await posts(room._id)).toHaveLength(1);
  });

  it('a mesma entrega assinada reenviada 8 dias depois (chaves vistas já limpas) não publica de novo', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id] });
    const i = issue(p);
    const h = J.addHistory(i.key, [status('Aberta', 'Em andamento')]);
    const raw = JSON.stringify(updatedBody(i, h));
    const delivery = uniq('entrega');
    expect((await hook(raw, { delivery })).status).toBe(200);
    await drain();
    expect(await posts(room._id)).toHaveLength(1);
    // Oito dias depois: a limpeza apagou as chaves vistas e as tarefas desta entrega.
    await pool.query(`UPDATE integration_seen SET created_at = now() - interval '8 days' WHERE key = $1 OR key LIKE $2`, [delivery, `%h:${h.id}`]);
    await pool.query(`UPDATE integration_jobs SET finished_at = now() - interval '8 days', created_at = now() - interval '8 days' WHERE dedupe_key = $1 OR dedupe_key LIKE $2`, [`jira.webhook:${delivery}`, `%:h:${h.id}`]);
    await sweepJobs();
    expect(await one(`SELECT 1 FROM integration_seen WHERE key = $1 OR key LIKE $2`, [delivery, `%h:${h.id}`])).toBeNull();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 8 * 86_400_000);
    try {
      expect((await hook(raw, { delivery })).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    await drain();
    expect(await posts(room._id)).toHaveLength(1);
  });

  it('mudança numa Descrição enorme: a fila e o aviso guardam só um trecho', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id], events: ['updated'] });
    const i = issue(p);
    const big = 'Texto longo da descrição. '.repeat(800);
    const h = J.addHistory(i.key, [{ field: 'description', fieldId: 'description', fromString: big, toString: `${big}!` }], { author: J.ana });
    expect((await hook(updatedBody(i, h))).status).toBe(200);
    const job = await one(`SELECT payload FROM integration_jobs WHERE kind = 'jira.webhook' AND payload->'issue'->>'id' = $1`, [i.id]);
    expect(String(job!.payload.changelog.items[0].toString).length).toBeLessThanOrEqual(1000);
    await drain();
    const [m] = await posts(room._id);
    expect(m.msg).toBe(`**Ana Teste** alterou Descrição em [${i.key}](${urlOfIssue(i.key)})`);
    const change = m.extra.jira.event.changes[0];
    expect([...change.from].length).toBeLessThanOrEqual(300);
    expect([...change.to].length).toBeLessThanOrEqual(300);
  });

  it('a consulta (runPollerOnce) e o webhook montam a mesma mensagem para a mesma mudança', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id] });
    const a = issue(p, { summary: 'Mesmo resumo', status: 'Em andamento', assignee: J.bruno });
    const b = issue(p, { summary: 'Mesmo resumo', status: 'Em andamento', assignee: J.bruno });
    const ha = J.addHistory(a.key, [status('Aberta', 'Em andamento')], { author: J.ana });
    expect((await hook(updatedBody(a, ha))).status).toBe(200);
    await drain();
    J.addHistory(b.key, [status('Aberta', 'Em andamento')], { author: J.ana });
    await poll();
    const list = await posts(room._id);
    expect(list).toHaveLength(2);
    const norm = (m: any, i: any) => {
      const out = JSON.parse(JSON.stringify({ msg: m.msg, jira: m.extra.jira, attachments: m.attachments }).replaceAll(i.key, 'CHAVE'));
      delete out.jira.issues[0].id;
      delete out.jira.issues[0].updatedAt;
      delete out.jira.event.at;
      return out;
    };
    expect(norm(list[1], b)).toEqual(norm(list[0], a));
  });

  it('o mesmo evento visto pela consulta e depois pelo webhook não é publicado de novo; outro projeto não é publicado', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id] });
    const i = issue(p);
    const h = J.addHistory(i.key, [status('Aberta', 'Em andamento')]);
    await poll();
    expect(await posts(room._id)).toHaveLength(1);
    expect((await hook(updatedBody(i, h))).status).toBe(200);
    await drain();
    expect(await posts(room._id)).toHaveLength(1);

    const other = J.addIssue({ key: `OPS-${++iseq}` });
    const oh = J.addHistory(other.key, [status('Aberta', 'Em andamento')]);
    expect((await hook(updatedBody(other, oh))).status).toBe(200);
    await drain();
    expect(await posts(room._id)).toHaveLength(1);
  });

  // ---------- Troca de site (D25): os ids do Jira (issue, histórico, comentário) são de cada site e se repetem ----------

  const toOtherSite = async () => {
    const r = await api('POST', 'jira.config.save', { siteUrl: J2.origin, authType: 'basic', accountEmail: J2.service.email, apiToken: J2.serviceToken, enabled: true }, A);
    expect(r.config?.siteUrl).toBe(J2.origin);
  };
  const projectOnBoth = () => {
    const p = newProject();
    J2.projects.push({ ...J.projects.find((x) => x.key === p) });
    return p;
  };
  const sharedId = () => String(90000 + ++iseq);
  const deletedBody = (i: any, p: string, actor = J.ana) => ({ timestamp: Date.now(), webhookEvent: 'jira:issue_deleted', user: who(actor), issue: { id: i.id, key: i.key, fields: { project: { key: p } } } });
  const SITE_JOBS = ['jira.webhook', 'jira.post', 'jira.unfurl', 'jira.remotelink'];
  const restrictedLine = (key: string) => `${key}: issue ou comentário com acesso restrito no Jira não é avisado no chat.`;
  const notVisibleLine = (key: string) => `${key}: a conta da integração não vê esta issue; o aviso não foi publicado.`;

  it('troca de site: issue do site novo com o id de uma já avisada no antigo → o status abre outro tópico e a exclusão usa o cartão dela; sem cartão no site novo, nada', async () => {
    const p = projectOnBoth();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id], events: ['status', 'deleted'] });
    const [idX, idY] = [sharedId(), sharedId()];
    const oldX = issue(p, { id: idX, summary: 'Issue X do site antigo' });
    const oldY = issue(p, { id: idY, summary: 'Issue Y do site antigo' });
    for (const o of [oldX, oldY]) expect((await hook(updatedBody(o, J.addHistory(o.key, [status('Aberta', 'Em andamento')], { author: J.ana })))).status).toBe(200);
    await drain();
    const before = await posts(room._id);
    expect(before.map((m) => m.extra.jira.issues[0].key).sort()).toEqual([oldX.key, oldY.key].sort());

    await toOtherSite();
    try {
      const newX = J2.addIssue({ key: `${p}-${++iseq}`, id: idX, summary: 'Issue X do site novo' });
      const newY = J2.addIssue({ key: `${p}-${++iseq}`, id: idY, summary: 'Issue Y do site novo' });
      const h = J2.addHistory(newX.key, [status('Aberta', 'Concluído')], { author: J2.ana });
      expect((await hook({ ...updatedBody(newX, h), user: who(J2.ana) })).status).toBe(200);
      await drain();
      const [statusPost] = (await posts(room._id)).slice(2);
      expect(statusPost).toMatchObject({ tmid: null, msg: `**Ana Teste** moveu [${newX.key}](${J2.origin}/browse/${newX.key}) de **Aberta** para **Concluído**` });
      expect(statusPost.extra.jira.site).toBe(J2.origin);

      J2.issues.delete(newX.key);
      J2.issues.delete(newY.key);
      expect((await hook(deletedBody(newX, p, J2.ana))).status).toBe(200);
      expect((await hook(deletedBody(newY, p, J2.ana))).status).toBe(200);
      await drain();
      const after = (await posts(room._id)).slice(2);
      expect(after).toHaveLength(2);
      expect(after[1]).toMatchObject({ tmid: statusPost.id, msg: `**Ana Teste** excluiu ${newX.key}: Issue X do site novo` });
      expect(after[1].extra.jira.issues[0]).toMatchObject({ key: newX.key, url: `${J2.origin}/browse/${newX.key}`, status: { name: 'Excluída' } });
      expect(JSON.stringify(after)).not.toContain(oldX.key);
      expect(JSON.stringify(after)).not.toContain(oldY.key);
    } finally {
      await configure();
    }
  });

  it('troca de site: criação, mudança e comentário do site novo com ids já vistos no antigo são avisados', async () => {
    const p = projectOnBoth();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id], events: ['created', 'status', 'commented'], threads: false });
    const [id, hid, cid] = [sharedId(), sharedId(), sharedId()];
    const created = (i: any, actor: FakeAccount) => ({ timestamp: Date.now(), webhookEvent: 'jira:issue_created', user: who(actor), issue: { id: i.id, key: i.key, fields: { project: { key: p } } } });
    const commented = (i: any, c: any, actor: FakeAccount) => ({
      timestamp: Date.now(),
      webhookEvent: 'comment_created',
      user: who(actor),
      issue: { id: i.id, key: i.key, fields: { project: { key: p } } },
      comment: { id: c.id, author: who(actor), created: c.created },
    });
    async function threeEvents(F: FakeJira, i: any) {
      expect((await hook(created(i, F.ana))).status).toBe(200);
      expect((await hook({ ...updatedBody(i, F.addHistory(i.key, [status('Aberta', 'Em andamento')], { id: hid, author: F.ana })), user: who(F.ana) })).status).toBe(200);
      expect((await hook(commented(i, F.addComment(i.key, `Comentário em ${i.key}`, { id: cid, author: F.ana }), F.ana))).status).toBe(200);
      await drain();
    }
    const old = issue(p, { id, summary: 'Criada no site antigo', created: new Date() });
    await threeEvents(J, old);
    expect(await posts(room._id)).toHaveLength(3);

    await toOtherSite();
    try {
      const fresh = J2.addIssue({ key: `${p}-${++iseq}`, id, summary: 'Criada no site novo', created: new Date() });
      await threeEvents(J2, fresh);
      const after = (await posts(room._id)).slice(3);
      expect(after.map((m) => m.extra.jira.event.kind).sort()).toEqual(['commented', 'created', 'status']);
      for (const m of after) expect(m.extra.jira).toMatchObject({ site: J2.origin, issues: [{ key: fresh.key, url: `${J2.origin}/browse/${fresh.key}` }] });
      const comment = after.find((m) => m.extra.jira.event.kind === 'commented')!.extra.jira.event.comment;
      expect(comment).toMatchObject({ id: cid });
      expect(comment.excerpt).toContain(fresh.key);
    } finally {
      await configure();
    }
  });

  it('troca de site: as linhas de issue restrita e de issue que a integração não vê voltam a aparecer para a issue do site novo com o mesmo id', async () => {
    const p = projectOnBoth();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id], events: ['status'] });
    const [idR, idN] = [sharedId(), sharedId()];
    async function twoSkips(F: FakeJira) {
      const keys = [`${p}-${++iseq}`, `${p}-${++iseq}`];
      const r = F.addIssue({ key: keys[0], id: idR, security: true });
      expect((await hook({ ...updatedBody(r, F.addHistory(r.key, [status('Aberta', 'Em andamento')], { author: F.ana })), user: who(F.ana) })).status).toBe(200);
      // O id idN não existe para a conta da integração: a releitura dá 404.
      const ghost = { id: idN, key: keys[1], fields: { project: { key: p } } };
      expect((await hook({ timestamp: Date.now(), webhookEvent: 'jira:issue_updated', user: who(F.ana), issue: ghost, changelog: { id: sharedId(), items: [status('Aberta', 'Em andamento')] } })).status).toBe(200);
      await drain();
      return keys;
    }
    const [oldR, oldN] = await twoSkips(J);
    expect(await activityTexts()).toEqual(expect.arrayContaining([restrictedLine(oldR), notVisibleLine(oldN)]));

    await toOtherSite();
    try {
      const [newR, newN] = await twoSkips(J2);
      expect(await activityTexts()).toEqual(expect.arrayContaining([restrictedLine(newR), notVisibleLine(newN)]));
      expect(await posts(room._id)).toEqual([]);
    } finally {
      await configure();
    }
  });

  it('troca de site: tarefas do site antigo na fila ou com falha são descartadas (não releem pelo id no site novo), com uma linha na atividade', async () => {
    const p = projectOnBoth();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id], events: ['status'] });
    const ids = [sharedId(), sharedId(), sharedId()];
    const olds = ids.map((id) => issue(p, { id }));
    const bodies = olds.map((o) => updatedBody(o, J.addHistory(o.key, [status('Aberta', 'Em andamento')], { author: J.ana })));
    // 1: já relida, com o aviso esperando os 5 s da rajada; 2: entrega na fila; 3: entrega que falhou de vez.
    expect((await hook(bodies[0])).status).toBe(200);
    await drainJobs();
    expect((await hook(bodies[1])).status).toBe(200);
    expect((await hook(bodies[2])).status).toBe(200);
    await pool.query(`UPDATE integration_jobs SET status = 'dead', finished_at = now() WHERE kind = 'jira.webhook' AND status = 'queued' AND payload->'issue'->>'id' = $1`, [ids[2]]);
    const pending = async () =>
      Number(
        (await one(`SELECT count(*)::int AS n FROM integration_jobs WHERE status IN ('queued', 'dead') AND (payload->'issue'->>'id' = ANY($1::text[]) OR payload->'ev'->>'issueId' = ANY($1::text[]))`, [ids]))!.n,
      );
    expect(await pending()).toBe(3);
    const all = Number((await one(`SELECT count(*)::int AS n FROM integration_jobs WHERE kind = ANY($1::text[]) AND status IN ('queued', 'dead')`, [SITE_JOBS]))!.n);
    expect(all).toBeGreaterThanOrEqual(3);

    await toOtherSite();
    try {
      for (const [n, id] of ids.entries()) J2.addIssue({ key: `${p}-${++iseq}`, id, summary: `Outra issue ${n} do site novo` });
      const reads = J2.calls(/\/rest\/api\/3\/issue\/\d+$/).length;
      expect(await pending()).toBe(0);
      expect(await activityTexts()).toContain(`${all} tarefas do endereço antigo do Jira (na fila ou com falha) foram descartadas.`);
      await drain();
      expect(await posts(room._id)).toEqual([]);
      expect(J2.calls(/\/rest\/api\/3\/issue\/\d+$/).length).toBe(reads);
    } finally {
      await configure();
    }
  });

  it('troca de site: issue criada pelo chat no site antigo (tópico na mensagem da pessoa, sem cartão) → criação e status da issue do site novo com o mesmo id são avisados fora desse tópico', async () => {
    const p = projectOnBoth();
    J.createmeta[p] = J.createmeta.OPS;
    const dani = await newUser(A);
    await linkToken(dani, account('Dani Teste'));
    const room = await channel(A, [dani.username]);
    const rule = await onlyRule({ projects: [p], roomIds: [room._id], events: ['created', 'status'] });
    const m = await send(dani, room._id, 'Ramal 4 mudo desde cedo');
    const r = await api('POST', 'jira.issue.create', { roomId: room._id, messageId: m._id, projectKey: p, issueTypeId: '10002', summary: 'Ramal mudo', description: 'Desde cedo.', replyInThread: false }, dani);
    const created = J.issues.get(r.issue?.key)!;
    expect(await one(`SELECT message_id FROM jira_threads WHERE integration_id = $1 AND issue_id = $2`, [rule._id, created.id])).toEqual({ message_id: m._id });

    await toOtherSite();
    try {
      expect(await one(`SELECT 1 FROM jira_threads WHERE integration_id = $1`, [rule._id])).toBeNull();
      const fresh = J2.addIssue({ key: `${p}-${++iseq}`, id: created.id, summary: 'Outra issue do site novo', created: new Date() });
      // Criada no Jira (não pelo chat): a marca "criada pelo chat" do id no site antigo não vale aqui.
      expect((await hook({ timestamp: Date.now(), webhookEvent: 'jira:issue_created', user: who(J2.ana), issue: { id: fresh.id, key: fresh.key, fields: { project: { key: p } } } })).status).toBe(200);
      await drain();
      const h = J2.addHistory(fresh.key, [status('Aberta', 'Em andamento')], { author: J2.ana });
      expect((await hook({ ...updatedBody(fresh, h), user: who(J2.ana) })).status).toBe(200);
      await drain();
      const list = await posts(room._id);
      expect(list.map((x) => x.extra.jira.event.kind)).toEqual(['created', 'status']);
      expect(list.map((x) => x.tmid)).toEqual([null, list[0].id]);
      expect(list.map((x) => x.extra.jira.issues[0].key)).toEqual([fresh.key, fresh.key]);
    } finally {
      await configure();
    }
  });

  it('issue.self do site configurado → aceita; a recusa de outro Jira só compara endereços do Jira Cloud (aqui, um endereço liberado no ambiente)', async () => {
    const p = newProject();
    const room = await channel(A);
    await onlyRule({ projects: [p], roomIds: [room._id], events: ['status'] });
    for (const self of [(i: any) => `${J.origin}/rest/api/2/issue/${i.id}`, (i: any) => `https://outro-jira-teste.atlassian.net/rest/api/2/issue/${i.id}`]) {
      const i = issue(p);
      const body = updatedBody(i, J.addHistory(i.key, [status('Aberta', 'Em andamento')], { author: J.ana }));
      expect((await hook({ ...body, issue: { ...body.issue, self: self(i) } })).status).toBe(200);
    }
    await drain();
    expect(await posts(room._id)).toHaveLength(2);
    expect((await activityTexts()).filter((t) => t.startsWith('Chegou uma chamada no webhook vinda de outro Jira'))).toEqual([]);
  });

  it('troca de site: trabalho do site antigo que termina depois da limpeza (tópico e aviso gravados tarde) não se mistura com o site novo', async () => {
    const p = projectOnBoth();
    const room = await channel(A);
    const rule = await onlyRule({ projects: [p], roomIds: [room._id], events: ['status', 'deleted'] });
    const [idX, idY] = [sharedId(), sharedId()];
    const oldX = issue(p, { id: idX });
    const oldY = issue(p, { id: idY });
    for (const o of [oldX, oldY]) expect((await hook(updatedBody(o, J.addHistory(o.key, [status('Aberta', 'Em andamento')], { author: J.ana })))).status).toBe(200);
    await drain();
    const [rootX, rootY] = await posts(room._id);
    const job = await one(`SELECT payload FROM integration_jobs WHERE kind = 'jira.post' AND payload->'ev'->>'issueId' = $1`, [idX]);
    expect(job!.payload.origin).toBe(J.origin);

    await toOtherSite();
    try {
      // O que uma tarefa do site antigo, ainda rodando na hora da troca, grava depois da limpeza: o tópico e outro aviso.
      for (const [o, root] of [[oldX, rootX], [oldY, rootY]] as const) {
        await pool.query(`INSERT INTO jira_threads (integration_id, room_id, issue_id, issue_key, message_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [rule._id, room._id, o.id, o.key, root.id]);
      }
      expect(await enqueue('jira.post', { ...job!.payload, origin: J.origin, ev: { ...job!.payload.ev, key: `h:${sharedId()}` } }, { integrationId: rule._id })).toBeTruthy();
      await drain();
      expect(await posts(room._id)).toHaveLength(2);

      const newX = J2.addIssue({ key: `${p}-${++iseq}`, id: idX, summary: 'Issue X do site novo' });
      const newY = J2.addIssue({ key: `${p}-${++iseq}`, id: idY });
      const h = J2.addHistory(newX.key, [status('Aberta', 'Em andamento')], { author: J2.ana });
      expect((await hook({ ...updatedBody(newX, h), user: who(J2.ana) })).status).toBe(200);
      J2.issues.delete(newY.key);
      expect((await hook(deletedBody(newY, p, J2.ana))).status).toBe(200);
      await drain();
      const after = (await posts(room._id)).slice(2);
      expect(after).toHaveLength(1);
      expect(after[0].tmid).toBeNull();
      expect(after[0].extra.jira.issues[0]).toMatchObject({ key: newX.key, url: `${J2.origin}/browse/${newX.key}` });
    } finally {
      await configure();
    }
  });
});

// ---------- Prévias ----------

describe('Jira: prévias', () => {
  beforeAll(async () => {
    J.addIssue({ key: 'OPS-2001', summary: 'Fila de ligações parada' });
    J.addIssue({ key: 'OPS-2002', summary: 'Restrita', security: true });
    J.addIssue({ key: 'OPS-2003', summary: 'Segunda issue' });
    J.addIssue({ key: 'SECRET-2004', summary: 'Projeto restrito' });
  });

  it('chave visível → prévia; outro projeto, chave em código e issue com nível de segurança → nada', async () => {
    const ok = await send(anaU, ops._id, 'Olhem a OPS-2001, por favor');
    await waitUnfurl(ok._id);
    expect(await jiraOf(ok._id)).toMatchObject({ kind: 'preview', site: J.origin, issues: [{ key: 'OPS-2001', summary: 'Fila de ligações parada', url: urlOfIssue('OPS-2001') }] });
    for (const text of ['E a SECRET-2004?', 'Em código: `OPS-2001`', 'Restrita: OPS-2002']) {
      const m = await send(anaU, ops._id, text);
      await waitUnfurl(m._id, text.includes('OPS-2002'));
      expect(await jiraOf(m._id), text).toBeNull();
    }
  });

  it('editar tirando a chave remove a prévia', async () => {
    const m = await send(anaU, ops._id, 'Veja OPS-2003');
    await waitUnfurl(m._id);
    expect((await jiraOf(m._id))?.kind).toBe('preview');
    expect((await api('POST', 'chat.update', { roomId: ops._id, msgId: m._id, text: 'Deixa para lá' }, anaU)).status).toBe(200);
    for (let n = 0; n < 40 && (await jiraOf(m._id)); n++) await sleep(50);
    expect(await jiraOf(m._id)).toBeNull();
  });

  it('jira.preview.remove pelo autor funciona, por outro membro é 403; jiraNoPreview impede nova prévia ao editar', async () => {
    const m = await send(anaU, ops._id, 'Status da OPS-2001?');
    await waitUnfurl(m._id);
    expect((await jiraOf(m._id))?.kind).toBe('preview');
    const denied = await api('POST', 'jira.preview.remove', { messageId: m._id }, reader);
    expect(denied.status).toBe(403);
    expect(denied.error).toBe('Só quem enviou a mensagem ou um moderador pode remover a prévia.');
    expect((await api('POST', 'jira.preview.remove', { messageId: m._id }, anaU)).status).toBe(200);
    const row = await one('SELECT extra FROM messages WHERE id = $1', [m._id]);
    expect(row!.extra.jira).toBeUndefined();
    expect(row!.extra.jiraNoPreview).toBe(true);
    await api('POST', 'chat.update', { roomId: ops._id, msgId: m._id, text: 'Status da OPS-2003?' }, anaU);
    await waitUnfurl(m._id, false);
    expect(await jiraOf(m._id)).toBeNull();
  });
});

// ---------- Issues ----------

describe('Jira: issues', () => {
  let op1: Auth;
  let sup2: Auth;
  let dm = '';
  let dmMsg = '';
  let notice: { _id: string; name: string };

  beforeAll(async () => {
    await ensureLinked(anaU, J.ana);
    await ensureLinked(brunoU, J.bruno);
    J.addIssue({ key: 'OPS-3001', summary: 'Fila de retorno lenta' });
    J.addIssue({ key: 'SUP-3002', summary: 'Cliente sem acesso ao portal' });
    J.addIssue({ key: 'SECRET-3003', summary: 'Contrato confidencial' });
    // DM entre dois restritos (operacao), aberta antes da restrição valer.
    await grant('use-jira', 'operacao');
    await grant('create-jira-issue', 'operacao');
    op1 = await newUser(A, { roles: ['operacao'] });
    sup2 = await newUser(A);
    dm = (await api('POST', 'im.create', { username: sup2.username }, op1)).room._id;
    dmMsg = (await send(op1, dm, 'Abrir chamado para a fila 2?'))._id;
    await api('POST', 'roles.addUserToRole', { roleId: 'operacao', username: sup2.username }, A);
    await api('POST', 'roles.removeUserFromRole', { roleId: 'user', username: sup2.username }, A);
    notice = await channel(A, [reader.username, anaU.username], { extraData: { notice: true } });
  });

  it('busca com a conta vinculada manda o Basic da própria pessoa', async () => {
    const before = J.server.calls.length;
    const r = await api('GET', 'jira.search', { q: 'fila' }, anaU);
    expect(r.status).toBe(200);
    expect(r.identity).toBe('user');
    const call = J.server.calls.slice(before).find((c) => c.path === '/rest/api/3/search/jql')!;
    expect(call.headers.authorization).toBe(J.basic(J.ana.email, tokenOf(J.ana)));
    expect(call.query.jql).toBe('text ~ "fila" ORDER BY updated DESC');
  });

  it('B3: sem conta vinculada, a busca vira só texto dentro dos projetos visíveis', async () => {
    const before = J.server.calls.length;
    const r = await api('GET', 'jira.search', { q: 'x) OR (project = SECRET' }, reader);
    expect(r.status).toBe(200);
    expect(r).toMatchObject({ identity: 'integration', jql: 'project in (OPS, SUP) AND text ~ "x OR project = SECRET" ORDER BY updated DESC' });
    const call = J.server.calls.slice(before).find((c) => c.path.endsWith('/search/jql'))!;
    expect(call.query.jql).toBe('project in (OPS, SUP) AND text ~ "x OR project = SECRET" ORDER BY updated DESC');
    expect(call.headers.authorization).toBe(J.basic(J.service.email, J.serviceToken));
    expect(r.issues.every((s: any) => ['OPS', 'SUP'].includes(s.project.key))).toBe(true);
  });

  it('resultado com issue de nível de segurança ou de outro projeto é filtrado', async () => {
    const shape = (key: string, extra: Record<string, unknown> = {}) => {
      const raw = J.addIssue({ key, ...extra });
      J.issues.delete(key);
      const { descriptionText: _d, ...fields } = raw.fields;
      return { id: raw.id, key: raw.key, fields };
    };
    const list = [shape('OPS-3101', { summary: 'Filtro misto visível' }), shape('OPS-3102', { security: true }), shape('SECRET-3103')];
    const off = J.intercept((req) => (req.path.endsWith('/search/jql') && String(req.query.jql).includes('text ~ "filtro misto"') ? { body: { issues: list, isLast: true } } : null));
    try {
      const r = await api('GET', 'jira.search', { q: 'filtro misto' }, reader);
      expect(r.issues.map((s: any) => s.key)).toEqual(['OPS-3101']);
    } finally {
      off();
    }
  });

  it('busca vazia → "Digite o que procurar." (§11), também no "Ver mais"', async () => {
    for (const q of [undefined, '', '   ', '"*?"']) {
      const r = await api('GET', 'jira.search', q === undefined ? {} : { q }, anaU);
      expect(r.status, String(q)).toBe(400);
      expect(r.errorType).toBe('error-invalid-params');
      expect(r.error).toBe('Digite o que procurar.');
    }
    const more = await api('POST', 'jira.search.more', { rid: ops._id, q: '', mode: 'text', nextPageToken: 'pagina-2' }, anaU);
    expect(more.status).toBe(400);
    expect(more.error).toBe('Digite o que procurar.');
  });

  it('jql sem conta vinculada → error-jira-link-required', async () => {
    const r = await api('GET', 'jira.search', { q: 'assignee = currentUser()', mode: 'jql' }, reader);
    expect(r.status).toBe(403);
    expect(r.errorType).toBe('error-jira-link-required');
    expect(r.error).toBe('Busca com JQL usa a sua conta do Jira. Conecte sua conta com /jira conectar.');
  });

  it('criar com a conta vinculada a partir de uma mensagem → ADF com o link de volta, resposta no tópico e o link remoto na issue', async () => {
    const m = await send(anaU, ops._id, 'Cliente reclamou da espera na fila 4');
    const r = await api('POST', 'jira.issue.create', { roomId: ops._id, messageId: m._id, projectKey: 'OPS', issueTypeId: '10002', summary: 'Espera alta na fila 4', description: 'Ver gravações.', replyInThread: true }, anaU);
    expect(r.status).toBe(200);
    const created = J.created[J.created.length - 1];
    expect(created.by).toBe(J.ana.accountId);
    const permalink = `https://203.0.113.10/channel/${ops._id}?msg=${m._id}`;
    const desc = JSON.stringify(created.body.fields.description);
    expect(desc).toContain('Ver gravações.');
    expect(desc).toContain('"text":"Abrir no Wescc Chat: "');
    expect(desc).toContain(`{"type":"text","text":"${permalink}","marks":[{"type":"link","attrs":{"href":"${permalink}"}}]}`);
    expect(desc).toContain('Cliente reclamou da espera na fila 4');
    expect(desc).not.toContain('Criada por');
    expect(created.body.fields).toMatchObject({ project: { key: 'OPS' }, issuetype: { id: '10002' }, summary: 'Espera alta na fila 4' });
    const reply = await one('SELECT tmid, user_id, extra FROM messages WHERE id = $1', [r.messageId]);
    expect(reply).toMatchObject({ tmid: m._id, user_id: anaU.userId });
    expect(reply!.extra.jira.viaIntegration).toBeUndefined();
    await drain();
    expect(J.remoteLinks[J.remoteLinks.length - 1]).toEqual({ key: r.issue.key, body: { globalId: `wescc:${m._id}`, object: { url: permalink, title: 'Mensagem no Wescc Chat' } } });
    expect(await one(`SELECT action FROM audit_log WHERE action = 'integration.jira.issue.created' AND target->>'key' = $1`, [r.issue.key])).toBeTruthy();
  });

  it('criar com um campo obrigatório de cada tipo suportado; campo que o chat não preenche vira blockers', async () => {
    const meta = await api('GET', 'jira.createMeta', { projectKey: 'OPS', roomId: ops._id }, anaU);
    expect(meta).toMatchObject({ identity: 'user', canPost: true, project: { key: 'OPS' } });
    expect(meta.issueTypes.map((t: any) => t.id)).toEqual(['10002', '10010', '10011']);
    expect(meta.fields['10010'].map((f: any) => [f.key, f.kind])).toEqual([
      ['priority', 'priority'],
      ['assignee', 'user'],
      ['customfield_10101', 'string'],
      ['customfield_10102', 'text'],
      ['customfield_10103', 'number'],
      ['customfield_10104', 'date'],
      ['customfield_10105', 'datetime'],
      ['customfield_10106', 'option'],
      ['customfield_10107', 'options'],
      ['customfield_10108', 'labels'],
      ['customfield_10109', 'user'],
    ]);
    expect(meta.blockers['10011']).toEqual(['Local e sala']);

    const fields = {
      customfield_10101: 'ACME',
      customfield_10102: 'Detalhe técnico',
      customfield_10103: '12,5',
      customfield_10104: '2026-10-20',
      customfield_10105: '2026-10-20T14:30:00-03:00',
      customfield_10106: '201',
      customfield_10107: ['301', '302'],
      customfield_10108: 'voz urgente',
      customfield_10109: J.bruno.accountId,
    };
    const r = await api('POST', 'jira.issue.create', { roomId: ops._id, projectKey: 'OPS', issueTypeId: '10010', summary: 'Chamado completo', description: '', priorityId: '1', assigneeAccountId: null, fields, replyInThread: false }, anaU);
    expect(r.status).toBe(200);
    expect(r.messageId).toBeUndefined();
    const sent = J.created[J.created.length - 1].body.fields;
    expect(sent).toMatchObject({
      priority: { id: '1' },
      customfield_10101: 'ACME',
      customfield_10102: { type: 'doc', version: 1 },
      customfield_10103: 12.5,
      customfield_10104: '2026-10-20',
      customfield_10105: '2026-10-20T14:30:00.000-0300',
      customfield_10106: { id: '201' },
      customfield_10107: [{ id: '301' }, { id: '302' }],
      customfield_10108: ['voz', 'urgente'],
      customfield_10109: { accountId: J.bruno.accountId },
    });
    // "Sem responsável" (null) vai explícito: senão o Jira poria o responsável padrão do projeto.
    expect(sent).toHaveProperty('assignee', null);

    const blocked = await api('POST', 'jira.issue.create', { roomId: ops._id, projectKey: 'OPS', issueTypeId: '10011', summary: 'Mudança', description: '', replyInThread: false }, anaU);
    expect(blocked.status).toBe(400);
    expect(blocked.errorType).toBe('error-jira-field');
    expect(blocked.error).toBe('Este tipo de issue tem campos obrigatórios que o chat ainda não preenche: Local e sala. Crie esta issue pelo Jira.');
  });

  it('criar sem escolher responsável → o campo não vai e o Jira usa o padrão do projeto; com responsável → { accountId }', async () => {
    const base = { roomId: ops._id, projectKey: 'OPS', issueTypeId: '10002', summary: 'Responsável padrão', description: '', replyInThread: false };
    expect((await api('POST', 'jira.issue.create', base, anaU)).status).toBe(200);
    expect(J.created[J.created.length - 1].body.fields).not.toHaveProperty('assignee');
    expect((await api('POST', 'jira.issue.create', { ...base, assigneeAccountId: J.bruno.accountId }, anaU)).status).toBe(200);
    expect(J.created[J.created.length - 1].body.fields.assignee).toEqual({ accountId: J.bruno.accountId });
    expect((await api('POST', 'jira.issue.create', { ...base, assigneeAccountId: null }, anaU)).status).toBe(200);
    expect(J.created[J.created.length - 1].body.fields.assignee).toBeNull();
  });

  it('criar pela conta da integração (permitido) → parágrafo de atribuição; sem permissão → identity none e error-jira-link-required', async () => {
    await configure({ createAsIntegration: true });
    const me = await one('SELECT name FROM users WHERE id = $1', [reader.userId]);
    expect((await api('GET', 'jira.createMeta', { projectKey: 'OPS', roomId: ops._id }, reader)).identity).toBe('integration');
    const m = await send(reader, ops._id, 'Fila 5 sem atendentes');
    const r = await api('POST', 'jira.issue.create', { roomId: ops._id, messageId: m._id, projectKey: 'OPS', issueTypeId: '10002', summary: 'Fila 5 sem atendentes', description: 'Urgente.', replyInThread: true }, reader);
    expect(r.status).toBe(200);
    const created = J.created[J.created.length - 1];
    expect(created.by).toBe(J.service.accountId);
    expect(JSON.stringify(created.body.fields.description)).toContain(`Criada por ${me!.name} (@${reader.username}) pelo ${getSetting('Site_Name')}.`);
    expect((await jiraOf(r.messageId))).toMatchObject({ kind: 'created', viaIntegration: true });

    await configure({ createAsIntegration: false });
    expect((await api('GET', 'jira.createMeta', { projectKey: 'OPS', roomId: ops._id }, reader)).identity).toBe('none');
    const denied = await api('POST', 'jira.issue.create', { roomId: ops._id, projectKey: 'OPS', issueTypeId: '10002', summary: 'Outra', description: '', replyInThread: false }, reader);
    expect(denied.status).toBe(403);
    expect(denied.errorType).toBe('error-jira-link-required');
    expect(denied.error).toBe('Conecte sua conta do Jira para criar issues.');
  });

  it('§6: replyInThread numa DM entre dois operacao → 403 error-direct-restricted e nenhuma chamada ao Jira', async () => {
    await linkToken(op1, account('Otávio Teste'));
    const before = J.server.calls.length;
    const r = await api('POST', 'jira.issue.create', { roomId: dm, messageId: dmMsg, projectKey: 'OPS', issueTypeId: '10002', summary: 'Chamado', description: '', replyInThread: true }, op1);
    expect(r.status).toBe(403);
    expect(r.errorType).toBe('error-direct-restricted');
    expect(r.error).toBe(blockedText(sup2.username));
    expect(J.server.calls.length).toBe(before);
  });

  it('§6: compartilhar num canal de avisos sendo leitor → 403, sem chamar o Jira', async () => {
    const before = J.server.calls.length;
    const r = await api('POST', 'jira.issue.share', { key: 'OPS-3001', roomId: notice._id }, reader);
    expect(r.status).toBe(403);
    expect(r.error).toBe(NOTICE_TEXT);
    expect(J.server.calls.length).toBe(before);
  });

  it('M22: compartilhar issue restrita com a conta vinculada → 409, depois publica com confirmed e audita', async () => {
    const r = await api('POST', 'jira.issue.share', { key: 'SECRET-3003', roomId: ops._id }, anaU);
    expect(r.status).toBe(409);
    expect(r.errorType).toBe('error-jira-share-confirm');
    expect(r.error).toBe(`Todos em #${ops.name} vão ver o resumo e o status de SECRET-3003, inclusive quem não tem acesso a este projeto no Jira.`);
    const ok = await api('POST', 'jira.issue.share', { key: 'SECRET-3003', roomId: ops._id, confirmed: true }, anaU);
    expect(ok.status).toBe(200);
    const msg = await one('SELECT user_id, msg, extra FROM messages WHERE id = $1', [ok.messageId]);
    expect(msg).toMatchObject({ user_id: anaU.userId, msg: `[SECRET-3003](${urlOfIssue('SECRET-3003')}): Contrato confidencial` });
    expect(msg!.extra.jira).toMatchObject({ kind: 'share', by: { _id: anaU.userId } });
    expect(await one(`SELECT data FROM audit_log WHERE action = 'integration.jira.issue.shared' AND target->>'key' = 'SECRET-3003'`)).toMatchObject({ data: { roomId: ops._id, messageId: ok.messageId } });
    // Issue de projeto visível: sem confirmação nem auditoria.
    expect((await api('POST', 'jira.issue.share', { key: 'OPS-3001', roomId: ops._id }, anaU)).status).toBe(200);
  });

  it('comentar e atribuir sem conta vinculada → 403', async () => {
    for (const [path, body] of [
      ['jira.issue.comment', { key: 'OPS-3001', text: 'Olá' }],
      ['jira.issue.assign', { key: 'OPS-3001', accountId: null }],
    ] as const) {
      const r = await api('POST', path, body, reader);
      expect(r.status).toBe(403);
      expect(r.errorType).toBe('error-jira-link-required');
      expect(r.error).toBe('Conecte sua conta do Jira para comentar e atribuir issues.');
    }
  });

  it('H7: comentário numa issue do Service Management é interno, a não ser com public: true', async () => {
    expect((await api('POST', 'jira.issue.comment', { key: 'SUP-3002', text: 'Verificando o acesso' }, anaU)).status).toBe(200);
    expect(J.postedComments[J.postedComments.length - 1]).toMatchObject({ key: 'SUP-3002', body: { properties: [{ key: 'sd.public.comment', value: { internal: true } }] } });
    // O campo é public (§4.8, D26): quem manda { internal: false } continua com um comentário interno.
    expect((await api('POST', 'jira.issue.comment', { key: 'SUP-3002', text: 'Resposta ao cliente', internal: false }, anaU)).status).toBe(200);
    expect(J.postedComments[J.postedComments.length - 1].body).toMatchObject({ properties: [{ key: 'sd.public.comment', value: { internal: true } }] });
    expect((await api('POST', 'jira.issue.comment', { key: 'SUP-3002', text: 'Acesso liberado', public: true }, anaU)).status).toBe(200);
    expect(J.postedComments[J.postedComments.length - 1].body.properties).toBeUndefined();
    expect((await api('POST', 'jira.issue.comment', { key: 'OPS-3001', text: 'Projeto de software' }, anaU)).status).toBe(200);
    expect(J.postedComments[J.postedComments.length - 1].body.properties).toBeUndefined();
  });

  describe('/jira', () => {
    it('ajuda e busca são efêmeras (nenhuma linha em messages)', async () => {
      const ws = await online(anaU);
      try {
        const before = await roomMessageCount(ops._id);
        const help = await command(anaU, ws, ops._id, 'ajuda');
        expect(help).toMatchObject({ rid: ops._id, source: 'jira', tone: 'info' });
        expect(help.text.split('\n')[0]).toBe('**Jira no chat**');
        const found = await command(anaU, ws, ops._id, 'buscar fila');
        expect(found.text).toMatch(/^\d+ issues para “fila”$/);
        expect(found.issues.length).toBeGreaterThan(0);
        expect(found.issueActions).toBe(true);
        expect(await roomMessageCount(ops._id)).toBe(before);
      } finally {
        ws.close();
      }
    });

    it('criar → formulário que abre sozinho só na sessão que pediu', async () => {
      const u = await newUser(A);
      const room = await channel(A, [u.username]);
      const ws = await online(u);
      try {
        const m = await command(u, ws, room._id, 'criar Fila 6 parada');
        expect(m).toMatchObject({ tone: 'info', text: 'Abrindo o formulário de nova issue.' });
        expect(m.actions).toEqual([{ kind: 'modal', label: 'Abrir formulário', modal: 'jira-create', params: { summary: 'Fila 6 parada', roomId: room._id }, autoOpen: true, primary: true }]);
        const session = await one('SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [u.userId]);
        expect(m.autoOpenFor).toBe(sessionTag(session!.id));
      } finally {
        ws.close();
      }
    });

    it('H1: commands.run com comentar, atribuir e criar numa DM bloqueada e num canal de avisos é recusado com o texto de envio, sem chamar o Jira', async () => {
      const wsOp = await online(op1);
      const wsReader = await online(reader);
      try {
        const before = J.server.calls.length;
        for (const params of ['comentar OPS-3001 Vou verificar', 'atribuir OPS-3001 eu', 'criar Chamado novo', 'buscar fila']) {
          const a = await command(op1, wsOp, dm, params);
          expect(a, params).toMatchObject({ tone: 'err', text: blockedText(sup2.username) });
          const b = await command(reader, wsReader, notice._id, params);
          expect(b, params).toMatchObject({ tone: 'err', text: NOTICE_TEXT });
        }
        for (const [u, rid] of [
          [op1, dm],
          [reader, notice._id],
        ] as const) {
          const more = await api('POST', 'jira.search.more', { rid, q: 'fila', nextPageToken: 'MTA' }, u);
          expect(more.status).toBe(403);
        }
        expect(J.server.calls.length).toBe(before);
      } finally {
        wsOp.close();
        wsReader.close();
      }
    });

    it('UX 5.12: ninguem, nenhum, eu e o usuário sem @ funcionam', async () => {
      const ws = await online(anaU);
      try {
        expect(await command(anaU, ws, ops._id, 'atribuir OPS-3001 ninguem')).toMatchObject({ tone: 'ok', text: 'OPS-3001 ficou sem responsável.' });
        expect(J.assignments[J.assignments.length - 1]).toEqual({ key: 'OPS-3001', accountId: null });
        expect(await command(anaU, ws, ops._id, 'atribuir OPS-3001 nenhum')).toMatchObject({ tone: 'ok', text: 'OPS-3001 ficou sem responsável.' });
        expect(await command(anaU, ws, ops._id, 'atribuir ops-3001 eu')).toMatchObject({ tone: 'ok', text: 'OPS-3001 agora está com você.' });
        expect(J.assignments[J.assignments.length - 1]).toEqual({ key: 'OPS-3001', accountId: J.ana.accountId });
        const bruno = await one('SELECT name FROM users WHERE id = $1', [brunoU.userId]);
        expect(await command(anaU, ws, ops._id, `atribuir OPS-3001 ${brunoU.username}`)).toMatchObject({ tone: 'ok', text: `OPS-3001 agora está com ${bruno!.name}.` });
        expect(J.assignments[J.assignments.length - 1]).toEqual({ key: 'OPS-3001', accountId: J.bruno.accountId });
        expect(await command(anaU, ws, ops._id, `atribuir OPS-3001 @${reader.username}`)).toMatchObject({ tone: 'warn', actions: [{ kind: 'modal', modal: 'jira-assign' }] });
      } finally {
        ws.close();
      }
    });

    it('o 31º comando no mesmo minuto → o texto do limite', async () => {
      const u = await newUser(A);
      const room = await channel(A, [u.username]);
      const ws = await online(u);
      try {
        for (let n = 0; n < 30; n++) expect((await command(u, ws, room._id, 'ajuda')).tone).toBe('info');
        expect(await command(u, ws, room._id, 'ajuda')).toMatchObject({ tone: 'warn', text: 'Muitos comandos seguidos. Espere um minuto.' });
      } finally {
        ws.close();
      }
    });
  });
});

// ---------- Contas vinculadas ----------

describe('Jira: contas vinculadas', () => {
  it('token pessoal certo → conta vinculada, sem o token na resposta', async () => {
    const u = await newUser(A);
    const acc = account('Dora Teste');
    const token = tokenOf(acc);
    J.allowBasic(acc, token);
    const r = await api('POST', 'jira.link.token', { email: acc.email, token }, u);
    expect(r.status).toBe(200);
    expect(r.account).toMatchObject({ provider: 'jira', method: 'token', displayName: 'Dora Teste', email: acc.email, site: J.origin, status: 'ok' });
    expect(JSON.stringify(r)).not.toContain(token);
    const row = await one(`SELECT external_id, access_token FROM linked_accounts WHERE user_id = $1`, [u.userId]);
    expect(row!.external_id).toBe(acc.accountId);
    expect(row!.access_token).not.toContain(token);
  });

  it('token errado → o texto do §4.10', async () => {
    const u = await newUser(A);
    const acc = account('Edu Teste');
    J.allowBasic(acc, tokenOf(acc));
    const r = await api('POST', 'jira.link.token', { email: acc.email, token: 'tok-teste-errado-0123456789' }, u);
    expect(r.status).toBe(400);
    expect(r.errorType).toBe('error-jira-auth');
    expect(r.error).toBe(
      `O Jira não aceitou este e-mail e token. Confira se o token foi copiado inteiro e se é da conta ${acc.email}. Se a organização da Atlassian bloqueia tokens de API, peça ao administrador do chat para usar Entrar com a Atlassian.`,
    );
    expect(await one(`SELECT 1 AS x FROM linked_accounts WHERE user_id = $1`, [u.userId])).toBeNull();
  });

  it('token com escopos só vale pelo gateway: o vínculo usa o gateway', async () => {
    const u = await newUser(A);
    const acc = account('Fabi Teste');
    const token = await linkToken(u, acc, { gatewayOnly: true });
    expect((await one(`SELECT meta FROM linked_accounts WHERE user_id = $1`, [u.userId]))!.meta).toEqual({ base: 'gateway' });
    const before = J.server.calls.length;
    expect((await api('GET', 'jira.search', { q: 'fila' }, u)).identity).toBe('user');
    const call = J.server.calls.slice(before).find((c) => c.path.endsWith('/search/jql'))!;
    expect(call.path).toBe(`/ex/jira/${J.cloudId}/rest/api/3/search/jql`);
    expect(call.headers.authorization).toBe(J.basic(acc.email, token));
  });

  describe('Entrar com a Atlassian (OAuth 2.0)', () => {
    let u: Auth;
    const acc = account('Iara Teste');

    beforeAll(async () => {
      await configure({ userAuth: 'oauth', oauthClientId: 'cliente-teste-jira', oauthClientSecret: 'tok-teste-segredo-oauth-0123' });
      u = await newUser(A);
      J.allowBasic(acc, 'tok-teste-nao-usado-0123456789');
    });

    async function start(user: Auth) {
      const res = await fetch(urlOf('/api/v1/jira.link.start'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-id': user.userId, 'x-auth-token': user.authToken },
        body: JSON.stringify({ returnTo: '/account/connected' }),
      });
      expect(res.status).toBe(200);
      const { url } = (await res.json()) as { url: string };
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith('wescc_int_oauth='))!;
      return { url: new URL(url), cookie, nonce: /^wescc_int_oauth=([^;]+)/.exec(cookie)![1] };
    }
    const callback = (qs: string, cookie: string) => fetch(urlOf(`/integrations/jira/callback?${qs}`), { headers: { cookie }, redirect: 'manual' });

    it('início: state e cookie HttpOnly preso a /integrations/', async () => {
      const s = await start(u);
      expect(`${s.url.origin}${s.url.pathname}`).toBe(`${J.origin}/authorize`);
      expect(Object.fromEntries(s.url.searchParams)).toMatchObject({
        audience: 'api.atlassian.com',
        client_id: 'cliente-teste-jira',
        scope: 'read:jira-work write:jira-work read:jira-user read:me offline_access',
        redirect_uri: 'https://203.0.113.10/integrations/jira/callback',
        response_type: 'code',
        prompt: 'consent',
      });
      expect(s.url.searchParams.get('state')!.length).toBeGreaterThan(30);
      expect(s.cookie).toMatch(/Path=\/integrations\/; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/);
    });

    it('retorno com o código → conta vinculada com site = origem; cookie errado → redireciona com erro', async () => {
      const bad = await start(u);
      const r0 = await callback(`code=qualquer&state=${encodeURIComponent(bad.url.searchParams.get('state')!)}`, 'wescc_int_oauth=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      expect(r0.status).toBe(302);
      expect(r0.headers.get('location')).toBe('/account/connected?integracao=erro&motivo=estado');

      const s = await start(u);
      J.oauthCodes.set('codigo-teste-1', acc.accountId);
      const res = await callback(`code=codigo-teste-1&state=${encodeURIComponent(s.url.searchParams.get('state')!)}`, `wescc_int_oauth=${s.nonce}`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/account/connected?integracao=jira-ok');
      const row = await one(`SELECT method, external_id, site, meta, status, display_name FROM linked_accounts WHERE user_id = $1`, [u.userId]);
      expect(row).toMatchObject({ method: 'oauth', external_id: acc.accountId, site: J.origin, meta: { cloudId: J.cloudId }, status: 'ok', display_name: 'Iara Teste' });
      // O mesmo state não serve de novo.
      const again = await callback(`code=codigo-teste-1&state=${encodeURIComponent(s.url.searchParams.get('state')!)}`, `wescc_int_oauth=${s.nonce}`);
      expect(again.headers.get('location')).toBe('/account/connected?integracao=erro&motivo=estado');
    });

    it('a renovação gira o refresh token e grava o novo', async () => {
      const used: string[] = [];
      for (let round = 0; round < 2; round++) {
        await pool.query(`UPDATE linked_accounts SET token_expires_at = now() - interval '1 minute' WHERE user_id = $1`, [u.userId]);
        const before = J.server.calls.length;
        const r = await api('GET', 'jira.search', { q: 'fila' }, u);
        expect(r.status).toBe(200);
        expect(r.identity).toBe('user');
        const calls = J.server.calls.slice(before);
        const refresh = calls.find((c) => c.path === '/oauth/token')!;
        expect(refresh.json).toMatchObject({ grant_type: 'refresh_token', client_id: 'cliente-teste-jira' });
        used.push(refresh.json.refresh_token);
        const search = calls.find((c) => c.path.endsWith('/search/jql'))!;
        expect(search.headers.authorization).toMatch(/^Bearer tok-teste-acesso-\d+$/);
      }
      expect(used[0]).not.toBe(used[1]);
      expect([...J.refreshTokens.entries()].filter(([, id]) => id === acc.accountId).map(([t]) => t)).not.toContain(used[1]);
    });

    it('invalid_grant → conta expirada e alerta para a pessoa', async () => {
      for (const [t, id] of [...J.refreshTokens.entries()]) if (id === acc.accountId) J.refreshTokens.delete(t);
      await pool.query(`UPDATE linked_accounts SET token_expires_at = now() - interval '1 minute' WHERE user_id = $1`, [u.userId]);
      const r = await api('GET', 'jira.search', { q: 'fila' }, u);
      expect(r.status).toBe(403);
      expect(r.errorType).toBe('error-jira-link-required');
      expect(r.error).toBe('A conexão com o Jira expirou. Conecte de novo em Minha conta → Contas conectadas.');
      expect(await one(`SELECT status, status_text FROM linked_accounts WHERE user_id = $1`, [u.userId])).toEqual({
        status: 'expired',
        status_text: 'A conexão com o Jira expirou. Conecte de novo em Minha conta → Contas conectadas.',
      });
      expect(await getState(`alert:jira.linked:${u.userId}`)).toMatchObject({ provider: 'jira', to: { userId: u.userId }, text: 'Conecte sua conta do Jira de novo em Minha conta → Contas conectadas.' });
    });
  });
});

// ---------- Segredos ----------

describe('Jira: nenhum segredo vaza', () => {
  it('nenhum token aparece em auditoria, atividade, estado, tarefas, mensagens ou na configuração', async () => {
    const dump = JSON.stringify([
      await many('SELECT action, target, data FROM audit_log'),
      await many('SELECT text, detail FROM integration_activity'),
      await many('SELECT id, data FROM integration_state'),
      await many('SELECT payload, last_error FROM integration_jobs'),
      await many('SELECT msg, extra, attachments FROM messages'),
      await many('SELECT value, hint FROM integration_secrets'),
      await many('SELECT access_token, refresh_token FROM linked_accounts'),
    ]);
    expect(dump).not.toMatch(/tok-teste/);
    expect(dump).not.toContain(hookSecret);
    const cfg = JSON.stringify(await api('GET', 'jira.config', {}, A));
    expect(cfg).not.toMatch(/tok-teste/);
    expect(cfg).not.toContain(hookSecret);
  });
});

// ---------- Limite do webhook (por último: enche o limite deste minuto) ----------

describe('Jira: limite do webhook', () => {
  it('M20: 601 chamadas no mesmo minuto com o mesmo token → 429, mesmo trocando o X-Forwarded-For', async () => {
    // Endereço novo: as chamadas dos testes anteriores neste minuto não contam para este token.
    const rotated = await api('POST', 'jira.webhook.rotate', { what: 'url' }, A);
    const fresh = new URL(rotated.webhookUrl).pathname.split('/').pop()!;
    expect(fresh).not.toBe(hookToken);
    expect((await hook({}, { token: hookToken, sig: null })).status).toBe(404);
    hookToken = fresh;
    const statuses: number[] = [];
    for (let n = 0; n < 601; n += 25) {
      const batch = Array.from({ length: Math.min(25, 601 - n) }, (_, k) =>
        fetch(urlOf(`/hooks/jira/${hookToken}`), { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${(n + k) % 250}` }, body: '{}' }).then((r) => r.status),
      );
      statuses.push(...(await Promise.all(batch)));
    }
    expect(statuses.filter((s) => s === 401)).toHaveLength(600);
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
    // Outro IP, mesmo token: continua barrado (o limite é do token, não do X-Forwarded-For).
    const again = await fetch(urlOf(`/hooks/jira/${hookToken}`), { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.99' }, body: '{}' });
    expect(again.status).toBe(429);
  });
});

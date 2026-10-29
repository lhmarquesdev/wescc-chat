import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stickerPreviewText, type MessageSticker } from '@shared/stickers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { many, one, query } from '../src/db/pool';
import { raiseAlert } from '../src/integrations/alerts';
import { botCtx, ensureBotUser } from '../src/integrations/bots';
import { drainJobs, enqueue, PermanentError, startJobWorker } from '../src/integrations/jobs';
import { BUDGET_WINDOW_MS, budgetKey } from '../src/integrations/msteams/budget';
import { COMMAND_TEXT } from '../src/integrations/msteams/command';
import { CONFIG_TEXT } from '../src/integrations/msteams/config';
import { GRAPH_TEXT } from '../src/integrations/msteams/graph';
import { HTML_TEXT } from '../src/integrations/msteams/html';
import { getInRow, IN_TEXT, processOrSkip, processTeamsMessage } from '../src/integrations/msteams/incoming';
import { MEETING_TEXT } from '../src/integrations/msteams/meetings';
import { NOTIFY_TEXT } from '../src/integrations/msteams/notifications';
import { OUT_TEXT, silentFlowCheck, silentText } from '../src/integrations/msteams/outgoing';
import { PEOPLE_TEXT } from '../src/integrations/msteams/people';
import { PRESENCE_TEXT } from '../src/integrations/msteams/presence';
import { markServiceBroken } from '../src/integrations/msteams/serviceAccount';
import { runPollerOnce } from '../src/integrations/runtime';
import { getState, setState } from '../src/integrations/state';
import { newId, sha256 } from '../src/lib/ids';
import { getSecret, reloadSecretsKey } from '../src/lib/secrets';
import { sendMessage } from '../src/services/messages';
import { getSetting } from '../src/services/settings';
import type { FakeReply } from './fake-http';
import { msFixture, startFakeMicrosoft, type FakeChannel, type FakeMessage, type FakeMicrosoft, type FakeSubscription, type FakeTeam, type MsUser } from './fake-microsoft';
import { admin, api, connectWs, newUser, sleep, startServer, stopServer, urlOf, type Auth } from './helpers';

// Microsoft Teams (§5, §6 e §12.3): configuração, conta de serviço, envio pelo Workflows, recebimento por notificações
// e por leitura periódica, reuniões, /teams e presença, tudo contra o Microsoft 365 falso (fake-microsoft.ts). Nada sai
// para a internet; tokens, segredos e ids são falsos.

process.env.SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const SITE = 'https://chat.explorer.example';
const OWNER = 'dono.fluxo@explorer-teste.com.br';
const B2_OWNER = 'dono.resumo@explorer-teste.com.br';
const SLOW_OWNER = 'dono.lento@explorer-teste.com.br';
const FAST_OWNER = 'dono.rapido@explorer-teste.com.br';
const MEET_URL = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZmFsc28tdGVzdGU%40thread.v2/0?context=%7b%22Tid%22%3a%22teste%22%7d';

let M: FakeMicrosoft;
let A: Auth;
let wsA: ReturnType<typeof connectWs>;
let TEAM: FakeTeam;
let CH: FakeChannel; // canal padrão
let PRIV: FakeChannel; // canal privado
let DENIED: FakeChannel; // a conta de serviço não participa
let CH2: FakeChannel; // canal que fica inacessível depois
let ownerMs: MsUser; // dono do fluxo principal no Entra
let anaMs: MsUser; // autora das mensagens no Teams
let brunoMs: MsUser;

beforeAll(async () => {
  M = await startFakeMicrosoft();
  process.env.INTEGRATIONS_ALLOWED_HOSTS = M.host;
  process.env.MS_LOGIN_URL = M.url;
  process.env.MS_GRAPH_URL = M.url;
  reloadSecretsKey();
  await startServer();
  A = await admin();
  await setSettings({ API_Enable_Rate_Limiter: false, Site_Url: SITE });
  // O Graph faz o aperto de mão no endereço público: aqui ele vem para o servidor de teste.
  M.validation = { from: SITE, to: urlOf('') };
  wsA = connectWs(A);
  await wsA.ready;
  TEAM = M.addTeam('Operação', [
    { name: 'Avisos do turno' },
    { name: 'Supervisão', membership: 'private' },
    { name: 'Restrito', forbidden: true },
    { name: 'Escalonamento' },
  ]);
  [CH, PRIV, DENIED, CH2] = TEAM.channels;
  // Todos os donos de fluxo existem no Entra (H5 confere o autor de um cartão pelo id).
  ownerMs = M.addUser('Dono do Fluxo', OWNER);
  for (const o of [B2_OWNER, SLOW_OWNER, FAST_OWNER]) M.addUser(o.split('@')[0], o);
  anaMs = M.addUser('Ana Souza', 'ana.souza@explorer-teste.com.br');
  brunoMs = M.addUser('Bruno Teste', 'bruno.teste@explorer-teste.com.br');
});

afterAll(async () => {
  wsA?.close();
  await stopServer();
  await M?.close();
});

// ---------- Ajudantes ----------

async function setSettings(settings: Record<string, unknown>) {
  const r = await api('POST', 'settings', { settings }, A);
  if (r.status !== 200) throw new Error(JSON.stringify(r));
}

const uniq = (p: string) => `${p}-${crypto.randomBytes(3).toString('hex')}`;
const ZW = '\u200b'; // o chat quebra links e menções de fora com U+200B
const siteName = () => String(getSetting('Site_Name') || 'Wescc Chat');

async function channel(owner: Auth, members: string[] = [], extra: Record<string, unknown> = {}) {
  const r = await api('POST', 'channels.create', { name: uniq('teams'), members, ...extra }, owner);
  if (!r.channel) throw new Error(JSON.stringify(r));
  return r.channel as { _id: string; name: string };
}
async function group(owner: Auth, members: string[] = []) {
  const r = await api('POST', 'groups.create', { name: uniq('grupo'), members }, owner);
  if (!r.group) throw new Error(JSON.stringify(r));
  return r.group as { _id: string; name: string };
}

const send = async (u: Auth, rid: string, msg: string, extra: Record<string, unknown> = {}) => {
  const r = await api('POST', 'chat.sendMessage', { message: { rid, msg, ...extra } }, u);
  if (!r.message) throw new Error(JSON.stringify(r));
  return r.message as { _id: string; rid: string; msg: string };
};

async function nameOf(u: Auth) {
  const row = await one('SELECT name, username FROM users WHERE id = $1', [u.userId]);
  return String(row?.name || row?.username);
}
const emailOf = async (u: Auth) => String((await one('SELECT email FROM users WHERE id = $1', [u.userId]))?.email ?? '');

const botId = async () => String((await getState<{ id: string }>('bot.msteams'))?.id ?? '');

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, what: string, ms = 8000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > until) throw new Error(`tempo esgotado esperando ${what}`);
    await sleep(25);
  }
}

const postJob = (ruleId: string, messageId: string) =>
  one(`SELECT id, status, run_at, attempts, last_error FROM integration_jobs WHERE kind = 'msteams.post' AND integration_id = $1 AND payload->>'messageId' = $2`, [ruleId, messageId]);
const waitPostJob = (ruleId: string, messageId: string) => waitFor(() => postJob(ruleId, messageId), 'a tarefa de envio ao Teams');

const drain = () => drainJobs();

const content = (call: { card: any }) => call.card.attachments[0].content;

function outRule(input: Record<string, unknown>) {
  return {
    name: 'Avisos da operação',
    enabled: true,
    filter: 'root',
    keywords: [],
    includeBots: false,
    includeFiles: true,
    includeLink: true,
    destinationLabel: 'Operação › Avisos',
    destinationPrivate: false,
    flowOwner: OWNER,
    budget: 20,
    auth: 'none',
    ...input,
  };
}
async function saveOut(input: Record<string, unknown>, u: Auth = A) {
  const r = await api('POST', 'msteams.out.save', outRule(input), u);
  if (!r.rule) throw new Error(JSON.stringify(r));
  return r.rule as { _id: string; lastError?: string | null };
}
const outRuleOf = async (id: string) => ((await api('GET', 'msteams.out.list', {}, A)).rules as any[]).find((r) => r._id === id);
const inRuleOf = async (id: string) => ((await api('GET', 'msteams.in.list', {}, A)).rules as any[]).find((r) => r._id === id);

async function saveConfig(input: Record<string, unknown>) {
  return api('POST', 'msteams.config.save', input, A);
}

// Entrada da conta de serviço: início pela API (cookie + PKCE), código emitido pelo Entra falso, retorno no navegador.
async function linkService(o: { cookie?: string } = {}) {
  const res = await fetch(urlOf('/api/v1/msteams.service.start'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': A.userId, 'x-auth-token': A.authToken },
    body: JSON.stringify({ returnTo: '/admin/integrations/teams/conexao' }),
  });
  const json: any = await res.json();
  if (!json.url) throw new Error(JSON.stringify(json));
  const url = new URL(json.url);
  const cookie = o.cookie ?? res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('wescc_int_oauth=')) ?? '';
  const code = M.issueCode({ challenge: url.searchParams.get('code_challenge') ?? '', redirectUri: url.searchParams.get('redirect_uri') ?? '', scope: url.searchParams.get('scope') ?? '' });
  const cb = await fetch(urlOf(`/integrations/msteams/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(url.searchParams.get('state') ?? '')}`), {
    headers: { cookie },
    redirect: 'manual',
  });
  return { url, cb };
}

// ---------- Configuração ----------

describe('Configuração (§5.2)', () => {
  it('com o Teams desligado só msteams.config* respondem e /hooks/msteams dá 404', async () => {
    const off = await api('GET', 'msteams.teams', {}, A);
    expect(off.status).toBe(400);
    expect(off.errorType).toBe('error-msteams-disabled');
    expect(off.error).toBe(CONFIG_TEXT.disabled);
    const cfg = await api('GET', 'msteams.config', {}, A);
    expect(cfg.config).toMatchObject({ enabled: false, status: { tone: 'off' }, clientSecret: { set: false } });
    const hook = await fetch(urlOf('/hooks/msteams/qualquer-coisa?validationToken=abc'), { method: 'POST' });
    expect(hook.status).toBe(404);
  });

  it('ID do locatário que não é GUID é recusado', async () => {
    const r = await saveConfig({ tenantId: 'explorer.onmicrosoft.com' });
    expect(r.status).toBe(400);
    expect(r.errorType).toBe('error-invalid-setting');
  });

  it('AADSTS7000215 → o texto do segredo; a resposta nunca traz o segredo', async () => {
    const wrong = 'tok-teste-segredo-errado-456';
    const r = await saveConfig({ tenantId: M.tenantId, clientId: M.clientId, clientSecret: wrong, clientSecretExpiresAt: '2027-10-01' });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r)).not.toContain(wrong);
    expect(r.config.clientSecret).toMatchObject({ set: true });
    expect(r.config.status).toMatchObject({ tone: 'err', text: GRAPH_TEXT.secret });
  });

  it('roles do token do aplicativo → granted.application; Permitir alterar e-mail ligado → o aviso (B5)', async () => {
    await setSettings({ Accounts_AllowEmailChange: true });
    const r = await saveConfig({ clientSecret: M.clientSecret, enabled: true });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r)).not.toContain(M.clientSecret);
    expect(r.config).toMatchObject({ enabled: true, emailChangeAllowed: true, appObjectId: M.appObjectId, notificationsProblem: null });
    expect(r.config.notificationsUrl).toMatch(new RegExp(`^${SITE}/hooks/msteams/[A-Za-z0-9]{40,}$`));
    expect(r.config.granted.application).toEqual(M.appRoles);
    expect(r.config.status.tone).toBe('warn');
    expect(r.config.status.details).toContain(CONFIG_TEXT.emailChange);

    await setSettings({ Accounts_AllowEmailChange: false });
    const t = await api('POST', 'msteams.config.test', {}, A);
    expect(t.config.emailChangeAllowed).toBe(false);
    expect(t.config.status.details).not.toContain(CONFIG_TEXT.emailChange);
    expect(t.config.status.tone).toBe('ok');
  });
});

// ---------- Conta de serviço ----------

describe('Conta de serviço (§5.2)', () => {
  it('cookie de outro navegador → volta com erro, sem trocar o código', async () => {
    const before = M.tokenCalls('authorization_code').length;
    const { cb } = await linkService({ cookie: `wescc_int_oauth=${crypto.randomBytes(32).toString('base64url')}` });
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toContain('integracao=erro');
    expect(M.tokenCalls('authorization_code')).toHaveLength(before);
  });

  it('o início leva code_challenge; o retorno troca o código com code_verifier e guarda a conta', async () => {
    const { url, cb } = await linkService();
    expect(`${url.origin}${url.pathname}`).toBe(`${M.url}/${M.tenantId}/oauth2/v2.0/authorize`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('redirect_uri')).toBe(`${SITE}/integrations/msteams/callback`);
    expect(url.searchParams.get('scope')!.split(' ')).toEqual(expect.arrayContaining(['offline_access', 'User.Read', 'ChannelMessage.Read.All']));
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/admin/integrations/teams/conexao?integracao=teams-ok');

    const exchange = new URLSearchParams(M.tokenCalls('authorization_code').at(-1)!.body);
    expect(exchange.get('redirect_uri')).toBe(`${SITE}/integrations/msteams/callback`);
    expect(crypto.createHash('sha256').update(exchange.get('code_verifier') ?? '').digest('base64url')).toBe(url.searchParams.get('code_challenge'));

    const cfg = (await api('GET', 'msteams.config', {}, A)).config;
    expect(cfg.serviceAccount).toMatchObject({ linked: true, upn: M.service.userPrincipalName, displayName: M.service.displayName, status: { tone: 'ok' } });
    expect(JSON.stringify(cfg)).not.toMatch(/tok-teste-refresh/);
    const audit = await one(`SELECT data::text AS data FROM audit_log WHERE action = 'integration.msteams.service.linked' ORDER BY created_at DESC LIMIT 1`);
    expect(audit.data).toContain(M.service.userPrincipalName);
    expect(audit.data).not.toMatch(/tok-teste/);
  });

  it('o refresh token girado pelo Entra fica gravado no lugar do antigo', async () => {
    const before = await getSecret('msteams.serviceRefreshToken');
    const refreshes = M.tokenCalls('refresh_token').length;
    M.expireTokens(); // 401 no Graph: o chat pede outro token com o refresh token
    const teams = await api('GET', 'msteams.teams', {}, A);
    expect(teams.teams).toEqual([{ id: TEAM.id, name: 'Operação' }]);
    expect(M.tokenCalls('refresh_token')).toHaveLength(refreshes + 1);
    const after = await getSecret('msteams.serviceRefreshToken');
    expect(after).not.toBe(before);
    expect(M.refreshTokens.has(after!)).toBe(true);
    expect(M.refreshTokens.has(before!)).toBe(false);
    const channels = await api('GET', 'msteams.channels', { teamId: TEAM.id }, A);
    expect(channels.channels.map((c: any) => [c.name, c.membership])).toEqual([
      ['Avisos do turno', 'standard'],
      ['Supervisão', 'private'],
      ['Restrito', 'standard'],
      ['Escalonamento', 'standard'],
    ]);
  });
});

// ---------- Envio (Wescc → Teams) ----------

describe('Envio para o Teams pelo Workflows (§5.3)', () => {
  let ana: Auth;
  let ops: { _id: string; name: string };
  let rule: { _id: string };
  let first: { _id: string };

  beforeAll(async () => {
    ana = await newUser(A, { name: 'Ana Souza' });
    ops = await channel(A, [ana.username]);
  });

  it('quem não é dono nem moderador da sala não cria a regra', async () => {
    expect((await api('POST', 'roles.create', { name: 'gestor-teams', scope: 'Users' }, A)).success).toBe(true);
    const perms = (await api('GET', 'permissions.listAll', {}, A)).update as { _id: string; roles: string[] }[];
    const roles = perms.find((p) => p._id === 'manage-msteams')!.roles;
    await api('POST', 'permissions.update', { permissions: [{ _id: 'manage-msteams', roles: [...roles, 'gestor-teams'] }] }, A);
    const gestor = await newUser(A, { roles: ['user', 'gestor-teams'] });
    await api('POST', 'channels.invite', { roomId: ops._id, username: gestor.username }, A);
    const r = await api('POST', 'msteams.out.save', outRule({ roomIds: [ops._id], url: M.flowUrl('fluxo-gestor') }), gestor);
    expect(r.status).toBe(400);
    expect(r.errorType).toBe('error-integration-room');
    expect(r.error).toBe('Só donos e moderadores da sala podem enviar as mensagens dela para o Teams.');
  });

  it('endereço antigo do Logic Apps e conector do Office 365 → os textos do §5.3', async () => {
    const logic = await api('POST', 'msteams.out.save', outRule({ roomIds: [ops._id], url: 'https://prod-12.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=x' }), A);
    expect(logic.error).toBe(OUT_TEXT.logicAzure);
    const connector = await api('POST', 'msteams.out.save', outRule({ roomIds: [ops._id], url: 'https://explorer.webhook.office.com/webhookb2/abc' }), A);
    expect(connector.error).toBe(OUT_TEXT.connector);
  });

  it('a regra é anunciada na sala pelo robô, sem @ e sem menções', async () => {
    rule = await saveOut({ roomIds: [ops._id], url: M.flowUrl('fluxo-ops') });
    const ann = await one(`SELECT msg, mentions FROM messages WHERE room_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`, [ops._id, await botId()]);
    expect(ann.msg).toBe(`${OUT_TEXT.announce('Operação › Avisos', await nameOf(A))}${OUT_TEXT.onlyRoot}`);
    expect(ann.msg).not.toContain('@');
    expect(ann.mentions ?? []).toEqual([]);
    const listed = await outRuleOf(rule._id);
    expect(listed).toMatchObject({ urlHost: M.host, url: { set: true }, flowOwner: OWNER, budget: 20 });
    expect(JSON.stringify(listed)).not.toContain('tok-teste-assinatura');
  });

  it('mensagem → tarefa → POST no fluxo com o cartão esperado', async () => {
    first = await send(ana, ops._id, 'Fila *parada* no turno da tarde');
    await waitPostJob(rule._id, first._id);
    await drain();
    const calls = M.flowCalls('fluxo-ops');
    expect(calls).toHaveLength(1);
    expect(calls[0].authorization).toBeNull();
    expect(calls[0].card.type).toBe('message');
    expect(calls[0].card.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    const c = content(calls[0]);
    expect(c).toMatchObject({ type: 'AdaptiveCard', version: '1.4', fallbackText: `Mensagem de Ana Souza em #${ops.name} no ${siteName()}` });
    expect(c.body[0]).toMatchObject({ id: `wescc:${rule._id}:${first._id}`, size: 'Small', isSubtle: true });
    expect(c.body[0].text).toMatch(new RegExp(`^#${ops.name} · ${siteName()} · \\d{2}:\\d{2}$`));
    expect(c.body[1]).toMatchObject({ text: 'Ana Souza', weight: 'Bolder' });
    expect(c.body[2]).toMatchObject({ type: 'TextBlock', text: 'Fila **parada** no turno da tarde', wrap: true });
    expect(c.actions).toEqual([{ type: 'Action.OpenUrl', title: `Abrir no ${siteName()}`, url: `${SITE}/channel/${ops._id}?msg=${first._id}` }]);
    expect((await postJob(rule._id, first._id)).status).toBe('done');
    expect((await outRuleOf(rule._id)).lastError).toBeNull();
  });

  it('filtro padrão root: resposta em tópico não vai; resposta mostrada no canal vai com a linha do tópico', async () => {
    const reply = await send(ana, ops._id, 'resposta só no tópico', { tmid: first._id });
    const shown = await send(ana, ops._id, 'resposta também no canal', { tmid: first._id, tshow: true });
    await waitPostJob(rule._id, shown._id);
    await sleep(150);
    expect(await postJob(rule._id, reply._id)).toBeNull();
    await drain();
    const c = content(M.flowCalls('fluxo-ops').at(-1)!);
    expect(c.body[0].id).toBe(`wescc:${rule._id}:${shown._id}`);
    expect(c.body[2].text).toBe('Resposta no tópico “Fila parada no turno da tarde”');
  });

  it('includeBots desligado: mensagens do jira.bot e com alias não vão', async () => {
    const jira = await ensureBotUser('jira');
    await api('POST', 'channels.invite', { roomId: ops._id, username: jira.username }, A);
    const fromBot = (await sendMessage(botCtx(jira), { rid: ops._id, msg: 'OPS-12 mudou para Em andamento' }, { integration: true })) as any;
    // Personificar exige message-impersonate; aqui basta uma mensagem com alias gravada como as integrações gravam.
    const aliased = { message: (await sendMessage({ userId: A.userId, username: A.username, sessionId: 'teste' }, { rid: ops._id, msg: 'Ponto fechado às 18h', alias: 'Sistema de Ponto' }, { trusted: true })) as any };
    expect(aliased.message?._id).toBeTruthy();
    const sentinel = await send(ana, ops._id, 'mensagem de pessoa');
    await waitPostJob(rule._id, sentinel._id);
    await sleep(150);
    expect(await postJob(rule._id, fromBot._id)).toBeNull();
    expect(await postJob(rule._id, aliased.message._id)).toBeNull();
    await drain();
  });

  it('figurinha vai com o texto de prévia no lugar da mensagem vazia', async () => {
    const fileId = newId();
    await query(`INSERT INTO sticker_files (id, sha256, mime, width, height, size, path) VALUES ($1, $2, 'image/webp', 128, 128, 512, $3)`, [fileId, crypto.randomBytes(32).toString('hex'), `2026/10/${fileId}`]);
    const sticker: MessageSticker = { fileId, name: 'Joinha', emojis: ['👍'], width: 128, height: 128, animated: false, url: `/sticker/${fileId}.webp`, scope: 'personal' };
    const m = (await sendMessage({ userId: ana.userId, username: ana.username, sessionId: 'teste' }, { rid: ops._id, sticker }, { sticker: true })) as any;
    await waitPostJob(rule._id, m._id);
    await drain();
    const c = content(M.flowCalls('fluxo-ops').at(-1)!);
    expect(c.body[0].id).toBe(`wescc:${rule._id}:${m._id}`);
    expect(c.body[2].text).toBe(stickerPreviewText(sticker));
    expect(c.body[2].text).toBe('👍 Figurinha “Joinha”');
  });

  it('filtro ack: só os avisos com “Ciente”, com a linha de confirmação', async () => {
    const notice = await channel(A, [ana.username], { extraData: { notice: true, noticeAck: true } });
    const ackRule = await saveOut({ name: 'Avisos com ciente', roomIds: [notice._id], filter: 'ack', url: M.flowUrl('fluxo-ack') });
    const plain = await send(A, notice._id, 'aviso sem confirmação');
    const ack = await send(A, notice._id, 'Leiam o procedimento novo da fila', { ackRequired: true });
    await waitPostJob(ackRule._id, ack._id);
    await sleep(150);
    expect(await postJob(ackRule._id, plain._id)).toBeNull();
    await drain();
    const calls = M.flowCalls('fluxo-ack');
    expect(calls).toHaveLength(1);
    const c = content(calls[0]);
    expect(c.body[0].id).toBe(`wescc:${ackRule._id}:${ack._id}`);
    expect(c.body.at(-1).text).toBe(`Este aviso pede confirmação de leitura no ${siteName()}.`);
  });

  it('filtro keywords: sem diferenciar maiúsculas e acentos', async () => {
    const room = await channel(A, [ana.username]);
    const kw = await saveOut({ name: 'Palavras-chave', roomIds: [room._id], filter: 'keywords', keywords: ['atenção', 'Urgente'], url: M.flowUrl('fluxo-palavras') });
    const no = await send(ana, room._id, 'tudo certo por aqui');
    const yes1 = await send(ana, room._id, 'ATENCAO: troca de turno às 14h');
    const yes2 = await send(ana, room._id, 'caso urgente na fila 3');
    await waitPostJob(kw._id, yes2._id);
    await waitPostJob(kw._id, yes1._id);
    await sleep(150);
    expect(await postJob(kw._id, no._id)).toBeNull();
    await drain();
    expect(M.flowCalls('fluxo-palavras').map((c) => content(c).body[0].id)).toEqual([`wescc:${kw._id}:${yes1._id}`, `wescc:${kw._id}:${yes2._id}`]);
  });

  it("fluxo que exige autenticação com auth 'none' → 401 → o texto do M15; com 'entra' vai o token do público exato", async () => {
    const room = await channel(A, [ana.username]);
    M.flowAuth('fluxo-protegido', 'entra');
    const prot = await saveOut({ name: 'Fluxo protegido', roomIds: [room._id], filter: 'all', url: M.flowUrl('fluxo-protegido') });
    const m1 = await send(ana, room._id, 'primeira tentativa');
    await waitPostJob(prot._id, m1._id);
    await drain();
    const dead = await postJob(prot._id, m1._id);
    expect(dead.status).toBe('dead');
    expect(dead.last_error).toBe(OUT_TEXT.authNone(M.appObjectId));
    expect((await outRuleOf(prot._id)).lastError).toBe(OUT_TEXT.authNone(M.appObjectId));

    const upd = await api('POST', 'msteams.out.save', outRule({ _id: prot._id, name: 'Fluxo protegido', roomIds: [room._id], filter: 'all', auth: 'entra' }), A);
    expect(upd.rule.auth).toBe('entra');
    const m2 = await send(ana, room._id, 'segunda tentativa');
    await waitPostJob(prot._id, m2._id);
    await drain();
    expect((await postJob(prot._id, m2._id)).status).toBe('done');
    const call = M.flowCalls('fluxo-protegido').at(-1)!;
    const token = /^Bearer (.+)$/.exec(call.authorization ?? '')![1];
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    expect(claims.aud).toBe('https://service.flow.microsoft.com/');
    expect(claims.oid).toBe(M.appObjectId);
    const scopes = M.tokenCalls('client_credentials').map((c) => new URLSearchParams(c.body).get('scope'));
    expect(scopes).toContain('https://service.flow.microsoft.com//.default');
  });

  it('429 com Retry-After → nova tentativa depois do tempo pedido', async () => {
    const room = await channel(A, [ana.username]);
    let first429 = true;
    M.flowReply('fluxo-429', () => {
      if (!first429) return { status: 202, body: '' };
      first429 = false;
      return { status: 429, headers: { 'retry-after': '2' }, body: { error: { code: 'TooManyRequests', message: 'Rate limit is exceeded.' } } };
    });
    const r429 = await saveOut({ name: 'Fluxo limitado', roomIds: [room._id], filter: 'all', url: M.flowUrl('fluxo-429') });
    const m = await send(ana, room._id, 'mensagem com espera');
    await waitPostJob(r429._id, m._id);
    const t0 = Date.now();
    await drain();
    const waiting = await one(`SELECT status, attempts, extract(epoch FROM run_at - now()) * 1000 AS wait FROM integration_jobs WHERE kind = 'msteams.post' AND integration_id = $1`, [r429._id]);
    expect(waiting).toMatchObject({ status: 'queued', attempts: 1 });
    expect(Number(waiting.wait)).toBeGreaterThan(500);
    expect(Number(waiting.wait)).toBeLessThanOrEqual(2000);
    const act = await one(`SELECT text FROM integration_activity WHERE integration_id = $1 AND tone = 'warn' ORDER BY created_at DESC LIMIT 1`, [r429._id]);
    expect(act.text).toBe(OUT_TEXT.throttled);
    await sleep(Math.max(0, 2100 - (Date.now() - t0)));
    await drain();
    expect((await postJob(r429._id, m._id)).status).toBe('done');
    expect(M.flowCalls('fluxo-429')).toHaveLength(2);
  });

  it('B2: 30 mensagens em duas regras do mesmo dono → no máximo 20 posts, o resto num resumo por regra, nada perdido e em ordem', async () => {
    const roomA = await channel(A, [ana.username]);
    const roomB = await channel(A, [ana.username]);
    const ra = await saveOut({ name: 'Resumo A', roomIds: [roomA._id], filter: 'all', flowOwner: B2_OWNER, budget: 20, url: M.flowUrl('fluxo-b2a') });
    const rb = await saveOut({ name: 'Resumo B', roomIds: [roomB._id], filter: 'all', flowOwner: B2_OWNER, budget: 20, url: M.flowUrl('fluxo-b2b') });
    const sentA: string[] = [];
    const sentB: string[] = [];
    for (let i = 1; i <= 15; i++) {
      sentA.push((await send(ana, roomA._id, `A${i}`))._id);
      sentB.push((await send(ana, roomB._id, `B${i}`))._id);
    }
    await waitFor(async () => Number((await one(`SELECT count(*)::int AS n FROM integration_jobs WHERE kind = 'msteams.post' AND integration_id = ANY($1)`, [[ra._id, rb._id]])).n) === 30, '30 tarefas');
    const t0 = Date.now();
    await drain();
    const elapsed = Date.now() - t0;
    const singlesA = M.flowCalls('fluxo-b2a').map((c) => content(c).body[0].id.split(':')[2]);
    const singlesB = M.flowCalls('fluxo-b2b').map((c) => content(c).body[0].id.split(':')[2]);
    const total = singlesA.length + singlesB.length;
    // D12: no máximo 20 por dono em qualquer janela de 5 minutos (a rodada leva bem menos que isso).
    expect(elapsed).toBeLessThan(BUDGET_WINDOW_MS);
    expect(total).toBe(20);
    // Em ordem dentro de cada regra.
    expect(singlesA).toEqual(sentA.slice(0, singlesA.length));
    expect(singlesB).toEqual(sentB.slice(0, singlesB.length));
    const digests = await many(`SELECT id, integration_id, payload FROM integration_jobs WHERE kind = 'msteams.digest' AND integration_id = ANY($1) AND status = 'queued' ORDER BY integration_id`, [[ra._id, rb._id]]);
    expect(digests).toHaveLength(2);
    const merged = Number((await one(`SELECT count(*)::int AS n FROM integration_jobs WHERE kind = 'msteams.post' AND integration_id = ANY($1) AND status = 'merged'`, [[ra._id, rb._id]])).n);
    expect(merged + total).toBe(30);
    expect(await activityTexts(ra._id)).toContain(OUT_TEXT.grouped(15 - singlesA.length));

    // Cinco minutos depois: o balde está cheio de novo e os resumos saem, um por regra.
    await setState(budgetKey(B2_OWNER), null);
    await query(`UPDATE integration_jobs SET run_at = now() WHERE kind = 'msteams.digest' AND integration_id = ANY($1)`, [[ra._id, rb._id]]);
    await drain();
    for (const [flow, sent, singles, rid] of [
      ['fluxo-b2a', sentA, singlesA, roomA],
      ['fluxo-b2b', sentB, singlesB, roomB],
    ] as const) {
      const calls = M.flowCalls(flow);
      expect(calls).toHaveLength(singles.length + 1);
      const digest = content(calls.at(-1)!);
      const rest = sent.length - singles.length;
      expect(digest.body[0].id).toMatch(/^wescc:[^:]+:resumo$/);
      expect(digest.body[1].text).toBe(`${rest} mensagens novas em #${rid.name} no ${siteName()}`);
      // Os primeiros do resumo são os que não foram sozinhos, na ordem.
      const prefix = flow === 'fluxo-b2a' ? 'A' : 'B';
      expect(digest.body.slice(2).map((b: any) => b.text)).toEqual(
        Array.from({ length: Math.min(5, rest) }, (_, i) => `Ana Souza: ${prefix}${singles.length + i + 1}`),
      );
    }
    expect(Number((await one(`SELECT count(*)::int AS n FROM integration_jobs WHERE integration_id = ANY($1) AND status NOT IN ('done', 'merged')`, [[ra._id, rb._id]])).n)).toBe(0);
    // O resumo que foi entregue termina como entregue; só as mensagens juntadas nele ficam 'merged'.
    expect((await many(`SELECT status FROM integration_jobs WHERE kind = 'msteams.digest' AND integration_id = ANY($1)`, [[ra._id, rb._id]])).map((r) => r.status)).toEqual(['done', 'done']);
  });

  it('resumo de uma regra com duas salas: a sala em cada linha; numa nova tentativa as já juntadas continuam; termina done', async () => {
    const owner = 'dono.salas@explorer-teste.com.br';
    M.addUser('dono.salas', owner);
    const roomA = await channel(A, [ana.username]);
    const roomB = await channel(A, [ana.username]);
    const rule = await saveOut({ name: 'Duas salas', roomIds: [roomA._id, roomB._id], filter: 'all', flowOwner: owner, budget: 5, url: M.flowUrl('fluxo-salas') });
    // O dono já gastou o limite: tudo vai para o resumo.
    const spent = () => setState(budgetKey(owner), { times: Array.from({ length: 5 }, () => Date.now()), day: '', dayCount: 0 });
    await spent();
    const a1 = await send(ana, roomA._id, 'A1');
    const b1 = await send(ana, roomB._id, 'B1');
    await waitFor(async () => Number((await one(`SELECT count(*)::int AS n FROM integration_jobs WHERE kind = 'msteams.post' AND integration_id = $1`, [rule._id])).n) === 2, '2 tarefas');
    await drain();
    const digest = await one(`SELECT id, status, payload FROM integration_jobs WHERE kind = 'msteams.digest' AND integration_id = $1`, [rule._id]);
    expect(digest).toMatchObject({ status: 'queued', payload: { messageIds: [a1._id, b1._id] } });

    // Chega outra enquanto o resumo espera e o resumo roda ainda sem vaga: junta a nova, guarda e espera de novo.
    const a2 = await send(ana, roomA._id, 'A2');
    await waitPostJob(rule._id, a2._id);
    await spent();
    await query(`UPDATE integration_jobs SET run_at = now() WHERE id = $1`, [digest.id]);
    await drain();
    expect(await one(`SELECT status, attempts, payload FROM integration_jobs WHERE id = $1`, [digest.id])).toMatchObject({
      status: 'queued',
      attempts: 0,
      payload: { messageIds: [a1._id, b1._id, a2._id] },
    });
    expect((await postJob(rule._id, a2._id)).status).toBe('merged');
    expect(M.flowCalls('fluxo-salas')).toHaveLength(0);

    // Com vaga: um cartão só, com as três e a sala de cada uma.
    await setState(budgetKey(owner), null);
    await query(`UPDATE integration_jobs SET run_at = now() WHERE id = $1`, [digest.id]);
    await drain();
    const calls = M.flowCalls('fluxo-salas');
    expect(calls).toHaveLength(1);
    const card = content(calls[0]);
    expect(card.body[0].text).toBe(`#${roomA.name}, #${roomB.name} · ${siteName()}`);
    expect(card.body[1].text).toBe(`3 mensagens novas em 2 salas no ${siteName()}`);
    expect(card.body.slice(2).map((b: any) => b.text)).toEqual([`#${roomA.name} · Ana Souza: A1`, `#${roomB.name} · Ana Souza: B1`, `#${roomA.name} · Ana Souza: A2`]);
    expect((await one(`SELECT status FROM integration_jobs WHERE id = $1`, [digest.id])).status).toBe('done');
  });

  it('B2: um fluxo lento numa regra não atrasa a outra', async () => {
    const slowRoom = await channel(A, [ana.username]);
    const fastRoom = await channel(A, [ana.username]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    M.flowReply('fluxo-lento', async () => {
      await gate;
      return { status: 202, body: '' };
    });
    const slow = await saveOut({ name: 'Lento', roomIds: [slowRoom._id], filter: 'all', flowOwner: SLOW_OWNER, url: M.flowUrl('fluxo-lento') });
    const fast = await saveOut({ name: 'Rápido', roomIds: [fastRoom._id], filter: 'all', flowOwner: FAST_OWNER, url: M.flowUrl('fluxo-rapido') });
    const s1 = await send(ana, slowRoom._id, 'lenta 1');
    const fastIds: string[] = [];
    for (let i = 1; i <= 3; i++) fastIds.push((await send(ana, fastRoom._id, `rápida ${i}`))._id);
    await waitPostJob(slow._id, s1._id);
    await waitPostJob(fast._id, fastIds[2]);
    const worker = startJobWorker(() => {});
    try {
      await waitFor(async () => M.flowCalls('fluxo-rapido').length === 3, 'as 3 mensagens da regra rápida', 20_000);
      expect(M.flowCalls('fluxo-lento')).toHaveLength(1); // ainda esperando a resposta do fluxo lento
      expect((await postJob(slow._id, s1._id)).status).toBe('running');
    } finally {
      release();
      await waitFor(async () => (await postJob(slow._id, s1._id))?.status === 'done', 'a mensagem lenta', 20_000).finally(() => worker.stop());
    }
  });

  it('a atividade nunca mostra o caminho do fluxo (a assinatura fica no caminho e na query)', async () => {
    const rows = await many(`SELECT text, detail FROM integration_activity WHERE provider = 'msteams'`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(`${r.text} ${r.detail ?? ''}`).not.toMatch(/\/workflows\/|tok-teste|sig=/);
    const jobs = await many(`SELECT payload::text AS payload, last_error FROM integration_jobs WHERE kind LIKE 'msteams.%'`);
    for (const j of jobs) expect(`${j.payload} ${j.last_error ?? ''}`).not.toMatch(/\/workflows\/|tok-teste|sig=/);
  });

  it('fluxo sem envio há 75 dias → aviso para quem gerencia; o envio seguinte limpa; um erro ativo não é trocado; remover a regra leva o alerta', async () => {
    const room = await channel(A, [ana.username]);
    const quiet = await saveOut({ name: 'Fluxo parado', roomIds: [room._id], url: M.flowUrl('fluxo-parado') });
    const key = `alert:msteams.out:${quiet._id}`;
    await silentFlowCheck();
    expect(await getState(key)).toBeNull();
    await query(`UPDATE integrations SET created_at = now() - interval '76 days', last_ok_at = NULL WHERE id = $1`, [quiet._id]);
    await silentFlowCheck();
    expect(await getState(key)).toMatchObject({ tone: 'warn', provider: 'msteams', to: 'managers', href: '/admin/integrations/teams/envio', text: silentText('Fluxo parado') });
    expect(silentText('Fluxo parado')).toBe('O fluxo da regra “Fluxo parado” não é usado há 75 dias. A Microsoft pode desligar fluxos sem uso por 90 dias.');
    const alerts = (await api('GET', 'integrations.alerts', {}, A)).alerts as { key: string }[];
    expect(alerts.map((x) => x.key)).toContain(`msteams.out:${quiet._id}`);

    const m = await send(ana, room._id, 'Volta do fluxo');
    await waitPostJob(quiet._id, m._id);
    await drain();
    expect(M.flowCalls('fluxo-parado')).toHaveLength(1);
    expect(await getState(key)).toBeNull();

    // Um envio que falhou (err) continua visível; o aviso de fluxo parado não o substitui.
    await query(`UPDATE integrations SET last_ok_at = now() - interval '80 days' WHERE id = $1`, [quiet._id]);
    await raiseAlert({ key: `msteams.out:${quiet._id}`, provider: 'msteams', tone: 'err', text: 'O envio “Fluxo parado” para o Teams falhou: teste.', href: '/admin/integrations/teams/envio', to: 'managers' });
    await silentFlowCheck();
    expect(await getState(key)).toMatchObject({ tone: 'err', text: 'O envio “Fluxo parado” para o Teams falhou: teste.' });
    expect((await api('POST', 'msteams.out.remove', { _id: quiet._id }, A)).success).toBe(true);
    expect(await getState(key)).toBeNull();
  });

  it('regra desligada não recebe o aviso de fluxo parado, e o aviso que havia some', async () => {
    const room = await channel(A, [ana.username]);
    const off = await saveOut({ name: 'Fluxo desligado', roomIds: [room._id], url: M.flowUrl('fluxo-desligado') });
    const key = `alert:msteams.out:${off._id}`;
    await query(`UPDATE integrations SET created_at = now() - interval '90 days' WHERE id = $1`, [off._id]);
    await silentFlowCheck();
    expect((await getState<{ tone: string }>(key))?.tone).toBe('warn');
    await query(`UPDATE integrations SET enabled = false WHERE id = $1`, [off._id]);
    await silentFlowCheck();
    expect(await getState(key)).toBeNull();
  });
});

const activityTexts = async (ruleId: string) => (await many(`SELECT text FROM integration_activity WHERE integration_id = $1 ORDER BY created_at, id`, [ruleId])).map((r) => String(r.text));

// ---------- Recebimento por notificações ----------

describe('Mensagens do Teams por notificações (§5.4)', () => {
  let room: { _id: string; name: string };
  let rule: { _id: string };
  let sub: FakeSubscription;
  let echoRule: { _id: string };
  let root: FakeMessage;
  let reply: FakeMessage;
  let hookUrl = '';

  const mirroredIn = (rid: string) =>
    many(`SELECT id, msg, tmid, alias, extra, mentions, user_id FROM messages WHERE room_id = $1 AND alias LIKE '% (Teams)' ORDER BY created_at, id`, [rid]);
  const bridgedOf = (teamsId: string) =>
    one(`SELECT m.id, m.msg, m.tmid, m.alias, m.extra, m.mentions, m.t FROM msteams_bridge_messages b LEFT JOIN messages m ON m.id = b.message_id WHERE b.integration_id = $1 AND b.teams_id = $2`, [rule._id, teamsId]);
  async function deliver(m: FakeMessage, changeType: 'created' | 'updated' | 'deleted' = 'created', s: FakeSubscription = sub) {
    const res = await M.notify(s, m, changeType);
    expect(res.status).toBe(202);
    await drain();
  }

  it('sem modo de recebimento a regra é recusada; o modo notificações precisa do endereço público', async () => {
    room = await channel(A);
    const r = await api('POST', 'msteams.in.save', { name: 'Avisos do turno', enabled: true, teamId: TEAM.id, channelId: CH.id, roomId: room._id, replies: true, edits: true, deletes: true, grantPublisher: false }, A);
    expect(r.status).toBe(400);
    expect(r.error).toBe(IN_TEXT.modeOff);
    const on = await saveConfig({ inboundMode: 'notifications' });
    expect(on.status).toBe(200);
    expect(on.config.inboundMode).toBe('notifications');
    hookUrl = urlOf(new URL(on.config.notificationsUrl).pathname);
  });

  it('o aperto de mão devolve o validationToken como texto, só no caminho certo', async () => {
    const token = 'Validation: tok-teste <b>eco</b>';
    const res = await fetch(`${hookUrl}?validationToken=${encodeURIComponent(token)}`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe(token);
    const wrong = await fetch(urlOf(`/hooks/msteams/${'x'.repeat(43)}?validationToken=abc`), { method: 'POST' });
    expect(wrong.status).toBe(404);
  });

  it('a regra cria a assinatura com includeResourceData false, o endereço do ciclo de vida e 55 minutos', async () => {
    const r = await api('POST', 'msteams.in.save', { name: 'Avisos do turno', enabled: true, teamId: TEAM.id, channelId: CH.id, roomId: room._id, replies: true, edits: true, deletes: true, grantPublisher: false }, A);
    expect(r.status).toBe(200);
    rule = r.rule;
    expect(r.rule).toMatchObject({ team: { id: TEAM.id, name: 'Operação' }, channel: { id: CH.id, name: 'Avisos do turno', membership: 'standard' }, roomId: room._id });
    const row = await one(`SELECT * FROM msteams_subscriptions WHERE integration_id = $1 AND purpose = 'messages'`, [rule._id]);
    sub = M.subscriptions.get(row.id)!;
    expect(sub).toMatchObject({ resource: `/teams/${TEAM.id}/channels/${CH.id}/messages`, changeType: 'created,updated,deleted', includeResourceData: false });
    const cfg = (await api('GET', 'msteams.config', {}, A)).config;
    expect(sub.notificationUrl).toBe(cfg.notificationsUrl);
    expect(sub.lifecycleNotificationUrl).toBe(`${cfg.notificationsUrl}/lifecycle`);
    const minutes = (Date.parse(sub.expirationDateTime) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(54);
    expect(minutes).toBeLessThanOrEqual(55);
    // O clientState vai só para o Graph; no banco fica o hash.
    expect(row.client_state_hash).toBe(sha256(sub.clientState));
    expect(JSON.stringify(row)).not.toContain(sub.clientState);
    expect(r.rule.subscriptionExpiresAt).toBeTruthy();
    const ann = await one(`SELECT msg FROM messages WHERE room_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`, [room._id, await botId()]);
    expect(ann.msg).toBe(`${IN_TEXT.announce('Operação', 'Avisos do turno', await nameOf(A))}${IN_TEXT.chatOnly}`);
    // Uma regra de envio na mesma sala: o que veio do Teams não volta para lá.
    echoRule = await saveOut({ name: 'Eco', roomIds: [room._id], filter: 'all', url: M.flowUrl('fluxo-eco') });
  });

  it('notificação com clientState errado é ignorada (e vira uma linha de atividade)', async () => {
    const m = M.post(CH, { author: anaMs });
    const res = await M.notify(sub, m, 'created', { clientState: 'tok-teste-estado-errado' });
    expect(res.status).toBe(202);
    expect(await one(`SELECT 1 FROM integration_jobs WHERE kind = 'msteams.notify' AND integration_id = $1`, [rule._id])).toBeNull();
    expect((await many(`SELECT text FROM integration_activity WHERE provider = 'msteams' AND text = $1`, [NOTIFY_TEXT.mismatch])).length).toBe(1);
    M.remove(m);
  });

  it('notificação certa → tarefa → leitura da mensagem → raiz e resposta em tópico com o apelido "{nome} (Teams)"', async () => {
    root = M.post(CH, { author: anaMs });
    const reads = M.graphCalls(`/v1.0/teams/${TEAM.id}/channels/${CH.id}/messages/${root.data.id}`).length;
    await deliver(root);
    expect(M.graphCalls(`/v1.0/teams/${TEAM.id}/channels/${CH.id}/messages/${root.data.id}`)).toHaveLength(reads + 1);
    const m = await bridgedOf(root.data.id);
    expect(m.alias).toBe('Ana Souza (Teams)');
    expect(m.msg).toContain('Bruno Teste, a fila de **retenção** voltou ao normal.');
    expect(m.msg).toContain('[painel da operação](https://explorer.sharepoint.com/sites/ops/painel.aspx)');
    expect(m.msg).toContain('👍');
    expect(m.msg).not.toMatch(/[<>]/);
    expect(m.extra.bridge).toMatchObject({ provider: 'msteams', externalId: root.data.id, author: 'Ana Souza', editedAt: null });
    expect(m.extra.bridge.webUrl).toMatch(/^https:\/\/teams\.microsoft\.com\/l\/message\//);
    expect(m.mentions ?? []).toEqual([]);

    reply = M.reply(root, { author: brunoMs, html: '<p>Obrigado, <strong>acompanhando</strong>.</p>' });
    await deliver(reply);
    const r = await bridgedOf(reply.data.id);
    expect(r).toMatchObject({ tmid: m.id, alias: 'Bruno Teste (Teams)', msg: 'Obrigado, **acompanhando**.' });
    // Nada disso volta para o Teams pela regra de envio da mesma sala.
    expect(await one(`SELECT 1 FROM integration_jobs WHERE integration_id = $1`, [echoRule._id])).toBeNull();
    expect(M.flowCalls('fluxo-eco')).toHaveLength(0);
  });

  it('M8: só lastModifiedDateTime (reação) não é edição; um lastEditedDateTime novo é', async () => {
    M.react(root);
    await deliver(root, 'updated');
    const same = await bridgedOf(root.data.id);
    expect(same.msg).toContain('a fila de **retenção** voltou ao normal');
    expect(same.extra.bridge.editedAt).toBeNull();

    M.edit(root, '<p>Fila de retenção <em>normalizada</em>.</p>');
    await deliver(root, 'updated');
    const edited = await bridgedOf(root.data.id);
    expect(edited.msg).toBe('Fila de retenção _normalizada_.');
    expect(edited.extra.bridge.editedAt).toBe(root.data.lastEditedDateTime);
  });

  it('exclusão no Teams é espelhada', async () => {
    const before = await bridgedOf(reply.data.id);
    M.remove(reply);
    await deliver(reply, 'deleted');
    expect(await bridgedOf(reply.data.id)).toBeNull();
    expect(await one(`SELECT id FROM messages WHERE id = $1 AND t IS NULL`, [before.id])).toBeNull();
  });

  it('nada mais antigo que a regra; @all neutralizado; from.application ignorado', async () => {
    const count = (await mirroredIn(room._id)).length;
    const old = M.post(CH, { author: anaMs, at: new Date(Date.now() - 3600_000), html: '<p>de antes da regra</p>' });
    await deliver(old);
    const app = M.post(CH, { fixture: 'message-application' });
    await deliver(app);
    expect(await mirroredIn(room._id)).toHaveLength(count);

    const all = M.post(CH, { author: anaMs, fixture: 'message-mention-all' });
    await deliver(all);
    const m = await bridgedOf(all.data.id);
    expect(m.msg).toContain('Operação atenção @​all e @​here');
    expect(m.msg).toContain('#​geral');
    expect(m.msg).not.toMatch(/(^|\s)@(all|here)\b/);
    expect(m.mentions ?? []).toEqual([]);
  });

  it('H5: cartão com wescc: e cartão sozinho do dono do fluxo não são espelhados; cartão de outra pessoa é', async () => {
    const count = (await mirroredIn(room._id)).length;
    const ours = M.post(CH, { author: brunoMs, fixture: 'message-wescc-card', vars: { ruleId: echoRule._id, messageId: 'abc123' } });
    await deliver(ours);
    const owners = M.post(CH, { author: ownerMs, fixture: 'message-card-flow-owner' });
    await deliver(owners);
    expect(await mirroredIn(room._id)).toHaveLength(count);
    // Os donos dos fluxos foram procurados pelo e-mail no Entra (aspas dobradas no $filter).
    expect(M.userFilters).toContain(`mail eq '${OWNER}' or userPrincipalName eq '${OWNER}'`);

    const other = M.post(CH, { author: brunoMs, fixture: 'message-card-flow-owner' });
    await deliver(other);
    const m = await bridgedOf(other.data.id);
    expect(m.msg).toBe('[conteúdo do Teams que o chat não mostra]');
  });

  it('H5: falha passageira ao procurar o dono de um fluxo não descarta cartões: a tarefa tenta de novo e o dono não fica marcado', async () => {
    const owner = 'dono.instavel@explorer-teste.com.br';
    M.addUser('dono.instavel', owner);
    const out = await saveOut({ name: 'Dono instável', roomIds: [(await channel(A))._id], filter: 'all', flowOwner: owner, url: M.flowUrl('fluxo-instavel') });
    let down = true;
    const stop = M.intercept((req) =>
      down && req.path === '/v1.0/users' && String(req.query.$filter ?? '').includes(owner) ? { status: 503, body: { error: { code: 'ServiceUnavailable', message: 'Tente mais tarde.' } } } : null,
    );
    try {
      const card = M.post(CH, { author: brunoMs, fixture: 'message-card-flow-owner' });
      await deliver(card);
      expect(await bridgedOf(card.data.id)).toBeNull();
      const job = await one(`SELECT id, status, last_error FROM integration_jobs WHERE kind = 'msteams.notify' AND integration_id = $1 AND payload->>'resource' LIKE $2`, [rule._id, `%${card.data.id}%`]);
      expect(job.status).toBe('queued');
      expect(job.last_error).toBeTruthy();
      down = false;
      await query(`UPDATE integration_jobs SET run_at = now() WHERE id = $1`, [job.id]);
      await drain();
      expect((await bridgedOf(card.data.id)).msg).toBe(HTML_TEXT.hidden);
      // O dono encontrado fica guardado: o próximo cartão sozinho de outra pessoa chega sem nova busca.
      const filters = M.userFilters.length;
      const next = M.post(CH, { author: brunoMs, fixture: 'message-card-flow-owner' });
      await deliver(next);
      expect((await bridgedOf(next.data.id)).msg).toBe(HTML_TEXT.hidden);
      expect(M.userFilters).toHaveLength(filters);
    } finally {
      stop();
      await api('POST', 'msteams.out.remove', { _id: out._id }, A);
    }
  });

  it('D21: texto do Teams partido entre tags não vira link nem menção; uma mensagem funda demais não trava a fila da regra', async () => {
    const t0 = new Date();
    const split = M.post(CH, {
      author: anaMs,
      html: '<p>Atualize sua senha em https:<span>//evil.example/login</span></p><p>Novo portal: <img src="https://x.example/a.png">(//evil.example/rh)</p><p>[Seu acesso expira]<b></b>(//evil.example/acesso) @<span>all</span></p>',
    });
    await deliver(split);
    const m = await bridgedOf(split.data.id);
    expect(m.msg).toContain(`https:${ZW}//evil.example/login`);
    expect(m.msg).toContain(`[imagem]${ZW}(//evil.example/rh)`);
    expect(m.msg).toContain(`[Seu acesso expira]${ZW}(//evil.example/acesso)`);
    expect(m.msg).toContain(`@${ZW}all`);
    expect(m.mentions ?? []).toEqual([]);

    const deep = M.post(CH, { author: anaMs, html: `<p>${'<b>'.repeat(3000)}funda</p>` });
    await deliver(deep);
    const later = M.post(CH, { author: anaMs, html: '<p>Mensagem normal, logo depois</p>' });
    await deliver(later);
    expect((await bridgedOf(deep.data.id)).msg).toContain('funda');
    expect((await bridgedOf(later.data.id)).msg).toBe('Mensagem normal, logo depois');
    expect(await many(`SELECT status, last_error FROM integration_jobs WHERE kind = 'msteams.notify' AND integration_id = $1 AND created_at >= $2 AND status <> 'done'`, [rule._id, t0])).toEqual([]);
  });

  it('D21: controles que um Safe Links desembrulha (%01, %03) não montam link nem @all, na mensagem nova e na edição', async () => {
    const SL = (inner: string) => `https://nam11.safelinks.protection.outlook.com/?url=${inner}&amp;data=05`;
    const m = M.post(CH, {
      author: anaMs,
      html:
        `<p>Atualize sua senha: ${SL('https%3A%01%2F%2Fevil.example%2Flogin')}</p>` +
        `<p>${SL('%5BSeu%20acesso%20expira%2C%20clique%20aqui%5D%01(%2F%2Fevil.example%2Facesso)')}</p>` +
        `<p>${SL('%5BPortal%20RH%5D%039%03(%2Faccount%2Fprofile)')}</p>` +
        `<p>${SL('%40%01all')} reunião agora</p>`,
    });
    await deliver(m);
    const row = await bridgedOf(m.data.id);
    expect(row.msg).toBe(
      [
        `Atualize sua senha: https:${ZW}//evil.example/login`,
        `[Seu acesso expira, clique aqui]${ZW}(//evil.example/acesso)`,
        `[Portal RH]${ZW}9${ZW}(/account/profile)`,
        `@${ZW}all reunião agora`,
      ].join('\n\n'),
    );
    expect(row.mentions ?? []).toEqual([]);
    M.edit(m, `<p>Novo: ${SL('https%3A%01%2F%2Fevil.example%2Fedit')}</p>`);
    await deliver(m, 'updated');
    expect((await bridgedOf(m.data.id)).msg).toBe(`Novo: https:${ZW}//evil.example/edit`);
  });

  it('nome do autor que um Safe Links desembrulha em U+0000 não trava a fila da regra: chega com o nome limpo e a seguinte também', async () => {
    const t0 = new Date();
    const guest = M.addUser('Convidado https://x.safelinks.protection.outlook.com/?url=%00%40all', 'convidado@externo-teste.com.br');
    const first = M.post(CH, { author: guest, html: '<p>Bom dia</p>' });
    await deliver(first);
    const later = M.post(CH, { author: anaMs, html: '<p>Mensagem normal, logo depois do convidado</p>' });
    await deliver(later);
    const m = await bridgedOf(first.data.id);
    expect(m).toMatchObject({ msg: 'Bom dia', alias: `Convidado @${ZW}all (Teams)` });
    expect(m.extra.bridge.author).toBe(`Convidado @${ZW}all`);
    expect((await bridgedOf(later.data.id)).msg).toBe('Mensagem normal, logo depois do convidado');
    expect(await many(`SELECT status, last_error FROM integration_jobs WHERE kind = 'msteams.notify' AND integration_id = $1 AND created_at >= $2 AND status <> 'done'`, [rule._id, t0])).toEqual([]);
  });

  it('H5: corpo montado de uma mensagem com cartão (100 mil "<" sem ">") não segura o servidor', async () => {
    const card = { attachments: [{ id: 'c1', contentType: 'application/vnd.microsoft.card.adaptive', content: '{"type":"AdaptiveCard"}' }] };
    const m = M.post(CH, { author: brunoMs, html: `${'<'.repeat(100_000)}<attachment id="c1"></attachment>`, patch: card });
    const res = await M.notify(sub, m, 'created');
    expect(res.status).toBe(202);
    const t0 = performance.now();
    await drain();
    const ms = performance.now() - t0;
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(3000);
    expect((await bridgedOf(m.data.id)).msg).toMatch(/^<{100}/);
  });

  it('renovação antes de vencer', async () => {
    const row = await one(`SELECT id FROM msteams_subscriptions WHERE integration_id = $1`, [rule._id]);
    await query(`UPDATE msteams_subscriptions SET expires_at = now() + interval '10 minutes' WHERE id = $1`, [row.id]);
    await runPollerOnce('msteams.subs');
    const patch = M.graphCalls(`/v1.0/subscriptions/${row.id}`).filter((c) => c.method === 'PATCH');
    expect(patch).toHaveLength(1);
    const after = await one(`SELECT extract(epoch FROM expires_at - now()) / 60 AS minutes FROM msteams_subscriptions WHERE id = $1`, [row.id]);
    expect(Number(after.minutes)).toBeGreaterThan(54);
    expect(Date.parse(M.subscriptions.get(row.id)!.expirationDateTime)).toBeGreaterThan(Date.now() + 54 * 60_000);
  });

  it('missed → uma leitura de recuperação (no máximo uma por hora)', async () => {
    const lost = M.post(CH, { author: anaMs, html: '<p>Mensagem que a notificação perdeu</p>' });
    const lists = () => M.graphCalls(`/v1.0/teams/${TEAM.id}/channels/${CH.id}/messages`).length;
    const before = lists();
    const res = await M.lifecycle(sub, 'missed');
    expect(res.status).toBe(202);
    await drain();
    expect(lists()).toBe(before + 1);
    expect(M.graphCalls(`/v1.0/teams/${TEAM.id}/channels/${CH.id}/messages`).at(-1)!.query).toMatchObject({ $top: '50', $expand: 'replies' });
    expect((await bridgedOf(lost.data.id)).msg).toBe('Mensagem que a notificação perdeu');
    await M.lifecycle(sub, 'missed');
    await drain();
    expect(lists()).toBe(before + 1);
  });

  it('ciclo de vida não espera atrás de uma notificação da regra que aguarda nova tentativa', async () => {
    const row = await one(`SELECT id FROM msteams_subscriptions WHERE integration_id = $1 AND purpose = 'messages'`, [rule._id]);
    const stuck = await enqueue('msteams.notify', { ruleId: rule._id, resource: 'x', changeType: 'created' }, { integrationId: rule._id, groupKey: `msteams.in:${rule._id}`, runAt: new Date(Date.now() + 3600_000) });
    try {
      const patches = () => M.graphCalls(`/v1.0/subscriptions/${row.id}`).filter((c) => c.method === 'PATCH').length;
      const before = patches();
      expect((await M.lifecycle(M.subscriptions.get(row.id)!, 'reauthorizationRequired')).status).toBe(202);
      await drain();
      expect(patches()).toBe(before + 1);
    } finally {
      await query(`DELETE FROM integration_jobs WHERE id = $1`, [stuck]);
    }
  });

  it('H4: canal privado do Teams pede acknowledgePrivate para canais e grupos privados do chat', async () => {
    const base = { name: 'Supervisão', enabled: true, teamId: TEAM.id, channelId: PRIV.id, replies: true, edits: true, deletes: true, grantPublisher: false };
    const pub = await channel(A);
    const priv = await group(A);
    for (const target of [pub, priv]) {
      const r = await api('POST', 'msteams.in.save', { ...base, roomId: target._id }, A);
      expect(r.status).toBe(400);
      expect(r.errorType).toBe('error-msteams-rule');
      expect(r.error).toBe(IN_TEXT.privateAck(target.name));
    }
    const ok = await api('POST', 'msteams.in.save', { ...base, roomId: priv._id, acknowledgePrivate: true }, A);
    expect(ok.rule.channel.membership).toBe('private');
    await api('POST', 'msteams.in.remove', { _id: ok.rule._id }, A);
  });

  it('sala de avisos pede grantPublisher; canal que a conta de serviço não vê → o texto do 403', async () => {
    const notice = await channel(A, [], { extraData: { notice: true } });
    const base = { name: 'Avisos', enabled: true, teamId: TEAM.id, channelId: CH.id, replies: true, edits: true, deletes: true };
    const refused = await api('POST', 'msteams.in.save', { ...base, roomId: notice._id, grantPublisher: false }, A);
    expect(refused.status).toBe(400);
    expect(refused.errorType).toBe('error-integration-room');
    expect(refused.error).toMatch(/canal de avisos/);
    const ok = await api('POST', 'msteams.in.save', { ...base, roomId: notice._id, grantPublisher: true }, A);
    expect(ok.status).toBe(200);
    const sub = await one(`SELECT roles FROM subscriptions WHERE room_id = $1 AND user_id = $2`, [notice._id, await botId()]);
    expect(sub.roles).toContain('publisher');
    await api('POST', 'msteams.in.remove', { _id: ok.rule._id }, A);

    const denied = await api('POST', 'msteams.in.save', { ...base, channelId: DENIED.id, roomId: (await channel(A))._id, grantPublisher: false }, A);
    expect(denied.status).toBe(400);
    expect(denied.error).toBe(IN_TEXT.forbidden(M.service.userPrincipalName));
  });

  it('canal que deixa de ser visível: 403 na leitura → o texto na regra', async () => {
    const target = await channel(A);
    const r = await api('POST', 'msteams.in.save', { name: 'Escalonamento', enabled: true, teamId: TEAM.id, channelId: CH2.id, roomId: target._id, replies: true, edits: true, deletes: true, grantPublisher: false }, A);
    const subRow = await one(`SELECT id FROM msteams_subscriptions WHERE integration_id = $1`, [r.rule._id]);
    const s2 = M.subscriptions.get(subRow.id)!;
    const m = M.post(CH2, { author: anaMs });
    CH2.forbidden = true;
    await deliver(m, 'created', s2);
    expect((await inRuleOf(r.rule._id)).lastError).toBe(IN_TEXT.forbidden(M.service.userPrincipalName));
    CH2.forbidden = false;
    await api('POST', 'msteams.in.remove', { _id: r.rule._id }, A);
    // A assinatura sai junto com a regra.
    expect(M.subscriptions.has(subRow.id)).toBe(false);
  });
});

// ---------- Recebimento por leitura periódica ----------

describe('Mensagens do Teams por leitura periódica (§5.4, D13)', () => {
  let rule: { _id: string };
  let room: string;
  const listCalls = () => M.graphCalls(new RegExp(`^/v1\\.0/teams/${TEAM.id}/channels/[^/]+/messages$`)).length;
  const deltaCalls = () => M.graphCalls(/\/messages\/delta$/);
  const bridgedOf = (teamsId: string) =>
    one(`SELECT m.id, m.msg, m.tmid FROM msteams_bridge_messages b JOIN messages m ON m.id = b.message_id WHERE b.integration_id = $1 AND b.teams_id = $2`, [rule._id, teamsId]);
  let lists = 0;

  beforeAll(async () => {
    const rules = (await api('GET', 'msteams.in.list', {}, A)).rules as any[];
    expect(rules).toHaveLength(1);
    rule = rules[0];
    room = rules[0].roomId;
  });

  it('sem acceptPolling → error-msteams-polling-accept', async () => {
    const r = await saveConfig({ inboundMode: 'polling' });
    expect(r.status).toBe(400);
    expect(r.errorType).toBe('error-msteams-polling-accept');
    expect(r.error).toBe(CONFIG_TEXT.pollingAccept);
  });

  it('com o aceite: as assinaturas saem, o delta link fica guardado e é reaproveitado', async () => {
    const r = await saveConfig({ inboundMode: 'polling', acceptPolling: true });
    expect(r.config).toMatchObject({ inboundMode: 'polling', pollingAcceptedBy: 'admin' });
    expect([...M.subscriptions.values()].filter((s) => s.resource.includes('/messages'))).toHaveLength(0);
    expect(await many(`SELECT id FROM msteams_subscriptions WHERE purpose = 'messages'`)).toHaveLength(0);
    lists = listCalls();

    await runPollerOnce('msteams.in');
    const first = deltaCalls().at(-1)!;
    expect(first.query.$filter).toMatch(/^lastModifiedDateTime gt \d{4}-\d{2}-\d{2}T/);
    const st = await getState<{ deltaLink?: string }>(`msteams.in:${rule._id}`);
    expect(st?.deltaLink).toContain('$deltatoken=');

    const fresh = M.post(CH, { author: anaMs, html: '<p>Chegou pela leitura periódica</p>' });
    await runPollerOnce('msteams.in');
    expect(deltaCalls().at(-1)!.query.$deltatoken).toBe(new URL(st!.deltaLink!).searchParams.get('$deltatoken'));
    const m = await bridgedOf(fresh.data.id);
    expect(m.msg).toBe('Chegou pela leitura periódica');

    const answer = M.reply(fresh, { author: brunoMs, html: '<p>Recebido</p>' });
    await runPollerOnce('msteams.in');
    expect(await bridgedOf(answer.data.id)).toMatchObject({ tmid: m.id, msg: 'Recebido' });
  });

  it('segue o @odata.nextLink até o fim antes de guardar o link novo', async () => {
    M.deltaPageSize = 1;
    try {
      const a = M.post(CH, { author: anaMs, html: '<p>página 1</p>' });
      const b = M.post(CH, { author: anaMs, html: '<p>página 2</p>' });
      await runPollerOnce('msteams.in');
      expect(deltaCalls().some((c) => c.query.$skiptoken)).toBe(true);
      const ma = await bridgedOf(a.data.id);
      const mb = await bridgedOf(b.data.id);
      expect([ma.msg, mb.msg]).toEqual(['página 1', 'página 2']);
      const order = await many(`SELECT id FROM messages WHERE id = ANY($1) ORDER BY created_at, id`, [[ma.id, mb.id]]);
      expect(order.map((o) => o.id)).toEqual([ma.id, mb.id]);
    } finally {
      M.deltaPageSize = null;
    }
  });

  it('mensagem que o chat recusa de vez ou funda demais não para a regra: as seguintes chegam e o delta link avança', async () => {
    const root = M.post(CH, { author: anaMs, html: '<p>Raiz antes das threads desligadas</p>' });
    await runPollerOnce('msteams.in');
    expect((await bridgedOf(root.data.id)).msg).toBe('Raiz antes das threads desligadas');
    await setSettings({ Threads_enabled: false });
    try {
      const refused = M.reply(root, { author: brunoMs, html: '<p>Resposta que o chat recusa</p>' });
      const deep = M.post(CH, { author: anaMs, html: `<p>${'<b>'.repeat(3000)}funda</p>` });
      const after = M.post(CH, { author: anaMs, html: '<p>Chegou depois da recusada</p>' });
      const link = (await getState<{ deltaLink?: string }>(`msteams.in:${rule._id}`))?.deltaLink;
      await runPollerOnce('msteams.in');
      expect(await bridgedOf(refused.data.id)).toBeNull();
      expect((await bridgedOf(deep.data.id)).msg).toContain('funda');
      expect((await bridgedOf(after.data.id)).msg).toBe('Chegou depois da recusada');
      expect((await getState<{ deltaLink?: string }>(`msteams.in:${rule._id}`))?.deltaLink).not.toBe(link);
      expect((await inRuleOf(rule._id)).lastError ?? null).toBeNull();
      // A recusa fica na atividade da regra, com o motivo.
      expect((await activityTexts(rule._id)).some((t) => t.includes('Threads estão desativadas'))).toBe(true);
    } finally {
      await setSettings({ Threads_enabled: true });
    }
  });

  it('nome do autor com U+0000 desembrulhado e erro de dado do banco não param a leitura: as seguintes chegam e o delta link avança', async () => {
    const guest = M.addUser('Visitante https://x.safelinks.protection.outlook.com/?url=%00', 'visitante@externo-teste.com.br');
    const odd = M.post(CH, { author: guest, html: '<p>Bom dia de novo</p>' });
    const after = M.post(CH, { author: anaMs, html: '<p>Chegou depois do nome estranho</p>' });
    const link = (await getState<{ deltaLink?: string }>(`msteams.in:${rule._id}`))?.deltaLink;
    await runPollerOnce('msteams.in');
    expect(await bridgedOf(odd.data.id)).toMatchObject({ msg: 'Bom dia de novo' });
    expect((await one(`SELECT alias FROM messages WHERE id = $1`, [(await bridgedOf(odd.data.id)).id])).alias).toBe('Visitante (Teams)');
    expect((await bridgedOf(after.data.id)).msg).toBe('Chegou depois do nome estranho');
    expect((await getState<{ deltaLink?: string }>(`msteams.in:${rule._id}`))?.deltaLink).not.toBe(link);
    expect((await inRuleOf(rule._id)).lastError ?? null).toBeNull();

    // Um dado que o banco recusa sempre (aqui um id com U+0000) é recusa de vez: fica na atividade e a leitura segue.
    const r = (await getInRow(rule._id))!;
    const bad = { ...after.data, id: `x\u0000${Date.now()}` };
    await expect(processTeamsMessage(r, bad, null)).rejects.toBeInstanceOf(PermanentError);
    await expect(processOrSkip(r, bad, null)).resolves.toBeUndefined();
    expect((await activityTexts(rule._id)).some((t) => t.startsWith(IN_TEXT.unsaved('')))).toBe(true);
  });

  it('a leitura periódica nunca usa a lista de mensagens', () => {
    expect(listCalls()).toBe(lists);
  });

  it('404 no delta → leitura periódica indisponível', async () => {
    M.deltaUnavailable = true;
    try {
      await runPollerOnce('msteams.in'); // o link guardado falha: recomeça na próxima
      await runPollerOnce('msteams.in'); // o primeiro delta falha e o canal existe
      const cfg = (await api('GET', 'msteams.config', {}, A)).config;
      expect(cfg.pollingUnavailable).toBe(CONFIG_TEXT.pollingUnavailable);
      expect((await inRuleOf(rule._id)).lastError).toBe(CONFIG_TEXT.pollingUnavailable);
    } finally {
      M.deltaUnavailable = false;
    }
    // Volta a valer com um novo aceite.
    await saveConfig({ inboundMode: 'off' });
    const again = await saveConfig({ inboundMode: 'polling', acceptPolling: true });
    expect(again.config.pollingUnavailable).toBeNull();
    const fresh = M.post(CH, { author: anaMs, html: '<p>de volta</p>' });
    await runPollerOnce('msteams.in');
    expect((await bridgedOf(fresh.data.id)).msg).toBe('de volta');
    expect(room).toBeTruthy();
  });
});

// ---------- Conta de serviço parada ----------

describe('M23: conta de serviço com invalid_grant', () => {
  it('status err com o texto, regras de recebimento paradas e alerta msteams.service uma vez por dia', async () => {
    const alerts = () => wsA.events.filter((e) => e.type === 'integrations.alert' && e.alert?.key === 'msteams.service');
    const before = alerts().length;
    M.refreshFault = msFixture('token-error-invalid-grant');
    M.expireTokens();
    const r = await api('GET', 'msteams.teams', {}, A);
    expect(r.status).toBe(400);
    expect(r.errorType).toBe('error-msteams-service');
    expect(r.error).toBe(GRAPH_TEXT.reauth);

    const cfg = (await api('GET', 'msteams.config', {}, A)).config;
    expect(cfg.serviceAccount.status).toMatchObject({ tone: 'err', text: GRAPH_TEXT.reauth });
    const overview = await api('GET', 'integrations.overview', {}, A);
    expect(overview.msteams.status).toMatchObject({ tone: 'err', text: GRAPH_TEXT.reauth });
    for (const rule of (await api('GET', 'msteams.in.list', {}, A)).rules) expect(rule.lastError).toBe(GRAPH_TEXT.reauth);
    await waitFor(async () => alerts().length === before + 1, 'o alerta msteams.service');

    // Outra instância que vê o mesmo problema não manda o alerta de novo; a leitura não tenta o Entra outra vez.
    const refreshes = M.tokenCalls('refresh_token').length;
    await markServiceBroken(GRAPH_TEXT.reauth);
    await runPollerOnce('msteams.in');
    expect(M.tokenCalls('refresh_token')).toHaveLength(refreshes);
    await sleep(200);
    expect(alerts()).toHaveLength(before + 1);
    expect((await getState<any>('poller:msteams.in'))?.failingSince).toBeTruthy();
  });

  it('entrar de novo limpa o erro e o alerta', async () => {
    M.refreshFault = null;
    const { cb } = await linkService();
    expect(cb.headers.get('location')).toContain('integracao=teams-ok');
    const cfg = (await api('GET', 'msteams.config', {}, A)).config;
    expect(cfg.serviceAccount.status.tone).toBe('ok');
    expect(await getState('alert:msteams.service')).toBeNull();
    expect((await api('GET', 'msteams.teams', {}, A)).teams).toHaveLength(1);
  });
});

// ---------- Erros do Graph ----------

describe('Erros do Microsoft Graph (§5.2, §11)', () => {
  it('503 sem Retry-After → indisponível; com Retry-After → ocupado; 400 → pedido recusado; 401 do aplicativo → aplicativo', async () => {
    let reply: FakeReply | null = null;
    const stop = M.intercept((req) => (req.path === '/v1.0/me/joinedTeams' ? reply : null));
    try {
      reply = { status: 503, body: { error: { code: 'ServiceUnavailable', message: 'Indisponível.' } } };
      expect(await api('GET', 'msteams.teams', {}, A)).toMatchObject({ status: 502, errorType: 'error-msteams-unavailable', error: GRAPH_TEXT.unavailable });
      reply = { status: 504, body: { error: { code: 'GatewayTimeout', message: 'Tempo esgotado.' } } };
      expect(await api('GET', 'msteams.teams', {}, A)).toMatchObject({ status: 502, errorType: 'error-msteams-unavailable' });
      reply = { status: 503, headers: { 'retry-after': '30' }, body: { error: { code: 'ServiceUnavailable', message: 'Espere.' } } };
      expect(await api('GET', 'msteams.teams', {}, A)).toMatchObject({ status: 429, errorType: 'error-msteams-busy', error: GRAPH_TEXT.busy });
      reply = { status: 400, body: { error: { code: 'BadRequest', message: 'Invalid filter clause' } } };
      expect(await api('GET', 'msteams.teams', {}, A)).toMatchObject({ status: 400, errorType: 'error-msteams-invalid', error: GRAPH_TEXT.invalid(400, 'BadRequest') });
    } finally {
      stop();
    }
    expect((await api('GET', 'msteams.teams', {}, A)).status).toBe(200);

    // 401 do Graph com o token do aplicativo (mesmo depois de pedir outro): é o aplicativo, não a conta de serviço.
    await saveConfig({ meetingsMode: 'graph' });
    const clara = await newUser(A, { name: 'Clara Erros', verified: true });
    M.addUser('Clara Erros', await emailOf(clara));
    const room = await channel(A, [clara.username]);
    const stop2 = M.intercept((req) =>
      req.method === 'POST' && /\/onlineMeetings$/.test(req.path) ? { status: 401, body: { error: { code: 'InvalidAuthenticationToken', message: 'Access token validation failure.' } } } : null,
    );
    try {
      const r = await api('POST', 'msteams.meeting.create', { roomId: room._id, tzOffset: -180 }, clara);
      expect(r).toMatchObject({ status: 400, errorType: 'error-msteams-app', error: GRAPH_TEXT.app });
    } finally {
      stop2();
    }
  });
});

// ---------- Reuniões ----------

describe('Reuniões do Teams (§5.5, §6)', () => {
  let ana: Auth;
  let bruno: Auth;
  let room: { _id: string; name: string };
  let ws: ReturnType<typeof connectWs>;
  let anaEmail = '';

  const graphCount = () => M.graphCalls().length;
  async function command(u: Auth, w: ReturnType<typeof connectWs>, rid: string, params: string) {
    const since = w.events.length;
    const r = await api('POST', 'commands.run', { roomId: rid, command: 'teams', params }, u);
    expect(r.status).toBe(200);
    expect(r.result).toEqual({ ok: true, command: 'teams' });
    return (await w.waitFor((e) => w.events.indexOf(e) >= since && e.type === 'ephemeral')).message;
  }

  beforeAll(async () => {
    await saveConfig({ meetingsMode: 'graph' });
    ana = await newUser(A, { name: 'Ana Reuniões', verified: true });
    bruno = await newUser(A, { name: 'Bruno Reuniões', verified: true });
    anaEmail = await emailOf(ana);
    M.addUser('Ana Reuniões', anaEmail);
    M.addUser('Bruno Reuniões', null, await emailOf(bruno)); // só o UPN
    room = await channel(A, [ana.username, bruno.username]);
    ws = connectWs(ana);
    await ws.ready;
  });
  afterAll(() => ws?.close());

  it('link colado → cartão publicado como a própria pessoa; link com Safe Links é aceito', async () => {
    const r = await api('POST', 'msteams.meeting.link', { roomId: room._id, url: MEET_URL, subject: 'Plantão [noite]' }, ana);
    expect(r.status).toBe(200);
    expect(r.meeting).toMatchObject({ provider: 'msteams', kind: 'linked', joinUrl: MEET_URL, subject: 'Plantão [noite]', by: { _id: ana.userId } });
    const msg = await one(`SELECT user_id, msg, extra, attachments FROM messages WHERE id = $1`, [r.messageId]);
    expect(msg.user_id).toBe(ana.userId);
    expect(msg.msg).toBe(`Reunião do Teams: [Plantão (noite)](${MEET_URL})`);
    expect(msg.extra.meeting).toMatchObject({ kind: 'linked', joinUrl: MEET_URL });
    expect(msg.attachments[0]).toMatchObject({ type: 'meeting', title: 'Plantão [noite]', title_link: MEET_URL });

    const wrapped = `https://nam12.safelinks.protection.outlook.com/?url=${encodeURIComponent(MEET_URL)}&data=05%7C02&reserved=0`;
    const safe = await api('POST', 'msteams.meeting.link', { roomId: room._id, url: wrapped }, ana);
    expect(safe.meeting.joinUrl).toBe(MEET_URL);
    expect(safe.meeting.subject).toBe(`Reunião em #${room.name}`);
  });

  it('link que não é de reunião do Teams → error-msteams-link', async () => {
    const r = await api('POST', 'msteams.meeting.link', { roomId: room._id, url: 'https://evil.example/l/meetup-join/abc' }, ana);
    expect(r.status).toBe(400);
    expect(r.errorType).toBe('error-msteams-link');
    expect(r.error).toBe(MEETING_TEXT.link);
  });

  it('criar pelo Graph → cartão; a busca usa mail ou userPrincipalName (B5)', async () => {
    const r = await api('POST', 'msteams.meeting.create', { roomId: room._id, subject: 'Alinhamento do turno', startsAt: '2026-10-23T12:00:00.000Z', minutes: 45, tzOffset: -180 }, ana);
    expect(r.status).toBe(200);
    const created = M.meetings.at(-1)!;
    expect(created.organizerId).toBe([...M.users.values()].find((u) => u.mail === anaEmail)!.id);
    expect(created.body).toMatchObject({
      subject: 'Alinhamento do turno',
      startDateTime: '2026-10-23T09:00:00-03:00',
      endDateTime: '2026-10-23T09:45:00-03:00',
      lobbyBypassSettings: { scope: 'organization', isDialInBypassEnabled: false },
    });
    expect(M.userFilters.at(-1)).toBe(`mail eq '${anaEmail}' or userPrincipalName eq '${anaEmail}'`);
    expect(r.meeting).toMatchObject({ kind: 'created', subject: 'Alinhamento do turno', startsAt: '2026-10-23T12:00:00.000Z', endsAt: '2026-10-23T12:45:00.000Z' });
    expect(r.meeting.joinUrl).toMatch(/^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//);
    const row = await one(`SELECT external_id, message_id FROM meetings WHERE id = $1`, [r.meeting.meetingId]);
    expect(row).toEqual({ external_id: created.id, message_id: r.messageId });
    // A segunda vez usa a conta guardada (sem nova busca).
    const filters = M.userFilters.length;
    await api('POST', 'msteams.meeting.create', { roomId: room._id, subject: 'Outra' }, ana);
    expect(M.userFilters).toHaveLength(filters);
  });

  it("B5: aspas simples do e-mail vão dobradas no $filter", async () => {
    const email = `o'neil.${crypto.randomBytes(3).toString('hex')}@explorer-teste.com.br`;
    const pat = await newUser(A, { name: "Pat O'Neil", email, verified: true });
    await api('POST', 'channels.invite', { roomId: room._id, username: pat.username }, A);
    M.addUser("Pat O'Neil", email);
    const r = await api('POST', 'msteams.meeting.create', { roomId: room._id }, pat);
    expect(r.status).toBe(200);
    const quoted = email.replace(/'/g, "''");
    expect(M.userFilters.at(-1)).toBe(`mail eq '${quoted}' or userPrincipalName eq '${quoted}'`);
  });

  it('sem a política de acesso de aplicativo → error-msteams-policy', async () => {
    const id = [...M.users.values()].find((u) => u.mail === anaEmail)!.id;
    M.meetingPolicyBlocked.add(id);
    try {
      const before = Number((await one(`SELECT count(*)::int AS n FROM messages WHERE room_id = $1`, [room._id])).n);
      const r = await api('POST', 'msteams.meeting.create', { roomId: room._id, subject: 'Bloqueada' }, ana);
      expect(r.status).toBe(403);
      expect(r.errorType).toBe('error-msteams-policy');
      expect(r.error).toBe(MEETING_TEXT.policy);
      expect(Number((await one(`SELECT count(*)::int AS n FROM messages WHERE room_id = $1`, [room._id])).n)).toBe(before);
    } finally {
      M.meetingPolicyBlocked.clear();
    }
  });

  it('B5: quem trocou o próprio e-mail (email_verified false) → error-msteams-email-unverified, sem chamar o Graph', async () => {
    await setSettings({ Accounts_AllowEmailChange: true });
    const carla = await newUser(A, { name: 'Carla', verified: true });
    await api('POST', 'channels.invite', { roomId: room._id, username: carla.username }, A);
    const changed = await api('POST', 'users.updateOwnBasicInfo', { data: { email: `carla.nova.${crypto.randomBytes(3).toString('hex')}@explorer-teste.com.br`, currentPassword: 'senha-forte-1' } }, carla);
    expect(changed.status).toBe(200);
    expect((await one(`SELECT email_verified FROM users WHERE id = $1`, [carla.userId])).email_verified).toBe(false);
    const calls = graphCount();
    const r = await api('POST', 'msteams.meeting.create', { roomId: room._id }, carla);
    expect(r.status).toBe(403);
    expect(r.errorType).toBe('error-msteams-email-unverified');
    expect(r.error).toBe(PEOPLE_TEXT.unverified);
    expect(graphCount()).toBe(calls);
    await setSettings({ Accounts_AllowEmailChange: false });
  });

  it('e-mail trocado pelo administrador derruba a conta guardada e busca de novo', async () => {
    const next = `ana.nova.${crypto.randomBytes(3).toString('hex')}@explorer-teste.com.br`;
    const newMs = M.addUser('Ana Reuniões (nova)', next);
    expect((await api('POST', 'users.update', { userId: ana.userId, data: { email: next, verified: true } }, A)).status).toBe(200);
    const r = await api('POST', 'msteams.meeting.create', { roomId: room._id, subject: 'Depois da troca' }, ana);
    expect(r.status).toBe(200);
    expect(M.meetings.at(-1)!.organizerId).toBe(newMs.id);
    expect(M.userFilters.at(-1)).toContain(`'${next}'`);
    const linked = await one(`SELECT external_id, email FROM linked_accounts WHERE user_id = $1 AND provider = 'microsoft'`, [ana.userId]);
    expect(linked).toEqual({ external_id: newMs.id, email: next });
    anaEmail = next;
  });

  it('dois resultados para o mesmo e-mail → error-msteams-no-account', async () => {
    const dup = await newUser(A, { name: 'Duplicado', verified: true });
    await api('POST', 'channels.invite', { roomId: room._id, username: dup.username }, A);
    const email = await emailOf(dup);
    M.addUser('Duplicado 1', email);
    M.addUser('Duplicado 2', email);
    const r = await api('POST', 'msteams.meeting.create', { roomId: room._id }, dup);
    expect(r.status).toBe(400);
    expect(r.errorType).toBe('error-msteams-no-account');
    expect(r.error).toBe(PEOPLE_TEXT.noAccount(email));
  });

  it('DM entre duas pessoas operacao: criar, colar link e agendar → 403 error-direct-restricted, sem chamar o Graph', async () => {
    const op1 = await newUser(A, { roles: ['user'], verified: true });
    const op2 = await newUser(A, { roles: ['user', 'operacao'], verified: true });
    const dm = await api('POST', 'im.create', { username: op2.username }, op1);
    expect(dm.status).toBe(200);
    await api('POST', 'roles.addUserToRole', { roleId: 'operacao', username: op1.username }, A);
    const calls = graphCount();
    for (const [endpoint, body] of [
      ['msteams.meeting.create', { roomId: dm.room._id }],
      ['msteams.meeting.link', { roomId: dm.room._id, url: MEET_URL }],
      ['msteams.meeting.scheduleLink', { roomId: dm.room._id, includeMembers: true }],
    ] as const) {
      const r = await api('POST', endpoint, body, op1);
      expect(r.status).toBe(403);
      expect(r.errorType).toBe('error-direct-restricted');
    }
    expect(graphCount()).toBe(calls);
    expect(await one(`SELECT 1 FROM meetings WHERE room_id = $1`, [dm.room._id])).toBeNull();
  });

  it('H1: /teams link pela API numa DM com quem pode ligar → o texto da restrição de chamadas, sem cartão', async () => {
    if (!(await one(`SELECT 1 FROM roles WHERE id = 'livre-teams'`))) {
      expect((await api('POST', 'roles.create', { name: 'livre-teams', scope: 'Users' }, A)).success).toBe(true);
    }
    const perms = (await api('GET', 'permissions.listAll', {}, A)).update as { _id: string; roles: string[] }[];
    const roles = perms.find((p) => p._id === 'start-dm-between-restricted')!.roles;
    await api('POST', 'permissions.update', { permissions: [{ _id: 'start-dm-between-restricted', roles: [...new Set([...roles, 'livre-teams'])] }] }, A);
    const op = await newUser(A, { roles: ['user', 'operacao'] });
    const free = await newUser(A, { roles: ['user', 'operacao', 'livre-teams'] });
    const dm = await api('POST', 'im.create', { username: op.username }, free);
    expect(dm.status).toBe(200);
    const w = connectWs(op);
    await w.ready;
    try {
      const reply = await command(op, w, dm.room._id, `link ${MEET_URL}`);
      expect(reply).toMatchObject({ tone: 'err', text: `Só @${free.username} pode iniciar chamadas com você.`, source: 'msteams' });
      expect(await one(`SELECT 1 FROM messages WHERE room_id = $1 AND extra ? 'meeting'`, [dm.room._id])).toBeNull();
      expect(await one(`SELECT 1 FROM meetings WHERE room_id = $1`, [dm.room._id])).toBeNull();
    } finally {
      w.close();
    }
  });

  it('D20: discussão da DM e grupo privado só com as duas pessoas seguem a restrição de chamadas (link, agendar, criar e /teams)', async () => {
    // Papel com a exceção criado no teste H1 acima.
    const op = await newUser(A, { roles: ['user', 'operacao'], verified: true });
    const free = await newUser(A, { roles: ['user', 'operacao', 'livre-teams'], verified: true });
    const dm = (await api('POST', 'im.create', { username: op.username }, free)).room;
    const d = await api('POST', 'rooms.createDiscussion', { prid: dm._id, t_name: 'Particular', users: [op.username] }, free);
    expect(d.status).toBe(200);
    const disc = d.discussion ?? d.room;
    const pair = await group(free, [op.username]);
    const text = `Só @${free.username} pode iniciar chamadas com você.`;
    const w = connectWs(op);
    await w.ready;
    try {
      const calls = graphCount();
      for (const rid of [disc._id, pair._id]) {
        for (const [endpoint, body] of [
          ['msteams.meeting.link', { roomId: rid, url: MEET_URL }],
          ['msteams.meeting.scheduleLink', { roomId: rid, includeMembers: true }],
          ['msteams.meeting.create', { roomId: rid }],
        ] as const) {
          const r = await api('POST', endpoint, body, op);
          expect(r.status, `${endpoint} em ${rid}`).toBe(403);
          expect(r.errorType).toBe('error-direct-restricted');
          expect(r.error).toBe(text);
        }
        expect(await command(op, w, rid, `link ${MEET_URL} Só nós dois`)).toMatchObject({ tone: 'err', text, source: 'msteams' });
        expect(await one(`SELECT 1 FROM meetings WHERE room_id = $1`, [rid])).toBeNull();
      }
      expect(graphCount()).toBe(calls);
    } finally {
      w.close();
    }
    // Quem tem a exceção marca na mesma discussão; um grupo com três pessoas não é uma ligação direta.
    expect((await api('POST', 'msteams.meeting.link', { roomId: disc._id, url: MEET_URL }, free)).status).toBe(200);
    const trio = await group(free, [op.username, ana.username]);
    expect((await api('POST', 'msteams.meeting.link', { roomId: trio._id, url: MEET_URL }, op)).status).toBe(200);
  });

  it('H1: /teams link por quem só lê um canal de avisos → o texto do canPostInRoom, sem cartão', async () => {
    const notice = await channel(A, [ana.username], { extraData: { notice: true } });
    const reply = await command(ana, ws, notice._id, `link ${MEET_URL}`);
    expect(reply).toMatchObject({ tone: 'err', text: 'Este é um canal de avisos: só os publicadores enviam mensagens.' });
    expect(await one(`SELECT 1 FROM meetings WHERE room_id = $1`, [notice._id])).toBeNull();
  });

  it('/teams sem nada abre o formulário; /teams link publica; /teams xyz mostra a ajuda', async () => {
    const form = await command(ana, ws, room._id, 'reuniao Revisão da escala');
    expect(form).toMatchObject({ tone: 'info', text: COMMAND_TEXT.opening, rid: room._id });
    expect(form.actions[0]).toMatchObject({ kind: 'modal', modal: 'msteams-meeting', autoOpen: true, params: { roomId: room._id, subject: 'Revisão da escala' } });
    expect(form.autoOpenFor).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const schedule = await command(ana, ws, room._id, 'agendar');
    expect(schedule.actions[0].params).toMatchObject({ roomId: room._id, tab: 'schedule' });
    const help = await command(ana, ws, room._id, 'xyz');
    expect(help.text).toBe(COMMAND_TEXT.help);

    const before = Number((await one(`SELECT count(*)::int AS n FROM meetings WHERE room_id = $1`, [room._id])).n);
    const r = await api('POST', 'commands.run', { roomId: room._id, command: 'teams', params: `link ${MEET_URL} Passagem de turno` }, ana);
    expect(r.result).toEqual({ ok: true, command: 'teams' });
    const meeting = await waitFor(async () => {
      const rows = await many(`SELECT subject, created_by FROM meetings WHERE room_id = $1 ORDER BY created_at`, [room._id]);
      return rows.length > before ? rows.at(-1) : null;
    }, 'a reunião do /teams link');
    expect(meeting).toEqual({ subject: 'Passagem de turno', created_by: ana.userId });
  });

  it('agendar: convidados (UPN) só em DM e grupo privado de até 20; quem não tem conta vai em skipped', async () => {
    const dm = await api('POST', 'im.create', { username: bruno.username }, ana);
    const brunoUpn = await emailOf(bruno);
    const inDm = await api('POST', 'msteams.meeting.scheduleLink', { roomId: dm.room._id, subject: 'Conversa rápida', startsAt: '2026-10-23T12:00:00.000Z', minutes: 30, tzOffset: -180, includeMembers: true }, ana);
    expect(inDm.status).toBe(200);
    expect(inDm.skipped).toEqual([]);
    const u = new URL(inDm.url);
    expect(`${u.origin}${u.pathname}`).toBe('https://teams.microsoft.com/l/meeting/new');
    expect(inDm.url).toContain('subject=Conversa%20r%C3%A1pida');
    expect(inDm.url).not.toContain('+');
    expect(u.searchParams.get('startTime')).toBe('2026-10-23T09:00:00-03:00');
    expect(u.searchParams.get('endTime')).toBe('2026-10-23T09:30:00-03:00');
    expect(u.searchParams.get('attendees')).toBe(brunoUpn);
    expect(u.searchParams.get('content')).toBe(MEETING_TEXT.contentDirect(siteName(), 'Bruno Reuniões'));

    const dora = await newUser(A, { name: 'Dora Sem Conta' });
    const priv = await group(ana, [bruno.username, dora.username]);
    const inGroup = await api('POST', 'msteams.meeting.scheduleLink', { roomId: priv._id, includeMembers: true }, ana);
    expect(new URL(inGroup.url).searchParams.get('attendees')).toBe(brunoUpn);
    expect(inGroup.skipped).toEqual(['Dora Sem Conta']);

    const pub = await api('POST', 'msteams.meeting.scheduleLink', { roomId: room._id, includeMembers: true }, ana);
    expect(new URL(pub.url).searchParams.get('attendees')).toBeNull();
    expect(pub.skipped).toEqual([]);
    expect(new URL(pub.url).searchParams.get('content')).toBe(MEETING_TEXT.content(siteName(), room.name));
  });
});

// ---------- Presença ----------

describe('Presença do Teams (fase 3, §5.6)', () => {
  let ana: Auth;
  let anaOid = '';
  let sub: FakeSubscription;
  let ws: ReturnType<typeof connectWs>;
  const user = (id: string) => one(`SELECT status, status_default, status_text FROM users WHERE id = $1`, [id]);
  const applied = async (id: string) => (await one(`SELECT applied FROM external_presence WHERE user_id = $1`, [id]))?.applied ?? null;
  async function presence(availability: string, activity: string) {
    M.presences.set(anaOid, { availability, activity });
    const res = await M.presenceChanged(sub, anaOid);
    expect(res.status).toBe(202);
    await drain();
  }

  beforeAll(async () => {
    ana = await newUser(A, { name: 'Ana Presença', verified: true });
    anaOid = M.addUser('Ana Presença', await emailOf(ana)).id;
    M.presences.set(anaOid, { availability: 'Available', activity: 'Available' });
  });
  afterAll(() => ws?.close());

  it('modo assinatura: cria a assinatura de presença e publica presence.external', async () => {
    const r = await saveConfig({ presenceEnabled: true });
    expect(r.config.presenceEnabled).toBe(true);
    const since = wsA.events.length;
    await runPollerOnce('msteams.presence');
    sub = [...M.subscriptions.values()].find((s) => s.resource.startsWith('/communications/presences'))!;
    expect(sub).toBeTruthy();
    expect(sub).toMatchObject({ changeType: 'updated', includeResourceData: false });
    expect(sub.resource).toContain(`'${anaOid}'`);
    const ev = await wsA.waitFor((e) => wsA.events.indexOf(e) >= since && e.type === 'presence.external' && e.userId === ana.userId);
    expect(ev.presence).toMatchObject({ provider: 'msteams', availability: 'Available', activity: 'Available', label: 'Disponível' });
    const got = await api('GET', 'msteams.presence', { userIds: ana.userId }, ana);
    expect(got.presence[ana.userId]).toMatchObject({ label: 'Disponível' });
  });

  it('M16: ocupado no Teams → "Em reunião no Teams" guardando o status anterior; ao sair volta o texto e o status', async () => {
    expect((await api('POST', 'integrations.linked.update', { provider: 'microsoft', busySync: true }, ana)).status).toBe(200);
    ws = connectWs(ana);
    await ws.ready;
    expect(await user(ana.userId)).toMatchObject({ status: 'online', status_default: 'online' });

    await presence('Busy', 'InAMeeting');
    expect(await user(ana.userId)).toEqual({ status: 'busy', status_default: 'online', status_text: PRESENCE_TEXT.busy });
    expect(await applied(ana.userId)).toEqual({ status: 'busy', previousDefault: 'online', previousText: '' });

    await presence('Available', 'Available');
    expect(await user(ana.userId)).toEqual({ status: 'online', status_default: 'online', status_text: '' });
    expect(await applied(ana.userId)).toBeNull();
  });

  it('M16: uma troca manual no meio da reunião nunca é sobrescrita', async () => {
    await presence('Busy', 'InACall');
    expect((await user(ana.userId))!.status).toBe('busy');
    expect((await api('POST', 'users.setStatus', { status: 'away', message: 'Almoço' }, ana)).status).toBe(200);
    await presence('Busy', 'Presenting');
    expect(await user(ana.userId)).toEqual({ status: 'away', status_default: 'away', status_text: 'Almoço' });
    expect(await applied(ana.userId)).toEqual({ status: 'manual' });
    await presence('Available', 'Available');
    expect(await user(ana.userId)).toEqual({ status: 'away', status_default: 'away', status_text: 'Almoço' });
    expect(await applied(ana.userId)).toBeNull();
  });

  it('sem endereço público, só lê por consulta com o aceite por escrito', async () => {
    await setSettings({ Site_Url: 'http://chat.explorer.example' });
    try {
      const polling = await getState('msteams.polling');
      await setState('msteams.polling', null);
      // Desligar e ligar de novo sem nenhum dos dois caminhos é recusado.
      await saveConfig({ presenceEnabled: false });
      const refused = await saveConfig({ presenceEnabled: true });
      expect(refused.status).toBe(400);
      expect(refused.error).toBe(CONFIG_TEXT.presenceDelivery);
      await setState('msteams.polling', polling);
      expect((await saveConfig({ presenceEnabled: true })).status).toBe(200);

      await setState('msteams.polling', null);
      const requests = M.presenceRequests.length;
      await runPollerOnce('msteams.presence');
      expect(M.presenceRequests).toHaveLength(requests);

      await setState('msteams.polling', polling);
      await runPollerOnce('msteams.presence');
      expect(M.presenceRequests.length).toBe(requests + 1);
      expect(M.presenceRequests.at(-1)).toContain(anaOid);
      // A consulta substitui a assinatura.
      expect([...M.subscriptions.values()].some((s) => s.resource.startsWith('/communications/presences'))).toBe(false);
    } finally {
      await setSettings({ Site_Url: SITE });
    }
  });
});

// ---------- Nada de segredo guardado à vista ----------

describe('Segredos (§3, §5)', () => {
  it('auditoria, atividade e fila sem segredo, token ou caminho de fluxo', async () => {
    const audit = await many(`SELECT action, target::text AS target, data::text AS data FROM audit_log`);
    expect(audit.some((r) => r.action === 'integration.msteams.rule.created')).toBe(true);
    for (const r of audit) expect(`${r.target} ${r.data}`).not.toMatch(/tok-teste|\/workflows\/|sig=/);
    const activity = await many(`SELECT text, detail FROM integration_activity`);
    for (const r of activity) expect(`${r.text} ${r.detail ?? ''}`).not.toMatch(/tok-teste|\/workflows\/|sig=/);
    const state = await many(`SELECT id, data::text AS data FROM integration_state`);
    for (const r of state) expect(r.data).not.toMatch(/tok-teste|eyJ/);
  });
});

describe('Textos que apontam abas de Administração › Integrações › Microsoft Teams', () => {
  it('cada "aba X" dos textos do servidor é uma aba que existe na página do Teams', () => {
    const page = fs.readFileSync(path.resolve(import.meta.dirname, '../../web/src/pages/admin/integrations/TeamsAdmin.tsx'), 'utf8');
    const tabs = [...page.matchAll(/\{ id: '[a-z]+', label: '([^']+)' \}/g)].map((m) => m[1]);
    expect(tabs).toEqual(expect.arrayContaining(['Conexão', 'Mensagens do Teams', 'Presença']));
    const dir = path.resolve(import.meta.dirname, '../src/integrations/msteams');
    const named = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/\baba ([A-ZÀ-Ý][\p{L} ]*?)(?=[.,;:)'`"]|$)/gmu)].map((m) => ({ f, tab: m[1] })));
    expect(named.length).toBeGreaterThan(0);
    for (const n of named) expect(tabs, `${n.f}: aba ${n.tab}`).toContain(n.tab);
    // O modo de recebimento e o aceite da leitura periódica ficam em Mensagens do Teams, não em Conexão.
    expect(IN_TEXT.modeOff).toBe('Escolha antes como as mensagens do Teams chegam (aba Mensagens do Teams).');
    expect(CONFIG_TEXT.presenceDelivery).toContain('leitura periódica aceita na aba Mensagens do Teams');
  });
});

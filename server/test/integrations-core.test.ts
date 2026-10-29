import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { jiraSiteAllowed, type MessageBridge, type MessageJira, type MessageMeeting } from '@shared/integrations';
import { stickerPreviewText } from '@shared/stickers';
import { config } from '../src/config';
import { migrate } from '../src/db/migrate';
import { one, pool } from '../src/db/pool';
import { ApiError } from '../src/lib/errors';
import { newId } from '../src/lib/ids';
import { SAFE_FETCH_TEXT, SafeFetchError, checkOutboundUrl, safeFetch } from '../src/lib/safeFetch';
import {
  KEY_MISMATCH,
  aadFor,
  checkSharedKey,
  encryptSecret,
  getSecret,
  integrationsPaused,
  keyMismatch,
  reencryptAll,
  reloadSecretsKey,
  secretState,
  setSecret,
} from '../src/lib/secrets';
import { alertText, clearAlert, raiseAlert } from '../src/integrations/alerts';
import { rawClient } from '../src/integrations/jira/client';
import { BOT_AVATAR } from '../src/integrations/assets';
import { BOTS, botCtx, botIds, checkTargets, ensureBotUser, prepareTargets, releaseTargets } from '../src/integrations/bots';
import { sendEphemeral, sessionTag } from '../src/integrations/ephemeral';
import {
  PermanentError,
  RetryLater,
  classifyError,
  collapseQueued,
  drainJobs,
  enqueue,
  getJob,
  registerJobHandler,
  retryDead,
  retryJob,
  sweepJobs,
  type JobHandler,
  type JobRow,
} from '../src/integrations/jobs';
import { expireAllLinked, getLinked, linkedSecrets, saveLinked, setLinkedStatus } from '../src/integrations/linked';
import { OAUTH_COOKIE, OAuthStateError, finishOAuth, safeReturnTo, startOAuth, stateErrorTarget } from '../src/integrations/oauthState';
import { checkSecretsKey, registerPoller, runDailyChecks, runPollerOnce, startIntegrationsRuntime, withLease, wrapHook } from '../src/integrations/runtime';
import { claimPost, getState, mergeState, releasePost, setState } from '../src/integrations/state';
import { excerpt, messagePermalink, plainFromMarkdown, safeExternalText, trustedLinkHost } from '../src/integrations/text';
import { runSync, type LdapSource } from '../src/ldap/sync';
import { registerCommand } from '../src/services/commands';
import { getMessageRow, removeMessageRow, replaceMessageText, sendMessage, setMessageExtra } from '../src/services/messages';
import { OPERACAO_PERMISSIONS, rolesWithPermission, seedPermissions, setPermissionRoles } from '../src/services/permissions';
import { createDirect } from '../src/services/rooms';
import { updateSettings } from '../src/services/settings';
import type { Ctx } from '../src/services/users';
import { startFake, type FakeServer } from './fake-http';
import { admin, api, connectWs, login, newUser, sleep, startServer, stopServer, urlOf, type Auth } from './helpers';
import { webp } from './sticker-bytes';

// Núcleo (§3): chave de teste, nenhum proxy do ambiente (o sandbox exporta HTTPS_PROXY e NO_PROXY) e só os
// servidores falsos liberados. Nenhum teste fala com a Atlassian ou com a Microsoft de verdade.
let TEST_KEY = crypto.randomBytes(32).toString('base64');
process.env.SECRETS_KEY = TEST_KEY;
for (const k of [
  'SECRETS_KEY_FILE', 'SECRETS_KEY_PREVIOUS', 'SECRETS_KEY_PREVIOUS_FILE', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy',
  'INTEGRATIONS_PROXY', 'INTEGRATIONS_PROXY_FILE', 'INTEGRATIONS_PROXY_FOR_ALLOWED', 'INTEGRATIONS_ALLOWED_HOSTS', 'NODE_USE_ENV_PROXY',
]) {
  delete process.env[k];
}
reloadSecretsKey();

// Integrações com Jira e Teams, núcleo. Fase 0: migração 016, API genérica, configurações, permissões,
// mensagens de integração (§2.6), comandos (§2.7) e o texto de figurinha nos webhooks de saída.

let A: Auth;
let hook: http.Server;
let hookUrl = '';
const received: any[] = [];

beforeAll(async () => {
  await startServer();
  A = await admin();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
  hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body || '{}'));
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
  hookUrl = `http://127.0.0.1:${(hook.address() as any).port}/saida`;
});
afterAll(async () => {
  hook?.close();
  await stopServer();
});

// ---------- Ajudantes ----------

const ctxOf = (u: { userId: string; username: string }): Ctx => ({ userId: u.userId, username: u.username, sessionId: '' });
const uniq = (p: string) => `${p}-${newId().slice(0, 6).toLowerCase()}`;

async function channel(owner: Auth, members: string[] = [], extra: Record<string, unknown> = {}) {
  const r = await api('POST', 'channels.create', { name: uniq('int'), members, ...extra }, owner);
  if (!r.channel) throw new Error(JSON.stringify(r));
  return r.channel as { _id: string; name: string };
}

async function botUser() {
  const username = uniq('robo');
  const r = await api('POST', 'users.create', { username, name: 'Robô de teste', email: `${username}@test.local`, password: 'senha-forte-1', roles: 'bot', type: 'bot', joinDefaultChannels: false }, A);
  if (!r.user) throw new Error(JSON.stringify(r));
  return { userId: r.user._id as string, username };
}

async function managedRule(type: 'jira-events' | 'msteams-outgoing' | 'msteams-incoming', userId: string, username: string) {
  const id = newId();
  await pool.query(`INSERT INTO integrations (id, type, name, token, user_id, username, config) VALUES ($1, $2, $3, '', $4, $5, '{"x": 1}')`, [id, type, `Regra ${type}`, userId, username]);
  return id;
}

const snapshot = (): MessageJira => ({
  kind: 'event',
  site: 'https://explorer.atlassian.net',
  issues: [
    {
      id: '10001',
      key: 'OPS-1',
      url: 'https://explorer.atlassian.net/browse/OPS-1',
      summary: 'Fila parada',
      status: { name: 'Em andamento', category: 'indeterminate' },
      type: { name: 'Tarefa', kind: 'task' },
      project: { key: 'OPS', name: 'Operação' },
      updatedAt: new Date().toISOString(),
    },
  ],
  event: { kind: 'status', at: new Date().toISOString() },
});
const meeting = (by: { userId: string; username: string }): MessageMeeting => ({
  provider: 'msteams',
  kind: 'linked',
  meetingId: newId(),
  joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_teste%40thread.v2/0',
  subject: 'Alinhamento',
  by: { _id: by.userId, username: by.username },
});
const bridge = (): MessageBridge => ({ provider: 'msteams', externalId: '1700000000000', author: 'Ana (Teams)' });

// ---------- Migração ----------

describe('Fase 0: migração 016', () => {
  it('os tipos novos passam na restrição, um tipo desconhecido não, e as tabelas e índices existem', async () => {
    for (const type of ['jira-events', 'msteams-outgoing', 'msteams-incoming'] as const) await managedRule(type, A.userId, A.username);
    const bad = await pool.query(`INSERT INTO integrations (id, type, name, token, user_id, username) VALUES ($1, 'outro', 'x', '', $2, 'admin')`, [newId(), A.userId]).catch((e) => e);
    expect(bad.code).toBe('23514');
    const objects = [
      'integration_secrets', 'integration_state', 'integration_activity', 'linked_accounts', 'integration_oauth_states', 'integration_jobs',
      'integration_seen', 'jira_threads', 'msteams_bridge_messages', 'msteams_subscriptions', 'meetings', 'external_presence',
      'integrations_type_idx', 'integration_activity_idx', 'integration_activity_rule_idx', 'linked_accounts_external_idx',
      'integration_jobs_dedupe_idx', 'integration_jobs_due_idx', 'integration_jobs_group_idx', 'integration_jobs_running_idx',
      'integration_jobs_rule_idx', 'integration_seen_age_idx', 'msteams_bridge_message_idx', 'msteams_subscriptions_exp_idx', 'meetings_room_idx',
    ];
    const missing = (await pool.query(`SELECT o FROM unnest($1::text[]) o WHERE to_regclass(o) IS NULL`, [objects])).rows.map((r) => r.o);
    expect(missing).toEqual([]);
    const row = await one(`SELECT config, secret, last_ok_at FROM integrations WHERE type = 'webhook-incoming' LIMIT 1`);
    expect(row === null || JSON.stringify(row.config) === '{}').toBe(true);
  });

  it('executar as migrações de novo não aplica nada', async () => {
    const log: string[] = [];
    await migrate((m) => log.push(m));
    expect(log).toEqual([]);
    expect((await one(`SELECT 1 AS ok FROM schema_migrations WHERE name = '016_jira_msteams.sql'`))?.ok).toBe(1);
  });

  it('M2: excluir o robô de uma regra levanta WI001 e a API responde 400 error-integration-bot; outro usuário continua excluível', async () => {
    const bot = await botUser();
    const dm = await api('POST', 'im.create', { username: bot.username }, A);
    expect(dm.success).toBe(true);
    const rule = await managedRule('jira-events', bot.userId, bot.username);

    const direct = await pool.query('DELETE FROM users WHERE id = $1', [bot.userId]).catch((e) => e);
    expect(direct.code).toBe('WI001');
    const r = await api('POST', 'users.delete', { userId: bot.userId }, A);
    expect(r).toMatchObject({ status: 400, success: false, errorType: 'error-integration-bot', error: 'Este usuário é o robô de uma integração. Exclua as regras dela antes.' });
    // A exclusão é uma transação: a DM e o usuário continuam lá.
    expect(await one('SELECT 1 FROM users WHERE id = $1', [bot.userId])).not.toBeNull();
    expect(await one('SELECT 1 FROM rooms WHERE id = $1', [dm.room._id])).not.toBeNull();

    // Webhook genérico: a chave estrangeira continua apagando a integração junto com o usuário.
    const other = await newUser(A);
    const hookIn = await api('POST', 'integrations.create', { type: 'webhook-incoming', name: 'Genérico', username: other.username, channel: '#geral' }, A);
    expect((await api('POST', 'users.delete', { userId: other.userId }, A)).success).toBe(true);
    expect(await one('SELECT 1 FROM integrations WHERE id = $1', [hookIn.integration._id])).toBeNull();

    await pool.query('DELETE FROM integrations WHERE id = $1', [rule]);
    expect((await api('POST', 'users.delete', { userId: bot.userId }, A)).success).toBe(true);
  });
});

// ---------- API genérica, configurações e permissões ----------

describe('Fase 0: API genérica de integrações', () => {
  it('integrations.list esconde os tipos do Jira e do Teams; get/update/remove/history/clearHistory recusam', async () => {
    const generic = await api('POST', 'integrations.create', { type: 'webhook-incoming', name: 'CI', username: 'admin', channel: '#geral' }, A);
    const jira = await managedRule('jira-events', A.userId, A.username);
    const teams = await managedRule('msteams-outgoing', A.userId, A.username);

    const list = await api('GET', 'integrations.list', { count: '500' }, A);
    expect(list.integrations.map((i: any) => i.type).every((t: string) => t === 'webhook-incoming' || t === 'webhook-outgoing')).toBe(true);
    expect(list.integrations.some((i: any) => i._id === generic.integration._id)).toBe(true);
    expect(list.total).toBe(list.integrations.length);
    expect(await api('GET', 'integrations.list', { type: 'jira-events' }, A)).toMatchObject({ status: 400, errorType: 'error-integration-managed' });

    const jiraText = 'Esta integração é configurada em Administração → Integrações → Jira.';
    const teamsText = 'Esta integração é configurada em Administração → Integrações → Microsoft Teams.';
    expect(await api('GET', 'integrations.get', { integrationId: jira }, A)).toMatchObject({ status: 400, errorType: 'error-integration-managed', error: jiraText });
    expect(await api('GET', 'integrations.get', { integrationId: teams }, A)).toMatchObject({ status: 400, error: teamsText });
    expect(await api('PUT', 'integrations.update', { integrationId: jira, type: 'webhook-incoming', name: 'Trocada', username: 'admin', channel: '#geral' }, A)).toMatchObject({
      status: 400,
      errorType: 'error-integration-managed',
    });
    expect(await api('POST', 'integrations.remove', { integrationId: teams }, A)).toMatchObject({ status: 400, error: teamsText });
    expect(await api('GET', 'integrations.history', { id: jira }, A)).toMatchObject({ status: 400, errorType: 'error-integration-managed' });
    expect(await api('POST', 'integrations.clearHistory', { integrationId: jira }, A)).toMatchObject({ status: 400, errorType: 'error-integration-managed' });
    const rows = await pool.query(`SELECT name, config FROM integrations WHERE id = ANY($1) ORDER BY type`, [[jira, teams]]);
    expect(rows.rows).toEqual([
      { name: 'Regra jira-events', config: { x: 1 } },
      { name: 'Regra msteams-outgoing', config: { x: 1 } },
    ]);
  });
});

describe('Fase 0: configurações e permissões', () => {
  it('M17: settings.public não expõe nada do Jira nem do Teams', async () => {
    const pub = await api('GET', 'settings.public');
    expect(pub.settings.length).toBeGreaterThan(0);
    expect(pub.settings.filter((s: any) => /^(Jira|MSTeams)_/.test(s._id))).toEqual([]);
    const all = await api('GET', 'settings', undefined, A);
    const ids = (all.settings ?? []).map((s: any) => s._id);
    expect(ids).toEqual(expect.arrayContaining(['Jira_Enabled', 'Jira_Site_Url', 'Jira_Events_Mode', 'MSTeams_Enabled', 'MSTeams_Inbound_Mode', 'MSTeams_Meetings_Mode']));
  });

  it('as configurações conferem o endereço do Jira, as chaves de projeto, os IDs do Entra e os intervalos', async () => {
    const set = (settings: Record<string, unknown>) => api('POST', 'settings', { settings }, A);
    const evil = await set({ Jira_Site_Url: 'https://evil.example' });
    expect(evil).toMatchObject({ status: 400, errorType: 'error-invalid-setting-value' });
    expect(evil.error).toContain('termina em .atlassian.net');
    expect((await set({ Jira_Site_Url: 'https://explorer.atlassian.net/browse' })).error).toContain('sem caminho');
    expect((await set({ Jira_Projects_Visible: 'OPS, 1X' })).error).toContain('Chave de projeto inválida: 1X.');
    expect((await set({ MSTeams_Tenant_Id: 'abc' })).error).toContain('00000000-0000-0000-0000-000000000000');
    expect((await set({ Jira_Poll_Minutes: 20 })).status).toBe(400);
    expect((await set({ MSTeams_Meeting_Minutes: 10 })).status).toBe(400);
    expect((await set({ MSTeams_Inbound_Mode: 'webhook' })).status).toBe(400);
    const ok = await set({ Jira_Site_Url: 'https://explorer.atlassian.net', Jira_Projects_Visible: 'OPS, SUP', MSTeams_Tenant_Id: '0b3c1d2e-1111-4222-8333-444455556666', Jira_Poll_Minutes: 5 });
    expect(ok.success).toBe(true);
    await set({ Jira_Site_Url: '', Jira_Projects_Visible: '', MSTeams_Tenant_Id: '', Jira_Poll_Minutes: 2 });
  });

  it('as cinco permissões vêm semeadas (também num banco que já existia) e a Operação não tem nenhuma', async () => {
    const five = ['use-jira', 'create-jira-issue', 'manage-jira', 'start-msteams-meeting', 'manage-msteams'];
    await pool.query('DELETE FROM permissions WHERE id = ANY($1)', [five]);
    await seedPermissions();
    const rows = (await pool.query('SELECT id, grp, roles FROM permissions WHERE id = ANY($1) ORDER BY id', [five])).rows;
    expect(rows).toEqual([
      { id: 'create-jira-issue', grp: 'integrations', roles: ['admin', 'user'] },
      { id: 'manage-jira', grp: 'integrations', roles: ['admin'] },
      { id: 'manage-msteams', grp: 'integrations', roles: ['admin'] },
      { id: 'start-msteams-meeting', grp: 'integrations', roles: ['admin', 'user'] },
      { id: 'use-jira', grp: 'integrations', roles: ['admin', 'user'] },
    ]);
    expect(five.filter((p) => OPERACAO_PERMISSIONS.includes(p))).toEqual([]);
    const perms = (await api('GET', 'permissions.listAll', {}, A)).update as { _id: string; roles: string[] }[];
    expect(perms.filter((p) => five.includes(p._id) && p.roles.includes('operacao'))).toEqual([]);
  });
});

// ---------- Mensagens (§2.6) ----------

describe('Fase 0: mensagens de integração', () => {
  it('chat.sendMessage ignora jira, meeting, bridge, jiraNoPreview e mentionsAllowed vindos do cliente', async () => {
    const ana = await newUser(A);
    const ch = await channel(A, [ana.username]);
    const r = await api(
      'POST',
      'chat.sendMessage',
      { message: { rid: ch._id, msg: `oi @${ana.username}`, jira: snapshot(), meeting: meeting(A), bridge: bridge(), jiraNoPreview: true, mentionsAllowed: [] } },
      A,
    );
    expect(r.success).toBe(true);
    expect(r.message).not.toHaveProperty('jira');
    expect(r.message).not.toHaveProperty('meeting');
    expect(r.message).not.toHaveProperty('bridge');
    const row = await getMessageRow(r.message._id);
    expect(row.extra).toEqual({});
    expect(row.mentions.map((m: any) => m.username)).toEqual([ana.username]);
    // Sem texto, o cartão do cliente não salva a mensagem vazia.
    const empty = await api('POST', 'chat.sendMessage', { message: { rid: ch._id, msg: '', jira: snapshot() } }, A);
    expect(empty).toMatchObject({ status: 400, errorType: 'error-invalid-message' });
  });

  it('sendMessage com integration grava jira, meeting e bridge e aceita texto vazio com cartão', async () => {
    const bot = await botUser();
    const ch = await channel(A, [bot.username]);
    const j = snapshot();
    const m = await sendMessage(ctxOf(bot), { rid: ch._id, msg: '', jira: j, bridge: bridge() }, { skipCommands: true, trusted: true, internalAttachments: true, integration: true });
    expect(m.jira).toEqual(j);
    expect(m.bridge).toEqual(bridge());
    const mt = meeting(bot);
    const m2 = await sendMessage(ctxOf(bot), { rid: ch._id, meeting: mt }, { skipCommands: true, trusted: true, internalAttachments: true, integration: true });
    expect((await getMessageRow(m2._id)).extra).toEqual({ meeting: mt });
    // Só bridge não é cartão: sem texto continua vazia.
    await expect(sendMessage(ctxOf(bot), { rid: ch._id, bridge: bridge() }, { integration: true })).rejects.toMatchObject({ errorType: 'error-invalid-message' });
    // Sem opts.integration nada disso vale, nem do código do servidor.
    const plain = await sendMessage(ctxOf(bot), { rid: ch._id, msg: 'texto', jira: j, meeting: mt, bridge: bridge() }, { skipCommands: true, trusted: true });
    expect((await getMessageRow(plain._id)).extra).toEqual({});
  });

  it('H3: envio de integração com @all, @here, @pessoa e #sala não menciona ninguém, mesmo com o robô publicador; mentionsAllowed menciona só a Ana', async () => {
    const bot = await botUser();
    const ana = await newUser(A);
    const pessoa = await newUser(A);
    const other = await channel(A);
    const avisos = await channel(A, [bot.username, ana.username, pessoa.username], { extraData: { notice: true } });
    expect((await api('POST', 'channels.addPublisher', { roomId: avisos._id, userId: bot.userId }, A)).success).toBe(true);
    const text = `Aviso @all @here @${pessoa.username} @${ana.username} em #${other.name}`;

    const none = await sendMessage(ctxOf(bot), { rid: avisos._id, msg: text }, { skipCommands: true, trusted: true, integration: true });
    expect(none.mentions).toEqual([]);
    expect(none.channels).toEqual([]);
    const only = await sendMessage(ctxOf(bot), { rid: avisos._id, msg: text, mentionsAllowed: [ana.username.toUpperCase()] }, { skipCommands: true, trusted: true, integration: true });
    expect(only.mentions.map((m: any) => m.username)).toEqual([ana.username]);
    expect(only.channels).toEqual([]);
    const subs = (await pool.query('SELECT user_id, user_mentions, group_mentions FROM subscriptions WHERE room_id = $1 AND user_id = ANY($2)', [avisos._id, [ana.userId, pessoa.userId]])).rows;
    expect(subs.find((s) => s.user_id === ana.userId)).toMatchObject({ user_mentions: 1, group_mentions: 0 });
    expect(subs.find((s) => s.user_id === pessoa.userId)).toMatchObject({ user_mentions: 0, group_mentions: 0 });

    // O mesmo texto de uma pessoa (publicadora) continua mencionando: só integrações perdem as menções.
    const person = await sendMessage(ctxOf(A), { rid: avisos._id, msg: text }, { skipCommands: true });
    expect(person.mentions.map((m: any) => m._id)).toEqual(expect.arrayContaining(['all', 'here', pessoa.userId, ana.userId]));
    expect(person.channels.map((c: any) => c._id)).toEqual([other._id]);

    // Um robô sem mention-all numa sala comum: @all de fora não vira erro, só some.
    const sala = await channel(A, [bot.username]);
    const quiet = await sendMessage(ctxOf(bot), { rid: sala._id, msg: '@all @here' }, { skipCommands: true, trusted: true, integration: true });
    expect(quiet.mentions).toEqual([]);
  });

  it('setMessageExtra publica updated sem editedAt e remove a chave com null', async () => {
    const ch = await channel(A);
    const m = await sendMessage(ctxOf(A), { rid: ch._id, msg: 'veja OPS-1' }, { skipCommands: true });
    const ws = connectWs(A);
    await ws.ready;
    try {
      const j = { ...snapshot(), kind: 'preview' as const };
      await setMessageExtra(m._id, 'jira', j);
      const ev = await ws.waitFor((e) => e.type === 'message' && e.action === 'updated' && e.message._id === m._id && e.message.jira);
      expect(ev.message.jira).toEqual(j);
      expect(ev.message.editedAt ?? null).toBeNull();
      expect(ev.message.msg).toBe('veja OPS-1');
      await setMessageExtra(m._id, 'jiraNoPreview', true);
      await setMessageExtra(m._id, 'jira', null);
      const gone = await ws.waitFor((e) => e.type === 'message' && e.action === 'updated' && e.message._id === m._id && !e.message.jira && e.message.jiraNoPreview);
      expect(gone.message.jiraNoPreview).toBe(true);
      const row = await getMessageRow(m._id);
      expect(row.extra).toEqual({ jiraNoPreview: true });
      expect(row.edited_at).toBeNull();
      expect(await setMessageExtra('naoexiste123', 'jira', j)).toBeNull();
    } finally {
      ws.close();
    }
  });

  it('replaceMessageText guarda o histórico, tira as menções e marca a edição', async () => {
    const bot = await botUser();
    const ana = await newUser(A);
    const ch = await channel(A, [bot.username, ana.username]);
    const m = await sendMessage(ctxOf(bot), { rid: ch._id, msg: 'original', bridge: bridge(), mentionsAllowed: [ana.username] }, { skipCommands: true, trusted: true, integration: true });
    const out = await replaceMessageText(m._id, `  editada @${ana.username} #${ch.name}  `, { id: bot.userId, username: bot.username }, { bridge: { ...bridge(), editedAt: '2026-10-22T12:00:00.000Z' } });
    expect(out.msg).toBe(`editada @${ana.username} #${ch.name}`);
    expect(out.mentions).toEqual([]);
    expect(out.channels).toEqual([]);
    expect(out.bridge.editedAt).toBe('2026-10-22T12:00:00.000Z');
    expect(out.editedBy).toMatchObject({ _id: bot.userId, username: bot.username });
    expect(out.editedAt).toBeTruthy();
    const hist = (await pool.query('SELECT msg, edited_by FROM message_history WHERE message_id = $1', [m._id])).rows;
    expect(hist).toEqual([{ msg: 'original', edited_by: bot.userId }]);
    const room = await one('SELECT last_message FROM rooms WHERE id = $1', [ch._id]);
    expect(room.last_message.msg).toBe(`editada @${ana.username} #${ch.name}`);
    const sys = await one(`SELECT id FROM messages WHERE room_id = $1 AND t IS NOT NULL LIMIT 1`, [ch._id]);
    if (sys) expect(await replaceMessageText(sys.id, 'x', { id: bot.userId, username: bot.username })).toBeNull();
  });

  it('M1: removeMessageRow de uma raiz com respostas tira extra.jira, meeting e bridge', async () => {
    const bot = await botUser();
    const ch = await channel(A, [bot.username]);
    const root = await sendMessage(ctxOf(bot), { rid: ch._id, msg: 'OPS-1 mudou', jira: snapshot(), meeting: meeting(bot), bridge: bridge() }, { skipCommands: true, trusted: true, integration: true });
    await sendMessage(ctxOf(A), { rid: ch._id, msg: 'resposta', tmid: root._id }, { skipCommands: true });
    await sendMessage(ctxOf(bot), { rid: ch._id, msg: 'thread', tmid: root._id, tshow: true }, { skipCommands: true, trusted: true, integration: true });
    await removeMessageRow(await getMessageRow(root._id));
    const row = await getMessageRow(root._id);
    expect(row.t).toBe('rm');
    expect(row.extra).toEqual({});
    // Sem respostas a linha some, como antes.
    const lone = await sendMessage(ctxOf(bot), { rid: ch._id, msg: 'sozinha', jira: snapshot() }, { skipCommands: true, trusted: true, integration: true });
    await removeMessageRow(await getMessageRow(lone._id));
    expect(await getMessageRow(lone._id)).toBeNull();
  });
});

// ---------- Comandos (§2.7) ----------

describe('Fase 0: comandos', () => {
  it('visible esconde o comando de commands.list e de /help; registerCommand registra; commands.run não muda', async () => {
    const u = await newUser(A);
    const ran: string[] = [];
    registerCommand({
      command: 'teste-oculto',
      params: '[texto]',
      description: 'Comando de teste das integrações',
      visible: async (ctx) => ctx.userId === A.userId,
      run: async (ctx, _room, args) => {
        ran.push(`${ctx.username}:${args}`);
        return { ok: true };
      },
    });
    const listA = await api('GET', 'commands.list', undefined, A);
    expect(listA.commands).toContainEqual({ command: 'teste-oculto', params: '[texto]', description: 'Comando de teste das integrações' });
    expect(listA.total).toBe(listA.commands.length);
    const listU = await api('GET', 'commands.list', undefined, u);
    expect(listU.commands.some((c: any) => c.command === 'teste-oculto')).toBe(false);
    expect(listU.commands.some((c: any) => c.command === 'help')).toBe(true);

    const geral = await api('GET', 'channels.info', { roomName: 'geral' }, A);
    const help = async (auth: Auth) => {
      const ws = connectWs(auth);
      await ws.ready;
      try {
        await api('POST', 'commands.run', { roomId: geral.channel._id, command: 'help' }, auth);
        return (await ws.waitFor((e) => e.type === 'notification' && e.title === 'Comandos disponíveis')).text as string;
      } finally {
        ws.close();
      }
    };
    expect(await help(A)).toContain('/teste-oculto [texto] — Comando de teste das integrações');
    const helpU = await help(u);
    expect(helpU).not.toContain('teste-oculto');
    expect(helpU).toContain('/help');

    // Esconder não é proibir: cada comando confere as próprias regras ao rodar.
    const r = await api('POST', 'commands.run', { roomId: geral.channel._id, command: 'teste-oculto', params: 'oi' }, u);
    expect(r.result).toEqual({ ok: true });
    expect(ran).toEqual([`${u.username}:oi`]);
  });
});

// ---------- Webhooks de saída ----------

describe('webhooks de saída', () => {
  it('webhook de saída recebe o texto da figurinha', async () => {
    // Quem envia não é o usuário da integração (as mensagens dele não disparam o webhook, para evitar laços).
    const u = await newUser(A);
    const ch = await channel(A, [u.username]);
    const out = await api('POST', 'integrations.create', { type: 'webhook-outgoing', name: 'Saída', username: 'admin', event: 'sendMessage', channel: ch._id, urls: [hookUrl] }, A);
    expect(out.success).toBe(true);
    const pack = await api('POST', 'stickers.packs.create', { scope: 'org', name: uniq('Pacote'), status: 'published' }, A);
    expect(pack.pack).toBeTruthy();
    const fd = new FormData();
    fd.append('packId', pack.pack._id);
    fd.append('name', 'Rindo');
    fd.append('emojis', '["😂"]');
    fd.append('file', new Blob([new Uint8Array(webp({ kind: 'vp8l', w: 256, h: 256, seed: 7101 }))], { type: 'application/octet-stream' }), 'rindo.webp');
    const st = await api('POST', 'stickers.create', fd, A);
    expect(st.sticker).toBeTruthy();
    const sent = await api('POST', 'chat.sendSticker', { roomId: ch._id, stickerId: st.sticker._id }, u);
    expect(sent.success).toBe(true);
    const id = sent.message._id;
    let call: any;
    for (let i = 0; i < 60 && !call; i++) {
      call = received.find((x) => x.message_id === id);
      if (!call) await sleep(50);
    }
    expect(call).toBeTruthy();
    expect(call.text).toBe('😂 Figurinha “Rindo”');
    expect(call.text).toBe(stickerPreviewText(sent.message.sticker));
    // Texto comum continua igual.
    const plain = await api('POST', 'chat.sendMessage', { message: { rid: ch._id, msg: 'só texto' } }, u);
    let call2: any;
    for (let i = 0; i < 60 && !call2; i++) {
      call2 = received.find((x) => x.message_id === plain.message._id);
      if (!call2) await sleep(50);
    }
    expect(call2.text).toBe('só texto');
  });
});

// =====================================================================================================================
// Núcleo das integrações (§3): segredos, safeFetch, fila, leases, robôs, efêmeras, contas, OAuth, texto e alertas.
// =====================================================================================================================

const kidOf = (blob: string | null | undefined) => String(blob ?? '').split('.')[1];
const kidOfKey = (key: string) => crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 8);
const jobRow = (id: string | null) => one('SELECT * FROM integration_jobs WHERE id = $1', [id]);
const activityRows = (where: string, params: unknown[]) => pool.query(`SELECT tone, text, detail, integration_id, job_id FROM integration_activity WHERE ${where} ORDER BY created_at, id`, params).then((r) => r.rows);
const ZW = '​';

let kindSeq = 0;
// Cada teste registra o seu tipo de tarefa (provedor jira): nenhuma tarefa de outro teste ou do módulo do Jira roda junto.
function kindFor(handler: JobHandler, o: { concurrency?: number; describe?: (j: JobRow) => string } = {}) {
  const kind = `jira.teste${++kindSeq}`;
  registerJobHandler(kind, handler, { provider: 'jira', ...o });
  return kind;
}

// Resposta do Fastify só com o que startOAuth usa.
function fakeReply(cookie?: string) {
  const headers: Record<string, any> = {};
  const reply: any = {
    request: { headers: cookie ? { cookie } : {} },
    getHeader: (k: string) => headers[k.toLowerCase()],
    header: (k: string, v: unknown) => {
      headers[k.toLowerCase()] = v;
      return reply;
    },
  };
  return { reply, headers };
}
const cookieValue = (setCookie: unknown) => {
  const list = Array.isArray(setCookie) ? setCookie : [String(setCookie ?? '')];
  const c = list.map(String).find((x) => x.startsWith(`${OAUTH_COOKIE}=`)) ?? '';
  return { raw: c, value: c.slice(OAUTH_COOKIE.length + 1).split(';')[0] };
};
const fakeReq = (state: string, nonce?: string) => ({ query: { state }, headers: nonce ? { cookie: `outro=1; ${OAUTH_COOKIE}=${nonce}` } : {} }) as any;

// Proxy http falso: registra cada CONNECT (e o Proxy-Authorization) e responde com o status pedido ou faz o túnel.
async function startProxy(answer: (target: string) => number | { pipeTo: number }) {
  const seen: { target: string; auth: string | null }[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    seen.push({ target: `${req.method} ${req.url}`, auth: (req.headers['proxy-authorization'] as string) ?? null });
    res.writeHead(403);
    res.end();
  });
  server.on('connect', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const target = String(req.url);
    seen.push({ target, auth: (req.headers['proxy-authorization'] as string) ?? null });
    socket.on('error', () => {});
    const a = answer(target);
    if (typeof a === 'number') {
      socket.end(`HTTP/1.1 ${a} ${a === 407 ? 'Proxy Authentication Required' : 'Forbidden'}\r\n${a === 407 ? 'Proxy-Authenticate: Basic realm="empresa"\r\n' : ''}Content-Length: 0\r\n\r\n`);
      return;
    }
    const up = net.connect(a.pipeTo, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    sockets.add(socket).add(up);
    up.on('error', () => socket.destroy());
    up.on('close', () => socket.destroy());
    socket.on('close', () => up.destroy());
  });
  server.on('connection', (s: net.Socket) => sockets.add(s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const close = () => {
    for (const s of sockets) s.destroy();
    return new Promise<void>((r) => server.close(() => r()));
  };
  return { port: (server.address() as net.AddressInfo).port, seen, close };
}

// SMTP falso (sem STARTTLS, sem autenticação): guarda os destinatários de cada mensagem.
async function startSmtp() {
  const mails: { to: string[]; data: string }[] = [];
  const server = net.createServer((s) => {
    let buf = '';
    let inData = false;
    let cur = { to: [] as string[], data: '' };
    s.on('error', () => {});
    s.write('220 smtp.falso ESMTP\r\n');
    s.on('data', (d) => {
      buf += d.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          cur.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          mails.push(cur);
          cur = { to: [], data: '' };
          s.write('250 OK\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') s.write('250-smtp.falso\r\n250 8BITMIME\r\n');
        else if (cmd === 'RCPT') {
          cur.to.push(line.replace(/^RCPT TO:\s*<?([^>]*)>?.*$/i, '$1').toLowerCase());
          s.write('250 OK\r\n');
        } else if (cmd === 'DATA') {
          inData = true;
          s.write('354 Pode mandar\r\n');
        } else if (cmd === 'QUIT') s.end('221 Tchau\r\n');
        else s.write('250 OK\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { port: (server.address() as net.AddressInfo).port, mails, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let f1: FakeServer;
let f2: FakeServer;
beforeAll(async () => {
  f1 = await startFake();
  f2 = await startFake();
  process.env.INTEGRATIONS_ALLOWED_HOSTS = `${f1.host},${f2.host}`;
});
afterAll(async () => {
  await f1?.close();
  await f2?.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- Segredos no banco ----------

describe('Núcleo: segredos no banco', () => {
  it('token do Jira gravado para uma origem é null para outra (bound_to); o valor gravado nunca é o texto puro; a auditoria só leva o id', async () => {
    const token = 'ATATT3x-token-de-teste-1234';
    await setSecret('jira.apiToken', token, A.userId, { boundTo: 'https://explorer.atlassian.net', expiresAt: '2030-01-01T00:00:00.000Z' });
    expect(await getSecret('jira.apiToken', 'https://explorer.atlassian.net')).toBe(token);
    expect(await getSecret('jira.apiToken', 'https://outra.atlassian.net')).toBeNull();
    expect(await getSecret('jira.apiToken')).toBeNull();
    const row = await one('SELECT value, hint, bound_to FROM integration_secrets WHERE id = $1', ['jira.apiToken']);
    expect(row.value).not.toContain('ATATT');
    expect(row.value.startsWith(`v1.${kidOfKey(TEST_KEY)}.`)).toBe(true);
    expect(row).toMatchObject({ hint: '••••1234', bound_to: 'https://explorer.atlassian.net' });
    expect(await secretState('jira.apiToken', 'https://explorer.atlassian.net')).toMatchObject({ set: true, hint: '••••1234', expiresAt: '2030-01-01T00:00:00.000Z' });
    expect(await secretState('jira.apiToken', 'https://outra.atlassian.net')).toEqual({ set: false });
    // O kid da chave fica gravado para as outras instâncias compararem.
    expect(await getState('secrets.kid')).toEqual({ kid: kidOfKey(TEST_KEY) });

    // Copiado para outra linha, não abre: aparece como ilegível.
    await pool.query(`INSERT INTO integration_secrets (id, value, hint) VALUES ('jira.webhookSecret', $1, 'x')`, [row.value]);
    expect(await secretState('jira.webhookSecret')).toMatchObject({ set: true, unreadable: true });
    await expect(getSecret('jira.webhookSecret')).rejects.toMatchObject({ statusCode: 500, errorType: 'error-secret-key' });
    await setSecret('jira.webhookSecret', null, A.userId);
    expect(await secretState('jira.webhookSecret')).toEqual({ set: false });

    const audits = (await pool.query(`SELECT action, target, data FROM audit_log WHERE action LIKE 'integration.secret.%' ORDER BY created_at`)).rows;
    expect(audits.map((a) => [a.action, a.target])).toEqual([
      ['integration.secret.set', { id: 'jira.apiToken' }],
      ['integration.secret.cleared', { id: 'jira.webhookSecret' }],
    ]);
    expect(JSON.stringify(audits)).not.toContain('ATATT');
    expect(JSON.stringify(audits)).not.toContain('v1.');
  });

  it('SECRETS_KEY_PREVIOUS abre os segredos antigos e reencryptAll passa segredos, regras, contas e OAuth para a chave nova', async () => {
    const oldKey = TEST_KEY;
    await setSecret('msteams.clientSecret', 'segredo-do-entra-123456', A.userId);
    const rule = await managedRule('msteams-outgoing', A.userId, A.username);
    await pool.query('UPDATE integrations SET secret = $2 WHERE id = $1', [rule, encryptSecret('https://fluxo.example/gatilho?sig=abc', aadFor.rule(rule))]);
    const u = await newUser(A);
    await saveLinked({ userId: u.userId, provider: 'microsoft', method: 'directory', externalId: `oid-${newId()}`, displayName: 'Ana', email: null, site: null, tokenExpiresAt: null, secretExpiresAt: null, scopes: [], meta: {}, access: 'ms-acesso', refresh: 'ms-renovacao' });
    const { reply } = fakeReply();
    const { state } = await startOAuth(reply, { purpose: 'msteams-service', userId: A.userId, redirectUri: 'http://localhost:3000/integrations/msteams/callback', returnTo: '/admin/integrations/teams/conexao', codeVerifier: 'verificador-pkce-de-teste' });

    TEST_KEY = crypto.randomBytes(32).toString('base64');
    process.env.SECRETS_KEY = TEST_KEY;
    process.env.SECRETS_KEY_PREVIOUS = oldKey;
    reloadSecretsKey();
    try {
      // A instância com a chave nova passa a ser a referência (a anterior bate com o kid gravado).
      expect(await checkSharedKey()).toEqual({ ok: true });
      expect(await getState('secrets.kid')).toEqual({ kid: kidOfKey(TEST_KEY) });
      expect(await getSecret('msteams.clientSecret')).toBe('segredo-do-entra-123456');
      const { count } = await reencryptAll();
      expect(count).toBeGreaterThanOrEqual(6);
      const blobs = [
        ...(await pool.query('SELECT value AS b FROM integration_secrets')).rows,
        ...(await pool.query('SELECT secret AS b FROM integrations WHERE id = $1', [rule])).rows,
        ...(await pool.query('SELECT access_token AS b FROM linked_accounts WHERE user_id = $1 UNION ALL SELECT refresh_token FROM linked_accounts WHERE user_id = $1', [u.userId])).rows,
        ...(await pool.query('SELECT code_verifier AS b FROM integration_oauth_states WHERE code_verifier IS NOT NULL')).rows,
      ].map((r) => r.b);
      expect(blobs.length).toBeGreaterThanOrEqual(6);
      expect(blobs.every((b) => kidOf(b) === kidOfKey(TEST_KEY))).toBe(true);
    } finally {
      delete process.env.SECRETS_KEY_PREVIOUS;
      reloadSecretsKey();
    }
    // Sem a anterior, tudo continua abrindo.
    expect(await getSecret('msteams.clientSecret')).toBe('segredo-do-entra-123456');
    expect(await getSecret('jira.apiToken', 'https://explorer.atlassian.net')).toBe('ATATT3x-token-de-teste-1234');
    expect(await linkedSecrets(u.userId, 'microsoft')).toEqual({ access: 'ms-acesso', refresh: 'ms-renovacao' });
    const nonce = cookieValue(reply.getHeader('set-cookie')).value;
    expect(await finishOAuth(fakeReq(state, nonce), 'msteams-service')).toMatchObject({ codeVerifier: 'verificador-pkce-de-teste' });
    await pool.query('DELETE FROM integrations WHERE id = $1', [rule]);
    await setSecret('msteams.clientSecret', null, A.userId);
  });

  it('sem chave: salvar um segredo responde 500 error-secret-key-missing e as integrações ficam paradas (overview diz source none, não chave diferente)', async () => {
    delete process.env.SECRETS_KEY;
    reloadSecretsKey();
    try {
      expect(integrationsPaused()).toBe(true);
      await expect(setSecret('jira.webhookToken', 'valor', A.userId)).rejects.toMatchObject({
        statusCode: 500,
        errorType: 'error-secret-key-missing',
        message: 'O servidor não tem a chave de segredos das integrações. Defina SECRETS_KEY_FILE com o caminho completo de um arquivo de chave e reinicie o serviço.',
      });
      expect(await one(`SELECT 1 FROM integration_secrets WHERE id = 'jira.webhookToken'`)).toBeNull();
      const ov = await api('GET', 'integrations.overview', undefined, A);
      expect(ov).toMatchObject({ paused: false, secretsKey: { source: 'none', created: false } });
    } finally {
      process.env.SECRETS_KEY = TEST_KEY;
      reloadSecretsKey();
    }
    expect(integrationsPaused()).toBe(false);
  });

  it('M3: um kid diferente do gravado em secrets.kid pausa as integrações (nenhuma tarefa reservada, ganchos parados, webhook 503) e levanta secrets.key', async () => {
    await updateSettings({ Jira_Enabled: true, Jira_Events_Mode: 'webhook' });
    const ran: string[] = [];
    const kind = kindFor(async (j) => void ran.push(j.id));
    const hookCalls: number[] = [];
    const hook = wrapHook<number>('jira', 'teste pausado', async (n) => void hookCalls.push(n));
    const id = await enqueue(kind, {});
    const before = await getState('secrets.kid');
    const logs: string[] = [];
    try {
      await setState('secrets.kid', { kid: 'ffffffff' });
      await checkSecretsKey((m) => logs.push(m));
      expect(keyMismatch()).toBe(true);
      expect(integrationsPaused()).toBe(true);
      expect(logs).toEqual([`[integrações] ${KEY_MISMATCH}`]);

      expect(await drainJobs({ kinds: [kind] })).toBe(0);
      expect((await jobRow(id)).status).toBe('queued');
      await hook(1);
      expect(hookCalls).toEqual([]);
      const res = await fetch(urlOf('/hooks/jira/qualquer-token'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(503);
      expect(() => encryptSecret('x', 'y')).toThrow(expect.objectContaining({ errorType: 'error-secret-key', message: KEY_MISMATCH }));

      const alert = await getState<any>('alert:secrets.key');
      expect(alert).toMatchObject({ tone: 'err', to: 'admins', href: '/admin/integrations', text: `As integrações estão paradas: ${KEY_MISMATCH}` });
      const alerts = await api('GET', 'integrations.alerts', undefined, A);
      expect(alerts.alerts.map((a: any) => a.key)).toContain('secrets.key');
      expect((await api('GET', 'integrations.overview', undefined, A)).paused).toBe(true);
    } finally {
      await setState('secrets.kid', before);
      await checkSecretsKey();
    }
    expect(integrationsPaused()).toBe(false);
    expect(await getState('alert:secrets.key')).toBeNull();
    expect(await drainJobs({ kinds: [kind] })).toBe(1);
    expect(ran).toEqual([id]);
    await hook(2);
    expect(hookCalls).toEqual([2]);
    await updateSettings({ Jira_Enabled: false, Jira_Events_Mode: 'polling' });
  });
});

// ---------- safeFetch ----------

describe('Núcleo: safeFetch', () => {
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return e instanceof SafeFetchError ? e.code : `outro: ${(e as Error).message}`;
    }
  };

  it('fora dos fornecedores e da lista: error-url-not-allowed; http só liberado; usuário na URL e portas estranhas recusados', async () => {
    const notAllowed = [
      'https://evil.example/x',
      'http://explorer.atlassian.net/rest/api/3/myself',
      'https://usuario:senha@explorer.atlassian.net/',
      'https://explorer.atlassian.net:8443/',
      'https://atlassian.net/',
      'https://explorer.atlassian.net.evil.example/',
      'ftp://explorer.atlassian.net/',
      'https://login.microsoftonline.com.evil.example/',
    ];
    for (const u of notAllowed) expect(await code(safeFetch(u)), u).toBe('error-url-not-allowed');
    const e = await safeFetch('https://evil.example/').catch((x) => x);
    expect(e.message).toBe(SAFE_FETCH_TEXT['error-url-not-allowed']);
    // Fornecedores conhecidos passam na conferência da URL.
    for (const u of ['https://explorer.atlassian.net/rest/api/3/myself', 'https://api.atlassian.com/oauth/token/accessible-resources', 'https://graph.microsoft.com/v1.0/me', 'https://prod-01.environment.api.powerplatform.com/x']) {
      expect(checkOutboundUrl(u).toString()).toBe(u);
    }
    // http em host liberado funciona; o mesmo host em outra porta não.
    f1.on('GET', '/ping', () => ({ body: { ok: true } }));
    const r = await safeFetch(`${f1.url}/ping`);
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(await code(safeFetch('http://127.0.0.1:9/ping'))).toBe('error-url-internal');
  });

  it('127.0.0.1, 10.x, 169.254.169.254 e localhost recusados; um nome de fornecedor que resolve para a rede interna também (error-url-internal)', async () => {
    for (const u of ['https://127.0.0.1/', 'https://10.1.2.3/', 'http://169.254.169.254/latest/meta-data', 'https://localhost/', 'https://[::1]/', 'https://192.168.0.10/']) {
      expect(await code(safeFetch(u)), u).toBe('error-url-internal');
    }
    const real = dns.lookup;
    const lookups: string[] = [];
    vi.spyOn(dns, 'lookup').mockImplementation(((host: string, opts: any, cb: any) => {
      lookups.push(host);
      const address = host === 'rebind.atlassian.net' ? '10.0.0.8' : host === 'publico.atlassian.net' ? '93.184.216.34' : null;
      if (!address) return (real as any)(host, opts, cb);
      if (opts?.all) cb(null, [{ address, family: 4 }]);
      else cb(null, address, 4);
    }) as any);
    expect(await code(safeFetch('https://rebind.atlassian.net/rest/api/3/myself'))).toBe('error-url-internal');
    // Em teste, um fornecedor de verdade nunca é alcançado: o endereço público é recusado antes de conectar.
    const e = await safeFetch('https://publico.atlassian.net/rest/api/3/myself').catch((x) => x);
    expect(e).toMatchObject({ code: 'error-network' });
    expect(e.message).toContain('Em teste, o chat não chama o Jira nem a Microsoft de verdade');
    expect(lookups).toEqual(['rebind.atlassian.net', 'publico.atlassian.net']);
  });

  it('3xx não é seguido por padrão; com redirects o destino é conferido de novo e Authorization não vai para outro host', async () => {
    f1.on('GET', '/r1', () => ({ status: 302, headers: { location: `${f2.url}/destino` } }));
    f1.on('GET', '/r2', () => ({ status: 302, headers: { location: '/destino-local' } }));
    f1.on('GET', '/r3', () => ({ status: 301, headers: { location: 'https://evil.example/' } }));
    f1.on('GET', '/r4', () => ({ status: 307, headers: { location: 'http://169.254.169.254/latest/meta-data' } }));
    f1.on('GET', '/r5', () => ({ status: 302, headers: { location: `${f1.url}/r1` } }));
    f1.on('GET', '/destino-local', (req) => ({ body: { auth: req.headers.authorization ?? null } }));
    f2.on('GET', '/destino', (req) => ({ body: { auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null } }));
    const headers = { authorization: 'Bearer segredo-do-teste', cookie: 'a=1' };

    const plain = await safeFetch(`${f1.url}/r1`, { headers });
    expect(plain.status).toBe(302);
    expect(f2.calls.filter((c) => c.path === '/destino')).toHaveLength(0);

    const other = await safeFetch(`${f1.url}/r1`, { headers, redirects: 1 });
    expect(other.status).toBe(200);
    expect(other.url).toBe(`${f2.url}/destino`);
    expect(other.json()).toEqual({ auth: null, cookie: null });
    const same = await safeFetch(`${f1.url}/r2`, { headers, redirects: 1 });
    expect(same.json()).toEqual({ auth: 'Bearer segredo-do-teste' });
    expect(await code(safeFetch(`${f1.url}/r3`, { redirects: 2 }))).toBe('error-url-not-allowed');
    expect(await code(safeFetch(`${f1.url}/r4`, { redirects: 2 }))).toBe('error-url-internal');
    expect(await code(safeFetch(`${f1.url}/r5`, { redirects: 1 }))).toBe('error-redirect');
  });

  it('maxBytes e tempo limite', async () => {
    f1.on('GET', '/grande', () => ({ body: 'x'.repeat(5000) }));
    f1.on('GET', '/lento', () => ({ body: { ok: true }, delayMs: 1500 }));
    expect(await code(safeFetch(`${f1.url}/grande`, { maxBytes: 1000 }))).toBe('error-too-large');
    expect((await safeFetch(`${f1.url}/grande`, { maxBytes: 6000 })).body.length).toBe(5000);
    const t0 = Date.now();
    const e = await safeFetch(`${f1.url}/lento`, { timeoutMs: 200 }).catch((x) => x);
    expect(e).toMatchObject({ code: 'error-timeout', message: 'O servidor demorou demais para responder.' });
    expect(Date.now() - t0).toBeLessThan(1400);
  });

  it('H6: com proxy, o fornecedor vai como CONNECT host:443 pelo nome, sem consulta local; Basic no Proxy-Authorization e nunca nos textos; 407 → error-proxy-auth', async () => {
    const answers: Record<string, number> = { 'explorer.atlassian.net:443': 407, 'graph.microsoft.com:443': 403 };
    const proxy = await startProxy((t) => answers[t] ?? 403);
    const lookups: string[] = [];
    const real = dns.lookup;
    vi.spyOn(dns, 'lookup').mockImplementation(((host: string, opts: any, cb: any) => {
      lookups.push(host);
      return (real as any)(host, opts, cb);
    }) as any);
    process.env.INTEGRATIONS_PROXY = `http://proxy.user:s3nh4%40forte@127.0.0.1:${proxy.port}`;
    try {
      const e407 = await safeFetch('https://explorer.atlassian.net/rest/api/3/myself', { headers: { authorization: 'Basic dGVzdGU=' } }).catch((x) => x);
      expect(e407).toMatchObject({ code: 'error-proxy-auth', message: SAFE_FETCH_TEXT['error-proxy-auth'] });
      const e403 = await safeFetch('https://graph.microsoft.com/v1.0/me').catch((x) => x);
      expect(e403).toMatchObject({
        code: 'error-proxy',
        message: 'O proxy recusou a conexão com graph.microsoft.com (HTTP 403). Peça para liberar graph.microsoft.com no proxy.',
      });
      expect(proxy.seen).toEqual([
        { target: 'explorer.atlassian.net:443', auth: `Basic ${Buffer.from('proxy.user:s3nh4@forte').toString('base64')}` },
        { target: 'graph.microsoft.com:443', auth: `Basic ${Buffer.from('proxy.user:s3nh4@forte').toString('base64')}` },
      ]);
      expect(lookups).toEqual([]);
      // Hosts liberados não passam pelo proxy (a não ser com INTEGRATIONS_PROXY_FOR_ALLOWED=1).
      f1.on('GET', '/direto', () => ({ body: { ok: 1 } }));
      expect((await safeFetch(`${f1.url}/direto`)).status).toBe(200);
      expect(proxy.seen).toHaveLength(2);
      // Proxy fora do ar: o texto mostra o proxy sem usuário e senha.
      const closed = await startProxy(() => 403);
      await closed.close();
      process.env.INTEGRATIONS_PROXY = `http://proxy.user:s3nh4%40forte@127.0.0.1:${closed.port}`;
      const down = await safeFetch('https://explorer.atlassian.net/').catch((x) => x);
      expect(down).toMatchObject({ code: 'error-proxy', message: `Não foi possível falar com o proxy http://127.0.0.1:${closed.port} (ECONNREFUSED).` });
      for (const m of [e407.message, e403.message, down.message]) {
        expect(m).not.toContain('s3nh4');
        expect(m).not.toContain(Buffer.from('proxy.user:s3nh4@forte').toString('base64'));
      }
      process.env.INTEGRATIONS_PROXY = 'socks5://127.0.0.1:1080';
      expect(await safeFetch('https://explorer.atlassian.net/').catch((x) => x)).toMatchObject({ code: 'error-proxy', message: 'O proxy precisa ser informado como http://proxy:porta.' });
    } finally {
      delete process.env.INTEGRATIONS_PROXY;
      await proxy.close();
    }
  });

  const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
  it.skipIf(!hasOpenssl)('H6: com NODE_USE_ENV_PROXY=1 o agente das integrações não é embrulhado de novo pelo proxy do ambiente (processo à parte)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wescc-h6-'));
    try {
      const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'k.pem', '-out', 'c.pem', '-days', '2', '-subj', '/CN=explorer.atlassian.net', '-addext', 'subjectAltName=DNS:explorer.atlassian.net'], { cwd: dir, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      const got: { path: string; host: string; auth: string | null }[] = [];
      const vendor = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
        got.push({ path: String(req.url), host: String(req.headers.host), auth: (req.headers.authorization as string) ?? null });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ accountId: '5b10ac8d82e05b22cc7d4ef5' }));
      });
      await new Promise<void>((ok) => vendor.listen(0, '127.0.0.1', () => ok()));
      const vendorPort = (vendor.address() as net.AddressInfo).port;
      const intProxy = await startProxy((t) => (t === 'explorer.atlassian.net:443' ? { pipeTo: vendorPort } : 403));
      const envProxy = await startProxy(() => 403);
      const script = path.join(dir, 'filho.mts');
      fs.writeFileSync(
        script,
        `import https from 'node:https';
import { safeFetch } from ${JSON.stringify(path.resolve(import.meta.dirname, '../src/lib/safeFetch.ts'))};
const out: Record<string, unknown> = {};
try {
  const r = await safeFetch('https://explorer.atlassian.net/rest/api/3/myself', { headers: { authorization: 'Basic dGVzdGU=' } });
  out.status = r.status;
  out.body = r.json();
} catch (e) {
  out.error = String((e as any).code) + ': ' + (e as Error).message;
}
out.control = await new Promise((done) => {
  const q = https.get('https://controle.example/', (res) => done('status ' + res.statusCode));
  q.on('error', (e: any) => done('erro ' + (e.code ?? e.message)));
});
console.log(JSON.stringify(out));
process.exit(0);
`,
      );
      const env: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(process.env)) if (!/proxy/i.test(k)) env[k] = v;
      Object.assign(env, {
        NODE_ENV: 'test',
        NODE_USE_ENV_PROXY: '1',
        HTTPS_PROXY: `http://127.0.0.1:${envProxy.port}`,
        HTTP_PROXY: `http://127.0.0.1:${envProxy.port}`,
        NO_PROXY: '',
        INTEGRATIONS_PROXY: `http://proxy.user:s3nh4@127.0.0.1:${intProxy.port}`,
        NODE_EXTRA_CA_CERTS: path.join(dir, 'c.pem'),
        LOG_LEVEL: 'silent',
      });
      const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: path.resolve(import.meta.dirname, '..'), env });
      const killer = setTimeout(() => child.kill('SIGKILL'), 40_000);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      const exit = await new Promise<number | null>((ok) => child.on('exit', ok));
      clearTimeout(killer);
      vendor.closeAllConnections();
      await Promise.all([intProxy.close(), envProxy.close(), new Promise<void>((ok) => vendor.close(() => ok()))]);
      expect(exit, stderr).toBe(0);
      const out = JSON.parse(stdout.trim().split('\n').pop()!);
      expect(out.status, JSON.stringify(out)).toBe(200);
      expect(out.body).toEqual({ accountId: '5b10ac8d82e05b22cc7d4ef5' });
      expect(intProxy.seen).toEqual([{ target: 'explorer.atlassian.net:443', auth: `Basic ${Buffer.from('proxy.user:s3nh4').toString('base64')}` }]);
      expect(got).toEqual([{ path: '/rest/api/3/myself', host: 'explorer.atlassian.net', auth: 'Basic dGVzdGU=' }]);
      // O resto do processo usa o proxy do ambiente; as integrações não passaram por ele.
      expect(envProxy.seen.map((s) => s.target)).toEqual(['controle.example:443']);
      expect(String(out.control)).toMatch(/^erro /);
      expect(stdout + stderr).not.toContain('s3nh4');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------- Fila de tarefas ----------

describe('Núcleo: fila de tarefas', () => {
  beforeAll(() => updateSettings({ Jira_Enabled: true }));
  afterAll(() => updateSettings({ Jira_Enabled: false }));

  it('dedupe; sucesso; claimPost e releasePost', async () => {
    const ran: unknown[] = [];
    const kind = kindFor(async (j) => void ran.push(j.payload));
    const id = await enqueue(kind, { n: 1 }, { dedupeKey: `entrega:${kind}` });
    expect(id).toBeTruthy();
    expect(await enqueue(kind, { n: 2 }, { dedupeKey: `entrega:${kind}` })).toBeNull();
    expect(await drainJobs({ kinds: [kind] })).toBe(1);
    expect(ran).toEqual([{ n: 1 }]);
    expect(await getJob(id!)).toMatchObject({ status: 'done', attempts: 1, provider: 'jira', lastError: null, kind });
    expect(await drainJobs({ kinds: [kind] })).toBe(0);

    const key = `post:${newId()}`;
    expect(await claimPost(key)).toBe(true);
    expect(await claimPost(key)).toBe(false);
    await releasePost(key);
    expect(await claimPost(key)).toBe(true);
  });

  it('RetryLater sem e com afterMs (run_at no intervalo) e com countAttempt = false', async () => {
    let mode: 'plain' | 'after' | 'free' = 'plain';
    const kind = kindFor(async () => {
      if (mode === 'plain') throw new RetryLater('O Jira pediu para esperar.');
      if (mode === 'after') throw new RetryLater('Limite de chamadas do Jira.', 120_000);
      throw new RetryLater('Sem vaga no envio agora.', 5_000, false);
    });
    const id = await enqueue(kind, {});
    const waitOf = async (t0: number) => new Date((await jobRow(id)).run_at).getTime() - t0;

    let t0 = Date.now();
    await drainJobs({ kinds: [kind] });
    expect(await jobRow(id)).toMatchObject({ status: 'queued', attempts: 1, last_error: 'O Jira pediu para esperar.', locked_by: null });
    let wait = await waitOf(t0);
    expect(wait).toBeGreaterThanOrEqual(30_000 * 0.7 - 1500);
    expect(wait).toBeLessThanOrEqual(30_000 * 1.3 + 1500);

    mode = 'after';
    await pool.query('UPDATE integration_jobs SET run_at = now() WHERE id = $1', [id]);
    t0 = Date.now();
    await drainJobs({ kinds: [kind] });
    expect(await jobRow(id)).toMatchObject({ status: 'queued', attempts: 2, last_error: 'Limite de chamadas do Jira.' });
    wait = await waitOf(t0);
    expect(wait).toBeGreaterThan(118_000);
    expect(wait).toBeLessThan(122_000);

    mode = 'free';
    await pool.query('UPDATE integration_jobs SET run_at = now() WHERE id = $1', [id]);
    t0 = Date.now();
    await drainJobs({ kinds: [kind] });
    // A tentativa foi devolvida.
    expect(await jobRow(id)).toMatchObject({ status: 'queued', attempts: 2, last_error: 'Sem vaga no envio agora.' });
    wait = await waitOf(t0);
    expect(wait).toBeGreaterThan(3_500);
    expect(wait).toBeLessThan(6_500);
    await pool.query('DELETE FROM integration_jobs WHERE id = $1', [id]);
  });

  it('tentativas esgotadas → dead com atividade, erro na regra e alerta; PermanentError morre na primeira', async () => {
    const rule = await managedRule('jira-events', A.userId, A.username);
    let fail: Error = new Error('O Jira respondeu 500.');
    const kind = kindFor(
      async () => {
        throw fail;
      },
      { describe: (j) => `Aviso de ${j.payload.key}` },
    );
    const id = await enqueue(kind, { key: 'OPS-7' }, { integrationId: rule, maxAttempts: 2 });
    await drainJobs({ kinds: [kind] });
    expect(await jobRow(id)).toMatchObject({ status: 'queued', attempts: 1 });
    await pool.query('UPDATE integration_jobs SET run_at = now() WHERE id = $1', [id]);
    await drainJobs({ kinds: [kind] });
    expect(await jobRow(id)).toMatchObject({ status: 'dead', attempts: 2, last_error: 'O Jira respondeu 500.' });
    expect(await activityRows('job_id = $1', [id])).toEqual([
      { tone: 'err', text: 'Aviso de OPS-7: O Jira respondeu 500.', detail: `${kind} · tentativa 2 de 2`, integration_id: rule, job_id: id },
    ]);
    expect(await one('SELECT last_error, last_error_at IS NOT NULL AS has_at FROM integrations WHERE id = $1', [rule])).toEqual({ last_error: 'O Jira respondeu 500.', has_at: true });
    expect(await getState<any>(`alert:jira.rule:${rule}`)).toMatchObject({
      tone: 'err',
      href: '/admin/integrations/jira/avisos',
      to: 'managers',
      text: 'A regra “Regra jira-events” do Jira não conseguiu publicar: O Jira respondeu 500.',
    });
    const act = await api('GET', 'integrations.activity', { provider: 'jira', integrationId: rule }, A);
    expect(act.activity).toEqual([expect.objectContaining({ jobId: id, canRetry: true, integrationName: 'Regra jira-events', tone: 'err' })]);

    fail = new PermanentError('A sala foi arquivada.');
    const p = await enqueue(kind, { key: 'OPS-8' }, { integrationId: rule });
    await drainJobs({ kinds: [kind] });
    expect(await jobRow(p)).toMatchObject({ status: 'dead', attempts: 1, last_error: 'A sala foi arquivada.' });
    await clearAlert(`jira.rule:${rule}`);
    await pool.query('DELETE FROM integrations WHERE id = $1', [rule]);
  });

  it('M5: classifyError torna permanente um ApiError 403 e tenta de novo um tempo esgotado do pool', async () => {
    const p = classifyError(new ApiError(403, 'error-not-allowed', 'Sem permissão para publicar.'), 'Não foi possível publicar');
    expect(p).toBeInstanceOf(PermanentError);
    expect(p.message).toBe('Não foi possível publicar: Sem permissão para publicar.');
    for (const status of [400, 404]) expect(classifyError(new ApiError(status, 'x', 'y'), 'z')).toBeInstanceOf(PermanentError);
    const t = classifyError(new Error('timeout exceeded when trying to connect'), 'Não foi possível publicar');
    expect(t).toBeInstanceOf(RetryLater);
    expect(t.message).toBe('Não foi possível publicar: timeout exceeded when trying to connect');
    expect(classifyError(new ApiError(500, 'error-db', 'Banco fora do ar.'), 'x')).toBeInstanceOf(RetryLater);
    expect(classifyError(new SafeFetchError('Endereço não permitido.', 'error-url-not-allowed'), 'x')).toBeInstanceOf(PermanentError);
    expect(classifyError(new SafeFetchError('Demorou.', 'error-timeout'), 'x')).toBeInstanceOf(RetryLater);
    const same = new RetryLater('já classificado', 1000);
    expect(classifyError(same, 'x')).toBe(same);
    // O texto já contém a mensagem: não repete.
    expect(classifyError(new Error('Sala arquivada.'), 'Sala arquivada.').message).toBe('Sala arquivada.');

    // Na fila: o 403 morre na primeira tentativa, o tempo esgotado volta para a fila.
    let err: Error = new ApiError(403, 'error-not-allowed', 'Sem permissão para publicar.');
    const kind = kindFor(async () => {
      throw err;
    });
    const a = await enqueue(kind, {});
    await drainJobs({ kinds: [kind] });
    expect(await jobRow(a)).toMatchObject({ status: 'dead', attempts: 1, last_error: 'Sem permissão para publicar.' });
    err = new Error('timeout exceeded when trying to connect');
    const b = await enqueue(kind, {});
    await drainJobs({ kinds: [kind] });
    expect(await jobRow(b)).toMatchObject({ status: 'queued', attempts: 1, last_error: 'timeout exceeded when trying to connect' });
    await pool.query('DELETE FROM integration_jobs WHERE id = ANY($1)', [[a, b]]);
  });

  it('M6: uma tarefa em nova tentativa segura as mais novas do mesmo grupo e não as de outros grupos', async () => {
    const order: string[] = [];
    let failFirst = true;
    const kind = kindFor(async (j) => {
      if (j.payload.first && failFirst) throw new RetryLater('ainda não', 60_000);
      order.push(`${j.groupKey === g ? 'g' : 'h'}${j.payload.n}`);
    });
    const g = `jira:regra:${newId()}`;
    const h = `jira:regra:${newId()}`;
    const j1 = await enqueue(kind, { n: 1, first: true }, { groupKey: g });
    const j2 = await enqueue(kind, { n: 2 }, { groupKey: g });
    await enqueue(kind, { n: 3 }, { groupKey: h });
    await drainJobs({ kinds: [kind] });
    expect(order).toEqual(['h3']);
    expect(await jobRow(j1)).toMatchObject({ status: 'queued', attempts: 1 });
    expect(await jobRow(j2)).toMatchObject({ status: 'queued', attempts: 0 });
    // Mesmo vencida, a mais nova espera a mais antiga do grupo.
    await pool.query('UPDATE integration_jobs SET run_at = now() - interval \'1 hour\' WHERE id = $1', [j2]);
    await drainJobs({ kinds: [kind] });
    expect(order).toEqual(['h3']);
    failFirst = false;
    await pool.query('UPDATE integration_jobs SET run_at = now() WHERE id = $1', [j1]);
    await drainJobs({ kinds: [kind] });
    expect(order).toEqual(['h3', 'g1', 'g2']);
  });

  it('M3: dois workers em paralelo nunca rodam duas tarefas do mesmo grupo, e a ordem de cada grupo é mantida', async () => {
    const active = new Map<string, number>();
    const seenOrder = new Map<string, number[]>();
    let maxPerGroup = 0;
    let running = 0;
    let maxTotal = 0;
    const kind = kindFor(
      async (j) => {
        const g = j.groupKey!;
        active.set(g, (active.get(g) ?? 0) + 1);
        running++;
        maxPerGroup = Math.max(maxPerGroup, active.get(g)!);
        maxTotal = Math.max(maxTotal, running);
        await sleep(25);
        if (!seenOrder.has(g)) seenOrder.set(g, []);
        seenOrder.get(g)!.push(j.payload.n);
        running--;
        active.set(g, active.get(g)! - 1);
      },
      { concurrency: 4 },
    );
    const groups = [newId(), newId(), newId()].map((x) => `grupo:${x}`);
    for (let n = 0; n < 6; n++) for (const g of groups) await enqueue(kind, { n }, { groupKey: g });
    const [a, b] = await Promise.all([drainJobs({ kinds: [kind] }), drainJobs({ kinds: [kind] })]);
    expect(a + b).toBe(18);
    expect(maxPerGroup).toBe(1);
    expect(maxTotal).toBeGreaterThan(1);
    for (const g of groups) expect(seenOrder.get(g)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('collapseQueued junta a rajada do grupo num resumo; abaixo de minCount nada muda', async () => {
    const g = `resumo:${newId()}`;
    const results: (JobRow[] | null)[] = [];
    const kind = kindFor(async (j) => void results.push(await collapseQueued(j.groupKey!, j.kind, { includeJobId: j.id, minCount: 3 })));
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) ids.push((await enqueue(kind, { n }, { groupKey: g }))!);
    expect(await drainJobs({ kinds: [kind] })).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]!.map((r) => r.payload.n)).toEqual([0, 1, 2, 3, 4]);
    const rows = (await pool.query('SELECT id, status, locked_by FROM integration_jobs WHERE id = ANY($1) ORDER BY created_at', [ids])).rows;
    expect(rows.map((r) => r.status)).toEqual(['merged', 'merged', 'merged', 'merged', 'merged']);
    expect(rows.slice(1).every((r) => r.locked_by === `merged:${ids[0]}`)).toBe(true);

    const small = `resumo:${newId()}`;
    const s1 = await enqueue(kind, { n: 1 }, { groupKey: small });
    const s2 = await enqueue(kind, { n: 2 }, { groupKey: small });
    results.length = 0;
    expect(await drainJobs({ kinds: [kind] })).toBe(2);
    expect(results).toEqual([null, null]);
    expect((await jobRow(s1)).status).toBe('done');
    expect((await jobRow(s2)).status).toBe('done');

    // Fora de um handler (sem includeJobId) também junta.
    const loose = `resumo:${newId()}`;
    for (let n = 0; n < 3; n++) await enqueue(`${kind}.solto`, { n }, { groupKey: loose });
    const got = await collapseQueued(loose, `${kind}.solto`, { minCount: 2 });
    expect(got?.map((r) => r.payload.n)).toEqual([0, 1, 2]);
    expect(await collapseQueued(loose, `${kind}.solto`, { minCount: 1 })).toBeNull();
  });

  it('retryJob, retryDead e a API (só quem gerencia o Jira); auditoria integration.job.retried', async () => {
    const rule = await managedRule('jira-events', A.userId, A.username);
    let ok = false;
    const kind = kindFor(async () => {
      if (!ok) throw new PermanentError('Falhou de vez.');
    });
    const a1 = (await enqueue(kind, {}, { integrationId: rule }))!;
    const a2 = (await enqueue(kind, {}, { integrationId: rule }))!;
    await drainJobs({ kinds: [kind] });
    expect((await jobRow(a1)).status).toBe('dead');
    expect((await jobRow(a2)).status).toBe('dead');

    const u = await newUser(A);
    expect(await api('POST', 'integrations.jobs.retry', { jobId: a1 }, u)).toMatchObject({ status: 403 });
    expect(await api('POST', 'integrations.jobs.retryAll', { integrationId: rule }, u)).toMatchObject({ status: 403 });
    expect((await api('POST', 'integrations.jobs.retry', { jobId: a1 }, A)).success).toBe(true);
    expect(await jobRow(a1)).toMatchObject({ status: 'queued', attempts: 0, last_error: null, finished_at: null });
    const again = await api('POST', 'integrations.jobs.retry', { jobId: a1 }, A);
    expect(again).toMatchObject({ status: 404, errorType: 'error-not-found', error: 'Esta tarefa já foi reenviada ou não existe mais.' });
    await expect(retryJob(a1)).rejects.toMatchObject({ statusCode: 404 });
    expect(await api('POST', 'integrations.jobs.retryAll', { integrationId: rule }, A)).toMatchObject({ success: true, count: 1 });
    expect(await retryDead(rule)).toBe(0);
    const audits = (await pool.query(`SELECT target, data FROM audit_log WHERE action = 'integration.job.retried' AND (target->>'jobId' = $1 OR target->>'integrationId' = $2)`, [a1, rule])).rows;
    expect(audits).toHaveLength(2);
    ok = true;
    expect(await drainJobs({ kinds: [kind] })).toBe(2);
    const act = await api('GET', 'integrations.activity', { provider: 'jira', integrationId: rule }, A);
    expect(act.activity.every((x: any) => x.canRetry === false)).toBe(true);
    await clearAlert(`jira.rule:${rule}`);
    await pool.query('DELETE FROM integrations WHERE id = $1', [rule]);
  });

  it('sweepJobs devolve à fila as que travaram em running e apaga o que venceu', async () => {
    const k = 'jira.varredura';
    const ins = (id: string, status: string, extra: string) =>
      pool.query(`INSERT INTO integration_jobs (id, kind, status, locked_by, locked_at, finished_at) VALUES ($1, $2, $3, ${extra})`, [id, k, status]);
    const ids = Object.fromEntries(['travada', 'rodando', 'feitaVelha', 'feitaNova', 'juntadaVelha', 'mortaVelha', 'mortaNova'].map((n) => [n, `${n}-${newId()}`]));
    await ins(ids.travada, 'running', `'x', now() - interval '10 minutes', NULL`);
    await ins(ids.rodando, 'running', `'x', now() - interval '1 minute', NULL`);
    await ins(ids.feitaVelha, 'done', `NULL, NULL, now() - interval '2 days'`);
    await ins(ids.feitaNova, 'done', `NULL, NULL, now() - interval '1 hour'`);
    await ins(ids.juntadaVelha, 'merged', `NULL, NULL, now() - interval '2 days'`);
    await ins(ids.mortaVelha, 'dead', `NULL, NULL, now() - interval '15 days'`);
    await ins(ids.mortaNova, 'dead', `NULL, NULL, now() - interval '2 days'`);
    await pool.query(`INSERT INTO integration_seen (scope, key, created_at) VALUES ('teste', 'velha', now() - interval '8 days'), ('teste', 'nova', now())`);
    await pool.query(`INSERT INTO integration_activity (id, provider, tone, text, created_at) VALUES ($1, 'jira', 'info', 'antiga', now() - interval '31 days')`, [newId()]);
    await pool.query(
      `INSERT INTO integration_oauth_states (state_hash, purpose, user_id, browser_hash, redirect_uri, expires_at) VALUES ('vencido', 'jira-user', $1, 'x', 'http://x', now() - interval '1 minute')`,
      [A.userId],
    );
    await sweepJobs();
    const rows = Object.fromEntries((await pool.query('SELECT id, status, locked_by FROM integration_jobs WHERE kind = $1', [k])).rows.map((r) => [r.id, r]));
    expect(rows[ids.travada]).toMatchObject({ status: 'queued', locked_by: null });
    expect(rows[ids.rodando]).toMatchObject({ status: 'running' });
    expect(Object.keys(rows).sort()).toEqual([ids.travada, ids.rodando, ids.feitaNova, ids.mortaNova].sort());
    expect((await pool.query(`SELECT key FROM integration_seen WHERE scope = 'teste'`)).rows).toEqual([{ key: 'nova' }]);
    expect(await one(`SELECT 1 FROM integration_activity WHERE text = 'antiga'`)).toBeNull();
    expect(await one(`SELECT 1 FROM integration_oauth_states WHERE state_hash = 'vencido'`)).toBeNull();
    await pool.query('DELETE FROM integration_jobs WHERE kind = $1', [k]);
  });

  it('fornecedor desligado: nada é reservado; ao religar, avisos guardados há mais de 6 horas viram dead', async () => {
    await updateSettings({ Jira_Enabled: false });
    const ran: string[] = [];
    const kind = kindFor(async (j) => void ran.push(j.id));
    const id = await enqueue(kind, {});
    expect(await drainJobs({ kinds: [kind] })).toBe(0);
    expect((await jobRow(id)).status).toBe('queued');
    const rule = await managedRule('jira-events', A.userId, A.username);
    const old = [newId(), newId()];
    for (const x of old) {
      await pool.query(`INSERT INTO integration_jobs (id, kind, integration_id, created_at, run_at) VALUES ($1, 'jira.post', $2, now() - interval '7 hours', now() + interval '1 day')`, [x, rule]);
    }
    const fresh = newId();
    const hook = newId();
    await pool.query(`INSERT INTO integration_jobs (id, kind, integration_id, run_at) VALUES ($1, 'jira.post', $2, now() + interval '1 day')`, [fresh, rule]);
    await pool.query(`INSERT INTO integration_jobs (id, kind, created_at, run_at) VALUES ($1, 'jira.webhook', now() - interval '7 hours', now() + interval '1 day')`, [hook]);

    await updateSettings({ Jira_Enabled: true });
    expect(await drainJobs({ kinds: [kind] })).toBe(1);
    expect(ran).toEqual([id]);
    for (const x of old) expect(await jobRow(x)).toMatchObject({ status: 'dead', last_error: 'A integração ficou desligada por mais de 6 horas; este aviso antigo foi descartado.' });
    expect((await jobRow(fresh)).status).toBe('queued');
    expect((await jobRow(hook)).status).toBe('queued');
    expect(await activityRows('integration_id = $1', [rule])).toEqual([
      { tone: 'warn', text: 'A integração ficou desligada por mais de 6 horas; 2 avisos antigos foram descartados.', detail: null, integration_id: rule, job_id: null },
    ]);
    await pool.query('DELETE FROM integration_jobs WHERE id = ANY($1)', [[...old, fresh, hook]]);
    await pool.query('DELETE FROM integrations WHERE id = $1', [rule]);
  });

  it('fila cheia: enqueue devolve null e escreve uma linha de atividade por hora', async () => {
    const kind = 'jira.cheia';
    await pool.query(`INSERT INTO integration_jobs (id, kind) SELECT 'cheia-' || g, $1 FROM generate_series(1, 20000) g`, [kind]);
    try {
      expect(await enqueue(kind, {})).toBeNull();
      expect(await enqueue(kind, {})).toBeNull();
      expect(await activityRows('text = $1', ['Fila de tarefas cheia (jira.cheia).'])).toEqual([{ tone: 'err', text: 'Fila de tarefas cheia (jira.cheia).', detail: null, integration_id: null, job_id: null }]);
    } finally {
      await pool.query('DELETE FROM integration_jobs WHERE kind = $1', [kind]);
    }
  });
});

// ---------- Leases e consultas periódicas ----------

describe('Núcleo: leases e consultas periódicas', () => {
  it('M4: um lease fica com uma instância por vez, é renovado e é assumido depois de until', async () => {
    const id = `teste-${newId()}`;
    let inner: boolean | null = null;
    let renewed = false;
    const took = await withLease(
      id,
      60_000,
      async (lease) => {
        inner = await withLease(id, 60_000, async () => {}, 'instancia-b');
        const until1 = (await getState<any>(`lease:${id}`)).until;
        await sleep(20);
        renewed = await lease.renew();
        expect(new Date((await getState<any>(`lease:${id}`)).until).getTime()).toBeGreaterThan(new Date(until1).getTime());
      },
      'instancia-a',
    );
    expect(took).toBe(true);
    expect(inner).toBe(false);
    expect(renewed).toBe(true);
    // Solto ao terminar: a outra instância pega na hora.
    expect(await withLease(id, 60_000, async () => {}, 'instancia-b')).toBe(true);

    // Uma instância que caiu segurando o lease: depois de until, outra assume; antes, não.
    const crashed = `teste-${newId()}`;
    await pool.query(`INSERT INTO integration_state (id, data) VALUES ($1, jsonb_build_object('until', now() + interval '1 minute', 'owner', 'morta'))`, [`lease:${crashed}`]);
    expect(await withLease(crashed, 60_000, async () => {}, 'viva')).toBe(false);
    await pool.query(`UPDATE integration_state SET data = jsonb_build_object('until', now() - interval '1 second', 'owner', 'morta') WHERE id = $1`, [`lease:${crashed}`]);
    expect(await withLease(crashed, 60_000, async () => {}, 'viva')).toBe(true);
  });

  it('M4: com dois runtimes no mesmo banco, a consulta periódica roda uma vez por intervalo', async () => {
    let on = true;
    let runs = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    registerPoller({
      id: 'teste.dois',
      provider: 'msteams',
      intervalMs: () => 60_000,
      enabled: () => on,
      alert: false,
      run: async () => {
        runs++;
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(150);
        concurrent--;
      },
    });
    const logs: string[] = [];
    const r1 = startIntegrationsRuntime((m) => logs.push(m), { tickMs: 40, worker: false });
    const r2 = startIntegrationsRuntime((m) => logs.push(m), { tickMs: 40, worker: false });
    try {
      await sleep(1200);
      expect(runs).toBe(1);
      // Passou o intervalo (em outra instância ou nesta): roda de novo, uma vez.
      await mergeState('poller:teste.dois', { lastStart: new Date(Date.now() - 61_000).toISOString() });
      await sleep(800);
      expect(runs).toBe(2);
      expect(maxConcurrent).toBe(1);
    } finally {
      on = false;
      r1.stop();
      r2.stop();
    }
    expect(logs.filter((m) => !m.includes('Chave de segredos'))).toEqual([]);
  });

  it('consultas periódicas: intervalo grande sem consulta vira aviso; falha por mais de 1 hora vira alerta jira.poll, que some quando volta', async () => {
    let fail = false;
    registerPoller({
      id: 'teste.falha',
      provider: 'jira',
      intervalMs: () => 60_000,
      enabled: () => false,
      gapWarnMs: 60 * 60_000,
      run: async () => {
        if (fail) throw new Error('Jira fora do ar.');
      },
    });
    await mergeState('poller:teste.falha', { lastStart: new Date(Date.now() - 3 * 3600_000).toISOString() });
    await runPollerOnce('teste.falha');
    expect(await activityRows(`text LIKE 'O chat ficou %'`, [])).toEqual([
      { tone: 'warn', text: 'O chat ficou 180 minutos sem consultar o Jira. Avisos desse período não foram publicados.', detail: null, integration_id: null, job_id: null },
    ]);
    fail = true;
    await runPollerOnce('teste.falha');
    expect((await getState<any>('poller:teste.falha')).failingSince).toBeTruthy();
    expect(await getState('alert:jira.poll')).toBeNull();
    await mergeState('poller:teste.falha', { failingSince: new Date(Date.now() - 2 * 3600_000).toISOString() });
    await runPollerOnce('teste.falha');
    expect(await getState<any>('alert:jira.poll')).toMatchObject({ tone: 'err', text: 'A consulta ao Jira falha há mais de 1 hora: Jira fora do ar.', href: '/admin/integrations/jira/avisos' });
    // Uma linha de atividade por texto por hora.
    expect(await activityRows('text = $1', ['Jira fora do ar.'])).toEqual([{ tone: 'err', text: 'Jira fora do ar.', detail: 'teste.falha', integration_id: null, job_id: null }]);
    fail = false;
    await runPollerOnce('teste.falha');
    expect(await getState('alert:jira.poll')).toBeNull();
    expect((await getState<any>('poller:teste.falha')).failingSince).toBeNull();
    await expect(runPollerOnce('nao.existe')).rejects.toThrow('Consulta periódica desconhecida: nao.existe');
  });

  it('wrapHook: o erro de um ouvinte vira uma linha de atividade (uma por texto por hora)', async () => {
    let calls = 0;
    const h = wrapHook<{ x: number }>('jira', 'gancho de teste', async () => {
      calls++;
      throw new Error('quebrou');
    });
    await h({ x: 1 });
    await h({ x: 2 });
    expect(calls).toBe(2);
    expect(await activityRows('text = $1', ['Falha ao processar gancho de teste: quebrou'])).toHaveLength(1);
  });

  it('alertText não dobra o ponto final', () => {
    expect(alertText('As integrações estão paradas', 'Falta a chave.')).toBe('As integrações estão paradas: Falta a chave.');
    expect(alertText('A consulta falha', 'HTTP 500')).toBe('A consulta falha: HTTP 500.');
    expect(alertText('A consulta falha', '')).toBe('A consulta falha.');
  });
});

// ---------- Robôs e salas de destino ----------

describe('Núcleo: robôs e salas de destino', () => {
  let jiraBot: { id: string; username: string };
  let U: Auth; // pessoa comum
  let M: Auth; // outro administrador, fora do time privado

  beforeAll(async () => {
    U = await newUser(A);
    M = await newUser(A, { roles: ['user', 'admin'] });
  });

  it('robô criado uma vez, jira.bot2 quando o nome está ocupado, avatar gravado; some → criado de novo', async () => {
    const taken = await api('POST', 'users.create', { username: 'jira.bot', name: 'Pessoa com o nome', email: 'jira.bot@test.local', password: 'senha-forte-1' }, A);
    expect(taken.success).toBe(true);
    const [b1, b2, b3] = await Promise.all([ensureBotUser('jira'), ensureBotUser('jira'), ensureBotUser('jira')]);
    expect(b2).toEqual(b1);
    expect(b3).toEqual(b1);
    jiraBot = b1;
    expect(b1.username).toBe('jira.bot2');
    const row = await one('SELECT name, type, roles, active, avatar_etag FROM users WHERE id = $1', [b1.id]);
    expect(row).toMatchObject({ name: 'Jira', type: 'bot', roles: ['bot'], active: true });
    expect(row.avatar_etag).toBeTruthy();
    const avatar = await one('SELECT content_type, data FROM avatars WHERE user_id = $1', [b1.id]);
    expect(avatar.content_type).toBe('image/png');
    expect(Buffer.from(avatar.data).equals(Buffer.from(BOT_AVATAR.jira, 'base64'))).toBe(true);
    expect(Buffer.from(avatar.data).subarray(1, 4).toString()).toBe('PNG');
    expect(await getState('bot.jira')).toEqual({ id: b1.id });
    expect(await ensureBotUser('jira')).toEqual(b1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM users WHERE type = 'bot' AND name = 'Jira'`)).rows[0].n).toBe(1);

    const ms = await ensureBotUser('msteams');
    expect(ms.username).toBe(BOTS.msteams.username);
    expect(Buffer.byteLength(BOT_AVATAR.msteams, 'base64')).toBeLessThanOrEqual(8 * 1024);
    // Apagado por fora (sem regras): a próxima chamada cria de novo.
    await pool.query('DELETE FROM users WHERE id = $1', [ms.id]);
    const ms2 = await ensureBotUser('msteams');
    expect(ms2.id).not.toBe(ms.id);
    expect(ms2.username).toBe('msteams.bot');
    expect((await botIds()).sort()).toEqual([b1.id, ms2.id].sort());
  });

  it('robô desativado: a tarefa morre com o texto de reativação (nunca reativamos sozinhos)', async () => {
    await pool.query('UPDATE users SET active = false WHERE id = $1', [jiraBot.id]);
    const text = `O usuário ${jiraBot.username} foi desativado. Reative-o em Administração → Usuários para as regras voltarem a publicar.`;
    try {
      await expect(ensureBotUser('jira')).rejects.toMatchObject({ statusCode: 400, errorType: 'error-integration-bot-inactive', message: text });
      await updateSettings({ Jira_Enabled: true });
      const kind = kindFor(async () => {
        await ensureBotUser('jira');
      });
      const id = await enqueue(kind, {});
      await drainJobs({ kinds: [kind] });
      expect(await jobRow(id)).toMatchObject({ status: 'dead', attempts: 1, last_error: text });
      expect((await one('SELECT active FROM users WHERE id = $1', [jiraBot.id])).active).toBe(false);
    } finally {
      await updateSettings({ Jira_Enabled: false });
      await pool.query('UPDATE users SET active = true WHERE id = $1', [jiraBot.id]);
    }
  });

  it('checkTargets: cada linha da tabela do §3.5, na ordem', async () => {
    const ctxA = ctxOf(A);
    const ctxU = ctxOf(U);
    const one_ = async (ctx: Ctx, rid: string, o: { kind?: 'jira' | 'msteams'; mode?: 'post' | 'read'; grant?: boolean } = {}) =>
      (await checkTargets(ctx, o.kind ?? 'jira', [rid], o.mode ?? 'post', o.grant ?? false))[0];

    // Sala inexistente e DM.
    expect(await one_(ctxA, 'nao-existe')).toMatchObject({ ok: false, problem: 'Só canais e grupos privados podem ser usados.' });
    const dm = await api('POST', 'im.create', { username: U.username }, A);
    expect(await one_(ctxA, dm.room._id)).toMatchObject({ ok: false, problem: 'Só canais e grupos privados podem ser usados.' });
    // Discussões (também a criada numa DM).
    const ch = await channel(A, [U.username]);
    const disc = await api('POST', 'rooms.createDiscussion', { prid: ch._id, t_name: uniq('discussao') }, A);
    const dmDisc = await api('POST', 'rooms.createDiscussion', { prid: dm.room._id, t_name: uniq('discussao-dm') }, A);
    for (const d of [disc, dmDisc]) {
      expect(d.discussion).toBeTruthy();
      expect(await one_(ctxA, d.discussion._id)).toMatchObject({ ok: false, problem: 'Discussões não podem ser usadas em integrações.' });
    }
    // Grupo privado de que a pessoa não participa.
    const grp = await api('POST', 'groups.create', { name: uniq('grupo') }, U);
    expect(await one_(ctxA, grp.group._id)).toMatchObject({ ok: false, problem: 'Você precisa participar do grupo privado para usá-lo numa integração.' });
    // Arquivada.
    const arch = await channel(A);
    expect((await api('POST', 'channels.archive', { roomId: arch._id }, A)).success).toBe(true);
    expect(await one_(ctxA, arch._id)).toMatchObject({ ok: false, problem: 'A sala está arquivada.' });
    // Envio para o Teams (read): só donos e moderadores da sala, ou admin global.
    expect(await one_(ctxU, ch._id, { kind: 'msteams', mode: 'read' })).toMatchObject({ ok: false, problem: 'Só donos e moderadores da sala podem enviar as mensagens dela para o Teams.' });
    expect(await one_(ctxA, ch._id, { kind: 'msteams', mode: 'read' })).toMatchObject({ ok: true });
    // Canal de avisos e sala somente leitura.
    const avisos = await channel(A, [U.username], { extraData: { notice: true } });
    expect(await one_(ctxA, avisos._id)).toEqual(
      expect.objectContaining({ ok: false, needsPublisher: true, botMember: false, problem: 'Este é um canal de avisos. Marque “Permitir que o Jira publique neste canal de avisos”.' }),
    );
    const ro = await channel(A, [], { readOnly: true });
    expect(await one_(ctxA, ro._id, { kind: 'msteams' })).toMatchObject({ ok: false, needsPublisher: true, problem: 'Esta sala é somente leitura. Marque “Permitir que o Microsoft Teams publique nesta sala”.' });
    expect(await one_(ctxA, avisos._id, { grant: true })).toMatchObject({ ok: true, needsPublisher: true });
    expect(await one_(ctxU, avisos._id, { grant: true })).toMatchObject({ ok: false, needsPublisher: true, problem: `Você não pode tornar o Jira publicador em #${avisos.name}.` });
    // Robô silenciado.
    const quiet = await channel(A);
    expect((await api('POST', 'rooms.muteUser', { roomId: quiet._id, username: jiraBot.username }, A)).success).toBe(true);
    expect(await one_(ctxA, quiet._id)).toMatchObject({ ok: false, problem: 'O Jira está silenciado nesta sala.' });
    // Tudo certo.
    const fine = await one_(ctxA, ch._id);
    expect(fine).toEqual({ room: expect.objectContaining({ _id: ch._id, name: ch.name, t: 'c', notice: false, archived: false, ro: false }), ok: true, botMember: false, needsPublisher: false });
    // Pela API, só quem gerencia aquele fornecedor.
    expect(await api('POST', 'integrations.targets.check', { provider: 'jira', roomIds: [ch._id] }, U)).toMatchObject({ status: 403 });
    const viaApi = await api('POST', 'integrations.targets.check', { provider: 'jira', roomIds: [ch._id, avisos._id], grantPublisher: true }, A);
    expect(viaApi.targets.map((t: any) => [t.ok, t.needsPublisher])).toEqual([
      [true, false],
      [true, true],
    ]);
  });

  it('H4: canal de um time privado é recusado para quem não é do time e não aparece em integrations.rooms.search', async () => {
    const teamName = uniq('time-privado');
    const team = await api('POST', 'teams.create', { name: teamName, type: 1 }, A);
    expect(team.team).toBeTruthy();
    const name = uniq('canal-do-time');
    const room = await api('POST', 'teams.createRoom', { teamId: team.team._id, name, type: 'c' }, A);
    expect(room.room).toBeTruthy();
    const rid = room.room._id;

    const [forM] = await checkTargets(ctxOf(M), 'jira', [rid], 'post', false);
    expect(forM).toMatchObject({ ok: false, problem: 'Este canal é de um time privado do qual você não participa.' });
    expect((await api('POST', 'integrations.targets.check', { provider: 'jira', roomIds: [rid] }, M)).targets[0].problem).toBe('Este canal é de um time privado do qual você não participa.');
    expect((await checkTargets(ctxOf(A), 'jira', [rid], 'post', false))[0].ok).toBe(true);

    const searchM = await api('GET', 'integrations.rooms.search', { text: name }, M);
    expect(searchM.rooms).toEqual([]);
    const searchA = await api('GET', 'integrations.rooms.search', { text: name }, A);
    expect(searchA.rooms.map((r: any) => r._id)).toEqual([rid]);
    // Nunca discussões nem salas arquivadas; quem não gerencia nada não pesquisa.
    const ch = await channel(A);
    await api('POST', 'rooms.createDiscussion', { prid: ch._id, t_name: `${name}-discussao` }, A);
    const arch = await api('POST', 'channels.create', { name: `${name}-arquivada` }, A);
    await api('POST', 'channels.archive', { roomId: arch.channel._id }, A);
    expect((await api('GET', 'integrations.rooms.search', { text: name }, A)).rooms.map((r: any) => r._id)).toEqual([rid]);
    expect(await api('GET', 'integrations.rooms.search', { text: name }, U)).toMatchObject({ status: 403 });
  });

  it('prepareTargets adiciona o robô com a mensagem de sistema e o papel publisher; releaseTargets tira só quando nenhuma regra usa a sala', async () => {
    const avisos = await channel(A, [], { extraData: { notice: true } });
    await expect(prepareTargets(ctxOf(A), 'jira', [avisos._id], false)).rejects.toMatchObject({
      statusCode: 400,
      errorType: 'error-integration-room',
      message: 'Este é um canal de avisos. Marque “Permitir que o Jira publique neste canal de avisos”.',
    });
    await prepareTargets(ctxOf(A), 'jira', [avisos._id], true);
    const sub = await one('SELECT roles FROM subscriptions WHERE room_id = $1 AND user_id = $2', [avisos._id, jiraBot.id]);
    expect(sub.roles).toContain('publisher');
    const sys = (await pool.query(`SELECT t, msg, user_id FROM messages WHERE room_id = $1 AND t IN ('au', 'subscription-role-added') ORDER BY created_at`, [avisos._id])).rows;
    expect(sys).toEqual([
      { t: 'au', msg: jiraBot.username, user_id: A.userId },
      { t: 'subscription-role-added', msg: jiraBot.username, user_id: A.userId },
    ]);
    // De novo: nada duplicado.
    await prepareTargets(ctxOf(A), 'jira', [avisos._id], true);
    expect((await pool.query(`SELECT 1 FROM messages WHERE room_id = $1 AND t IN ('au', 'subscription-role-added')`, [avisos._id])).rowCount).toBe(2);
    expect((await checkTargets(ctxOf(A), 'jira', [avisos._id], 'post', false))[0]).toMatchObject({ ok: true, botMember: true, needsPublisher: false });

    // Uma regra ainda usa a sala: o robô fica.
    const rule = newId();
    await pool.query(`INSERT INTO integrations (id, type, name, token, user_id, username, channels, config) VALUES ($1, 'jira-events', 'Avisos OPS', '', $2, $3, $4, '{}')`, [rule, jiraBot.id, jiraBot.username, [avisos._id]]);
    await releaseTargets(ctxOf(A), 'jira', [avisos._id], 'Os avisos do Jira deixaram de ser publicados aqui.');
    expect(await one('SELECT 1 FROM subscriptions WHERE room_id = $1 AND user_id = $2', [avisos._id, jiraBot.id])).not.toBeNull();
    expect(await one('SELECT 1 FROM messages WHERE room_id = $1 AND user_id = $2 AND t IS NULL', [avisos._id, jiraBot.id])).toBeNull();
    await pool.query('DELETE FROM integrations WHERE id = $1', [rule]);
    await releaseTargets(ctxOf(A), 'jira', [avisos._id], 'Os avisos do Jira deixaram de ser publicados aqui.');
    expect(await one('SELECT 1 FROM subscriptions WHERE room_id = $1 AND user_id = $2', [avisos._id, jiraBot.id])).toBeNull();
    const last = (await pool.query(`SELECT t, msg, user_id FROM messages WHERE room_id = $1 ORDER BY created_at DESC LIMIT 2`, [avisos._id])).rows;
    expect(last).toEqual([
      { t: 'ru', msg: jiraBot.username, user_id: A.userId },
      { t: null, msg: 'Os avisos do Jira deixaram de ser publicados aqui.', user_id: jiraBot.id },
    ]);
    const bare = (await pool.query(`SELECT mentions FROM messages WHERE room_id = $1 AND user_id = $2`, [avisos._id, jiraBot.id])).rows;
    expect(bare.every((r) => (r.mentions ?? []).length === 0)).toBe(true);
  });

  it('UX 5.10: quem escreve numa DM com o robô recebe uma resposta efêmera e nenhuma mensagem do robô; F11: DM nova com o robô é recusada', async () => {
    const V = await newUser(A);
    // Uma DM que já existia antes de o usuário virar o robô da integração.
    const saved = await getState('bot.jira');
    await setState('bot.jira', null);
    const dm = await api('POST', 'im.create', { username: jiraBot.username }, V);
    await setState('bot.jira', saved);
    expect(dm.room).toBeTruthy();
    const ws = connectWs(V);
    await ws.ready;
    try {
      expect((await api('POST', 'chat.sendMessage', { message: { rid: dm.room._id, msg: 'oi, robô' } }, V)).success).toBe(true);
      const ev = await ws.waitFor((e) => e.type === 'ephemeral' && e.message.rid === dm.room._id);
      expect(ev.message).toMatchObject({ source: 'jira', tone: 'info', text: 'Eu só publico avisos do Jira nas salas. Use /jira ajuda para ver o que dá para fazer.' });
      expect((await api('POST', 'chat.sendMessage', { message: { rid: dm.room._id, msg: 'de novo' } }, V)).success).toBe(true);
      await sleep(300);
      expect(ws.events.filter((e) => e.type === 'ephemeral')).toHaveLength(1);
    } finally {
      ws.close();
    }
    expect((await pool.query('SELECT 1 FROM messages WHERE room_id = $1 AND user_id = $2', [dm.room._id, jiraBot.id])).rowCount).toBe(0);
    const W = await newUser(A);
    expect(await api('POST', 'im.create', { username: jiraBot.username }, W)).toMatchObject({
      status: 400,
      errorType: 'error-integration-bot-direct',
      error: 'O robô de uma integração não recebe mensagens diretas.',
    });
  });
});

// ---------- Respostas efêmeras ----------

describe('Núcleo: respostas efêmeras', () => {
  it('vão só para a pessoa (todas as conexões dela), com ações filtradas; autoOpenFor é a marca da sessão que pediu', async () => {
    const U = await newUser(A);
    const U2 = await login(U.username, 'senha-forte-1');
    const me1 = await api('GET', 'integrations.me', undefined, U);
    const me2 = await api('GET', 'integrations.me', undefined, U2);
    expect(me1.sessionTag).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(me1.sessionTag).not.toBe(me2.sessionTag);
    const sessions = (await pool.query('SELECT id FROM sessions WHERE user_id = $1', [U.userId])).rows.map((r) => sessionTag(r.id));
    expect(sessions).toEqual(expect.arrayContaining([me1.sessionTag, me2.sessionTag]));

    const wsU = connectWs(U);
    const wsU2 = connectWs(U2);
    const wsA = connectWs(A);
    await Promise.all([wsU.ready, wsU2.ready, wsA.ready]);
    try {
      const ch = await channel(A, [U.username]);
      const sent = sendEphemeral(U.userId, {
        rid: ch._id,
        source: 'jira',
        tone: 'ok',
        text: 'Só você vê isto.',
        autoOpenFor: me1.sessionTag,
        actions: [
          { kind: 'api', label: 'Ver mais', endpoint: 'jira.search.more', body: { q: 'x' } },
          { kind: 'api', label: 'Perigo', endpoint: 'users.delete' as any, body: {} },
          { kind: 'url', label: 'Abrir', url: 'http://inseguro.example/' },
          { kind: 'url', label: 'Abrir', url: 'https://explorer.atlassian.net/browse/OPS-1' },
          { kind: 'modal', label: 'Criar', modal: 'jira-create', autoOpen: true },
          { kind: 'modal', label: 'Outro', modal: 'jira-link' },
        ],
      });
      expect(sent.actions?.map((a) => a.label)).toEqual(['Ver mais', 'Abrir', 'Criar']);
      const [e1, e2] = await Promise.all([wsU.waitFor((e) => e.type === 'ephemeral'), wsU2.waitFor((e) => e.type === 'ephemeral')]);
      expect(e1.message).toEqual(sent);
      expect(e2.message.autoOpenFor).toBe(me1.sessionTag);
      expect(sent._id).toBeTruthy();
      await sleep(300);
      expect(wsA.events.some((e) => e.type === 'ephemeral')).toBe(false);
      expect(await one('SELECT 1 FROM messages WHERE msg = $1', ['Só você vê isto.'])).toBeNull();
    } finally {
      wsU.close();
      wsU2.close();
      wsA.close();
    }
  });
});

// ---------- Contas conectadas ----------

describe('Núcleo: contas conectadas', () => {
  const site = 'https://explorer.atlassian.net';
  const jiraRow = (userId: string, externalId: string, extra: Record<string, unknown> = {}) => ({
    userId,
    provider: 'jira' as const,
    method: 'token' as const,
    externalId,
    displayName: 'Ana Souza',
    email: 'ana@explorer.com.br',
    site,
    tokenExpiresAt: null,
    secretExpiresAt: null,
    scopes: [],
    meta: {},
    ...extra,
  });

  it('tokens cifrados no banco; conflito (provider, external_id) → 409; integrations.linked.list sem tokens; outra origem → expirada', async () => {
    const U = await newUser(A);
    const V = await newUser(A);
    const ext = `acc-${newId()}`;
    await saveLinked({ ...jiraRow(U.userId, ext), access: 'token-pessoal-ana-9876' });
    const row = await one('SELECT access_token, refresh_token, status FROM linked_accounts WHERE user_id = $1', [U.userId]);
    expect(row.access_token).not.toContain('token-pessoal');
    expect(row.access_token.startsWith('v1.')).toBe(true);
    expect(row.refresh_token).toBeNull();
    expect(await linkedSecrets(U.userId, 'jira', site)).toEqual({ access: 'token-pessoal-ana-9876', refresh: null });
    // Salvar de novo sem token mantém o guardado.
    await saveLinked({ ...jiraRow(U.userId, ext), displayName: 'Ana S.' });
    expect((await linkedSecrets(U.userId, 'jira', site)).access).toBe('token-pessoal-ana-9876');

    await expect(saveLinked({ ...jiraRow(V.userId, ext), access: 'outro' })).rejects.toMatchObject({
      statusCode: 409,
      errorType: 'error-linked-elsewhere',
      message: 'Esta conta já está conectada a outra pessoa do chat. Peça para ela desconectar ou fale com o administrador.',
    });
    const list = await api('GET', 'integrations.linked.list', undefined, U);
    expect(list.accounts).toEqual([expect.objectContaining({ provider: 'jira', method: 'token', displayName: 'Ana S.', site, status: 'ok' })]);
    const text = JSON.stringify(list);
    expect(text).not.toContain('token-pessoal');
    expect(text).not.toContain('v1.');
    expect(text).not.toMatch(/access|refresh|external/i);
    const audits = (await pool.query(`SELECT action, data FROM audit_log WHERE action LIKE 'integration.linked.%' AND target->>'userId' = $1`, [U.userId])).rows;
    expect(audits).toEqual([{ action: 'integration.linked.added', data: { provider: 'jira', method: 'token', displayName: 'Ana Souza' } }]);

    // O endereço do Jira mudou: nada é devolvido, a conta expira e a pessoa recebe o alerta.
    expect(await linkedSecrets(U.userId, 'jira', 'https://nova.atlassian.net')).toEqual({ access: null, refresh: null });
    expect(await getLinked(U.userId, 'jira')).toMatchObject({ status: 'expired', statusText: 'O endereço do Jira mudou. Conecte sua conta de novo.' });
    expect(await getState<any>(`alert:jira.linked:${U.userId}`)).toMatchObject({ to: { userId: U.userId }, href: '/account/connected', text: 'Conecte sua conta do Jira de novo em Minha conta → Contas conectadas.' });
    await setLinkedStatus(U.userId, 'jira', 'ok');
    expect(await getState(`alert:jira.linked:${U.userId}`)).toBeNull();

    expect((await api('POST', 'integrations.linked.remove', { provider: 'jira' }, U)).success).toBe(true);
    expect(await getLinked(U.userId, 'jira')).toBeNull();
    expect((await pool.query(`SELECT 1 FROM audit_log WHERE action = 'integration.linked.removed' AND target->>'userId' = $1`, [U.userId])).rowCount).toBe(1);
  });

  it('expireAllLinked apaga os tokens, expira todas as contas do Jira e avisa cada pessoa', async () => {
    const U = await newUser(A);
    const V = await newUser(A);
    await saveLinked({ ...jiraRow(U.userId, `acc-${newId()}`), access: 'a1' });
    await saveLinked({ ...jiraRow(V.userId, `acc-${newId()}`), method: 'oauth', access: 'a2', refresh: 'r2' });
    const n = await expireAllLinked('jira', 'O endereço do Jira mudou. Conecte sua conta de novo.');
    expect(n).toBeGreaterThanOrEqual(2);
    const rows = (await pool.query(`SELECT status, status_text, access_token, refresh_token FROM linked_accounts WHERE user_id = ANY($1)`, [[U.userId, V.userId]])).rows;
    expect(rows).toEqual([
      { status: 'expired', status_text: 'O endereço do Jira mudou. Conecte sua conta de novo.', access_token: null, refresh_token: null },
      { status: 'expired', status_text: 'O endereço do Jira mudou. Conecte sua conta de novo.', access_token: null, refresh_token: null },
    ]);
    expect((await api('GET', 'integrations.alerts', undefined, V)).alerts.map((a: any) => a.key)).toEqual([`jira.linked:${V.userId}`]);
  });

  it('conta Microsoft: busySync em integrations.linked.update', async () => {
    const U = await newUser(A);
    expect(await api('POST', 'integrations.linked.update', { provider: 'microsoft', busySync: true }, U)).toMatchObject({ status: 404 });
    await saveLinked({ userId: U.userId, provider: 'microsoft', method: 'directory', externalId: `oid-${newId()}`, displayName: 'Ana', email: 'ana@explorer.com.br', site: null, tokenExpiresAt: null, secretExpiresAt: null, scopes: [], meta: { upn: 'ana@explorer.com.br' } });
    const r = await api('POST', 'integrations.linked.update', { provider: 'microsoft', busySync: true }, U);
    expect(r.account).toMatchObject({ provider: 'microsoft', busySync: true });
    expect((await getLinked(U.userId, 'microsoft'))?.meta).toEqual({ upn: 'ana@explorer.com.br', busySync: true });
    expect(await api('POST', 'integrations.linked.update', { provider: 'jira', busySync: true }, U)).toMatchObject({ status: 400 });
  });
});

// ---------- OAuth ----------

describe('Núcleo: estado do OAuth', () => {
  const start = async (o: { purpose?: 'jira-user' | 'msteams-service'; cookie?: string; returnTo?: string; codeVerifier?: string } = {}) => {
    const { reply, headers } = fakeReply(o.cookie);
    const { state } = await startOAuth(reply, {
      purpose: o.purpose ?? 'jira-user',
      userId: A.userId,
      redirectUri: 'http://localhost:3000/integrations/jira/callback',
      returnTo: o.returnTo ?? '/account/connected',
      ...(o.codeVerifier ? { codeVerifier: o.codeVerifier } : {}),
    });
    return { state, cookie: cookieValue(headers['set-cookie']), headers };
  };
  const err = (p: Promise<unknown>) => p.then(() => null, (e) => e);

  it('bom: devolve a pessoa, apaga a linha e o cookie; o cookie é HttpOnly, SameSite=Lax, Path=/integrations/', async () => {
    const s = await start({ codeVerifier: 'verificador-123' });
    expect(s.cookie.raw).toMatch(new RegExp(`^${OAUTH_COOKIE}=[A-Za-z0-9_-]{43}; Path=/integrations/; Max-Age=600; HttpOnly; SameSite=Lax$`));
    expect(s.headers['cache-control']).toBe('no-store');
    const hash = crypto.createHash('sha256').update(s.state).digest('hex');
    const row = await one('SELECT * FROM integration_oauth_states WHERE state_hash = $1', [hash]);
    expect(row).toMatchObject({ purpose: 'jira-user', user_id: A.userId, return_to: '/account/connected' });
    expect(row.browser_hash).not.toBe(s.cookie.value);
    expect(row.code_verifier).not.toContain('verificador');
    const { reply, headers } = fakeReply();
    const got = await finishOAuth(fakeReq(s.state, s.cookie.value), 'jira-user', reply);
    expect(got).toEqual({ userId: A.userId, redirectUri: 'http://localhost:3000/integrations/jira/callback', returnTo: '/account/connected', codeVerifier: 'verificador-123' });
    expect(await one('SELECT 1 FROM integration_oauth_states WHERE state_hash = $1', [hash])).toBeNull();
    expect(cookieValue(headers['set-cookie']).raw).toContain('Max-Age=0');
    // Reusado: recusado.
    expect(await err(finishOAuth(fakeReq(s.state, s.cookie.value), 'jira-user'))).toBeInstanceOf(OAuthStateError);
  });

  it('cookie errado, propósito errado, vencido e reusado são recusados (e a linha some mesmo assim)', async () => {
    const a = await start();
    const e1 = await err(finishOAuth(fakeReq(a.state, crypto.randomBytes(32).toString('base64url')), 'jira-user'));
    expect(e1).toBeInstanceOf(OAuthStateError);
    expect(e1.returnTo).toBe('/account/connected');
    expect(await err(finishOAuth(fakeReq(a.state, a.cookie.value), 'jira-user'))).toBeInstanceOf(OAuthStateError);

    const b = await start({ returnTo: '/account/connected?aba=jira' });
    const e2 = await err(finishOAuth(fakeReq(b.state, b.cookie.value), 'msteams-service'));
    expect(e2).toBeInstanceOf(OAuthStateError);
    expect(e2.returnTo).toBe('/admin/integrations/teams/conexao');

    const c = await start({ returnTo: '/account/connected?aba=jira' });
    await pool.query(`UPDATE integration_oauth_states SET expires_at = now() - interval '1 second' WHERE state_hash = $1`, [crypto.createHash('sha256').update(c.state).digest('hex')]);
    const e3 = await err(finishOAuth(fakeReq(c.state, c.cookie.value), 'jira-user'));
    expect(e3).toBeInstanceOf(OAuthStateError);
    expect(stateErrorTarget(e3.returnTo)).toBe('/account/connected?aba=jira&integracao=erro&motivo=estado');

    expect(await err(finishOAuth(fakeReq(''), 'jira-user'))).toBeInstanceOf(OAuthStateError);
    expect(await err(finishOAuth(fakeReq('nao-existe', a.cookie.value), 'jira-user'))).toBeInstanceOf(OAuthStateError);
  });

  it('sem sessão, cada início tem um nonce novo e o cookie que o navegador mandar não é reaproveitado; returnTo só do mesmo site', async () => {
    const first = await start();
    const second = await start({ cookie: `${OAUTH_COOKIE}=${first.cookie.value}` });
    expect(second.cookie.value).not.toBe(first.cookie.value);
    expect((await finishOAuth(fakeReq(first.state, first.cookie.value), 'jira-user')).userId).toBe(A.userId);
    expect((await finishOAuth(fakeReq(second.state, second.cookie.value), 'jira-user')).userId).toBe(A.userId);

    for (const bad of ['https://evil.example/', '//evil.example/account/', '/\\evil.example', '/outra/pagina', 'javascript:alert(1)', '/account/\r\nx']) {
      expect(safeReturnTo(bad, 'jira-user'), bad).toBe('/account/connected');
    }
    expect(safeReturnTo('/admin/integrations/jira/conexao?x=1', 'msteams-service')).toBe('/admin/integrations/jira/conexao?x=1');
    expect(safeReturnTo(undefined, 'msteams-service')).toBe('/admin/integrations/teams/conexao');
    const evil = await start({ returnTo: 'https://evil.example/' });
    expect((await finishOAuth(fakeReq(evil.state, evil.cookie.value), 'jira-user')).returnTo).toBe('/account/connected');
  });
});

// ---------- Texto de fora ----------

describe('Núcleo: texto de fora', () => {
  it('H2: safeExternalText desarma [x](https://evil.example), deixa o link do Jira clicável, torna https://evil.example texto, desembrulha Safe Links e neutraliza @all', async () => {
    expect(safeExternalText('[Seu acesso expira, clique aqui](https://evil.example)')).toBe(`[Seu acesso expira, clique aqui]${ZW}(https:${ZW}//evil.example)`);
    expect(safeExternalText('Veja https://explorer.atlassian.net/browse/OPS-1')).toBe('Veja https://explorer.atlassian.net/browse/OPS-1');
    expect(safeExternalText('Abra https://evil.example/login agora')).toBe(`Abra https:${ZW}//evil.example/login agora`);
    expect(safeExternalText('ou www.evil.example')).toBe(`ou w${ZW}ww.evil.example`);
    expect(safeExternalText('https://teams.microsoft.com/l/message/1 e https://explorer.sharepoint.com/sites/x')).toBe('https://teams.microsoft.com/l/message/1 e https://explorer.sharepoint.com/sites/x');
    const wrapped = 'https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexplorer.atlassian.net%2Fbrowse%2FOPS-2&data=05%7C01&reserved=0';
    expect(safeExternalText(`Link: ${wrapped}`)).toBe('Link: https://explorer.atlassian.net/browse/OPS-2');
    const evilWrapped = 'https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fevil.example%2Fx&data=1';
    expect(safeExternalText(evilWrapped)).toBe(`https:${ZW}//evil.example/x`);
    expect(safeExternalText('@all @here @ana.souza #financeiro e ana@explorer.com.br')).toBe(`@${ZW}all @${ZW}here @${ZW}ana.souza #${ZW}financeiro e ana@explorer.com.br`);
    // O host do chat (Site_Url) também é confiável.
    await updateSettings({ Site_Url: 'https://chat.explorer.com.br' });
    try {
      expect(safeExternalText('https://chat.explorer.com.br/channel/geral')).toBe('https://chat.explorer.com.br/channel/geral');
      expect(messagePermalink({ id: 'sala1', t: 'c' }, 'msg1')).toBe('https://chat.explorer.com.br/channel/sala1?msg=msg1');
      expect(messagePermalink({ id: 'sala2', t: 'p' }, 'm')).toBe('https://chat.explorer.com.br/group/sala2?msg=m');
      expect(messagePermalink({ id: 'sala3', t: 'd' }, 'm')).toBe('https://chat.explorer.com.br/direct/sala3?msg=m');
    } finally {
      await updateSettings({ Site_Url: '' });
    }
    expect(messagePermalink({ id: 'sala1', t: 'c' }, 'msg1')).toBeNull();
  });

  it('excerpt e plainFromMarkdown', () => {
    expect(excerpt('linha 1\n\n\nlinha 2   \nlinha 3', 100)).toBe('linha 1\nlinha 2\nlinha 3');
    expect(excerpt('abcdefghij', 5)).toBe('abcd…');
    expect(plainFromMarkdown('**negrito** _itálico_ ~~riscado~~ `código` [Jira](https://explorer.atlassian.net)\n> citação')).toBe('negrito itálico riscado código Jira (https://explorer.atlassian.net)\ncitação');
  });
});

// ---------- Alertas ----------

describe('Núcleo: alertas', () => {
  let smtp: Awaited<ReturnType<typeof startSmtp>>;
  beforeAll(async () => {
    smtp = await startSmtp();
    await updateSettings({ SMTP_Host: '127.0.0.1', SMTP_Port: smtp.port, From_Email: 'chat@explorer.com.br', Site_Url: 'https://chat.explorer.com.br' });
  });
  afterAll(async () => {
    await updateSettings({ SMTP_Host: '', Site_Url: '' });
    await smtp?.close();
  });

  it('uma vez por dia por chave, só para quem gerencia (no chat e por e-mail com SMTP configurado); some quando resolvido', async () => {
    const U = await newUser(A);
    const adminEmail = (await one('SELECT email FROM users WHERE id = $1', [A.userId])).email.toLowerCase();
    const userEmail = `${U.username}@test.local`.toLowerCase();
    const wsA = connectWs(A);
    const wsU = connectWs(U);
    await Promise.all([wsA.ready, wsU.ready]);
    const input = { key: 'teste.conexao', provider: 'jira' as const, tone: 'err' as const, text: 'A conexão com o Jira falhou: HTTP 401.', href: '/admin/integrations/jira/conexao', to: 'managers' as const };
    try {
      await raiseAlert(input);
      const ev = await wsA.waitFor((e) => e.type === 'integrations.alert' && e.alert.key === 'teste.conexao');
      expect(ev.alert).toMatchObject({ key: 'teste.conexao', provider: 'jira', tone: 'err', text: input.text, href: input.href });
      expect(smtp.mails.length).toBeGreaterThanOrEqual(1);
      const recipients = smtp.mails.flatMap((m) => m.to);
      expect(recipients).toContain(adminEmail);
      expect(recipients).not.toContain(userEmail);
      const raw = smtp.mails[0].data;
      expect(raw.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/=\r\n/g, '')).toContain('Abrir: https://chat.explorer.com.br/admin/integrations/jira/conexao');
      // Assunto em "encoded words" (RFC 2047, Q): junta os pedaços e decodifica.
      const subjectLine = /^Subject: (.*(?:\r\n[ \t].*)*)/m.exec(raw)?.[1] ?? '';
      const subject = [...subjectLine.matchAll(/=\?UTF-8\?Q\?([^?]*)\?=/gi)]
        .map((m) => Buffer.from(m[1].replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'))
        .join('');
      expect(subject).toBe('Wescc Chat: A conexão com o Jira falhou');
      const sent = smtp.mails.length;
      const since = (await getState<any>('alert:teste.conexao')).since;

      // De novo no mesmo dia: nada novo, o "desde" continua.
      await raiseAlert({ ...input, text: 'A conexão com o Jira falhou: HTTP 403.' });
      await sleep(200);
      expect(wsA.events.filter((e) => e.type === 'integrations.alert' && e.alert.key === 'teste.conexao')).toHaveLength(1);
      expect(smtp.mails.length).toBe(sent);
      expect(await getState<any>('alert:teste.conexao')).toMatchObject({ since, text: 'A conexão com o Jira falhou: HTTP 403.' });
      expect(wsU.events.some((e) => e.type === 'integrations.alert')).toBe(false);
      expect((await api('GET', 'integrations.alerts', undefined, A)).alerts.map((a: any) => a.key)).toContain('teste.conexao');
      expect((await api('GET', 'integrations.alerts', undefined, U)).alerts).toEqual([]);

      // Passou um dia: entrega outra vez.
      await pool.query(`UPDATE integration_state SET data = jsonb_set(data, '{lastSentAt}', '"2020-01-01T00:00:00.000Z"') WHERE id = 'alert:teste.conexao'`);
      await raiseAlert(input);
      expect(smtp.mails.length).toBeGreaterThan(sent);

      // Resolvido: some; se voltar, avisa de novo.
      await clearAlert('teste.conexao');
      expect((await api('GET', 'integrations.alerts', undefined, A)).alerts.map((a: any) => a.key)).not.toContain('teste.conexao');

      // Alerta pessoal: só a própria pessoa.
      await raiseAlert({ key: `jira.linked:${U.userId}`, provider: 'jira', tone: 'warn', text: 'Seu token do Jira expira em 3 dias.', href: '/account/connected', to: { userId: U.userId } });
      await wsU.waitFor((e) => e.type === 'integrations.alert' && e.alert.key === `jira.linked:${U.userId}`);
      expect(smtp.mails.flatMap((m) => m.to)).toContain(userEmail);
      expect((await api('GET', 'integrations.alerts', undefined, U)).alerts.map((a: any) => a.key)).toEqual([`jira.linked:${U.userId}`]);
      expect((await api('GET', 'integrations.alerts', undefined, A)).alerts.map((a: any) => a.key)).not.toContain(`jira.linked:${U.userId}`);
      await clearAlert(`jira.linked:${U.userId}`);
    } finally {
      wsA.close();
      wsU.close();
    }
  });
});

// ---------- integrations.me e API comum ----------

describe('Núcleo: integrations.me e API comum', () => {
  it('integrations.me para um administrador, uma pessoa comum e alguém da Operação, com sessionTag e bots', async () => {
    const U = await newUser(A);
    const O = await newUser(A, { roles: ['operacao'] });
    const bots = await botIds();
    const meA = await api('GET', 'integrations.me', undefined, A);
    expect(meA).toMatchObject({
      bots: expect.arrayContaining(bots),
      jira: { enabled: false, canUse: true, canCreate: true, canManage: true, userAuth: 'token', createAsIntegration: false, site: '', account: null },
      msteams: { enabled: false, meetings: 'links', canMeet: true, canManage: true, defaultMinutes: 30, presence: false, account: null },
    });
    expect(meA.sessionTag).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const meU = await api('GET', 'integrations.me', undefined, U);
    expect(meU).toMatchObject({ jira: { canUse: true, canCreate: true, canManage: false }, msteams: { canMeet: true, canManage: false, emailTrusted: false } });
    const meO = await api('GET', 'integrations.me', undefined, O);
    expect(meO).toMatchObject({ jira: { canUse: false, canCreate: false, canManage: false }, msteams: { canMeet: false, canManage: false } });
    expect(meO.bots.sort()).toEqual([...bots].sort());

    await updateSettings({ Jira_Enabled: true, Jira_Site_Url: 'https://explorer.atlassian.net' });
    try {
      expect((await api('GET', 'integrations.me', undefined, U)).jira).toMatchObject({ enabled: true, site: 'https://explorer.atlassian.net' });
    } finally {
      await updateSettings({ Jira_Enabled: false, Jira_Site_Url: '' });
    }
    await pool.query('UPDATE users SET email_verified = true WHERE id = $1', [U.userId]);
    expect((await api('GET', 'integrations.me', undefined, U)).msteams.emailTrusted).toBe(true);
  });

  it('overview, activity e secretsKey.reencrypt conferem as permissões', async () => {
    const U = await newUser(A);
    expect(await api('GET', 'integrations.overview', undefined, U)).toMatchObject({ status: 403 });
    const ov = await api('GET', 'integrations.overview', undefined, A);
    expect(ov).toMatchObject({ paused: false, secretsKey: { source: 'env', created: false }, jira: { enabled: false, status: expect.any(Object) }, msteams: { enabled: false } });
    expect(ov.secretsKey.file).toBeUndefined();
    expect(await api('GET', 'integrations.activity', { provider: 'jira' }, U)).toMatchObject({ status: 403 });
    expect(await api('GET', 'integrations.activity', {}, A)).toMatchObject({ status: 400 });
    const act = await api('GET', 'integrations.activity', { provider: 'jira', count: '500' }, A);
    expect(act.activity.length).toBeLessThanOrEqual(100);
    expect(typeof act.total).toBe('number');
    expect(await api('POST', 'integrations.secretsKey.reencrypt', {}, U)).toMatchObject({ status: 403 });
    const re = await api('POST', 'integrations.secretsKey.reencrypt', {}, A);
    expect(re).toMatchObject({ success: true, count: 0 });
    expect((await pool.query(`SELECT 1 FROM audit_log WHERE action = 'integration.secretsKey.reencrypted'`)).rowCount).toBe(1);
  });
});

// ---------- Blocos do §16 fora do núcleo ----------

describe('Núcleo: LDAP (§16)', () => {
  it('o e-mail que vem do diretório fica confirmado (email_verified), também numa conta que já existia', async () => {
    const sam = `ldap${newId().slice(0, 6).toLowerCase()}`;
    const guid = crypto.randomBytes(16);
    let mail = `${sam}@explorer.test`;
    const source = (): LdapSource => ({
      async *users() {
        yield [
          {
            dn: `CN=${sam},OU=SAC,OU=Explorer,DC=explorer,DC=test`,
            objectClass: ['top', 'person', 'organizationalPerson', 'user'],
            sAMAccountName: sam,
            cn: sam,
            mail,
            objectGUID: guid,
            userAccountControl: '512',
          },
        ];
      },
      async groupsOf() {
        return [];
      },
      async close() {},
    });
    await updateSettings({ LDAP_Enable: true, LDAP_Url: 'ldap://127.0.0.1:9', LDAP_Sync_User_Active_State: false });
    try {
      await runSync({ trigger: 'manual', startedBy: A.userId, source: source() });
      const created = await one('SELECT id, email, email_verified FROM users WHERE username = $1', [sam]);
      expect(created).toMatchObject({ email: mail, email_verified: true });
      // Confirmação perdida (ou conta antiga): a próxima sincronização confirma de novo.
      await pool.query('UPDATE users SET email_verified = false WHERE id = $1', [created.id]);
      await runSync({ trigger: 'manual', startedBy: A.userId, source: source() });
      expect((await one('SELECT email_verified FROM users WHERE id = $1', [created.id])).email_verified).toBe(true);
      // E-mail novo no diretório: trocado e confirmado.
      await pool.query('UPDATE users SET email_verified = false WHERE id = $1', [created.id]);
      mail = `${sam}.novo@explorer.test`;
      await runSync({ trigger: 'manual', startedBy: A.userId, source: source() });
      expect(await one('SELECT email, email_verified FROM users WHERE id = $1', [created.id])).toEqual({ email: mail, email_verified: true });
      // E-mail do diretório já usado por outra conta: não é trocado nem confirmado.
      const other = await newUser(A);
      await pool.query('UPDATE users SET email_verified = false WHERE id = $1', [created.id]);
      mail = `${other.username}@test.local`;
      await runSync({ trigger: 'manual', startedBy: A.userId, source: source() });
      expect(await one('SELECT email, email_verified FROM users WHERE id = $1', [created.id])).toEqual({ email: `${sam}.novo@explorer.test`, email_verified: false });
    } finally {
      await updateSettings({ LDAP_Enable: false, LDAP_Url: '' });
    }
  });
});

// =====================================================================================================================
// Revisão do núcleo: cada caso volta a falhar se a correção sair.
// =====================================================================================================================

// O que o chat (web/src/lib/markdown.tsx) transforma em link, menção ou canal: cópia da regex INLINE de lá, com a mesma
// recursão em negrito, itálico e tachado. É o oráculo do texto que vem de fora.
const WEB_MD_LINK = '\\[[^\\[\\]\\n]+\\]\\((?:https?:\\/\\/|\\/)(?:[^)\\s\\[]|\\[(?![^\\[\\]\\n]*\\]\\())+\\)';
const WEB_INLINE = new RegExp(
  [
    '(`[^`\\n]+`)',
    `(${WEB_MD_LINK})`,
    '((?:https?:\\/\\/|www\\.)[^\\s<]+[^\\s<.,;:!?)\\]\'"])',
    '(\\*\\*[^*\\n]+\\*\\*|\\*[^*\\s][^*\\n]*\\*)',
    '(__[^_\\n]+__|(?<![\\w])_[^_\\s][^_\\n]*_(?![\\w]))',
    '(~~[^~\\n]+~~|~[^~\\s][^~\\n]*~)',
    '((?<![\\w@])@[0-9a-zA-Z._-]+)',
    '((?<![\\w#&])#[0-9a-zA-Z\\u00C0-\\u017F._-]+)',
    '(:[a-z0-9_+\\-]+:)',
  ].join('|'),
  'g',
);
function webTokens(text: string): { kind: 'link' | 'mention' | 'channel'; value: string }[] {
  const out: { kind: 'link' | 'mention' | 'channel'; value: string }[] = [];
  for (const m of text.matchAll(WEB_INLINE)) {
    const [, code, mdLink, url, bold, italic, strike, mention, chan] = m;
    if (code) continue;
    if (mdLink) out.push({ kind: 'link', value: /^\[([^\]]+)\]\(([^)]+)\)$/.exec(mdLink)![2] });
    else if (url) out.push({ kind: 'link', value: url.startsWith('www.') ? `https://${url}` : url });
    else if (bold) out.push(...webTokens(bold.startsWith('**') ? bold.slice(2, -2) : bold.slice(1, -1)));
    else if (italic) out.push(...webTokens(italic.startsWith('__') ? italic.slice(2, -2) : italic.slice(1, -1)));
    else if (strike) out.push(...webTokens(strike.startsWith('~~') ? strike.slice(2, -2) : strike.slice(1, -1)));
    else if (mention) out.push({ kind: 'mention', value: mention.slice(1) });
    else if (chan) out.push({ kind: 'channel', value: chan.slice(1) });
  }
  return out;
}
// renderMarkdown de lá: os blocos ``` saem antes, depois linha a linha, sem o "> " da citação, o "# " do título e o
// "- " da lista.
function webRender(text: string) {
  return text.split(/```/).flatMap((part, i) =>
    i % 2 === 1
      ? []
      : part.split('\n').flatMap((line) => {
          const l = line.replace(/^(>\s?)+/, '');
          const h = /^(#{1,4})\s+(\S.*)$/.exec(l);
          const li = /^\s*[-*•]\s+(\S.*)$/.exec(l);
          return webTokens(h ? h[2] : li ? li[1] : l);
        }),
  );
}
const linkHosts = (text: string) => webRender(text).filter((t) => t.kind === 'link').map((t) => new URL(t.value).hostname);

describe('Revisão do núcleo', () => {
  it('safeExternalText: um segundo endereço dentro do primeiro, um www. no meio ou no destino de um link markdown não fica clicável', () => {
    const evil = [
      'Veja https://x/https://evil.example/login',
      '[Seu acesso expira](https://a/https://evil.example)',
      'Veja www.a.example/www.evil.example',
      'https://www.evil.example/phish',
      '[Clique aqui](https://www.evil.example/login)',
      'http://evil.example/?next=www.evil2.example',
      'HTTPS://EVIL.EXAMPLE/x e WWW.EVIL.EXAMPLE',
      'wwww.evil.example e https://https://evil.example',
    ];
    for (const s of evil) {
      const out = safeExternalText(s);
      expect(linkHosts(out), `${s} → ${out}`).toEqual([]);
      // O endereço continua à mostra (só fica sem clique).
      expect(out.replace(/​/g, '')).toBe(s);
    }
    // O controle: links de hosts confiáveis seguem clicáveis, inteiros.
    for (const ok of ['https://explorer.atlassian.net/browse/OPS-1']) {
      expect(safeExternalText(ok)).toBe(ok);
      expect(linkHosts(safeExternalText(ok))).toEqual(['explorer.atlassian.net']);
    }
    // Um endereço dentro do link confiável vira texto (o link de fora continua clicável, até o fim).
    const next = 'https://explorer.atlassian.net/browse/OPS-1?next=https://evil.example';
    expect(safeExternalText(next)).toBe(`https://explorer.atlassian.net/browse/OPS-1?next=https:${ZW}//evil.example`);
    expect(linkHosts(safeExternalText(next))).toEqual(['explorer.atlassian.net']);
  });

  it('neutralizeMentions: @all, @here, @nome e #sala depois de pontuação ou dentro de *negrito*, _itálico_ e ~tachado~ ficam como texto; e-mails intactos', () => {
    for (const s of ['*@all* sistema fora do ar', '_@here_', 'oi,@here', '[@all]', 'x:@all', '~@ana.souza~', '**#financeiro**', 'ver;#financeiro', 'joão@all', '(@all)', '"@here"', '@all', '#@all', '@#financeiro', 'x__@all__', '__#financeiro__', 'a _@here_ b']) {
      const out = safeExternalText(s);
      expect(webTokens(out).filter((t) => t.kind !== 'link'), `${s} → ${out}`).toEqual([]);
      expect(out.replace(/​/g, '')).toBe(s);
    }
    for (const mail of ['ana@explorer.com.br', 'ana.souza_2@explorer.com.br', 'fila&#35;1']) expect(safeExternalText(mail)).toBe(mail);
  });

  it('F11: o robô também não abre uma DM nova, nem por um webhook de entrada com o usuário do robô', async () => {
    const bot = await ensureBotUser('jira');
    const U = await newUser(A);
    await expect(createDirect(botCtx(bot), [U.username])).rejects.toMatchObject({ statusCode: 400, errorType: 'error-integration-bot-direct' });
    expect(await one(`SELECT 1 FROM rooms WHERE t = 'd' AND $1 = ANY(uids) AND $2 = ANY(uids)`, [bot.id, U.userId])).toBeNull();
    const msg = 'O robô do Jira ou do Teams não pode publicar por um webhook.';
    expect(await api('POST', 'integrations.create', { type: 'webhook-incoming', name: 'Relé', username: bot.username, channel: `@${U.username}` }, A)).toMatchObject({ status: 400, errorType: 'error-invalid-user', error: msg });
    expect(await api('POST', 'integrations.create', { type: 'webhook-incoming', name: 'Relé', username: bot.username, channel: '#geral' }, A)).toMatchObject({ status: 400, error: msg });
    const generic = await api('POST', 'integrations.create', { type: 'webhook-incoming', name: 'Genérico', username: 'admin', channel: '#geral' }, A);
    expect(generic.success).toBe(true);
    expect(await api('PUT', 'integrations.update', { integrationId: generic.integration._id, name: 'Genérico', username: BOTS.msteams.username, channel: '#geral' }, A)).toMatchObject({ status: 400, error: msg });
    await api('POST', 'integrations.remove', { integrationId: generic.integration._id }, A);
  });

  it('sweepJobs: uma tarefa que travou ou derrubou o servidor na última tentativa vira dead (atividade, erro na regra, alerta) e não segura o grupo', async () => {
    await updateSettings({ Jira_Enabled: true });
    try {
      const ran: string[] = [];
      const kind = kindFor(async (j) => void ran.push(j.id), { describe: () => 'Aviso de teste' });
      const rule = await managedRule('jira-events', A.userId, A.username);
      const group = `jira:${rule}:sala`;
      const poison = await enqueue(kind, { n: 1 }, { integrationId: rule, groupKey: group, maxAttempts: 3 });
      const next = await enqueue(kind, { n: 2 }, { integrationId: rule, groupKey: group, maxAttempts: 3 });
      const crashed = await enqueue(kind, { n: 3 }, { maxAttempts: 3 });
      await pool.query(`UPDATE integration_jobs SET status = 'running', attempts = 3, locked_by = 'x', locked_at = now() - interval '10 minutes' WHERE id = $1`, [poison]);
      await pool.query(`UPDATE integration_jobs SET status = 'running', attempts = 1, locked_by = 'x', locked_at = now() - interval '10 minutes' WHERE id = $1`, [crashed]);
      await sweepJobs();
      const text = 'A tarefa travou ou derrubou o servidor nas últimas tentativas.';
      expect(await jobRow(poison)).toMatchObject({ status: 'dead', attempts: 3, last_error: text, locked_by: null });
      expect(await jobRow(crashed)).toMatchObject({ status: 'queued', attempts: 1, locked_by: null });
      expect(await activityRows('job_id = $1', [poison])).toEqual([{ tone: 'err', text: `Aviso de teste: ${text}`, detail: `${kind} · tentativa 3 de 3`, integration_id: rule, job_id: poison }]);
      expect((await one('SELECT last_error FROM integrations WHERE id = $1', [rule])).last_error).toBe(text);
      expect(await getState<any>(`alert:jira.rule:${rule}`)).toMatchObject({ tone: 'err', text: `A regra “Regra jira-events” do Jira não conseguiu publicar: ${text}` });
      // O grupo segue: a próxima roda; a morta não roda de novo.
      await drainJobs({ kinds: [kind] });
      expect(ran.sort()).toEqual([next, crashed].sort());
      expect((await jobRow(poison)).status).toBe('dead');
      await clearAlert(`jira.rule:${rule}`);
      await pool.query('DELETE FROM integrations WHERE id = $1', [rule]);
    } finally {
      await updateSettings({ Jira_Enabled: false });
    }
  });

  it('chave diferente da das outras instâncias é percebida sem o agendador: salvar é recusado e as integrações param', async () => {
    const before = await getState('secrets.kid');
    const hookCalls: number[] = [];
    const hook = wrapHook<number>('jira', 'teste sem agendador', async (n) => void hookCalls.push(n));
    try {
      await setState('secrets.kid', { kid: 'deadbeef' });
      reloadSecretsKey(); // como uma instância que acabou de subir com DISABLE_CRON=1 (nenhum runtime rodando)
      await expect(setSecret('jira.webhookToken', 'valor-de-teste-123', A.userId)).rejects.toMatchObject({ statusCode: 500, errorType: 'error-secret-key', message: KEY_MISMATCH });
      expect(await one(`SELECT 1 FROM integration_secrets WHERE id = 'jira.webhookToken'`)).toBeNull();
      expect(integrationsPaused()).toBe(true);
      await hook(1);
      expect(hookCalls).toEqual([]);
      const u = await newUser(A);
      await expect(
        saveLinked({ userId: u.userId, provider: 'microsoft', method: 'directory', externalId: `oid-${newId()}`, displayName: 'Ana', email: null, site: null, tokenExpiresAt: null, secretExpiresAt: null, scopes: [], meta: {}, access: 'tok-a', refresh: 'tok-r' }),
      ).rejects.toMatchObject({ errorType: 'error-secret-key' });
      expect(await getLinked(u.userId, 'microsoft')).toBeNull();
    } finally {
      await setState('secrets.kid', before);
      reloadSecretsKey();
      await checkSharedKey();
    }
    expect(integrationsPaused()).toBe(false);
    await hook(2);
    expect(hookCalls).toEqual([2]);
  });

  it('reencryptAll numa instância com a chave errada é recusado e não muda a referência; com descarte explícito, a chave atual passa a valer', async () => {
    const goodKey = TEST_KEY;
    await setSecret('msteams.clientSecret', 'segredo-do-entra-654321', A.userId);
    const ref = await getState<{ kid: string }>('secrets.kid');
    expect(ref).toEqual({ kid: kidOfKey(goodKey) });
    const wrongKey = crypto.randomBytes(32).toString('base64');
    process.env.SECRETS_KEY = wrongKey;
    reloadSecretsKey();
    try {
      await checkSharedKey();
      expect(keyMismatch()).toBe(true);
      await expect(reencryptAll()).rejects.toMatchObject({ statusCode: 500, errorType: 'error-secret-key', message: KEY_MISMATCH });
      expect(await api('POST', 'integrations.secretsKey.reencrypt', {}, A)).toMatchObject({ status: 500, errorType: 'error-secret-key' });
      expect(await getState('secrets.kid')).toEqual(ref);
      expect(keyMismatch()).toBe(true);
      // Chave antiga perdida de verdade: o administrador confirma o descarte e cadastra de novo o que não abre.
      const r = await api('POST', 'integrations.secretsKey.reencrypt', { discardUnreadable: true }, A);
      expect(r).toMatchObject({ success: true, count: 0 });
      expect(r.unreadable).toBeGreaterThanOrEqual(1);
      expect(await getState('secrets.kid')).toEqual({ kid: kidOfKey(wrongKey) });
      expect(keyMismatch()).toBe(false);
      expect(await secretState('msteams.clientSecret')).toMatchObject({ set: true, unreadable: true });
    } finally {
      process.env.SECRETS_KEY = goodKey;
      reloadSecretsKey();
      await setState('secrets.kid', ref);
      await checkSharedKey();
      await setSecret('msteams.clientSecret', null, A.userId);
    }
    expect(integrationsPaused()).toBe(false);
  });

  it('INTEGRATIONS_ALLOWED_HOSTS: uma entrada sem porta vale só para https na 443; http precisa de host:80 (safeFetch e o site do Jira)', () => {
    const saved = process.env.INTEGRATIONS_ALLOWED_HOSTS;
    process.env.INTEGRATIONS_ALLOWED_HOSTS = 'jira.empresa.local,ci.empresa.local:80';
    try {
      expect(() => checkOutboundUrl('http://jira.empresa.local/rest/api/3/myself')).toThrow(expect.objectContaining({ code: 'error-url-not-allowed' }));
      expect(checkOutboundUrl('https://jira.empresa.local/rest/api/3/myself').hostname).toBe('jira.empresa.local');
      expect(checkOutboundUrl('http://ci.empresa.local/x').hostname).toBe('ci.empresa.local');
      expect(() => checkOutboundUrl('https://ci.empresa.local/x')).toThrow(expect.objectContaining({ code: 'error-url-not-allowed' }));
      const allowed = ['jira.empresa.local', 'ci.empresa.local:80'];
      expect(jiraSiteAllowed('http://jira.empresa.local', allowed)).toEqual({ problem: 'Use o endereço https do Jira Cloud, por exemplo https://explorer.atlassian.net.' });
      expect(jiraSiteAllowed('https://jira.empresa.local', allowed)).toEqual({ origin: 'https://jira.empresa.local' });
      expect(jiraSiteAllowed('http://ci.empresa.local', allowed)).toEqual({ origin: 'http://ci.empresa.local' });
    } finally {
      if (saved === undefined) delete process.env.INTEGRATIONS_ALLOWED_HOSTS;
      else process.env.INTEGRATIONS_ALLOWED_HOSTS = saved;
    }
  });

  it('checkTargets não mostra o nome nem as marcas de uma sala que a pessoa não pode ver', async () => {
    const M = await newUser(A, { roles: ['user', 'admin'] });
    const secret = await api('POST', 'groups.create', { name: uniq('segredo') }, A);
    expect(secret.group).toBeTruthy();
    const teamName = uniq('time-fechado');
    const team = await api('POST', 'teams.create', { name: teamName, type: 1 }, A);
    const teamRoom = await api('POST', 'teams.createRoom', { teamId: team.team._id, name: uniq('canal-fechado'), type: 'c' }, A);
    const ch = await channel(A);
    const disc = await api('POST', 'rooms.createDiscussion', { prid: secret.group._id, t_name: uniq('discussao-secreta') }, A);
    expect(disc.discussion).toBeTruthy();
    const ids = [secret.group._id, teamRoom.room._id, disc.discussion._id, 'nao-existe'];
    const checks = (await api('POST', 'integrations.targets.check', { provider: 'jira', roomIds: ids }, M)).targets;
    expect(checks.map((c: any) => c.ok)).toEqual([false, false, false, false]);
    for (const c of checks) expect(c.room).toEqual({ _id: c.room._id, name: '', t: 'c', notice: false, archived: false, ro: false });
    expect(checks.map((c: any) => c.room._id)).toEqual(ids);
    // Quem pode ver continua vendo o nome (também numa recusa).
    const mine = await checkTargets(ctxOf(A), 'jira', [disc.discussion._id, ch._id], 'post', false);
    expect(mine[0]).toMatchObject({ ok: false, problem: 'Discussões não podem ser usadas em integrações.' });
    expect(mine[0].room.name).not.toBe('');
    expect(mine[1].room.name).toBe(ch.name);
  });

  it('saveLinked sem token novo e com outra origem do Jira não leva o token antigo para o site novo', async () => {
    const u = await newUser(A);
    const base = { userId: u.userId, provider: 'jira' as const, method: 'token' as const, externalId: `acc-${newId()}`, displayName: 'Ana', email: null, tokenExpiresAt: null, secretExpiresAt: null, scopes: [], meta: {} };
    await saveLinked({ ...base, site: 'https://a.atlassian.net', access: 'tok-teste-site-a-123456' });
    expect((await linkedSecrets(u.userId, 'jira', 'https://a.atlassian.net')).access).toBe('tok-teste-site-a-123456');
    await saveLinked({ ...base, site: 'https://evil.atlassian.net' });
    expect(await linkedSecrets(u.userId, 'jira', 'https://evil.atlassian.net')).toEqual({ access: null, refresh: null });
    const row = await one('SELECT access_token, refresh_token, status, status_text, site FROM linked_accounts WHERE user_id = $1', [u.userId]);
    expect(row).toEqual({ access_token: null, refresh_token: null, status: 'expired', status_text: 'O endereço do Jira mudou. Conecte sua conta de novo.', site: 'https://evil.atlassian.net' });
    // Com token novo, a conta volta a valer no site novo.
    await saveLinked({ ...base, site: 'https://evil.atlassian.net', access: 'tok-teste-site-b-654321' });
    expect(await linkedSecrets(u.userId, 'jira', 'https://evil.atlassian.net')).toEqual({ access: 'tok-teste-site-b-654321', refresh: null });
    expect((await getLinked(u.userId, 'jira'))?.status).toBe('ok');
  });

  it('OAuth: duas abas da mesma sessão valem as duas sem o navegador mandar o cookie de /integrations/ para /api/; outra sessão não', async () => {
    const begin = async (sessionId: string) => {
      const { reply, headers } = fakeReply();
      reply.request.ctx = { userId: A.userId, username: A.username, sessionId };
      const { state } = await startOAuth(reply, { purpose: 'jira-user', userId: A.userId, redirectUri: 'http://localhost:3000/integrations/jira/callback', returnTo: '/account/connected' });
      return { state, nonce: cookieValue(headers['set-cookie']).value };
    };
    const tab1 = await begin('sessao-1');
    const tab2 = await begin('sessao-1');
    expect(tab2.nonce).toBe(tab1.nonce);
    expect(tab1.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // O navegador guarda só o último cookie; a primeira aba termina com ele.
    expect((await finishOAuth(fakeReq(tab1.state, tab2.nonce), 'jira-user')).userId).toBe(A.userId);
    expect((await finishOAuth(fakeReq(tab2.state, tab2.nonce), 'jira-user')).userId).toBe(A.userId);
    const other = await begin('sessao-2');
    expect(other.nonce).not.toBe(tab1.nonce);
    await expect(finishOAuth(fakeReq(other.state, tab1.nonce), 'jira-user')).rejects.toBeInstanceOf(OAuthStateError);
    // Sem sessão (token de acesso pessoal sem id de sessão): nonce novo a cada vez.
    expect((await begin('')).nonce).not.toBe((await begin('')).nonce);
  });

  it('overview: paused só com a chave diferente da das outras instâncias; sem chave é source none (e as integrações ficam paradas)', async () => {
    delete process.env.SECRETS_KEY;
    reloadSecretsKey();
    try {
      expect(integrationsPaused()).toBe(true);
      expect(await api('GET', 'integrations.overview', undefined, A)).toMatchObject({ paused: false, secretsKey: { source: 'none', created: false } });
    } finally {
      process.env.SECRETS_KEY = TEST_KEY;
      reloadSecretsKey();
    }
  });

  it('o caminho do arquivo da chave e o erro do sistema só aparecem para o papel admin', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wescc-chave-'));
    const file = path.join(dir, 'nao-existe', 'integrations-key.txt');
    const savedRoles = rolesWithPermission('manage-jira');
    delete process.env.SECRETS_KEY;
    process.env.SECRETS_KEY_FILE = file;
    reloadSecretsKey();
    try {
      const U = await newUser(A);
      await setPermissionRoles([{ _id: 'manage-jira', roles: [...savedRoles, 'user'] }]);
      const forU = await api('GET', 'integrations.overview', undefined, U);
      expect(forU.secretsKey.source).toBe('file');
      expect(forU.secretsKey.file).toBeUndefined();
      expect(forU.secretsKey.problem).toBe('Não foi possível criar a chave de segredos das integrações no arquivo de SECRETS_KEY_FILE. Confira se a pasta existe e se o serviço pode gravar nela.');
      expect(JSON.stringify(forU)).not.toContain(dir);
      expect(JSON.stringify(forU)).not.toContain('ENOENT');
      const forA = await api('GET', 'integrations.overview', undefined, A);
      expect(forA.secretsKey.file).toBe(file);
      expect(forA.secretsKey.problem).toContain(file);
      const e = await setSecret('jira.webhookToken', 'valor-de-teste-123', A.userId).then(() => null, (x) => x);
      expect(e).toMatchObject({ statusCode: 500, errorType: 'error-secret-key-missing' });
      expect(e.message).not.toContain(dir);
    } finally {
      await setPermissionRoles([{ _id: 'manage-jira', roles: savedRoles }]);
      delete process.env.SECRETS_KEY_FILE;
      process.env.SECRETS_KEY = TEST_KEY;
      reloadSecretsKey();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('conferência diária: o token da integração do Jira e o segredo do Entra já vencidos mantêm o alerta (com “expirou”)', async () => {
    const past = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    await setSecret('jira.apiToken', 'ATATT3x-token-vencido-123', A.userId, { boundTo: 'https://explorer.atlassian.net', expiresAt: past });
    await setSecret('msteams.clientSecret', 'segredo-vencido-do-entra-123', A.userId, { expiresAt: past });
    try {
      await runDailyChecks();
      expect(await getState<any>('alert:jira.token')).toMatchObject({ tone: 'err', text: 'O token da conta da integração do Jira expirou. Gere um novo e cadastre na conexão do Jira.' });
      expect(await getState<any>('alert:msteams.secret')).toMatchObject({ tone: 'err', text: 'O segredo do aplicativo do Microsoft Entra expirou. Crie um novo e cadastre na conexão do Teams.' });
      // Dentro dos 14 dias: o texto do §3.14.
      const soon = new Date(Date.now() + 3 * 24 * 3600_000 - 60_000).toISOString();
      await setSecret('jira.apiToken', 'ATATT3x-token-vencido-123', A.userId, { boundTo: 'https://explorer.atlassian.net', expiresAt: soon });
      await runDailyChecks();
      expect(await getState<any>('alert:jira.token')).toMatchObject({ tone: 'warn', text: 'O token da conta da integração do Jira expira em 3 dias.' });
      // Token pessoal do Jira já vencido: o alerta da pessoa também fica.
      const u = await newUser(A);
      await saveLinked({ userId: u.userId, provider: 'jira', method: 'token', externalId: `acc-${newId()}`, displayName: 'Ana', email: null, site: 'https://explorer.atlassian.net', tokenExpiresAt: null, secretExpiresAt: new Date(past), scopes: [], meta: {}, access: 'tok-teste-pessoal-vencido-123' });
      await runDailyChecks();
      expect(await getState<any>(`alert:jira.linked:${u.userId}`)).toMatchObject({ tone: 'err', text: 'Conecte sua conta do Jira de novo em Minha conta → Contas conectadas.' });
      await pool.query('DELETE FROM linked_accounts WHERE user_id = $1', [u.userId]);
      await setState(`alert:jira.linked:${u.userId}`, null);
    } finally {
      await setSecret('jira.apiToken', null, A.userId);
      await setSecret('msteams.clientSecret', null, A.userId);
      await runDailyChecks();
    }
    expect(await getState('alert:jira.token')).toBeNull();
    expect(await getState('alert:msteams.secret')).toBeNull();
  });

  it('instalador (texto): -RemoveSecrets apaga o proxy das integrações; -RotateSecretsKey e -FinishSecretsKeyRotation fazem a troca de chave do README', () => {
    const ps1 = fs.readFileSync(path.resolve(import.meta.dirname, '../../scripts/windows/install-chat-service.ps1'), 'utf8');
    const readme = fs.readFileSync(path.resolve(import.meta.dirname, '../../README.md'), 'utf8');
    expect(ps1).toContain('[switch]$RotateSecretsKey,');
    expect(ps1).toContain('[switch]$FinishSecretsKeyRotation,');
    expect(ps1).toContain("$IntegrationsKeyPreviousFile = Join-Path $SecretsDir 'integrations-key-previous.txt'");
    expect(ps1).toContain("if (Test-Path -LiteralPath $IntegrationsKeyPreviousFile) { $envVars['SECRETS_KEY_PREVIOUS_FILE'] = $IntegrationsKeyPreviousFile }");
    // A chave atual vira a anterior antes de a nova ser criada; a anterior só sai quando pedem.
    const rotate = ps1.indexOf('if ($RotateSecretsKey) {');
    expect(rotate).toBeGreaterThan(-1);
    expect(rotate).toBeLessThan(ps1.indexOf('if (Test-Path -LiteralPath $IntegrationsKeyFile) {\n  Ok "Chave de segredos das integrações'));
    expect(ps1).toContain('[IO.File]::Move($IntegrationsKeyFile, $IntegrationsKeyPreviousFile)');
    // -RemoveSecrets também apaga o proxy das integrações (pode ter usuário e senha).
    const uninstall = ps1.slice(ps1.indexOf('# Integrações (Jira/Teams): a chave fica sempre.'), ps1.indexOf('if (Test-Path -LiteralPath $InstallJson) {\n    Invoke-Step "Anotar a remoção'));
    expect(uninstall).toContain('Invoke-Step "Apagar $IntegrationsProxyFile" { Remove-Item -LiteralPath $IntegrationsProxyFile -Force }');
    expect(readme).toContain('-RotateSecretsKey');
    expect(readme).toContain('-FinishSecretsKeyRotation');
  });

  it('fake-vendors: sobe os falsos dos testes, com consentimento do Jira (Ana ou Bruno), GUIDs do Entra, token JWT e eventos simulados', async () => {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/proxy/i.test(k)) env[k] = v;
    Object.assign(env, { NODE_ENV: 'development', INTEGRATIONS_DEV_ENDPOINTS: '1' });
    const child = spawn(process.execPath, ['--import', 'tsx', path.resolve(import.meta.dirname, '../scripts/fake-vendors.ts')], { cwd: path.resolve(import.meta.dirname, '..'), env });
    const killer = setTimeout(() => child.kill('SIGKILL'), 50_000);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    try {
      for (let i = 0; i < 200 && !out.includes('Ctrl+C encerra.'); i++) await new Promise((r) => setTimeout(r, 100));
      expect(out).toContain('Ctrl+C encerra.');
      const jiraUrl = /Jira em (http:\/\/127\.0\.0\.1:\d+)/.exec(out)![1];
      const msUrl = /Microsoft em (http:\/\/127\.0\.0\.1:\d+)/.exec(out)![1];
      expect(out).toContain(`export INTEGRATIONS_ALLOWED_HOSTS=${new URL(jiraUrl).host},${new URL(msUrl).host}`);
      const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      const tenant = /ID do locatário: (\S+)/.exec(out)![1];
      const client = /ID do aplicativo \(cliente\): (\S+)/.exec(out)![1];
      const clientSecret = /Segredo do aplicativo: (\S+)/.exec(out)![1];
      expect(tenant).toMatch(guid);
      expect(client).toMatch(guid);
      expect(out).not.toContain('qualquer texto');

      // Jira: tela de consentimento com duas pessoas; o código vale para quem foi escolhido.
      const back = 'http://localhost:9/integrations/jira/callback';
      const page = await fetch(`${jiraUrl}/authorize?${new URLSearchParams({ redirect_uri: back, state: 'st-1' })}`);
      const pageHtml = await page.text();
      expect(pageHtml).toContain('Ana Teste');
      expect(pageHtml).toContain('Bruno Teste');
      const whoAuthorized = async (conta: string) => {
        const r = await fetch(`${jiraUrl}/authorize/escolher?${new URLSearchParams({ conta, redirect_uri: back, state: 'st-1' })}`, { redirect: 'manual' });
        const loc = new URL(r.headers.get('location')!);
        expect(loc.searchParams.get('state')).toBe('st-1');
        const tok = await (await fetch(`${jiraUrl}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', code: loc.searchParams.get('code') }) })).json();
        const { cloudId } = await (await fetch(`${jiraUrl}/_edge/tenant_info`)).json();
        return (await (await fetch(`${jiraUrl}/ex/jira/${cloudId}/rest/api/3/myself`, { headers: { authorization: `Bearer ${tok.access_token}` } })).json()).accountId;
      };
      const ana = await whoAuthorized('ana');
      const bruno = await whoAuthorized('bruno');
      expect(ana).toBeTruthy();
      expect(bruno).toBeTruthy();
      expect(ana).not.toBe(bruno);
      // Tokens pessoais do banner, a conta da integração e um tipo de issue com campos personalizados obrigatórios.
      const [, anaEmail, anaToken] = /^ {4}(\S+), token (\S+)$/m.exec(out)!;
      const basic = (e: string, t: string) => ({ authorization: `Basic ${Buffer.from(`${e}:${t}`).toString('base64')}` });
      expect((await (await fetch(`${jiraUrl}/rest/api/3/myself`, { headers: basic(anaEmail, anaToken) })).json()).accountId).toBe(ana);
      const [, svcEmail, svcToken] = /Conta da integração: (\S+), token (\S+)/.exec(out)!;
      const svc = basic(svcEmail, svcToken);
      const fields = (await (await fetch(`${jiraUrl}/rest/api/3/issue/createmeta/OPS/issuetypes/10010`, { headers: svc })).json()).fields;
      expect(fields.some((f: any) => f.required && String(f.fieldId).startsWith('customfield_'))).toBe(true);
      // Mudança simulada: aparece no histórico que a consulta lê.
      const upd = await fetch(`${jiraUrl}/__fake/jira/issue-updated`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'OPS-1', status: 'Concluído' }) });
      expect(upd.status).toBe(200);
      const log = await (await fetch(`${jiraUrl}/rest/api/3/issue/OPS-1/changelog`, { headers: svc })).json();
      expect(log.values.at(-1).items[0]).toMatchObject({ field: 'status', toString: 'Concluído' });

      // Microsoft: login da conta de serviço com PKCE, token em formato JWT e mensagem simulada num canal.
      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const msBack = 'http://localhost:9/integrations/msteams/callback';
      const auth = await fetch(`${msUrl}/${tenant}/oauth2/v2.0/authorize?${new URLSearchParams({ client_id: client, redirect_uri: msBack, code_challenge: challenge, code_challenge_method: 'S256', scope: 'offline_access ChannelMessage.Read.All', state: 'st-2' })}`, { redirect: 'manual' });
      const msLoc = new URL(auth.headers.get('location')!);
      expect(msLoc.searchParams.get('state')).toBe('st-2');
      const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: client, client_secret: clientSecret, code: msLoc.searchParams.get('code')!, code_verifier: verifier, redirect_uri: msBack, scope: 'offline_access ChannelMessage.Read.All' });
      const msTok = await (await fetch(`${msUrl}/${tenant}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form })).json();
      const parts = String(msTok.access_token).split('.');
      expect(parts).toHaveLength(3);
      expect(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))).toMatchObject({ tid: tenant });
      const graph = { authorization: `Bearer ${msTok.access_token}` };
      const teams = (await (await fetch(`${msUrl}/v1.0/me/joinedTeams`, { headers: graph })).json()).value;
      const team = teams.find((t: any) => t.displayName === 'Operação (teste)');
      const channels = (await (await fetch(`${msUrl}/v1.0/teams/${team.id}/channels`, { headers: graph })).json()).value;
      const channel = channels.find((c: any) => c.displayName === 'Avisos do turno');
      const sent = await (await fetch(`${msUrl}/__fake/teams/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ canal: 'Avisos do turno', texto: 'Bom dia, turno' }) })).json();
      expect(sent).toMatchObject({ ok: true, canal: 'Avisos do turno' });
      const msgs = (await (await fetch(`${msUrl}/v1.0/teams/${team.id}/channels/${encodeURIComponent(channel.id)}/messages`, { headers: graph })).json()).value;
      expect(msgs.map((m: any) => m.id)).toContain(sent.id);
    } finally {
      clearTimeout(killer);
      child.kill('SIGTERM');
      await new Promise((ok) => (child.exitCode !== null ? ok(null) : child.on('exit', ok)));
    }
  }, 60_000);
});

// =====================================================================================================================
// Verificação do núcleo: cada caso volta a falhar se a correção sair.
// =====================================================================================================================

describe('Verificação do núcleo', () => {
  it('safeExternalText: num endereço de host confiável, o fim de *, _, ~, ` ou ```, um :emoji: antes ou o começo em maiúsculas não deixam um endereço de fora clicável', () => {
    const evil = [
      // O chat corta o link confiável no fim do *negrito*, _itálico_, ~tachado~, `código` ou ``` e lê o resto de novo.
      '*https://explorer.atlassian.net/*https://evil.example/login',
      'Veja **https://explorer.atlassian.net/**https://evil.example/login',
      '~https://explorer.atlassian.net/~https://evil.example/login',
      '__https://explorer.atlassian.net/__https://evil.example/login',
      '_https://explorer.atlassian.net/_.https://evil.example/login',
      '`x https://explorer.atlassian.net/`https://evil.example/login',
      'https://explorer.atlassian.net/```x```https://evil.example/login',
      '*www.atlassian.net/*www.evil.example/login',
      '*https://teams.microsoft.com/l/*https://evil.example/login',
      // Um :emoji: que começou antes come o "https" do começo, e o chat recomeça no do meio.
      ':xhttps://explorer.atlassian.net/?next=https://evil.example/login',
      // O chat só começa um link em minúsculas: o "https://" do meio é o que vira link.
      'Veja HTTPS://explorer.atlassian.net/https://evil.example/login',
      'Https://explorer.atlassian.net/x?next=https://evil.example/login',
      'WWW.atlassian.net/www.evil.example/login',
      // O corte cai antes do fim do host: o servidor lê o "@" do endereço inteiro, o chat abre só o começo.
      '*https://evil.example*@explorer.atlassian.net/browse/OPS-1',
      '~https://evil.example~@explorer.atlassian.net/',
      '__https://evil.example__@explorer.atlassian.net/',
      '_https://evil.example_.@explorer.atlassian.net/',
      'https://evil.example```@explorer.atlassian.net/',
      '*https:///evil.example*@explorer.atlassian.net/',
      '*https://\\evil.example*@explorer.atlassian.net/',
      '*www.evil.example*@explorer.atlassian.net/',
    ];
    for (const s of evil) {
      const out = safeExternalText(s);
      const hosts = linkHosts(out);
      expect(hosts.filter((h) => !trustedLinkHost(h)), `${s} → ${out} → ${hosts.join(', ')}`).toEqual([]);
      expect(out.replace(/​/g, '')).toBe(s);
    }
    // Controles: o link confiável continua clicável e igual, com *negrito* ou _itálico_ em volta e _ ou @ no caminho.
    for (const [ok, host] of [
      ['*https://explorer.atlassian.net/browse/OPS-1*', 'explorer.atlassian.net'],
      ['_https://explorer.atlassian.net/browse/OPS-1_', 'explorer.atlassian.net'],
      ['Veja www.atlassian.net/x', 'www.atlassian.net'],
      ['https://explorer.sharepoint.com/sites/ops/_layouts/15/Doc.aspx?id=1', 'explorer.sharepoint.com'],
      ['https://teams.microsoft.com/l/message/19:abc@thread.tacv2/1?tenantId=t', 'teams.microsoft.com'],
    ]) {
      expect(safeExternalText(ok)).toBe(ok);
      expect(linkHosts(safeExternalText(ok))).toEqual([host]);
    }
  });

  it('INTEGRATIONS_PROXY_FILE que não dá para ler: o erro do safeFetch e o do Jira não mostram o caminho nem o erro do sistema, que vão só para o log', async () => {
    const dir = path.join(os.tmpdir(), `wescc-sem-proxy-${crypto.randomUUID()}`);
    const file = path.join(dir, 'integrations-proxy.txt');
    const text = 'Não foi possível ler o arquivo do proxy das integrações (INTEGRATIONS_PROXY_FILE). Confira o caminho e se o serviço pode ler o arquivo.';
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => void logged.push(String(m)));
    const level = config.logLevel;
    config.logLevel = 'info';
    process.env.INTEGRATIONS_PROXY_FILE = file;
    try {
      const e = await safeFetch('https://explorer.atlassian.net/rest/api/3/myself', { timeoutMs: 2000 }).catch((x) => x);
      expect(e).toMatchObject({ code: 'error-proxy', message: text });
      // O cliente do Jira repassa o texto do proxy (teste da conexão, status, alerta jira.connection).
      const client = rawClient({ kind: 'integration' }, 'https://explorer.atlassian.net', 'https://explorer.atlassian.net', 'Basic dGVzdGU=');
      const j: Error = await client.get('/rest/api/3/myself').then(() => new Error('sem erro'), (x: Error) => x);
      expect(j).toMatchObject({ statusCode: 502, errorType: 'error-jira-unavailable', message: text });
      for (const m of [e.message, j.message]) {
        expect(m).not.toContain(dir);
        expect(m).not.toMatch(/não existe|ENOENT/);
      }
      // O caminho e o motivo ficam no log do servidor, uma vez por problema.
      expect(logged.filter((l) => l.includes(file) && l.includes('não existe'))).toHaveLength(1);
    } finally {
      delete process.env.INTEGRATIONS_PROXY_FILE;
      config.logLevel = level;
      spy.mockRestore();
    }
  });
});

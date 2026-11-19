import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, api, newUser, startServer, stopServer, type Auth } from './helpers';

// Auditoria e engajamento: data inválida é 400 "Data inválida." (antes 500), início depois do fim é recusado, o filtro
// do registro de ações acha por trecho e sem diferença de maiúsculas, e a auditoria entre usuários não ignora nome
// inexistente nem trata % como curinga (admsys-22, admsys-23, admsys-24).
let A: Auth;
let ana: Auth;
let bia: Auth;

beforeAll(async () => {
  await startServer();
  A = await admin();
  ana = await newUser(A);
  bia = await newUser(A);
  await api('POST', 'settings', { settings: { Site_Name: 'Empresa Auditada' } }, A);
});
afterAll(() => stopServer());

const day = (offset = 0) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);

describe('datas da auditoria e do engajamento', () => {
  it('data inválida vira 400 com mensagem clara', async () => {
    const cases: [string, string, Record<string, string> | undefined, Record<string, unknown> | undefined][] = [
      ['GET', 'engagement-dashboard/users', { start: 'abc' }, undefined],
      ['GET', 'engagement-dashboard/messages', { end: '2026-13-45' }, undefined],
      ['GET', 'engagement-dashboard/channels', { start: '2026-02-30' }, undefined],
      ['GET', 'audit.log', { startDate: 'abc' }, undefined],
      ['GET', 'audit.log', { end: 'ontem' }, undefined],
      ['GET', 'audit.settings', { start: '1' }, undefined],
    ];
    for (const [method, path, query] of cases) {
      const r = await api(method, path, query, A);
      expect([path, r.status, r.errorType, r.error]).toEqual([path, 400, 'error-invalid-date', 'Data inválida.']);
    }
    const m = await api('POST', 'audit.messages', { type: 'user', username: ana.username, startDate: 'abc', endDate: day() }, A);
    expect([m.status, m.error, m.details]).toEqual([400, 'Data inválida.', { param: 'startDate' }]);
  });

  it('início depois do fim e período longo demais são recusados', async () => {
    const inverted = await api('GET', 'engagement-dashboard/messages', { start: day(), end: day(-5) }, A);
    expect([inverted.status, inverted.error]).toEqual([400, 'A data inicial é depois da final.']);
    const auditInverted = await api('POST', 'audit.messages', { type: 'user', username: ana.username, startDate: new Date().toISOString(), endDate: new Date(Date.now() - 86400_000).toISOString() }, A);
    expect(auditInverted.error).toBe('A data inicial é depois da final.');
    const decade = await api('GET', 'engagement-dashboard/users', { start: '2016-01-01', end: day() }, A);
    expect([decade.status, decade.error]).toEqual([400, 'Escolha um período de até um ano.']);
    const startOnly = await api('GET', 'engagement-dashboard/users', { start: '2016-01-01' }, A);
    expect(startOnly.status).toBe(400);
    // Os formatos que a tela usa continuam valendo.
    expect((await api('GET', 'engagement-dashboard/users', { start: day(-89), end: day() }, A)).daily).toHaveLength(90);
    const iso = await api('POST', 'audit.messages', { type: 'user', username: ana.username, startDate: new Date(Date.now() - 86400_000).toISOString(), endDate: new Date().toISOString() }, A);
    expect(iso.status).toBe(200);
  });
});

describe('registro de ações', () => {
  it('ação por trecho e sem diferença de maiúsculas; * continua valendo', async () => {
    const partial = await api('GET', 'audit.log', { action: 'settings' }, A);
    expect(partial.total).toBeGreaterThan(0);
    expect(partial.events.every((e: any) => e.action.includes('settings'))).toBe(true);
    expect((await api('GET', 'audit.log', { action: 'SETTINGS.*' }, A)).total).toBe(partial.total);
    expect((await api('GET', 'audit.log', { action: 'chang' }, A)).events.some((e: any) => e.action === 'settings.changed')).toBe(true);
    // _ e % são texto, não curinga.
    expect((await api('GET', 'audit.log', { action: 'settings_changed' }, A)).total).toBe(0);
    expect((await api('GET', 'audit.log', { action: '%' }, A)).total).toBe(0);
  });

  it('quem fez: com ou sem @, maiúsculas e por trecho', async () => {
    for (const actor of ['admin', 'Admin', '@admin', 'adm']) {
      const r = await api('GET', 'audit.log', { actor }, A);
      expect([actor, r.total > 0, r.events.every((e: any) => e.actor.username === 'admin')]).toEqual([actor, true, true]);
    }
    expect((await api('GET', 'audit.log', { actor: 'ninguem' }, A)).total).toBe(0);
  });
});

describe('auditoria de mensagens', () => {
  it('conversa entre usuários: nome inexistente é recusado; % é procurado como texto', async () => {
    const dm = await api('POST', 'im.create', { username: bia.username }, ana);
    const rid = dm.room._id;
    await api('POST', 'chat.sendMessage', { message: { rid, msg: 'desconto de 10%' } }, ana);
    await api('POST', 'chat.sendMessage', { message: { rid, msg: 'sem porcentagem' } }, bia);
    const period = { startDate: new Date(Date.now() - 86400_000).toISOString(), endDate: new Date(Date.now() + 86400_000).toISOString() };

    const unknown = await api('POST', 'audit.messages', { type: 'u', users: [ana.username, 'naoexiste'], ...period }, A);
    expect([unknown.status, unknown.errorType, unknown.error]).toEqual([404, 'error-user-not-found', 'Usuário não encontrado: naoexiste.']);
    const same = await api('POST', 'audit.messages', { type: 'u', users: [ana.username, ana.username], ...period }, A);
    expect(same.error).toBe('Informe ao menos dois usuários.');

    const both = await api('POST', 'audit.messages', { type: 'u', users: [`@${ana.username.toUpperCase()}`, bia.username], ...period }, A);
    expect(both.messages.map((m: any) => m.msg).sort()).toEqual(['desconto de 10%', 'sem porcentagem']);
    const percent = await api('POST', 'audit.messages', { type: 'u', users: [ana.username, bia.username], msg: '%', ...period }, A);
    expect(percent.messages.map((m: any) => m.msg)).toEqual(['desconto de 10%']);
  });
});

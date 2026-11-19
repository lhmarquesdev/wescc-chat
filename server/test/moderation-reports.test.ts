import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool';
import { admin, api, newUser, startServer, stopServer, type Auth } from './helpers';

// Denúncias: motivo obrigatório, nada de denunciar a própria mensagem (ou a si mesmo), uma denúncia aberta por pessoa
// e mensagem, e usuário inexistente recusado (messages-29, admsys-25).
let A: Auth;
let ana: Auth;
let bia: Auth;
let rid: string;

const send = async (auth: Auth, msg: string) => (await api('POST', 'chat.sendMessage', { message: { rid, msg } }, auth)).message;
const report = (auth: Auth, messageId: string, description = 'conteúdo ofensivo') => api('POST', 'chat.reportMessage', { messageId, description }, auth);
const openReports = async (userId: string) => (await api('GET', 'moderation.userReports', { userId }, A)).reports as any[];

beforeAll(async () => {
  await startServer();
  A = await admin();
  ana = await newUser(A);
  bia = await newUser(A);
  rid = (await api('POST', 'channels.create', { name: 'denuncias', members: [ana.username, bia.username] }, A)).channel._id;
});
afterAll(() => stopServer());

describe('denúncia de mensagem', () => {
  it('exige o motivo e recusa a própria mensagem', async () => {
    const m = await send(ana, 'mensagem da ana');
    for (const description of ['', '   ', 'ok']) {
      const r = await report(bia, m._id, description);
      expect([r.status, r.errorType, r.error]).toEqual([400, 'error-report-reason', 'Informe o motivo da denúncia.']);
    }
    const own = await report(ana, m._id);
    expect([own.status, own.error]).toEqual([400, 'Você não pode denunciar a sua própria mensagem.']);
    expect(await openReports(ana.userId)).toEqual([]);
  });

  it('uma denúncia aberta por pessoa e mensagem; depois de descartada, pode denunciar de novo', async () => {
    const m = await send(ana, 'outra mensagem da ana');
    expect((await report(bia, m._id, '  motivo com espaços  ')).status).toBe(200);
    const again = await report(bia, m._id);
    expect([again.status, again.errorType, again.error]).toEqual([400, 'error-report-exists', 'Você já denunciou esta mensagem. A moderação vai analisar.']);
    expect((await report(A, m._id)).status).toBe(200);
    const rows = await openReports(ana.userId);
    expect(rows.map((r) => r.description).sort()).toEqual(['conteúdo ofensivo', 'motivo com espaços']);
    const list = await api('GET', 'moderation.reportsByUsers', {}, A);
    expect(list.reports.find((r: any) => r.userId === ana.userId).count).toBe(2);

    await api('POST', 'moderation.dismissReports', { msgId: m._id }, A);
    expect((await report(bia, m._id)).status).toBe(200);
  });
});

describe('denúncia de usuário', () => {
  it('recusa usuário inexistente, a si mesmo e a repetida', async () => {
    const ghost = await api('POST', 'moderation.reportUser', { userId: 'naoexiste', description: 'perfil falso' }, bia);
    expect([ghost.status, ghost.errorType, ghost.error]).toEqual([404, 'error-user-not-found', 'Usuário não encontrado.']);
    const self = await api('POST', 'moderation.reportUser', { userId: bia.userId, description: 'eu mesmo' }, bia);
    expect([self.status, self.error]).toEqual([400, 'Você não pode denunciar a si mesmo.']);
    const empty = await api('POST', 'moderation.reportUser', { userId: ana.userId, description: '' }, bia);
    expect(empty.errorType).toBe('error-report-reason');
    expect((await api('POST', 'moderation.reportUser', { userId: ana.userId, description: 'perfil falso' }, bia)).status).toBe(200);
    const again = await api('POST', 'moderation.reportUser', { userId: ana.userId, description: 'perfil falso' }, bia);
    expect([again.status, again.error]).toEqual([400, 'Você já denunciou esta pessoa. A moderação vai analisar.']);
    const list = await api('GET', 'moderation.reportsByUsers', {}, A);
    expect(list.reports.some((r: any) => r.username === null)).toBe(false);
    const n = await pool.query(`SELECT count(*)::int AS n FROM moderation_reports WHERE reported_user_id = 'naoexiste'`);
    expect(n.rows[0].n).toBe(0);
  });
});

describe('ações por denúncia na Moderação', () => {
  it('descarta uma mensagem, uma denúncia de pessoa e apaga só a mensagem escolhida', async () => {
    const keep = await send(ana, 'mensagem que fica');
    const drop = await send(ana, 'mensagem que sai');
    const reply = (await api('POST', 'chat.sendMessage', { message: { rid, msg: 'resposta denunciada', tmid: keep._id } }, ana)).message;
    for (const m of [keep, drop, reply]) expect((await report(bia, m._id)).status).toBe(200);
    expect((await report(A, keep._id)).status).toBe(200);

    let rows = await openReports(ana.userId);
    const row = rows.find((r) => r.messageId === reply._id);
    // "Abrir na conversa": sala, tipo e tópico da mensagem.
    expect(row).toMatchObject({ rid, roomType: 'c', tmid: keep._id, messageRemoved: false });

    expect((await api('POST', 'moderation.dismissReports', {}, A)).status).toBe(400);
    expect((await api('POST', 'moderation.dismissReports', { msgId: keep._id }, A)).status).toBe(200);
    rows = await openReports(ana.userId);
    expect(rows.some((r) => r.messageId === keep._id)).toBe(false);

    const del = await api('POST', 'moderation.user.deleteReportedMessages', { userId: ana.userId, msgId: drop._id }, A);
    expect([del.status, del.count]).toEqual([200, 1]);
    expect((await api('GET', 'chat.getMessage', { msgId: drop._id }, A)).status).not.toBe(200);
    expect((await api('GET', 'chat.getMessage', { msgId: keep._id }, A)).message.msg).toBe('mensagem que fica');
    rows = await openReports(ana.userId);
    expect(rows.map((r) => r.messageId)).toContain(reply._id);
    expect(rows.some((r) => r.messageId === drop._id)).toBe(false);

    const userReport = rows.find((r) => !r.messageId);
    expect(userReport).toBeTruthy();
    expect((await api('POST', 'moderation.dismissReports', { reportId: userReport._id }, A)).status).toBe(200);
    rows = await openReports(ana.userId);
    expect(rows.some((r) => !r.messageId)).toBe(false);
    expect(rows.map((r) => r.messageId)).toContain(reply._id);
  });
});

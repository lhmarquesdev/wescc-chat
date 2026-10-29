// Rotas REST do Microsoft Teams (§5.8), o retorno da conta de serviço e /hooks/msteams. Registra tarefas, ganchos e
// /teams uma vez. Com o Teams desligado, só msteams.config* respondem (o resto: error-msteams-disabled).
import { INTEGRATION_CALLBACK, type TeamsConfigInput } from '@shared/integrations';
import type { FastifyInstance } from 'fastify';
import { b, q, route, str, strArray } from '../../api/http';
import { badRequest } from '../../lib/errors';
import { assertTeamsEnabled, getTeamsConfig, saveTeamsConfig, testConnection } from './config';
import { listChannels, listInRules, listTeams, removeInRule, saveInRule } from './incoming';
import { createMeeting, linkMeeting, scheduleLink, testMeeting } from './meetings';
import { registerMsteamsHooks } from './notifications';
import { listOutRules, removeOutRule, saveOutRule, testOutRule } from './outgoing';
import { presenceFor } from './presence';
import { registerMsteams } from './register';
import { serviceCallback, startServiceSignIn, unlinkService } from './serviceAccount';

const MANAGE = { permissions: ['manage-msteams'] };
const MEET = { permissions: ['start-msteams-meeting'] };

const tmidOf = (v: unknown) => (typeof v === 'string' && v ? v : null);

export function msteamsRoutes(app: FastifyInstance) {
  registerMsteams();

  // ---------- Configuração (funciona com o Teams desligado) ----------
  route(app, 'GET', 'msteams.config', MANAGE, async () => ({ config: await getTeamsConfig() }));
  route(app, 'POST', 'msteams.config.save', MANAGE, async (req, _r, ctx) => saveTeamsConfig(ctx, b(req) as TeamsConfigInput));
  route(app, 'POST', 'msteams.config.test', MANAGE, async () => testConnection());

  // ---------- Conta de serviço ----------
  route(app, 'POST', 'msteams.service.start', MANAGE, async (req, reply, ctx) => {
    assertTeamsEnabled();
    return startServiceSignIn(ctx, reply, b(req).returnTo);
  });
  route(app, 'POST', 'msteams.service.unlink', MANAGE, async (_req, _r, ctx) => {
    assertTeamsEnabled();
    await unlinkService(ctx);
    return {};
  });

  // ---------- Equipes e canais (o que a conta de serviço vê) ----------
  route(app, 'GET', 'msteams.teams', MANAGE, async () => {
    assertTeamsEnabled();
    return { teams: await listTeams() };
  });
  route(app, 'GET', 'msteams.channels', MANAGE, async (req) => {
    assertTeamsEnabled();
    return { channels: await listChannels(str(q(req).teamId, 'teamId', { max: 200 })) };
  });

  // ---------- Envio (Wescc → Teams) ----------
  route(app, 'GET', 'msteams.out.list', MANAGE, async () => {
    assertTeamsEnabled();
    return { rules: await listOutRules() };
  });
  route(app, 'POST', 'msteams.out.save', MANAGE, async (req, _r, ctx) => {
    assertTeamsEnabled();
    return { rule: await saveOutRule(ctx, b(req) as any) };
  });
  route(app, 'POST', 'msteams.out.remove', MANAGE, async (req, _r, ctx) => {
    assertTeamsEnabled();
    await removeOutRule(ctx, str(b(req)._id, '_id', { max: 64 }));
    return {};
  });
  route(app, 'POST', 'msteams.out.test', MANAGE, async (req) => {
    assertTeamsEnabled();
    return testOutRule(str(b(req)._id, '_id', { max: 64 }));
  });

  // ---------- Recebimento (Teams → Wescc) ----------
  route(app, 'GET', 'msteams.in.list', MANAGE, async () => {
    assertTeamsEnabled();
    return { rules: await listInRules() };
  });
  route(app, 'POST', 'msteams.in.save', MANAGE, async (req, _r, ctx) => {
    assertTeamsEnabled();
    return { rule: await saveInRule(ctx, b(req) as any) };
  });
  route(app, 'POST', 'msteams.in.remove', MANAGE, async (req, _r, ctx) => {
    assertTeamsEnabled();
    await removeInRule(ctx, str(b(req)._id, '_id', { max: 64 }));
    return {};
  });

  // ---------- Reuniões ----------
  route(app, 'POST', 'msteams.meeting.create', MEET, async (req, _r, ctx) => {
    assertTeamsEnabled();
    const body = b(req);
    return createMeeting(ctx, { roomId: body.roomId, subject: body.subject, startsAt: body.startsAt, minutes: body.minutes, tzOffset: body.tzOffset, tmid: tmidOf(body.tmid) });
  });
  route(app, 'POST', 'msteams.meeting.link', MEET, async (req, _r, ctx) => {
    assertTeamsEnabled();
    const body = b(req);
    return linkMeeting(ctx, { roomId: body.roomId, url: body.url, subject: body.subject, tmid: tmidOf(body.tmid) });
  });
  route(app, 'POST', 'msteams.meeting.scheduleLink', MEET, async (req, _r, ctx) => {
    assertTeamsEnabled();
    const body = b(req);
    return scheduleLink(ctx, {
      roomId: body.roomId,
      subject: body.subject,
      startsAt: body.startsAt,
      minutes: body.minutes,
      tzOffset: body.tzOffset,
      includeMembers: body.includeMembers === true,
    });
  });
  route(app, 'POST', 'msteams.meeting.test', MANAGE, async (req, _r, ctx) => {
    assertTeamsEnabled();
    return testMeeting(ctx, b(req).tzOffset);
  });

  // ---------- Presença (qualquer pessoa logada) ----------
  route(app, 'GET', 'msteams.presence', {}, async (req) => {
    assertTeamsEnabled();
    const ids = strArray(q(req).userIds);
    if (ids.length > 100) throw badRequest('error-invalid-params', 'Peça a presença de até 100 pessoas por vez.');
    return { presence: await presenceFor(ids) };
  });

  // Retorno da entrada da conta de serviço (sem sessão: quem iniciou vem do state, o navegador do cookie) e as notificações.
  app.get(INTEGRATION_CALLBACK.msteams, async (req, reply) => serviceCallback(req, reply));
  registerMsteamsHooks(app);
}

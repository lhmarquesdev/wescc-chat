import type { FastifyInstance } from 'fastify';
import { b, bool, q, route, str, strArray } from '../api/http';
import { notFound } from '../lib/errors';
import { adminAccountsSummary, adminConfig, connectCallback, disconnect, listProviders, saveAdminConfig, setDirection, startConnect } from './accounts';
import { busyTimes, cancelEvent, createEvent, getEvent, joinMeeting, listEvents, meetingForRoom, meetingInfo, respond, updateEvent } from './events';
import { syncAccount } from './sync';
import { one } from '../db/pool';

const eventIdOf = (body: Record<string, any>) => str(body.eventId, 'eventId', { max: 64 });

export function calendarRoutes(app: FastifyInstance) {
  // Eventos
  route(app, 'GET', 'calendar.events', {}, async (req, _r, ctx) => {
    const query = q(req);
    return { events: await listEvents(ctx, { from: query.from, to: query.to, hideDeclined: bool(query.hideDeclined) === true }) };
  });
  route(app, 'GET', 'calendar.event', {}, async (req, _r, ctx) => ({ event: await getEvent(ctx, str(q(req).eventId, 'eventId', { max: 64 })) }));
  route(app, 'POST', 'calendar.create', {}, async (req, _r, ctx) => ({ event: await createEvent(ctx, b(req)) }));
  route(app, 'POST', 'calendar.update', {}, async (req, _r, ctx) => {
    const body = b(req);
    return { event: await updateEvent(ctx, eventIdOf(body), body) };
  });
  route(app, 'POST', 'calendar.cancel', {}, async (req, _r, ctx) => {
    await cancelEvent(ctx, eventIdOf(b(req)));
    return {};
  });
  route(app, 'POST', 'calendar.respond', {}, async (req, _r, ctx) => {
    const body = b(req);
    return { event: await respond(ctx, eventIdOf(body), body.response) };
  });
  route(app, 'GET', 'calendar.busy', {}, async (req, _r, ctx) => {
    const query = q(req);
    return { busy: await busyTimes(ctx, { userIds: strArray(query.userIds), from: query.from, to: query.to }) };
  });

  // Reuniões (link /meet/<código>)
  route(app, 'GET', 'calendar.meeting', {}, async (req, _r, ctx) => meetingInfo(ctx, q(req).code));
  route(app, 'POST', 'calendar.meeting.join', {}, async (req, _r, ctx) => joinMeeting(ctx, b(req).code));
  route(app, 'GET', 'calendar.meeting.byRoom', {}, async (req, _r, ctx) => ({ event: await meetingForRoom(ctx, str(q(req).roomId, 'roomId', { max: 64 })) }));

  // Contas do Google/Outlook
  route(app, 'GET', 'calendar.accounts', {}, async (_req, _r, ctx) => ({ providers: await listProviders(ctx) }));
  route(app, 'POST', 'calendar.accounts.connect', {}, async (req, reply, ctx) => {
    const body = b(req);
    return startConnect(ctx, reply, { provider: body.provider, direction: body.direction, returnTo: body.returnTo });
  });
  route(app, 'POST', 'calendar.accounts.direction', {}, async (req, _r, ctx) => ({ account: await setDirection(ctx, b(req)) }));
  route(app, 'POST', 'calendar.accounts.disconnect', {}, async (req, _r, ctx) => {
    await disconnect(ctx, b(req).provider);
    return {};
  });
  route(app, 'POST', 'calendar.accounts.sync', {}, async (req, _r, ctx) => {
    const row = await one(`SELECT id FROM calendar_accounts WHERE user_id = $1 AND provider = $2`, [ctx.userId, b(req).provider]);
    if (!row) throw notFound('error-calendar-not-connected', 'Esta conta não está conectada.');
    // Vencida: tenta de novo (a pessoa pode ter liberado o acesso); o status volta a ok se o token servir.
    await one(`UPDATE calendar_accounts SET status = 'ok' WHERE id = $1 AND status = 'error' RETURNING id`, [row.id]);
    return { result: await syncAccount(row.id), providers: await listProviders(ctx) };
  });
  app.get('/integrations/calendar/:provider/callback', async (req, reply) => connectCallback(req, reply, String((req.params as any).provider ?? '')));

  // Administração › Integrações › Agenda
  route(app, 'GET', 'calendar.admin.config', { permissions: ['edit-privileged-setting'] }, async () => ({ config: await adminConfig(), accounts: await adminAccountsSummary() }));
  route(app, 'POST', 'calendar.admin.save', { permissions: ['edit-privileged-setting'] }, async (req, _r, ctx) => ({ config: await saveAdminConfig(ctx, b(req)), accounts: await adminAccountsSummary() }));
}

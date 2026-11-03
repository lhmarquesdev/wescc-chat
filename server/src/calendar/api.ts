import type { FastifyInstance } from 'fastify';
import { b, bool, q, route, str, strArray } from '../api/http';
import { busyTimes, cancelEvent, createEvent, getEvent, joinMeeting, listEvents, meetingForRoom, meetingInfo, respond, updateEvent } from './events';

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
}

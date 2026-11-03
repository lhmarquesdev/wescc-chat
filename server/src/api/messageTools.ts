import type { FastifyInstance } from 'fastify';
import { badRequest } from '../lib/errors';
import { forwardMessage } from '../services/forward';
import { closePoll, createPoll, myVotes, pollVoters, vote } from '../services/polls';
import { deleteReminder, listReminders, setReminder } from '../services/reminders';
import { cancelScheduled, listScheduled, scheduleMessage, sendScheduledNow, updateScheduled } from '../services/scheduled';
import { b, bool, q, route, str, strArray } from './http';

// Encaminhar, enquetes, "Lembrar-me" e envios agendados. As permissões são conferidas nos serviços (o texto sai em
// português e, em create-poll e schedule-message, vale o papel da sala).

const list = (v: unknown) => {
  if (!Array.isArray(v)) throw badRequest('error-invalid-params', 'Parâmetros inválidos.');
  return v;
};

export function messageToolsRoutes(app: FastifyInstance) {
  // ---------- Encaminhar ----------
  route(app, 'POST', 'chat.forwardMessage', {}, async (req, _rep, ctx) => {
    const body = b(req);
    return forwardMessage(ctx, { messageId: str(body.messageId, 'messageId'), targets: list(body.targets), comment: body.comment });
  });

  // ---------- Enquetes ----------
  route(app, 'POST', 'polls.create', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const message = await createPoll(ctx, {
      rid: str(body.rid, 'rid'),
      tmid: str(body.tmid, 'tmid', { optional: true }) ?? null,
      question: body.question,
      options: body.options,
      multiple: bool(body.multiple) ?? false,
      anonymous: bool(body.anonymous) ?? false,
      closesAt: str(body.closesAt, 'closesAt', { optional: true }) ?? null,
    });
    return { message };
  });
  route(app, 'POST', 'polls.vote', {}, async (req, _rep, ctx) => {
    const body = b(req);
    return vote(ctx, str(body.messageId, 'messageId'), list(body.optionIds));
  });
  route(app, 'POST', 'polls.close', {}, async (req, _rep, ctx) => ({ message: await closePoll(ctx, str(b(req).messageId, 'messageId')) }));
  route(app, 'GET', 'polls.myVotes', {}, async (req, _rep, ctx) => {
    const ids = strArray(q(req).messageIds);
    if (ids.length > 100) throw badRequest('error-invalid-params', 'Parâmetros inválidos.');
    return { votes: await myVotes(ctx, ids) };
  });
  route(app, 'GET', 'polls.voters', {}, async (req, _rep, ctx) => pollVoters(ctx, str(q(req).messageId, 'messageId')));

  // ---------- "Lembrar-me" ----------
  route(app, 'POST', 'reminders.set', {}, async (req, _rep, ctx) => {
    const body = b(req);
    return { reminder: await setReminder(ctx, str(body.messageId, 'messageId'), str(body.remindAt, 'remindAt')) };
  });
  route(app, 'GET', 'reminders.list', {}, async (_req, _rep, ctx) => listReminders(ctx));
  route(app, 'POST', 'reminders.delete', {}, async (req, _rep, ctx) => {
    await deleteReminder(ctx, str(b(req).reminderId, 'reminderId'));
    return {};
  });

  // ---------- Envios agendados ----------
  route(app, 'POST', 'chat.scheduleMessage', {}, async (req, _rep, ctx) => {
    const body = b(req);
    const m = body.message;
    if (!m || typeof m !== 'object') throw badRequest('error-invalid-params', 'O parâmetro "message" é obrigatório.');
    const scheduled = await scheduleMessage(
      ctx,
      { rid: str(m.rid, 'rid'), msg: m.msg, tmid: str(m.tmid, 'tmid', { optional: true }) ?? null, tshow: bool(m.tshow) ?? false, ackRequired: bool(m.ackRequired) ?? false },
      str(body.sendAt, 'sendAt'),
    );
    return { scheduled };
  });
  route(app, 'GET', 'chat.getScheduledMessages', {}, async (req, _rep, ctx) => ({ scheduled: await listScheduled(ctx, str(q(req).roomId, 'roomId', { optional: true }) ?? null) }));
  route(app, 'POST', 'chat.updateScheduledMessage', {}, async (req, _rep, ctx) => {
    const body = b(req);
    return { scheduled: await updateScheduled(ctx, str(body.scheduledId, 'scheduledId'), { msg: body.msg, sendAt: body.sendAt }) };
  });
  route(app, 'POST', 'chat.cancelScheduledMessage', {}, async (req, _rep, ctx) => {
    await cancelScheduled(ctx, str(b(req).scheduledId, 'scheduledId'));
    return {};
  });
  route(app, 'POST', 'chat.sendScheduledMessageNow', {}, async (req, _rep, ctx) => ({ message: await sendScheduledNow(ctx, str(b(req).scheduledId, 'scheduledId')) }));
}

import type { CallModerationAction, CallParticipant, CallSource, UserRef } from '@shared/index';
import { CALL_LIMITS } from '@shared/calls';
import { one } from '../db/pool';
import { ApiError, badRequest } from '../lib/errors';
import { audit } from '../services/audit';
import { rolesHavePermission } from '../services/permissions';
import { actorOf, type Ctx } from '../services/users';
import { endGroupCallTx } from './group';
import { clearHandTx } from './hands';
import { hit } from './limits';
import { SfuError, type SfuTrack } from './livekit';
import { evaluateGuardTx } from './guard';
import { lk, loadCall, loadCallRow, loadParticipants, loadRoomInfo, presentIds, publishCallTo, withCallLock } from './model';
import { ERR, loadViewer, rightsFor } from './policy';
import { afterLeaveTx, applyGrantsTx, leaveRowsTx } from './presence';
import { participantOf } from './views';

// Moderação (§5.14). Ninguém liga o microfone ou a câmera de outra pessoa: não há ação para isso.

export const CALL_MODERATION_ACTIONS: readonly CallModerationAction[] = ['mute', 'stopVideo', 'lowerHand', 'allowSpeak', 'revokeSpeak', 'remove'];
const SCREEN: CallSource[] = ['screen_share', 'screen_share_audio'];

export async function moderate(ctx: Ctx, input: { callId: string; userId: string; action: CallModerationAction }): Promise<{ participant: CallParticipant }> {
  const { callId, userId, action } = input;
  const call = await loadCall(callId);
  if (call.scope !== 'group') throw badRequest('error-invalid-params', 'A moderação só existe em chamadas em grupo.');
  if (call.status !== 'ongoing') throw ERR.ended();
  const room = await loadRoomInfo(call.room_id);
  const actor = await loadViewer(ctx.userId, callId, call.room_id);
  if (!actor || !rightsFor(actor, call, room).canModerate) throw ERR.notModerator();
  if (userId === ctx.userId) throw badRequest('error-invalid-params', 'Use os botões da chamada para você mesmo.');
  const target = await loadViewer(userId, callId, call.room_id);
  if (!target?.row) throw badRequest('error-invalid-params', 'Esta pessoa não está na chamada.');
  // Anfitrião sem moderate-call não age sobre quem tem moderate-call.
  if (!rolesHavePermission(actor.mgmtRoles, 'moderate-call') && rolesHavePermission(target.mgmtRoles, 'moderate-call')) {
    throw new ApiError(403, 'error-call-not-moderator', 'Você não pode fazer isso com um moderador da sala.');
  }
  if ((action === 'allowSpeak' || action === 'revokeSpeak') && !call.listen_only) throw badRequest('error-invalid-params', 'A fala só é controlada em transmissões.');
  hit(ctx.userId, 'moderate', 30, 60_000);

  // As faixas vêm do LiveKit antes da trava (nada de LiveKit dentro dela).
  let tracks: SfuTrack[] = [];
  if (action === 'mute' || action === 'stopVideo') {
    try {
      tracks = (await lk.listParticipants(call.sfu_room, { timeoutMs: 2000 })).find((p) => p.identity === userId)?.tracks ?? [];
    } catch (e) {
      if (!(e instanceof SfuError && e.code === 'not_found')) throw ERR.sfu();
    }
  }
  const me = await one('SELECT id, username, name FROM users WHERE id = $1', [ctx.userId]);
  const byRef: UserRef = { _id: ctx.userId, username: me?.username ?? ctx.username, name: me?.name };
  const by = `@${byRef.username}`;

  return withCallLock(callId, async (c, fx) => {
    const cur = await loadCallRow(callId, c);
    if (!cur || cur.status !== 'ongoing') throw ERR.ended();
    const live = await loadRoomInfo(cur.room_id, c);
    const sfuRoom = cur.sfu_room;
    let text: string | null = null;
    if (action === 'mute') {
      const mics = tracks.filter((t) => t.source === 'microphone' && !t.muted);
      for (const t of mics) fx.sfu(() => lk.muteTrack(sfuRoom, userId, t.sid));
      if (mics.length) text = `${by} silenciou seu microfone.`;
    } else if (action === 'stopVideo') {
      const cams = tracks.filter((t) => t.source === 'camera' && !t.muted);
      const screens = tracks.filter((t) => SCREEN.includes(t.source as CallSource));
      for (const t of cams) fx.sfu(() => lk.muteTrack(sfuRoom, userId, t.sid));
      if (screens.length) {
        // Sem as fontes de tela por 60 s; a reconciliação devolve depois.
        await c.query(
          `UPDATE call_participants SET screen_block_until = now() + make_interval(secs => ${CALL_LIMITS.screenBlockSeconds}) WHERE call_id = $1 AND user_id = $2`,
          [callId, userId],
        );
        await applyGrantsTx(c, fx, cur, live, { userIds: [userId], force: new Set([userId]) });
      }
      if (cams.length && screens.length) text = `${by} desligou sua câmera e parou seu compartilhamento de tela.`;
      else if (cams.length) text = `${by} desligou sua câmera.`;
      else if (screens.length) text = `${by} parou seu compartilhamento de tela.`;
    } else if (action === 'lowerHand') {
      if (await clearHandTx(c, fx, cur, live, userId)) text = `${by} baixou sua mão.`;
    } else if (action === 'allowSpeak' || action === 'revokeSpeak') {
      const allow = action === 'allowSpeak';
      const r = await one(`UPDATE call_participants SET speak_granted = $3 WHERE call_id = $1 AND user_id = $2 AND speak_granted <> $3 RETURNING user_id`, [callId, userId, allow], c);
      if (r) {
        // A trava decide antes: uma fala liberada nunca chega ao LiveKit para quem formaria um par sem acompanhante.
        if ((await evaluateGuardTx(c, fx, callId)) !== 'ended') {
          await applyGrantsTx(c, fx, (await loadCallRow(callId, c))!, live, { userIds: [userId] });
          fx.after(() => publishCallTo(callId, [userId]));
        }
        text = allow ? `${by} liberou sua fala.` : `${by} retirou sua permissão de falar.`;
      }
    } else if (action === 'remove') {
      const left = await leaveRowsTx(c, callId, [userId], 'removed', { removedBy: ctx.userId });
      if (left.length) {
        fx.sfu(() => lk.removeParticipant(sfuRoom, userId));
        fx.after(() => publishCallTo(callId, [userId]));
        text = `${by} removeu você da chamada.`;
        if (!(await presentIds(callId, c)).length) await endGroupCallTx(c, fx, cur, 'empty', null);
        else await afterLeaveTx(c, fx, cur, live, left);
      }
    }
    if (text) {
      const notice = { kind: 'moderated' as const, action, by: byRef, text };
      fx.publish({ user: userId }, { type: 'call.notice', callId, notice });
      const rid = cur.room_id;
      fx.after(() => audit(actorOf(ctx), 'call.moderate', { callId, rid, userId }, { action }));
    }
    const row = (await loadParticipants(callId, c)).find((r) => r.user_id === userId);
    return { participant: participantOf(row, (await loadCallRow(callId, c))!, live) };
  });
}

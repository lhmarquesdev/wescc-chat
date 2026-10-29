import type { CallLeftReason, CallSource } from '@shared/index';
import { CALL_LIMITS, callTrackNameOk, isTransmissionRoom } from '@shared/calls';
import { isExempt, isRestricted } from '@shared/direct';
import { many, one, query } from '../db/pool';
import { audit } from '../services/audit';
import { currentDirectRules, partyOf } from '../services/direct';
import { getSetting } from '../services/settings';
import { touchCall } from './card';
import { endGroupCallTx, handOverTx, roomOptions } from './group';
import { evaluateGuard, evaluateGuardTx, recheckAfterChaperoneGrace } from './guard';
import { publishInCall } from './incall';
import { SfuError, type SfuParticipant, type SfuWebhookEvent } from './livekit';
import { isLive, lk, loadCallRow, loadParticipants, loadRoomInfo, markRoomSeen, presentSql, withCallLock, type Db, type Effects } from './model';
import { grantsFor, sameSources } from './policy';
import { enqueue } from './queue';

// Presença no servidor de chamadas (§5.11): webhooks assinados, na ordem por chamada, mais a reconciliação a cada 10 s.

const REFUSED_AGAIN = 'Você precisa entrar na chamada de novo.';
const TAMPER = 'Você saiu da chamada: o navegador enviou dados fora do padrão. Recarregue a página.';
const CALL_ROOM = /^wc_([A-Za-z0-9]+)$/;

const rolesOf = (r: any): string[] => [...(r.global_roles ?? []), ...(r.room_roles ?? [])];

// ---------- Permissões no LiveKit ----------

// Por quanto tempo uma fonte tirada pelo servidor ainda não conta como adulteração (o LiveKit tira a faixa ao receber
// a permissão nova; um webhook ou uma lista de antes disso ainda a mostram).
export const REVOKED_GRACE_SECONDS = 30;

// Trecho do SET de quem perde fontes: guarda as que saíram (com as que já tinham saído há pouco). $n: as fontes novas.
// No SET, granted_sources ainda é o valor de antes.
export const revokedSql = (n: number) =>
  `revoked_sources = CASE WHEN granted_sources <@ $${n}::text[] THEN revoked_sources
     ELSE ARRAY(SELECT unnest(granted_sources) EXCEPT SELECT unnest($${n}::text[])
                UNION SELECT unnest(revoked_sources) WHERE revoked_at > now() - make_interval(secs => ${REVOKED_GRACE_SECONDS})) END,
   revoked_at = CASE WHEN granted_sources <@ $${n}::text[] THEN revoked_at ELSE now() END`;

// Para cada pessoa dentro cuja permissão mudou (ou que está em force), manda a permissão inteira ao LiveKit depois do
// commit e guarda o que foi concedido. Quem ainda está entrando e perdeu o direito de publicar tem o token anulado.
// Roda dentro da transação de quem mudou, sem o agrupamento 'grants' do §5.2: uma pausa não pode esperar 300 ms (S3), e
// fx.pushed já evita mandar a mesma pessoa duas vezes na mesma transação.
export async function applyGrantsTx(
  c: Db,
  fx: Effects,
  call: any,
  room: any,
  o: { userIds?: string[]; force?: Set<string> } = {},
): Promise<number> {
  const rows = (await loadParticipants(call.id, c)).filter((r) => (r.state === 'joined' || r.state === 'joining') && (!o.userIds || o.userIds.includes(r.user_id)));
  let pushed = 0;
  for (const r of rows) {
    const g = grantsFor({ username: r.username }, call, room, rolesOf(r), r);
    const same = r.granted_publish === g.canPublish && sameSources(r.granted_sources, g.sources);
    if (r.state === 'joined') {
      // force: manda mesmo igual (o LiveKit pode ter outra coisa), a não ser que já tenha ido nesta transação.
      const forced = !!o.force?.has(r.user_id) && !fx.pushed.has(r.user_id);
      if (same && !forced) continue;
      const sfuRoom = call.sfu_room;
      const identity = r.user_id;
      const p = { canPublish: g.canPublish, sources: g.sources, hidden: !!r.granted_hidden };
      fx.sfu(() => lk.updatePermission(sfuRoom, identity, p));
      fx.pushed.add(identity);
      await c.query(`UPDATE call_participants SET granted_publish = $3, granted_sources = $4, ${revokedSql(4)} WHERE call_id = $1 AND user_id = $2`, [
        call.id,
        r.user_id,
        g.canPublish,
        g.sources,
      ]);
      pushed++;
    } else if (r.granted_publish && !g.canPublish) {
      // Pode já estar conectado sem o participant_joined ter chegado: as fontes que tinha também ficam guardadas.
      await c.query(`UPDATE call_participants SET token_at = NULL, granted_publish = false, granted_sources = '{}', ${revokedSql(3)} WHERE call_id = $1 AND user_id = $2`, [
        call.id,
        r.user_id,
        [],
      ]);
    }
  }
  return pushed;
}

// ---------- Relógios da chamada ----------

// Pico, sala vazia (ninguém presente) e pessoa sozinha (exatamente uma dentro).
export async function updateClocksTx(c: Db, callId: string) {
  await c.query(
    `UPDATE calls SET
        peak = GREATEST(peak, x.joined),
        empty_since = CASE WHEN x.present = 0 THEN coalesce(empty_since, now()) ELSE NULL END,
        alone_since = CASE WHEN x.joined = 1 THEN coalesce(alone_since, now()) ELSE NULL END
       FROM (SELECT count(*) FILTER (WHERE ${presentSql()})::int AS present, count(*) FILTER (WHERE p.state = 'joined')::int AS joined
               FROM call_participants p WHERE p.call_id = $1) x
      WHERE id = $1`,
    [callId],
  );
}

// Tira pessoas da chamada (somando o tempo de quem estava dentro). Devolve as linhas como estavam antes.
export async function leaveRowsTx(c: Db, callId: string, userIds: string[], reason: CallLeftReason, o: { sid?: string | null; at?: number | null; removedBy?: string } = {}) {
  if (!userIds.length) return [];
  const before = await many(`SELECT * FROM call_participants WHERE call_id = $1 AND user_id = ANY($2) AND state IN ('joining', 'joined') FOR UPDATE`, [callId, userIds], c);
  if (!before.length) return [];
  await c.query(
    `UPDATE call_participants SET
        seconds = seconds + CASE WHEN state = 'joined' THEN GREATEST(0, EXTRACT(EPOCH FROM now() - last_joined_at))::int ELSE 0 END,
        state = 'left', left_at = now(), left_reason = $3, hand_at = NULL,
        session_id = coalesce($4, session_id), removed_by = coalesce($6, removed_by),
        sfu_event_at = CASE WHEN $5::float8 IS NULL THEN sfu_event_at ELSE to_timestamp($5::float8) END
      WHERE call_id = $1 AND user_id = ANY($2) AND state IN ('joining', 'joined')`,
    [callId, before.map((r) => r.user_id), reason, o.sid ?? null, o.at ?? null, o.removedBy ?? null],
  );
  return before;
}

// Depois que pessoas saíram: avisos, trava, contagem, "Em chamada" e a troca de anfitrião.
export async function afterLeaveTx(c: Db, fx: Effects, call: any, room: any, left: any[], o: { chaperoneDropped?: boolean } = {}) {
  if (!left.length) return;
  await updateClocksTx(c, call.id);
  const present = (await many(`SELECT user_id FROM call_participants p WHERE call_id = $1 AND ${presentSql()}`, [call.id], c)).map((r) => r.user_id);
  for (const r of left) {
    if (r.hand_at) fx.publish({ users: present }, { type: 'call.hand', callId: call.id, userId: r.user_id, at: null });
    fx.after(() => publishInCall(r.user_id));
  }
  if (left.some((r) => r.host)) await handOverTx(c, fx, call, room);
  fx.after(() => evaluateGuard(call.id));
  if (o.chaperoneDropped) fx.after(() => recheckAfterChaperoneGrace(call.id));
  fx.after(() => touchCall(call.id));
}

// ---------- Entrada e saída vistas pelo LiveKit ----------

const at = (seconds: number | null | undefined) => (seconds ? seconds : null);
const stale = (row: any, seconds: number | null) => !!seconds && !!row?.sfu_event_at && new Date(row.sfu_event_at).getTime() > seconds * 1000;

export async function markJoinedTx(c: Db, fx: Effects, call: any, room: any, userId: string, sid: string, seconds: number | null = null) {
  const row = await one(
    `SELECT p.*, u.username, u.roles AS global_roles, u.active, (s.id IS NOT NULL) AS member,
            (p.token_at > now() - make_interval(secs => ${CALL_LIMITS.tokenSeconds})) AS fresh
       FROM call_participants p JOIN users u ON u.id = p.user_id
       LEFT JOIN subscriptions s ON s.room_id = $3 AND s.user_id = p.user_id
      WHERE p.call_id = $1 AND p.user_id = $2 FOR UPDATE OF p`,
    [call.id, userId, call.room_id],
    c,
  );
  if (row && stale(row, seconds)) return false;
  if (row?.state === 'joined' && row.session_id === sid) return false; // repetido
  // Esta sessão já saiu (o participant_left chegou antes, ou a pessoa desligou ainda conectando): nada a fazer.
  if (row?.state === 'left' && row.session_id === sid) return false;
  // Quem caiu e já pediu um token novo (outro aparelho, ou a volta depois da queda) entra com a sessão nova.
  const back = row?.state === 'left' && row.left_reason === 'disconnected' && row.fresh && row.session_id !== sid;
  const accepted = !!row && row.active && row.member && (row.state === 'joining' || row.state === 'joined' || back);
  if (!accepted) {
    const sfuRoom = call.sfu_room;
    fx.sfu(() => lk.removeParticipant(sfuRoom, userId));
    fx.publish({ user: userId }, { type: 'call.notice', callId: call.id, notice: { kind: 'refused', text: REFUSED_AGAIN } });
    if (row && seconds) await c.query(`UPDATE call_participants SET sfu_event_at = to_timestamp($3::float8) WHERE call_id = $1 AND user_id = $2`, [call.id, userId, seconds]);
    return false;
  }
  const takeover = row.state === 'joined';
  await c.query(
    `UPDATE call_participants SET state = 'joined', session_id = $3, left_reason = NULL, left_at = NULL,
        last_joined_at = CASE WHEN $4 THEN last_joined_at ELSE now() END, joined_at = coalesce(joined_at, now()),
        sfu_event_at = CASE WHEN $5::float8 IS NULL THEN sfu_event_at ELSE to_timestamp($5::float8) END
      WHERE call_id = $1 AND user_id = $2`,
    [call.id, userId, sid, takeover, seconds],
  );
  await updateClocksTx(c, call.id);
  // Quem é restrito pode formar um par ao conectar (deixou de estar silenciado na sala depois do token, por exemplo):
  // a trava decide antes de qualquer permissão ir ao LiveKit, para um par sem acompanhante nunca receber canPublish true.
  let cur = call;
  if (isRestricted(partyOf({ id: row.user_id, username: row.username, roles: row.global_roles, active: row.active }), currentDirectRules())) {
    if ((await evaluateGuardTx(c, fx, call.id)) === 'ended') return true;
    cur = await loadCallRow(call.id, c);
  }
  // O token pode ter concedido mais do que vale agora (a trava ligou ou a tela foi bloqueada entre o token e a conexão,
  // e o que foi gravado depois já não diz o que o token trazia): a sessão nova sempre recebe a permissão de agora (S3).
  await applyGrantsTx(c, fx, cur, room, { userIds: [userId], force: new Set([userId]) });
  if (!(await one(`SELECT 1 FROM call_participants WHERE call_id = $1 AND host`, [call.id], c))) await handOverTx(c, fx, call, room, { candidate: userId });
  if (!takeover) {
    fx.after(() => evaluateGuard(call.id));
    fx.after(() => touchCall(call.id));
    fx.after(() => publishInCall(userId));
  }
  return true;
}

export async function markLeftTx(
  c: Db,
  fx: Effects,
  call: any,
  room: any,
  userId: string,
  sid: string | null,
  reason: CallLeftReason,
  seconds: number | null = null,
  disconnectReason?: string | null,
) {
  const row = await one(`SELECT p.*, u.username, u.roles, u.active, u.type FROM call_participants p JOIN users u ON u.id = p.user_id WHERE p.call_id = $1 AND p.user_id = $2 FOR UPDATE OF p`, [call.id, userId], c);
  if (!row || (row.state !== 'joined' && row.state !== 'joining')) return false;
  if (stale(row, seconds)) return false;
  // Sessão antiga: numa linha joined, outra que não a atual (troca de aparelho: a pessoa continua dentro pela nova);
  // numa linha joining, a sessão de antes do token novo. Uma sessão desconhecida numa linha joining é a nova, que caiu
  // antes de o participant_joined chegar: a saída vale, e o participant_joined atrasado é ignorado depois.
  if (sid && row.session_id && (row.state === 'joined' ? sid !== row.session_id : sid === row.session_id)) return false;
  if (disconnectReason === 'DUPLICATE_IDENTITY') return false;
  const left = await leaveRowsTx(c, call.id, [userId], reason, { sid, at: at(seconds) });
  const rules = currentDirectRules();
  const party = partyOf({ id: row.user_id, username: row.username, roles: row.roles, active: row.active });
  const chaperone = row.state === 'joined' && row.type === 'user' && (!isRestricted(party, rules) || isExempt(party, rules));
  await afterLeaveTx(c, fx, call, room, left, { chaperoneDropped: chaperone && reason === 'disconnected' });
  return true;
}

export async function markJoined(callId: string, userId: string, sid: string, seconds: number | null = null) {
  return withCallLock(callId, async (c, fx) => {
    const call = await loadCallRow(callId, c);
    if (!call || !isLive(call) || call.media !== 'sfu') return false;
    return markJoinedTx(c, fx, call, await loadRoomInfo(call.room_id, c), userId, sid, seconds);
  });
}

export async function markLeft(callId: string, userId: string, sid: string | null, reason: CallLeftReason, seconds: number | null = null, disconnectReason?: string | null) {
  return withCallLock(callId, async (c, fx) => {
    const call = await loadCallRow(callId, c);
    if (!call || !isLive(call) || call.media !== 'sfu') return false;
    return markLeftTx(c, fx, call, await loadRoomInfo(call.room_id, c), userId, sid, reason, seconds, disconnectReason);
  });
}

// ---------- Faixas ----------

// O nome da faixa é visto por todos na sala: texto livre seria um canal escondido. Fonte fora do que a pessoa poderia
// publicar também. Mas uma fonte que o próprio servidor tirou (pausa, bloqueio da tela, silêncio na sala, fala ou papel
// revogados) pode ser de uma faixa publicada antes de o LiveKit receber a permissão nova, vista por um webhook ou por
// uma lista de antes: o LiveKit já a tira, sem expulsar ninguém. sfu: a permissão que o LiveKit tinha na mesma lista
// das faixas (reconciliação); o que ele deixava publicar não é adulteração do navegador.
export function trackAllowed(row: any, call: any, room: any, track: { source: CallSource | 'unknown'; name: string }, sfu?: SfuParticipant['permission']) {
  if (!callTrackNameOk(track.source, track.name)) return false;
  if (track.source === 'unknown') return false;
  if ((row.granted_sources ?? []).includes(track.source)) return true;
  const revoked = !!row.revoked_at && new Date(row.revoked_at).getTime() > Date.now() - REVOKED_GRACE_SECONDS * 1000;
  if (revoked && (row.revoked_sources ?? []).includes(track.source)) return true;
  if (sfu?.canPublish && (!sfu.canPublishSources.length || sfu.canPublishSources.includes(track.source))) return true;
  const normal = grantsFor({ username: row.username }, { listen_only: call.listen_only, guard_until: null }, room, rolesOf(row), { speak_granted: row.speak_granted, screen_block_until: null });
  return normal.speaker && (track.source === 'microphone' || track.source === 'camera' || normal.screenAllowed);
}

async function tamperTx(c: Db, fx: Effects, call: any, room: any, row: any, track: { source: string; name: string }) {
  const left = await leaveRowsTx(c, call.id, [row.user_id], 'failed');
  const sfuRoom = call.sfu_room;
  fx.sfu(() => lk.removeParticipant(sfuRoom, row.user_id));
  fx.publish({ user: row.user_id }, { type: 'call.notice', callId: call.id, notice: { kind: 'refused', text: TAMPER } });
  const actor = { id: row.user_id, username: row.username };
  fx.after(() => audit(actor, 'call.tamper', { callId: call.id, userId: row.user_id }, { source: track.source, name: String(track.name ?? '').slice(0, 64) }));
  await afterLeaveTx(c, fx, call, room, left);
}

export async function checkTracks(callId: string, identity: string, track: { source: CallSource | 'unknown'; name: string }, seconds: number | null = null) {
  return withCallLock(callId, async (c, fx) => {
    const call = await loadCallRow(callId, c);
    if (!call || !isLive(call) || call.media !== 'sfu') return;
    const room = await loadRoomInfo(call.room_id, c);
    const rows = await loadParticipants(callId, c);
    const row = rows.find((r) => r.user_id === identity);
    if (!row || (row.state !== 'joined' && row.state !== 'joining')) return;
    if (seconds) await c.query(`UPDATE call_participants SET sfu_event_at = GREATEST(coalesce(sfu_event_at, to_timestamp(0)), to_timestamp($3::float8)) WHERE call_id = $1 AND user_id = $2`, [callId, identity, seconds]);
    if (!trackAllowed(row, call, room, track)) await tamperTx(c, fx, call, room, row, track);
  });
}

// ---------- Webhooks ----------

const seenIds = new Set<string>();
function remember(id: string) {
  seenIds.add(id);
  if (seenIds.size > 10_000) seenIds.delete(seenIds.values().next().value!);
}

// Chamado pela rota do webhook depois de responder 200. Repetidos (id) e atrasados (createdAt) não mudam nada.
export async function handleSfuEvent(ev: SfuWebhookEvent): Promise<void> {
  if (ev.id) {
    if (seenIds.has(ev.id)) return;
    remember(ev.id);
  }
  const m = CALL_ROOM.exec(ev.room?.name ?? '');
  if (!m) return;
  const callId = m[1];
  await enqueue(`ev:${callId}`, async () => {
    const call = await one(`SELECT id, status, media FROM calls WHERE id = $1`, [callId]);
    if (!call || !isLive(call) || call.media !== 'sfu') return;
    if (ev.event === 'room_finished') {
      // Só o nosso DeleteRoom encerra chamadas: aqui o LiveKit reiniciou ou esvaziou a sala.
      await query(`UPDATE calls SET sfu_missing_since = coalesce(sfu_missing_since, now()) WHERE id = $1 AND status IN ('ringing', 'ongoing')`, [callId]);
      return;
    }
    markRoomSeen(callId);
    const p = ev.participant;
    if (!p?.identity) return;
    const seconds = ev.createdAt || null;
    if (ev.event === 'participant_joined') await markJoined(callId, p.identity, p.sid, seconds);
    else if (ev.event === 'participant_left' || ev.event === 'participant_connection_aborted') await markLeft(callId, p.identity, p.sid || null, 'disconnected', seconds, p.disconnectReason);
    else if (ev.event === 'track_published' && ev.track) await checkTracks(callId, p.identity, ev.track, seconds);
  });
}

// ---------- Reconciliação ----------

const maxHours = () => Number(getSetting('Calls_Max_Duration_Hours')) || 12;

// Retrato de cada linha tirado antes de pedir a lista ao LiveKit. A lista pode ter sido montada antes de um webhook
// que chegou enquanto ela vinha: o que mudou desde o retrato (entrada, saída, token novo, permissão) fica para a próxima
// passada, em vez de ser corrigido com a lista velha.
const SNAPSHOT = `SELECT user_id, state, session_id, token_at, last_joined_at, left_at, granted_publish, granted_sources FROM call_participants WHERE call_id = $1`;
const fingerprint = (r: any) =>
  JSON.stringify([r.state, r.session_id, r.token_at, r.last_joined_at, r.left_at, r.granted_publish, [...(r.granted_sources ?? [])].sort()]);

// A cada 10 s, para cada chamada viva pelo servidor de chamadas: corrige o que os webhooks perderam (§5.11).
export async function reconcileCall(callId: string): Promise<void> {
  const first = await loadCallRow(callId);
  if (!first || !isLive(first) || first.media !== 'sfu') return;
  const before = new Map((await many(SNAPSHOT, [callId])).map((r) => [r.user_id as string, fingerprint(r)]));
  const unchanged = (r: any) => before.get(r.user_id) === fingerprint(r);
  let list: SfuParticipant[] | null = null;
  let missing: 'not_found' | 'unreachable' | null = null;
  try {
    // Sem configuração, falha na hora com not_configured e conta como fora do ar (ninguém consegue entrar).
    list = await lk.listParticipants(first.sfu_room, { timeoutMs: 2000 });
  } catch (e) {
    missing = e instanceof SfuError && e.code === 'not_found' ? 'not_found' : 'unreachable';
  }
  if (missing) {
    const ended = await withCallLock(callId, async (c, fx) => {
      const call = await loadCallRow(callId, c);
      if (!call || !isLive(call)) return true;
      const r = await one(
        `UPDATE calls SET sfu_missing_since = coalesce(sfu_missing_since, now()) WHERE id = $1
         RETURNING sfu_missing_since < now() - make_interval(secs => ${CALL_LIMITS.sfuMissingSeconds}) AS expired,
                   created_at < now() - make_interval(hours => $2) AS too_long`,
        [callId, maxHours()],
        c,
      );
      const joinedSince = await one(`SELECT 1 FROM call_participants WHERE call_id = $1 AND last_joined_at > (SELECT sfu_missing_since FROM calls WHERE id = $1)`, [callId], c);
      if (r?.expired && !joinedSince) {
        await endGroupCallTx(c, fx, call, 'sfu', null);
        return true;
      }
      if (r?.too_long) {
        await endGroupCallTx(c, fx, call, 'max-duration', null);
        return true;
      }
      return false;
    });
    // Sala sumiu (LiveKit reiniciado): recria para as pessoas reconectarem sem esperar.
    if (!ended && missing === 'not_found') await lk.createRoom(first.sfu_room, roomOptions(first)).catch(() => {});
    return;
  }
  markRoomSeen(callId);
  const inSfu = new Map(list!.map((p) => [p.identity, p]));
  await withCallLock(callId, async (c, fx) => {
    let call = await loadCallRow(callId, c);
    if (!call || !isLive(call)) return;
    const room = await loadRoomInfo(call.room_id, c);
    await c.query(`UPDATE calls SET sfu_missing_since = NULL WHERE id = $1 AND sfu_missing_since IS NOT NULL`, [callId]);
    const rows = await loadParticipants(callId, c);
    const live = await many(`SELECT user_id, ${presentSql()} AS present FROM call_participants p WHERE call_id = $1`, [callId], c);
    const present = new Map(live.map((r) => [r.user_id, r.present]));
    // 1. Quem o LiveKit não tem mais, quem chegou sem webhook, e tokens de entrada que venceram sem conexão.
    for (const r of rows) {
      if (!unchanged(r)) continue;
      const p = inSfu.get(r.user_id);
      if (r.state === 'joined' && !p) await markLeftTx(c, fx, call, room, r.user_id, null, 'disconnected');
      else if (r.state === 'joining' && p) await markJoinedTx(c, fx, call, room, r.user_id, p.sid);
      else if (r.state === 'joining' && !p && !present.get(r.user_id)) {
        const left = await leaveRowsTx(c, callId, [r.user_id], 'failed');
        await afterLeaveTx(c, fx, call, room, left);
      }
    }
    // A trava pode ter encerrado a chamada na entrada de alguém (markJoinedTx).
    if (!isLive((await loadCallRow(callId, c))!)) return;
    // 2. No LiveKit sem linha viva, removidos, desativados ou fora da sala: saem.
    const after = new Map((await loadParticipants(callId, c)).map((r) => [r.user_id, r]));
    for (const p of list!) {
      const r = after.get(p.identity);
      const inside = r && (r.state === 'joined' || r.state === 'joining');
      if (inside && r.active && r.member) continue;
      const sfuRoom = call.sfu_room;
      fx.sfu(() => lk.removeParticipant(sfuRoom, p.identity));
      if (inside) {
        const left = await leaveRowsTx(c, callId, [p.identity], r.active ? 'room' : 'deactivated');
        await afterLeaveTx(c, fx, call, room, left);
      }
    }
    // Quem está dentro sem ser mais membro ou ativo (e não aparece no LiveKit) também sai.
    for (const r of after.values()) {
      if ((r.state === 'joined' || r.state === 'joining') && (!r.active || !r.member) && !inSfu.has(r.user_id)) {
        const left = await leaveRowsTx(c, callId, [r.user_id], r.active ? 'room' : 'deactivated');
        await afterLeaveTx(c, fx, call, room, left);
      }
    }
    // 3. A sala mudou (C5): na v1a uma chamada comum numa sala que virou somente leitura, de avisos ou oculta acaba.
    if (room.archived) return void (await endGroupCallTx(c, fx, call, 'room', null));
    if (!call.listen_only && isTransmissionRoom(room)) return void (await endGroupCallTx(c, fx, call, 'readonly', null));
    // 4. A trava antes das permissões: uma mudança que só a reconciliação vê (fim do silêncio na sala, papel novo) pode
    // formar um par, e a pausa tem de valer antes de qualquer canPublish true sair para o LiveKit.
    if ((await evaluateGuardTx(c, fx, callId)) === 'ended') return;
    // 5. Permissões: o que o LiveKit aplica ou o que guardamos difere do que vale agora (até 20 por passada).
    call = await loadCallRow(callId, c);
    const force = new Set<string>();
    for (const r of await loadParticipants(callId, c)) {
      if (r.state !== 'joined' || force.size >= 20 || !unchanged(r)) continue;
      const p = inSfu.get(r.user_id);
      if (!p) continue;
      const g = grantsFor({ username: r.username }, call, room, rolesOf(r), r);
      const sfuSources = p.permission.canPublish ? p.permission.canPublishSources : [];
      if (p.permission.canPublish !== g.canPublish || !sameSources(sfuSources, g.sources) || p.permission.canPublishData || p.permission.canUpdateMetadata) force.add(r.user_id);
    }
    await applyGrantsTx(c, fx, call, room, { force });
    // 6. Faixas que os webhooks não trouxeram. A lista é de antes do passo 5: uma fonte que o LiveKit ainda deixava
    // (silêncio na sala visto agora, por exemplo) sai com a permissão nova, sem expulsar ninguém.
    for (const r of await loadParticipants(callId, c)) {
      if (r.state !== 'joined') continue;
      const p = inSfu.get(r.user_id);
      const bad = p?.tracks.find((t) => t.type !== 'data' && !trackAllowed(r, call, room, t, p.permission));
      if (bad) await tamperTx(c, fx, call, room, r, bad);
    }
    // 7. Os relógios.
    const clocks = await one(
      `SELECT empty_since < now() - make_interval(secs => ${CALL_LIMITS.emptyGraceSeconds}) AS empty,
              alone_since < now() - make_interval(mins => ${CALL_LIMITS.aloneMinutes}) AS alone,
              created_at < now() - make_interval(hours => $2) AS too_long
         FROM calls WHERE id = $1`,
      [callId, maxHours()],
      c,
    );
    call = await loadCallRow(callId, c);
    if (clocks?.empty) await endGroupCallTx(c, fx, call, 'empty', null);
    else if (clocks?.alone) await endGroupCallTx(c, fx, call, 'alone', null);
    else if (clocks?.too_long) await endGroupCallTx(c, fx, call, 'max-duration', null);
  });
}

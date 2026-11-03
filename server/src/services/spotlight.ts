// Busca da barra lateral (Ctrl+K): pessoas para conversar e canais públicos em que a pessoa ainda não está.
// Só leitura. Conversas em que a pessoa já está ficam na busca local da web; aqui vem só o que falta.
import type { SpotlightRoom, SpotlightUser } from '@shared/index';
import { escapeLike, parseSpotlightQuery, spotlightReady } from '@shared/search';
import { many } from '../db/pool';
import { truncate } from '../lib/text';
import { visibleStatusCustom } from './mappers';
import { hasPermission } from './permissions';
import type { Ctx } from './users';

const LIMIT = 8;

// Pessoas: sem quem pergunta, sem bots e sem contas desativadas. Ordem: usuário exato, começo do usuário ou do
// nome, começo de uma palavra do nome, qualquer parte.
async function searchPeople(userId: string, like: string, text: string): Promise<SpotlightUser[]> {
  const rows = await many(
    `WITH q AS (SELECT wescc_fold($2) AS f)
     SELECT u.id, u.username, u.name, u.status, u.status_text, u.status_custom, u.roles, u.avatar_etag
     FROM users u CROSS JOIN q
     WHERE u.active AND u.type = 'user' AND u.id <> $1
       AND (wescc_fold(u.username) LIKE '%' || q.f || '%' OR wescc_fold(u.name) LIKE '%' || q.f || '%')
     ORDER BY CASE
         WHEN lower(u.username) = lower($3) THEN 0
         WHEN wescc_fold(u.username) LIKE q.f || '%' OR wescc_fold(u.name) LIKE q.f || '%' THEN 1
         WHEN wescc_fold(u.name) LIKE '% ' || q.f || '%' THEN 2
         ELSE 3 END,
       lower(coalesce(nullif(u.name, ''), u.username))
     LIMIT ${LIMIT}`,
    [userId, like, text],
  );
  return rows.map((r) => ({
    _id: r.id,
    username: r.username,
    name: r.name,
    status: r.status,
    statusText: r.status_text || undefined,
    statusCustom: visibleStatusCustom(r),
    roles: r.roles ?? [],
    avatarETag: r.avatar_etag,
  }));
}

// Canais: as mesmas regras de canAccessRoom (canal de time privado só para membros do time), sem os arquivados, os
// de que a pessoa foi banida (joinRoom recusa) e os que ela já tem na lista.
async function searchRooms(userId: string, like: string, text: string): Promise<SpotlightRoom[]> {
  const rows = await many(
    `WITH q AS (SELECT wescc_fold($2) AS f)
     SELECT r.id, r.name, r.fname, r.topic, r.users_count, r.team_id, r.team_main, r.notice,
            (coalesce(r.join_code, '') <> '') AS has_code, t.name AS team_name
     FROM rooms r CROSS JOIN q LEFT JOIN teams t ON t.id = r.team_id
     WHERE r.t = 'c' AND r.prid IS NULL AND NOT r.archived
       AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.room_id = r.id AND s.user_id = $1)
       AND NOT coalesce(r.custom_fields->'banned' ? $1, false)
       AND (r.team_id IS NULL OR r.team_main OR t.type = 0
            OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = r.team_id AND m.user_id = $1))
       AND (wescc_fold(r.name) LIKE '%' || q.f || '%' OR wescc_fold(coalesce(r.fname, '')) LIKE '%' || q.f || '%')
     ORDER BY CASE
         WHEN lower(r.name) = lower($3) THEN 0
         WHEN wescc_fold(r.name) LIKE q.f || '%' OR wescc_fold(coalesce(r.fname, '')) LIKE q.f || '%' THEN 1
         ELSE 2 END,
       r.featured DESC, r.users_count DESC, r.name
     LIMIT ${LIMIT}`,
    [userId, like, text],
  );
  const anyCode = rows.some((r) => r.has_code);
  const bypass = anyCode && (await hasPermission(userId, 'join-without-join-code'));
  return rows.map((r) => ({
    _id: r.id,
    t: 'c' as const,
    name: r.name,
    fname: r.fname || r.name,
    topic: truncate(r.topic ?? '', 120) || undefined,
    usersCount: Number(r.users_count ?? 0),
    teamId: r.team_id,
    teamMain: !!r.team_main,
    teamName: r.team_main ? undefined : r.team_name ?? undefined,
    notice: !!r.notice,
    joinCodeRequired: !!r.has_code && !bypass,
  }));
}

export async function spotlight(ctx: Ctx, raw: string): Promise<{ users: SpotlightUser[]; rooms: SpotlightRoom[] }> {
  const q = parseSpotlightQuery(raw);
  if (!spotlightReady(q)) return { users: [], rooms: [] };
  const like = escapeLike(q.text);
  // Sem create-d não há com quem abrir conversa nova (as DMs que já existem aparecem na busca local).
  // Sem view-c-room, nenhum canal público abre (a mesma regra de canAccessRoom).
  const [people, channels] = await Promise.all([
    q.scope !== 'rooms' && hasPermission(ctx.userId, 'create-d'),
    q.scope !== 'users' && hasPermission(ctx.userId, 'view-c-room'),
  ]);
  const [users, rooms] = await Promise.all([
    people ? searchPeople(ctx.userId, like, q.text) : [],
    channels ? searchRooms(ctx.userId, like, q.text) : [],
  ]);
  return { users, rooms };
}

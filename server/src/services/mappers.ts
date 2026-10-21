import type { Message, Room, Subscription, Team, User } from '@shared/index';

export function mapUser(r: any, opts: { full?: boolean } = {}): User {
  const u: User = {
    _id: r.id,
    username: r.username,
    name: r.name,
    status: r.status,
    statusText: r.status_text || undefined,
    active: r.active,
    type: r.type,
    roles: r.roles,
    bio: r.bio || undefined,
    avatarETag: r.avatar_etag,
    createdAt: r.created_at,
  };
  if (opts.full) {
    u.email = r.email ?? undefined;
    u.emailVerified = r.email_verified;
    u.statusDefault = r.status_default;
    u.authSource = r.auth_source;
    if (r.auth_source === 'oauth' && r.external_id) u.authProvider = String(r.external_id).split(':')[0];
    u.twoFactorEnabled = r.totp_enabled;
    u.preferences = r.preferences;
    u.lastLogin = r.last_login;
  }
  return u;
}

export function mapRoom(r: any): Room {
  return {
    _id: r.id,
    t: r.t,
    name: r.name,
    fname: r.fname,
    topic: r.topic || undefined,
    description: r.description || undefined,
    announcement: r.announcement || undefined,
    u: r.owner_id ? { _id: r.owner_id, username: r.owner_username ?? '' } : undefined,
    ro: r.ro,
    archived: r.archived,
    default: r.is_default,
    featured: r.featured,
    encrypted: r.encrypted,
    broadcast: r.broadcast,
    reactWhenReadOnly: r.react_when_ro,
    teamId: r.team_id,
    teamMain: r.team_main,
    prid: r.prid,
    pmid: r.pmid,
    usernames: r.t === 'd' ? r.usernames : undefined,
    uids: r.t === 'd' ? r.uids : undefined,
    usersCount: r.users_count,
    msgs: r.msgs,
    lastMessage: r.last_message,
    lm: r.lm,
    retention: r.retention,
    ts: r.created_at,
    _updatedAt: r.updated_at,
  };
}

// Espera colunas da subscription (s_*) e da sala.
export function mapSubscription(s: any, room: any, user: { id: string; username: string }, dmName?: { name: string; fname: string }): Subscription {
  return {
    _id: s.id,
    rid: s.room_id,
    u: { _id: user.id, username: user.username },
    t: room.t,
    name: dmName?.name ?? room.name ?? '',
    fname: dmName?.fname ?? room.fname ?? room.name ?? '',
    roles: s.roles,
    open: s.open,
    alert: s.alert,
    unread: s.unread,
    userMentions: s.user_mentions,
    groupMentions: s.group_mentions,
    tunread: s.tunread,
    f: s.favorite,
    ls: s.ls,
    ts: s.created_at,
    prid: room.prid,
    teamId: room.team_id,
    teamMain: room.team_main,
    notifications: s.notifications,
    _updatedAt: s.updated_at,
  };
}

export function mapMessage(r: any): Message {
  const files = r.files ?? [];
  return {
    _id: r.id,
    rid: r.room_id,
    msg: r.msg,
    u: { _id: r.user_id ?? r.extra?.visitorId ?? null, username: r.username, name: r.user_name },
    t: r.t,
    ts: r.created_at,
    _updatedAt: r.updated_at,
    tmid: r.tmid,
    tcount: r.tcount || undefined,
    tlm: r.tlm,
    replies: r.replies?.length ? r.replies : undefined,
    drid: r.drid,
    dcount: r.dcount || undefined,
    dlm: r.dlm,
    mentions: r.mentions,
    channels: r.channels,
    reactions: r.reactions,
    attachments: r.attachments,
    file: files[0] ?? null,
    files,
    pinned: r.pinned,
    pinnedAt: r.pinned_at,
    pinnedBy: r.pinned_by,
    starred: (r.starred ?? []).map((id: string) => ({ _id: id })),
    editedAt: r.edited_at,
    editedBy: r.edited_by,
    alias: r.alias ?? undefined,
    emoji: r.emoji ?? undefined,
    avatar: r.avatar ?? undefined,
    unread: r.unread ?? undefined,
  };
}

export function mapTeam(r: any): Team {
  return {
    _id: r.id,
    name: r.name,
    type: r.type,
    roomId: r.room_id,
    createdBy: { _id: r.created_by, username: r.created_by_username ?? '' },
    createdAt: r.created_at,
    roomsCount: r.rooms_count ?? undefined,
    membersCount: r.members_count ?? undefined,
  };
}

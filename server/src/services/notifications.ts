import type { UserRef } from '@shared/index';
import { many } from '../db/pool';
import { bus } from '../realtime/bus';
import { sendMail } from './mailer';
import { getSetting } from './settings';
import type { Ctx } from './users';

// Decide quem recebe notificação (desktop/in-app e e-mail) para uma nova mensagem.
export async function dispatchNotifications(ctx: Ctx, room: any, row: any, mentions: UserRef[], parent: any) {
  const members = await many(
    `SELECT s.user_id, s.notifications, u.username, u.name, u.email, u.status, u.preferences
     FROM subscriptions s JOIN users u ON u.id = s.user_id
     WHERE s.room_id = $1 AND s.user_id <> $2 AND u.active`,
    [room.id, ctx.userId],
  );
  if (!members.length) return;
  const ids = new Set(mentions.map((m) => m._id));
  const all = ids.has('all');
  const here = ids.has('here');
  const teamIds = mentions.filter((m) => (m as any).type === 'team').map((m) => m._id);
  const teamMembers = teamIds.length
    ? new Set((await many('SELECT user_id FROM team_members WHERE team_id = ANY($1)', [teamIds])).map((r) => r.user_id))
    : new Set<string>();
  const followers = new Set<string>(row.tmid && parent ? parent.replies ?? [] : []);
  const isDM = room.t === 'd';
  const roomName = isDM ? ctx.username : room.fname || room.name || '';
  const hidePush = getSetting<boolean>('Push_Privacy_Hide_Content');
  const text = row.msg || (row.files?.length ? `📎 ${row.files[0].name}` : '');
  const emailEnabled = getSetting<boolean>('Email_Notifications_Enabled');

  for (const m of members) {
    const prefs = m.notifications ?? {};
    if (prefs.disableNotifications) continue;
    const mentioned = ids.has(m.user_id) || teamMembers.has(m.user_id) || (!prefs.muteGroupMentions && (all || (here && m.status !== 'offline')));
    const following = followers.has(m.user_id);
    let desktop: string = prefs.desktop && prefs.desktop !== 'default' ? prefs.desktop : m.preferences?.desktopNotifications ?? (isDM ? 'all' : 'mentions');
    if (isDM && (!prefs.desktop || prefs.desktop === 'default')) desktop = 'all';
    const notify = desktop === 'all' ? !row.tmid || following || mentioned : desktop === 'mentions' ? mentioned || (isDM && !row.tmid) || following : false;
    if (notify) {
      bus.publish(
        { user: m.user_id },
        {
          type: 'notification',
          rid: room.id,
          title: isDM ? (room.uids.length > 2 ? `${ctx.username} em ${roomName}` : ctx.username) : `#${roomName}`,
          text: hidePush ? 'Você tem uma nova mensagem' : `${isDM ? '' : `${ctx.username}: `}${text}`.slice(0, 300),
          messageId: row.id,
          sender: { _id: ctx.userId, username: ctx.username },
          tmid: row.tmid,
        },
      );
    }
    // E-mail para quem está offline e foi mencionado (ou recebeu DM).
    const emailPref = prefs.email && prefs.email !== 'default' ? prefs.email : m.preferences?.emailNotificationMode ?? 'mentions';
    if (emailEnabled && m.email && m.status === 'offline' && emailPref !== 'nothing' && (mentioned || isDM)) {
      const site = getSetting<string>('Site_Name');
      const url = `${getSetting<string>('Site_Url')}/${isDM ? 'direct' : room.t === 'p' ? 'group' : 'channel'}/${room.id}`;
      void sendMail({
        to: m.email,
        subject: `[${site}] ${isDM ? `Mensagem direta de ${ctx.username}` : `Você foi mencionado em #${roomName}`}`,
        text: `${ctx.username}: ${hidePush ? '(conteúdo oculto)' : text}\n\nAbrir: ${url}`,
      });
    }
  }
}

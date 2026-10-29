import type { UserRef } from '@shared/index';
import { messagePreviewText } from '@shared/stickers';
import { many } from '../db/pool';
import { truncate } from '../lib/text';
import { bus } from '../realtime/bus';
import { sendMail } from './mailer';
import { getSetting } from './settings';
import type { Ctx } from './users';

// Avisos do Jira (eventos e resumos), cartões de reunião do Teams e mensagens espelhadas do Teams trazem markdown que o
// próprio servidor montou: na notificação, no push e no e-mail vão sem ** e com o rótulo do link no lugar de [rótulo](url).
// Texto de fora já chega com "](" quebrado por U+200B (safeExternalText), então só os links do servidor casam.
export function plainIntegrationText(s: string): string {
  return s.replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, '$1').replace(/\*\*([^*\n]+)\*\*/g, '$1');
}

async function serverBuiltMarkdown(ctx: Ctx, row: any): Promise<boolean> {
  if (row.extra?.jira || row.extra?.meeting) return true;
  const { botIds } = await import('../integrations/bots');
  return (await botIds()).includes(ctx.userId);
}

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
  // Quem a pessoa vê como autor: o apelido da mensagem (ponte do Teams "Ana Souza (Teams)", webhooks) ou o usuário.
  // O sender do evento continua a conta que publicou.
  const senderName: string = row.alias ? truncate(String(row.alias), 100) : ctx.username;
  const roomName = isDM ? senderName : room.fname || room.name || '';
  const hidePush = getSetting<boolean>('Push_Privacy_Hide_Content');
  const preview = messagePreviewText({ msg: row.msg, sticker: row.extra?.sticker, files: row.files });
  const text = (await serverBuiltMarkdown(ctx, row)) ? plainIntegrationText(preview) : preview;
  const emailEnabled = getSetting<boolean>('Email_Notifications_Enabled');
  const pushTargets: string[] = [];
  const title = isDM ? (room.uids.length > 2 ? `${senderName} em ${roomName}` : senderName) : `#${roomName}`;
  const body = hidePush ? 'Você tem uma nova mensagem' : `${isDM ? '' : `${senderName}: `}${text}`.slice(0, 300);

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
        { type: 'notification', rid: room.id, title, text: body, messageId: row.id, sender: { _id: ctx.userId, username: ctx.username }, tmid: row.tmid },
      );
      pushTargets.push(m.user_id);
    }
    // E-mail para quem está offline e foi mencionado (ou recebeu DM).
    const emailPref = prefs.email && prefs.email !== 'default' ? prefs.email : m.preferences?.emailNotificationMode ?? 'mentions';
    if (emailEnabled && m.email && m.status === 'offline' && emailPref !== 'nothing' && (mentioned || isDM)) {
      const site = getSetting<string>('Site_Name');
      const url = `${getSetting<string>('Site_Url')}/${isDM ? 'direct' : room.t === 'p' ? 'group' : 'channel'}/${room.id}`;
      void sendMail({
        to: m.email,
        subject: `[${site}] ${isDM ? `Mensagem direta de ${senderName}` : `Você foi mencionado em #${roomName}`}`,
        text: `${senderName}: ${hidePush ? '(conteúdo oculto)' : text}\n\nAbrir: ${url}`,
      });
    }
  }

  // Push só para quem não está com o chat aberto em nenhum lugar (quem está recebe a notificação pelo WebSocket).
  if (pushTargets.length && getSetting('Push_enable')) {
    const online = new Set((await many('SELECT DISTINCT user_id FROM presence_connections WHERE user_id = ANY($1)', [pushTargets])).map((r) => r.user_id));
    const offline = pushTargets.filter((id) => !online.has(id));
    if (offline.length) {
      const { sendPush } = await import('./push');
      const base = isDM ? 'direct' : room.t === 'p' ? 'group' : room.t === 'l' ? 'live' : 'channel';
      const path = `/${base}/${room.id}${row.tmid ? `/thread/${row.tmid}` : ''}`;
      void sendPush(offline, { title, body, url: path, tag: room.id }).catch(() => {});
    }
  }
}

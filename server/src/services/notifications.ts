import type { UserRef } from '@shared/index';
import { messagePreviewText } from '@shared/stickers';
import { silencesNotifications } from '@shared/status';
import { many } from '../db/pool';
import { truncate } from '../lib/text';
import { bus } from '../realtime/bus';
import { sendMail } from './mailer';
import { getSetting } from './settings';
import type { Ctx } from './users';

// Avisos do Jira (eventos e resumos) e cartões de reunião trazem markdown que o
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

async function groupDmLabel(uids: string[]) {
  const rows = await many('SELECT coalesce(nullif(trim(name), \'\'), username) AS n FROM users WHERE id = ANY($1) ORDER BY 1', [uids]);
  const names = rows.map((r) => r.n as string);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}` : names.join('');
}

// Decide quem recebe notificação (desktop/in-app, push e e-mail) para uma nova mensagem.
// highlights: quem tem palavra destacada na mensagem (userId -> palavra), avisado como numa menção.
export async function dispatchNotifications(ctx: Ctx, room: any, row: any, mentions: UserRef[], parent: any, highlights: Map<string, string> = new Map()) {
  const members = await many(
    `SELECT s.user_id, s.notifications, u.username, u.name, u.email, u.status, u.status_default, u.preferences
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
  // Quem a pessoa vê como autor: o apelido da mensagem (webhooks) ou o usuário.
  // O sender do evento continua a conta que publicou.
  // Pessoa aparece pelo nome, como nas telas do chat ("Ana Souza", não "ana"); sem nome, o usuário.
  const sender = row.alias ? null : (await many('SELECT name FROM users WHERE id = $1', [ctx.userId]))[0];
  const senderName: string = row.alias ? truncate(String(row.alias), 100) : sender?.name?.trim() || ctx.username;
  // Conversa em grupo (DM com 3+): "Ana Souza em Ana Souza, Bruno Lima e Carla Dias" (antes saía "ana em ana").
  const groupDM = isDM && (room.uids?.length ?? 0) > 2;
  const roomName = groupDM ? await groupDmLabel(room.uids) : isDM ? senderName : room.fname || room.name || '';
  const hidePush = getSetting<boolean>('Push_Privacy_Hide_Content');
  const preview = messagePreviewText({ msg: row.msg, sticker: row.extra?.sticker, files: row.files, forward: row.extra?.forward, poll: row.extra?.poll, e2e: row.e2e });
  // Cifrada: "Mensagem criptografada" no push e no e-mail; quem está com o chat aberto decifra no navegador (e2e).
  const text = !row.e2e && (await serverBuiltMarkdown(ctx, row)) ? plainIntegrationText(preview) : preview;
  const e2e = row.e2e && !hidePush ? { envelope: row.e2e, prefix: isDM ? '' : `${senderName}: ` } : undefined;
  const emailEnabled = getSetting<boolean>('Email_Notifications_Enabled');
  const pushTargets: string[] = [];
  const title = isDM ? (groupDM ? `${senderName} em ${roomName}` : senderName) : `#${roomName}`;
  const body = hidePush ? 'Você tem uma nova mensagem' : `${isDM ? '' : `${senderName}: `}${text}`.slice(0, 300);
  // Quem tem o chat aberto em algum lugar (uma consulta só): o push e o e-mail vão para quem não tem. Pela conexão, não
  // pelo status: quem está invisível com o chat aberto aparece offline, mas já recebe pelo WebSocket.
  const pushOn = !!getSetting('Push_enable');
  const connected =
    emailEnabled || pushOn
      ? new Set((await many('SELECT DISTINCT user_id FROM presence_connections WHERE user_id = ANY($1)', [members.map((m) => m.user_id)])).map((r) => r.user_id))
      : new Set<string>();

  for (const m of members) {
    const prefs = m.notifications ?? {};
    if (prefs.disableNotifications) continue;
    // Ocupado (escolhido, mesmo com o chat fechado): sem notificação, som, push nem e-mail. Os contadores já subiram.
    if (silencesNotifications(m.status_default)) continue;
    const direct = ids.has(m.user_id) || teamMembers.has(m.user_id) || (!prefs.muteGroupMentions && (all || (here && m.status !== 'offline')));
    const word = highlights.get(m.user_id);
    const mentioned = direct || !!word;
    const following = followers.has(m.user_id);
    let desktop: string = prefs.desktop && prefs.desktop !== 'default' ? prefs.desktop : m.preferences?.desktopNotifications ?? (isDM ? 'all' : 'mentions');
    if (isDM && (!prefs.desktop || prefs.desktop === 'default')) desktop = 'all';
    const notify = desktop === 'all' ? !row.tmid || following || mentioned : desktop === 'mentions' ? mentioned || (isDM && !row.tmid) || following : false;
    if (notify) {
      bus.publish(
        { user: m.user_id },
        { type: 'notification', rid: room.id, title, text: body, messageId: row.id, sender: { _id: ctx.userId, username: ctx.username }, tmid: row.tmid, e2e },
      );
      pushTargets.push(m.user_id);
    }
    // E-mail para quem está sem o chat aberto e foi mencionado (ou recebeu DM, ou tem a palavra destacada).
    const emailPref = prefs.email && prefs.email !== 'default' ? prefs.email : m.preferences?.emailNotificationMode ?? 'mentions';
    if (emailEnabled && m.email && !connected.has(m.user_id) && emailPref !== 'nothing' && (mentioned || isDM)) {
      const site = getSetting<string>('Site_Name');
      const url = `${getSetting<string>('Site_Url')}/${isDM ? 'direct' : room.t === 'p' ? 'group' : 'channel'}/${room.id}`;
      const subject = isDM ? `Mensagem direta de ${senderName}` : !direct && word ? `“${word}” em #${roomName}` : `Você foi mencionado em #${roomName}`;
      void sendMail({
        to: m.email,
        subject: `[${site}] ${subject}`,
        text: `${senderName}: ${hidePush ? '(conteúdo oculto)' : text}\n\nAbrir: ${url}`,
      });
    }
  }

  // Push só para quem não está com o chat aberto em nenhum lugar (quem está recebe a notificação pelo WebSocket).
  if (pushTargets.length && pushOn) {
    const offline = pushTargets.filter((id) => !connected.has(id));
    if (offline.length) {
      const { sendPush } = await import('./push');
      const base = isDM ? 'direct' : room.t === 'p' ? 'group' : 'channel';
      const path = `/${base}/${room.id}${row.tmid ? `/thread/${row.tmid}` : ''}`;
      void sendPush(offline, { title, body, url: path, tag: room.id }).catch(() => {});
    }
  }
}

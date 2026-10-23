import { callScopeOf, isTransmissionRoom } from '@shared/calls';
import { sfuConfig } from '../calls/livekit';
import { one } from '../db/pool';
import { ApiError, badRequest, forbidden } from '../lib/errors';
import { bus } from '../realtime/bus';
import { sendMessage } from './messages';
import {
  createDirect,
  createRoom,
  getRoomByName,
  inviteToRoom,
  joinRoom,
  kickFromRoom,
  leaveRoom,
  saveRoomSettings,
  setArchived,
  setMuted,
  updateSubscriptionFlags,
} from './rooms';
import { getSetting } from './settings';
import { setStatus, type Ctx } from './users';

export interface SlashCommand {
  command: string;
  params: string;
  description: string;
  run(ctx: Ctx, room: any, args: string, tmid: string | null): Promise<unknown>;
  // Integrações (Jira/Teams): esconde o comando da lista e da ajuda para quem não pode usá-lo.
  visible?: (ctx: Ctx) => boolean | Promise<boolean>;
}

const commands = new Map<string, SlashCommand>();

function reg(command: string, params: string, description: string, run: SlashCommand['run']) {
  commands.set(command, { command, params, description, run });
}

// Integrações (Jira/Teams): módulos registram os próprios comandos.
export function registerCommand(cmd: SlashCommand) {
  commands.set(cmd.command, cmd);
}

const usernames = (s: string) => [...s.matchAll(/@?([0-9a-zA-Z._-]+)/g)].map((m) => m[1]);

async function userIdsOf(names: string[]) {
  const out: string[] = [];
  for (const n of names) {
    const u = await one('SELECT id FROM users WHERE lower(username) = lower($1)', [n]);
    if (!u) throw badRequest('error-invalid-user', `Usuário @${n} não encontrado.`);
    out.push(u.id);
  }
  return out;
}

async function roomArg(args: string, fallback: any) {
  const name = args.trim().replace(/^#/, '');
  if (!name) return fallback;
  const r = await getRoomByName(name);
  if (!r) throw badRequest('error-room-not-found', `Sala #${name} não encontrada.`);
  return r;
}

const ok = (command: string) => ({ ok: true, command });

const say = (text: string) => async (ctx: Ctx, room: any, args: string, tmid: string | null) =>
  sendMessage(ctx, { rid: room.id, msg: args ? `${args} ${text}` : text, tmid }, { skipCommands: true });

reg('join', '#canal', 'Entrar em um canal', async (ctx, room, args) => {
  const r = await roomArg(args, null);
  if (!r) throw badRequest('error-invalid-params', 'Informe o canal: /join #canal');
  await joinRoom(ctx, r.id);
  return ok('join');
});
reg('leave', '', 'Sair da sala atual', async (ctx, room) => {
  await leaveRoom(ctx, room.id);
  return ok('leave');
});
commands.set('part', { ...commands.get('leave')!, command: 'part' });
reg('invite', '@usuário', 'Convidar usuários para a sala', async (ctx, room, args) => {
  await inviteToRoom(ctx, room.id, await userIdsOf(usernames(args)));
  return ok('invite');
});
reg('kick', '@usuário', 'Remover um usuário da sala', async (ctx, room, args) => {
  for (const id of await userIdsOf(usernames(args))) await kickFromRoom(ctx, room.id, id);
  return ok('kick');
});
reg('topic', 'texto', 'Definir o tópico da sala', async (ctx, room, args) => {
  await saveRoomSettings(ctx, room.id, { roomTopic: args });
  return ok('topic');
});
reg('archive', '[#canal]', 'Arquivar a sala', async (ctx, room, args) => {
  await setArchived(ctx, (await roomArg(args, room)).id, true);
  return ok('archive');
});
reg('unarchive', '[#canal]', 'Desarquivar a sala', async (ctx, room, args) => {
  await setArchived(ctx, (await roomArg(args, room)).id, false);
  return ok('unarchive');
});
reg('mute', '@usuário', 'Silenciar um usuário na sala', async (ctx, room, args) => {
  for (const id of await userIdsOf(usernames(args))) await setMuted(ctx, room.id, id, true);
  return ok('mute');
});
reg('unmute', '@usuário', 'Remover silêncio de um usuário', async (ctx, room, args) => {
  for (const id of await userIdsOf(usernames(args))) await setMuted(ctx, room.id, id, false);
  return ok('unmute');
});
reg('msg', '@usuário mensagem', 'Enviar mensagem direta', async (ctx, _room, args) => {
  const m = args.match(/^@?([0-9a-zA-Z._-]+)\s+([\s\S]+)$/);
  if (!m) throw badRequest('error-invalid-params', 'Uso: /msg @usuário mensagem');
  const dm = await createDirect(ctx, [m[1]]);
  await sendMessage(ctx, { rid: dm.id, msg: m[2] }, { skipCommands: true });
  return ok('msg');
});
reg('create', '#canal [private]', 'Criar um canal', async (ctx, _room, args) => {
  const m = args.match(/^#?([^\s]+)(\s+private)?/);
  if (!m) throw badRequest('error-invalid-params', 'Uso: /create #canal [private]');
  await createRoom(ctx, { type: m[2] ? 'p' : 'c', name: m[1] });
  return ok('create');
});
reg('invite-all-to', '#sala', 'Convidar todos desta sala para outra', async (ctx, room, args) => {
  const target = await roomArg(args, null);
  if (!target) throw badRequest('error-invalid-params', 'Uso: /invite-all-to #sala');
  const { many } = await import('../db/pool');
  const ids = (await many('SELECT user_id FROM subscriptions WHERE room_id = $1', [room.id])).map((r) => r.user_id);
  await inviteToRoom(ctx, target.id, ids);
  return ok('invite-all-to');
});
reg('invite-all-from', '#sala', 'Convidar todos de outra sala para esta', async (ctx, room, args) => {
  const source = await roomArg(args, null);
  if (!source) throw badRequest('error-invalid-params', 'Uso: /invite-all-from #sala');
  const { many } = await import('../db/pool');
  const ids = (await many('SELECT user_id FROM subscriptions WHERE room_id = $1', [source.id])).map((r) => r.user_id);
  await inviteToRoom(ctx, room.id, ids);
  return ok('invite-all-from');
});
reg('hide', '', 'Ocultar a sala da barra lateral', async (ctx, room) => {
  await updateSubscriptionFlags(ctx, room.id, { open: false });
  return ok('hide');
});
reg('status', 'texto', 'Definir mensagem de status', async (ctx, _room, args) => {
  await setStatus(ctx.userId, undefined, args);
  return ok('status');
});
reg('away', '', 'Ficar ausente', async (ctx) => {
  await setStatus(ctx.userId, 'away');
  return ok('away');
});
reg('busy', '', 'Ficar ocupado', async (ctx) => {
  await setStatus(ctx.userId, 'busy');
  return ok('busy');
});
reg('online', '', 'Ficar online', async (ctx) => {
  await setStatus(ctx.userId, 'online');
  return ok('online');
});
reg('me', 'ação', 'Mensagem em terceira pessoa', async (ctx, room, args, tmid) =>
  sendMessage(ctx, { rid: room.id, msg: `_${args}_`, tmid }, { skipCommands: true }),
);
reg('shrug', '[mensagem]', '¯\\_(ツ)_/¯', say('¯\\\\_(ツ)_/¯'));
reg('tableflip', '[mensagem]', '(╯°□°）╯︵ ┻━┻', say('(╯°□°）╯︵ ┻━┻'));
reg('unflip', '[mensagem]', '┬─┬ ノ( ゜-゜ノ)', say('┬─┬ ノ( ゜-゜ノ)'));
reg('lennyface', '[mensagem]', '( ͡° ͜ʖ ͡°)', say('( ͡° ͜ʖ ͡°)'));
reg('gimme', '[mensagem]', '༼ つ ◕_◕ ༽つ', async (ctx, room, args, tmid) =>
  sendMessage(ctx, { rid: room.id, msg: `༼ つ ◕_◕ ༽つ ${args}`.trim(), tmid }, { skipCommands: true }),
);
// Link do Jitsi (serviço externo), como antes; só com VideoConf_Enabled.
const jitsiLink = (ctx: Ctx, room: any, tmid: string | null) => {
  const url = `https://${getSetting('VideoConf_Jitsi_Domain')}/${getSetting('VideoConf_Jitsi_Prefix')}-${room.id}`;
  return sendMessage(ctx, { rid: room.id, msg: `📞 Chamada de vídeo iniciada: ${url}`, tmid }, { skipCommands: true });
};
// /call, /call voz, /call vídeo: a web abre a tela de entrada da chamada (a dois, já toca). Nada é postado na sala;
// calls.start confere tudo de novo.
reg('call', '[voz|vídeo]', 'Iniciar uma chamada de voz ou vídeo nesta sala', async (ctx, room, args, tmid) => {
  const a = args.trim().toLocaleLowerCase('pt-BR');
  const kind = a === 'voz' || a === 'audio' || a === 'áudio' ? 'audio' : 'video';
  const enabled = !!getSetting('Calls_Enabled');
  const scope = room.t === 'l' ? null : callScopeOf(room);
  const groupOk = !!getSetting('Calls_Group_Enabled') && sfuConfig().configured;
  if (enabled && scope && (scope === 'direct' || groupOk)) {
    if (scope === 'group' && isTransmissionRoom(room)) throw new ApiError(403, 'error-call-not-allowed', 'Esta sala não aceita chamadas.');
    bus.publish({ user: ctx.userId }, { type: 'call.prompt', rid: room.id, kind });
    return ok('call');
  }
  if (getSetting('VideoConf_Enabled')) return jitsiLink(ctx, room, tmid);
  if (!enabled) throw forbidden('As chamadas estão desativadas.');
  if (room.t === 'l') throw badRequest('error-call-room', 'Chamadas não estão disponíveis em conversas de atendimento.');
  if (scope === 'group') throw badRequest('error-call-group-disabled', 'Chamadas em grupo estão desativadas. Só é possível ligar em mensagens diretas entre duas pessoas.');
  throw badRequest('error-call-user', 'Este usuário não pode receber chamadas.');
});
reg('jitsi', '', 'Link de videoconferência do Jitsi', async (ctx, room, _args, tmid) => {
  if (!getSetting('VideoConf_Enabled')) throw badRequest('error-videoconf-disabled', 'O Jitsi está desativado. Use /call para uma chamada interna.');
  return jitsiLink(ctx, room, tmid);
});
reg('help', '', 'Listar comandos', async (ctx) => {
  const lines = (await listCommands(ctx)).map((c) => `/${c.command} ${c.params} — ${c.description}`);
  bus.publish({ user: ctx.userId }, { type: 'notification', rid: '', title: 'Comandos disponíveis', text: lines.join('\n'), messageId: '', sender: { _id: 'system', username: 'system' } });
  return ok('help');
});

export async function listCommands(ctx?: Ctx) {
  const out = [];
  for (const c of commands.values()) {
    if (c.visible && (!ctx || !(await c.visible(ctx)))) continue;
    out.push({ command: c.command, params: c.params, description: c.description });
  }
  return out;
}

// Retorna false quando não é um comando conhecido (a mensagem segue como texto).
export async function runSlashCommand(ctx: Ctx, room: any, msg: string, tmid: string | null) {
  const m = msg.match(/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i);
  if (!m) return false;
  const cmd = commands.get(m[1].toLowerCase());
  if (!cmd) return false;
  return cmd.run(ctx, room, (m[2] ?? '').trim(), tmid);
}

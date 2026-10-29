// /teams (§5.7): toda resposta é efêmera. canPostInRoom e a restrição de chamadas (assertCanMeet) vêm antes de tudo, porque
// commands.run não confere (H1).
import type { EphemeralMessage } from '@shared/integrations';
import { ApiError } from '../../lib/errors';
import { canPostInRoom } from '../../services/messages';
import { hasPermission } from '../../services/permissions';
import type { Ctx } from '../../services/users';
import { sendEphemeral, sessionTag } from '../ephemeral';
import { meetingsMode, teamsOn } from './config';
import { assertCanMeet, linkMeeting, MEETING_TEXT } from './meetings';

export const COMMAND_TEXT = {
  params: '[reuniao | agendar | link]',
  description: 'Reunião do Microsoft Teams nesta sala',
  noPermission: 'Você não tem permissão para marcar reuniões do Teams.',
  opening: 'Abrindo o formulário de reunião do Teams.',
  openForm: 'Abrir formulário',
  linkMissing: 'Cole o link depois do comando: /teams link https://teams.microsoft.com/…',
  failed: 'Não foi possível concluir o comando. Tente de novo.',
  help:
    '**Microsoft Teams no chat**\n`/teams reuniao assunto` abre o formulário de reunião\n`/teams agendar` abre o Teams para marcar data e hora\n`/teams link https://teams.microsoft.com/…` anuncia uma reunião na sala',
};

type Reply = Omit<EphemeralMessage, '_id' | 'ts' | 'rid' | 'tmid' | 'source'>;

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const SUBCOMMANDS: Record<string, 'meeting' | 'schedule' | 'link' | 'help'> = {
  '': 'meeting',
  reuniao: 'meeting',
  criar: 'meeting',
  agendar: 'schedule',
  link: 'link',
  colar: 'link',
  ajuda: 'help',
  help: 'help',
};

export const commandVisible = async (ctx: Ctx) => teamsOn() && meetingsMode() !== 'off' && (await hasPermission(ctx.userId, 'start-msteams-meeting'));

export async function teamsCommand(ctx: Ctx, room: any, args: string, tmid: string | null) {
  const reply = (r: Reply) => sendEphemeral(ctx.userId, { rid: room.id, tmid: tmid ?? null, source: 'msteams', ...r });
  try {
    const answer = await runTeams(ctx, room, String(args ?? '').trim(), tmid);
    if (answer) reply(answer);
  } catch (e) {
    reply({ tone: 'err', text: e instanceof ApiError ? e.message : COMMAND_TEXT.failed });
  }
  return { ok: true, command: 'teams' };
}

function formReply(ctx: Ctx, room: any, tmid: string | null, params: Record<string, string>): Reply {
  return {
    tone: 'info',
    text: COMMAND_TEXT.opening,
    actions: [
      {
        kind: 'modal',
        label: COMMAND_TEXT.openForm,
        modal: 'msteams-meeting',
        params: { roomId: room.id, ...(tmid ? { tmid } : {}), ...params },
        autoOpen: true,
        primary: true,
      },
    ],
    autoOpenFor: sessionTag(ctx.sessionId ?? ''),
  };
}

async function runTeams(ctx: Ctx, room: any, args: string, tmid: string | null): Promise<Reply | null> {
  if (!teamsOn() || meetingsMode() === 'off') return { tone: 'info', text: MEETING_TEXT.off };
  if (!(await hasPermission(ctx.userId, 'start-msteams-meeting'))) return { tone: 'err', text: COMMAND_TEXT.noPermission };
  // Sala em que a pessoa não pode escrever, ou em que ela não pode chamar (DM, discussão da DM, sala a dois):
  // nada acontece, para nenhum subcomando.
  try {
    await canPostInRoom(ctx, room);
    await assertCanMeet(ctx, room);
  } catch (e) {
    if (e instanceof ApiError) return { tone: 'err', text: e.message };
    throw e;
  }

  const [first = '', ...rest] = args.split(/\s+/).filter(Boolean);
  const sub = SUBCOMMANDS[fold(first)];
  const tail = rest.join(' ').trim();
  switch (sub) {
    case 'meeting':
      return formReply(ctx, room, tmid, tail ? { subject: [...tail].slice(0, 200).join('') } : {});
    case 'schedule':
      return formReply(ctx, room, tmid, { tab: 'schedule', ...(tail ? { subject: [...tail].slice(0, 200).join('') } : {}) });
    case 'link': {
      const [url = '', ...subject] = rest;
      if (!url) return { tone: 'warn', text: COMMAND_TEXT.linkMissing };
      await linkMeeting(ctx, { roomId: room.id, url, subject: subject.join(' '), tmid });
      return null;
    }
    default:
      return { tone: 'info', text: COMMAND_TEXT.help };
  }
}

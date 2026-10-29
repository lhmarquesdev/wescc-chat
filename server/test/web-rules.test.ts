import { describe, expect, it } from 'vitest';
import type { Message } from '@shared/index';
import type { MessageSticker } from '@shared/stickers';
import { DEFAULT_PERMISSIONS } from '../src/services/permissions';
import { listSettings } from '../src/services/settings';
import { authorName, continuesGroup, editableKind, lastOwnEditable } from '../../web/src/lib/messageRules';
import { ADMIN_MENU_PERMS, ADMIN_SECTIONS, SETTINGS_GROUP, settingsPath } from '../../web/src/pages/admin/sections';

// Regras puras do chat web que mais de uma tela usa (seta para cima, agrupamento, nome do autor, menu da
// Administração): os casos que já divergiram entre as telas depois de juntar figurinhas, chamadas e Jira/Teams.

const ME = { _id: 'u-ana', username: 'ana.souza', name: 'Ana Souza' };
const BOT = { _id: 'u-teams', username: 'msteams.bot', name: 'Microsoft Teams' };
let n = 0;
// Hora local (o agrupamento compara o dia do calendário de quem lê).
const at = (h: number, min: number, day = 15) => new Date(2026, 9, day, h, min).toISOString();
function msg(over: Partial<Message> = {}): Message {
  n++;
  return {
    _id: `m${n}`,
    rid: 'r1',
    msg: `texto ${n}`,
    u: ME,
    ts: at(10, 0),
    _updatedAt: at(10, 0),
    mentions: [],
    channels: [],
    reactions: {},
    attachments: [],
    pinned: false,
    starred: [],
    ...over,
  };
}
const sticker: MessageSticker = { fileId: 'f1', name: 'Joinha', emojis: [], width: 512, height: 512, animated: false, url: '/sticker/f1.webp', scope: 'org', stickerId: 's1' };

describe('seta para cima no compositor (lastOwnEditable)', () => {
  it('pula a figurinha própria e edita o texto anterior', () => {
    const text = msg({ msg: 'olá' });
    const stk = msg({ msg: '', sticker });
    expect(editableKind(stk)).toBe(false);
    expect(lastOwnEditable([text, stk], ME._id, true)?._id).toBe(text._id);
  });

  it('sem texto próprio antes da figurinha, não abre edição nenhuma', () => {
    expect(lastOwnEditable([msg({ u: BOT }), msg({ msg: '', sticker })], ME._id, true)).toBeUndefined();
  });

  it('pula mensagens de sistema e de outras pessoas, e respeita Message_AllowEditing', () => {
    const text = msg();
    const list = [text, msg({ t: 'rm' }), msg({ t: 'uj' }), msg({ u: BOT, alias: 'Bruno Lima (Teams)' })];
    expect(lastOwnEditable(list, ME._id, true)?._id).toBe(text._id);
    expect(lastOwnEditable(list, ME._id, false)).toBeUndefined();
  });
});

describe('agrupamento de mensagens seguidas (continuesGroup)', () => {
  const ana = (h: number, min: number, extra: Partial<Message> = {}) => msg({ u: BOT, alias: 'Ana Souza (Teams)', ts: at(h, min), ...extra });
  const bruno = (h: number, min: number) => msg({ u: BOT, alias: 'Bruno Lima (Teams)', ts: at(h, min) });

  it('respostas do Teams de pessoas diferentes (mesmo robô, alias diferente) não se agrupam', () => {
    const replies = [ana(10, 0), bruno(10, 1), ana(10, 2)];
    expect(continuesGroup(replies[0], replies[1], 300_000)).toBe(false);
    expect(continuesGroup(replies[1], replies[2], 300_000)).toBe(false);
  });

  it('a mesma pessoa do Teams dentro do intervalo se agrupa; fora dele, não', () => {
    expect(continuesGroup(ana(10, 0), ana(10, 4), 300_000)).toBe(true);
    expect(continuesGroup(ana(10, 0), ana(10, 6), 300_000)).toBe(false);
  });

  it('alias ausente, nulo ou vazio contam como o mesmo (mensagem comum)', () => {
    const a = msg({ ts: at(10, 0) });
    const b = msg({ ts: at(10, 1), alias: null as unknown as string });
    const c = msg({ ts: at(10, 2), alias: '' });
    expect(continuesGroup(a, b, 300_000)).toBe(true);
    expect(continuesGroup(b, c, 300_000)).toBe(true);
  });

  it('mensagem de sistema e virada do dia quebram o grupo', () => {
    expect(continuesGroup(msg({ ts: at(10, 0), t: 'rm' }), msg({ ts: at(10, 1) }), 300_000)).toBe(false);
    expect(continuesGroup(msg({ ts: at(10, 0) }), msg({ ts: at(10, 1), t: 'message_pinned' }), 300_000)).toBe(false);
    expect(continuesGroup(msg({ ts: at(23, 58, 15) }), msg({ ts: at(0, 1, 16) }), 300_000)).toBe(false);
  });
});

describe('nome do autor nos painéis (authorName)', () => {
  it('a cópia do Teams mostra a pessoa do alias, não o robô', () => {
    expect(authorName(msg({ u: BOT, alias: 'Ana Souza (Teams)' }))).toBe('Ana Souza (Teams)');
    expect(authorName(msg())).toBe('Ana Souza');
    expect(authorName(msg({ u: { _id: 'u2', username: 'bruno.lima' } }))).toBe('bruno.lima');
  });
});

describe('item "Administração" do menu do usuário', () => {
  const known = new Set(DEFAULT_PERMISSIONS.map(([id]) => id));

  it('quem abre qualquer seção vê o item (chamadas, Jira, Teams e figurinhas inclusive)', () => {
    for (const s of ADMIN_SECTIONS) for (const p of s.perm) expect(ADMIN_MENU_PERMS, `${s.id}: ${p}`).toContain(p);
    for (const p of ['manage-calls', 'manage-jira', 'manage-msteams', 'manage-integrations', 'manage-own-integrations', 'manage-sticker-packs']) expect(ADMIN_MENU_PERMS).toContain(p);
  });

  it('um papel só com manage-calls ou só com manage-jira + manage-msteams cai na seção certa', () => {
    const first = (perms: string[]) => ADMIN_SECTIONS.find((s) => s.perm.some((p) => perms.includes(p)))?.id;
    expect(ADMIN_MENU_PERMS.some((p) => p === 'manage-calls')).toBe(true);
    expect(first(['manage-calls'])).toBe('calls');
    expect(first(['manage-jira', 'manage-msteams'])).toBe('integrations');
  });

  it('cada permissão das seções existe no servidor (um id errado esconderia a seção de todo mundo)', () => {
    const unknown = ADMIN_MENU_PERMS.filter((p) => !known.has(p));
    expect(unknown).toEqual([]);
  });
});

describe('botões "Configurações" das seções', () => {
  const groupOf = (prefix: string) => [...new Set(listSettings().filter((s) => s._id.startsWith(prefix)).map((s) => s.group))];

  it('Figurinhas abre o grupo onde ficam todas as configurações de figurinha', () => {
    expect(groupOf('Stickers_')).toEqual([SETTINGS_GROUP.stickers]);
    expect(settingsPath(SETTINGS_GROUP.stickers)).toBe('/admin/settings?group=Message');
  });

  it('Chamadas abre o grupo das chamadas', () => {
    expect(groupOf('Calls_')).toEqual([SETTINGS_GROUP.calls]);
  });
});

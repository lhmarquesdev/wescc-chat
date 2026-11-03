import { describe, expect, it } from 'vitest';
import type { Message } from '@shared/index';
import type { MessageSticker } from '@shared/stickers';
import { csvCell, exportFileName, exportSlug, nextDataRequestAt, safeZipName } from '@shared/dataExport';
import { EMOJI, emojiText } from '@shared/emoji';
import { roleDisplayName, systemText as sharedSystemText } from '@shared/messageText';
import { DEFAULT_PERMISSIONS } from '../src/services/permissions';
import { listSettings } from '../src/services/settings';
import { EMOJI as WEB_EMOJI } from '../../web/src/lib/emoji';
import { systemText as webSystemText } from '../../web/src/lib/format';
import { authorName, continuesGroup, editableKind, lastOwnEditable } from '../../web/src/lib/messageRules';
import { ADMIN_MENU_PERMS, ADMIN_SECTIONS, SETTINGS_GROUP, settingsPath } from '../../web/src/pages/admin/sections';

// Regras puras do chat web que mais de uma tela usa (seta para cima, agrupamento, nome do autor, menu da
// Administração): os casos que já divergiram entre as telas depois de juntar figurinhas, chamadas e Jira.

const ME = { _id: 'u-ana', username: 'ana.souza', name: 'Ana Souza' };
const BOT = { _id: 'u-hook', username: 'webhook.bot', name: 'Webhook' };
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
    const list = [text, msg({ t: 'rm' }), msg({ t: 'uj' }), msg({ u: BOT, alias: 'Bruno Lima (Webhook)' })];
    expect(lastOwnEditable(list, ME._id, true)?._id).toBe(text._id);
    expect(lastOwnEditable(list, ME._id, false)).toBeUndefined();
  });
});

describe('agrupamento de mensagens seguidas (continuesGroup)', () => {
  const ana = (h: number, min: number, extra: Partial<Message> = {}) => msg({ u: BOT, alias: 'Ana Souza (Webhook)', ts: at(h, min), ...extra });
  const bruno = (h: number, min: number) => msg({ u: BOT, alias: 'Bruno Lima (Webhook)', ts: at(h, min) });

  it('mensagens de webhook com apelidos diferentes (mesmo robô, alias diferente) não se agrupam', () => {
    const replies = [ana(10, 0), bruno(10, 1), ana(10, 2)];
    expect(continuesGroup(replies[0], replies[1], 300_000)).toBe(false);
    expect(continuesGroup(replies[1], replies[2], 300_000)).toBe(false);
  });

  it('o mesmo apelido dentro do intervalo se agrupa; fora dele, não', () => {
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
  it('a mensagem com apelido mostra o alias, não o robô', () => {
    expect(authorName(msg({ u: BOT, alias: 'Ana Souza (Webhook)' }))).toBe('Ana Souza (Webhook)');
    expect(authorName(msg())).toBe('Ana Souza');
    expect(authorName(msg({ u: { _id: 'u2', username: 'bruno.lima' } }))).toBe('bruno.lima');
  });
});

describe('item "Administração" do menu do usuário', () => {
  const known = new Set(DEFAULT_PERMISSIONS.map(([id]) => id));

  it('quem abre qualquer seção vê o item (chamadas, Jira e figurinhas inclusive)', () => {
    for (const s of ADMIN_SECTIONS) for (const p of s.perm) expect(ADMIN_MENU_PERMS, `${s.id}: ${p}`).toContain(p);
    for (const p of ['manage-calls', 'manage-jira', 'manage-integrations', 'manage-own-integrations', 'manage-sticker-packs']) expect(ADMIN_MENU_PERMS).toContain(p);
  });

  it('um papel só com manage-calls ou só com manage-jira cai na seção certa', () => {
    const first = (perms: string[]) => ADMIN_SECTIONS.find((s) => s.perm.some((p) => perms.includes(p)))?.id;
    expect(ADMIN_MENU_PERMS.some((p) => p === 'manage-calls')).toBe(true);
    expect(first(['manage-calls'])).toBe('calls');
    expect(first(['manage-jira'])).toBe('integrations');
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

describe('ícones dos grupos do RBAC (tela Papéis e permissões)', () => {
  it('todo grupo do catálogo tem ícone próprio: grupo sem ícone derrubava a tela inteira', async () => {
    const { RBAC_GROUPS } = await import('@shared/rbac');
    const { GROUP_ICON, groupIcon } = await import('../../web/src/pages/admin/rbac/groupIcons');
    expect(RBAC_GROUPS.map((g) => g.id).filter((id) => !GROUP_ICON[id])).toEqual([]);
    expect(groupIcon('grupo-que-nao-existe')).toBe('rbac-admin');
  });
});

describe('texto das mensagens de sistema (web e exportações)', () => {
  it('systemText da web é o do shared', () => {
    const names: Record<string, string> = { 'bruno.lima': 'Bruno Lima' };
    const nameOf = (u: string) => names[u] ?? u;
    const cases: Record<string, any>[] = [
      { t: 'uj', msg: 'ana.souza' },
      { t: 'au', msg: 'bruno.lima' },
      { t: 'subscription-role-added', msg: 'bruno.lima', role: 'owner' },
      { t: 'call_ended', msg: '', call: { kind: 'video', duration: 754 } },
      { t: 'room-set-notice', msg: '' },
      { t: 'room_changed_topic', msg: 'Planejamento' },
    ];
    const out = cases.map((c) => {
      const m = msg(c as Partial<Message>);
      const web = webSystemText(m, nameOf);
      expect(web).toBe(sharedSystemText(m, nameOf));
      return web;
    });
    expect(out).toEqual([
      'Ana Souza entrou na sala',
      'Ana Souza adicionou Bruno Lima',
      'Ana Souza deu o papel Dono a Bruno Lima',
      'Chamada de vídeo · 12 min 34 s',
      'Ana Souza transformou a sala em canal de avisos',
      'Ana Souza alterou o tópico para: Planejamento',
    ]);
  });
});

describe('regras das exportações', () => {
  const H = 3600_000;
  const now = Date.parse('2026-11-03T15:00:00Z');
  const ago = (h: number) => new Date(now - h * H).toISOString();
  const after = (h: number) => new Date(now + h * H).toISOString();

  it('nextDataRequestAt: um pedido a cada 24 horas, o que falhou não conta', () => {
    expect(nextDataRequestAt([], now)).toBeNull();
    expect(nextDataRequestAt([{ status: 'ready', requestedAt: ago(2) }], now)).toBe(after(22));
    expect(nextDataRequestAt([{ status: 'failed', requestedAt: ago(2) }], now)).toBeNull();
    expect(nextDataRequestAt([{ status: 'ready', requestedAt: ago(25) }], now)).toBeNull();
    expect(nextDataRequestAt([{ status: 'pending', requestedAt: ago(1) }], now)).toBe(after(23));
    // O mais novo que não falhou é o que manda.
    expect(nextDataRequestAt([{ status: 'failed', requestedAt: ago(1) }, { status: 'expired', requestedAt: ago(5) }], now)).toBe(after(19));
  });

  it('nomes de arquivo', () => {
    expect(exportSlug('Projeto X — Ação #1', 'conversa')).toBe('projeto-x-acao-1');
    expect(exportSlug('🙂', 'conversa')).toBe('conversa');
    expect(exportFileName('Conversa com Bruno Lima', '2026-10-01', '2026-10-31', 'html')).toBe('conversa-com-bruno-lima_2026-10-01_a_2026-10-31.html');
    expect(safeZipName('abc', '../../etc/pass:wd')).toBe('abc-etcpasswd');
    expect(safeZipName('abc', 'foto ação.png')).toBe('abc-foto ação.png');
    expect(safeZipName('abc', '.oculto')).toBe('abc-oculto');
    expect(safeZipName('abc', '...')).toBe('abc-arquivo');
    const long = safeZipName('abc', `${'x'.repeat(300)}.pdf`);
    expect(long).toMatch(/^abc-x+\.pdf$/);
    expect(long).toHaveLength(4 + 120);
  });

  it('reações como no chat: emoji pelo shortcode, personalizado como :nome:', () => {
    expect(emojiText(':thumbsup:')).toBe('👍');
    expect(emojiText('+1')).toBe('👍');
    expect(emojiText(':100:')).toBe('💯');
    expect(emojiText(':logo_wescc:')).toBe(':logo_wescc:');
    expect(emojiText(':constructor:')).toBe(':constructor:');
    // A web usa o mesmo mapa.
    expect(WEB_EMOJI).toBe(EMOJI);
  });

  it('nome dos papéis: ROLE_LABEL, a descrição curta do papel criado, ou o id com maiúscula', () => {
    expect(roleDisplayName('user')).toBe('Usuário');
    expect(roleDisplayName('operacao', 'Operação')).toBe('Operação');
    expect(roleDisplayName('supervisor', 'Supervisiona a operação de campo e os turnos da noite.')).toBe('Supervisor');
    expect(roleDisplayName('suporte')).toBe('Suporte');
  });

  it('células do CSV', () => {
    expect(csvCell('=SOMA(A1)')).toBe(`'=SOMA(A1)`);
    expect(csvCell('+5')).toBe(`'+5`);
    expect(csvCell('-2')).toBe(`'-2`);
    expect(csvCell('@user')).toBe(`'@user`);
    expect(csvCell('a;b')).toBe(`"a;b"`);
    expect(csvCell('diz "oi"')).toBe(`"diz ""oi"""`);
    expect(csvCell('linha 1\nlinha 2')).toBe(`"linha 1\nlinha 2"`);
    expect(csvCell('normal')).toBe('normal');
    expect(csvCell(null)).toBe('');
    expect(csvCell(12)).toBe('12');
  });
});

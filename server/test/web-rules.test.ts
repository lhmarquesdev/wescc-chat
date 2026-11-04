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
import { authorName, continuesGroup, editableKind, forwardableKind, forwardOrigin, lastOwnEditable, messageLink, pollMeta, pollShares } from '../../web/src/lib/messageRules';
import { fromLocalInput, reminderPresets, schedulePresets, toLocalInput, whenText } from '../../web/src/lib/messageTimes';
import { AHEAD_ERROR, aheadError, POLL_ERRORS, pollInputError, type MessageForward, type MessagePoll } from '@shared/messages';
import { messagePreviewText } from '@shared/stickers';
import { ENCRYPTED_PLACEHOLDER } from '@shared/dataExport';
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

describe('matriz de permissões (web/src/pages/admin/rbac/matrix.ts)', () => {
  const role = (id: string, extra: Record<string, unknown> = {}) => ({ _id: id, scope: 'Users' as const, users: 0, protected: true, ...extra });

  it('colunas padrão: Administrador, personalizados, do sistema globais com gente e os de sala principais, até 8', async () => {
    const { defaultColumns } = await import('../../web/src/pages/admin/rbac/matrix');
    const roles = [
      role('user', { users: 10 }),
      role('guest'),
      role('admin', { root: true, users: 1 }),
      role('supervisor', { protected: false }),
      role('owner', { scope: 'Subscriptions' }),
      role('moderator', { scope: 'Subscriptions' }),
      role('publisher', { scope: 'Subscriptions' }),
      role('leader', { scope: 'Subscriptions' }),
    ];
    expect(defaultColumns(roles)).toEqual(['admin', 'supervisor', 'user', 'owner', 'moderator', 'publisher']);
    const many = [role('admin', { root: true }), ...Array.from({ length: 10 }, (_, i) => role(`p${i}`, { protected: false }))];
    const cols = defaultColumns(many);
    expect(cols).toHaveLength(8);
    expect(cols[0]).toBe('admin');
  });

  it('matrixChanges grava só o que entrou e saiu, e papel sem mudança fica de fora', async () => {
    const { matrixChanges } = await import('../../web/src/pages/admin/rbac/matrix');
    const initial = { a: ['x', 'y', 'legada'], b: ['x'] };
    const draft = { a: new Set(['y', 'z', 'legada']), b: new Set(['x']) };
    expect(matrixChanges(initial, draft)).toEqual([{ roleId: 'a', add: ['z'], remove: ['x'] }]);
    expect(matrixChanges(initial, { a: new Set(initial.a), b: new Set(initial.b) })).toEqual([]);
  });

  it('differs: só com dois papéis ou mais, quando uns têm e outros não', async () => {
    const { differs } = await import('../../web/src/pages/admin/rbac/matrix');
    const perms = { a: new Set(['x']), b: new Set<string>(), c: new Set(['x']) };
    expect(differs('x', ['a', 'b'], perms)).toBe(true);
    expect(differs('x', ['a', 'c'], perms)).toBe(false);
    expect(differs('x', ['a'], perms)).toBe(false);
    expect(differs('y', ['a', 'b'], perms)).toBe(false);
  });

  it('cellLock segue as travas do servidor, na ordem', async () => {
    const { cellLock } = await import('../../web/src/pages/admin/rbac/matrix');
    const { LOCK_TEXT } = await import('@shared/rbac');
    const grant = { root: false, held: ['create-c'], roleLocks: { admin: 'root-only' as const, user: null } };
    expect(cellLock('create-c', { _id: 'user' }, grant, false)).toBe('Você pode ver, mas não alterar permissões.');
    expect(cellLock('create-c', { _id: 'admin', root: true }, grant, true)).toBe(LOCK_TEXT['root-only']);
    expect(cellLock('create-p', { _id: 'user' }, grant, true)).toBe('Você não tem esta permissão, então não pode dá-la nem tirá-la.');
    expect(cellLock('create-c', { _id: 'user' }, grant, true)).toBeNull();
    const root = { root: true, held: [], roleLocks: {} };
    expect(cellLock('manage-roles', { _id: 'admin', root: true }, root, true)).toBe('O Administrador sempre gerencia papéis.');
    expect(cellLock('assign-roles', { _id: 'admin', root: true }, root, true)).toBe('O Administrador sempre gerencia papéis.');
    expect(cellLock('create-p', { _id: 'admin', root: true }, root, true)).toBeNull();
  });

  it('cellState: papel de sala em permissão que não é checada na sala não tem efeito', async () => {
    const { cellState } = await import('../../web/src/pages/admin/rbac/matrix');
    const owner = role('owner', { scope: 'Subscriptions' });
    expect(cellState('create-p', owner, new Set(['create-p']), null)).toBe('inert');
    expect(cellState('delete-message', owner, new Set(['delete-message']), null)).toBe('on');
    expect(cellState('mention-here', owner, new Set(), null)).toBe('off');
    expect(cellState('create-p', role('user'), new Set(), 'trava')).toBe('locked');
    expect(cellState('create-p', role('user'), new Set(['create-p']), null)).toBe('on');
  });

  it('estado na URL: ida e volta, só o que foge do padrão', async () => {
    const { matrixQuery, parseMatrixQuery } = await import('../../web/src/pages/admin/rbac/matrix');
    const q = { roles: ['operacao', 'supervisor-operacao'], group: 'admin', q: 'apagar mensagens', diff: true, sens: true };
    expect(parseMatrixQuery(matrixQuery(q))).toEqual(q);
    expect(matrixQuery({ roles: ['a', 'b'], group: 'all', q: '', diff: true, sens: false })).toBe('?roles=a,b&diff=1');
    expect(matrixQuery({ roles: [], group: 'all', q: '', diff: false, sens: false })).toBe('');
    expect(parseMatrixQuery('')).toEqual({ roles: [], group: 'all', q: '', diff: false, sens: false });
  });
});

describe('trava de uma pessoa na tela de Usuários (userLockOf)', () => {
  it('administrador sem trava; a própria pessoa; senão a primeira trava dos papéis dela', async () => {
    const { userLockOf } = await import('../../web/src/pages/admin/rbac/userLock');
    const grant = { root: false, userId: 'me', roleLocks: { admin: 'root-only' as const, operacao: null, auditor: 'superior' as const } };
    expect(userLockOf({ ...grant, root: true }, 'me', { _id: 'x', roles: ['admin'] })).toBeNull();
    expect(userLockOf(grant, 'me', { _id: 'me', roles: ['operacao'] })).toBe('self');
    expect(userLockOf(grant, 'me', { _id: 'x', roles: ['operacao', 'admin'] })).toBe('root-only');
    expect(userLockOf(grant, 'me', { _id: 'x', roles: ['operacao'] })).toBeNull();
    expect(userLockOf(grant, 'me', { _id: 'x', roles: ['auditor'] })).toBe('superior');
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

// ---------- Mensagens: encaminhar, enquetes, "Lembrar-me" e envio agendado ----------

describe('encaminhar e editar: tipos de mensagem', () => {
  it('editableKind recusa enquete e encaminhada', () => {
    expect(editableKind(msg())).toBe(true);
    expect(editableKind(msg({ poll: { question: 'Q', options: [], voters: 0, multiple: false, anonymous: false, closesAt: null, closedAt: null } }))).toBe(false);
    expect(editableKind(msg({ forward: { mid: 'x', rid: 'r2', t: 'c', u: ME, ts: at(9, 0), hops: 1 } }))).toBe(false);
  });
  it('forwardableKind: sem sistema, sem enquete, sem figurinha removida', () => {
    expect(forwardableKind(msg())).toBe(true);
    expect(forwardableKind(msg({ sticker }))).toBe(true);
    expect(forwardableKind(msg({ forward: { mid: 'x', rid: 'r2', t: 'c', u: ME, ts: at(9, 0), hops: 1 } }))).toBe(true);
    expect(forwardableKind(msg({ t: 'uj' }))).toBe(false);
    expect(forwardableKind(msg({ poll: { question: 'Q', options: [], voters: 0, multiple: false, anonymous: false, closesAt: null, closedAt: null } }))).toBe(false);
    expect(forwardableKind(msg({ sticker: { fileId: 'f1', removed: true } }))).toBe(false);
    // Mensagem cifrada (messages.e2e, do grupo da criptografia): nunca encaminhada.
    expect(forwardableKind({ ...msg(), e2e: { v: 1 } } as any)).toBe(false);
  });
});

describe('link de uma mensagem (messageLink)', () => {
  it('canal, grupo, DM e resposta de tópico', () => {
    expect(messageLink({ rid: 'r1', t: 'c', mid: 'm1' })).toBe('/channel/r1?msg=m1');
    expect(messageLink({ rid: 'r2', t: 'p', mid: 'm2' })).toBe('/group/r2?msg=m2');
    expect(messageLink({ rid: 'r3', t: 'd', mid: 'm3', tmid: null })).toBe('/direct/r3?msg=m3');
    expect(messageLink({ rid: 'r1', t: 'c', mid: 'm4', tmid: 'm1' })).toBe('/channel/r1/thread/m1');
  });
});

describe('origem da encaminhada (forwardOrigin)', () => {
  const f = (over: Partial<MessageForward>): MessageForward => ({ mid: 'm1', rid: 'r1', t: 'c', u: ME, ts: at(9, 0), hops: 1, ...over });
  const subs = {
    r2: { t: 'p', name: 'projeto-x' },
    r3: { t: 'd', name: 'ana.souza, bruno' },
    r4: { t: 'c', name: 'vendas', fname: 'Vendas' },
  };
  it('canal público com nome: #nome e link', () => {
    expect(forwardOrigin(f({ roomName: 'geral' }), {})).toEqual({ text: 'Encaminhada de #geral', link: '/channel/r1?msg=m1' });
  });
  it('grupo privado: o nome só para quem está nele', () => {
    expect(forwardOrigin(f({ rid: 'r2', t: 'p' }), subs)).toEqual({ text: 'Encaminhada de projeto-x', link: '/group/r2?msg=m1' });
    expect(forwardOrigin(f({ rid: 'r9', t: 'p' }), subs)).toEqual({ text: 'Encaminhada de um grupo privado', link: null });
  });
  it('DM nunca mostra quem está nela', () => {
    expect(forwardOrigin(f({ rid: 'r3', t: 'd' }), subs)).toEqual({ text: 'Encaminhada de uma conversa direta', link: '/direct/r3?msg=m1' });
    expect(forwardOrigin(f({ rid: 'r8', t: 'd' }), subs)).toEqual({ text: 'Encaminhada de uma conversa direta', link: null });
  });
  it('canal sem nome público: o da inscrição, ou "um canal"', () => {
    expect(forwardOrigin(f({ rid: 'r4' }), subs).text).toBe('Encaminhada de #Vendas');
    expect(forwardOrigin(f({ rid: 'r7' }), subs)).toEqual({ text: 'Encaminhada de um canal', link: null });
  });
  it('encaminhada de novo: "várias vezes"', () => {
    expect(forwardOrigin(f({ roomName: 'geral', hops: 2 }), {}).text).toBe('Encaminhada várias vezes de #geral');
  });
  it('resposta de tópico: o link abre o tópico', () => {
    expect(forwardOrigin(f({ roomName: 'geral', tmid: 'root' }), {}).link).toBe('/channel/r1/thread/root');
  });
});

describe('enquetes: porcentagens e linha de cima', () => {
  const poll = (votes: number[], over: Partial<MessagePoll> = {}): MessagePoll => ({
    question: 'Q',
    options: votes.map((v, i) => ({ id: `o${i + 1}`, text: `Opção ${i + 1}`, votes: v })),
    voters: votes.reduce((a, b) => a + b, 0),
    multiple: false,
    anonymous: false,
    closesAt: null,
    closedAt: null,
    ...over,
  });
  it('pollShares: maior resto, empate fica com a de cima, soma 100', () => {
    expect(pollShares(poll([1, 1, 1]))).toEqual([34, 33, 33]);
    expect(pollShares(poll([2, 1]))).toEqual([67, 33]);
    expect(pollShares(poll([0, 0, 0]))).toEqual([0, 0, 0]);
    expect(pollShares(poll([5, 0]))).toEqual([100, 0]);
    for (const v of [[3, 3, 1], [1, 2, 3, 4, 5, 6, 7], [7, 7, 7, 7, 7, 7]]) expect(pollShares(poll(v)).reduce((a, b) => a + b, 0)).toBe(100);
  });
  it('pollMeta: aberta, várias, anônima, com prazo, encerrada', () => {
    const now = new Date(2026, 10, 3, 14, 10);
    expect(pollMeta(poll([0, 0]), now)).toBe('Uma resposta');
    expect(pollMeta(poll([0, 0], { multiple: true }), now)).toBe('Várias respostas');
    expect(pollMeta(poll([0, 0], { anonymous: true }), now)).toBe('Uma resposta · Anônima');
    expect(pollMeta(poll([0, 0], { multiple: true, anonymous: true, closesAt: new Date(2026, 10, 4, 18, 0).toISOString() }), now)).toBe(
      'Várias respostas · Anônima · Encerra amanhã às 18:00',
    );
    expect(pollMeta(poll([1, 0], { closedAt: new Date(2026, 10, 3, 12, 0).toISOString() }), now)).toBe('Encerrada');
    // O prazo passou: encerrada mesmo antes do agendador gravar.
    expect(pollMeta(poll([1, 0], { closesAt: new Date(2026, 10, 3, 14, 0).toISOString() }), now)).toBe('Encerrada');
  });
});

describe('atalhos de horário (messageTimes)', () => {
  const hhmm = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const list = (ps: { label: string; at: Date }[]) => ps.map((p) => `${p.label} → ${hhmm(p.at)}`);
  it('reminderPresets numa terça às 14:10 e às 23:50', () => {
    expect(list(reminderPresets(new Date(2026, 10, 3, 14, 10)))).toEqual([
      'Em 20 minutos → 03/11 14:30',
      'Em 1 hora → 03/11 15:10',
      'Em 3 horas → 03/11 17:10',
      'Amanhã às 9h → 04/11 09:00',
    ]);
    expect(list(reminderPresets(new Date(2026, 10, 3, 23, 50)))).toEqual([
      'Em 20 minutos → 04/11 00:10',
      'Em 1 hora → 04/11 00:50',
      'Em 3 horas → 04/11 02:50',
      'Amanhã às 9h → 04/11 09:00',
    ]);
  });
  it('schedulePresets: "Hoje às 18h" só antes das 17h', () => {
    expect(list(schedulePresets(new Date(2026, 10, 3, 16, 0)))).toEqual([
      'Hoje às 18h → 03/11 18:00',
      'Amanhã às 9h → 04/11 09:00',
      'Amanhã às 14h → 04/11 14:00',
      'Segunda-feira às 9h → 09/11 09:00',
    ]);
    expect(list(schedulePresets(new Date(2026, 10, 3, 17, 30)))).toEqual(['Amanhã às 9h → 04/11 09:00', 'Amanhã às 14h → 04/11 14:00', 'Segunda-feira às 9h → 09/11 09:00']);
  });
  it('schedulePresets: no domingo a segunda é amanhã; na segunda, a da semana seguinte', () => {
    expect(list(schedulePresets(new Date(2026, 10, 8, 10, 0)))).toEqual(['Hoje às 18h → 08/11 18:00', 'Amanhã às 9h → 09/11 09:00', 'Amanhã às 14h → 09/11 14:00']);
    expect(list(schedulePresets(new Date(2026, 10, 9, 10, 0)))).toEqual([
      'Hoje às 18h → 09/11 18:00',
      'Amanhã às 9h → 10/11 09:00',
      'Amanhã às 14h → 10/11 14:00',
      'Segunda-feira às 9h → 16/11 09:00',
    ]);
  });
  it('whenText: hoje, amanhã, ontem, outro dia, outro ano', () => {
    const now = new Date(2026, 10, 3, 14, 10);
    const iso = (...a: [number, number, number, number, number]) => new Date(...a).toISOString();
    expect(whenText(iso(2026, 10, 3, 15, 20), now)).toBe('hoje às 15:20');
    expect(whenText(iso(2026, 10, 4, 9, 0), now)).toBe('amanhã às 09:00');
    expect(whenText(iso(2026, 10, 2, 18, 0), now)).toBe('ontem às 18:00');
    expect(whenText(iso(2026, 10, 5, 9, 0), now)).toBe('qui., 05/11 às 09:00');
    expect(whenText(iso(2027, 10, 5, 9, 0), now)).toBe('05/11/2027 às 09:00');
    expect(whenText('não é data', now)).toBe('');
  });
  it('datetime-local: ida e volta no fuso do aparelho', () => {
    const d = new Date(2026, 10, 3, 9, 5);
    expect(toLocalInput(d)).toBe('2026-11-03T09:05');
    expect(fromLocalInput('2026-11-03T09:05')!.getTime()).toBe(d.getTime());
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('03/11/2026')).toBeNull();
  });
});

describe('prévia das mensagens novas (messagePreviewText)', () => {
  it('enquete, encaminhada sem e com comentário, figurinha encaminhada, vídeo', () => {
    expect(messagePreviewText({ msg: 'Qual dia?', poll: { question: 'Qual dia?' } })).toBe('📊 Qual dia?');
    expect(messagePreviewText({ msg: 'o relatório saiu', forward: {} })).toBe('↪ o relatório saiu');
    expect(messagePreviewText({ msg: 'o relatório saiu', forward: { comment: 'olha isso' } })).toBe('olha isso');
    expect(messagePreviewText({ msg: '', sticker: { ...sticker, name: 'Gato', emojis: ['😺'] }, forward: {} })).toBe('↪ 😺 Figurinha “Gato”');
    expect(messagePreviewText({ msg: '', files: [{ name: 'a.pdf' }], forward: {} })).toBe('↪ 📎 a.pdf');
    expect(messagePreviewText({ msg: '', forward: {} })).toBe('↪ Mensagem encaminhada');
    expect(messagePreviewText({ msg: '', files: [{ name: 'Mensagem de vídeo.mp4', video: true, duration: 42 }] })).toBe('🎥 Mensagem de vídeo (0:42)');
    expect(messagePreviewText({ msg: '', files: [{ name: 'v.webm', video: true }] })).toBe('🎥 Mensagem de vídeo');
    expect(messagePreviewText({ msg: 'x', poll: { question: 'x' }, e2e: { v: 1 } })).toBe(ENCRYPTED_PLACEHOLDER);
  });
});

describe('validação de enquete e de horário (bordas exatas)', () => {
  const now = new Date('2026-11-03T14:10:00.000Z');
  const ms = (n: number) => new Date(now.getTime() + n).toISOString();
  const base = { question: 'Qual dia?', options: ['Segunda', 'Terça'] };
  it('pollInputError: pergunta, opções e prazo', () => {
    expect(pollInputError(base, now)).toBeNull();
    expect(pollInputError({ ...base, question: '   ' }, now)).toBe(POLL_ERRORS.question);
    expect(pollInputError({ ...base, question: 'x'.repeat(301) }, now)).toBe(POLL_ERRORS.question);
    expect(pollInputError({ ...base, options: ['Só uma', '  '] }, now)).toBe(POLL_ERRORS.count);
    expect(pollInputError({ ...base, options: Array.from({ length: 11 }, (_, i) => `o${i}`) }, now)).toBe(POLL_ERRORS.count);
    expect(pollInputError({ ...base, options: ['a', 'x'.repeat(101)] }, now)).toBe(POLL_ERRORS.optionLength);
    expect(pollInputError({ ...base, options: ['Sim', ' sim '] }, now)).toBe(POLL_ERRORS.repeated);
    expect(pollInputError({ ...base, closesAt: ms(5 * 60_000) }, now)).toBeNull();
    expect(pollInputError({ ...base, closesAt: ms(5 * 60_000 - 1) }, now)).toBe(POLL_ERRORS.deadline);
    expect(pollInputError({ ...base, closesAt: ms(90 * 86_400_000) }, now)).toBeNull();
    expect(pollInputError({ ...base, closesAt: ms(90 * 86_400_000 + 1) }, now)).toBe(POLL_ERRORS.deadline);
    expect(pollInputError({ ...base, closesAt: 'amanhã' }, now)).toBe(POLL_ERRORS.deadline);
    expect(pollInputError({ ...base, closesAt: null }, now)).toBeNull();
  });
  it('aheadError: de 1 minuto a 365 dias', () => {
    expect(aheadError(ms(60_000), now)).toBeNull();
    expect(aheadError(ms(60_000 - 1), now)).toBe(AHEAD_ERROR);
    expect(aheadError(ms(365 * 86_400_000), now)).toBeNull();
    expect(aheadError(ms(365 * 86_400_000 + 1), now)).toBe(AHEAD_ERROR);
    expect(aheadError('ontem', now)).toBe(AHEAD_ERROR);
    expect(aheadError(undefined, now)).toBe(AHEAD_ERROR);
  });
});

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
import { authorName, continuesGroup, editableKind, forwardableKind, forwardOrigin, joinsText, lastOwnEditable, mentionGroups, mentionSuggestions, messageLink, pollMeta, pollShares } from '../../web/src/lib/messageRules';
import { fromLocalInput, reminderPresets, schedulePresets, toLocalInput, whenText } from '../../web/src/lib/messageTimes';
import { AHEAD_ERROR, aheadError, POLL_ERRORS, pollInputError, type MessageForward, type MessagePoll } from '@shared/messages';
import { messagePreviewText } from '@shared/stickers';
import { ENCRYPTED_PLACEHOLDER } from '@shared/dataExport';
import { ADMIN_MENU_PERMS, ADMIN_SECTIONS, SETTINGS_GROUP, settingsPath } from '../../web/src/pages/admin/sections';
// Busca da barra lateral, status personalizados e palavras destacadas.
import type { SpotlightUser, Subscription } from '@shared/index';
import { foldText, parseSpotlightQuery, spotlightReady } from '@shared/search';
import { compileHighlights, findHighlight, normalizeHighlights, splitHighlights } from '@shared/highlights';
import { normalizeStatusName, presenceLabel, selfUserPatch, shownCustomStatus, silencesNotifications, sortStatuses, statusLine, type CustomUserStatus } from '@shared/status';
import { RBAC_AREAS, roleNameKey, roleNameProblem, screenGapWarning, screenGaps } from '@shared/rbac';
import { ROLE_LABEL } from '@shared/messageText';
import { readableError } from '../../web/src/lib/errorText';
import { deviceLabel } from '@shared/devices';
import { dedupePeople, dedupeRooms, matchesLocal, orderPeople, resultCountText, spotlightHint } from '../../web/src/lib/spotlightRules';
// Tradução de mensagens
import { capitalize, isTranslatable, languageLabel, languageOptions, translationKey } from '../../web/src/lib/translateRules';

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

describe('busca da barra lateral', () => {
  it('foldText e parseSpotlightQuery: prefixo, espaços e o corte em 64', () => {
    expect(foldText('Conceição ÁRVORE')).toBe('conceicao arvore');
    expect(parseSpotlightQuery('@ Ana ')).toEqual({ text: 'Ana', scope: 'users' });
    expect(parseSpotlightQuery('#sup')).toEqual({ text: 'sup', scope: 'rooms' });
    expect(parseSpotlightQuery('  suporte  ')).toEqual({ text: 'suporte', scope: 'all' });
    // Só um prefixo: "@#x" busca pessoas por "#x".
    expect(parseSpotlightQuery('@#x')).toEqual({ text: '#x', scope: 'users' });
    const long = 'á'.repeat(80);
    expect([...parseSpotlightQuery(long).text].length).toBe(64);
    expect(spotlightReady(parseSpotlightQuery('@a'))).toBe(false);
    expect(spotlightReady(parseSpotlightQuery('@an'))).toBe(true);
  });

  const sub = (over: Partial<Subscription>): Subscription => ({
    _id: `s-${over.rid ?? 'x'}`,
    rid: 'x',
    u: ME,
    t: 'c',
    name: 'geral',
    fname: 'geral',
    roles: [],
    open: true,
    alert: false,
    unread: 0,
    userMentions: 0,
    groupMentions: 0,
    tunread: [],
    f: false,
    ls: null,
    ts: at(9, 0),
    notifications: {} as Subscription['notifications'],
    _updatedAt: at(9, 0),
    ...over,
  });
  const person = (username: string, name = username): SpotlightUser => ({ _id: `u-${username}`, username, name, status: 'online', roles: ['user'] });

  it('matchesLocal: conversa oculta, DM pelo usuário, escopo de @ e #', () => {
    const hidden = sub({ rid: 'r-sup', name: 'suporte-ti', fname: 'Suporte TI', open: false });
    const dm = sub({ rid: 'r-dm', t: 'd', name: 'joao.conceicao', fname: 'João Conceição' });
    expect(matchesLocal(hidden, parseSpotlightQuery('suporte'))).toBe(true);
    expect(matchesLocal(hidden, parseSpotlightQuery('#sup'))).toBe(true);
    expect(matchesLocal(hidden, parseSpotlightQuery('@sup'))).toBe(false);
    expect(matchesLocal(dm, parseSpotlightQuery('conceicao'))).toBe(true);
    expect(matchesLocal(dm, parseSpotlightQuery('joao.con'))).toBe(true);
    expect(matchesLocal(dm, parseSpotlightQuery('#joao'))).toBe(false);
    // Só o prefixo: tudo do escopo.
    expect(matchesLocal(dm, parseSpotlightQuery('@'))).toBe(true);
    expect(matchesLocal(hidden, parseSpotlightQuery('@'))).toBe(false);
  });

  it('dedupePeople, dedupeRooms e orderPeople (estável)', () => {
    const subs = [sub({ rid: 'r1', t: 'd', name: 'Bia.Lima' }), sub({ rid: 'r2', t: 'd', name: 'ana,bia', fname: 'Ana e Bia' })];
    const out = dedupePeople([person('bia.lima'), person('ana'), person('carla')], subs);
    // A DM em grupo (ana,bia) não esconde a Ana.
    expect(out.map((u) => u.username)).toEqual(['ana', 'carla']);
    const rooms = [
      { _id: 'r-a', name: 'a' },
      { _id: 'r-b', name: 'b' },
    ] as never[];
    expect(dedupeRooms(rooms, { 'r-a': sub({ rid: 'r-a' }) }).map((r: { _id: string }) => r._id)).toEqual(['r-b']);
    const order = orderPeople(['a1', 'b1', 'a2', 'b2', 'a3'], (x) => x.startsWith('b'));
    expect(order).toEqual(['a1', 'a2', 'a3', 'b1', 'b2']);
    expect(resultCountText(0)).toBe('Nenhum resultado');
    expect(resultCountText(1)).toBe('1 resultado');
    expect(resultCountText(7)).toBe('7 resultados');
  });

  // Revisão: "a" ou "@" sozinhos diziam "Nada encontrado… Confira a grafia" sem o servidor ter sido perguntado.
  it('spotlightHint: o que falta para a busca ir ao servidor', () => {
    expect(spotlightHint(parseSpotlightQuery('a'))).toBe('Digite pelo menos 2 letras para buscar pessoas e canais.');
    expect(spotlightHint(parseSpotlightQuery('@'))).toBe('Digite um nome depois do @ para buscar pessoas.');
    expect(spotlightHint(parseSpotlightQuery('# '))).toBe('Digite um nome depois do # para buscar canais e times.');
    expect(spotlightHint(parseSpotlightQuery('@a'))).toBe('Digite pelo menos 2 letras para buscar pessoas.');
  });
});

describe('palavras destacadas', () => {
  it('normalizeHighlights: limpa, deduplica sem acento e recusa o que não serve', () => {
    expect(normalizeHighlights(['  Plantão ', 'plantao', 'servidor   fora', ''])).toEqual({ ok: true, words: ['Plantão', 'servidor fora'] });
    expect(normalizeHighlights('plantão')).toMatchObject({ ok: false, error: 'Palavras destacadas: envie uma lista de textos.' });
    expect(normalizeHighlights([1])).toMatchObject({ ok: false });
    expect(normalizeHighlights(['a'])).toMatchObject({ ok: false, error: '“a”: cada palavra destacada precisa ter de 2 a 40 caracteres.' });
    expect(normalizeHighlights(['!!!'])).toMatchObject({ ok: false, error: '“!!!”: use letras ou números.' });
    expect(normalizeHighlights(Array.from({ length: 21 }, (_, i) => `palavra${i}`))).toMatchObject({ ok: false, error: 'Use no máximo 20 palavras destacadas.' });
    expect(normalizeHighlights([])).toEqual({ ok: true, words: [] });
  });

  it('acentos e maiúsculas não importam; a palavra precisa estar inteira', () => {
    const m = compileHighlights(['plantão', 'Servidor fora']);
    expect(findHighlight('Quem está de PLANTAO hoje?', m)).toBe('plantão');
    expect(findHighlight('o plantão começou', m)).toBe('plantão');
    // Sem acento e com o acento separado (NFD) também casa.
    expect(findHighlight('plantao ok', m)).toBe('plantão');
    expect(findHighlight('plantão agora', m)).toBe('plantão');
    expect(findHighlight('o servidor   FORA do ar', m)).toBe('Servidor fora');
    // Limites de palavra (letras acentuadas, números e _ contam como parte da palavra).
    expect(findHighlight('plantões', m)).toBeNull();
    expect(findHighlight('replantão', m)).toBeNull();
    expect(findHighlight('plantão2', m)).toBeNull();
    expect(findHighlight('_plantão', m)).toBeNull();
    expect(findHighlight('(plantão)', m)).toBe('plantão');
    expect(findHighlight('plantão!', m)).toBe('plantão');
    expect(findHighlight('', m)).toBeNull();
    expect(findHighlight('plantão', null)).toBeNull();
    expect(compileHighlights([])).toBeNull();
  });

  it('caracteres especiais compilam e casam como texto', () => {
    const m = compileHighlights(['c++', 'n-2', '(urgente)', 'a.b']);
    expect(m).not.toBeNull();
    expect(findHighlight('vaga de C++ aberta', m)).toBe('c++');
    expect(findHighlight('nível n-2 hoje', m)).toBe('n-2');
    expect(findHighlight('chamado (URGENTE) aberto', m)).toBe('(urgente)');
    expect(findHighlight('veja a.b', m)).toBe('a.b');
    // O ponto não vira "qualquer letra".
    expect(findHighlight('veja axb', m)).toBeNull();
  });

  it('splitHighlights devolve o texto original e marca os trechos (a expressão mais longa ganha)', () => {
    const m = compileHighlights(['servidor', 'servidor fora']);
    const text = 'O Servidor fora do ar; o servidor voltou. Servidores ok.';
    const parts = splitHighlights(text, m);
    expect(parts.map((p) => p.text).join('')).toBe(text);
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['Servidor fora', 'servidor']);
    expect(splitHighlights('nada aqui', m)).toEqual([{ text: 'nada aqui', hit: false }]);
    expect(splitHighlights('', m)).toEqual([]);
    expect(splitHighlights('sem lista', null)).toEqual([{ text: 'sem lista', hit: false }]);
  });

  // Revisão: marcas fora dos acentos latinos (U+20D7) ficavam no padrão logo depois de um \p{M}*, e a flag i fazia o
  // "ι" grego casar com a marca U+0345: uma fila de marcas numa mensagem travava o servidor por segundos (ReDoS).
  it('palavra com sinais combinantes: não passa na validação e não trava a busca', () => {
    const arrows = 'a' + '⃗'.repeat(16);
    expect(normalizeHighlights([arrows])).toMatchObject({ ok: false, error: expect.stringContaining('pelo menos 2 letras ou números') });
    expect(normalizeHighlights(['ͅͅ'])).toMatchObject({ ok: false });
    expect(foldText('a⃗bͅİ')).toBe('abi');
    const marks = (m: string) => m.repeat(3000);
    const cases: [string, string][] = [
      // Já gravadas antes da correção: compilam sem as marcas e continuam rápidas.
      [arrows, 'a' + marks('⃗') + 'b'],
      ['a' + '⃗'.repeat(30) + 'b', 'a' + marks('⃗') + 'b'],
      ['ι'.repeat(40), 'ι' + marks('ͅ') + 'x'],
      ['ι'.repeat(40), 'ι'.repeat(3000) + 'x'],
      ['a a a a a a a a a a a a a', ('a' + '́'.repeat(40) + ' ').repeat(80) + 'b'],
    ];
    for (const [word, text] of cases) {
      const m = compileHighlights([word]);
      const t0 = performance.now();
      findHighlight(text, m);
      splitHighlights(text, m);
      expect(performance.now() - t0, word.slice(0, 4)).toBeLessThan(250);
    }
    // As marcas do texto continuam valendo como acento: "ab" com sinais em cima ainda é "ab".
    expect(findHighlight('veja a⃗⃗b agora', compileHighlights(['ab']))).toBe('ab');
    expect(findHighlight('PLANTÃO hoje', compileHighlights(['plantão']))).toBe('plantão');
    expect(findHighlight('ΙΙ ok', compileHighlights(['ιι']))).toBe('ιι');
  });
});

describe('status personalizados', () => {
  const list: CustomUserStatus[] = [
    { _id: 'st-reuniao', name: 'Em reunião', statusType: 'busy' },
    { _id: 'st-almoco', name: 'Almoço', statusType: 'away' },
  ];

  it('presenceLabel: o nome só enquanto o status real é o tipo dele', () => {
    expect(presenceLabel({ status: 'busy', statusCustom: 'st-reuniao' }, list)).toBe('Em reunião');
    // Ficou offline (fechou o chat) ou ausente automático: volta ao rótulo de base.
    expect(presenceLabel({ status: 'offline', statusCustom: 'st-reuniao' }, list)).toBe('Offline');
    expect(presenceLabel({ status: 'away', statusCustom: 'st-reuniao' }, list)).toBe('Ausente');
    expect(presenceLabel({ status: 'busy', statusCustom: 'st-sumiu' }, list)).toBe('Ocupado');
    expect(presenceLabel({ status: 'online' }, list)).toBe('Disponível');
  });

  it('normalizeStatusName: espaços, tamanho e nomes reservados sem acento', () => {
    expect(normalizeStatusName('  Em   pausa ')).toEqual({ ok: true, name: 'Em pausa' });
    expect(normalizeStatusName('ocupádo')).toMatchObject({ ok: false, code: 'error-status-name-reserved', error: 'Esse nome já é de um status padrão.' });
    expect(normalizeStatusName('INVISIVEL')).toMatchObject({ ok: false, code: 'error-status-name-reserved' });
    expect(normalizeStatusName('   ')).toMatchObject({ ok: false, code: 'error-invalid-name' });
    expect(normalizeStatusName('x'.repeat(41))).toMatchObject({ ok: false, code: 'error-invalid-name' });
    expect(normalizeStatusName('x'.repeat(40))).toMatchObject({ ok: true });
  });

  it('silencesNotifications vale para o escolhido ocupado; a lista ordena por tipo e nome', () => {
    expect(silencesNotifications('busy')).toBe(true);
    expect(silencesNotifications('away')).toBe(false);
    expect(silencesNotifications(undefined)).toBe(false);
    const sorted = sortStatuses([...list, { _id: 'st-pausa', name: 'Em pausa', statusType: 'away' }]);
    expect(sorted.map((s) => s.name)).toEqual(['Almoço', 'Em pausa', 'Em reunião']);
    // Validação final: números em ordem de número ("Status 2" antes de "Status 10").
    const numbered = sortStatuses(['Status 10', 'Status 2', 'Status 1', 'Status 11'].map((name, i) => ({ _id: `n${i}`, name, statusType: 'away' as const })));
    expect(numbered.map((s) => s.name)).toEqual(['Status 1', 'Status 2', 'Status 10', 'Status 11']);
  });

  // Revisão: em Membros, a mensagem de status escondia o personalizado ("Em atendimento" virava só "até as 15h").
  it('statusLine: com mensagem, o personalizado continua à vista; o de base dá lugar à mensagem', () => {
    expect(shownCustomStatus({ status: 'busy', statusCustom: 'st-reuniao' }, list)?.name).toBe('Em reunião');
    expect(shownCustomStatus({ status: 'away', statusCustom: 'st-reuniao' }, list)).toBeUndefined();
    expect(statusLine('Em reunião', true, 'até as 15h')).toBe('Em reunião · até as 15h');
    expect(statusLine('Ocupado', false, 'até as 15h')).toBe('até as 15h');
    expect(statusLine('Em reunião', true, '')).toBe('Em reunião');
  });

  // Revisão: editar o perfil manda a todos um "user" com statusCustom null (a pessoa invisível não se revela); a própria
  // aba juntava esse null ao me e perdia o personalizado escolhido até recarregar.
  it('selfUserPatch: o evento para todos não apaga o personalizado da própria aba', () => {
    const me = { _id: 'u1', name: 'Bruno', bio: '', status: 'offline', statusDefault: 'offline', statusCustom: 'st-fora' };
    const broadcast = { _id: 'u1', name: 'Bruno', bio: 'nova bio', status: 'offline', statusCustom: null };
    expect({ ...me, ...selfUserPatch(broadcast) }).toMatchObject({ bio: 'nova bio', statusCustom: 'st-fora', statusDefault: 'offline' });
    // O evento da própria escolha (com statusDefault) troca, inclusive para nenhum.
    expect({ ...me, ...selfUserPatch({ _id: 'u1', statusDefault: 'busy', statusCustom: null }) }).toMatchObject({ statusDefault: 'busy', statusCustom: null });
    expect({ ...me, ...selfUserPatch({ _id: 'u1', statusDefault: 'busy', statusCustom: 'st-reuniao' }) }.statusCustom).toBe('st-reuniao');
  });

  it('a seção da Administração existe e toda área do RBAC aponta para uma seção que existe', () => {
    expect(ADMIN_SECTIONS.find((s) => s.id === 'user-status')?.perm).toEqual(['manage-user-status']);
    expect(ADMIN_MENU_PERMS).toContain('manage-user-status');
    const ids = new Set(ADMIN_SECTIONS.map((s) => s.id));
    for (const a of RBAC_AREAS) if (a.adminSection) expect(ids.has(a.adminSection), a.id).toBe(true);
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

describe('tradução de mensagens (regras da web)', () => {
  const OTHER = { _id: 'u-bia', username: 'bia', name: 'Bia' };
  it('isTranslatable: texto de outra pessoa; nunca o próprio, sistema, figurinha, enquete, encaminhada, cifrada ou vazio', () => {
    expect(isTranslatable(msg({ u: OTHER, msg: 'Hello team' }), ME._id)).toBe(true);
    expect(isTranslatable(msg({ u: ME, msg: 'Hello team' }), ME._id)).toBe(false);
    expect(isTranslatable(msg({ u: OTHER, t: 'uj' }), ME._id)).toBe(false);
    expect(isTranslatable(msg({ u: OTHER, t: 'rm', msg: '' }), ME._id)).toBe(false);
    expect(isTranslatable(msg({ u: OTHER, msg: '   ' }), ME._id)).toBe(false);
    expect(isTranslatable(msg({ u: OTHER, sticker: { fileId: 'f1' } as unknown as MessageSticker }), ME._id)).toBe(false);
    expect(isTranslatable(msg({ u: OTHER, poll: { question: 'Qual?' } as unknown as MessagePoll }), ME._id)).toBe(false);
    expect(isTranslatable(msg({ u: OTHER, forward: { rid: 'r2' } as unknown as MessageForward }), ME._id)).toBe(false);
    // Mensagem cifrada (E2E: msg vazia e e2e preenchido) e sala criptografada: nunca.
    expect(isTranslatable({ ...msg({ u: OTHER, msg: 'texto' }), e2e: { v: 1 } } as Message, ME._id)).toBe(false);
    expect(isTranslatable(msg({ u: OTHER, msg: 'Hello' }), ME._id, { encrypted: true })).toBe(false);
    expect(isTranslatable(msg({ u: OTHER, msg: 'Hello' }), ME._id, { encrypted: false })).toBe(true);
    // Autor excluído (u._id nulo): continua traduzível.
    expect(isTranslatable(msg({ u: { _id: null as unknown as string, username: 'removido' }, msg: 'Hello' }), ME._id)).toBe(true);
    // Revisão: sem texto para o tradutor (só emoji, menção, link ou código), sem "Traduzir".
    for (const text of [':smile: :tada:', '👍👍', '@ana @bruno', 'https://x.example/a', '`npm test`', 'ok']) {
      expect(isTranslatable(msg({ u: OTHER, msg: text }), ME._id), text).toBe(false);
    }
    expect(isTranslatable(msg({ u: OTHER, msg: ':smile: Good morning, team' }), ME._id)).toBe(true);
  });
  it('translationKey muda com a edição e com o idioma', () => {
    const m = msg({ _id: 'x1' });
    expect(translationKey(m, 'en')).toBe('x1|en|');
    expect(translationKey({ ...m, editedAt: '2026-11-04T10:00:00.000Z' }, 'en')).toBe('x1|en|2026-11-04T10:00:00.000Z');
    expect(translationKey(m, 'pt-BR')).not.toBe(translationKey(m, 'en'));
  });
  it('languageLabel: nome em português, códigos antigos do LibreTranslate e o nome do servidor como reserva', () => {
    expect(languageLabel('en')).toBe('inglês');
    expect(languageLabel('pt-BR')).toBe('português (Brasil)');
    expect(languageLabel('pt-br')).toBe('português (Brasil)');
    expect(languageLabel('pb')).toBe('português (Brasil)');
    expect(languageLabel('es')).toBe('espanhol');
    expect(languageLabel('xx', 'Xx')).toBe('Xx');
    expect(languageLabel('xx')).toBe('xx');
    expect(languageLabel('not a code!', 'Nome')).toBe('Nome');
  });
  it('capitalize e languageOptions (ordem do nome em português, sem repetir pb e pt-BR)', () => {
    expect(capitalize('inglês')).toBe('Inglês');
    expect(capitalize('')).toBe('');
    const opts = languageOptions([
      { language: 'en', name: 'English' },
      { language: 'pb', name: 'Portuguese (Brazil)' },
      { language: 'pt-BR', name: 'Portuguese (Brazil)' },
      { language: 'de', name: 'German' },
      { language: 'es', name: 'Spanish' },
    ]);
    expect(opts).toEqual([
      { value: 'de', label: 'Alemão' },
      { value: 'es', label: 'Espanhol' },
      { value: 'en', label: 'Inglês' },
      { value: 'pt-BR', label: 'Português (Brasil)' },
    ]);
  });
});

describe('nome de papel (Novo papel e o editor, iguais ao servidor)', () => {
  const roles = [
    { id: 'admin', description: 'Administrador' },
    { id: 'user', description: 'Usuário' },
    { id: 'operacao', description: 'Operação' },
    { id: 'supervisor', description: '' },
  ];
  const check = (id: string, d: string, isNew = true) => roleNameProblem(id, d, roles, ROLE_LABEL, { isNew, displayName: roleDisplayName })?.code ?? null;
  it('o identificador não imita outro e começa e termina com letra ou número', () => {
    expect(roleNameKey('Admin. ')).toBe('admin');
    expect(check('admin ', 'X')).toBe('error-invalid-role-name');
    expect(check('admin.', 'X')).toBe('error-invalid-role-name');
    expect(check('Ad-min', 'X')).toBe('RBAC_RESERVED_ROLE_NAME');
    expect(check('administrador', 'X')).toBe('RBAC_RESERVED_ROLE_NAME');
    expect(check('Super visor', 'X')).toBe('error-duplicate-role-names-not-allowed');
    expect(check('chefe-turno', 'Chefe de turno')).toBeNull();
  });
  it('o nome exibido não repete o de um papel padrão nem o de outro papel (sem maiúsculas e acentos)', () => {
    expect(check('falso', 'Administrador')).toBe('RBAC_DUPLICATE_ROLE_LABEL');
    expect(check('falso', 'ADMIN')).toBe('RBAC_DUPLICATE_ROLE_LABEL');
    expect(check('falso', 'usuario')).toBe('RBAC_DUPLICATE_ROLE_LABEL');
    expect(check('falso', 'Operacao')).toBe('RBAC_DUPLICATE_ROLE_LABEL');
    expect(check('falso', 'Supervisor')).toBe('RBAC_DUPLICATE_ROLE_LABEL');
    // Sem nome exibido, vale o identificador (Falso), que é livre.
    expect(check('falso', '')).toBeNull();
    // Editar: o próprio nome não conta; o identificador já existente não é conferido de novo.
    expect(check('operacao', 'Operação', false)).toBeNull();
    expect(check('operacao', 'Auditor', false)).toBe('RBAC_DUPLICATE_ROLE_LABEL');
    expect(check('admin', 'Qualquer', false)).toBeNull();
  });
  // Sobras da validação final: letras de outros alfabetos, largura total, invisíveis e controles de direção.
  it('letras parecidas, de largura total e invisíveis não fazem outro "Administrador"', () => {
    const lookAlikes = [
      '\u0410dmin', // A cirílico
      '\u0410dministrador',
      'Administr\u0430dor', // a cirílico no meio
      'Administrad\u03bfr', // ο grego
      'Adm\u0456n', // і cirílico
      '\u0391DMIN', // Α grego
      '\uff21\uff44\uff4d\uff49\uff4e', // Ａｄｍｉｎ
      '\ud835\udc00\ud835\udc1d\ud835\udc26\ud835\udc22\ud835\udc27', // 𝐀𝐝𝐦𝐢𝐧
      'Ad\u200bmin', // espaço de largura zero
      'Admin\u2060istrador', // junção invisível
      '\u1d00\u1d05\u1d0d\u026a\u0274', // versaletes
      'Adrninistrador', // rn no lugar de m
      'Admln', // l no lugar de i
      'Adm1n',
      'Administrad0r',
      '\u2605 Administrador \u2605',
      'Administradora',
      '\u0410d\u043c\u0456\u043d', // Аdмін: м, і e н cirílicos
    ];
    for (const d of lookAlikes) expect(check('falso', d), JSON.stringify(d)).toBe('RBAC_DUPLICATE_ROLE_LABEL');
    // O motivo diz com qual papel se confunde.
    expect(roleNameProblem('falso', '\u0410dmin', roles, ROLE_LABEL, { isNew: true, displayName: roleDisplayName })?.error).toBe(
      'Esse nome se confunde com o do papel “Administrador”. Escolha outro nome de exibição.',
    );
    // Controle de direção: "\u202EnimdA" aparece como "Admin"; o nome com ele é recusado de vez.
    expect(check('falso', '\u202enimdA')).toBe('RBAC_INVALID_ROLE_LABEL');
    expect(check('falso', 'Chefe\u2066 de turno')).toBe('RBAC_INVALID_ROLE_LABEL');
    expect(roleNameProblem('falso', '\u202enimdA', roles, ROLE_LABEL, { isNew: true, displayName: roleDisplayName })?.field).toBe('label');
    // O identificador também: "Adm1n" e "administrator" são do Administrador.
    expect(check('Adm1n', 'X')).toBe('RBAC_RESERVED_ROLE_NAME');
    expect(check('administrator', 'X')).toBe('RBAC_RESERVED_ROLE_NAME');
  });
  it('os nomes de todos os papéis padrão ficam reservados, também o que só aparece na descrição ("Dono da sala")', () => {
    for (const d of ['Dono da sala', 'Dono', 'D\u043eno', 'Moderador', 'Moderador da sala', 'M\u043ederador', 'Líder', 'Lider da sala', 'Usuário', 'Usu\u0430rio', 'Bot', 'Convidado', 'Operação', 'Operacao', 'Anônimo', 'App', 'Publicador', 'Auditor de logs']) {
      expect(check('falso', d), d).toBe('RBAC_DUPLICATE_ROLE_LABEL');
    }
    // Os identificadores também, ainda que a linha não exista (o Operação pode ser excluído).
    const semOperacao = roles.filter((r) => r.id !== 'operacao');
    const novo = (id: string, d: string) => roleNameProblem(id, d, semOperacao, ROLE_LABEL, { isNew: true, displayName: roleDisplayName })?.code ?? null;
    expect(novo('Operacao', 'Turno')).toBe('error-duplicate-role-names-not-allowed');
    expect(novo('moderador', 'Turno')).toBe('error-duplicate-role-names-not-allowed');
    expect(novo('falso', 'Operação')).toBe('RBAC_DUPLICATE_ROLE_LABEL');
    // Só o próprio Operação volta com o nome dele.
    expect(novo('operacao', 'Operação')).toBeNull();
  });
  it('só o nome inteiro conta: um nome que acrescenta palavras passa', () => {
    for (const d of ['Administrador do NOC', 'Moderador de turno', 'Administrador 2', 'Dono do processo', 'Chefe de turno', 'Dev 👨‍💻', 'Supervisão']) {
      expect(check('falso', d), d).toBeNull();
    }
    // A forma de comparação: acentos, maiúsculas, pontuação e invisíveis não contam; a tabela vale nos dois lados.
    expect(roleNameKey('  Ａdm\u200bin! ')).toBe('admin');
    expect(roleNameKey('\u0410\u0434min')).not.toBe('admin'); // д cirílico não parece d: fica
    expect(roleNameKey('Operação')).toBe(roleNameKey('OPERACAO'));
  });
});

describe('texto de erro da API (web)', () => {
  it('troca o padrão em inglês e o código cru por português, e mantém o texto do servidor', () => {
    expect(readableError(403, 'error-not-allowed', 'User does not have the permissions required for this action')).toBe('Você não tem permissão para fazer isso.');
    expect(readableError(401, 'error-unauthorized', 'You must be logged in to do this.')).toBe('Entre de novo para continuar.');
    expect(readableError(404, 'error-room-not-found', 'error-room-not-found')).toBe('Não encontrado.');
    expect(readableError(500, undefined, undefined)).toBe('Não deu certo (erro 500).');
    expect(readableError(400, 'error-invalid-params', 'O parâmetro "name" é obrigatório.')).toBe('O parâmetro "name" é obrigatório.');
  });
});

describe('nome do dispositivo (Dispositivos, e-mail de acesso novo e Meus dados)', () => {
  it('programa ou navegador desconhecido nunca vira "Outro em Desconhecido"', () => {
    expect(deviceLabel({ name: 'Chrome em Windows', browser: 'Chrome', os: 'Windows' })).toBe('Chrome em Windows');
    expect(deviceLabel({ name: 'Outro em Desconhecido', browser: 'Outro', os: 'Desconhecido' })).toBe('Navegador ou aplicativo desconhecido');
    expect(deviceLabel({ name: 'Outro em Linux', browser: 'Outro', os: 'Linux' })).toBe('Navegador ou aplicativo desconhecido em Linux');
    expect(deviceLabel({ name: 'API em Desconhecido', browser: 'API', os: 'Desconhecido' })).toBe('Navegador ou aplicativo desconhecido');
    expect(deviceLabel({ name: 'Firefox em Desconhecido', browser: 'Firefox', os: 'Desconhecido' })).toBe('Firefox');
    expect(deviceLabel({ name: 'Notebook da Ana' })).toBe('Notebook da Ana');
    expect(deviceLabel({})).toBe('Navegador ou aplicativo desconhecido');
  });
});

describe('linha agrupada de entradas e saídas', () => {
  const ev = (t: string, username: string, name: string, min: number, msg = '') =>
    ({ _id: `${t}-${username}-${min}`, rid: 'r', t, msg, u: { _id: username, username, name }, ts: new Date(Date.UTC(2026, 10, 4, 3, min)).toISOString() }) as unknown as Message;
  it('quem saiu e voltou aparece uma vez, na ordem certa', () => {
    expect(joinsText([ev('ul', 'gabi', 'Gabriela Nunes', 1), ev('uj', 'gabi', 'Gabriela Nunes', 2)])).toBe('Gabriela Nunes saiu e voltou');
    expect(joinsText([ev('uj', 'gabi', 'Gabriela Nunes', 1), ev('ul', 'gabi', 'Gabriela Nunes', 2)])).toBe('Gabriela Nunes entrou e saiu da sala');
    // Fora de ordem na lista: vale a hora.
    expect(joinsText([ev('uj', 'gabi', 'Gabriela Nunes', 2), ev('ul', 'gabi', 'Gabriela Nunes', 1)])).toBe('Gabriela Nunes saiu e voltou');
  });
  it('as partes seguem a ordem em que começaram', () => {
    const ms = [ev('ul', 'bia', 'Bia', 1), ev('uj', 'ana', 'Ana', 2), ev('uj', 'caio', 'Caio', 3), ev('au', 'adm', 'Administrador', 4, 'rui')];
    expect(joinsText(ms, (u) => (u === 'rui' ? 'Rui Costa' : u))).toBe('Bia saiu da sala; Ana e Caio entraram na sala; Administrador adicionou Rui Costa');
  });
});

// Validação final: papel com "Dar e tirar papéis" sem "Ver a lista de usuários" não acha a tela de Usuários.
describe('screenGapWarning', () => {
  it('avisa quando a permissão não tem a tela, e só então', () => {
    expect(screenGaps(['assign-roles'])).toEqual([{ key: 'assign-roles', needs: 'view-user-administration' }]);
    expect(screenGapWarning(['assign-roles'])).toBe(
      'Sem “Ver a lista de usuários”, quem tiver este papel (e nenhum outro com ela) não encontra a tela para usar “Dar e tirar papéis de pessoas”.',
    );
    expect(screenGapWarning(['assign-roles', 'assign-admin-role'])).toContain('“Dar e tirar papéis de pessoas” e “Dar o papel de Administrador”');
    expect(screenGapWarning(['assign-roles', 'view-user-administration'])).toBeUndefined();
    expect(screenGapWarning(['view-user-administration'])).toBeUndefined();
    expect(screenGapWarning([])).toBeUndefined();
  });
});


// Sobras da validação final: no "@" sozinho, com 10 ou mais pessoas, @all e @here sumiam no corte em 10.
describe('sugestões do @ (compositor)', () => {
  const people = Array.from({ length: 12 }, (_, i) => `p${i}`);
  it('os grupos que a pessoa pode usar têm vaga mesmo com 10 ou mais pessoas', () => {
    expect(mentionSuggestions(people, ['@all', '@here'])).toEqual([...people.slice(0, 8), '@all', '@here']);
    expect(mentionSuggestions(people, ['@all', '@here'], 'eu')).toEqual([...people.slice(0, 7), '@all', '@here', 'eu']);
    expect(mentionSuggestions(people, [])).toEqual(people.slice(0, 10));
    // Com poucas pessoas, todas aparecem antes dos grupos.
    expect(mentionSuggestions(['ana', 'bia'], ['@all'], 'eu')).toEqual(['ana', 'bia', '@all', 'eu']);
    expect(mentionSuggestions([], ['@all', '@here'])).toEqual(['@all', '@here']);
  });
  it('@all e @here só para quem pode e só se o termo combina', () => {
    const all = () => true;
    expect(mentionGroups('', all)).toEqual(['all', 'here']);
    expect(mentionGroups('h', all)).toEqual(['here']);
    expect(mentionGroups('ana', all)).toEqual([]);
    expect(mentionGroups('', (p) => p === 'mention-here')).toEqual(['here']);
    expect(mentionGroups('', () => false)).toEqual([]);
  });
});

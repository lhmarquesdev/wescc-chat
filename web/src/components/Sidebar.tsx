import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useFilesTab } from '../lib/files';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { Subscription, UserStatus } from '@shared/index';
import { parseSpotlightQuery } from '@shared/search';
import { presenceLabel, shownCustomStatus, silencesNotifications, statusLine } from '@shared/status';
import { api, errorMessage } from '../lib/api';
import { badgeCount, MY_STATUS_LABEL, roomIconName, roomPath } from '../lib/format';
import { matchesLocal, spotlightHint } from '../lib/spotlightRules';
import { useInstallPrompt } from '../lib/install';
import { logout } from '../lib/session';
import { usePermission, useSetting, useStore } from '../lib/store';
import { applyTheme } from '../pages/AccountPage';
import { ADMIN_MENU_PERMS } from '../pages/admin/sections';
import { BrandMark } from './BrandIcons';
import { CreateModal, type CreateKind } from './CreateModal';
import { Icon, type IconName } from './Icon';
import { isMentionBadge, useForYou, type ForYouItem } from './navState';
// Chamadas em grupo: ponto da sala com chamada viva, "Em chamada" nas conversas a dois e o selo de perdidas.
import { CallsNavBadge, InCallBadge, RoomLiveDot } from './call/LiveIndicators';
import { useDirectPeer } from '../lib/roomcall';
import { useIsPhone, type Placement } from './overlay';
import { SpotlightResults, useSpotlight, useSpotlightRows } from './Spotlight';
import { Empty, Field, GroupAvatar, Menu, Modal, UserAvatar } from './ui';

// Preferências da barra lateral, só neste navegador (grupos recolhidos e ordem).
const local = {
  get(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // sem armazenamento (janela anônima, site bloqueado): vale só nesta sessão
    }
  },
};

type SortMode = 'recent' | 'az';
const byName = (a: Subscription, b: Subscription) => (a.fname || a.name).localeCompare(b.fname || b.name, 'pt-BR');
// Recentes: pela hora da última mensagem da sala (sem mensagens, quando a pessoa entrou). Nunca pela atualização da
// inscrição: ler a sala muda essa hora e a lista trocava de lugar a cada sala aberta.
const recentAt = (s: Subscription) => s.lm ?? s.ts ?? '';
const byRecent = (a: Subscription, b: Subscription) => recentAt(b).localeCompare(recentAt(a)) || byName(a, b);
// Cada grupo guarda a própria ordem; side.sort é a ordem única de antes e vale como padrão.
const sortKey = (group: string) => `side.sort.${group}`;
const readSort = (group: string): SortMode => ((local.get(sortKey(group)) ?? local.get('side.sort')) === 'az' ? 'az' : 'recent');

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

// ---------- Item de sala ----------

// onPick: na busca, abrir uma conversa termina a busca (como o Enter e as linhas de Pessoas e Canais).
function SidebarItem({ s, big, onPick }: { s: Subscription; big?: boolean; onPick?: () => void }) {
  const typing = useStore((st) => Object.keys(st.typing[s.rid] ?? {}).length > 0);
  const dmUser = s.t === 'd' && !s.name.includes(',') ? s.name : null;
  const silenced = !!s.notifications?.disableNotifications;
  const mention = isMentionBadge(s);
  // Sala silenciada ou com o contador oculto: só o selo de menção aparece.
  const count = s.unread > 0 && (mention || (!silenced && !s.notifications?.hideUnreadStatus)) ? s.unread : 0;
  const kind = mention ? 'mention' : s.groupMentions > 0 ? 'group' : '';
  // Chamadas em grupo: a outra pessoa da conversa a dois, para o "Em chamada".
  const otherId = useDirectPeer(s.rid, !!dmUser);
  // Conversa oculta (só aparece na busca): abrir volta a mostrá-la na lista.
  const hidden = !s.open;
  return (
    <NavLink
      to={roomPath(s)}
      className={({ isActive }) => ['side-item', isActive && 'active', (s.alert || s.unread) && 'unread', silenced && 'silenced'].filter(Boolean).join(' ')}
      onClick={() => {
        if (hidden) void api.post('rooms.open', { roomId: s.rid }).catch(() => {});
        onPick?.();
      }}
    >
      {dmUser ? (
        <UserAvatar username={dmUser} size={big ? 24 : 20} />
      ) : s.t === 'd' ? (
        <GroupAvatar usernames={s.name.split(/,\s*/)} size={big ? 24 : 20} />
      ) : (
        <span className="side-icon">
          <Icon name={roomIconName(s)} size={big ? 18 : 16} />
        </span>
      )}
      <span className="side-name">{s.fname || s.name}</span>
      {hidden && <span className="side-hint">Oculta</span>}
      {/* Chamadas em grupo: */}
      {dmUser ? <InCallBadge userId={otherId} /> : <RoomLiveDot rid={s.rid} />}
      {typing ? (
        <span className="side-typing" role="img" aria-label="digitando">
          <i />
          <i />
          <i />
        </span>
      ) : (
        <>
          {s.tunread.length > 0 && (
            <span className="badge thread" title="Tópicos com respostas novas">
              <Icon name="panel-threads" size={12} />
              {badgeCount(s.tunread.length)}
            </span>
          )}
          {count > 0 && <span className={kind ? `badge ${kind}` : 'badge'}>{badgeCount(count)}</span>}
        </>
      )}
    </NavLink>
  );
}

// ---------- Grupo (recolhível) ----------

function SideGroup({
  title,
  items,
  searching,
  big,
  sort,
  onSort,
  add,
  onPick,
}: {
  title: string;
  items: Subscription[];
  searching: boolean;
  big?: boolean;
  sort: SortMode;
  onSort: (s: SortMode) => void;
  add?: { label: string; onClick: () => void };
  onPick?: () => void;
}) {
  const key = `side.collapsed.${title}`;
  const [collapsed, setCollapsed] = useState(() => local.get(key) === '1');
  const { pathname } = useLocation();
  const toggle = () => {
    setCollapsed(!collapsed);
    local.set(key, collapsed ? null : '1');
  };
  // Recolhido ainda mostra a sala aberta e as que têm novidade; numa busca, mostra tudo.
  const shown = collapsed && !searching ? items.filter((s) => s.alert || s.unread > 0 || s.tunread.length || pathname.startsWith(roomPath(s))) : items;
  return (
    <div className="side-group">
      <div className="side-group-head">
        <button type="button" className="side-group-title" aria-expanded={!collapsed || searching} onClick={toggle}>
          <Icon name="chevron-down" size={12} className={collapsed && !searching ? 'collapsed' : undefined} />
          {title}
        </button>
        <div className="side-group-tools">
          <Menu
            align="left"
            label={`Ordenar ${title}`}
            trigger={
              <button type="button" className="icon-btn" title="Ordenar" aria-label={`Ordenar ${title}`}>
                <Icon name="sort" size={14} />
              </button>
            }
          >
            {(close) => (
              <>
                <div className="menu-label">Ordenar {title.toLowerCase()} por</div>
                {(
                  [
                    ['recent', 'Recentes'],
                    ['az', 'A–Z'],
                  ] as const
                ).map(([id, label]) => (
                  <button key={id} role="menuitemradio" aria-checked={sort === id} onClick={() => (onSort(id), close())}>
                    {label}
                    {sort === id && <Icon name="check" className="menu-check" />}
                  </button>
                ))}
              </>
            )}
          </Menu>
          {add && (
            <button type="button" className="icon-btn" title={add.label} aria-label={add.label} onClick={add.onClick}>
              <Icon name="add" />
            </button>
          )}
        </div>
      </div>
      {shown.map((s) => (
        <SidebarItem key={s.rid} s={s} big={big} onPick={onPick} />
      ))}
    </div>
  );
}

// ---------- Menu "Criar" ----------

const CREATE_ITEMS: { kind: CreateKind; icon: IconName; label: string; desc: string }[] = [
  { kind: 'dm', icon: 'room-dm', label: 'Mensagem direta', desc: 'Converse com uma ou mais pessoas' },
  { kind: 'channel', icon: 'room-channel', label: 'Canal', desc: 'Um espaço para um assunto ou equipe' },
  { kind: 'team', icon: 'room-team', label: 'Time', desc: 'Agrupe canais e pessoas' },
  { kind: 'discussion', icon: 'room-discussion', label: 'Discussão', desc: 'Um assunto à parte dentro de uma sala' },
];

// O que a pessoa pode criar (quem é da operação, por exemplo, só abre mensagem direta).
function useCreatable() {
  const dm = usePermission('create-d');
  const discussion = usePermission(['start-discussion', 'start-discussion-other-user']);
  const channel = usePermission(['create-c', 'create-p']);
  const team = usePermission('create-team');
  const can: Record<CreateKind, boolean> = { dm, discussion, channel, team };
  return CREATE_ITEMS.filter((i) => can[i.kind]);
}

function CreateMenu({ onPick, size = 18 }: { onPick: (k: CreateKind) => void; size?: 18 | 20 }) {
  const items = useCreatable();
  if (!items.length) return null;
  return (
    <Menu
      className="create-menu"
      label="Criar"
      sheetTitle="Criar"
      trigger={
        <button type="button" className="icon-btn" title="Criar" aria-label="Criar">
          <Icon name="compose" size={size} />
        </button>
      }
    >
      {(close) =>
        items.map((i) => (
          <button key={i.kind} onClick={() => (onPick(i.kind), close())}>
            <span className="create-tile">
              <Icon name={i.icon} />
            </span>
            <span className="menu-text">
              <span>{i.label}</span>
              <span className="menu-desc">{i.desc}</span>
            </span>
          </button>
        ))
      }
    </Menu>
  );
}

// ---------- Menu do usuário ----------

type Theme = 'light' | 'dark' | 'auto';
const THEMES: { id: Theme; label: string; icon: IconName }[] = [
  { id: 'light', label: 'Claro', icon: 'theme-light' },
  { id: 'dark', label: 'Escuro', icon: 'theme-dark' },
  { id: 'auto', label: 'Automático', icon: 'theme-auto' },
];

// O próprio status: o real (ao vivo), a mensagem, o rótulo (o personalizado, como "Em reunião", ou o de base),
// se a pessoa escolheu um personalizado e se as notificações estão silenciadas (Ocupado).
export function useMyStatus() {
  const me = useStore((s) => s.me)!;
  const live = useStore((s) => s.presence[me.username]);
  const list = useStore((s) => s.userStatuses);
  const status = (live?.status ?? me.status ?? 'offline') as UserStatus;
  const text = (live ? live.statusText : me.statusText) || '';
  // O personalizado de quem está invisível só a própria pessoa sabe (a presença chega sem ele): vem de me.
  const custom = !!shownCustomStatus({ status, statusCustom: me.statusCustom }, list);
  const label = presenceLabel({ status, statusCustom: me.statusCustom }, list);
  const silenced = silencesNotifications(me.statusDefault);
  return { status, text, label, custom, silenced, line: statusLine(label, custom, text) };
}

function StatusTextModal({ onClose }: { onClose: () => void }) {
  const { text: current } = useMyStatus();
  const [text, setText] = useState(current);
  const [busy, setBusy] = useState(false);
  const save = async (value: string) => {
    setBusy(true);
    try {
      await api.post('users.setStatus', { message: value });
      const me = useStore.getState().me;
      if (me) useStore.getState().setMe({ ...me, statusText: value });
      onClose();
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
      setBusy(false);
    }
  };
  return (
    <Modal
      size="sm"
      title="Mensagem de status"
      description="Aparece ao lado do seu nome para quem conversa com você."
      onClose={onClose}
      footer={
        <>
          {current && (
            <button type="button" className="btn ghost" disabled={busy} onClick={() => void save('')}>
              Limpar
            </button>
          )}
          <button type="button" className="btn primary" disabled={busy || text.trim() === current} onClick={() => void save(text.trim())}>
            Salvar
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() !== current) void save(text.trim());
        }}
      >
        <Field label="Mensagem" hint="Até 120 caracteres.">
          <input autoFocus maxLength={120} value={text} placeholder="Em reunião até 15h" onChange={(e) => setText(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

// Até este tanto, os personalizados aparecem direto no menu; mais que isso, ficam atrás de "Personalizados" (com 20 ou
// 30, Minha conta, Tema e Sair saíam da tela). O escolhido continua à vista com o grupo fechado.
const CUSTOM_INLINE = 5;

function CustomStatusItems({ chosen, close }: { chosen: string | null; close: () => void }) {
  const statuses = useStore((s) => s.userStatuses);
  const [open, setOpen] = useState(false);
  if (!statuses.length) return null;
  const many = statuses.length > CUSTOM_INLINE;
  const shown = !many || open ? statuses : statuses.filter((x) => x._id === chosen);
  return (
    <>
      {many ? (
        <button type="button" className="menu-disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="chevron-down" />
          <span className="menu-text">Personalizados</span>
          <span className="menu-count">{statuses.length}</span>
        </button>
      ) : (
        <div className="menu-label">Personalizados</div>
      )}
      {shown.map((x) => (
        <button key={x._id} role="menuitemradio" aria-checked={chosen === x._id} onClick={() => (void setStatus({ statusId: x._id }), close())}>
          <span className={`status-dot ${x.statusType}`} aria-hidden="true" />
          <span className="menu-text">{x.name}</span>
          {chosen === x._id && <Icon name="check" className="menu-check" />}
        </button>
      ))}
    </>
  );
}

// Status de base ou personalizado. A marca no menu muda já (as outras abas recebem pelo evento "user").
async function setStatus(choice: { status?: UserStatus; statusId?: string }) {
  try {
    await api.post('users.setStatus', choice);
    const st = useStore.getState();
    const custom = choice.statusId ? st.userStatuses.find((x) => x._id === choice.statusId) : undefined;
    const statusDefault = custom?.statusType ?? choice.status;
    if (st.me && statusDefault) st.setMe({ ...st.me, statusDefault, statusCustom: custom?._id ?? null });
  } catch (e) {
    useStore.getState().toast(errorMessage(e), 'error');
  }
}

async function setTheme(theme: Theme) {
  const me = useStore.getState().me;
  if (!me) return;
  applyTheme(theme);
  try {
    await api.post('users.setPreferences', { data: { theme } });
    useStore.getState().setMe({ ...me, preferences: { ...me.preferences, theme } });
  } catch (e) {
    applyTheme(String(me.preferences?.theme ?? 'auto'));
    useStore.getState().toast(errorMessage(e), 'error');
  }
}

function useAdminHome() {
  // Quem abre qualquer seção da Administração vê o item (figurinhas, chamadas, Jira...): a lista sai das seções.
  const canAdmin = usePermission(ADMIN_MENU_PERMS);
  const canStats = usePermission('view-statistics');
  const canImport = usePermission(['run-import', 'view-import-operations']);
  // Quem só cuida de importações cai direto nelas, não em Informações (que exige view-statistics).
  // Figurinhas: os outros vão para /admin, e a Administração abre a primeira seção que a pessoa pode ver.
  return canAdmin ? (!canStats && canImport ? '/admin/import' : '/admin') : null;
}

// Status, mensagem de status, conta, administração, tema, instalar e sair. No celular vira folha.
export function UserMenu({ trigger, placement }: { trigger: ReactNode; placement?: Placement }) {
  const me = useStore((s) => s.me)!;
  const navigate = useNavigate();
  const adminHome = useAdminHome();
  const install = useInstallPrompt();
  const [editStatus, setEditStatus] = useState(false);
  const { status, text, silenced } = useMyStatus();
  const statuses = useStore((s) => s.userStatuses);
  const theme = String(me.preferences?.theme ?? 'auto');
  const chosen = me.statusDefault ?? status;
  const chosenCustom = me.statusCustom && statuses.some((x) => x._id === me.statusCustom) ? me.statusCustom : null;
  return (
    <>
      <Menu align="left" placement={placement} label="Menu do usuário" className="user-menu" trigger={trigger}>
        {(close) => (
          <>
            <div className="menu-title">
              <UserAvatar username={me.username} size={40} status={status} />
              <strong>{me.name}</strong>
              <span>@{me.username}</span>
            </div>
            {(['online', 'away', 'busy', 'offline'] as const).map((s) => (
              <button key={s} role="menuitemradio" aria-checked={!chosenCustom && chosen === s} onClick={() => (void setStatus({ status: s }), close())}>
                <span className={`status-dot ${s}`} aria-hidden="true" />
                {MY_STATUS_LABEL[s]}
                {!chosenCustom && chosen === s && <Icon name="check" className="menu-check" />}
              </button>
            ))}
            {/* Logo abaixo de "Ocupado": quem acabou de escolher vê o aviso sem rolar. */}
            {silenced && (
              <div className="menu-note">
                <Icon name="notify-silenced" />
                <span>Notificações silenciadas enquanto você estiver ocupado. Chamadas continuam tocando.</span>
              </div>
            )}
            <CustomStatusItems chosen={chosenCustom} close={close} />
            <button onClick={() => (setEditStatus(true), close())}>
              <Icon name="edit" />
              <span className="menu-text">
                <span>{text ? 'Alterar mensagem de status' : 'Definir mensagem de status'}</span>
                {text && <span className="menu-desc">{text}</span>}
              </span>
            </button>
            <hr />
            <button onClick={() => (navigate('/account/profile'), close())}>
              <Icon name="account" />
              Minha conta
            </button>
            {adminHome && (
              <button onClick={() => (navigate(adminHome), close())}>
                <Icon name="admin" />
                Administração
              </button>
            )}
            <hr />
            <div className="menu-label">Tema</div>
            <div className="menu-theme" role="group" aria-label="Tema">
              {THEMES.map((t) => (
                <button key={t.id} type="button" role="menuitemradio" aria-checked={theme === t.id} className={theme === t.id ? 'on' : undefined} onClick={() => void setTheme(t.id)}>
                  <Icon name={t.icon} />
                  {t.label}
                </button>
              ))}
            </div>
            {(install.available || install.iosHint) && <hr />}
            {install.available && (
              <button onClick={() => (void install.install(), close())}>
                <Icon name="install" />
                Instalar app
              </button>
            )}
            {install.iosHint && (
              <div className="menu-note">
                <Icon name="install" />
                <span>Para instalar, toque em Compartilhar e depois em Adicionar à Tela de Início.</span>
              </div>
            )}
            <hr />
            <button onClick={() => void logout().then(() => (location.href = '/login'))}>
              <Icon name="logout" />
              Sair
            </button>
          </>
        )}
      </Menu>
      {editStatus && <StatusTextModal onClose={() => setEditStatus(false)} />}
    </>
  );
}

// Rodapé com a pessoa e o status: abre o menu do usuário para cima. Também usado pela navegação da administração.
export function SideFoot() {
  const me = useStore((s) => s.me)!;
  const { status, line, silenced } = useMyStatus();
  return (
    <div className="side-foot">
      <UserMenu
        placement="top-start"
        trigger={
          <button type="button" className="me-btn" title={`${me.name} · ${line}`}>
            <UserAvatar username={me.username} size={32} status={status} />
            <span className="me-text">
              <span className="me-name">{me.name}</span>
              <span className="me-status">
                <span className="me-status-text">{line}</span>
                {silenced && <Icon name="notify-silenced" size={12} className="me-silenced" label="Notificações silenciadas" />}
              </span>
            </span>
            <Icon name="me-menu" className="me-chevron" />
          </button>
        }
      />
    </div>
  );
}

// Primeira linha da navegação de Administração e Conta no modo takeover (a seção toma o lugar da barra lateral).
export function TakeoverBack() {
  return (
    <Link to="/home" className="page-nav-back">
      <Icon name="back" />
      Voltar às conversas
    </Link>
  );
}

// Celular: barra com a volta e o nome da área acima da faixa de seções (lá a navegação lateral, que diz isso no
// desktop, vira só a faixa). Some no desktop.
export function TakeoverHead({ title }: { title: string }) {
  return (
    <div className="takeover-head">
      <Link to="/home" className="icon-btn" aria-label="Voltar às conversas" title="Voltar às conversas">
        <Icon name="back" />
      </Link>
      <strong>{title}</strong>
    </div>
  );
}

// ---------- Navegação principal ----------

// Chamadas em grupo: `extra` leva um selo próprio (o de chamadas perdidas, com o rótulo para leitores de tela).
function NavRow({
  to,
  match,
  icon,
  label,
  badge,
  badgeKind,
  extra,
  onNavigate,
}: {
  to: string;
  match?: string;
  icon: IconName;
  label: string;
  badge?: number;
  badgeKind?: string;
  extra?: ReactNode;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const active = pathname === to || pathname.startsWith(`${match ?? to}/`) || (!!match && pathname === match);
  return (
    <button
      type="button"
      className={active ? 'side-item active' : 'side-item'}
      title={label}
      aria-current={active ? 'page' : undefined}
      onClick={() => (navigate(to), onNavigate?.())}
    >
      <span className="side-icon">
        <Icon name={icon} />
      </span>
      <span className="side-name">{label}</span>
      {!!badge && <span className={badgeKind ? `badge ${badgeKind}` : 'badge'}>{badgeCount(badge)}</span>}
      {extra}
    </button>
  );
}

// ---------- "Para você" (celular) ----------

// Cartão de menção ou chamada perdida (faixa do celular e Início).
export function ForYouCard({ item }: { item: ForYouItem }) {
  const navigate = useNavigate();
  return (
    <button type="button" className="for-you-card" onClick={() => navigate(item.to)}>
      <span className={`for-you-icon ${item.kind}`}>
        <Icon name={item.kind === 'mention' ? 'mention' : 'call-missed'} size={20} />
      </span>
      <span className="for-you-text">
        <span className="for-you-name">{item.title}</span>
        <span className="for-you-sub">{item.sub}</span>
      </span>
    </button>
  );
}

function ForYou() {
  const items = useForYou(3);
  const scroller = useRef<HTMLDivElement>(null);
  const first = items[0]?.key;
  // Um cartão novo entra no começo: a faixa volta ao início para ele aparecer inteiro (sem isso o cartão antigo
  // ficava no lugar e o novo, cortado à esquerda).
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = 0;
  }, [first]);
  if (!items.length) return null;
  return (
    <section className="for-you" aria-label="Para você">
      <h2 className="for-you-title">Para você</h2>
      <div className="for-you-scroll" ref={scroller}>
        {items.map((i) => (
          <ForYouCard key={i.key} item={i} />
        ))}
      </div>
    </section>
  );
}

// ---------- Barra lateral ----------

// mode "list": no celular, a lista de conversas é a tela inicial (sem navegação nem rodapé: a barra de abas cuida disso).
export function Sidebar({ onNavigate, mode = 'side' }: { onNavigate?: () => void; mode?: 'side' | 'list' }) {
  const subs = useStore((s) => s.subscriptions);
  const connected = useStore((s) => s.connected);
  const siteName = useSetting<string>('Site_Name');
  const callsEnabled = useSetting<boolean>('Calls_Enabled');
  const calendarOn = useSetting<boolean>('Calendar_Enabled') !== false;
  const filesOn = useFilesTab(); // Arquivos
  const phone = useIsPhone();
  const list = mode === 'list';
  const [filter, setFilter] = useState('');
  const [create, setCreate] = useState<CreateKind | null>(null);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [sorts, setSorts] = useState<Record<string, SortMode>>({});
  const canDm = usePermission('create-d');
  const canChannel = usePermission(['create-c', 'create-p']);
  const navigate = useNavigate();
  const listRef = useRef<HTMLElement>(null);
  const sortOf = (group: string) => sorts[group] ?? readSort(group);
  const setSort = (group: string, mode: SortMode) => {
    setSorts((x) => ({ ...x, [group]: mode }));
    local.set(sortKey(group), mode);
  };

  // Ctrl+K (⌘K no Mac) vai para a busca da barra lateral.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        const el = document.getElementById('sidebar-filter') as HTMLInputElement | null;
        // Barra escondida (takeover, gaveta fechada no celular): o atalho fica com o navegador.
        if (!el || !el.getClientRects().length || el.closest('[inert]')) return;
        e.preventDefault();
        el.focus();
        el.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const searching = filter.trim().length > 0;
  const all = useMemo(() => Object.values(subs).filter((s) => s.open || s.unread > 0 || s.alert), [subs]);
  const groups = useMemo(() => {
    // Na busca entram também as conversas ocultas; sem acento, pelo nome de exibição ou pelo usuário da DM, com @ e #.
    const q = parseSpotlightQuery(filter);
    const list = (searching ? Object.values(subs) : all)
      .filter((s) => !searching || matchesLocal(s, q))
      .filter((s) => !onlyUnread || s.unread > 0 || s.alert || s.tunread.length);
    return [
      { title: 'Favoritos', items: list.filter((s) => s.f) },
      { title: 'Times', items: list.filter((s) => !s.f && s.teamMain) },
      { title: 'Canais', items: list.filter((s) => !s.f && !s.teamMain && !s.prid && (s.t === 'c' || s.t === 'p')), add: canChannel ? { label: 'Criar canal', onClick: () => setCreate('channel') } : undefined },
      { title: 'Discussões', items: list.filter((s) => !s.f && s.prid) },
      { title: 'Mensagens diretas', items: list.filter((s) => !s.f && s.t === 'd'), add: canDm ? { label: 'Nova mensagem direta', onClick: () => setCreate('dm') } : undefined },
    ]
      .map((g) => ({ ...g, items: g.items.sort(sortOf(g.title) === 'az' ? byName : byRecent) }))
      .filter((g) => g.items.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, subs, filter, searching, onlyUnread, sorts, canChannel, canDm]);
  const localCount = groups.reduce((n, g) => n + g.items.length, 0);

  // Pessoas e canais do servidor depois das conversas (não com "Somente não lidas": ali só contam as da lista).
  const spot = useSpotlight(filter, searching && !onlyUnread);
  const spotRows = useSpotlightRows(spot);
  const spotCount = spotRows.people.length + spotRows.rooms.length;
  // Enter antes de a resposta chegar: abre o primeiro resultado quando ela vier (se o texto não mudar).
  const [pendingEnter, setPendingEnter] = useState<string | null>(null);
  const finishSearch = () => {
    setFilter('');
    setPendingEnter(null);
    // Sai do campo (no celular, fecha o teclado).
    (document.getElementById('sidebar-filter') as HTMLInputElement | null)?.blur();
  };
  const spotDone = () => {
    finishSearch();
    onNavigate?.();
  };
  // Enter abre o primeiro resultado, na ordem da tela: conversas, depois Pessoas, depois Canais e times (cada linha
  // termina a busca ao abrir).
  const openFirst = () => {
    const first = listRef.current?.querySelector<HTMLElement>('.side-item');
    if (!first) return false;
    first.click();
    return true;
  };
  // "Abrir diretório" leva o texto da busca (com @, na aba Pessoas) e termina a busca daqui.
  const openDirectory = () => {
    const q = parseSpotlightQuery(filter);
    navigate(`/directory${q.scope === 'users' ? '/users' : ''}${q.text ? `?q=${encodeURIComponent(q.text)}` : ''}`);
    finishSearch();
    onNavigate?.();
  };
  useEffect(() => {
    if (!pendingEnter) return;
    if (spot.key !== pendingEnter) return setPendingEnter(null);
    if (spot.settledFor === pendingEnter) {
      setPendingEnter(null);
      openFirst();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEnter, spot.key, spot.settledFor]);

  // Setas para cima e para baixo andam pelas conversas; da primeira, para cima volta à busca. Esc numa linha volta à busca.
  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' && (e.target as HTMLElement).closest('.side-item')) {
      e.preventDefault();
      document.getElementById('sidebar-filter')?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('.side-item') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    if (e.key === 'ArrowUp' && i === 0) document.getElementById('sidebar-filter')?.focus();
    else items[e.key === 'ArrowDown' ? Math.min(i + 1, items.length - 1) : i - 1]?.focus();
  };

  let empty: ReactNode = null;
  // Curta demais (uma letra, só "@" ou "#"): o servidor não foi perguntado; no lugar de "Nada encontrado", a dica.
  const spotIdle = searching && !onlyUnread && !spot.key;
  // A busca só diz "nada encontrado" quando o servidor também respondeu sem nada (ou quando nem foi perguntado).
  const spotSettledEmpty = !spot.key || (spot.settledFor === spot.key && !spot.error && spotCount === 0);
  if (!groups.length) {
    if (searching) {
      if (spotSettledEmpty && !spotIdle)
        empty = (
          <Empty
            icon="search"
            title={`Nada encontrado para “${filter.trim()}”`}
            action={
              <button type="button" className="btn small" onClick={openDirectory}>
                Abrir diretório
              </button>
            }
          >
            Confira a grafia ou procure no diretório.
          </Empty>
        );
    }
    else if (onlyUnread && all.length)
      empty = (
        <Empty
          icon="all-done"
          title="Tudo lido"
          action={
            <button type="button" className="btn small" onClick={() => setOnlyUnread(false)}>
              Mostrar todas
            </button>
          }
        >
          Não há conversas com mensagens novas.
        </Empty>
      );
    else
      empty = (
        <Empty
          icon="nav-chats"
          title="Nenhuma conversa ainda"
          action={
            <button type="button" className="btn small" onClick={() => (navigate('/directory'), onNavigate?.())}>
              Abrir diretório
            </button>
          }
        >
          Entre em um canal ou mande uma mensagem direta.
        </Empty>
      );
  }

  return (
    <aside className="sidebar" data-mode={mode} onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate?.()}>
      <div className="side-head">
        {list ? (
          <h1 className="side-title">Conversas</h1>
        ) : (
          <div className="side-brand">
            <BrandMark size={28} />
            <span className="side-title" title={siteName}>
              {siteName}
            </span>
            {!connected && <span className="offline-pill" role="img" title="Reconectando…" aria-label="Reconectando…" />}
          </div>
        )}
        <CreateMenu onPick={setCreate} size={list ? 20 : 18} />
      </div>
      {!list && (
        <nav className="side-actions" aria-label="Navegação principal">
          <NavRow to="/home" icon="nav-home" label="Início" onNavigate={onNavigate} />
          {callsEnabled && <NavRow to="/calls" icon="nav-calls" label="Chamadas" extra={<CallsNavBadge />} onNavigate={onNavigate} />}
          {calendarOn && <NavRow to="/calendar" icon="nav-calendar" label="Agenda" onNavigate={onNavigate} />}
          {filesOn && <NavRow to="/files" icon="nav-files" label="Arquivos" onNavigate={onNavigate} />}
          <NavRow to="/directory" icon="nav-directory" label="Diretório" onNavigate={onNavigate} />
        </nav>
      )}
      <div className="side-search">
        <div className="side-search-field">
          <Icon name="search" size={list ? 16 : 14} />
          <input
            id="sidebar-filter"
            placeholder="Buscar"
            aria-label="Buscar conversas, pessoas e canais"
            autoComplete="off"
            enterKeyHint="go"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setPendingEnter(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter) {
                e.preventDefault();
                setFilter('');
                setPendingEnter(null);
              } else if (e.key === 'Enter' && searching) {
                e.preventDefault();
                if (!openFirst() && spot.loading && spot.key) setPendingEnter(spot.key);
              } else if (e.key === 'ArrowDown') {
                const first = listRef.current?.querySelector<HTMLElement>('.side-item');
                if (first) {
                  e.preventDefault();
                  first.focus();
                }
              }
            }}
          />
          {filter ? (
            <button type="button" className="side-search-clear" aria-label="Limpar busca" onClick={() => setFilter('')}>
              <Icon name="close" size={14} />
            </button>
          ) : (
            !list && <kbd>{isMac ? '⌘ K' : 'Ctrl K'}</kbd>
          )}
        </div>
        <button
          type="button"
          className={`icon-btn ${onlyUnread ? 'on' : ''}`}
          title="Somente não lidas"
          aria-label="Somente não lidas"
          aria-pressed={onlyUnread}
          onClick={() => setOnlyUnread(!onlyUnread)}
        >
          <Icon name="filter-unread" />
        </button>
      </div>
      <nav className="side-list" aria-label="Conversas" ref={listRef} onKeyDown={onListKey}>
        {list && !searching && !onlyUnread && <ForYou />}
        {groups.map((g) => (
          <SideGroup
            key={g.title}
            title={g.title}
            items={g.items}
            searching={searching}
            big={list}
            sort={sortOf(g.title)}
            onSort={(m) => setSort(g.title, m)}
            add={g.add}
            onPick={searching ? finishSearch : undefined}
          />
        ))}
        {searching && !onlyUnread && (
          <SpotlightResults spot={spot} localCount={localCount} big={list} onDone={spotDone} hint={spotIdle ? spotlightHint(parseSpotlightQuery(filter)) : undefined} />
        )}
        {empty}
      </nav>
      {!list && !phone && <SideFoot />}
      {create && <CreateModal kind={create} onClose={() => setCreate(null)} />}
    </aside>
  );
}

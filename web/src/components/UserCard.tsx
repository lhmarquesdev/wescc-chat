import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { startCall } from '../lib/calls';
import { partyOf, useDirect, type DirectState } from '../lib/direct';
import { formatDateTime, roleLabel, roomPath, STATUS_LABEL } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';
import { canWithRoles, useSetting, useStore } from '../lib/store';
import { Icon } from './Icon';
import { Portal, Sheet, useAnchored, useEscape, useFocusTrap, useIsPhone } from './overlay';
import { Menu, Skeleton, UserAvatar, confirmDialog, useAsync } from './ui';

// Camadas que abrem a partir do cartão (menu, confirmação, avisos): um clique nelas não o fecha.
const KEEP_OPEN = '.menu, .modal-backdrop, .sheet-backdrop, .toasts';

// Cartão do usuário: popover junto do nome ou avatar clicado; no celular, folha que sobe de baixo.
export function UserCard({
  username,
  anchor,
  rid,
  roomRoles,
  onClose,
}: {
  username: string;
  anchor?: HTMLElement | null;
  rid?: string;
  roomRoles: string[];
  onClose: () => void;
}) {
  const phone = useIsPhone();
  const label = `Perfil de @${username}`;
  if (phone)
    return (
      <Sheet onClose={onClose} className="user-card-sheet" label={label}>
        <UserCardBody username={username} rid={rid} roomRoles={roomRoles} onClose={onClose} />
      </Sheet>
    );
  return (
    <UserPopover anchor={anchor} label={label} onClose={onClose}>
      <UserCardBody username={username} rid={rid} roomRoles={roomRoles} onClose={onClose} />
    </UserPopover>
  );
}

function UserPopover({ anchor, label, onClose, children }: { anchor?: HTMLElement | null; label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Nos painéis da direita o cartão abre para a esquerda; na lista de mensagens, para a direita do nome.
  const inPanel = !!anchor?.closest('.panel');
  const anch = useAnchored({ open: true, placement: inPanel ? 'left-start' : 'right-start', gap: inPanel ? 16 : 8, minHeight: 200, onHidden: onClose });
  const { setReference, setFloating } = anch;
  useLayoutEffect(() => {
    if (anchor?.isConnected) setReference(anchor);
    else {
      // Sem alvo (aberto pelo teclado ou o nó saiu da tela): perto do topo, centralizado.
      setReference({ getBoundingClientRect: () => new DOMRect(innerWidth / 2 - 160, 72, 0, 0) });
    }
  }, [anchor, setReference]);
  const setPanel = useCallback(
    (n: HTMLDivElement | null) => {
      ref.current = n;
      setFloating(n);
    },
    [setFloating],
  );
  useEscape(true, onClose);
  useFocusTrap(ref, true);
  // Escondido até ser posicionado, o cartão não recebe foco: foca assim que aparece.
  useEffect(() => {
    if (anch.positioned && ref.current && !ref.current.contains(document.activeElement)) ref.current.focus({ preventScroll: true });
  }, [anch.positioned]);
  useEffect(() => {
    const h = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || ref.current?.contains(t) || anchor?.contains(t) || t.closest?.(KEEP_OPEN)) return;
      onClose();
    };
    document.addEventListener('pointerdown', h, true);
    return () => document.removeEventListener('pointerdown', h, true);
  }, [anchor, onClose]);
  return (
    <Portal>
      <div ref={setPanel} className="user-card-pop" role="dialog" aria-label={label} tabIndex={-1} style={anch.style} data-side={anch.positioned ? anch.side : undefined}>
        {children}
      </div>
    </Portal>
  );
}

function UserCardBody({ username, rid, roomRoles, onClose }: { username: string; rid?: string; roomRoles: string[]; onClose: () => void }) {
  const navigate = useNavigate();
  const me = useStore((s) => s.me)!;
  const presence = useStore((s) => s.presence[username]);
  const callsOn = useSetting<boolean>('Calls_Enabled');
  const can = (p: string) => canWithRoles(p, roomRoles);
  const { data, loading, error, reload } = useAsync(async () => {
    const u = (await api.get('users.info', { username })).user;
    if (!rid) return { u, roles: [] as string[], inRoom: false, muted: false, roomType: undefined, notice: false };
    const info = await api.get('rooms.info', { roomId: rid }).catch(() => null);
    // Lista de membros oculta ("Ocultar a lista de membros"): quem não pode vê-la nem pergunta.
    const hidden = !!info?.room.broadcast && !can('view-broadcast-member-list');
    const r = hidden ? null : await api.get('rooms.membersOrderedByRole', { roomId: rid, filter: username, count: 5 }).catch(() => null);
    const roles: string[] = r?.members.find((m: any) => m.username === username)?.roles ?? [];
    const muted = !!info?.room.muted?.includes(username);
    return { u, roles, inRoom: !!r?.members.some((m: any) => m.username === username), muted, roomType: info?.room.t, notice: !!info?.room.notice };
  }, [username, rid]);

  const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
  const direct = useDirect();

  const openDm = async () => {
    const r = await api.post('im.create', { username });
    navigate(roomPath({ _id: r.room._id, t: 'd' }));
    onClose();
    return r.room._id as string;
  };
  const dm = () => openDm().catch(fail);
  // Ligar abre a conversa e liga dali; a regra de chamada é do servidor (pode barrar mesmo com a conversa aberta).
  const call = async () => {
    try {
      const id = await openDm();
      const info = await api.get('rooms.info', { roomId: id }).catch(() => null);
      if (info?.room.direct?.canCall === false) return useStore.getState().toast(info.room.direct.callBlockedReason ?? 'Você não pode ligar para esta pessoa.', 'error');
      await startCall(id, 'audio');
    } catch (e) {
      fail(e);
    }
  };

  if (loading && !data)
    return (
      <div className="user-card loading" role="status" aria-label="Carregando">
        <div className="user-card-head">
          <Skeleton circle height={64} />
          <div className="user-card-who">
            <Skeleton width={150} height={16} />
            <Skeleton width={90} />
          </div>
        </div>
        <Skeleton width="70%" />
        <Skeleton height={36} />
      </div>
    );
  if (error || !data)
    return (
      <div className="user-card">
        <div className="form-error">{error ?? 'Não foi possível carregar o perfil.'}</div>
      </div>
    );

  const path = data.roomType === 'p' ? 'groups' : 'channels';
  const roleAction = (role: 'Owner' | 'Moderator' | 'Leader' | 'Publisher', add: boolean) =>
    api
      .post(`${path}.${add ? 'add' : 'remove'}${role}`, { roomId: rid, userId: data.u._id })
      .then(reload)
      .catch(fail);
  const kick = async () => {
    const ok = await confirmDialog({ title: `Remover @${username} da sala?`, body: 'A pessoa deixa de ver as mensagens novas desta sala.', confirmLabel: 'Remover da sala', danger: true });
    if (ok) api.post(`${path}.kick`, { roomId: rid, userId: data.u._id }).then(onClose).catch(fail);
  };

  const self = data.u._id === me._id;
  // Abrir, só ver o histórico (bloqueada) ou nada (não dá para começar).
  const dmState = !self ? direct.state([partyOf(data.u)]) : null;
  const status = presence?.status ?? data.u.status;
  const statusText = presence?.statusText ?? data.u.statusText;
  const has = (r: string) => data.roles.includes(r);
  const moderate = !!rid && data.inRoom && !self;
  const toggles = moderate
    ? [
        can('set-owner') && { key: 'owner', icon: 'role-owner' as const, label: has('owner') ? 'Remover dono' : 'Tornar dono', run: () => roleAction('Owner', !has('owner')) },
        can('set-moderator') && { key: 'moderator', icon: 'role-moderator' as const, label: has('moderator') ? 'Remover moderador' : 'Tornar moderador', run: () => roleAction('Moderator', !has('moderator')) },
        can('set-leader') && { key: 'leader', icon: 'role-leader' as const, label: has('leader') ? 'Remover líder' : 'Tornar líder', run: () => roleAction('Leader', !has('leader')) },
        data.notice &&
          can('set-publisher') && {
            key: 'publisher',
            icon: has('publisher') ? ('remove-publisher' as const) : ('make-publisher' as const),
            label: has('publisher') ? 'Remover publicador' : 'Tornar publicador',
            run: () => roleAction('Publisher', !has('publisher')),
          },
        can('mute-user') && {
          key: 'mute',
          icon: data.muted ? ('unmute-user' as const) : ('mute-user' as const),
          label: data.muted ? 'Remover silêncio' : 'Silenciar',
          run: () => api.post(data.muted ? 'rooms.unmuteUser' : 'rooms.muteUser', { roomId: rid, userId: data.u._id }).then(reload).catch(fail),
        },
      ].filter((x): x is Exclude<typeof x, false> => !!x)
    : [];
  const admin = me.permissions.includes('view-user-administration');
  const canKick = moderate && can('remove-user');
  const hasMenu = toggles.length > 0 || admin || canKick;
  const globalRoles = (data.u.roles as string[]).filter((r) => r !== 'user');

  return (
    <div className="user-card">
      <div className="user-card-head">
        <UserAvatar username={username} size={64} status={status} />
        <div className="user-card-who">
          <h2>{data.u.name || data.u.username}</h2>
          <div className="user-card-handle">@{data.u.username}</div>
          <div className="user-card-status">
            {STATUS_LABEL[status] ?? status}
            {statusText && <span> · {statusText}</span>}
          </div>
        </div>
      </div>
      {(globalRoles.length > 0 || data.roles.length > 0) && (
        <div className="chips">
          {globalRoles.map((r) => (
            <span key={r} className="pill">
              {roleLabel(r)}
            </span>
          ))}
          {data.roles.map((r) => (
            <span key={r} className="pill accent">
              {roleLabel(r)} da sala
            </span>
          ))}
        </div>
      )}
      {data.u.bio && <div className="bio">{renderMarkdown(data.u.bio)}</div>}
      {(data.u.email || data.u.lastLogin) && (
        <ul className="user-card-meta">
          {data.u.email && (
            <li>
              <Icon name="email" size={14} />
              <a href={`mailto:${data.u.email}`}>{data.u.email}</a>
            </li>
          )}
          {data.u.lastLogin && (
            <li>
              <Icon name="last-seen" size={14} />
              Último acesso: {formatDateTime(data.u.lastLogin)}
            </li>
          )}
        </ul>
      )}
      {(dmState || hasMenu) && (
        <div className="row-actions">
          {dmState && <DirectButton st={dmState} onOpen={dm} onView={(p) => (navigate(p), onClose())} />}
          {dmState && callsOn && (
            <button type="button" className="btn" onClick={call} disabled={dmState.kind !== 'open'} title={dmState.kind !== 'open' ? dmState.text : undefined}>
              <Icon name="call-audio" />
              Ligar
            </button>
          )}
          {hasMenu && (
            <Menu
              label="Mais ações"
              trigger={
                <button type="button" className="btn user-card-more" title="Mais ações" aria-label="Mais ações">
                  <Icon name="more" />
                </button>
              }
            >
              {(close) => (
                <>
                  {toggles.map((t) => (
                    <button key={t.key} onClick={() => (close(), void t.run())}>
                      <Icon name={t.icon} />
                      {t.label}
                    </button>
                  ))}
                  {admin && (
                    <button onClick={() => (close(), navigate(`/admin/users?edit=${data.u._id}`), onClose())}>
                      <Icon name="manage-user" />
                      Administrar
                    </button>
                  )}
                  {canKick && (
                    <>
                      {(toggles.length > 0 || admin) && <hr />}
                      <button className="danger" onClick={() => (close(), void kick())}>
                        <Icon name="remove-user" />
                        Remover da sala
                      </button>
                    </>
                  )}
                </>
              )}
            </Menu>
          )}
        </div>
      )}
      {dmState && dmState.kind !== 'open' && (
        <p className="muted small direct-note">
          <Icon name="direct-blocked" size={14} />
          {dmState.text}
        </p>
      )}
    </div>
  );
}

function DirectButton({ st, onOpen, onView }: { st: DirectState; onOpen: () => void; onView: (path: string) => void }) {
  if (st.kind === 'view')
    return (
      <button type="button" className="btn primary" onClick={() => onView(st.path)}>
        <Icon name="room-dm" />
        Ver conversa
      </button>
    );
  return (
    <button type="button" className="btn primary" onClick={onOpen} disabled={st.kind === 'none'} title={st.kind === 'none' ? st.text : undefined}>
      <Icon name="room-dm" />
      Mensagem
    </button>
  );
}

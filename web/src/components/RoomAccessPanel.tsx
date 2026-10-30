// Painel "Permissões" da sala: quem pode enviar mensagens (todos ou só quem eu escolher) e o que cada pessoa pode fazer
// no canal. Em cima do RBAC: escolher quem fala dá o papel Publicador; os papéis de sala (Dono, Moderador, Líder e os
// criados em Papéis e permissões) somam permissões só nesta sala, com cadeado no que você não pode dar.
import { useMemo, useState } from 'react';
import { areaLevel, levelText, RBAC_GROUPS, rbacLabel } from '@shared/rbac';
import type { Room } from '@shared/index';
import { api, errorMessage } from '../lib/api';
import { plural, roleLabel } from '../lib/format';
import { useStore } from '../lib/store';
import { Icon } from './Icon';
import { Empty, SearchInput, Segmented, SkeletonList, Toggle, Tooltip, UserAvatar, confirmDialog, useAsync } from './ui';

interface Member {
  _id: string;
  username: string;
  name?: string;
  status?: string;
  active: boolean;
  bot: boolean;
  roomRoles: string[];
  globalRoles: string[];
  muted: boolean;
  canPost: boolean;
  postsByGlobal: boolean;
  roomPermissions: string[];
}
interface RoomRole {
  _id: string;
  builtin: boolean;
  permissions: string[];
  canPost: boolean;
  lock: 'perm' | 'superior' | null;
}
interface Access {
  room: { _id: string; readOnly: boolean; notice: boolean; reactWhenReadOnly: boolean };
  can: { mode: boolean; react: boolean; mute: boolean; posters: boolean };
  roles: RoomRole[];
  members: Member[];
  total: number;
}

type Tab = 'speak' | 'people';
const ORDER = ['owner', 'moderator', 'leader', 'publisher'];
const ROOM_AREAS = RBAC_GROUPS.find((g) => g.id === 'room')!.areas;
const LOCK: Record<string, string> = { perm: 'Você não pode dar nem tirar este papel nesta sala.', superior: 'Este papel dá permissões que você não tem.' };

const toast = (t: string, kind?: 'success' | 'error') => useStore.getState().toast(t, kind);
const fail = (e: unknown) => toast(errorMessage(e), 'error');
const byName = (a: Member, b: Member) => (a.name || a.username).localeCompare(b.name || b.username, 'pt-BR');
// Por que a pessoa fala mesmo sem estar na lista: papel global ou um papel de sala que já escreve.
const speaksBy = (m: Member, roles: RoomRole[]) => (m.postsByGlobal ? 'Papel global' : m.roomRoles.filter((r) => r !== 'publisher' && roles.find((x) => x._id === r)?.canPost).map(roleLabel)[0] ?? null);

export function RoomAccessPanel({ room, onChanged }: { room: Room; onChanged: () => void }) {
  const [tab, setTab] = useState<Tab>('speak');
  const [filter, setFilter] = useState('');
  const data = useAsync(() => api.get('rooms.access', { roomId: room._id, filter }) as Promise<Access>, [room._id, filter, room.ro, room.notice, (room as any).muted?.join()]);
  const a = data.data;
  if (data.loading && !a) return <SkeletonList />;
  if (data.error && !a)
    return (
      <Empty icon="rbac-lock" title="Sem acesso às permissões">
        {data.error}
      </Empty>
    );
  if (!a) return null;
  const reload = () => (data.reload(), onChanged());
  return (
    <div className="room-access">
      <div className="panel-filters">
        <Segmented<Tab>
          label="Permissões"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'speak', label: 'Quem fala', icon: 'rbac-chat' },
            { id: 'people', label: 'Pessoas', icon: 'panel-members' },
          ]}
        />
      </div>
      <div key={tab} className="room-access-panel">
        {tab === 'speak' ? <Speak a={a} filter={filter} setFilter={setFilter} onDone={reload} /> : <People a={a} filter={filter} setFilter={setFilter} onDone={reload} />}
      </div>
    </div>
  );
}

// ---------- Quem fala ----------

function Speak({ a, filter, setFilter, onDone }: { a: Access; filter: string; setFilter: (v: string) => void; onDone: () => void }) {
  const chosen = a.room.readOnly;
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const members = useMemo(() => [...a.members].sort(byName), [a.members]);
  const speaking = members.filter((m) => m.canPost || (!m.muted && pending[m._id])).length;
  const changes = Object.entries(pending).filter(([id, on]) => on !== a.members.find((m) => m._id === id)?.roomRoles.includes('publisher'));

  const setMode = async (next: boolean) => {
    if (next === chosen) return;
    if (!next) {
      const yes = await confirmDialog({ title: 'Liberar o canal para todos?', body: 'Todos os membros voltam a enviar mensagens. Quem foi escolhido continua com o papel Publicador.', confirmLabel: 'Liberar' });
      if (!yes) return;
    }
    api
      .post('rooms.saveRoomSettings', { rid: a.room._id, readOnly: next })
      .then(() => (toast(next ? 'Agora só quem você escolher envia mensagens.' : 'Todos os membros podem enviar mensagens.', 'success'), onDone()))
      .catch(fail);
  };
  const save = async () => {
    setBusy(true);
    try {
      const add = changes.filter(([, on]) => on).map(([id]) => id);
      const remove = changes.filter(([, on]) => !on).map(([id]) => id);
      await api.post('rooms.access.setPosters', { roomId: a.room._id, add, remove });
      toast(`${plural(changes.length, 'pessoa atualizada', 'pessoas atualizadas')}.`, 'success');
      setPending({});
      onDone();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="access-card">
        <h3 className="access-title">
          <i aria-hidden="true" />
          Quem pode enviar mensagens
        </h3>
        {a.room.notice ? (
          <p className="access-hint">Canal de avisos: só quem está marcado abaixo publica; os outros leem.</p>
        ) : (
          <div className="access-modes" role="radiogroup" aria-label="Quem pode enviar mensagens">
            {[
              { on: false, icon: 'panel-members' as const, title: 'Todos os membros', hint: 'Qualquer pessoa do canal envia, menos as silenciadas.' },
              { on: true, icon: 'rbac-lock' as const, title: 'Só quem eu escolher', hint: 'Os outros leem. Donos e moderadores sempre enviam.' },
            ].map((o) => (
              <button
                key={String(o.on)}
                type="button"
                role="radio"
                aria-checked={chosen === o.on}
                aria-disabled={!a.can.mode || undefined}
                className={chosen === o.on ? 'access-mode on' : 'access-mode'}
                onClick={() => a.can.mode && void setMode(o.on)}
              >
                <Icon name={o.icon} size={18} />
                <span>
                  <strong>{o.title}</strong>
                  <span>{o.hint}</span>
                </span>
                <span className="access-radio" aria-hidden="true" />
              </button>
            ))}
            {!a.can.mode && <p className="access-hint">Só o dono do canal muda esta opção.</p>}
          </div>
        )}
        {(chosen || a.room.notice) && a.can.react && (
          <Toggle
            checked={a.room.reactWhenReadOnly}
            onChange={(v) =>
              api
                .post('rooms.saveRoomSettings', { rid: a.room._id, reactWhenReadOnly: v })
                .then(onDone)
                .catch(fail)
            }
            label="Quem não envia pode reagir"
          />
        )}
      </section>
      {(chosen || a.room.notice) && (
        <section className="access-card flush">
          <h3 className="access-title">
            <i aria-hidden="true" />
            Podem enviar
            <span className="pill head-count">{speaking}</span>
          </h3>
          <div className="access-search">
            <SearchInput value={filter} onChange={setFilter} placeholder="Buscar membros" />
          </div>
          <ul className="access-list">
            {members.map((m) => {
              const by = speaksBy(m, a.roles);
              const on = by ? true : pending[m._id] ?? m.roomRoles.includes('publisher');
              const locked = !!by || !a.can.posters;
              const tip = by ? `Já envia: ${by}.` : !a.can.posters ? 'Você não pode escolher quem envia.' : null;
              const row = (
                <label className={`access-person${m.muted ? ' muted' : ''}${pending[m._id] !== undefined ? ' changed' : ''}`}>
                  <input type="checkbox" checked={on} disabled={locked} onChange={(e) => setPending({ ...pending, [m._id]: e.target.checked })} />
                  <UserAvatar username={m.username} size={28} status={m.status} />
                  <span className="access-who">
                    <span>{m.name || m.username}</span>
                    <span>
                      @{m.username}
                      {by && ` · ${by}`}
                      {m.muted && ' · silenciado'}
                    </span>
                  </span>
                  {locked && <Icon name="rbac-lock" size={12} />}
                </label>
              );
              return <li key={m._id}>{tip ? <Tooltip label={tip}>{row}</Tooltip> : row}</li>;
            })}
          </ul>
          {a.total > a.members.length && <p className="access-hint pad">Mostrando {a.members.length} de {a.total}. Busque pelo nome para achar os outros.</p>}
        </section>
      )}
      {changes.length > 0 && (
        <div className="access-save" role="status">
          <span>{plural(changes.length, 'alteração', 'alterações')}</span>
          <button type="button" className="btn small" onClick={() => setPending({})}>
            Descartar
          </button>
          <button type="button" className="btn small primary" disabled={busy} aria-busy={busy || undefined} onClick={() => void save()}>
            Salvar
          </button>
        </div>
      )}
    </>
  );
}

// ---------- Pessoas ----------

function People({ a, filter, setFilter, onDone }: { a: Access; filter: string; setFilter: (v: string) => void; onDone: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const members = useMemo(() => [...a.members].sort((x, y) => rank(x) - rank(y) || byName(x, y)), [a.members]);
  return (
    <>
      <div className="access-search top">
        <SearchInput value={filter} onChange={setFilter} placeholder="Buscar membros" />
      </div>
      {!members.length ? (
        <Empty icon="panel-members" title="Ninguém encontrado" />
      ) : (
        <ul className="access-people">
          {members.map((m) => (
            <li key={m._id} className={open === m._id ? 'open' : undefined}>
              <button type="button" className="access-row" aria-expanded={open === m._id} onClick={() => setOpen(open === m._id ? null : m._id)}>
                <UserAvatar username={m.username} size={32} status={m.status} />
                <span className="access-who">
                  <span>{m.name || m.username}</span>
                  <span>
                    {m.roomRoles.length ? [...m.roomRoles].sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y)).map(roleLabel).join(' · ') : 'Membro'}
                  </span>
                </span>
                {m.muted ? (
                  <span className="pill warn tag">Silenciado</span>
                ) : !m.canPost ? (
                  <span className="pill tag">Só lê</span>
                ) : null}
                <Icon name="chevron-down" size={14} />
              </button>
              {open === m._id && <PersonDetail key={m.roomRoles.join()} a={a} m={m} onDone={onDone} />}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const rank = (m: Member) => (m.roomRoles.includes('owner') ? 0 : m.roomRoles.includes('moderator') ? 1 : m.roomRoles.length ? 2 : 3);

function PersonDetail({ a, m, onDone }: { a: Access; m: Member; onDone: () => void }) {
  const me = useStore((s) => s.me?._id);
  const [roles, setRoles] = useState<string[]>(m.roomRoles);
  const [busy, setBusy] = useState(false);
  const dirty = [...roles].sort().join() !== [...m.roomRoles].sort().join();
  const list = [...a.roles].sort((x, y) => Number(!x.builtin) - Number(!y.builtin) || ORDER.indexOf(x._id) - ORDER.indexOf(y._id) || roleLabel(x._id).localeCompare(roleLabel(y._id), 'pt-BR'));
  const held = new Set(m.roomPermissions);
  const save = async () => {
    setBusy(true);
    try {
      await api.post('rooms.access.setRoles', { roomId: a.room._id, userId: m._id, roles });
      toast(`Papéis de @${m.username} no canal salvos.`, 'success');
      onDone();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const mute = (v: boolean) =>
    api
      .post(v ? 'rooms.muteUser' : 'rooms.unmuteUser', { roomId: a.room._id, userId: m._id })
      .then(() => (toast(v ? `@${m.username} silenciado no canal.` : `@${m.username} pode falar de novo.`, 'success'), onDone()))
      .catch(fail);
  return (
    <div className="access-detail">
      <span className="access-label">Papéis neste canal</span>
      <div className="access-roles">
        {list.map((r) => {
          const on = roles.includes(r._id);
          const lock = r.lock ? LOCK[r.lock] : null;
          const chip = (
            <button
              type="button"
              className={`chip selectable${on ? ' on' : ''}${lock ? ' disabled' : ''}`}
              aria-pressed={on}
              aria-disabled={!!lock || undefined}
              onClick={() => !lock && setRoles(on ? roles.filter((x) => x !== r._id) : [...roles, r._id])}
            >
              {lock && <Icon name="rbac-lock" size={12} />}
              {roleLabel(r._id)}
            </button>
          );
          return lock ? (
            <Tooltip key={r._id} label={lock}>
              {chip}
            </Tooltip>
          ) : (
            <span key={r._id}>{chip}</span>
          );
        })}
      </div>
      {dirty && (
        <div className="access-actions">
          <button type="button" className="btn small" onClick={() => setRoles(m.roomRoles)}>
            Descartar
          </button>
          <button type="button" className="btn small primary" disabled={busy} aria-busy={busy || undefined} onClick={() => void save()}>
            Salvar papéis
          </button>
        </div>
      )}
      {a.can.mute && m._id !== me && (
        <Toggle checked={m.muted} onChange={mute} label="Silenciado" description="Não envia mensagens neste canal, mesmo que tenha um papel que envia." />
      )}
      <span className="access-label">O que pode neste canal</span>
      <ul className="access-effective">
        <li className={m.canPost ? 'yes' : 'no'}>
          <Icon name={m.canPost ? 'check' : 'close'} size={12} />
          Enviar mensagens
        </li>
        {ROOM_AREAS.map((area) => {
          const keys = [...area.levels.flatMap((l) => l.keys), ...area.extras].filter((k) => held.has(k) && k !== 'post-readonly');
          if (!keys.length) return null;
          const lv = areaLevel(area, held);
          return (
            <li key={area.id} className="yes">
              <Icon name="check" size={12} />
              <span>
                <strong>{area.label}</strong>
                <span className="muted">{area.levels.length && lv.kind !== 'custom' ? levelText(area, lv) : keys.map(rbacLabel).join(' · ')}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {dirty && <p className="access-hint">A lista acima mostra o que está salvo.</p>}
    </div>
  );
}

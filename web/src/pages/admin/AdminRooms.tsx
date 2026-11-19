import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, roomIconName, roomPath } from '../../lib/format';
import { useStore } from '../../lib/store';
import { UserPicker, type PickedUser } from '../../components/Pickers';
import { Icon } from '../../components/Icon';
import { Empty, Field, Modal, Pager, SearchInput, SkeletonList, SkeletonTable, Toggle, confirmDialog, useAsync, ThLabel } from '../../components/ui';
import { PageHead, RoomCell, TableWrap, num } from './parts';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const ok = (t: string) => useStore.getState().toast(t);

const TYPE_LABEL: Record<string, string> = { c: 'Canal público', p: 'Grupo privado', d: 'Mensagem direta' };

export function AdminRooms() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('');
  const [types, setTypes] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const [count, setCount] = useState(25);
  const [edit, setEdit] = useState<any>(null);
  const { data, loading, reload } = useAsync(() => api.get('rooms.adminRooms', { filter, types, offset, count }), [filter, types.join(), offset, count]);
  const toggleType = (t: string) => (setTypes(types.includes(t) ? types.filter((x) => x !== t) : [...types, t]), setOffset(0));
  const rooms: any[] = data?.rooms ?? [];
  return (
    <>
      <PageHead title="Salas" count={data?.total}>
        <SearchInput value={filter} onChange={(v) => (setFilter(v), setOffset(0))} placeholder="Buscar salas" />
        <div className="chips" role="group" aria-label="Tipo de sala">
          {Object.entries(TYPE_LABEL).map(([t, l]) => (
            <label key={t} className={`chip selectable ${types.includes(t) ? 'on' : ''}`}>
              <input type="checkbox" hidden checked={types.includes(t)} onChange={() => toggleType(t)} />
              {l}
            </label>
          ))}
        </div>
      </PageHead>
      {loading && !data ? (
        <SkeletonTable rows={8} cols={5} />
      ) : !rooms.length ? (
        <Empty
          icon="search"
          title="Nenhuma sala encontrada"
          action={
            (filter || types.length > 0) && (
              <button className="btn" onClick={() => (setFilter(''), setTypes([]), setOffset(0))}>
                Limpar filtros
              </button>
            )
          }
        >
          Confira a grafia ou mude os tipos escolhidos.
        </Empty>
      ) : (
        <TableWrap>
          <table className="table stack kv">
            <thead>
              <tr>
                <th>
                  <ThLabel>Nome</ThLabel>
                </th>
                <th className="num">
                  <ThLabel>Membros</ThLabel>
                </th>
                <th className="num col-md">
                  <ThLabel>Mensagens</ThLabel>
                </th>
                <th className="col-lg">
                  <ThLabel>Criada por</ThLabel>
                </th>
                <th className="col-xl">
                  <ThLabel>Criada em</ThLabel>
                </th>
                <th className="actions-col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rooms.map((r: any) => (
                <tr key={r._id} className="clickable" onClick={() => setEdit(r)}>
                  <td>
                    <RoomCell
                      icon={<Icon name={roomIconName(r)} />}
                      name={
                        <>
                          {r.fname || r.name || r.usernames?.join(', ')}
                          {r.default && <span className="pill tag">Padrão</span>}
                          {r.featured && <span className="pill accent tag">Destaque</span>}
                          {r.archived && <span className="pill tag">Arquivada</span>}
                          {r.encrypted && <span className="pill tag">Criptografada</span>}
                        </>
                      }
                      sub={r.teamMain ? 'Time' : r.prid ? 'Discussão' : TYPE_LABEL[r.t]}
                    />
                  </td>
                  <td className="num" data-label="Membros">
                    {num(r.usersCount)}
                  </td>
                  <td className="num col-md" data-label="Mensagens">
                    {num(r.msgs)}
                  </td>
                  <td className="opt nowrap col-lg" data-label="Criada por">
                    {r.u?.username ? `@${r.u.username}` : <span className="muted">—</span>}
                  </td>
                  <td className="muted nowrap opt col-xl" data-label="Criada em">
                    {formatDateTime(r.ts)}
                  </td>
                  <td className="actions-col">
                    <div className="row-actions">
                      <button type="button" className="btn small ghost" onClick={(e) => (e.stopPropagation(), navigate(roomPath(r)))}>
                        <Icon name="open-external" />
                        Abrir
                      </button>
                      <button type="button" className="btn small ghost" onClick={(e) => (e.stopPropagation(), setEdit(r))}>
                        <Icon name="edit" />
                        Editar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {data && data.total > 0 && <Pager offset={offset} count={count} total={data.total} onChange={setOffset} sizes={[25, 50, 100]} onCountChange={(n) => (setCount(n), setOffset(0))} />}
      {edit && <RoomEdit room={edit} onClose={() => setEdit(null)} onSaved={reload} />}
    </>
  );
}

function RoomEdit({ room, onClose, onSaved }: { room: any; onClose: () => void; onSaved: () => void }) {
  const navigate = useNavigate();
  const [f, setF] = useState({
    roomName: room.prid ? room.fname : room.name,
    roomTopic: room.topic ?? '',
    roomDescription: room.description ?? '',
    roomAnnouncement: room.announcement ?? '',
    roomType: room.t,
    readOnly: room.ro,
    notice: !!room.notice,
    broadcast: !!room.broadcast,
    default: room.default,
    featured: room.featured,
  });
  const [add, setAdd] = useState<PickedUser[]>([]);
  const [nameError, setNameError] = useState('');
  const [busy, setBusy] = useState(false);
  // Donos da sala: começam com os de hoje; tirar e pôr gente aqui troca o dono (ex.: quando o dono sai da empresa).
  const manageOwners = room.t === 'c' || room.t === 'p';
  const prefix = room.t === 'p' ? 'groups' : 'channels';
  const info = useAsync(() => (manageOwners ? api.get('rooms.adminRooms.getRoom', { rid: room._id }) : Promise.resolve(null)), [room._id]);
  const [owners, setOwners] = useState<PickedUser[] | null>(null);
  const currentOwners: PickedUser[] = info.data?.owners ?? [];
  const shownOwners = owners ?? currentOwners;
  const saveOwners = async () => {
    if (!owners) return;
    const added = owners.filter((o) => !currentOwners.some((c) => c._id === o._id));
    const removed = currentOwners.filter((c) => !owners.some((o) => o._id === c._id));
    // Primeiro os novos donos (quem não está na sala entra), depois saem os antigos: a sala nunca fica sem dono.
    for (const u of added) {
      try {
        await api.post(`${prefix}.addOwner`, { roomId: room._id, userId: u._id });
      } catch (e: any) {
        if (e?.errorType !== 'error-user-not-in-room') throw e;
        await api.post('rooms.adminRooms.addUser', { roomId: room._id, userId: u._id });
        await api.post(`${prefix}.addOwner`, { roomId: room._id, userId: u._id });
      }
    }
    for (const u of removed) await api.post(`${prefix}.removeOwner`, { roomId: room._id, userId: u._id });
  };
  const save = async () => {
    if (room.t !== 'd' && !String(f.roomName ?? '').trim()) return setNameError('Informe o nome da sala.');
    if (manageOwners && owners && !owners.length) return fail(new Error('A sala precisa de pelo menos um dono.'));
    setBusy(true);
    try {
      const body: any = { rid: room._id, ...f };
      if (room.t === 'd') {
        delete body.roomName;
        delete body.roomType;
      }
      // Canal de avisos é sempre somente leitura: o servidor cuida de ro (e recusa readOnly false junto).
      if (f.notice) delete body.readOnly;
      if (room.t !== 'c' && room.t !== 'p') {
        delete body.notice;
        delete body.broadcast;
      }
      await api.post('rooms.saveRoomSettings', body);
      for (const u of add) await api.post('rooms.adminRooms.addUser', { roomId: room._id, userId: u._id });
      await saveOwners();
      ok('Sala salva.');
      onSaved();
      onClose();
    } catch (e) {
      fail(e);
      // Parte pode ter sido gravada (as configurações antes dos donos): a lista mostra o que ficou.
      onSaved();
    } finally {
      setBusy(false);
    }
  };
  const archive = async () => {
    const archiving = !room.archived;
    if (archiving) {
      const yes = await confirmDialog({
        title: `Arquivar ${room.fname || room.name}?`,
        body: 'Ninguém escreve mais na sala; o histórico continua visível para quem é membro. Dá para desarquivar depois.',
        confirmLabel: 'Arquivar',
      });
      if (!yes) return;
    }
    setBusy(true);
    try {
      await api.post(`${prefix}.${archiving ? 'archive' : 'unarchive'}`, { roomId: room._id });
      ok(archiving ? 'Sala arquivada.' : 'Sala desarquivada.');
      onSaved();
      onClose();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const yes = await confirmDialog({
      title: `Excluir ${room.fname || room.name || 'a sala'}?`,
      body: 'A sala e todas as mensagens dela são apagadas. Não dá para desfazer.',
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!yes) return;
    (room.teamMain ? api.post('teams.delete', { teamId: room.teamId }) : api.post('rooms.delete', { roomId: room._id }))
      .then(() => (ok(room.teamMain ? 'Time excluído.' : 'Sala excluída.'), onSaved(), onClose()))
      .catch(fail);
  };
  return (
    <Modal
      title={`Sala ${room.fname || room.name || ''}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn danger left" disabled={busy} onClick={remove}>
            <Icon name="delete" />
            Excluir
          </button>
          {manageOwners && (
            <button className="btn" disabled={busy} onClick={archive}>
              <Icon name={room.archived ? 'unarchive' : 'archive'} />
              {room.archived ? 'Desarquivar' : 'Arquivar'}
            </button>
          )}
          <button className="btn" onClick={() => navigate(roomPath(room))}>
            <Icon name="open-external" />
            Abrir
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            Salvar
          </button>
        </>
      }
    >
      <div className="form">
        {room.t !== 'd' && (
          <Field label="Nome" error={nameError || undefined}>
            <input value={f.roomName} onChange={(e) => (setF({ ...f, roomName: e.target.value }), setNameError(''))} />
          </Field>
        )}
        <Field label="Tópico">
          <input value={f.roomTopic} onChange={(e) => setF({ ...f, roomTopic: e.target.value })} />
        </Field>
        <Field label="Descrição">
          <textarea value={f.roomDescription} onChange={(e) => setF({ ...f, roomDescription: e.target.value })} />
        </Field>
        <Field label="Anúncio">
          <textarea value={f.roomAnnouncement} onChange={(e) => setF({ ...f, roomAnnouncement: e.target.value })} />
        </Field>
        {room.t !== 'd' && (
          <div className="toggle-list">
            <Toggle checked={f.roomType === 'p'} onChange={(v) => setF({ ...f, roomType: v ? 'p' : 'c' })} label="Privada" />
            {(room.t === 'c' || room.t === 'p') && (
              <>
                {/* Desligar um canal de avisos libera a escrita e mostra os membros (dá para religar aqui); numa sala que não
                    era de avisos, ligar e desligar antes de salvar volta ao que estava. */}
                <Toggle
                  checked={f.notice}
                  onChange={(v) => {
                    const leaving = !v && !!room.notice;
                    setF({ ...f, notice: v, readOnly: leaving ? false : f.readOnly, broadcast: leaving ? false : !!room.broadcast });
                  }}
                  label="Canal de avisos"
                />
                {(f.notice || room.broadcast) && <Toggle checked={f.broadcast} onChange={(v) => setF({ ...f, broadcast: v })} label="Ocultar a lista de membros" />}
              </>
            )}
            {!f.notice && <Toggle checked={f.readOnly} onChange={(v) => setF({ ...f, readOnly: v })} label="Somente leitura" />}
            <Toggle checked={f.default} onChange={(v) => setF({ ...f, default: v })} label="Padrão para novos usuários" />
            <Toggle checked={f.featured} onChange={(v) => setF({ ...f, featured: v })} label="Destaque" />
          </div>
        )}
        {room.t !== 'd' && (
          <Field label="Adicionar usuários">
            <UserPicker value={add} onChange={setAdd} />
          </Field>
        )}
        {manageOwners && (
          <Field label="Donos" hint="Quem é dono gerencia a sala. Para trocar o dono, adicione a nova pessoa e tire a antiga; quem não está na sala entra nela.">
            {info.loading && !info.data ? <SkeletonList n={1} /> : <UserPicker value={shownOwners} onChange={setOwners} placeholder="Adicionar dono" />}
          </Field>
        )}
      </div>
    </Modal>
  );
}

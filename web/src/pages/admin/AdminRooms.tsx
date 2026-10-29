import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, roomIconName, roomPath } from '../../lib/format';
import { useStore } from '../../lib/store';
import { UserPicker, type PickedUser } from '../../components/Pickers';
import { Icon } from '../../components/Icon';
import { Empty, Field, Modal, Pager, SearchInput, SkeletonTable, Toggle, confirmDialog, useAsync } from '../../components/ui';
import { PageHead, RoomCell, TableWrap, num } from './parts';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');

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
      <PageHead title="Salas" count={data?.total} />
      <div className="filters admin-filters">
        <SearchInput value={filter} onChange={(v) => (setFilter(v), setOffset(0))} placeholder="Buscar salas" />
        <div className="chips" role="group" aria-label="Tipo de sala">
          {Object.entries(TYPE_LABEL).map(([t, l]) => (
            <label key={t} className={`chip selectable ${types.includes(t) ? 'on' : ''}`}>
              <input type="checkbox" hidden checked={types.includes(t)} onChange={() => toggleType(t)} />
              {l}
            </label>
          ))}
        </div>
      </div>
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
                <th>Nome</th>
                <th className="num">Membros</th>
                <th className="num col-md">Mensagens</th>
                <th className="col-lg">Criada por</th>
                <th className="col-xl">Criada em</th>
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
  const save = async () => {
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
      onSaved();
      onClose();
    } catch (e) {
      fail(e);
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
    (room.teamMain ? api.post('teams.delete', { teamId: room.teamId }) : api.post('rooms.delete', { roomId: room._id })).then(() => (onSaved(), onClose())).catch(fail);
  };
  return (
    <Modal
      title={`Sala ${room.fname || room.name || ''}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn danger left" onClick={remove}>
            <Icon name="delete" />
            Excluir
          </button>
          <button className="btn" onClick={() => navigate(roomPath(room))}>
            <Icon name="open-external" />
            Abrir
          </button>
          <button className="btn primary" onClick={save}>
            Salvar
          </button>
        </>
      }
    >
      <div className="form">
        {room.t !== 'd' && (
          <Field label="Nome">
            <input value={f.roomName} onChange={(e) => setF({ ...f, roomName: e.target.value })} />
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
      </div>
    </Modal>
  );
}

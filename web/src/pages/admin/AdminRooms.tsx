import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, roomIcon, roomPath } from '../../lib/format';
import { useStore } from '../../lib/store';
import { UserPicker, type PickedUser } from '../../components/Pickers';
import { Field, Modal, Pager, Spinner, Toggle, useAsync } from '../../components/ui';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');

const TYPE_LABEL: Record<string, string> = { c: 'Canal público', p: 'Grupo privado', d: 'Mensagem direta', l: 'Atendimento' };

export function AdminRooms() {
  const [filter, setFilter] = useState('');
  const [types, setTypes] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const [edit, setEdit] = useState<any>(null);
  const { data, loading, reload } = useAsync(() => api.get('rooms.adminRooms', { filter, types, offset, count: 25 }), [filter, types.join(), offset]);
  const toggleType = (t: string) => (setTypes(types.includes(t) ? types.filter((x) => x !== t) : [...types, t]), setOffset(0));
  return (
    <>
      <h1>Salas</h1>
      <div className="filters">
        <input placeholder="Buscar salas" value={filter} onChange={(e) => (setFilter(e.target.value), setOffset(0))} />
        {Object.entries(TYPE_LABEL).map(([t, l]) => (
          <label key={t} className={`chip selectable ${types.includes(t) ? 'on' : ''}`}>
            <input type="checkbox" hidden checked={types.includes(t)} onChange={() => toggleType(t)} />
            {l}
          </label>
        ))}
      </div>
      {loading ? (
        <Spinner />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Tipo</th>
              <th>Membros</th>
              <th>Mensagens</th>
              <th>Criada por</th>
              <th>Criada em</th>
            </tr>
          </thead>
          <tbody>
            {data?.rooms.map((r: any) => (
              <tr key={r._id} className="clickable" onClick={() => setEdit(r)}>
                <td>
                  {roomIcon(r)} {r.fname || r.name || r.usernames?.join(', ')}
                  {r.default && <span className="pill">padrão</span>}
                  {r.featured && <span className="pill">destaque</span>}
                  {r.archived && <span className="pill">arquivada</span>}
                </td>
                <td>{r.teamMain ? 'Time' : r.prid ? 'Discussão' : TYPE_LABEL[r.t]}</td>
                <td>{r.usersCount}</td>
                <td>{r.msgs}</td>
                <td>{r.u?.username ?? '—'}</td>
                <td className="muted">{formatDateTime(r.ts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && <Pager offset={offset} count={25} total={data.total} onChange={setOffset} />}
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
  return (
    <Modal
      title={`Sala ${room.fname || room.name || ''}`}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn danger left"
            onClick={() =>
              confirm('Excluir a sala e todas as mensagens?') &&
              (room.teamMain ? api.post('teams.delete', { teamId: room.teamId }) : api.post('rooms.delete', { roomId: room._id })).then(() => (onSaved(), onClose())).catch(fail)
            }
          >
            Excluir
          </button>
          <button className="btn" onClick={() => navigate(roomPath(room))}>
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
          <>
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
          </>
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

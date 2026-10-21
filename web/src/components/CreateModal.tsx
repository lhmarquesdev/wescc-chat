import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { roomPath } from '../lib/format';
import { usePermission } from '../lib/store';
import { RoomPicker, UserPicker, type PickedRoom, type PickedUser } from './Pickers';
import { Field, Modal, Toggle } from './ui';

export type CreateKind = 'dm' | 'channel' | 'team' | 'discussion';

const TITLES: Record<CreateKind, string> = {
  dm: 'Nova mensagem direta',
  channel: 'Criar canal',
  team: 'Criar time',
  discussion: 'Criar discussão',
};

export function CreateModal({ kind, onClose, parent, pmid }: { kind: CreateKind; onClose: () => void; parent?: PickedRoom; pmid?: string }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setPrivate] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  const [broadcast, setBroadcast] = useState(false);
  const [members, setMembers] = useState<PickedUser[]>([]);
  const [parentRoom, setParentRoom] = useState<PickedRoom | null>(parent ?? null);
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const canPublic = usePermission('create-c');
  const canPrivate = usePermission('create-p');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const usernames = members.map((m) => m.username);
      if (kind === 'dm') {
        const r = await api.post('im.create', { usernames: usernames.join(',') });
        navigate(roomPath({ _id: r.room._id, t: 'd' }));
      } else if (kind === 'channel') {
        const prefix = isPrivate ? 'groups' : 'channels';
        const r = await api.post(`${prefix}.create`, { name, members: usernames, readOnly, extraData: { topic, broadcast } });
        const room = r.channel ?? r.group;
        navigate(roomPath(room));
      } else if (kind === 'team') {
        const r = await api.post('teams.create', { name, type: isPrivate ? 1 : 0, members: usernames, room: { readOnly, extraData: { topic } } });
        navigate(roomPath({ _id: r.team.roomId, t: isPrivate ? 'p' : 'c' }));
      } else {
        if (!parentRoom) throw new Error('Escolha a sala de origem.');
        const r = await api.post('rooms.createDiscussion', { prid: parentRoom._id, pmid, t_name: name, users: usernames, reply: reply || undefined });
        navigate(roomPath(r.discussion));
      }
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const nameValid = kind === 'dm' ? members.length > 0 : kind === 'discussion' ? name.trim().length > 0 && !!parentRoom : /^[0-9a-zA-ZÀ-ſ._-]{1,64}$/.test(name);

  return (
    <Modal
      title={TITLES[kind]}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!nameValid || busy} onClick={submit}>
            {kind === 'dm' ? 'Abrir conversa' : 'Criar'}
          </button>
        </>
      }
    >
      {kind === 'discussion' && (
        <Field label="Sala ou grupo de origem">
          <RoomPicker value={parentRoom} onChange={setParentRoom} />
        </Field>
      )}
      {kind !== 'dm' && (
        <Field label="Nome" hint={kind === 'discussion' ? undefined : 'Sem espaços. Use letras, números, ponto, hífen ou sublinhado.'}>
          <input autoFocus value={name} onChange={(e) => setName(kind === 'discussion' ? e.target.value : e.target.value.replace(/\s/g, '-'))} />
        </Field>
      )}
      {(kind === 'channel' || kind === 'team') && (
        <>
          <Field label="Tópico">
            <input value={topic} onChange={(e) => setTopic(e.target.value)} />
          </Field>
          <Toggle
            checked={isPrivate}
            onChange={(v) => setPrivate(v ? canPrivate || !canPublic : !canPublic)}
            label={isPrivate ? 'Privado: só convidados podem entrar' : 'Público: qualquer pessoa pode entrar'}
          />
          <Toggle checked={readOnly} onChange={setReadOnly} label="Somente leitura" />
          {kind === 'channel' && <Toggle checked={broadcast} onChange={setBroadcast} label="Transmissão (só donos e moderadores escrevem; respostas vão para DM)" />}
        </>
      )}
      <Field label={kind === 'dm' ? 'Pessoas (até 8)' : 'Adicionar membros'}>
        <UserPicker value={members} onChange={setMembers} />
      </Field>
      {kind === 'discussion' && (
        <Field label="Primeira mensagem (opcional)">
          <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3} />
        </Field>
      )}
      {error && <div className="form-error">{error}</div>}
    </Modal>
  );
}

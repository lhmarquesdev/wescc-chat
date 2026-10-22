import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { partyOf, useDirect, type DirectState } from '../lib/direct';
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

const blockedText = (st: DirectState) => (st.kind === 'none' ? st.text : undefined);

export function CreateModal({ kind, onClose, parent, pmid }: { kind: CreateKind; onClose: () => void; parent?: PickedRoom; pmid?: string }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setPrivate] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  const [notice, setNotice] = useState(false);
  const [reactions, setReactions] = useState(true);
  const [ack, setAck] = useState(true);
  const [hideMembers, setHideMembers] = useState(false);
  const [members, setMembers] = useState<PickedUser[]>([]);
  const [parentRoom, setParentRoom] = useState<PickedRoom | null>(parent ?? null);
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const canPublic = usePermission('create-c');
  const canPrivate = usePermission('create-p');
  const direct = useDirect();
  // Conversa direta: a mesma regra do servidor, avaliada a cada pessoa escolhida. Uma DM que já existe com essas
  // pessoas é só reaberta; se ela estiver bloqueada para envio, o botão leva ao histórico.
  const dmState = kind === 'dm' && members.length ? direct.state(members.map(partyOf)) : null;
  const dmBlocked = dmState?.kind === 'none';
  // A sala nasce privada (grupo, time privado, discussão fora de um canal público): quem tem papel restrito não traz
  // outra pessoa restrita para ela.
  const privateRoom = kind === 'discussion' ? !!parentRoom && parentRoom.t !== 'c' : (kind === 'channel' || kind === 'team') && isPrivate;

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const usernames = members.map((m) => m.username);
      if (dmState?.kind === 'view') {
        navigate(dmState.path);
      } else if (kind === 'dm') {
        const r = await api.post('im.create', { usernames: usernames.join(',') });
        navigate(roomPath({ _id: r.room._id, t: 'd' }));
      } else if (kind === 'channel') {
        const prefix = isPrivate ? 'groups' : 'channels';
        const extraData = { topic, notice, noticeAck: notice && ack, reactWhenReadOnly: notice && reactions, broadcast: notice && hideMembers };
        const r = await api.post(`${prefix}.create`, { name, members: usernames, extraData });
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
          <button className="btn primary" disabled={!nameValid || busy || dmBlocked} onClick={submit}>
            {dmState?.kind === 'view' ? 'Ver conversa' : kind === 'dm' ? 'Abrir conversa' : 'Criar'}
          </button>
        </>
      }
    >
      <div className="form">
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
            {kind === 'team' && <Toggle checked={readOnly} onChange={setReadOnly} label="Somente leitura" />}
          </>
        )}
        {kind === 'channel' && (
          <div className="field" role="radiogroup" aria-label="Tipo de canal">
            <span className="field-label">Tipo de canal</span>
            <div className="radio-cards">
              <label className={`radio-card ${notice ? '' : 'on'}`}>
                <input type="radio" name="channel-kind" checked={!notice} onChange={() => setNotice(false)} />
                <span>
                  <strong>Canal comum</strong>
                  <span className="field-hint">Todos os membros conversam.</span>
                </span>
              </label>
              <label className={`radio-card ${notice ? 'on' : ''}`}>
                <input type="radio" name="channel-kind" checked={notice} onChange={() => setNotice(true)} />
                <span>
                  <strong>📢 Canal de avisos</strong>
                  <span className="field-hint">Só donos, moderadores e publicadores escrevem. Todos os membros leem.</span>
                </span>
              </label>
            </div>
          </div>
        )}
        {kind === 'channel' && notice && (
          <div className="notice-opts">
            <Toggle checked={reactions} onChange={setReactions} label="Permitir reações aos avisos" />
            <Toggle checked={ack} onChange={setAck} label="Pedir “Ciente” nos avisos" />
            <span className="field-hint opt-hint">Cada aviso ganha o botão Ciente, e quem publica vê quem já confirmou a leitura.</span>
            <Toggle checked={hideMembers} onChange={setHideMembers} label="Ocultar a lista de membros" />
            <span className="field-hint opt-hint">Só donos e moderadores veem quem está no canal.</span>
            <p className="muted small">Você será o dono do canal. Para escolher quem publica, abra o perfil da pessoa no canal e use “Tornar publicador”.</p>
          </div>
        )}
        <Field label={kind === 'dm' ? 'Pessoas (até 8)' : 'Adicionar membros'}>
          <UserPicker
            value={members}
            onChange={setMembers}
            itemDisabled={
              kind === 'dm'
                ? (u) => blockedText(direct.state([...members, u].map(partyOf)))
                : privateRoom
                  ? (u) => direct.bringIn(members.map(partyOf), partyOf(u))
                  : undefined
            }
          />
        </Field>
        {dmState?.kind === 'none' && <div className="form-error">{dmState.text}</div>}
        {dmState?.kind === 'view' && <p className="muted small direct-note">🚫 {dmState.text}</p>}
        {kind === 'discussion' && (
          <Field label="Primeira mensagem (opcional)">
            <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3} />
          </Field>
        )}
        {error && <div className="form-error">{error}</div>}
      </div>
    </Modal>
  );
}

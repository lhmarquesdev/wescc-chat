import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Room } from '@shared/index';
import { api, ApiError, errorMessage } from '../lib/api';
import { partyOf, useDirect, type DirectState } from '../lib/direct';
import { roomPath } from '../lib/format';
import { usePermission, useSetting, useStore } from '../lib/store';
import { sendEncrypted } from '../lib/e2e/client';
import { requireE2eReady } from './e2e/E2eDialogs';
import { Icon } from './Icon';
import { RoomPicker, UserPicker, type PickedRoom, type PickedUser } from './Pickers';
import { Field, Modal, Segmented, Toggle } from './ui';

export type CreateKind = 'dm' | 'channel' | 'team' | 'discussion';

const TITLES: Record<CreateKind, string> = {
  dm: 'Nova mensagem direta',
  channel: 'Criar canal',
  team: 'Criar time',
  discussion: 'Criar discussão',
};

const blockedText = (st: DirectState) => (st.kind === 'none' ? st.text : undefined);

// Erro do formulário com o ícone na frente (a classe .form-error é a que os testes procuram).
function FormError({ children }: { children: ReactNode }) {
  return (
    <div className="form-error" role="alert">
      <Icon name="error" size={16} />
      <span>{children}</span>
    </div>
  );
}

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
  // Criptografia de ponta a ponta: grupo privado criado já cifrado (com E2E_Enable).
  const [encrypted, setEncrypted] = useState(false);
  const e2eOn = !!useSetting<boolean>('E2E_Enable');
  const e2eHere = e2eOn && kind === 'channel' && isPrivate;
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
        const e2e = e2eHere && encrypted;
        // A chave da conversa nasce neste navegador: a senha da criptografia vem antes.
        if (e2e && !(await requireE2eReady())) return;
        const extraData = { topic, notice, noticeAck: notice && ack, reactWhenReadOnly: notice && reactions, broadcast: notice && hideMembers, encrypted: e2e || undefined };
        const r = await api.post(`${prefix}.create`, { name, members: usernames, extraData });
        const room = r.channel ?? r.group;
        navigate(roomPath(room));
      } else if (kind === 'team') {
        const r = await api.post('teams.create', { name, type: isPrivate ? 1 : 0, members: usernames, room: { readOnly, extraData: { topic } } });
        navigate(roomPath({ _id: r.team.roomId, t: isPrivate ? 'p' : 'c' }));
      } else {
        if (!parentRoom) throw new Error('Escolha a sala de origem.');
        const create = (first?: string) => api.post('rooms.createDiscussion', { prid: parentRoom._id, pmid, t_name: name, users: usernames, reply: first || undefined });
        // Discussão de conversa criptografada nasce criptografada: a primeira mensagem vai cifrada, depois de criar.
        const parentEncrypted = !!useStore.getState().rooms[parentRoom._id]?.encrypted;
        let r: { discussion: Room };
        let later = parentEncrypted ? reply.trim() : '';
        try {
          r = await create(later ? undefined : reply);
        } catch (e) {
          if (!(e instanceof ApiError && e.errorType === 'error-e2e-reply')) throw e;
          later = reply.trim();
          r = await create();
        }
        if (later && (await requireE2eReady())) await sendEncrypted(r.discussion, { msg: later }).catch((e) => useStore.getState().toast(errorMessage(e), 'error'));
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
      className="create-modal"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn primary" aria-busy={busy || undefined} disabled={!nameValid || busy || dmBlocked} onClick={submit}>
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
          <Field label="Nome" required hint={kind === 'discussion' ? undefined : 'Sem espaços. Use letras, números, ponto, hífen ou sublinhado.'}>
            <input
              autoFocus
              value={name}
              placeholder={kind === 'discussion' ? 'Ex.: Escala de dezembro' : kind === 'team' ? 'Ex.: time-retencao' : 'Ex.: operacao-sac'}
              onChange={(e) => setName(kind === 'discussion' ? e.target.value : e.target.value.replace(/\s/g, '-'))}
            />
          </Field>
        )}
        {(kind === 'channel' || kind === 'team') && (
          <>
            <Field label="Tópico" hint="Opcional. Aparece no cabeçalho, embaixo do nome.">
              <input value={topic} onChange={(e) => setTopic(e.target.value)} />
            </Field>
            {/* div, não label: um <label> em volta dos botões passaria o clique do título para o primeiro deles. */}
            <div className="field">
              <span className="field-label">Quem pode entrar</span>
              <Segmented
                label="Quem pode entrar"
                value={isPrivate ? 'private' : 'public'}
                onChange={(v) => setPrivate(v === 'private' ? canPrivate || !canPublic : !canPublic)}
                items={[
                  { id: 'private', label: 'Privado', icon: 'room-private' },
                  { id: 'public', label: 'Público', icon: kind === 'team' ? 'room-team' : 'room-channel' },
                ]}
              />
              <span className="field-hint">{isPrivate ? 'Só quem for convidado entra.' : 'Qualquer pessoa da empresa encontra no diretório e entra.'}</span>
            </div>
            {kind === 'team' && <Toggle checked={readOnly} onChange={setReadOnly} label="Somente leitura" description="Só donos e moderadores escrevem na sala principal do time." />}
            {e2eHere && (
              <Toggle
                checked={encrypted}
                onChange={setEncrypted}
                label="Criptografar de ponta a ponta"
                description="Só quem participa lê. Busca, figurinhas, bots e integrações deixam de funcionar."
              />
            )}
          </>
        )}
        {kind === 'channel' && (
          <div className="field">
            <span className="field-label">Tipo de canal</span>
            <Segmented
              label="Tipo de canal"
              value={notice ? 'notice' : 'common'}
              onChange={(v) => setNotice(v === 'notice')}
              items={[
                { id: 'common', label: 'Canal comum', icon: 'room-channel' },
                { id: 'notice', label: 'Canal de avisos', icon: 'notice' },
              ]}
            />
            <span className="field-hint">{notice ? 'Só donos, moderadores e publicadores escrevem. Todos os membros leem.' : 'Todos os membros conversam.'}</span>
          </div>
        )}
        {kind === 'channel' && notice && (
          <div className="notice-opts">
            <Toggle checked={reactions} onChange={setReactions} label="Permitir reações aos avisos" />
            <Toggle checked={ack} onChange={setAck} label="Pedir “Ciente” nos avisos" description="Cada aviso ganha o botão Ciente, e quem publica vê quem já confirmou a leitura." />
            <Toggle checked={hideMembers} onChange={setHideMembers} label="Ocultar a lista de membros" description="Só donos e moderadores veem quem está no canal." />
            <p className="muted small notice-owner">
              <Icon name="info" size={14} />
              <span>Você será o dono do canal. Para escolher quem publica, abra o perfil da pessoa no canal e use “Tornar publicador”.</span>
            </p>
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
        {dmState?.kind === 'none' && <FormError>{dmState.text}</FormError>}
        {dmState?.kind === 'view' && (
          <p className="muted small direct-note">
            <Icon name="direct-blocked" size={16} />
            <span>{dmState.text}</span>
          </p>
        )}
        {kind === 'discussion' && (
          <Field label="Primeira mensagem (opcional)">
            <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3} />
          </Field>
        )}
        {error && <FormError>{error}</FormError>}
      </div>
    </Modal>
  );
}

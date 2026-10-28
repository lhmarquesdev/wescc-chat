// Integrações (Jira/Teams): criar ou editar uma regra de recebimento (canal do Teams → sala do chat) (§7.4).
import { useId, useState, type FormEvent } from 'react';
import type { IntegrationRoomRef, TeamsChannelRef, TeamsInRule, TeamsInRuleInput } from '@shared/integrations';
import { errorMessage } from '../../../lib/api';
import { Icon } from '../../../components/Icon';
import { Modal, Toggle, confirmDialog, useAsync } from '../../../components/ui';
import { teamsAdmin } from './admin-api';
import { FieldBlock, FormError, done, useInvalid } from './parts';
import { RoomTargets, roomName } from './RoomTargets';
import './integrations-admin.css';

// Os mesmos textos do servidor (IN_TEXT).
const IN_TEXT = {
  name: 'Dê um nome à regra (até 80 caracteres).',
  channel: 'Escolha a equipe e o canal do Teams.',
  room: 'Escolha a sala do chat que recebe as mensagens.',
  privateAck: (room: string) => `Este canal do Teams é privado. Confirme que as mensagens dele ficarão visíveis para todos os membros de #${room}.`,
};

type Field = 'name' | 'team' | 'channel' | 'room' | 'privateAck';

export function TeamsInModal({ rule, onClose, onSaved }: { rule: TeamsInRule | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<TeamsInRuleInput>(() =>
    rule
      ? {
          name: rule.name,
          enabled: rule.enabled,
          teamId: rule.team.id,
          channelId: rule.channel.id,
          roomId: rule.roomId,
          replies: rule.replies,
          edits: rule.edits,
          deletes: rule.deletes,
          grantPublisher: rule.grantPublisher,
          acknowledgePrivate: rule.channel.membership !== 'standard',
        }
      : { name: '', enabled: true, teamId: '', channelId: '', roomId: '', replies: true, edits: true, deletes: true, grantPublisher: false, acknowledgePrivate: false },
  );
  const [room, setRoom] = useState<IntegrationRoomRef | null>(rule?.room ?? null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const formId = useId();
  const ids = { name: useId(), team: useId(), channel: useId(), room: useId(), privateAck: useId() };
  // Erro de um campo: marcado e com o foco nele; o erro do servidor continua no fim (FormError).
  const v = useInvalid<Field>({ name: ids.name, team: ids.team, channel: ids.channel, room: ids.room, privateAck: ids.privateAck });
  const teams = useAsync(() => teamsAdmin.teams().then((r) => r.teams), []);
  const channels = useAsync(() => (f.teamId ? teamsAdmin.channels(f.teamId).then((r) => r.channels) : Promise.resolve([] as TeamsChannelRef[])), [f.teamId]);
  const FIELD_OF: Partial<Record<keyof TeamsInRuleInput, Field>> = { name: 'name', channelId: 'channel', roomId: 'room', acknowledgePrivate: 'privateAck' };
  const set = <K extends keyof TeamsInRuleInput>(k: K, val: TeamsInRuleInput[K]) => {
    setF((cur) => ({ ...cur, [k]: val }));
    setError(null);
    const field = FIELD_OF[k];
    if (field) v.clear(field);
  };

  // A regra em edição mostra a equipe e o canal mesmo antes de a lista do Teams chegar (ou se a conta perdeu acesso).
  const teamList = [...(teams.data ?? [])];
  if (rule && !teamList.some((t) => t.id === rule.team.id)) teamList.unshift(rule.team);
  const channelList = [...(channels.data ?? [])];
  if (rule && f.teamId === rule.team.id && !channelList.some((c) => c.id === rule.channel.id)) channelList.unshift(rule.channel);
  const channel = channelList.find((c) => c.id === f.channelId) ?? null;
  const isPrivate = !!channel && channel.membership !== 'standard';
  const roomLabel = room ? roomName(room) : 'sala';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const name = f.name.trim();
    const problem: { field: Field; text: string } | null =
      !name || name.length > 80
        ? { field: 'name', text: IN_TEXT.name }
        : !f.teamId
          ? { field: 'team', text: IN_TEXT.channel }
          : !f.channelId
            ? { field: 'channel', text: IN_TEXT.channel }
            : !f.roomId
              ? { field: 'room', text: IN_TEXT.room }
              : isPrivate && !f.acknowledgePrivate
                ? { field: 'privateAck', text: IN_TEXT.privateAck(roomLabel) }
                : null;
    if (problem) {
      setError(null);
      v.show(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await teamsAdmin.inSave({ ...f, name, acknowledgePrivate: isPrivate && f.acknowledgePrivate, ...(rule ? { _id: rule._id } : {}) });
      done(rule ? 'Regra salva.' : 'Regra criada.');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!rule) return;
    const yes = await confirmDialog({
      title: `Excluir a regra “${rule.name}”?`,
      body: 'As mensagens deste canal do Teams deixam de chegar à sala. As que já foram copiadas continuam no chat.',
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!yes) return;
    setSaving(true);
    try {
      await teamsAdmin.inRemove(rule._id);
      done('Regra excluída.');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={rule ? 'Editar regra de recebimento' : 'Nova regra de recebimento'}
      onClose={onClose}
      footer={
        <>
          {rule && (
            <button type="button" className="btn danger" disabled={saving} onClick={remove}>
              <Icon name="delete" />
              Excluir regra
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" form={formId} className="btn primary" disabled={saving} aria-busy={saving || undefined}>
            {rule ? 'Salvar regra' : 'Criar regra'}
          </button>
        </>
      }
    >
      <form id={formId} className="form" onSubmit={submit} noValidate>
        <FieldBlock label="Nome" htmlFor={ids.name} error={v.error('name')} errorId={v.errorId('name')}>
          <input id={ids.name} value={f.name} maxLength={80} {...v.aria('name')} onChange={(e) => set('name', e.target.value)} />
        </FieldBlock>

        <FieldBlock label="Equipe" htmlFor={ids.team} error={v.error('team')} errorId={v.errorId('team')}>
          <select
            id={ids.team}
            value={f.teamId}
            disabled={teams.loading && !teams.data}
            {...v.aria('team')}
            onChange={(e) => {
              setF((cur) => ({ ...cur, teamId: e.target.value, channelId: '', acknowledgePrivate: false }));
              setError(null);
              v.clear('team');
            }}
          >
            <option value="">{teams.loading && !teams.data ? 'Carregando…' : 'Escolha a equipe'}</option>
            {teamList.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {teams.error && <span className="field-error">{teams.error}</span>}
        </FieldBlock>

        <FieldBlock label="Canal" htmlFor={ids.channel} hint="Só aparecem equipes e canais de que a conta de serviço participa." error={v.error('channel')} errorId={v.errorId('channel')}>
          <select
            id={ids.channel}
            value={f.channelId}
            disabled={!f.teamId || (channels.loading && !channels.data)}
            {...v.aria('channel')}
            onChange={(e) => (set('channelId', e.target.value), set('acknowledgePrivate', false))}
          >
            <option value="">{f.teamId && channels.loading && !channels.data ? 'Carregando…' : 'Escolha o canal'}</option>
            {channelList.map((c) => (
              <option key={c.id} value={c.id}>
                {c.membership === 'standard' ? c.name : `${c.name} (privado)`}
              </option>
            ))}
          </select>
          {channels.error && <span className="field-error">{channels.error}</span>}
        </FieldBlock>

        <FieldBlock label="Sala do chat" error={v.error('room')} errorId={v.errorId('room')}>
          <RoomTargets
            inputId={ids.room}
            invalid={v.aria('room')}
            provider="msteams"
            mode="post"
            single
            max={1}
            value={f.roomId ? [f.roomId] : []}
            onChange={(ids) => set('roomId', ids[0] ?? '')}
            grantPublisher={f.grantPublisher}
            onGrantPublisher={(val) => set('grantPublisher', val)}
            known={rule?.room ? [rule.room] : undefined}
            onPicked={setRoom}
          />
        </FieldBlock>

        {isPrivate && (
          <div className="field">
            <label className="check">
              <input id={ids.privateAck} type="checkbox" checked={!!f.acknowledgePrivate} {...v.aria('privateAck')} onChange={(e) => set('acknowledgePrivate', e.target.checked)} />
              <span>Entendo que as mensagens deste canal privado do Teams ficarão visíveis para todos os membros de #{roomLabel}.</span>
            </label>
            {v.error('privateAck') && (
              <span className="field-error" id={v.errorId('privateAck')}>
                <Icon name="error" size={14} />
                {v.error('privateAck')}
              </span>
            )}
          </div>
        )}

        <Toggle checked={f.replies} onChange={(val) => set('replies', val)} label="Copiar respostas (viram tópicos)" />
        <Toggle checked={f.edits} onChange={(val) => set('edits', val)} label="Copiar edições" />
        <Toggle checked={f.deletes} onChange={(val) => set('deletes', val)} label="Copiar exclusões" />
        <Toggle checked={f.enabled} onChange={(val) => set('enabled', val)} label="Regra ativada" />

        <div className="callout info">
          <Icon name="info" />
          <span>As mensagens aparecem com o nome da pessoa e “(Teams)”. Menções do Teams viram texto e não notificam ninguém no chat. Mensagens anteriores à regra não são copiadas.</span>
        </div>

        {error && <FormError text={error} />}
      </form>
    </Modal>
  );
}

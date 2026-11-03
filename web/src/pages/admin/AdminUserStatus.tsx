// Administração › Status do usuário: os status personalizados ("Em reunião", "Almoço") que as pessoas escolhem no
// menu. O tipo decide o comportamento: Ocupado silencia as notificações; Invisível aparece offline para os outros.
import { useState } from 'react';
import type { CustomUserStatus, UserStatus } from '@shared/index';
import { STATUS_NAME_MAX, STATUS_TYPES, STATUS_TYPE_LABEL, normalizeStatusName, sortStatuses } from '@shared/status';
import { ApiError, api, errorMessage } from '../../lib/api';
import { plural } from '../../lib/format';
import { useStore } from '../../lib/store';
import { Icon } from '../../components/Icon';
import { Empty, Field, Modal, SkeletonTable, confirmDialog, useAsync } from '../../components/ui';
import { PageHead, RowMenu, TableWrap } from './parts';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const ok = (t: string) => useStore.getState().toast(t);

// O que cada tipo faz, na escolha do modal.
const TYPE_HINT: Record<UserStatus, string> = {
  online: 'Aparece como disponível e recebe notificações.',
  away: 'Aparece como ausente e recebe notificações.',
  busy: 'Silencia notificações, sons, push e e-mails. Chamadas continuam tocando.',
  offline: 'Aparece offline para as outras pessoas e recebe notificações.',
};

type Row = CustomUserStatus & { usersCount?: number };

export function AdminUserStatus() {
  // A lista volta a carregar quando alguém muda um status (evento userStatus.changed põe a lista nova na store).
  const live = useStore((s) => s.userStatuses);
  const { data, loading, reload } = useAsync(() => api.get<{ statuses: Row[] }>('custom-user-status.list'), [live]);
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const rows = sortStatuses(data?.statuses ?? []);
  // "Em uso" muda a cada escolha no menu (sem evento para a Administração): editar e excluir contam de novo antes,
  // para o aviso dizer quantas pessoas mudam junto.
  const fresh = async (s: Row): Promise<Row | null> => {
    try {
      const r = await api.get<{ statuses: Row[] }>('custom-user-status.list');
      reload();
      return r.statuses.find((x) => x._id === s._id) ?? null;
    } catch {
      return s;
    }
  };
  const edit = async (s: Row) => {
    const cur = await fresh(s);
    if (cur) setEditing(cur);
    else fail(new Error('Status não encontrado.'));
  };
  const remove = async (row: Row) => {
    const s = await fresh(row);
    if (!s) return;
    const n = s.usersCount ?? 0;
    const after = STATUS_TYPE_LABEL[s.statusType]; // offline escolhido aparece como "Invisível"
    const yes = await confirmDialog({
      title: `Excluir “${s.name}”?`,
      body: n ? `${plural(n, 'pessoa está', 'pessoas estão')} com ele agora e ${n === 1 ? 'passa' : 'passam'} a aparecer como ${after}.` : 'Ninguém está com ele agora.',
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!yes) return;
    try {
      await api.post('custom-user-status.delete', { customUserStatusId: s._id });
      ok('Status excluído.');
      reload();
    } catch (e) {
      fail(e);
    }
  };
  const newButton = (
    <button className="btn primary" onClick={() => setEditing('new')}>
      <Icon name="add" />
      Novo status
    </button>
  );
  return (
    <>
      <PageHead title="Status do usuário" count={rows.length || undefined}>
        {rows.length > 0 && newButton}
      </PageHead>
      {loading && !data ? (
        <SkeletonTable rows={4} cols={3} />
      ) : !rows.length ? (
        <Empty icon="user-status" title="Nenhum status personalizado" action={newButton}>
          Crie status como “Em reunião” ou “Almoço” para as pessoas escolherem no menu. O tipo decide o comportamento: Ocupado silencia as notificações.
        </Empty>
      ) : (
        <TableWrap>
          <table className="table stack kv user-status-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Tipo</th>
                <th className="num">Em uso</th>
                <th className="actions-col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s._id}>
                  <td data-label="Nome">
                    <span className="user-status-name">
                      <span className={`status-dot ${s.statusType}`} aria-hidden="true" />
                      <strong>{s.name}</strong>
                    </span>
                  </td>
                  <td data-label="Tipo">
                    {/* Um só bloco: na tabela empilhada do celular a célula é flex e separaria o texto da nota. */}
                    <span>
                      {STATUS_TYPE_LABEL[s.statusType]}
                      {s.statusType === 'busy' && <span className="muted"> · silencia notificações</span>}
                    </span>
                  </td>
                  <td className="num" data-label="Em uso">
                    {s.usersCount ? plural(s.usersCount, 'pessoa', 'pessoas') : <span className="muted">—</span>}
                  </td>
                  <td className="actions-col">
                    <RowMenu label={`Ações de “${s.name}”`}>
                      {(close) => (
                        <>
                          <button type="button" onClick={() => (close(), void edit(s))}>
                            <Icon name="edit" />
                            Editar
                          </button>
                          <button type="button" className="danger" onClick={() => (close(), void remove(s))}>
                            <Icon name="delete" />
                            Excluir
                          </button>
                        </>
                      )}
                    </RowMenu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {editing && (
        <StatusModal
          status={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function StatusModal({ status, onClose, onSaved }: { status: Row | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(status?.name ?? '');
  const [type, setType] = useState<UserStatus>(status?.statusType ?? 'busy');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const inUse = status?.usersCount ?? 0;
  const save = async () => {
    const r = normalizeStatusName(name);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setSaving(true);
    try {
      if (status) await api.post('custom-user-status.update', { _id: status._id, name: r.name, statusType: type });
      else await api.post('custom-user-status.create', { name: r.name, statusType: type });
      ok(status ? 'Status salvo.' : 'Status criado.');
      onSaved();
    } catch (e) {
      // Nome repetido ou reservado vai para o campo; o resto vira aviso.
      if (e instanceof ApiError && /name/.test(e.errorType)) setError(e.message);
      else fail(e);
      setSaving(false);
    }
  };
  return (
    <Modal
      title={status ? 'Editar status' : 'Novo status'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={saving || !name.trim()} onClick={() => void save()}>
            {status ? 'Salvar' : 'Criar status'}
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Nome" hint="Até 40 caracteres. Aparece no lugar do tipo, como “Em reunião”." error={error || undefined}>
          <input
            autoFocus
            value={name}
            maxLength={STATUS_NAME_MAX}
            onChange={(e) => {
              setName(e.target.value);
              setError('');
            }}
          />
        </Field>
        <div className="field" role="radiogroup" aria-label="Tipo">
          <span className="field-label">Tipo</span>
          <div className="status-choices">
            {STATUS_TYPES.map((t) => (
              <label key={t} className={`status-choice ${type === t ? 'on' : ''}`}>
                <input type="radio" name="user-status-type" checked={type === t} onChange={() => setType(t)} />
                <span>
                  <strong className="status-choice-title">
                    <span className={`status-dot ${t}`} aria-hidden="true" />
                    {STATUS_TYPE_LABEL[t]}
                  </strong>
                  <span className="field-hint">{TYPE_HINT[t]}</span>
                </span>
              </label>
            ))}
          </div>
          {status && inUse > 0 && type !== status.statusType && (
            <span className="field-hint">
              {plural(inUse, 'pessoa está', 'pessoas estão')} com este status agora e {inUse === 1 ? 'muda' : 'mudam'} junto.
            </span>
          )}
        </div>
        {/* Enter no campo salva. */}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// Papéis em lote com prévia: antes de gravar, quem recebe (ou perde), quem já está assim e quem fica de fora e por
// quê (servidor, dryRun). Aplicar grava só quem pode (skipBlocked); os travados continuam como estavam.
import { useState } from 'react';
import { LOCK_TEXT, type LockReason } from '@shared/rbac';
import { api } from '../../../lib/api';
import { nameList, roleLabel } from '../../../lib/format';
import { Icon } from '../../../components/Icon';
import { useIsPhone } from '../../../components/overlay';
import { Modal, SkeletonTable, useAsync } from '../../../components/ui';
import { people, rbacFail, rbacOk } from './data';

type Reason = Exclude<LockReason, null | 'own-role' | 'protected'> | 'self' | 'not-assignable' | 'last-admin';

interface Person {
  _id: string;
  username: string;
}
interface Preview {
  ok: Person[];
  unchanged: Person[];
  blocked: (Person & { reason: Reason; roles?: string[] })[];
}

export function bulkReason(reason: Reason, roles?: string[]) {
  if (reason === 'not-assignable') return `Você não pode dar nem tirar: ${nameList((roles ?? []).map(roleLabel), 3)}.`;
  if (reason === 'last-admin') return 'É o último administrador ativo.';
  return LOCK_TEXT[reason] ?? '';
}

// n pessoas + verbo no singular ou no plural ("1 recebe", "3 recebem").
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function BulkRolesDialog({ role, mode, userIds, onClose, onDone }: { role: string; mode: 'add' | 'remove'; userIds: string[]; onClose: () => void; onDone: (applied: number) => void }) {
  const phone = useIsPhone();
  const body = { userIds, [mode]: [role] };
  const preview = useAsync(() => api.post('rbac.users.bulkRoles', { ...body, dryRun: true }) as Promise<Preview>, [role, mode, userIds.join()]);
  const [busy, setBusy] = useState(false);
  const label = roleLabel(role);
  const p = preview.data;
  const ok = p?.ok.length ?? 0;
  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.post('rbac.users.bulkRoles', { ...body, skipBlocked: true });
      rbacOk(`Papel ${label} ${mode === 'add' ? 'adicionado a' : 'removido de'} ${people(r.users)}.`);
      onDone(r.users);
    } catch (e) {
      rbacFail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      size="sm"
      variant={phone ? 'sheet' : undefined}
      title={mode === 'add' ? `Dar o papel ${label} a ${people(userIds.length)}` : `Tirar o papel ${label} de ${people(userIds.length)}`}
      description="Confira antes de aplicar. Quem fica de fora continua como está."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy || !ok} aria-busy={busy || undefined} onClick={() => void apply()}>
            Aplicar a {people(ok)}
          </button>
        </>
      }
    >
      {preview.loading && !p ? (
        <SkeletonTable rows={3} cols={1} />
      ) : preview.error || !p ? (
        <p className="callout warn">
          <Icon name="warning" />
          <span>{preview.error || 'Não foi possível montar a prévia.'}</span>
        </p>
      ) : (
        <ul className="rbac-bulk-preview">
          <li className={ok ? 'up' : 'muted'}>
            <Icon name={mode === 'add' ? 'rbac-up' : 'rbac-down'} size={14} />
            {mode === 'add' ? count(ok, 'recebe', 'recebem') : count(ok, 'perde', 'perdem')}
          </li>
          {p.unchanged.length > 0 && (
            <li className="muted">
              <Icon name="check" size={14} />
              {mode === 'add' ? count(p.unchanged.length, 'já tem', 'já têm') : count(p.unchanged.length, 'não tem', 'não têm')}
            </li>
          )}
          {p.blocked.length > 0 && (
            <li className="blocked">
              <Icon name="rbac-lock" size={14} />
              <span>
                {count(p.blocked.length, 'fica de fora', 'ficam de fora')}
                <ul>
                  {p.blocked.map((b) => (
                    <li key={b._id}>
                      <strong>@{b.username}</strong> — {bulkReason(b.reason, b.roles)}
                    </li>
                  ))}
                </ul>
              </span>
            </li>
          )}
        </ul>
      )}
    </Modal>
  );
}

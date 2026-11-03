// Papéis em lote com prévia: antes de gravar, quem recebe (ou perde), quem já está assim e quem fica de fora e por
// quê (servidor, dryRun). Aplicar grava só quem pode (skipBlocked); os travados continuam como estavam. A prévia diz
// também o que o papel traz (Exige 2FA, Restrito), quem fica só com Usuário e quando você está na lista.
import { useState } from 'react';
import { LOCK_TEXT, type LockReason } from '@shared/rbac';
import { api } from '../../../lib/api';
import { nameList, roleLabel } from '../../../lib/format';
import { Icon } from '../../../components/Icon';
import { useIsPhone } from '../../../components/overlay';
import { useStore } from '../../../lib/store';
import { Modal, SkeletonTable, useAsync } from '../../../components/ui';
import { people, rbacFail, rbacOk } from './data';

type Reason = Exclude<LockReason, null | 'own-role' | 'protected'> | 'self' | 'not-assignable' | 'last-admin';

interface Person {
  _id: string;
  username: string;
}
interface Preview {
  // fallbackUser: perde o último papel e fica com Usuário.
  ok: (Person & { fallbackUser?: boolean })[];
  unchanged: Person[];
  blocked: (Person & { reason: Reason; roles?: string[] })[];
}

export function bulkReason(reason: Reason, roles?: string[]) {
  // Sem papel nenhum a pessoa ficaria com Usuário, e o Usuário também precisa caber no que você dá.
  if (reason === 'not-assignable' && roles?.length === 1 && roles[0] === 'user') return 'Ficaria só com Usuário, e esse papel você não pode dar.';
  if (reason === 'not-assignable') return `Você não pode dar nem tirar: ${nameList((roles ?? []).map(roleLabel), 3)}.`;
  if (reason === 'last-admin') return 'É o último administrador ativo.';
  return LOCK_TEXT[reason] ?? '';
}

// n pessoas + verbo no singular ou no plural ("1 recebe", "3 recebem").
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface BulkRoleInfo {
  mandatory2fa?: boolean;
  restrictDirect?: boolean;
}

export function BulkRolesDialog({
  role,
  info,
  mode,
  userIds,
  onClose,
  onDone,
}: {
  role: string;
  info?: BulkRoleInfo;
  mode: 'add' | 'remove';
  userIds: string[];
  onClose: () => void;
  onDone: (applied: number) => void;
}) {
  const phone = useIsPhone();
  const me = useStore((s) => s.me);
  const [selfOk, setSelfOk] = useState(false);
  const body = { userIds, [mode]: [role] };
  const preview = useAsync(() => api.post('rbac.users.bulkRoles', { ...body, dryRun: true }) as Promise<Preview>, [role, mode, userIds.join()]);
  const [busy, setBusy] = useState(false);
  const label = roleLabel(role);
  const p = preview.data;
  const ok = p?.ok.length ?? 0;
  const self = !!p?.ok.some((u) => u._id === me?._id);
  const fallback = p?.ok.filter((u) => u.fallbackUser).length ?? 0;
  // Dar a si mesmo um papel que exige 2FA, sem 2FA configurado: o chat pede a configuração logo depois e nada mais
  // funciona até lá (nem desfazer). Só aplica com a confirmação explícita.
  const selfGate = self && mode === 'add' && !!info?.mandatory2fa && !me?.twoFactorEnabled;
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
          <button className="btn primary" disabled={busy || !ok || (selfGate && !selfOk)} aria-busy={busy || undefined} onClick={() => void apply()}>
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
        <>
        <ul className="rbac-bulk-preview">
          <li className={ok ? 'up' : 'muted'}>
            <Icon name={mode === 'add' ? 'rbac-up' : 'rbac-down'} size={14} />
            {mode === 'add' ? count(ok, 'recebe', 'recebem') : count(ok, 'perde', 'perdem')}
          </li>
          {self && (
            <li className="warn">
              <Icon name="admin-users" size={14} />
              Inclui você
            </li>
          )}
          {fallback > 0 && (
            <li className="warn">
              <Icon name="warning" size={14} />
              {count(fallback, 'fica só com Usuário (era o último papel)', 'ficam só com Usuário (era o último papel)')}
            </li>
          )}
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
        {info && (info.mandatory2fa || info.restrictDirect) && (
          <ul className="rbac-bulk-notes">
            {info.mandatory2fa && mode === 'add' && (
              <li>
                <Icon name="security" size={14} />
                <span>
                  <strong>Exige 2FA:</strong> quem recebe configura a autenticação em dois fatores antes de voltar a usar o chat.
                </span>
              </li>
            )}
            {info.restrictDirect && (
              <li>
                <Icon name="direct-blocked" size={14} />
                <span>
                  <strong>Restrito em conversas diretas:</strong>{' '}
                  {mode === 'add'
                    ? 'quem recebe só conversa em particular e liga para quem não é restrito.'
                    : 'quem perde deixa de ser restrito, se não tiver outro papel restrito.'}
                </span>
              </li>
            )}
          </ul>
        )}
        {selfGate && (
          <label className="rbac-understood rbac-bulk-self">
            <input type="checkbox" checked={selfOk} onChange={(e) => setSelfOk(e.target.checked)} />
            Você está na lista e ainda não tem 2FA: ao aplicar, o chat pede a configuração antes de qualquer outra coisa. Entendi.
          </label>
        )}
        </>
      )}
    </Modal>
  );
}

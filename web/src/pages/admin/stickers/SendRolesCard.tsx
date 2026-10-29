// Figurinhas: "Quem não envia figurinhas" (Stickers_Send_Blocked_Roles), só para quem edita configurações privilegiadas.
import { useEffect, useId, useState } from 'react';
import { api, errorMessage } from '../../../lib/api';
import { usePermission, useSetting, useStore } from '../../../lib/store';
import { RoleChips, useGlobalRoles } from '../../../components/stickers/studioParts';

const parse = (raw: string | undefined) =>
  String(raw ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

export function SendRolesCard() {
  const id = useId();
  const canEdit = usePermission('edit-privileged-setting');
  const raw = useSetting<string>('Stickers_Send_Blocked_Roles');
  const roles = useGlobalRoles();
  // O valor novo fica na tela até o settings.changed trazer o mesmo.
  const [local, setLocal] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setLocal(null), [raw]);
  if (!canEdit) return null;
  const value = local ?? parse(raw);
  const save = async (next: string[]) => {
    setLocal(next);
    setBusy(true);
    try {
      await api.post('settings', { settings: { Stickers_Send_Blocked_Roles: next.join(',') } });
      useStore.getState().toast('Configuração salva.', 'success');
    } catch (e) {
      setLocal(null);
      useStore.getState().toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <div className="card-head">
        <h2 id={`${id}-t`}>Quem não envia figurinhas</h2>
      </div>
      <div className="field">
        <RoleChips value={value} roles={roles} labelledBy={`${id}-t`} disabled={busy} onChange={(next) => void save(next)} />
        <span className="field-hint">Quem tem um destes papéis continua vendo as figurinhas nas conversas, mas não envia. Exemplo: operação.</span>
      </div>
    </div>
  );
}

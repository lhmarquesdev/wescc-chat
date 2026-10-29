// Atribuir uma issue: "Eu", "Ninguém" ou alguém da busca de pessoas do Jira (com o @ do chat quando vinculado).
import { useState } from 'react';
import { errorMessage } from '../../lib/api';
import { settleEphemeralRequest } from '../../lib/ephemeral';
import { jiraApi, type IntegrationModalRequest } from '../../lib/integrations';
import { useStore } from '../../lib/store';
import { Modal } from '../ui';
import { FormError, PersonSearch, type PersonPick } from './JiraFieldInputs';
import './integrations.css';

export default function JiraAssignModal({ req, onClose }: { req: IntegrationModalRequest; onClose: () => void }) {
  const key = (req.params?.key ?? '').toUpperCase();
  const [pick, setPick] = useState<PersonPick>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!pick || busy) return;
    setBusy(true);
    setError('');
    try {
      const target = pick.kind === 'me' ? 'me' : pick.kind === 'none' ? null : pick.user.accountId;
      const r = await jiraApi.assign(key, target);
      settleEphemeralRequest(req);
      onClose();
      const k = r.issue?.key ?? key;
      const text =
        pick.kind === 'none'
          ? `${k} ficou sem responsável.`
          : pick.kind === 'me'
            ? `${k} agora está com você.`
            : `${k} agora está com ${r.issue?.assignee?.displayName || pick.user.displayName}.`;
      useStore.getState().toast(text, 'success');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Atribuir ${key}`}
      variant="sheet"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn primary" disabled={!pick || busy} aria-busy={busy || undefined} onClick={() => void submit()}>
            Atribuir
          </button>
        </>
      }
    >
      <div className="form">
        <PersonSearch target={{ key }} value={pick} onChange={setPick} label="Buscar pessoa no Jira" />
        {error && <FormError>{error}</FormError>}
      </div>
    </Modal>
  );
}

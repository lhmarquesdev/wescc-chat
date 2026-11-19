// Canal com código de acesso: pede o código num diálogo do app (no lugar do prompt do navegador) e só chama o
// servidor quando a pessoa confirma. Código errado fica no diálogo, com o erro; Cancelar não envia nada.
import { useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Field, Modal } from './ui';

export function JoinCodeDialog({ rid, name, onJoined, onClose }: { rid: string; name: string; onJoined: () => void; onClose: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ok = code.trim().length > 0;
  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.post('channels.join', { roomId: rid, joinCode: code.trim() });
      onJoined();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      size="sm"
      variant="sheet"
      title="Código de acesso"
      description={`#${name} pede um código para entrar. Quem administra o canal pode passar o código.`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn primary" disabled={!ok || busy} aria-busy={busy || undefined} onClick={() => void submit()}>
            Entrar no canal
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Código" required>
          <input value={code} autoComplete="off" spellCheck={false} maxLength={200} onChange={(e) => (setCode(e.target.value), setError(''))} />
        </Field>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
      </form>
    </Modal>
  );
}

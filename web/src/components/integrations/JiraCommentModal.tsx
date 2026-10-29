// Comentar numa issue pela conta do Jira da pessoa. Em projeto do Service Management o comentário é interno, a não
// ser que a pessoa marque "Enviar ao cliente".
import { useEffect, useState } from 'react';
import { errorMessage } from '../../lib/api';
import { settleEphemeralRequest } from '../../lib/ephemeral';
import { jiraApi, type IntegrationModalRequest } from '../../lib/integrations';
import { useStore } from '../../lib/store';
import { Field, Modal } from '../ui';
import { FormError } from './JiraFieldInputs';
import './integrations.css';

const MAX = 10000;

export default function JiraCommentModal({ req, onClose }: { req: IntegrationModalRequest; onClose: () => void }) {
  const key = (req.params?.key ?? '').toUpperCase();
  const [serviceDesk, setServiceDesk] = useState(req.params?.serviceDesk === '1');
  const [text, setText] = useState('');
  const [isPublic, setPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // O cartão pode ser antigo: o tipo do projeto vem da issue de agora.
  useEffect(() => {
    if (!key) return;
    let alive = true;
    jiraApi
      .issue(key)
      .then((r) => alive && setServiceDesk(!!r.issue.project.serviceDesk))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [key]);

  const ok = text.trim().length > 0 && text.length <= MAX;
  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError('');
    try {
      await jiraApi.comment(key, text.trim(), serviceDesk && isPublic);
      settleEphemeralRequest(req);
      onClose();
      useStore.getState().toast(serviceDesk && !isPublic ? `Comentário interno publicado em ${key}.` : `Comentário publicado em ${key}.`, 'success');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Comentar em ${key}`}
      variant="sheet"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn primary" disabled={!ok || busy} aria-busy={busy || undefined} onClick={() => void submit()}>
            Comentar
          </button>
        </>
      }
    >
      <div className="form">
        <Field label="Comentário" required hint={text.length > MAX * 0.9 ? `${text.length}/${MAX}` : undefined}>
          <textarea
            rows={5}
            value={text}
            maxLength={MAX}
            required
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </Field>
        {serviceDesk ? (
          <div className="field">
            <label className="check">
              <input type="checkbox" checked={isPublic} onChange={(e) => setPublic(e.target.checked)} />
              Enviar ao cliente (comentário público)
            </label>
            <span className="field-hint">Este projeto atende clientes. Sem marcar, o comentário fica interno.</span>
          </div>
        ) : (
          <div className="field-hint">O comentário é publicado pela sua conta do Jira.</div>
        )}
        {error && <FormError>{error}</FormError>}
      </div>
    </Modal>
  );
}

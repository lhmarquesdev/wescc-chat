// Integrações (Jira/Teams): conectar a conta do Jira da própria pessoa (§7.9). Também aberto pelo chat (modal
// jira-link das respostas efêmeras), por isso as props são fixas.
import { useId, useState, type FormEvent } from 'react';
import type { LinkedAccount } from '@shared/integrations';
import { errorMessage } from '../../lib/api';
import { jiraApi, loadIntegrationsMe, useIntegrationsMe } from '../../lib/integrations';
import { useSetting, useStore } from '../../lib/store';
import { Icon } from '../../components/Icon';
import { Field, Modal, Skeleton } from '../../components/ui';
import '../admin/integrations/integrations-admin.css';

const TOKENS_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function FormError({ text }: { text: string }) {
  return (
    <div className="form-error" role="alert">
      <Icon name="error" size={16} />
      <span>{text}</span>
    </div>
  );
}

export function JiraTokenModal({ onClose, onLinked }: { onClose(): void; onLinked?(a: LinkedAccount): void }) {
  const me = useIntegrationsMe();
  const siteName = useSetting<string>('Site_Name') || 'Wescc Chat';
  const myEmail = useStore((s) => s.me?.email ?? '');
  const formId = useId();
  const [email, setEmail] = useState(myEmail);
  const [token, setToken] = useState('');
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mode = me?.jira.enabled ? me.jira.userAuth : null;

  // O servidor só volta para /account/… ou /admin/integrations/… (safeReturnTo); de uma sala, a volta é para Contas
  // conectadas, e o texto do modal diz isso.
  const here = location.pathname.startsWith('/account/') || location.pathname.startsWith('/admin/integrations/');
  const startOAuth = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await jiraApi.linkStart(here ? location.pathname + location.search : '/account/connected');
      location.assign(url);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { account } = await jiraApi.linkToken(email.trim(), token.trim(), expires || null);
      setToken('');
      useStore.getState().toast('Conta do Jira conectada.', 'success');
      void loadIntegrationsMe(true);
      onLinked?.(account);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Igual aos outros modais das integrações: Cancelar é ghost, a ação principal fica sozinha em destaque.
  const cancel = (
    <button type="button" className="btn ghost" onClick={onClose}>
      Cancelar
    </button>
  );

  if (!me)
    return (
      <Modal title="Conectar sua conta do Jira" onClose={onClose} footer={cancel}>
        <div className="form" role="status" aria-label="Carregando" aria-busy="true">
          <Skeleton height={14} width="80%" />
          <Skeleton height={14} width="60%" />
          <Skeleton height={36} />
        </div>
      </Modal>
    );

  if (mode === 'oauth')
    return (
      <Modal
        title="Conectar sua conta do Jira"
        onClose={onClose}
        footer={
          <>
            {cancel}
            <button type="button" className="btn primary" disabled={busy} aria-busy={busy || undefined} onClick={startOAuth}>
              <Icon name="tokens" />
              Entrar com a Atlassian
            </button>
          </>
        }
      >
        <div className="form">
          <p>{here ? 'Você vai para a página da Atlassian, autoriza o chat e volta para cá.' : 'Você vai para a página da Atlassian, autoriza o chat e volta para Minha conta → Contas conectadas.'}</p>
          {error && <FormError text={error} />}
        </div>
      </Modal>
    );

  if (mode !== 'token')
    return (
      <Modal title="Conectar sua conta do Jira" onClose={onClose} footer={cancel}>
        <p>{mode === 'off' ? 'Neste chat, ninguém conecta a própria conta do Jira. Comentar e atribuir issues ficam indisponíveis.' : 'O Jira não está ativo neste chat.'}</p>
      </Modal>
    );

  const ready = !!email.trim() && token.trim().length > 0;
  return (
    <Modal
      title="Conectar sua conta do Jira"
      onClose={onClose}
      footer={
        <>
          {cancel}
          <button type="submit" form={formId} className="btn primary" disabled={busy || !ready} aria-busy={busy || undefined}>
            {busy ? 'Conectando…' : 'Conectar'}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate>
        <ol className="int-steps">
          <li>
            <p>
              Abra{' '}
              <a href={TOKENS_URL} target="_blank" rel="noopener noreferrer">
                {/* O espaço separa o ícone do texto, dentro do mesmo link. */}
                id.atlassian.com → Segurança → Tokens de API <Icon name="open-external" size={14} />
              </a>{' '}
              e clique em Criar token de API.
            </p>
          </li>
          <li>
            <p>Dê um nome, por exemplo {siteName}, escolha a validade e copie o token.</p>
          </li>
          <li>
            <p>Cole aqui:</p>
            <div className="form">
              <Field label="E-mail da sua conta Atlassian">
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" spellCheck={false} required />
              </Field>
              <Field label="Token de API">
                <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} required />
              </Field>
              <Field label="Validade do token (opcional)" hint="Avisamos 14 dias antes de expirar.">
                <input type="date" value={expires} min={today()} onChange={(e) => setExpires(e.target.value)} />
              </Field>
              <p className="muted small">
                <Icon name="encrypted" size={14} /> O token fica cifrado no servidor e só é usado quando você age pelo chat.
              </p>
              {error && <FormError text={error} />}
            </div>
          </li>
        </ol>
      </form>
    </Modal>
  );
}

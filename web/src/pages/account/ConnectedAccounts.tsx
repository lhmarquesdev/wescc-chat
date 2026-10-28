// Integrações (Jira/Teams): Minha conta → Contas conectadas (§7.9). A conta do Jira de cada pessoa (OAuth ou token)
// e a conta do Microsoft 365 encontrada pelo e-mail, para a presença do Teams.
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { LinkedAccount } from '@shared/integrations';
import { formatDateTime, formatRelative } from '../../lib/format';
import { jiraApi, linkedApi, loadIntegrationsMe, useIntegrationsMe } from '../../lib/integrations';
import { useStore } from '../../lib/store';
import { Icon } from '../../components/Icon';
import { Empty, Skeleton, Toggle, confirmDialog } from '../../components/ui';
import { PageHead } from '../admin/parts';
import { done, fail, motivoText, useIntegrationEvents } from '../admin/integrations/parts';
import { JiraTokenModal } from './JiraTokenModal';
import '../admin/integrations/integrations-admin.css';

const dateFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });

const ACCOUNT_PILL: Record<LinkedAccount['status'], { cls: string; text: string }> = {
  ok: { cls: 'pill ok', text: 'Conectada' },
  expired: { cls: 'pill warn', text: 'Expirada' },
  error: { cls: 'pill err', text: 'Com erro' },
};

// Volta do OAuth da Atlassian (?integracao=…): avisa e tira a consulta do endereço.
function useJiraReturn() {
  const location = useLocation();
  const navigate = useNavigate();
  // O StrictMode roda o efeito duas vezes no desenvolvimento: um aviso por entrada do histórico.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const r = q.get('integracao');
    if (!r || handled.current === location.key) return;
    handled.current = location.key;
    if (r === 'jira-ok') done('Conta do Jira conectada.');
    else if (r === 'erro') fail(new Error(`Não foi possível conectar a conta do Jira (${motivoText(q.get('motivo'))}).`));
    q.delete('integracao');
    q.delete('motivo');
    const rest = q.toString();
    navigate({ pathname: location.pathname, search: rest ? `?${rest}` : '' }, { replace: true });
    void loadIntegrationsMe(true);
  }, [location.search, location.pathname, location.key, navigate]);
}

function JiraCard({ userAuth, createAsIntegration, account }: { userAuth: 'token' | 'oauth'; createAsIntegration: boolean; account: LinkedAccount | null }) {
  const [tokenOpen, setTokenOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const signIn = async () => {
    setBusy(true);
    try {
      const { url } = await jiraApi.linkStart('/account/connected');
      location.assign(url);
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  };
  const connect = () => (userAuth === 'oauth' ? void signIn() : setTokenOpen(true));

  const unlink = async () => {
    const yes = await confirmDialog({
      title: 'Desconectar sua conta do Jira?',
      body: 'O chat deixa de criar, comentar e atribuir issues em seu nome. O token continua válido na Atlassian: apague-o em id.atlassian.com se não for mais usá-lo.',
      confirmLabel: 'Desconectar',
      danger: true,
    });
    if (!yes) return;
    setBusy(true);
    try {
      await linkedApi.remove('jira');
      await loadIntegrationsMe(true);
      done('Conta do Jira desconectada.');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const pill = account ? ACCOUNT_PILL[account.status] : null;
  const meta = account
    ? [
        account.method === 'token' && account.secretExpiresAt ? `Token válido até ${dateFmt.format(new Date(account.secretExpiresAt))}` : null,
        account.lastUsedAt ? `Usada ${formatRelative(account.lastUsedAt)}` : null,
      ].filter(Boolean)
    : [];

  return (
    <section className="card" aria-labelledby="linked-jira-title">
      <div className="card-head">
        <span className="card-icon">
          <Icon name="int-jira" size={20} />
        </span>
        <div>
          {/* O estado fica na linha do título: no celular o texto usa a largura toda do cartão. */}
          <div className="row-actions wrap">
            <h2 id="linked-jira-title">Jira</h2>
            {pill && <span className={pill.cls}>{pill.text}</span>}
          </div>
          {!account ? (
            <>
              <p>
                Conecte sua conta para criar, comentar e atribuir issues em seu nome.
                {createAsIntegration && ' Sem conectar, suas issues são criadas pela conta da integração.'}
              </p>
              <div className="row-actions wrap">
                <button type="button" className="btn primary" disabled={busy} onClick={connect}>
                  {userAuth === 'oauth' ? 'Entrar com a Atlassian' : 'Conectar com token'}
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                <strong>{account.displayName}</strong>
                {account.email && ` · ${account.email}`}
              </p>
              {account.site && <small>{account.site}</small>}
              {account.status !== 'ok' && account.statusText && <p className="neg">{account.statusText}</p>}
              {meta.length > 0 && <small title={account.lastUsedAt ? formatDateTime(account.lastUsedAt) : undefined}>{meta.join(' · ')}</small>}
              <div className="row-actions wrap">
                {/* O rótulo segue o modo de agora (o mesmo que o clique usa), não o da conta: o administrador pode ter trocado. */}
                <button type="button" className={account.status === 'ok' ? 'btn small' : 'btn small primary'} disabled={busy} onClick={connect}>
                  {userAuth === 'token' ? 'Trocar token' : 'Entrar de novo'}
                </button>
                <button type="button" className="btn small ghost danger" disabled={busy} onClick={unlink}>
                  Desconectar
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {tokenOpen && <JiraTokenModal onClose={() => setTokenOpen(false)} />}
    </section>
  );
}

function MicrosoftCard({ emailTrusted, account }: { emailTrusted: boolean; account: LinkedAccount | null }) {
  const myEmail = useStore((s) => s.me?.email ?? '');
  const [busy, setBusy] = useState(false);
  const busySync = !!account?.busySync;

  const update = async (v: boolean) => {
    setBusy(true);
    try {
      await linkedApi.update({ provider: 'microsoft', busySync: v });
      await loadIntegrationsMe(true);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="linked-ms-title">
      <div className="card-head">
        <span className="card-icon">
          <Icon name="int-teams" size={20} />
        </span>
        <div>
          <h2 id="linked-ms-title">Microsoft 365</h2>
          {!emailTrusted ? (
            <p>Seu e-mail no chat não foi confirmado pelo administrador. Peça para conferir antes de usar a presença do Teams.</p>
          ) : account ? (
            <p>
              Encontramos sua conta pelo e-mail: <strong>{account.displayName}</strong>
              {account.email && ` (${account.email})`}.
            </p>
          ) : (
            <p>Não encontramos uma conta do Microsoft 365 com o seu e-mail ({myEmail || 'sem e-mail'}).</p>
          )}
          <Toggle
            checked={busySync}
            disabled={!emailTrusted || !account || busy}
            onChange={update}
            label="Ficar como Ocupado no chat quando eu estiver em reunião ou chamada no Teams"
            description="Depois da reunião, o chat volta para o status que você tinha escolhido."
          />
        </div>
      </div>
    </section>
  );
}

export function ConnectedAccounts() {
  const me = useIntegrationsMe();
  useJiraReturn();
  useIntegrationEvents(() => void loadIntegrationsMe(true));

  const showJira = !!me && me.jira.enabled && me.jira.userAuth !== 'off';
  const showMs = !!me && me.msteams.presence;
  return (
    <>
      <PageHead title="Contas conectadas" />
      <p className="page-lead">Conecte suas contas de outros sistemas para o chat agir em seu nome quando você pedir.</p>
      {!me ? (
        <div className="grid-2 int-hub">
          <div className="card">
            <div className="card-head">
              <Skeleton width={36} height={36} />
              <div>
                <Skeleton width={120} height={16} />
                <Skeleton width="80%" height={12} />
              </div>
            </div>
          </div>
        </div>
      ) : !showJira && !showMs ? (
        <Empty icon="int-linked" title="Nenhuma conta para conectar">
          O administrador ainda não ligou integrações que usam a sua conta.
        </Empty>
      ) : (
        <div className="grid-2 int-hub">
          {showJira && <JiraCard userAuth={me.jira.userAuth as 'token' | 'oauth'} createAsIntegration={me.jira.createAsIntegration} account={me.jira.account} />}
          {showMs && <MicrosoftCard emailTrusted={me.msteams.emailTrusted} account={me.msteams.account} />}
        </div>
      )}
    </>
  );
}

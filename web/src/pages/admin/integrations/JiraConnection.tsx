// Integrações (Jira/Teams): Jira → Conexão (§7.3). Salvar chama jira.config.save, que testa quando muda a conexão.
import { useEffect, useId, useState } from 'react';
import type { JiraConfig, JiraConfigInput } from '@shared/integrations';
import { useSetting, useStore } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { Toggle, confirmDialog } from '../../../components/ui';
import { jiraAdmin } from './admin-api';
import { ConnStatus } from './ConnStatus';
import type { JiraTabProps } from './JiraAdmin';
import { CopyBox, Radio, SaveBar, SettingRow, TabBody, fail, isoDay, useDraft, useUnsavedGuard } from './parts';
import { SecretField } from './SecretField';
import './integrations-admin.css';

interface Form {
  siteUrl: string;
  authType: JiraConfig['authType'];
  accountEmail: string;
  apiToken: string | null | undefined;
  apiTokenExpiresAt: string;
  userAuth: JiraConfig['userAuth'];
  oauthClientId: string;
  oauthClientSecret: string | null | undefined;
  createAsIntegration: boolean;
}

const AUTH_HELP: Record<JiraConfig['authType'], string> = {
  scoped: 'Crie em admin.atlassian.com → Diretório → Contas de serviço. Escopos: read:jira-work, write:jira-work e read:jira-user. Deixe o perfil da conta em Português (Brasil).',
  basic: 'Entre no Jira com a conta da integração e crie o token em id.atlassian.com → Segurança → Tokens de API.',
};
const USER_AUTH_HELP: Record<JiraConfig['userAuth'], string> = {
  oauth: 'As pessoas clicam em Entrar com a Atlassian e autorizam o chat. Não precisam copiar tokens, que expiram. Precisa de um aplicativo OAuth 2.0 em developer.atlassian.com.',
  token: 'Cada pessoa cria um token em id.atlassian.com e cola em Minha conta → Contas conectadas. A organização da Atlassian pode bloquear esses tokens.',
  off: 'Ninguém conecta a própria conta. Comentar e atribuir ficam indisponíveis.',
};
const CONNECTION: (keyof Form)[] = ['siteUrl', 'authType', 'accountEmail', 'apiToken', 'apiTokenExpiresAt'];

const baseOf = (c: JiraConfig): Form => ({
  siteUrl: c.siteUrl,
  authType: c.authType,
  accountEmail: c.accountEmail,
  apiToken: undefined,
  apiTokenExpiresAt: isoDay(c.apiToken.expiresAt),
  userAuth: c.userAuth,
  oauthClientId: c.oauthClientId,
  oauthClientSecret: undefined,
  createAsIntegration: c.createAsIntegration,
});

export function JiraConnection({ config, onConfig, onDirty }: JiraTabProps) {
  const siteName = useSetting<string>('Site_Name') || 'Wescc Chat';
  const base = baseOf(config);
  const f = useDraft(base);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  // Remonta os campos de segredo depois de salvar ou descartar (voltam a "Cadastrado").
  const [generation, setGeneration] = useState(0);
  const ids = { site: useId(), email: useId(), token: useId(), expires: useId(), client: useId(), secret: useId() };
  const dirty = f.changed.length > 0;
  useUnsavedGuard(dirty);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const discard = () => {
    f.reset();
    setGeneration((g) => g + 1);
  };

  const save = async (): Promise<boolean> => {
    if (f.isChanged('siteUrl') && config.siteUrl.trim()) {
      const yes = await confirmDialog({
        title: 'Trocar o endereço do Jira?',
        body: 'O token da conta da integração e as contas conectadas das pessoas serão descartados. Será preciso cadastrar o token de novo, e cada pessoa precisará conectar a conta de novo.',
        confirmLabel: 'Trocar endereço',
        danger: true,
      });
      if (!yes) return false;
    }
    const input: JiraConfigInput = {};
    for (const k of f.changed) {
      if (k === 'apiTokenExpiresAt') input.apiTokenExpiresAt = f.get(k) || null;
      else (input as Record<string, unknown>)[k] = f.get(k);
    }
    setSaving(true);
    try {
      const r = await jiraAdmin.save(input);
      onConfig(r.config);
      f.reset();
      setGeneration((g) => g + 1);
      // Mudou a conexão: o servidor já testou. Falhou → o aviso diz isso, não um "salvo" verde ao lado do erro.
      const tested = CONNECTION.some((k) => k in input);
      if (tested && r.config.status.tone === 'err') useStore.getState().toast(`Alterações salvas, mas a conexão falhou: ${r.config.status.text}`, 'warning');
      else useStore.getState().toast('Alterações salvas.', 'success');
      return true;
    } catch (e) {
      fail(e);
      return false;
    } finally {
      setSaving(false);
    }
  };

  // Com alterações na conexão, salvar já testa; o teste em seguida mostra o resultado com o que foi salvo.
  const test = async () => {
    if (dirty && !(await save())) return;
    setTesting(true);
    try {
      await jiraAdmin.test();
      const r = await jiraAdmin.config();
      onConfig(r.config);
    } catch (e) {
      fail(e);
    } finally {
      setTesting(false);
    }
  };

  const userAuth = f.get('userAuth');
  const authType = f.get('authType');
  const connectionDirty = CONNECTION.some((k) => f.isChanged(k));
  return (
    <>
      <TabBody>
        <div className="callout info">
          <Icon name="info" />
          <span>O chat usa uma conta do Jira para ler issues e publicar avisos. Ela só vê o que essa conta vê no Jira. Prefira uma conta de serviço, que não pertence a uma pessoa.</span>
        </div>
        <section className="settings-section" aria-label="Conta da integração">
          <SettingRow
            label="Endereço do Jira"
            htmlFor={ids.site}
            modified={f.isChanged('siteUrl')}
            help="O endereço que você usa para abrir o Jira no navegador. Precisa terminar em .atlassian.net; outro servidor só se liberado pelo responsável pelo servidor do chat."
          >
            <input id={ids.site} type="url" inputMode="url" spellCheck={false} placeholder="https://suaempresa.atlassian.net" value={f.get('siteUrl')} onChange={(e) => f.set('siteUrl', e.target.value)} />
            {config.siteProblem && !f.isChanged('siteUrl') && (
              <div className="callout err">
                <Icon name="error" />
                <span>{config.siteProblem}</span>
              </div>
            )}
          </SettingRow>
          <SettingRow label="Tipo de conta da integração" modified={f.isChanged('authType')} help={AUTH_HELP[authType]} group>
            <Radio name="jira-auth-type" value="scoped" current={authType} onChange={(v) => f.set('authType', v)}>
              Conta de serviço com token com escopos (recomendado)
            </Radio>
            <Radio name="jira-auth-type" value="basic" current={authType} onChange={(v) => f.set('authType', v)}>
              Token de API de uma conta comum
            </Radio>
          </SettingRow>
          <SettingRow label="E-mail da conta da integração" htmlFor={ids.email} modified={f.isChanged('accountEmail')}>
            <input id={ids.email} type="email" spellCheck={false} autoComplete="off" value={f.get('accountEmail')} onChange={(e) => f.set('accountEmail', e.target.value)} />
          </SettingRow>
          <SettingRow label="Token de API" htmlFor={ids.token} modified={f.isChanged('apiToken')} help="O token fica cifrado no servidor. Nunca é mostrado de novo.">
            <SecretField key={`token-${generation}`} id={ids.token} label="Token de API" state={config.apiToken} value={f.get('apiToken')} onChange={(v) => f.set('apiToken', v)} />
          </SettingRow>
          <SettingRow label="Validade do token" htmlFor={ids.expires} modified={f.isChanged('apiTokenExpiresAt')} help="A Atlassian expira os tokens em até um ano. Avisamos 14 dias antes.">
            <input id={ids.expires} type="date" value={f.get('apiTokenExpiresAt')} onChange={(e) => f.set('apiTokenExpiresAt', e.target.value)} />
          </SettingRow>
        </section>
        <div className="settings-extra toggle-list">
          <div className="row-actions wrap">
            <button type="button" className="btn" disabled={testing || saving} onClick={test}>
              <Icon name="int-test" />
              Testar conexão
            </button>
          </div>
          <ConnStatus status={connectionDirty ? null : config.status} testing={testing} />
        </div>

        <section className="settings-section">
          <h3 className="section-title">Contas das pessoas</h3>
          <SettingRow label="Como cada pessoa conecta a própria conta" modified={f.isChanged('userAuth')} help={USER_AUTH_HELP[userAuth]} group>
            <Radio name="jira-user-auth" value="oauth" current={userAuth} onChange={(v) => f.set('userAuth', v)}>
              Entrar com a Atlassian (OAuth 2.0, recomendado)
            </Radio>
            <Radio name="jira-user-auth" value="token" current={userAuth} onChange={(v) => f.set('userAuth', v)}>
              Token de API pessoal
            </Radio>
            <Radio name="jira-user-auth" value="off" current={userAuth} onChange={(v) => f.set('userAuth', v)}>
              Ninguém conecta (só a conta da integração)
            </Radio>
          </SettingRow>
          {userAuth === 'oauth' && (
            <>
              {config.oauthProblem && (
                <div className="callout warn">
                  <Icon name="warning" />
                  <span>{config.oauthProblem}</span>
                </div>
              )}
              <SettingRow label="Client ID" htmlFor={ids.client} modified={f.isChanged('oauthClientId')}>
                <input id={ids.client} spellCheck={false} autoComplete="off" className="mono" value={f.get('oauthClientId')} onChange={(e) => f.set('oauthClientId', e.target.value)} />
              </SettingRow>
              <SettingRow label="Client secret" htmlFor={ids.secret} modified={f.isChanged('oauthClientSecret')}>
                <SecretField
                  key={`oauth-${generation}`}
                  id={ids.secret}
                  label="Client secret"
                  state={config.oauthClientSecret}
                  value={f.get('oauthClientSecret')}
                  onChange={(v) => f.set('oauthClientSecret', v)}
                />
              </SettingRow>
              <SettingRow
                label="Endereço de retorno"
                help="Cadastre este endereço no aplicativo (Autorização → OAuth 2.0 (3LO)) e ative a distribuição para as pessoas do seu site. Um endereço https interno da empresa serve."
              >
                <CopyBox value={config.oauthRedirectUri} label="Endereço de retorno" />
              </SettingRow>
            </>
          )}
          <SettingRow
            label="Criar issues pela conta da integração"
            modified={f.isChanged('createAsIntegration')}
            help={`A issue mostra “Criada por Nome (@usuário) pelo ${siteName}.”. Comentar e atribuir sempre usam a conta da própria pessoa.`}
          >
            <Toggle checked={f.get('createAsIntegration')} onChange={(v) => f.set('createAsIntegration', v)} label="Quem não conectou a conta cria issues pela conta da integração" />
          </SettingRow>
        </section>
      </TabBody>
      <SaveBar count={f.changed.length} saving={saving} onDiscard={discard} onSave={() => void save()} />
    </>
  );
}

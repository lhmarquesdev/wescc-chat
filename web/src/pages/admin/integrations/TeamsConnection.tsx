// Integrações (Jira/Teams): Microsoft Teams → Conexão (§7.4): aplicativo do Entra, teste, o que já funciona e a
// conta de serviço que lê os canais.
import { useEffect, useId, useState } from 'react';
import type { TeamsConfig, TeamsConfigInput } from '@shared/integrations';
import { useSetting } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { confirmDialog } from '../../../components/ui';
import { TableWrap } from '../parts';
import { teamsAdmin } from './admin-api';
import { ConnStatus } from './ConnStatus';
import { Breakable, CopyBox, Disclosure, SaveBar, SettingRow, TabBody, done, fail, isoDay, useDraft, useUnsavedGuard } from './parts';
import { SecretField } from './SecretField';
import type { TeamsTabProps } from './TeamsAdmin';
import './integrations-admin.css';

// As linhas do teste começam com o nome do recurso (FEATURES no servidor) e " · ".
const FEATURES = ['Avisos para o Teams', 'Mensagens do Teams', 'Criar reunião na hora', 'Presença'];
const featureOf = (line: string) => FEATURES.find((f) => line.startsWith(`${f} · `)) ?? null;

export const EMAIL_CHANGE_TEXT =
  'Pessoas podem trocar o próprio e-mail no chat. Desligue Permitir alterar e-mail (Administração → Configurações → Contas) antes de usar Criar agora e a presença: o chat encontra a conta do Microsoft 365 de cada pessoa pelo e-mail.';
// O teste do servidor repete esse aviso (CONFIG_TEXT.emailChange), numa linha própria e como motivo de Criar reunião
// e Presença. Com a caixa do topo na tela, a linha própria some e o motivo só aponta para ela.
const SERVER_EMAIL_LINE = 'Pessoas podem trocar o próprio e-mail no chat.';
const EMAIL_REASON = 'Desligue Permitir alterar e-mail (veja o aviso no topo).';

const PERMISSIONS: [string, string, string, string][] = [
  ['User.Read, offline_access, Team.ReadBasic.All, Channel.ReadBasic.All, ChannelMessage.Read.All', 'Delegada', 'Ler canais do Teams', 'Administrador de Aplicativos'],
  ['Presence.Read.All', 'Delegada', 'Presença por assinatura', 'Administrador de Aplicativos'],
  ['User.Read.All', 'Aplicativo', 'Encontrar a conta de cada pessoa', 'Administrador de Função Privilegiada ou Global'],
  ['OnlineMeetings.ReadWrite.All', 'Aplicativo', 'Criar reuniões na hora', 'Administrador de Função Privilegiada ou Global'],
  ['Presence.Read.All', 'Aplicativo', 'Ler a presença', 'Administrador de Função Privilegiada ou Global'],
];

interface Form {
  tenantId: string;
  clientId: string;
  clientSecret: string | null | undefined;
  clientSecretExpiresAt: string;
}

const baseOf = (c: TeamsConfig): Form => ({ tenantId: c.tenantId, clientId: c.clientId, clientSecret: undefined, clientSecretExpiresAt: isoDay(c.clientSecret.expiresAt) });

function Features({ lines, emailNote }: { lines: string[]; emailNote: boolean }) {
  if (!lines.length) return null;
  return (
    <div className="settings-extra toggle-list">
      <h3 className="sub-title">O que já funciona</h3>
      <div className="toggle-list" role="list">
        {lines.map((l) => {
          const name = featureOf(l) as string;
          const rest = l.slice(name.length + 3);
          const ready = rest.startsWith('Pronto');
          // A pílula já diz "Pronto": o texto segue sem repetir a palavra.
          const detail = ready ? rest.replace(/^Pronto[.:]?\s*/, '') : emailNote && rest.startsWith(SERVER_EMAIL_LINE) ? EMAIL_REASON : rest;
          // wrap: o texto que não cabe ao lado da pílula desce inteiro para a linha de baixo (celular), em vez de
          // quebrar numa coluna estreita que começa num ponto diferente em cada item.
          return (
            <div key={l} className="row-actions wrap" role="listitem">
              <span className={ready ? 'pill ok' : 'pill warn'}>{ready ? 'Pronto' : 'Falta configurar'}</span>
              <span>
                <strong>{name}</strong>
                {detail && ` · ${detail.charAt(0).toUpperCase()}${detail.slice(1)}`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TeamsConnection({ config, onConfig, onDirty }: TeamsTabProps) {
  const siteName = useSetting<string>('Site_Name') || 'Wescc Chat';
  const f = useDraft(baseOf(config));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [signing, setSigning] = useState(false);
  const [generation, setGeneration] = useState(0);
  const ids = { tenant: useId(), client: useId(), secret: useId(), expires: useId() };
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
    const input: TeamsConfigInput = {};
    for (const k of f.changed) {
      if (k === 'clientSecretExpiresAt') input.clientSecretExpiresAt = f.get(k) || null;
      else (input as Record<string, unknown>)[k] = f.get(k);
    }
    setSaving(true);
    try {
      const r = await teamsAdmin.save(input);
      onConfig(r.config);
      f.reset();
      setGeneration((g) => g + 1);
      done('Alterações salvas.');
      return true;
    } catch (e) {
      fail(e);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (dirty && !(await save())) return;
    setTesting(true);
    try {
      const r = await teamsAdmin.test();
      onConfig(r.config);
    } catch (e) {
      fail(e);
    } finally {
      setTesting(false);
    }
  };

  const signIn = async () => {
    setSigning(true);
    try {
      const { url } = await teamsAdmin.serviceStart('/admin/integrations/teams/conexao');
      location.assign(url);
    } catch (e) {
      fail(e);
      setSigning(false);
    }
  };

  const unlink = async () => {
    const yes = await confirmDialog({
      title: 'Desconectar a conta de serviço?',
      body: 'As mensagens do Teams param de chegar ao chat até alguém entrar de novo.',
      confirmLabel: 'Desconectar',
      danger: true,
    });
    if (!yes) return;
    try {
      await teamsAdmin.serviceUnlink();
      done('Conta de serviço desconectada.');
    } catch (e) {
      fail(e);
      return;
    }
    // O estado e "O que já funciona" vêm do último teste, guardado no servidor: sem a conta, testa de novo (como na
    // volta do login) para não continuar dizendo que as mensagens do Teams estão prontas.
    setTesting(true);
    try {
      const r = await teamsAdmin.test();
      onConfig(r.config);
    } catch {
      const r = await teamsAdmin.config().catch(() => null);
      if (r) onConfig(r.config);
    } finally {
      setTesting(false);
    }
  };

  const svc = config.serviceAccount;
  const appSaved = !!config.tenantId && !!config.clientId && config.clientSecret.set;
  // O Entra só aceita https ou http://localhost, e a volta do login cai na origem do endereço de retorno: com a nota,
  // entrar só funciona aberto nessa mesma origem (outra porta do localhost também perde a sessão na volta).
  const redirectOrigin = (() => {
    try {
      return new URL(config.serviceRedirectUri).origin;
    } catch {
      return null;
    }
  })();
  const redirectBlocked = !!config.serviceRedirectNote && location.origin !== redirectOrigin;
  const signInBlocked = !appSaved || redirectBlocked || !config.enabled;
  const statusLines = config.status.details ?? [];
  const featureLines = statusLines.filter((l) => featureOf(l));
  const appDirty = f.changed.length > 0;

  const signInButton = (primary: boolean, label: string) => (
    <button type="button" className={primary ? 'btn small primary' : 'btn small'} disabled={signInBlocked || signing} onClick={signIn}>
      {label}
    </button>
  );

  return (
    <>
      <TabBody>
        <div className="callout info">
          <Icon name="info" />
          <span>
            O envio de mensagens para o Teams funciona sem esta conexão: cada regra usa um fluxo do Workflows. A conexão serve para ler canais do Teams, criar reuniões e mostrar presença.
          </span>
        </div>
        {config.emailChangeAllowed && (
          <div className="callout warn">
            <Icon name="warning" />
            <span>{EMAIL_CHANGE_TEXT}</span>
          </div>
        )}

        <section className="settings-section">
          <h3 className="section-title">Aplicativo no Microsoft Entra</h3>
          <SettingRow label="ID do locatário (tenant ID)" htmlFor={ids.tenant} modified={f.isChanged('tenantId')}>
            <input id={ids.tenant} className="mono" spellCheck={false} autoComplete="off" value={f.get('tenantId')} onChange={(e) => f.set('tenantId', e.target.value)} />
          </SettingRow>
          <SettingRow label="ID do aplicativo (client ID)" htmlFor={ids.client} modified={f.isChanged('clientId')}>
            <input id={ids.client} className="mono" spellCheck={false} autoComplete="off" value={f.get('clientId')} onChange={(e) => f.set('clientId', e.target.value)} />
          </SettingRow>
          <SettingRow label="Segredo do aplicativo (client secret)" htmlFor={ids.secret} modified={f.isChanged('clientSecret')} help="Copie o Valor do segredo, não o ID.">
            <SecretField
              key={`secret-${generation}`}
              id={ids.secret}
              label="Segredo do aplicativo"
              state={config.clientSecret}
              value={f.get('clientSecret')}
              onChange={(v) => f.set('clientSecret', v)}
            />
          </SettingRow>
          <SettingRow label="Validade do segredo" htmlFor={ids.expires} modified={f.isChanged('clientSecretExpiresAt')}>
            <input id={ids.expires} type="date" value={f.get('clientSecretExpiresAt')} onChange={(e) => f.set('clientSecretExpiresAt', e.target.value)} />
          </SettingRow>
          <SettingRow label="Endereço de retorno">
            <CopyBox value={config.serviceRedirectUri} label="Endereço de retorno" />
            {config.serviceRedirectNote && (
              <div className="callout warn">
                <Icon name="warning" />
                <span>
                  <Breakable text={config.serviceRedirectNote} />
                </span>
              </div>
            )}
          </SettingRow>
        </section>

        <Disclosure label="Como criar o aplicativo">
          <ol className="int-steps">
            <li>
              <p>Em entra.microsoft.com, abra Identidade → Aplicativos → Registros de aplicativo → Novo registro.</p>
            </li>
            <li>
              <p>Nome: {siteName} (chat). Tipos de conta: somente este diretório. URI de redirecionamento: Web, com o endereço de retorno acima.</p>
            </li>
            <li>
              <p>Em Certificados e segredos, crie um segredo do cliente e copie o Valor.</p>
            </li>
            <li>
              <p>
                Em Permissões de API → Adicionar → Microsoft Graph, inclua as permissões da tabela e clique em Conceder consentimento do administrador. As permissões de aplicativo só podem ser
                consentidas por um Administrador de Função Privilegiada ou Administrador Global.
              </p>
            </li>
          </ol>
          <TableWrap>
            <table className="table stack kv">
              <thead>
                <tr>
                  <th>Permissão</th>
                  <th>Tipo</th>
                  <th>Para quê</th>
                  <th>Quem consente</th>
                </tr>
              </thead>
              <tbody>
                {PERMISSIONS.map(([perm, kind, what, who]) => (
                  <tr key={`${perm}-${kind}`}>
                    <td className="mono small">{perm}</td>
                    <td data-label="Tipo">{kind}</td>
                    <td data-label="Para quê">{what}</td>
                    <td data-label="Quem consente">{who}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Disclosure>

        <div className="settings-extra toggle-list">
          <div className="row-actions wrap">
            <button type="button" className="btn" disabled={testing || saving} onClick={test}>
              <Icon name="int-test" />
              Testar conexão
            </button>
          </div>
          <ConnStatus status={appDirty ? null : config.status} testing={testing} hide={(l) => !!featureOf(l) || (config.emailChangeAllowed && l.startsWith(SERVER_EMAIL_LINE))} />
        </div>
        {!appDirty && !testing && <Features lines={featureLines} emailNote={config.emailChangeAllowed} />}

        <section className="settings-section">
          <h3 className="section-title">Conta de serviço</h3>
          <p className="setting-desc">
            Para ler canais do Teams, o chat usa uma conta do Microsoft 365 com licença do Teams que participa das equipes. Entre com ela uma vez; o acesso fica cifrado no servidor. Use uma conta cuja senha
            não expira, liberada pelo Acesso Condicional para uso a partir do servidor.
          </p>
          {svc.linked ? (
            <div className="toggle-list">
              <div className="row-actions wrap">
                <span>
                  Conectada como <strong>{svc.displayName || svc.upn}</strong>
                  {svc.upn && svc.displayName ? ` (${svc.upn})` : ''}
                </span>
                {svc.status.tone === 'err' ? <span className="pill err">Com erro</span> : <span className="pill ok">Conectada</span>}
              </div>
              {svc.status.tone === 'err' && <span className="small neg">{svc.status.text}</span>}
              <div className="row-actions wrap">
                {signInButton(svc.status.tone === 'err', 'Entrar de novo')}
                <button type="button" className="btn small ghost danger" onClick={unlink}>
                  Desconectar
                </button>
              </div>
              {redirectBlocked && (
                <span className="small muted">
                  <Breakable text={config.serviceRedirectNote} />
                </span>
              )}
            </div>
          ) : (
            <div className="toggle-list">
              <div className="row-actions wrap">
                <button type="button" className="btn primary" disabled={signInBlocked || signing} onClick={signIn}>
                  <Icon name="tokens" />
                  Entrar com a conta de serviço
                </button>
              </div>
              {!appSaved ? (
                <span className="small muted">Salve o ID do locatário, o ID do aplicativo e o segredo antes de entrar.</span>
              ) : !config.enabled ? (
                <span className="small muted">Ative a integração no topo da página antes de entrar.</span>
              ) : redirectBlocked ? (
                <span className="small muted">
                  <Breakable text={config.serviceRedirectNote} />
                </span>
              ) : null}
            </div>
          )}
        </section>
      </TabBody>
      <SaveBar count={f.changed.length} saving={saving} onDiscard={discard} onSave={() => void save()} />
    </>
  );
}

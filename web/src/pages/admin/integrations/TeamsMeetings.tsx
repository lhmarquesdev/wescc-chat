// Integrações (Jira/Teams): Microsoft Teams → Reuniões (§7.4): colar link, agendar pelo Teams ou criar na hora (com a
// política de acesso do aplicativo, que só um administrador do Teams libera).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ConnectorStatus, TeamsConfig } from '@shared/integrations';
import { roleLabel } from '../../../lib/format';
import { usePermission } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { Skeleton, useAsync } from '../../../components/ui';
import { permissionsApi, teamsAdmin } from './admin-api';
import { ConnStatus } from './ConnStatus';
import { Radio, SaveBar, SettingRow, TabBody, done, fail, useCopied, useDraft, useUnsavedGuard } from './parts';
import { TeamsOffNote, type TeamsTabProps } from './TeamsAdmin';
import { EMAIL_CHANGE_TEXT } from './TeamsConnection';
import './integrations-admin.css';

type Mode = TeamsConfig['meetingsMode'];
type Lobby = TeamsConfig['meetingLobby'];

const MODE_HELP: Record<Mode, string> = {
  off: 'A opção de reunião some das salas.',
  links: 'As pessoas colam o link de uma reunião ou abrem o Teams com o formulário preenchido. Não precisa de configuração.',
  graph:
    'O chat cria a reunião no Microsoft 365 em nome de quem pediu (não entra na agenda do Outlook). Precisa da permissão OnlineMeetings.ReadWrite.All, de uma política do Teams (abaixo) e de e-mails confirmados no chat.',
};
const LOBBY: { id: Lobby; label: string }[] = [
  { id: 'organization', label: 'Pessoas da organização' },
  { id: 'everyone', label: 'Todos' },
  { id: 'organizer', label: 'Só o organizador' },
];
const MINUTES = [15, 30, 45, 60, 90, 120];

const policyScript = (clientId: string) =>
  [
    'Connect-MicrosoftTeams',
    `New-CsApplicationAccessPolicy -Identity "Wescc-Reunioes" -AppIds "${clientId || '{clientId}'}" -Description "Reunioes criadas pelo chat"`,
    'Grant-CsApplicationAccessPolicy -PolicyName "Wescc-Reunioes" -Identity "supervisor@empresa.com"',
  ].join('\n');

function CodeCopy({ code, label }: { code: string; label: string }) {
  const [copied, copy] = useCopied();
  return (
    // <code> em bloco (o .code-block já mantém as linhas inteiras): sem as margens do <pre>, fora da grade de 4 px.
    <div className="toggle-list" role="group" aria-label={label}>
      <code className="code-block block">{code}</code>
      <div>
        <button type="button" className="btn small" onClick={() => void copy(code)}>
          <Icon name={copied ? 'check' : 'copy'} />
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>
    </div>
  );
}

export function TeamsMeetings({ config, onConfig, onDirty }: TeamsTabProps) {
  const f = useDraft<{ meetingsMode: Mode; meetingLobby: Lobby; meetingMinutes: number }>({
    meetingsMode: config.meetingsMode,
    meetingLobby: config.meetingLobby,
    meetingMinutes: config.meetingMinutes,
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectorStatus | null>(null);
  const canPerms = usePermission('access-permissions');
  const perms = useAsync(() => permissionsApi.list().then((r) => r.update), []);
  const dirty = f.changed.length > 0;
  useUnsavedGuard(dirty);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const mode = f.get('meetingsMode');

  const save = async () => {
    setSaving(true);
    try {
      const r = await teamsAdmin.save(Object.fromEntries(f.changed.map((k) => [k, f.get(k)])));
      onConfig(r.config);
      f.reset();
      done('Alterações salvas.');
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const r = await teamsAdmin.meetingTest();
      setResult({ tone: r.ok ? 'ok' : 'err', text: r.text, checkedAt: new Date().toISOString(), details: [] });
    } catch (e) {
      fail(e);
    } finally {
      setTesting(false);
    }
  };

  const roles = perms.data?.find((p) => p._id === 'start-msteams-meeting')?.roles ?? [];

  return (
    <>
      <TabBody>
        {config.emailChangeAllowed && mode === 'graph' && (
          <div className="callout warn">
            <Icon name="warning" />
            <span>{EMAIL_CHANGE_TEXT}</span>
          </div>
        )}
        {/* Sem título: logo depois das abas (ou do aviso), com o mesmo espaço das outras abas. */}
        <section aria-label="Reuniões">
          <SettingRow label="Reuniões do Teams nas salas" modified={f.isChanged('meetingsMode')} help={MODE_HELP[mode]} group>
            <Radio name="teams-meetings-mode" value="off" current={mode} onChange={(v) => f.set('meetingsMode', v)}>
              Desligado
            </Radio>
            <Radio name="teams-meetings-mode" value="links" current={mode} onChange={(v) => f.set('meetingsMode', v)}>
              Colar link e agendar pelo Teams
            </Radio>
            <Radio name="teams-meetings-mode" value="graph" current={mode} onChange={(v) => f.set('meetingsMode', v)}>
              Também criar a reunião na hora
            </Radio>
          </SettingRow>
          {mode === 'graph' && (
            <SettingRow label="Quem entra direto, sem sala de espera" htmlFor="teams-meeting-lobby" modified={f.isChanged('meetingLobby')}>
              <select id="teams-meeting-lobby" value={f.get('meetingLobby')} onChange={(e) => f.set('meetingLobby', e.target.value as Lobby)}>
                {LOBBY.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </SettingRow>
          )}
          {mode !== 'off' && (
            <SettingRow label="Duração padrão" htmlFor="teams-meeting-minutes" modified={f.isChanged('meetingMinutes')}>
              <select id="teams-meeting-minutes" value={f.get('meetingMinutes')} onChange={(e) => f.set('meetingMinutes', Number(e.target.value))}>
                {MINUTES.map((n) => (
                  <option key={n} value={n}>
                    {n} minutos
                  </option>
                ))}
              </select>
            </SettingRow>
          )}
          <SettingRow label="Quem pode marcar reuniões">
            {perms.loading && !perms.data ? (
              <Skeleton width={200} height={14} />
            ) : perms.data ? (
              <span>{roles.length ? roles.map(roleLabel).join(', ') : 'ninguém'}</span>
            ) : (
              <span className="muted small">Não foi possível ler as permissões.</span>
            )}
            {/* Botão pequeno: no celular a área de toque chega a 44 px (um link de texto teria 16). */}
            {canPerms && (
              <Link to="/admin/permissions" className="btn small">
                Alterar em Papéis e permissões
              </Link>
            )}
          </SettingRow>
        </section>

        {mode === 'graph' && (
          <section className="card settings-extra" aria-labelledby="teams-policy-title">
            <div className="card-head">
              <div>
                <h2 id="teams-policy-title">Liberar o aplicativo para criar reuniões</h2>
                <p className="card-desc">
                  Um administrador do Teams roda estes comandos no PowerShell (módulo MicrosoftTeams). Libere só as pessoas que vão criar reuniões, por exemplo os supervisores:
                </p>
              </div>
            </div>
            <div className="form">
              <CodeCopy code={policyScript(config.clientId)} label="Comandos do PowerShell" />
              <span className="small muted">
                Repita a última linha para cada pessoa. A política pode levar até 30 minutos para valer. Liberar todos com -Global é possível, mas não recomendado.
              </span>
              {config.enabled ? (
                <div className="toggle-list">
                  <div className="row-actions wrap">
                    <button type="button" className="btn" disabled={testing || dirty} onClick={test}>
                      <Icon name="int-test" />
                      Testar criação
                    </button>
                    {dirty && <span className="small muted">Salve as alterações antes de testar.</span>}
                  </div>
                  <ConnStatus status={result} testing={testing} />
                </div>
              ) : (
                <TeamsOffNote />
              )}
            </div>
          </section>
        )}
      </TabBody>
      <SaveBar count={f.changed.length} saving={saving} onDiscard={f.reset} onSave={() => void save()} />
    </>
  );
}

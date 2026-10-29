// Administração › Integrações › Agenda: liga a conexão de cada pessoa com o Google Agenda e com o Outlook/Teams.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CalendarAdminConfig, CalendarProvider } from '@shared/calendar';
import { api } from '../../../lib/api';
import { plural } from '../../../lib/format';
import { GoogleIcon, MicrosoftIcon } from '../../../components/BrandIcons';
import { Icon } from '../../../components/Icon';
import { Skeleton, Toggle, useAsync } from '../../../components/ui';
import { SecretField } from './SecretField';
import { CopyBox, Disclosure, LoadError, SaveBar, SettingRow, SubHead, TabBody, done, fail, useUnsavedGuard } from './parts';
import './integrations-admin.css';

interface Summary {
  provider: CalendarProvider;
  total: number;
  problems: number;
}
type Loaded = { config: CalendarAdminConfig; accounts: Summary[] };

const SYNC_CHOICES = [1, 2, 5, 10, 15, 30, 60];

function usage(s: Summary | undefined) {
  if (!s?.total) return 'Ninguém conectou ainda.';
  return `${plural(s.total, 'pessoa conectada', 'pessoas conectadas')}${s.problems ? ` · ${plural(s.problems, 'precisa', 'precisam')} conectar de novo` : ''}`;
}

export function CalendarAdmin() {
  const { data, error, reload } = useAsync<Loaded>(() => api.get('calendar.admin.config'), []);
  const [base, setBase] = useState<Loaded | null>(null);
  useEffect(() => {
    if (data) setBase(data);
  }, [data]);
  const cfg = base?.config;
  const [googleOn, setGoogleOn] = useState<boolean | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null | undefined>(undefined);
  const [msOn, setMsOn] = useState<boolean | null>(null);
  const [minutes, setMinutes] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const g = googleOn ?? !!cfg?.google.enabled;
  const id = clientId ?? cfg?.google.clientId ?? '';
  const m = msOn ?? !!cfg?.microsoft.enabled;
  const mins = minutes ?? cfg?.syncMinutes ?? 5;
  const changes = cfg
    ? [g !== cfg.google.enabled, id !== cfg.google.clientId, typeof secret === 'string' && !!secret, m !== cfg.microsoft.enabled, mins !== cfg.syncMinutes].filter(Boolean).length
    : 0;
  useUnsavedGuard(changes > 0);
  const discard = () => (setGoogleOn(null), setClientId(null), setSecret(undefined), setMsOn(null), setMinutes(null));

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.post<Loaded>('calendar.admin.save', {
        googleEnabled: g,
        googleClientId: id,
        ...(typeof secret === 'string' && secret ? { googleClientSecret: secret } : {}),
        microsoftEnabled: m,
        syncMinutes: mins,
      });
      setBase(r);
      discard();
      done('Agenda salva.');
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  };

  const teamsReady = !!cfg && !!cfg.microsoft.tenantId && !!cfg.microsoft.clientId && cfg.microsoft.secretSet;
  const sum = (p: CalendarProvider) => base?.accounts.find((a) => a.provider === p);

  return (
    <TabBody>
      <SubHead title="Agenda" tone={null} enabled={null} onToggle={() => {}} />
      <p className="page-lead">
        Cada pessoa conecta a própria agenda em <Link to="/calendar">Agenda</Link> e escolhe o sentido: trazer os eventos para o chat, levar os do chat para lá, ou os dois. Aqui você libera os
        fornecedores.
      </p>
      {error && !base ? (
        <LoadError text={error} onRetry={reload} />
      ) : !cfg ? (
        <div className="card">
          <Skeleton height={120} />
        </div>
      ) : (
        <div className="int-hub">
          <section className="card int-cal-card">
            <div className="card-head">
              <span className="card-icon">
                <GoogleIcon size={20} />
              </span>
              <div>
                <h2>Google Agenda</h2>
                <p className="muted small">{usage(sum('google'))}</p>
              </div>
              <Toggle checked={g} onChange={setGoogleOn} label="Permitir" />
            </div>
            <SettingRow label="ID do cliente OAuth" help="Google Cloud Console › APIs e serviços › Credenciais › ID do cliente OAuth (aplicativo da Web)." htmlFor="cal-g-id">
              <input id="cal-g-id" value={id} placeholder="123456-abc.apps.googleusercontent.com" spellCheck={false} onChange={(e) => setClientId(e.target.value)} />
            </SettingRow>
            <SettingRow label="Chave secreta do cliente" help="Fica cifrada no servidor e nunca volta para a tela.">
              <SecretField state={{ set: cfg.google.secretSet }} value={secret} onChange={setSecret} placeholder="GOCSPX-…" label="Chave secreta do cliente" />
            </SettingRow>
            <SettingRow label="URI de redirecionamento autorizado" help="Cole exatamente este endereço no cliente OAuth do Google.">
              <CopyBox value={cfg.google.redirectUri} label="URI de redirecionamento do Google" />
            </SettingRow>
            <Disclosure label="Como criar o cliente no Google">
              <ol className="int-steps">
                <li>No Google Cloud Console, crie (ou escolha) um projeto e ative a Google Calendar API.</li>
                <li>
                  Em Tela de permissão OAuth, escolha <strong>Interno</strong> (só contas da sua empresa) e adicione o escopo <code>calendar.events</code>.
                </li>
                <li>Em Credenciais, crie um ID do cliente OAuth do tipo Aplicativo da Web e cole a URI de redirecionamento acima.</li>
                <li>Copie o ID e a chave secreta para cá e ligue Permitir.</li>
              </ol>
            </Disclosure>
          </section>

          <section className="card int-cal-card">
            <div className="card-head">
              <span className="card-icon">
                <MicrosoftIcon size={20} />
              </span>
              <div>
                <h2>Outlook / Microsoft Teams</h2>
                <p className="muted small">{usage(sum('microsoft'))}</p>
              </div>
              <Toggle checked={m} onChange={setMsOn} disabled={!teamsReady && !m} label="Permitir" />
            </div>
            {!teamsReady && (
              <div className="callout warn">
                <Icon name="info" />
                <span>
                  Usa o mesmo aplicativo do Microsoft Entra do Teams. Preencha antes o locatário, o ID e o segredo em <Link to="/admin/integrations/teams">Integrações › Microsoft Teams</Link>.
                </span>
              </div>
            )}
            <SettingRow label="Aplicativo" help="O do Teams. Cada pessoa entra com a própria conta Microsoft e autoriza só a agenda dela.">
              <span className="mono small">{cfg.microsoft.clientId || '—'}</span>
            </SettingRow>
            <SettingRow label="URI de redirecionamento" help="Adicione em Autenticação › Web no aplicativo do Entra.">
              <CopyBox value={cfg.microsoft.redirectUri} label="URI de redirecionamento da Microsoft" />
            </SettingRow>
            <Disclosure label="Permissões que o aplicativo precisa">
              <ol className="int-steps">
                <li>
                  Em Permissões de API › Microsoft Graph › <strong>Permissões delegadas</strong>, adicione <code>Calendars.ReadWrite</code>, <code>User.Read</code> e <code>offline_access</code>.
                </li>
                <li>Conceda o consentimento do administrador para a organização (ou deixe cada pessoa aceitar ao conectar).</li>
                <li>Em Autenticação, adicione a URI acima como plataforma Web.</li>
              </ol>
            </Disclosure>
          </section>

          <section className="card">
            <SettingRow label="Sincronizar a cada" help="Mudanças feitas no chat vão na hora; o que muda no Google ou no Outlook chega nesse intervalo.">
              <select value={mins} onChange={(e) => setMinutes(Number(e.target.value))}>
                {SYNC_CHOICES.map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? '1 minuto' : `${n} minutos`}
                  </option>
                ))}
              </select>
            </SettingRow>
          </section>
        </div>
      )}
      <SaveBar count={changes} saving={saving} onDiscard={discard} onSave={() => void save()} />
    </TabBody>
  );
}

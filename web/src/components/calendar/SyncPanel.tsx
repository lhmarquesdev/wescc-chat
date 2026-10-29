// Agendas conectadas: Google Agenda e Outlook/Teams, cada uma com o sentido da sincronização (trazer, levar ou os dois).
import { useEffect, useState } from 'react';
import type { CalendarProvider, CalendarProviderInfo, SyncDirection } from '@shared/calendar';
import { DIRECTION_LABEL, PROVIDER_LABEL } from '@shared/calendar';
import { errorMessage } from '../../lib/api';
import { calendarApi } from '../../lib/calendar';
import { formatRelative } from '../../lib/format';
import { realtime } from '../../lib/realtime';
import { useStore } from '../../lib/store';
import { GoogleIcon, MicrosoftIcon } from '../BrandIcons';
import { Icon } from '../Icon';
import { confirmDialog, Modal, Segmented, Skeleton } from '../ui';
import './calendar.css';

const DIRECTION_HELP: Record<SyncDirection, (p: string) => string> = {
  both: (p) => `Seus eventos do ${p} aparecem aqui e os do chat vão para o ${p}.`,
  import: (p) => `Seus eventos do ${p} aparecem aqui (só leitura). Nada do chat vai para lá.`,
  export: (p) => `Os eventos e reuniões do chat vão para o ${p}. Nada de lá aparece aqui.`,
};
const DIRECTIONS: { id: SyncDirection; label: string; icon: 'cal-direction' | 'prev' | 'next' }[] = [
  { id: 'both', label: 'Nos dois sentidos', icon: 'cal-direction' },
  { id: 'import', label: 'Trazer para o chat', icon: 'prev' },
  { id: 'export', label: 'Levar do chat', icon: 'next' },
];

function Brand({ provider }: { provider: CalendarProvider }) {
  return <span className="cal-brand">{provider === 'google' ? <GoogleIcon size={20} /> : <MicrosoftIcon size={20} />}</span>;
}

export function useCalendarAccounts() {
  const [providers, setProviders] = useState<CalendarProviderInfo[] | null>(null);
  const reload = () => void calendarApi.accounts().then(setProviders).catch(() => setProviders([]));
  useEffect(() => {
    reload();
    const off = realtime.on((ev) => {
      if (ev.type === 'calendar.changed') reload();
    });
    return () => void off();
  }, []);
  return { providers, setProviders, reload };
}

// Escolher o sentido antes de sair para o Google/Microsoft.
function ConnectModal({ provider, onClose }: { provider: CalendarProvider; onClose: () => void }) {
  const [direction, setDirection] = useState<SyncDirection>('both');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = PROVIDER_LABEL[provider];
  const go = async () => {
    setBusy(true);
    try {
      const { url } = await calendarApi.connect(provider, direction);
      location.assign(url);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Conectar ${label}`}
      onClose={onClose}
      size="sm"
      description={`Você entra com a sua conta ${provider === 'google' ? 'Google' : 'Microsoft'} e autoriza o chat a ler e gravar eventos da sua agenda principal.`}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn primary" aria-busy={busy || undefined} disabled={busy} onClick={() => void go()}>
            Continuar no {provider === 'google' ? 'Google' : 'Microsoft'}
          </button>
        </>
      }
    >
      <div className="form">
        <div className="field">
          <span className="field-label">Sentido da sincronização</span>
          <div className="cal-dir-options" role="radiogroup" aria-label="Sentido da sincronização">
            {DIRECTIONS.map((d) => (
              <button key={d.id} type="button" role="radio" aria-checked={direction === d.id} className={direction === d.id ? 'cal-dir on' : 'cal-dir'} onClick={() => setDirection(d.id)}>
                <Icon name={d.icon} size={18} />
                <span>
                  <strong>{d.label}</strong>
                  <small>{DIRECTION_HELP[d.id](label)}</small>
                </span>
              </button>
            ))}
          </div>
          <span className="field-hint">Dá para trocar depois, sem conectar de novo.</span>
        </div>
        {error && (
          <div className="form-error" role="alert">
            <Icon name="error" size={16} />
            <span>{error}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}

function AccountRow({ info, onProviders }: { info: CalendarProviderInfo; onProviders: (p: CalendarProviderInfo[]) => void }) {
  const toast = useStore((s) => s.toast);
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const label = PROVIDER_LABEL[info.provider];
  const a = info.account;

  const change = async (d: SyncDirection) => {
    setBusy('dir');
    try {
      await calendarApi.direction(info.provider, d);
      onProviders(await calendarApi.accounts());
      toast(`${label}: ${DIRECTION_LABEL[d].toLowerCase()}.`, 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  const syncNow = async () => {
    setBusy('sync');
    try {
      const r = await calendarApi.syncNow(info.provider);
      onProviders(r.providers);
      if (r.result.error) toast(r.result.error, 'error');
      else toast(`${label} sincronizado.`, 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  const disconnect = async () => {
    const ok = await confirmDialog({
      title: `Desconectar o ${label}?`,
      body: 'Os eventos trazidos de lá saem da agenda do chat, e as cópias de eventos futuros do chat são apagadas de lá.',
      confirmLabel: 'Desconectar',
      danger: true,
    });
    if (!ok) return;
    setBusy('off');
    try {
      await calendarApi.disconnect(info.provider);
      onProviders(await calendarApi.accounts());
      toast(`${label} desconectado.`, 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
      setBusy(null);
    }
  };

  if (!a)
    return (
      <li className="cal-account">
        <Brand provider={info.provider} />
        <div className="cal-account-text">
          <strong>{label}</strong>
          <small className="muted">{info.available ? 'Não conectado' : 'O administrador ainda não liberou'}</small>
        </div>
        {info.available && (
          <button type="button" className="btn small" onClick={() => setConnecting(true)}>
            Conectar
          </button>
        )}
        {connecting && <ConnectModal provider={info.provider} onClose={() => setConnecting(false)} />}
      </li>
    );

  const problem = a.status !== 'ok';
  return (
    <li className={problem ? 'cal-account problem' : 'cal-account'}>
      <Brand provider={info.provider} />
      <div className="cal-account-text">
        <strong>{label}</strong>
        <small className="muted ellipsis" title={a.email}>
          {a.email || a.displayName}
        </small>
        {problem ? (
          <small className="cal-account-problem">
            <Icon name="error" size={12} />
            {a.statusText ?? 'A conexão precisa de atenção.'}
          </small>
        ) : (
          <small className="muted">{a.lastSyncAt ? `Sincronizado ${formatRelative(a.lastSyncAt)}` : 'Sincronizando…'}</small>
        )}
      </div>
      <div className="cal-account-actions">
        {a.status === 'expired' ? (
          <button type="button" className="btn small primary" onClick={() => setConnecting(true)}>
            Conectar de novo
          </button>
        ) : (
          <button type="button" className="icon-btn" title="Sincronizar agora" aria-label="Sincronizar agora" aria-busy={busy === 'sync' || undefined} disabled={!!busy} onClick={() => void syncNow()}>
            <Icon name="cal-sync" size={16} />
          </button>
        )}
        <button type="button" className="icon-btn" title="Desconectar" aria-label="Desconectar" disabled={!!busy} onClick={() => void disconnect()}>
          <Icon name="cal-disconnect" size={16} />
        </button>
      </div>
      <div className="cal-account-dir">
        <Segmented label={`Sentido da sincronização com o ${label}`} value={a.direction} onChange={(d) => void change(d)} items={DIRECTIONS.map((d) => ({ id: d.id, label: d.id === 'both' ? 'Os dois' : d.id === 'import' ? 'Trazer' : 'Levar' }))} />
        <small className="muted">{DIRECTION_HELP[a.direction](label)}</small>
      </div>
      {connecting && <ConnectModal provider={info.provider} onClose={() => setConnecting(false)} />}
    </li>
  );
}

export function SyncPanel({ providers, onProviders }: { providers: CalendarProviderInfo[] | null; onProviders: (p: CalendarProviderInfo[]) => void }) {
  return (
    <section className="cal-side-card" aria-labelledby="cal-sync-title">
      <h2 id="cal-sync-title">
        <Icon name="cal-sync" size={16} />
        Agendas conectadas
      </h2>
      {!providers ? (
        <div className="cal-account-sk">
          <Skeleton height={36} />
          <Skeleton height={36} />
        </div>
      ) : (
        <ul className="cal-accounts">
          {providers.map((p) => (
            <AccountRow key={p.provider} info={p} onProviders={onProviders} />
          ))}
        </ul>
      )}
    </section>
  );
}

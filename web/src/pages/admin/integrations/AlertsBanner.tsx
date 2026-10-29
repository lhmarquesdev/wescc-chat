// Integrações (Jira/Teams): alertas abertos (conexão com erro, token perto de expirar, fluxo parado…) e os avisos da
// chave de segredos (§7.2).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Provider } from '@shared/integrations';
import { formatDateTime, formatWhen } from '../../../lib/format';
import { Icon } from '../../../components/Icon';
import { useAsync } from '../../../components/ui';
import { coreAdmin, type IntegrationsOverview } from './admin-api';
import { useIntegrationEvents } from './parts';
import './integrations-admin.css';

// Avisos da chave de segredos (integrations.overview). Valem para todas as integrações: aparecem no hub e nas páginas
// do Jira e do Teams.
export function SecretsKeyNotices({ secretsKey: key, paused }: { secretsKey?: IntegrationsOverview['secretsKey']; paused?: boolean }) {
  return (
    <>
      {key?.source === 'none' && (
        <div className="callout err" role="alert">
          <Icon name="error" />
          <span>
            O servidor não tem a chave de segredos das integrações. Sem ela, nenhum token pode ser salvo. O responsável pelo servidor precisa definir SECRETS_KEY_FILE com o caminho completo de um arquivo de
            chave e reiniciar o serviço.
          </span>
        </div>
      )}
      {key?.problem && (
        <div className="callout err" role="alert">
          <Icon name="error" />
          <span>{key.problem}</span>
        </div>
      )}
      {paused && (
        <div className="callout err" role="alert">
          <Icon name="error" />
          <span>As integrações estão paradas: a chave de segredos deste servidor é diferente da usada pelos outros. Use a mesma SECRETS_KEY em todos.</span>
        </div>
      )}
    </>
  );
}

// Nas páginas do Jira e do Teams: os mesmos avisos da chave que o hub mostra.
export function SecretsKeyBanner() {
  const { data, reload } = useAsync(() => coreAdmin.overview(), []);
  useIntegrationEvents(reload);
  return <SecretsKeyNotices secretsKey={data?.secretsKey} paused={data?.paused} />;
}

// "Desde 14:05", "Desde ontem 09:12", "Desde 20/10 18:30": a hora do começo numa linha própria, fora da frase do
// alerta ("desde agora" logo depois de um ponto final não se lê bem).
const since = (iso: string) => `Desde ${formatWhen(iso).replace(/^Ontem/, 'ontem')}`;

// O alerta secrets.key nunca entra aqui: ele repete os avisos da chave (SecretsKeyNotices), e o servidor o manda com
// provider 'jira', então sumiria das páginas do Teams.
export function AlertsBanner({ provider }: { provider?: Provider }) {
  const { data, reload } = useAsync(() => coreAdmin.alerts(), []);
  useIntegrationEvents(reload);
  const [all, setAll] = useState(false);
  const list = (data?.alerts ?? []).filter((a) => a.key !== 'secrets.key' && (!provider || a.provider === provider)).sort((a, b) => Number(b.tone === 'err') - Number(a.tone === 'err'));
  if (!list.length) return null;
  // Os que passam de 3 abrem aqui mesmo: a Atividade lista tarefas, não alertas.
  const shown = all ? list : list.slice(0, 3);
  const rest = list.length - 3;
  return (
    <>
      {shown.map((a) => (
        <div key={a.key} className={a.tone === 'err' ? 'callout err' : 'callout warn'} role={a.tone === 'err' ? 'alert' : undefined}>
          <Icon name={a.tone === 'err' ? 'error' : 'warning'} />
          <span>
            {a.text}
            <time className="block small muted" dateTime={a.since} title={formatDateTime(a.since)}>
              {since(a.since)}
            </time>
          </span>
          {a.href && (
            <Link className="btn small callout-action" to={a.href}>
              Abrir
            </Link>
          )}
        </div>
      ))}
      {rest > 0 && (
        <p className="small">
          <button type="button" className="btn small ghost" aria-expanded={all} onClick={() => setAll((v) => !v)}>
            {all ? 'Mostrar menos' : rest === 1 ? 'e mais 1 alerta' : `e mais ${rest} alertas`}
          </button>
        </p>
      )}
    </>
  );
}

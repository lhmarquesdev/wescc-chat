// Integrações (Jira/Teams): página inicial de Administração → Integrações (§7.2).
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Tone } from '@shared/integrations';
import { plural } from '../../../lib/format';
import { usePermission, useSetting, useStore } from '../../../lib/store';
import type { IconName } from '../../../components/icons';
import { Icon } from '../../../components/Icon';
import { Skeleton, useAsync } from '../../../components/ui';
import { useIsPhone } from '../../../components/overlay';
import { PageHead } from '../parts';
import { coreAdmin } from './admin-api';
import { AlertsBanner, SecretsKeyNotices } from './AlertsBanner';
import { INLINE_SKELETON, StatusPill, useIntegrationEvents } from './parts';
import './integrations-admin.css';

const ACK_KEY = 'wescc.integrations.secretsKeyAck';

function readAck() {
  try {
    return localStorage.getItem(ACK_KEY) === '1';
  } catch {
    return false;
  }
}

// Cartão inteiro é o link: ícone à esquerda, texto, e o estado no canto (no celular, embaixo do texto, para não
// apertar o título). tone null = carregando: o lugar do selo já fica reservado.
function HubCard({ to, icon, title, children, meta, tone }: { to: string; icon: IconName; title: string; children: ReactNode; meta: ReactNode; tone?: Tone | null }) {
  const phone = useIsPhone();
  const pill = tone === undefined ? null : tone ? <StatusPill tone={tone} /> : <Skeleton width={72} height={20} />;
  return (
    <Link to={to} className="card action">
      <div className="card-head">
        <span className="card-icon">
          <Icon name={icon} size={20} />
        </span>
        <div>
          <h2>{title}</h2>
          <p>{children}</p>
          {meta && <small>{meta}</small>}
          {phone && pill}
        </div>
        {!phone && pill}
      </div>
    </Link>
  );
}

export function Hub() {
  const siteName = useSetting<string>('Site_Name') || 'Wescc Chat';
  const canJira = usePermission('manage-jira');
  const canTeams = usePermission('manage-msteams');
  const canAllHooks = usePermission('manage-integrations');
  const canHooks = usePermission(['manage-integrations', 'manage-own-integrations']);
  const isAdmin = useStore((s) => !!s.me?.roles?.includes('admin'));
  // Quem só gerencia os próprios webhooks não lê a visão geral (403): o cartão aparece sem os números.
  const canOverview = canJira || canTeams || canAllHooks;
  const { data, error, reload } = useAsync(() => (canOverview ? coreAdmin.overview() : Promise.resolve(null)), [canOverview]);
  useIntegrationEvents(reload);
  const [acked, setAcked] = useState(readAck);
  const key = data?.secretsKey;
  const loading = canOverview && !data && !error;
  const meta = (text: string | null) => (loading ? <Skeleton width={120} height={12} style={INLINE_SKELETON} /> : text);

  const ack = () => {
    setAcked(true);
    try {
      localStorage.setItem(ACK_KEY, '1');
    } catch {
      // armazenamento indisponível: some só até recarregar
    }
  };

  return (
    <>
      <PageHead title="Integrações" />
      <p className="page-lead">Conecte o {siteName} a outros sistemas. Cada integração só faz o que você ligar aqui.</p>
      <SecretsKeyNotices secretsKey={key} paused={data?.paused} />
      {/* Com a chave com problema, o arquivo citado não guarda chave nenhuma: o lembrete do backup confundiria. */}
      {key?.source === 'file' && !key.problem && isAdmin && !acked && (
        <div className="callout warn">
          <Icon name="tokens" />
          <span>
            Os tokens das integrações são cifrados com a chave guardada em <code>{key.file ?? 'arquivo de chave'}</code>. Faça uma cópia desse arquivo fora do servidor, separada do backup do banco: sem ela, será
            preciso cadastrar os tokens de novo.
          </span>
          <button type="button" className="btn small ghost callout-action" onClick={ack}>
            Entendi
          </button>
        </div>
      )}
      {canOverview && <AlertsBanner />}
      <div className="grid-2 int-hub">
        {canJira && (
          <HubCard
            to="/admin/integrations/jira"
            icon="int-jira"
            title="Jira"
            tone={data ? (data.jira.enabled ? data.jira.status.tone : 'off') : loading ? null : undefined}
            meta={meta(data ? (data.jira.rules ? plural(data.jira.rules, 'regra de aviso', 'regras de aviso') : 'Nenhuma regra') : null)}
          >
            Avisos de issues nos canais, prévias, criar issues a partir de mensagens e o comando /jira.
          </HubCard>
        )}
        {canTeams && (
          <HubCard
            to="/admin/integrations/teams"
            icon="int-teams"
            title="Microsoft Teams"
            tone={data ? (data.msteams.enabled ? data.msteams.status.tone : 'off') : loading ? null : undefined}
            meta={meta(data ? `${plural(data.msteams.outRules, 'envio', 'envios')} · ${plural(data.msteams.inRules, 'recebimento', 'recebimentos')}` : null)}
          >
            Mensagens entre salas do chat e canais do Teams, e reuniões do Teams nas salas.
          </HubCard>
        )}
        {canHooks && (
          <HubCard
            to="/admin/integrations/webhooks"
            icon="int-webhook"
            title="Webhooks"
            meta={canOverview ? meta(data ? `${data.webhooks.incoming.toLocaleString('pt-BR')} de entrada · ${data.webhooks.outgoing.toLocaleString('pt-BR')} de saída` : null) : null}
          >
            Webhooks de entrada e de saída para outros sistemas, no formato do Slack.
          </HubCard>
        )}
      </div>
    </>
  );
}

// Integrações (Jira/Teams): estado da conexão e as linhas do último teste (§7.7).
import type { ConnectorStatus } from '@shared/integrations';
import { formatDateTime, formatRelative } from '../../../lib/format';
import { Icon } from '../../../components/Icon';
import { Spinner } from '../../../components/ui';
import { StatusPill } from './parts';
import './integrations-admin.css';

type LineTone = 'ok' | 'warn' | 'err' | 'info';

// As linhas chegam do servidor como texto, sem o tom de cada uma. Os passos que deram certo têm começo fixo
// (CONFIG_TEXT.account/projects no Jira; appRoles/serviceLinked/serviceScopes no Teams); a dica da lista de IPs é só
// informação. O resto segue o estado do teste: num teste com avisos ou com erro, é a linha que causou o selo.
const OK_LINE = [/^Conta da integração: /, /^A conta da integração vê /, /^Permissões do aplicativo: /, /^Conta de serviço: /, /^Permissões da conta de serviço: /];
const INFO_LINE = [/^Se a organização da Atlassian usa lista de IPs permitidos/];

export function lineTone(line: string, status: ConnectorStatus['tone']): LineTone {
  if (OK_LINE.some((r) => r.test(line))) return 'ok';
  if (INFO_LINE.some((r) => r.test(line))) return 'info';
  if (status === 'warn' || status === 'err') return status;
  return status === 'ok' ? 'ok' : 'info';
}

export function ConnStatus({ status, testing, hide }: { status: ConnectorStatus | null | undefined; testing?: boolean; hide?: (line: string) => boolean }) {
  if (testing)
    return (
      <div className="toggle-list" role="status" aria-live="polite">
        <div className="row-actions">
          <Spinner size="sm" />
          <span>Testando…</span>
        </div>
      </div>
    );
  if (!status) return null;
  // Num erro o servidor repete a falha nas linhas: ela já está ao lado do selo, não precisa aparecer duas vezes.
  const lines = (status.details ?? []).filter((l) => !hide?.(l) && !(status.tone !== 'ok' && l === status.text)).map((text) => ({ text, tone: lineTone(text, status.tone) }));
  const facts = lines.filter((l) => l.tone === 'ok' || l.tone === 'info');
  const problems = lines.filter((l) => l.tone === 'warn' || l.tone === 'err');
  return (
    <div className="toggle-list" role="status" aria-live="polite">
      <div className="row-actions wrap">
        {status.tone !== 'off' && <StatusPill tone={status.tone} />}
        <span className={status.tone === 'off' ? 'muted' : undefined}>{status.text}</span>
      </div>
      {facts.length > 0 && (
        <div className="toggle-list" role="list" aria-label="Resultado do teste">
          {facts.map((l, i) => (
            <div key={i} className="row-actions" role="listitem" data-tone={l.tone}>
              <Icon name={l.tone === 'ok' ? 'success' : 'info'} className={l.tone === 'ok' ? 'pos' : 'muted'} />
              <span>{l.text}</span>
            </div>
          ))}
        </div>
      )}
      {/* O que causou "Atenção" ou "Com erro" fica destacado, com o ícone e a cor do tom. */}
      {problems.map((l, i) => (
        <div key={i} className={`callout ${l.tone}`} data-tone={l.tone}>
          <Icon name={l.tone === 'err' ? 'error' : 'warning'} />
          <span>{l.text}</span>
        </div>
      ))}
      {status.checkedAt && (
        <span className="small muted" title={formatDateTime(status.checkedAt)}>
          Testado {formatRelative(status.checkedAt)}
        </span>
      )}
    </div>
  );
}

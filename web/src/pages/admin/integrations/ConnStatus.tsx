// Integrações (Jira/Teams): estado da conexão e as linhas do último teste (§7.7).
import type { CSSProperties } from 'react';
import type { ConnectorStatus } from '@shared/integrations';
import { formatDateTime, formatRelative } from '../../../lib/format';
import { Icon, type IconName } from '../../../components/Icon';
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

// §7.7: as linhas são uma lista; o tom vem no ícone de 14 px (sucesso --ok, atenção --warn, erro --danger), o texto
// fica na cor normal. O ícone fica no meio da primeira linha (altura de linha de 14 px), mesmo quando o texto quebra.
const TONE_ICON: Record<LineTone, { icon: IconName; color: string; label?: string }> = {
  ok: { icon: 'success', color: 'var(--ok)' },
  warn: { icon: 'warning', color: 'var(--warn)', label: 'Atenção' },
  err: { icon: 'error', color: 'var(--danger)', label: 'Erro' },
  info: { icon: 'info', color: 'var(--fg-muted)' },
};
const LINE: CSSProperties = { alignItems: 'flex-start', fontSize: 'var(--fs-14)', lineHeight: 'var(--lh-14)' };
const LINE_ICON: CSSProperties = { display: 'inline-flex', alignItems: 'center', flexShrink: 0, height: 'var(--lh-14)' };
const LINE_TEXT: CSSProperties = { minWidth: 0, overflowWrap: 'anywhere' };

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
  return (
    <div className="toggle-list" role="status" aria-live="polite">
      <div className="row-actions wrap">
        {status.tone !== 'off' && <StatusPill tone={status.tone} />}
        <span className={status.tone === 'off' ? 'muted' : undefined}>{status.text}</span>
      </div>
      {lines.length > 0 && (
        <div className="toggle-list" role="list" aria-label="Resultado do teste">
          {lines.map((l, i) => {
            const t = TONE_ICON[l.tone];
            return (
              <div key={i} className="row-actions" role="listitem" data-tone={l.tone} style={LINE}>
                <span style={{ ...LINE_ICON, color: t.color }}>
                  <Icon name={t.icon} size={14} label={t.label} />
                </span>
                <span style={LINE_TEXT}>{l.text}</span>
              </div>
            );
          })}
        </div>
      )}
      {status.checkedAt && (
        <span className="small muted" title={formatDateTime(status.checkedAt)}>
          Testado {formatRelative(status.checkedAt)}
        </span>
      )}
    </div>
  );
}

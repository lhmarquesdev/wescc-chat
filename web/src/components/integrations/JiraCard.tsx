// Cartão de issue do Jira (.att-jira): avisos do Jira, prévias, compartilhamentos e issues criadas pelo chat.
// O resumo é texto puro vindo do servidor (safeExternalText): o cartão nunca interpreta markdown do Jira.
import { useState, type CSSProperties } from 'react';
import type { Message } from '@shared/index';
import type { JiraIssueSnapshot, MessageJira } from '@shared/integrations';
import { errorMessage } from '../../lib/api';
import { formatTime } from '../../lib/format';
import { JIRA_STATUS, JIRA_TYPE_ICON, jiraApi, openIntegrationModal, useIntegrationsMe } from '../../lib/integrations';
import { canWithRoles, useStore } from '../../lib/store';
import { Icon, type IconName } from '../Icon';
import { PHONE_QUERY, useMedia } from '../overlay';
import { Tooltip } from '../ui';
import './integrations.css';

const SNAPSHOT_TIP = 'Status quando a mensagem foi enviada';
// Sem hover (toque) ou no celular as ações ficam à vista numa linha própria, com o rótulo; com mouse, só o ícone.
const TOUCH_QUERY = `(hover: none), (pointer: coarse), ${PHONE_QUERY}`;
const LATE_MS = 2 * 60 * 1000;
const dayMonth = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });

// " · no Jira às 14:05", ou " · no Jira em 21/10 às 14:05" quando foi em outro dia.
function lateSuffix(postedAt: string, at: string): string {
  const posted = new Date(postedAt);
  const happened = new Date(at);
  if (!(posted.getTime() - happened.getTime() > LATE_MS)) return '';
  const time = formatTime(at);
  return posted.toDateString() === happened.toDateString() ? ` · no Jira às ${time}` : ` · no Jira em ${dayMonth.format(happened)} às ${time}`;
}

export function JiraCard({ jira, message, compact, onShare }: { jira: MessageJira; message?: Message; compact?: boolean; onShare?: (key: string) => void }) {
  const me = useStore((s) => s.me);
  const sub = useStore((s) => (message ? s.subscriptions[message.rid] : undefined));
  const im = useIntegrationsMe();
  const [removing, setRemoving] = useState(false);
  const own = !!message && !!me && message.u._id === me._id;
  // Autor ou quem edita mensagens na sala (o mesmo critério do servidor em jira.preview.remove).
  const canRemove = jira.kind === 'preview' && !!message && !!me && (own || canWithRoles('edit-message', [...me.roles, ...(sub?.roles ?? [])]));

  const remove = async () => {
    if (!message) return;
    setRemoving(true);
    try {
      await jiraApi.removePreview(message._id);
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
      setRemoving(false);
    }
  };

  const linked = !!im?.jira.enabled && im.jira.canUse && !!im.jira.account;
  const issues = jira.issues;
  return (
    <div className="att-jira-stack">
      {issues.map((issue) => (
        <IssueCard
          key={issue.key}
          issue={issue}
          jira={jira}
          message={message}
          compact={compact}
          onShare={onShare}
          canComment={linked}
          canAssignMe={linked && (!issue.assignee?.username || issue.assignee.username !== me?.username)}
        />
      ))}
      {canRemove && (
        <button type="button" className="icon-btn" aria-label="Remover prévia" title="Remover prévia" disabled={removing} onClick={() => void remove()}>
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}

// Ação do cartão. Com mouse: botão de ícone com a dica e o rótulo como nome acessível; cabe ao lado da linha 3 e só
// aparece no hover e no foco. No toque e no celular: o .btn.small.ghost com o rótulo à vista.
function CardAction({ icon, label, labelled, href, busy, onClick }: { icon: IconName; label: string; labelled: boolean; href?: string; busy?: boolean; onClick?: () => void }) {
  const content = labelled ? (
    <>
      <Icon name={icon} size={14} />
      {label}
    </>
  ) : (
    <Icon name={icon} size={16} />
  );
  const props = labelled ? { className: 'btn small ghost' } : { className: 'icon-btn', 'aria-label': label };
  const el = href ? (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer">
      {content}
    </a>
  ) : (
    <button type="button" {...props} disabled={busy} aria-busy={busy || undefined} onClick={onClick}>
      {content}
    </button>
  );
  return labelled ? (
    el
  ) : (
    <Tooltip label={label} placement="top">
      {el}
    </Tooltip>
  );
}

function IssueCard({
  issue,
  jira,
  message,
  compact,
  onShare,
  canComment,
  canAssignMe,
}: {
  issue: JiraIssueSnapshot;
  jira: MessageJira;
  message?: Message;
  compact?: boolean;
  onShare?: (key: string) => void;
  canComment: boolean;
  canAssignMe: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const labelled = useMedia(TOUCH_QUERY);
  const st = JIRA_STATUS[issue.status.category] ?? JIRA_STATUS.new;
  const style = { '--att-jira-bar': st.bar } as CSSProperties;
  const by = jira.by ? jira.by.name || jira.by.username : null;
  const event = jira.kind === 'event' ? jira.event : undefined;
  const meta = [issue.priority?.name, issue.assignee?.displayName || 'Sem responsável', issue.project.name].filter(Boolean).join(' · ');
  const late = event && message ? lateSuffix(message.ts, event.at) : '';
  const pill = (
    <span className={st.pill}>
      <Icon name={st.icon} size={12} />
      {issue.status.name}
    </span>
  );

  const assignMe = async () => {
    setBusy(true);
    try {
      const r = await jiraApi.assign(issue.key, 'me');
      useStore.getState().toast(`${r.issue.key} agora está com você.`, 'success');
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const showActions = !compact && !!message;
  const metaRow = (
    <div className="att-jira-meta">
      {meta}
      {late}
    </div>
  );
  return (
    <div className="att-jira" style={style}>
      {jira.kind === 'created' && by && (
        <div className="att-jira-meta">
          Issue criada por {by}
          {jira.viaIntegration ? ' pela conta da integração' : ''}
        </div>
      )}
      <div className="att-jira-row">
        <Icon name={JIRA_TYPE_ICON[issue.type.kind] ?? 'jira-type-other'} size={16} label={issue.type.name} />
        <a className="att-jira-key" href={issue.url} target="_blank" rel="noopener noreferrer">
          {issue.key}
        </a>
        {/* Retratos não se atualizam: a dica explica que o status é o do momento do envio. */}
        {compact ? pill : <Tooltip label={SNAPSHOT_TIP}>{pill}</Tooltip>}
      </div>
      {/* O span leva o corte em 2 linhas; o link em volta pode crescer a área de toque sem mostrar uma 3ª linha. */}
      <a className="att-jira-summary" href={issue.url} target="_blank" rel="noopener noreferrer">
        <span>{issue.summary}</span>
      </a>
      {event?.comment && <div className="quote-att">{event.comment.excerpt}</div>}
      {showActions ? (
        // Linha 3 e ações lado a lado: as ações guardam o próprio espaço (só aparecem no hover e no foco), então nunca
        // cobrem o texto nem mudam a altura do cartão.
        <div className="att-jira-row">
          {metaRow}
          <div className="att-jira-actions">
            <CardAction icon="open-external" label="Abrir no Jira" labelled={labelled} href={issue.url} />
            {canComment && (
              <CardAction
                icon="jira-comment"
                label="Comentar"
                labelled={labelled}
                onClick={() => openIntegrationModal({ modal: 'jira-comment', rid: message.rid, tmid: message.tmid ?? null, params: { key: issue.key, ...(issue.project.serviceDesk ? { serviceDesk: '1' } : {}) } })}
              />
            )}
            {canAssignMe && <CardAction icon="jira-assign-me" label="Atribuir a mim" labelled={labelled} busy={busy} onClick={() => void assignMe()} />}
            {onShare && <CardAction icon="send" label="Compartilhar na sala" labelled={labelled} onClick={() => onShare(issue.key)} />}
          </div>
        </div>
      ) : (
        metaRow
      )}
    </div>
  );
}

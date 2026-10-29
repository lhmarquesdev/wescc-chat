// Resposta que só a pessoa vê (/jira, /teams, avisos das integrações): moldura tracejada, "Só você vê isto" e
// "Dispensar". Nunca conta como não lida e não entra no agrupamento das mensagens.
import type { EphemeralAction, EphemeralMessage, JiraIssueSnapshot } from '@shared/integrations';
import { api, errorMessage } from '../../lib/api';
import { dismissEphemeral, getEphemeralAction, setEphemeralAction, useEphemeralActions } from '../../lib/ephemeral';
import { formatDateTime, formatTime } from '../../lib/format';
import { canRunApiAction, openIntegrationModal, shareIssueWithConfirm, useIntegrationsMe } from '../../lib/integrations';
import { renderMarkdown } from '../../lib/markdown';
import { useStore } from '../../lib/store';
import { Icon } from '../Icon';
import { JiraCard } from './JiraCard';
import './integrations.css';

const SOURCE = {
  jira: { name: 'Jira', icon: 'int-jira' },
  msteams: { name: 'Microsoft Teams', icon: 'int-teams' },
} as const;

const toast = (text: string, kind: 'success' | 'error' | 'info' = 'info') => useStore.getState().toast(text, kind);

// Link de uma ação: só https, como o servidor já filtra (javascript:, http: e endereços quebrados não abrem).
function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

// O que o chat sabe executar: link https, modal, ou um endpoint da lista que o servidor também confere.
const runnable = (a: EphemeralAction) => (a.kind === 'url' ? isHttps(a.url) : a.kind === 'modal' || canRunApiAction(a.endpoint));

export function EphemeralRow({ m }: { m: EphemeralMessage }) {
  const me = useStore((s) => s.me);
  const im = useIntegrationsMe();
  // Ocupado e feito ficam na loja das efêmeras: a linha é montada de novo quando muda de lugar entre as mensagens.
  const st = useEphemeralActions(m._id);
  const src = SOURCE[m.source] ?? SOURCE.jira;
  // Comentar e Atribuir pedem conta vinculada; sem o modo de conta pessoal ligado, os botões nem aparecem.
  const personal = !!im?.jira.enabled && (im.jira.userAuth !== 'off' || !!im.jira.account);

  const run = async (a: EphemeralAction, i: number) => {
    const key = `a:${i}`;
    if (!runnable(a) || getEphemeralAction(m._id, key)) return;
    if (a.kind === 'url') {
      window.open(a.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (a.kind === 'modal') {
      openIntegrationModal({ modal: a.modal, rid: m.rid, tmid: m.tmid ?? null, params: a.params, ephemeralId: m._id });
      return;
    }
    setEphemeralAction(m._id, key, 'busy');
    let ok = false;
    try {
      if (a.endpoint === 'jira.issue.share' && a.body.confirmed !== true) {
        ok = (await shareIssueWithConfirm(String(a.body.key ?? ''), String(a.body.roomId ?? m.rid), (a.body.tmid as string | undefined) ?? m.tmid ?? null)) !== null;
      } else {
        const r = await api.post<{ issue?: JiraIssueSnapshot }>(a.endpoint, a.body);
        if (a.endpoint === 'jira.issue.assign' && r.issue) {
          toast(r.issue.assignee ? `${r.issue.key} agora está com ${r.issue.assignee.displayName}.` : `${r.issue.key} ficou sem responsável.`, 'success');
        }
        ok = true;
      }
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setEphemeralAction(m._id, key, ok ? 'done' : null);
    }
  };

  // Compartilhar um cartão da lista: uma vez só; depois o botão vira "Compartilhada" (e continua com o foco).
  const share = async (issueKey: string) => {
    const key = `share:${issueKey}`;
    if (getEphemeralAction(m._id, key)) return;
    setEphemeralAction(m._id, key, 'busy');
    let ok = false;
    try {
      ok = (await shareIssueWithConfirm(issueKey, m.rid, m.tmid ?? null)) !== null;
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setEphemeralAction(m._id, key, ok ? 'done' : null);
    }
  };

  const actions = (m.actions ?? []).slice(0, 3);
  const shown = actions.some((a, i) => runnable(a) && st[`a:${i}`] !== 'done');
  return (
    <div className="msg ephemeral" data-tone={m.tone} role="note" aria-label="Resposta que só você vê">
      <div className="msg-left">
        <span aria-hidden="true">
          <Icon name={src.icon} size={18} />
        </span>
      </div>
      <div className="msg-main">
        <div className="msg-head">
          <strong>{src.name}</strong>
          <span className="pill ephemeral-pill">Só você vê isto</span>
          <time className="msg-time" dateTime={m.ts} title={formatDateTime(m.ts)}>
            {formatTime(m.ts)}
          </time>
        </div>
        {m.text && (
          <div className="msg-body">
            {m.tone === 'warn' && <Icon name="warning" size={16} />}
            {m.tone === 'err' && <Icon name="error" size={16} />}
            <div>{renderMarkdown(m.text, { me: me?.username })}</div>
          </div>
        )}
        {!!m.issues?.length && (
          <div className="att-jira-stack">
            {m.issues.slice(0, 10).map((issue) => (
              <div key={issue.key}>
                <JiraCard jira={{ kind: 'share', site: '', issues: [issue] }} compact />
                {m.issueActions && (
                  <div className="att-jira-actions">
                    <button
                      type="button"
                      className="btn small ghost"
                      aria-disabled={st[`share:${issue.key}`] ? true : undefined}
                      aria-busy={st[`share:${issue.key}`] === 'busy' || undefined}
                      onClick={() => void share(issue.key)}
                    >
                      <Icon name={st[`share:${issue.key}`] === 'done' ? 'check' : 'send'} size={14} />
                      {st[`share:${issue.key}`] === 'done' ? 'Compartilhada' : 'Compartilhar na sala'}
                    </button>
                    {personal && (
                      <button
                        type="button"
                        className="btn small ghost"
                        onClick={() => openIntegrationModal({ modal: 'jira-comment', rid: m.rid, tmid: m.tmid ?? null, params: { key: issue.key, ...(issue.project.serviceDesk ? { serviceDesk: '1' } : {}) } })}
                      >
                        <Icon name="jira-comment" size={14} />
                        Comentar
                      </button>
                    )}
                    {personal && (
                      <button type="button" className="btn small ghost" onClick={() => openIntegrationModal({ modal: 'jira-assign', rid: m.rid, tmid: m.tmid ?? null, params: { key: issue.key } })}>
                        <Icon name="account" size={14} />
                        Atribuir
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {shown && (
          <div className="row-actions">
            {actions.map((a, i) =>
              !runnable(a) || st[`a:${i}`] === 'done' ? null : (
                <button
                  key={i}
                  type="button"
                  className={'primary' in a && a.primary ? 'btn small primary' : 'btn small'}
                  disabled={st[`a:${i}`] === 'busy'}
                  aria-busy={st[`a:${i}`] === 'busy' || undefined}
                  onClick={() => void run(a, i)}
                >
                  {a.kind === 'url' && <Icon name="open-external" size={14} />}
                  {a.label}
                </button>
              ),
            )}
          </div>
        )}
      </div>
      <button type="button" className="icon-btn" aria-label="Dispensar" title="Dispensar" onClick={() => dismissEphemeral(m.rid, m._id)}>
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

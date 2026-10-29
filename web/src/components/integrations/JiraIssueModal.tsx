// Criar issue no Jira a partir da sala ou de uma mensagem (Mais → Integrações, /jira criar). Sem conta vinculada,
// o passo de conectar acontece aqui mesmo e o formulário volta com o resumo digitado.
import { lazy, Suspense, useEffect, useId, useMemo, useState } from 'react';
import type { Message } from '@shared/index';
import type { JiraCreateMeta, JiraFieldMeta, JiraProjectRef } from '@shared/integrations';
import { api, ApiError, errorMessage } from '../../lib/api';
import { JIRA_TYPE_ICON, jiraApi, loadIntegrationsMe, useIntegrationsMe, type IntegrationModalRequest } from '../../lib/integrations';
import { useStore } from '../../lib/store';
import { Icon } from '../Icon';
import { useIsPhone } from '../overlay';
import { Field, Modal, Skeleton } from '../ui';
import { settleEphemeralRequest } from '../../lib/ephemeral';
import { fieldControlId, fieldDefault, fieldProblems, FormError, JiraFieldInputs, PersonSearch, type PersonPick } from './JiraFieldInputs';
import './integrations.css';

// O passo de conectar só carrega quando é pedido (o mesmo pedaço que IntegrationModals e Contas conectadas usam).
const JiraTokenModal = lazy(() => import('../../pages/account/JiraTokenModal').then((m) => ({ default: m.JiraTokenModal })));

const LAST_PROJECT = 'jira.lastProject';
const readLast = () => {
  try {
    return localStorage.getItem(LAST_PROJECT) ?? '';
  } catch {
    return '';
  }
};
const saveLast = (key: string) => {
  try {
    localStorage.setItem(LAST_PROJECT, key);
  } catch {
    // armazenamento indisponível
  }
};

// Primeira linha da mensagem, sem marcação, até 120 caracteres.
function firstLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  const plain = line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`>#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...plain].length > 120 ? `${[...plain].slice(0, 119).join('')}…` : plain;
}

// Citação recolhida: 3 linhas, até 240 caracteres.
function shortQuote(text: string): string {
  const lines = text.split('\n').slice(0, 3).join('\n');
  const cut = [...lines].length > 240 ? `${[...lines].slice(0, 239).join('')}…` : lines;
  return cut + (text.split('\n').length > 3 && !cut.endsWith('…') ? '…' : '');
}

const isTask = (t: { kind: string; name: string }) => t.kind === 'task' || /^(tarefa|task)$/i.test(t.name);

// Números com vírgula decimal saem com ponto (a mesma leitura que o servidor faz).
function normalized(fields: JiraFieldMeta[], value: Record<string, unknown>): Record<string, unknown> {
  const out = { ...value };
  for (const f of fields) if (f.kind === 'number' && typeof out[f.key] === 'string') out[f.key] = (out[f.key] as string).trim().replace(',', '.');
  return out;
}

export default function JiraIssueModal({ req, onClose }: { req: IntegrationModalRequest; onClose: () => void }) {
  const me = useIntegrationsMe();
  const phone = useIsPhone();
  const rid = req.params?.roomId || req.rid;
  const tmid = req.params?.tmid || req.tmid || null;
  const fromList = useStore((s) => (req.messageId ? (s.messages[rid]?.list.find((m) => m._id === req.messageId) ?? (tmid ? s.threads[tmid]?.find((m) => m._id === req.messageId) : undefined)) : undefined));
  const [source, setSource] = useState<Message | null>(fromList ?? null);
  const [projects, setProjects] = useState<JiraProjectRef[] | null>(null);
  const [identity, setIdentity] = useState<'user' | 'integration' | 'none' | null>(null);
  const [projectKey, setProjectKey] = useState('');
  const [projectQuery, setProjectQuery] = useState('');
  const showFilter = !!projects && (projects.length > 15 || !!projectQuery);
  const [meta, setMeta] = useState<JiraCreateMeta | null>(null);
  const [typeId, setTypeId] = useState('');
  const [summary, setSummary] = useState(req.params?.summary ?? '');
  const [description, setDescription] = useState('');
  const [priorityId, setPriorityId] = useState('');
  const [assignee, setAssignee] = useState<PersonPick>({ kind: 'none' });
  const [extra, setExtra] = useState<Record<string, unknown>>({});
  const [reply, setReply] = useState<boolean | null>(null);
  const [linking, setLinking] = useState(false);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Falha ao carregar projetos ou tipos: fica no alto do formulário, com "Tentar de novo".
  const [loadError, setLoadError] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  // Depois da primeira tentativa de criar, os campos com problema ficam marcados (e desmarcam enquanto a pessoa corrige).
  const [attempted, setAttempted] = useState(false);
  const ids = useId();

  // Mensagem de origem que não está carregada (link antigo, outra página do histórico).
  useEffect(() => {
    if (source || !req.messageId) return;
    let alive = true;
    api
      .get('chat.getMessage', { msgId: req.messageId })
      .then((r) => alive && setSource(r.message))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [req.messageId, source]);

  // Resumo vindo da mensagem, só enquanto a pessoa não digitou nada.
  useEffect(() => {
    if (source && !summary && !req.params?.summary) setSummary(firstLine(source.msg ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // Projetos em que a pessoa (ou a conta da integração) cria issues.
  useEffect(() => {
    let alive = true;
    const t = setTimeout(
      () => {
        jiraApi
          .projects(true, projectQuery || undefined)
          .then((r) => {
            if (!alive) return;
            setLoadError('');
            setProjects(r.projects);
            setIdentity(r.identity as 'user' | 'integration' | 'none');
            setProjectKey((cur) => {
              if (cur && r.projects.some((p) => p.key === cur)) return cur;
              if (projectQuery) return cur;
              const prefer = [readLast(), me?.jira.defaultProject ?? ''].find((k) => k && r.projects.some((p) => p.key === k));
              return prefer ?? r.projects[0]?.key ?? '';
            });
          })
          .catch((e) => alive && setLoadError(errorMessage(e)));
      },
      projectQuery ? 250 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectQuery, reload]);

  // Tipos e campos do projeto escolhido.
  useEffect(() => {
    if (!projectKey) return;
    let alive = true;
    setMeta(null);
    jiraApi
      .createMeta(projectKey, rid)
      .then((m) => {
        if (!alive) return;
        setLoadError('');
        setMeta(m);
        setIdentity(m.identity);
        setTypeId((cur) => (m.issueTypes.some((t) => t.id === cur) ? cur : (m.issueTypes.find(isTask) ?? m.issueTypes[0])?.id ?? ''));
      })
      .catch((e) => alive && setLoadError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [projectKey, rid, reload]);

  const fields: JiraFieldMeta[] = useMemo(() => (meta && typeId ? (meta.fields[typeId] ?? []) : []), [meta, typeId]);
  const priority = fields.find((f) => f.key === 'priority');
  const extraFields = useMemo(() => fields.filter((f) => f.key !== 'priority' && f.key !== 'assignee'), [fields]);
  const blockers = meta && typeId ? (meta.blockers[typeId] ?? []) : [];
  const type = meta?.issueTypes.find((t) => t.id === typeId);

  // Valores padrão do Jira entram nos campos obrigatórios quando o tipo muda.
  useEffect(() => {
    const next: Record<string, unknown> = {};
    for (const f of extraFields) {
      const d = fieldDefault(f);
      if (d !== undefined) next[f.key] = d;
    }
    setExtra(next);
    setInvalid(null);
    setAttempted(false);
  }, [extraFields]);

  // Problemas que o chat confere (depois da primeira tentativa) mais o campo que o servidor recusou.
  const fieldName = (key: string) => extraFields.find((f) => f.key === key)?.name ?? key;
  const errors = useMemo(() => {
    const out = attempted ? fieldProblems(extraFields, extra) : {};
    if (invalid && !out[invalid]) out[invalid] = `Confira o campo ${fieldName(invalid)}.`;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempted, extraFields, extra, invalid]);
  const changeExtra = (v: Record<string, unknown>) => {
    if (invalid && v[invalid] !== extra[invalid]) setInvalid(null);
    setExtra(v);
  };

  const canPost = meta?.canPost ?? true;
  const replyOn = reply ?? (!!source && canPost);
  const count = [...summary].length;
  const summaryOk = summary.trim().length > 0 && count <= 255;
  const ready = !!meta && meta.identity !== 'none' && !!type && !blockers.length && summaryOk;
  const author = source ? source.u.name || source.u.username : '';

  const linked = () => {
    setLinking(false);
    setError('');
    setLoadError('');
    void loadIntegrationsMe(true);
    setReload((n) => n + 1);
  };

  // "Eu": o accountId da própria pessoa vem da busca de pessoas do projeto (o servidor marca quem é quem no chat).
  const myAccountId = async (): Promise<string | null> => {
    const acc = me?.jira.account;
    const chatUser = useStore.getState().me?.username;
    if (!acc || !chatUser) return null;
    for (const query of [acc.email ?? '', acc.displayName]) {
      if (!query) continue;
      const r = await jiraApi.assignable({ projectKey, query }).catch(() => null);
      const hit = r?.users.find((u) => u.username === chatUser);
      if (hit) return hit.accountId;
    }
    return null;
  };

  const submit = async () => {
    if (!ready || busy || !type || !meta) return;
    // Obrigatórios e números antes de ir ao Jira: todos marcados de uma vez, o foco no primeiro.
    setAttempted(true);
    const first = extraFields.find((f) => fieldProblems(extraFields, extra)[f.key]);
    if (first) {
      document.getElementById(fieldControlId(first.key))?.focus();
      return;
    }
    setBusy(true);
    setError('');
    setInvalid(null);
    try {
      let assigneeAccountId: string | null | undefined = undefined;
      let assignAfter = false;
      if (identity === 'user') {
        if (assignee?.kind === 'none') assigneeAccountId = null;
        else if (assignee?.kind === 'user') assigneeAccountId = assignee.user.accountId;
        else if (assignee?.kind === 'me') {
          assigneeAccountId = await myAccountId();
          // Sem achar a própria conta na busca: cria e atribui em seguida (jira.issue.assign aceita "me").
          if (!assigneeAccountId) assignAfter = true;
        }
      }
      const r = await jiraApi.create({
        roomId: rid,
        messageId: source?._id ?? null,
        projectKey: meta.project.key,
        issueTypeId: type.id,
        summary: summary.trim(),
        description,
        priorityId: priority && priorityId ? priorityId : null,
        assigneeAccountId,
        fields: normalized(extraFields, extra),
        replyInThread: replyOn && canPost,
      });
      saveLast(meta.project.key);
      settleEphemeralRequest(req);
      if (assignAfter) await jiraApi.assign(r.issue.key, 'me').catch((e) => useStore.getState().toast(errorMessage(e), 'error'));
      onClose();
      useStore.getState().toast(`Issue ${r.issue.key} criada.`, 'success', { action: { label: 'Abrir', onClick: () => window.open(r.issue.url, '_blank', 'noopener,noreferrer') } });
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.errorType === 'error-jira-field') {
        const hit = fields.find((f) => e.message.includes(f.name));
        if (hit) setInvalid(hit.key);
      }
    } finally {
      setBusy(false);
    }
  };

  if (linking)
    return (
      <Suspense fallback={null}>
        <JiraTokenModal onClose={() => setLinking(false)} onLinked={linked} />
      </Suspense>
    );

  const canLinkHere = !!me && me.jira.userAuth !== 'off';
  // Esqueleto só enquanto carrega de verdade: com erro, o aviso no alto toma o lugar.
  const loadingProjects = !projects && !loadError;
  const loadingMeta = !!projectKey && !meta && !loadError;
  const noProjects = !!projects && projects.length === 0 && !projectQuery && !loadError;
  const site = (me?.jira.site ?? '').replace(/\/$/, '');
  const createLabel = busy ? 'Criando…' : phone ? 'Criar' : 'Criar issue';
  const none = identity === 'none' || meta?.identity === 'none';
  const retry = () => {
    setLoadError('');
    setReload((n) => n + 1);
  };
  const typeIcon = type ? (JIRA_TYPE_ICON[type.kind] ?? 'jira-type-other') : 'jira-type-other';
  return (
    <Modal
      title="Criar issue no Jira"
      size="lg"
      variant={phone ? 'fullscreen' : undefined}
      description={author ? `A partir da mensagem de ${author}` : undefined}
      onClose={onClose}
      footer={
        none ? undefined : (
          <>
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancelar
            </button>
            <button type="button" className="btn primary" disabled={!ready || busy} aria-busy={busy || undefined} onClick={() => void submit()}>
              {createLabel}
            </button>
          </>
        )
      }
    >
      {none ? (
        <div className="form">
          <div className="callout info">
            <Icon name="info" />
            <span>Conecte sua conta do Jira para criar a issue.</span>
            {canLinkHere && (
              <button type="button" className="btn primary" onClick={() => setLinking(true)}>
                Conectar
              </button>
            )}
          </div>
          {error && <FormError>{error}</FormError>}
        </div>
      ) : (
        <div className="form">
          {identity === 'user' && me?.jira.account && (
            <div className="callout info">
              <Icon name="info" />
              <span>A issue será criada pela sua conta do Jira ({me.jira.account.displayName}).</span>
            </div>
          )}
          {identity === 'integration' && (
            <div className="callout warn">
              <Icon name="warning" />
              <span>
                Você não conectou sua conta do Jira. A issue será criada pela conta da integração, com o seu nome na descrição.
                {canLinkHere && (
                  <>
                    {' '}
                    <button type="button" className="link" onClick={() => setLinking(true)}>
                      Conectar minha conta
                    </button>
                  </>
                )}
              </span>
            </div>
          )}
          {loadError && (
            <div className="callout err" role="alert">
              <Icon name="error" />
              <span>{loadError}</span>
              <button type="button" className="btn small" onClick={retry}>
                Tentar de novo
              </button>
            </div>
          )}
          {noProjects && (
            <div className="callout warn">
              <Icon name="warning" />
              <span>
                {identity === 'integration'
                  ? 'A conta da integração não pode criar issues em nenhum projeto do Jira. Peça ao administrador do Jira para liberar um projeto.'
                  : 'Sua conta do Jira não pode criar issues em nenhum projeto. Peça acesso a um projeto ao administrador do Jira.'}
              </span>
            </div>
          )}
          {/* Com muitos projetos, um filtro (busca no Jira) ao lado da lista; sem ele, a lista ocupa a linha toda. */}
          {!noProjects && (loadingProjects || projects) && (
            <div className={showFilter ? 'two-col' : undefined}>
              <Field label="Projeto">
                {!projects ? (
                  <Skeleton height={36} />
                ) : projects.length === 0 ? (
                  <span className="muted small">Nenhum projeto encontrado.</span>
                ) : (
                  <select value={projectKey} onChange={(e) => setProjectKey(e.target.value)}>
                    {projectKey && !projects.some((p) => p.key === projectKey) && <option value={projectKey}>{projectKey}</option>}
                    {projects.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.name} ({p.key})
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {showFilter && (
                <Field label="Filtrar projetos">
                  <input type="search" value={projectQuery} placeholder="Nome ou chave do projeto" onChange={(e) => setProjectQuery(e.target.value)} />
                </Field>
              )}
            </div>
          )}
          {(meta || loadingMeta || loadingProjects) && (
            <div className="field">
              <label className="field-label" htmlFor={`${ids}-type`}>
                Tipo
              </label>
              {!meta ? (
                <Skeleton height={36} />
              ) : (
                // Lista nativa (setas e leitores de tela de graça) com o ícone do tipo escolhido à esquerda.
                <div data-int="type">
                  <Icon name={typeIcon} size={16} />
                  <select id={`${ids}-type`} value={typeId} onChange={(e) => setTypeId(e.target.value)}>
                    {meta.issueTypes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}
          {blockers.length > 0 && meta && type && (
            <div className="callout warn">
              <Icon name="warning" />
              <span>
                Este tipo de issue tem campos obrigatórios que o chat ainda não preenche: {blockers.join(', ')}. Crie esta issue pelo Jira.{' '}
                {site && (
                  <a className="link" href={`${site}/secure/CreateIssue.jspa?pid=${encodeURIComponent(meta.project.id)}&issuetype=${encodeURIComponent(type.id)}`} target="_blank" rel="noopener noreferrer">
                    Abrir no Jira
                  </a>
                )}
              </span>
            </div>
          )}
          <Field label="Resumo" required hint={`${count}/255`} error={count > 255 ? 'Dê um resumo à issue (até 255 caracteres).' : undefined}>
            <input value={summary} onChange={(e) => setSummary(e.target.value)} required aria-required="true" />
          </Field>
          <Field label="Descrição" hint={source ? 'A mensagem original e o link para ela entram no fim da descrição.' : undefined}>
            <textarea rows={6} value={description} maxLength={32000} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          {source && (
            <div className="quote-att" style={{ marginTop: 0 }}>
              <div className="quote-head">
                <strong>{author}</strong>
              </div>
              <div className="small pre-wrap">{shortQuote(source.msg ?? '')}</div>
            </div>
          )}
          {loadingMeta ? (
            <Skeleton height={36} />
          ) : (
            meta && (
              <>
                {priority && (
                  <Field label="Prioridade">
                    <select value={priorityId} onChange={(e) => setPriorityId(e.target.value)}>
                      <option value="">Padrão do Jira</option>
                      {(priority.options ?? []).map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {identity === 'user' && fields.some((f) => f.key === 'assignee') && (
                  <div className="field">
                    <label className="field-label" id={`${ids}-assignee`} htmlFor={`${ids}-assignee-search`}>
                      Responsável
                    </label>
                    <PersonSearch target={{ projectKey: meta.project.key }} value={assignee} onChange={setAssignee} inputId={`${ids}-assignee-search`} labelId={`${ids}-assignee`} />
                  </div>
                )}
                <JiraFieldInputs fields={extraFields} value={extra} onChange={changeExtra} errors={errors} projectKey={meta.project.key} />
              </>
            )
          )}
          <div className="field">
            <label className="check">
              <input
                type="checkbox"
                checked={replyOn && canPost}
                disabled={!canPost}
                aria-describedby={!canPost && meta?.canPostReason ? `${ids}-reply-why` : undefined}
                onChange={(e) => setReply(e.target.checked)}
              />
              {/* Desligada porque a sala não aceita mensagens: o texto também apaga; o motivo vem logo abaixo. */}
              <span className={canPost ? undefined : 'muted'}>{source ? 'Responder no tópico com o link da issue' : 'Avisar na sala com o link da issue'}</span>
            </label>
            {!canPost && meta?.canPostReason && (
              <span className="field-hint" id={`${ids}-reply-why`}>
                {meta.canPostReason}
              </span>
            )}
          </div>
          <div className="field-hint">
            <Icon name="info" size={12} /> O texto vai para o Jira e fica visível para quem tem acesso ao projeto.
          </div>
          {error && <FormError>{error}</FormError>}
        </div>
      )}
    </Modal>
  );
}

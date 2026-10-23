import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { LDAP_SYNC_PRESETS, type LdapRunStatus, type LdapStatus, type LdapSyncChangeKind, type LdapSyncCounts, type LdapSyncRun } from '@shared/ldap';
import { api, ApiError, errorMessage } from '../../../lib/api';
import { formatDateTime, formatDuration } from '../../../lib/format';
import { useStore } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { Empty, Field, Modal, Pager, SkeletonTable, Tabs, useAsync } from '../../../components/ui';
import { SettingInput } from '../AdminSettings';
import type { LdapSettings } from './index';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const ok = (t: string) => useStore.getState().toast(t);

const INTERVAL = 'LDAP_Background_Sync_Interval';
const TOGGLES = [
  'LDAP_Background_Sync_Import_New_Users',
  'LDAP_Sync_User_Active_State',
  'LDAP_Sync_AD_Disabled',
  'LDAP_Sync_Reactivate_Users',
  'LDAP_Sync_Avatar',
  'LDAP_Sync_Max_Deactivation_Percent',
];
export const AGENDA_IDS = ['LDAP_Background_Sync', INTERVAL, ...TOGGLES];
const PAGE = 20;
const CUSTOM = 'custom';

const STATUS_LABEL: Record<LdapRunStatus, string> = { success: 'Concluída', partial: 'Concluída com avisos', failed: 'Falhou', running: 'Em andamento' };
const TRIGGER_LABEL: Record<LdapSyncRun['trigger'], string> = { cron: 'Automática', manual: 'Manual', api: 'API' };
const KIND_LABEL: Record<LdapSyncChangeKind, string> = {
  created: 'Criado',
  profile: 'Perfil',
  roles: 'Papéis',
  channels: 'Canais',
  teams: 'Times',
  avatar: 'Foto',
  deactivated: 'Desativado',
  reactivated: 'Reativado',
};
const COUNT_LABEL: [keyof LdapSyncCounts, string][] = [
  ['seen', 'Vistos'],
  ['imported', 'Novos'],
  ['updated', 'Atualizados'],
  ['changed', 'Com mudanças'],
  ['deactivated', 'Desativados'],
  ['reactivated', 'Reativados'],
  ['skipped', 'Ignorados'],
  ['errors', 'Erros'],
  ['avatars', 'Fotos'],
  ['rolesChanged', 'Papéis'],
  ['channelsAdded', 'Entradas em canais'],
  ['channelsRemoved', 'Saídas de canais'],
  ['teamsAdded', 'Entradas em times'],
  ['teamsRemoved', 'Saídas de times'],
];

const num = (n: number) => n.toLocaleString('pt-BR');
const duration = (run: LdapSyncRun) => {
  const ms = run.durationMs ?? (run.status === 'running' ? Date.now() - new Date(run.startedAt).getTime() : null);
  return ms === null ? '—' : ms < 1000 ? 'menos de 1 s' : formatDuration(ms / 1000);
};
const plural = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`;
// Resumo da linha do histórico quando não cabem as colunas de números.
function summary(c: LdapSyncCounts) {
  const parts = [
    c.imported && plural(c.imported, 'novo', 'novos'),
    c.updated && plural(c.updated, 'atualizado', 'atualizados'),
    c.deactivated && plural(c.deactivated, 'desativado', 'desativados'),
    c.reactivated && plural(c.reactivated, 'reativado', 'reativados'),
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Nenhuma conta processada';
}
const origin = (run: LdapSyncRun) => `${TRIGGER_LABEL[run.trigger]}${run.startedBy ? ` por @${run.startedBy.username}` : ''}`;

export function RunStatus({ status }: { status: LdapRunStatus }) {
  return <span className={`pill ldap-run ${status}`}>{STATUS_LABEL[status]}</span>;
}

export function LdapSync({ s, status, statusError, reloadStatus, active }: { s: LdapSettings; status: LdapStatus | null; statusError: string | null; reloadStatus: () => void; active: boolean }) {
  const [offset, setOffset] = useState(0);
  const history = useAsync(() => api.get<{ runs: LdapSyncRun[]; total: number }>('ldap.sync.runs', { offset, count: PAGE }), [offset]);
  const [run, setRun] = useState<LdapSyncRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [details, setDetails] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // "Personalizado (cron)" escolhido sem mudar o valor: fica aqui para o Descartar e o Salvar poderem desfazer.
  const [customCron, setCustomCron] = useState(false);
  const reloadRef = useRef({ status: reloadStatus, history: history.reload });
  reloadRef.current = { status: reloadStatus, history: history.reload };

  // Uma sincronização já em andamento (outra aba, a agenda) também é acompanhada.
  useEffect(() => {
    if (status?.running && !run) setRun(status.running);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.running?._id]);

  // Acompanha a execução a cada 2 s até terminar.
  useEffect(() => {
    if (!run || run.status !== 'running') return;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ run: LdapSyncRun }>('ldap.sync.run', { runId: run._id });
        if (!alive) return;
        if (r.run.status === 'running') return setRun(r.run);
        const c = r.run.counts;
        if (r.run.status === 'failed') fail(`A sincronização falhou: ${r.run.error ?? 'erro desconhecido'}`);
        else ok(`Sincronização concluída: ${c.imported} novos, ${c.updated} atualizados, ${c.deactivated} desativados, ${c.reactivated} reativados, ${c.errors} erros.`);
        setRun(null);
        reloadRef.current.status();
        reloadRef.current.history();
      } catch (e) {
        if (!alive) return;
        // Execução sumiu (retenção) ou o servidor não respondeu: tenta de novo, sem travar o botão para sempre.
        if (e instanceof ApiError && e.status === 404) {
          setRun(null);
          reloadRef.current.status();
        } else setRun({ ...run });
      }
    }, 2000);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [run]);

  const start = async () => {
    setStarting(true);
    try {
      const r = await api.post<{ run: LdapSyncRun }>('ldap.sync.start');
      setRun(r.run);
      history.reload();
    } catch (e) {
      fail(e);
      if (e instanceof ApiError && e.status === 409) reloadStatus();
    } finally {
      setStarting(false);
    }
  };
  const saveAgenda = async () => {
    setSaving(true);
    const done = await s.save(AGENDA_IDS);
    setSaving(false);
    if (done) {
      ok('Agenda da sincronização salva.');
      setCustomCron(false);
      reloadStatus();
    }
  };
  const discardAgenda = () => {
    s.discard(AGENDA_IDS);
    setCustomCron(false);
  };

  const enabled = status ? status.enabled : !!s.saved('LDAP_Enable');
  const shown = run ?? status?.lastRun ?? null;
  const agendaDirty = s.dirtyIds(AGENDA_IDS).length > 0;
  const syncing = !!run || starting;

  return (
    <>
      {!enabled && (
        <div className="callout warn">
          <Icon name="warning" />
          <span>O LDAP está desativado. Ative-o na aba Conexão para sincronizar.</span>
        </div>
      )}

      <div className="card">
        <div className="ldap-card-head">
          <h3>{run ? 'Sincronização em andamento' : 'Última sincronização'}</h3>
          <span className="spacer" />
          <button className="btn primary" disabled={!s.canEdit || !enabled || syncing} onClick={() => void start()}>
            {syncing ? (
              <>
                <span className="spinner sm ldap-busy" aria-hidden="true" />
                Sincronizando…
              </>
            ) : (
              <>
                <Icon name="sync" />
                Sincronizar agora
              </>
            )}
          </button>
        </div>
        {status && (
          <p className="muted small ldap-card-lead">
            Contas vindas do LDAP: {num(status.users.total)} · {num(status.users.active)} ativas
            {status.users.deactivatedBySync > 0 && ` · ${num(status.users.deactivatedBySync)} desativadas pela sincronização`}
          </p>
        )}
        {statusError && !status ? (
          <div className="form-error">Não foi possível ler a situação do LDAP: {statusError}</div>
        ) : !status && !run ? (
          <SkeletonTable rows={3} cols={3} />
        ) : shown ? (
          <RunSummary run={shown} onDetails={() => setDetails(shown._id)} />
        ) : (
          <Empty>Nenhuma sincronização ainda. Use “Sincronizar agora” para trazer as contas do AD.</Empty>
        )}
      </div>

      <fieldset className="ldap-fieldset" disabled={!s.canEdit}>
        <div className="card form">
          <h3>Agenda</h3>
          <div className={`ldap-setting ${s.isDirty('LDAP_Background_Sync') ? 'changed' : ''}`}>
            {s.get('LDAP_Background_Sync') && <SettingInput s={s.get('LDAP_Background_Sync')} value={s.value('LDAP_Background_Sync')} onChange={(v) => s.set('LDAP_Background_Sync', v)} />}
          </div>
          <Frequency s={s} status={status} custom={customCron} onCustom={setCustomCron} />
          {TOGGLES.map((id) => {
            const def = s.get(id);
            return (
              def && (
                <div key={id} className={`ldap-setting ${s.isDirty(id) ? 'changed' : ''}`}>
                  <SettingInput s={def} value={s.value(id)} onChange={(v) => s.set(id, v)} />
                </div>
              )
            );
          })}
          <div className="row-actions wrap">
            <button className="btn primary" disabled={!s.canEdit || !agendaDirty || saving} onClick={() => void saveAgenda()}>
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
            {agendaDirty && (
              <button className="link small" onClick={discardAgenda}>
                Descartar alterações
              </button>
            )}
          </div>
        </div>
      </fieldset>

      <div className="card">
        <h3>Histórico</h3>
        {history.loading && !history.data ? (
          <SkeletonTable rows={4} cols={4} />
        ) : history.error && !history.data ? (
          <div className="form-error">Não foi possível carregar o histórico: {history.error}</div>
        ) : !history.data?.runs.length ? (
          <Empty>Nenhuma sincronização registrada.</Empty>
        ) : (
          <div className="ldap-history-wrap">
            <table className="table ldap-history">
              <thead>
                <tr>
                  <th>Início</th>
                  <th className="ldap-opt">Origem</th>
                  <th>Situação</th>
                  <th className="ldap-opt ldap-wide">Duração</th>
                  <th className="ldap-mid">Resumo</th>
                  <th className="ldap-opt ldap-wide num">Novos</th>
                  <th className="ldap-opt ldap-wide num">Atualizados</th>
                  <th className="ldap-opt ldap-wide num">Desativados</th>
                  <th className="ldap-opt ldap-wide num">Reativados</th>
                  <th className="num">Erros</th>
                </tr>
              </thead>
              <tbody>
                {history.data.runs.map((r) => (
                  <HistoryRow key={r._id} r={r.status === 'running' && run?._id === r._id ? run : r} onOpen={() => setDetails(r._id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {history.data && <Pager offset={offset} count={PAGE} total={history.data.total} onChange={setOffset} />}
      </div>

      {details && active && <RunModal runId={details} onClose={() => setDetails(null)} />}
    </>
  );
}

// `custom` guarda só a escolha explícita de "Personalizado": um valor que não é preset já cai nesse modo sozinho.
function Frequency({ s, status, custom, onCustom }: { s: LdapSettings; status: LdapStatus | null; custom: boolean; onCustom: (v: boolean) => void }) {
  const value = String(s.value(INTERVAL) ?? '');
  const norm = value.trim().replace(/\s+/g, ' ');
  const preset = LDAP_SYNC_PRESETS.find((p) => p.cron === norm);
  const selected = custom || !preset ? CUSTOM : preset.cron;
  const def = s.get(INTERVAL);
  return (
    <div className={`ldap-setting ${s.isDirty(INTERVAL) ? 'changed' : ''}`}>
      <Field label="Frequência" hint={status?.background.enabled ? `Agenda salva: ${status.background.label}.` : 'A frequência só vale com a sincronização em segundo plano ligada.'}>
        <select
          value={selected}
          disabled={!s.canEdit}
          onChange={(e) => {
            if (e.target.value === CUSTOM) return onCustom(true);
            onCustom(false);
            s.set(INTERVAL, e.target.value);
          }}
        >
          {LDAP_SYNC_PRESETS.map((p) => (
            <option key={p.cron} value={p.cron}>
              {p.label}
            </option>
          ))}
          <option value={CUSTOM}>Personalizado (cron)</option>
        </select>
      </Field>
      {selected === CUSTOM && (
        <Field
          label={<>Expressão cron {def && <span className="muted mono small">{def._id}</span>}</>}
          hint="Minuto, hora, dia do mês, mês e dia da semana. Ex.: 0 7-19 * * 1-5 (de hora em hora, das 7h às 19h, em dias úteis)."
        >
          <input className="mono" value={value} disabled={!s.canEdit} onChange={(e) => s.set(INTERVAL, e.target.value)} placeholder="*/15 * * * *" spellCheck={false} />
        </Field>
      )}
      {status && !status.background.valid && (
        <p className="ldap-warn-text">
          <Icon name="warning" size={14} />
          Expressão inválida: a sincronização automática está parada.
        </p>
      )}
    </div>
  );
}

function RunSummary({ run, onDetails }: { run: LdapSyncRun; onDetails: () => void }) {
  return (
    <div className="ldap-run-summary">
      <div className="ldap-run-meta">
        <RunStatus status={run.status} />
        <span>
          <span className="muted">Início:</span> {formatDateTime(run.startedAt)}
        </span>
        <span>
          <span className="muted">Fim:</span> {run.finishedAt ? formatDateTime(run.finishedAt) : '—'}
        </span>
        <span>
          <span className="muted">Duração:</span> {duration(run)}
        </span>
        <span>
          <span className="muted">Origem:</span> {origin(run)}
        </span>
      </div>
      {run.error && <div className="form-error">{run.error}</div>}
      <div className="stats ldap-counts">
        {COUNT_LABEL.map(([k, label]) => (
          <div key={k} className={`stat ldap-count ${run.counts[k] ? '' : 'zero'} ${k === 'errors' && run.counts.errors ? 'bad' : ''}`}>
            <span className="stat-value ldap-count-value">{num(run.counts[k])}</span>
            <span className="stat-label ldap-count-label">{label}</span>
          </div>
        ))}
      </div>
      {/* As listas só existem no fim da execução. */}
      {run.status !== 'running' && (
        <button className="link" onClick={onDetails}>
          Ver mudanças, erros e avisos
          <Icon name="next" size={14} />
        </button>
      )}
    </div>
  );
}

function HistoryRow({ r, onOpen }: { r: LdapSyncRun; onOpen: () => void }) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  };
  const c = r.counts;
  return (
    <tr className="clickable" tabIndex={0} role="button" title="Ver detalhes" onClick={onOpen} onKeyDown={onKey}>
      <td className="nowrap">
        {formatDateTime(r.startedAt)}
        <div className="muted small ldap-start-origin">{origin(r)}</div>
      </td>
      <td className="ldap-opt">
        {TRIGGER_LABEL[r.trigger]}
        {r.startedBy && <div className="muted small">@{r.startedBy.username}</div>}
      </td>
      <td>
        <RunStatus status={r.status} />
      </td>
      <td className="ldap-opt ldap-wide nowrap">{duration(r)}</td>
      <td className="ldap-mid">
        {summary(c)}
        <div className="muted small">{duration(r)}</div>
      </td>
      <td className="ldap-opt ldap-wide num">{num(c.imported)}</td>
      <td className="ldap-opt ldap-wide num">{num(c.updated)}</td>
      <td className="ldap-opt ldap-wide num">{num(c.deactivated)}</td>
      <td className="ldap-opt ldap-wide num">{num(c.reactivated)}</td>
      <td className="num">
        <span className={c.errors ? 'neg' : ''}>{num(c.errors)}</span>
        {r.warningsCount > 0 && (
          <span className="ldap-warn-mark" title={`${r.warningsCount} ${r.warningsCount === 1 ? 'aviso' : 'avisos'}`} aria-label={`${r.warningsCount} ${r.warningsCount === 1 ? 'aviso' : 'avisos'}`}>
            <Icon name="warning" size={14} />
          </span>
        )}
      </td>
    </tr>
  );
}

type RunTab = 'changes' | 'errors' | 'warnings';

function RunModal({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [state, setState] = useState<{ run: LdapSyncRun | null; error: string | null }>({ run: null, error: null });
  const [tab, setTab] = useState<RunTab>('changes');
  const [filter, setFilter] = useState('');
  const { run, error } = state;
  const loading = !run && !error;
  const running = run?.status === 'running';

  // Em andamento, as listas só são gravadas no fim: a janela se atualiza a cada 2 s até a execução terminar.
  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const load = async (first: boolean) => {
      try {
        const r = await api.get<{ run: LdapSyncRun }>('ldap.sync.run', { runId });
        if (!alive) return;
        setState({ run: r.run, error: null });
        if (r.run.status === 'running') t = setTimeout(() => void load(false), 2000);
      } catch (e) {
        if (!alive) return;
        if (first) {
          setState({ run: null, error: errorMessage(e) });
          fail(e);
        } else if (!(e instanceof ApiError && e.status === 404)) t = setTimeout(() => void load(false), 2000);
      }
    };
    void load(true);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [runId]);

  const f = filter.trim().toLowerCase();
  const changes = (run?.changes ?? []).filter((c) => !f || c.username.toLowerCase().includes(f) || c.detail.toLowerCase().includes(f));
  const errors = (run?.errors ?? []).filter((e) => !f || `${e.login ?? ''} ${e.dn ?? ''} ${e.message}`.toLowerCase().includes(f));
  const warnings = (run?.warnings ?? []).filter((w) => !f || w.toLowerCase().includes(f));
  const capped = (n: number, shown: number, fem: boolean) =>
    n > shown && (
      <p className="muted small">
        Mostrando {fem ? 'as primeiras' : 'os primeiros'} {num(shown)}.
      </p>
    );
  // Em andamento ainda não há listas: elas são gravadas no fim da execução.
  const total = run && !running ? { changes: run.changes?.length ?? 0, errors: run.errors?.length ?? 0, warnings: run.warnings?.length ?? 0 } : null;

  return (
    <Modal wide title={run ? `Sincronização de ${formatDateTime(run.startedAt)}` : 'Sincronização'} onClose={onClose}>
      {loading && !run ? (
        <SkeletonTable rows={5} cols={3} />
      ) : !run ? (
        <div className="form-error">Não foi possível abrir esta sincronização{error ? `: ${error}` : '.'}</div>
      ) : (
        <>
          <div className="ldap-run-meta">
            <RunStatus status={run.status} />
            <span>{origin(run)}</span>
            <span>
              <span className="muted">Duração:</span> {duration(run)}
            </span>
          </div>
          {run.error && <div className="form-error">{run.error}</div>}
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { id: 'changes', label: `Mudanças (${num(run.changesCount)})` },
              { id: 'errors', label: `Erros (${num(run.errorsCount)})` },
              { id: 'warnings', label: `Avisos (${num(run.warningsCount)})` },
            ]}
          />
          {total && total[tab] > 10 && <input type="search" className="search-input" placeholder="Filtrar por usuário ou texto" value={filter} onChange={(e) => setFilter(e.target.value)} />}
          {running && <Empty>Sincronização em andamento. As mudanças, os erros e os avisos aparecem aqui quando ela terminar.</Empty>}
          {total &&
            tab === 'changes' &&
            (total.changes === 0 ? (
              <Empty>Nenhuma mudança nesta sincronização.</Empty>
            ) : (
              <>
                {capped(run.changesCount, total.changes, true)}
                <table className="table ldap-changes">
                  <tbody>
                    {changes.map((c, i) => (
                      <tr key={i}>
                        <td className="nowrap">
                          <strong>@{c.username}</strong>
                        </td>
                        <td>
                          <span className={`pill ldap-kind ${c.kind}`}>{KIND_LABEL[c.kind] ?? c.kind}</span>
                        </td>
                        <td className="ldap-break">{c.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!changes.length && <Empty>Nada encontrado com esse filtro.</Empty>}
              </>
            ))}
          {total &&
            tab === 'errors' &&
            (total.errors === 0 ? (
              <Empty>Nenhum erro nesta sincronização.</Empty>
            ) : (
              <>
                {capped(run.errorsCount, total.errors, false)}
                <ul className="ldap-issues">
                  {errors.map((e, i) => (
                    <li key={i}>
                      {(e.login || e.dn) && (
                        <span className="ldap-issue-who">
                          {e.login && <strong>{e.login}</strong>}
                          {e.dn && <span className="mono small muted ldap-break">{e.dn}</span>}
                        </span>
                      )}
                      <span className="neg">{e.message}</span>
                    </li>
                  ))}
                </ul>
                {!errors.length && <Empty>Nada encontrado com esse filtro.</Empty>}
              </>
            ))}
          {total &&
            tab === 'warnings' &&
            (total.warnings === 0 ? (
              <Empty>Nenhum aviso nesta sincronização.</Empty>
            ) : (
              <>
                {capped(run.warningsCount, total.warnings, false)}
                <ul className="ldap-warnings">
                  {warnings.map((w, i) => (
                    <li key={i}>
                      <Icon name="warning" size={14} />
                      {w}
                    </li>
                  ))}
                </ul>
                {!warnings.length && <Empty>Nada encontrado com esse filtro.</Empty>}
              </>
            ))}
        </>
      )}
    </Modal>
  );
}

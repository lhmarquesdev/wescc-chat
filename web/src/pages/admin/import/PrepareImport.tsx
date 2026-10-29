import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../../../lib/api';
import { roomIconName } from '../../../lib/format';
import { usePermission, useSetting } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { Empty, SkeletonTable } from '../../../components/ui';
import { fail, ImportTitle, isImporting, isReading, isWaiting, num, ok, plural, ProgressBar, ST, Stat, StatusPill, statusLabel, useImportEvents, usePolling, Warnings } from './common';
import type { ImportFileData, ImportOperation, SelectionChannel, SelectionUser, ShortSelectionPart } from './types';

const DIRECT_MESSAGES_ID = '__directMessages__';

export function PrepareImport() {
  const navigate = useNavigate();
  const [op, setOp] = useState<ImportOperation | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  const [data, setData] = useState<ImportFileData | null>(null);
  const [polling, setPolling] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const leaving = useRef(false);

  const leave = (path: string, toast?: string) => {
    if (leaving.current) return;
    leaving.current = true;
    setPolling(false);
    if (toast) ok(toast);
    navigate(path, { replace: true });
  };

  // getImportFileData nunca muda a situação no servidor: dá para chamar a cada segundo enquanto o arquivo é lido.
  const fetchData = async () => {
    try {
      const r = await api.get<ImportFileData>('getImportFileData');
      setLoadError(null);
      setOp(r.operation);
      const st = r.operation.status;
      if (r.waiting) {
        // Importação pela API: os dados chegam por import.addUsers, não por esta tela.
        if (st === ST.new && r.operation.importerKey === 'api') setPolling(false);
        return;
      }
      setPolling(false);
      if (st === ST.userSelection && r.users) setData(r);
      else if (isImporting(st)) leave('/admin/import/progress');
      else if (st === ST.done) leave('/admin/import');
    } catch (e) {
      if (e instanceof ApiError && e.errorType === 'error-operation-not-found') return leave('/admin/import/new', 'Nenhuma importação em andamento. Escolha um arquivo para começar.');
      setLoadError(errorMessage(e));
      // Erros de rede ou do servidor: tenta de novo no próximo ciclo.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) setPolling(false);
    }
  };
  usePolling(fetchData, 1000, polling);

  useImportEvents((p) => {
    if (!op || p._id !== op._id) return;
    if (typeof p.rate === 'number') setRate(p.rate);
    setOp({ ...op, status: p.status, valid: p.valid, count: p.count, error: p.error ?? op.error, messagesstatus: p.messagesstatus !== undefined ? p.messagesstatus : op.messagesstatus });
    if (!p.valid) return leave('/admin/import', 'Esta importação foi substituída por outra.');
    if (isImporting(p.status)) return leave('/admin/import/progress');
    // Terminou a leitura (seleção, falha ou cancelamento): busca o resultado sem esperar o próximo ciclo.
    if (polling && !isReading(p.status)) void fetchData();
    if (data && p.status !== ST.userSelection) setData(null);
  });

  const cancel = async (question: string) => {
    if (!confirm(question)) return;
    try {
      await api.post('import.cancel');
      leave('/admin/import', 'Importação cancelada.');
    } catch (e) {
      fail(e);
    }
  };

  if (!op) {
    return (
      <>
        <ImportTitle title="Importação" />
        {loadError ? <div className="form-error imp-block">Não foi possível carregar a importação: {loadError}</div> : <SkeletonTable rows={4} cols={3} />}
      </>
    );
  }

  if (op.status === ST.failed || op.status === ST.cancelled) {
    return (
      <>
        <ImportTitle title="Importação" />
        <div className="card imp-card">
          <div className="imp-detail-head">
            <StatusPill status={op.status} />
            {op.file && <span className="mono small ellipsis">{op.file}</span>}
          </div>
          <div className="form-error imp-block">{op.error || (op.status === ST.cancelled ? 'A importação foi cancelada.' : 'A importação falhou.')}</div>
          <Warnings list={op.warnings} open />
          <div className="row-actions wrap">
            <button className="btn primary" onClick={() => navigate('/admin/import')}>
              Voltar para o histórico
            </button>
            {op.importerKey !== 'api' && !op.importerKey.startsWith('pending-') && (
              <button className="btn" onClick={() => navigate(`/admin/import/new/${op.importerKey}`)}>
                Tentar outro arquivo
              </button>
            )}
          </div>
        </div>
      </>
    );
  }

  if (data && op.status === ST.userSelection)
    return <Selection data={data} op={op} onCancel={() => void cancel('Descartar esta importação? Os dados lidos do arquivo são apagados; nada foi importado ainda.')} />;

  if (op.importerKey === 'api' && op.status === ST.new) {
    return (
      <>
        <ImportTitle title="Importação pela API" />
        <Empty>Esta importação está sendo feita pela API (import.addUsers e import.run). Os usuários aparecem aqui depois do primeiro import.addUsers.</Empty>
      </>
    );
  }

  const c = op.count;
  const readSoFar = c.users + c.channels + c.messages > 0;
  return (
    <>
      <ImportTitle title="Lendo o arquivo" />
      <div className="card imp-card">
        <h2 aria-live="polite">{statusLabel(op.status)}</h2>
        {op.file && <p className="mono small muted ellipsis">{op.file}</p>}
        <ProgressBar value={!isWaiting(op.status) && rate && rate > 0 ? rate : null} label="Leitura do arquivo" />
        {op.messagesstatus && <p className="small muted">Lendo {op.messagesstatus}</p>}
        {readSoFar && (
          <div className="stats imp-stats">
            <Stat label="Usuários" value={num(c.users)} />
            <Stat label="Canais" value={num(c.channels)} />
            <Stat label="Mensagens" value={num(c.messages)} />
          </div>
        )}
        {loadError && <div className="field-hint neg">Sem resposta do servidor ({loadError}). Tentando de novo…</div>}
        <p className="small muted">A leitura continua no servidor se você sair desta página. Nada é importado antes de você escolher o que entra.</p>
        <div className="row-actions">
          <button className="btn danger" onClick={() => void cancel('Cancelar a leitura do arquivo?')}>
            Cancelar
          </button>
        </div>
      </div>
    </>
  );
}

// ---------- Seleção ----------

type Tab = 'users' | 'channels';

function part(ids: string[], sel: Set<string>): ShortSelectionPart {
  if (!ids.length) return { all: false };
  const chosen = ids.filter((id) => sel.has(id));
  if (chosen.length === ids.length) return { all: true };
  return { all: false, list: [...new Set(chosen)] };
}

const selectedLabel = (n: number) => `${num(n)} ${n === 1 ? 'selecionado' : 'selecionados'}`;

// O servidor só dá o papel admin a contas que a importação cria, e só se quem importa pode atribuí-lo.
function adminTitle(u: SelectionUser, canGrant: boolean) {
  if (u.is_email_taken) return 'Administrador na origem. A conta já existe aqui e continua com os papéis que tem.';
  if (canGrant) return 'Administrador na origem: a conta nova recebe o papel de administrador.';
  return 'Administrador na origem. Você não pode atribuir o papel de administrador, então a conta nova entra sem ele.';
}

function Selection({ data, op, onCancel }: { data: ImportFileData; op: ImportOperation; onCancel: () => void }) {
  const navigate = useNavigate();
  const retention = useSetting<boolean>('RetentionPolicy_Enabled');
  const canGrantAdmin = usePermission('assign-admin-role');
  const users = data.users ?? [];
  const channels = data.channels ?? [];
  const messageCount = data.message_count ?? 0;
  const [selUsers, setSelUsers] = useState(() => new Set(users.map((u) => u.user_id)));
  const [selChannels, setSelChannels] = useState(() => new Set(channels.map((c) => c.channel_id)));
  const [tab, setTab] = useState<Tab>(users.length || !channels.length ? 'users' : 'channels');
  const [sendEmails, setSendEmails] = useState(false);
  const [starting, setStarting] = useState(false);

  const nUsers = countSelected(users, (u) => u.user_id, selUsers);
  const nChannels = countSelected(channels, (c) => c.channel_id, selChannels);
  // Mensagens de canais trazidos por uma importação anterior (o arquivo não lista canais): entram sem precisar de seleção.
  const looseMessages = !channels.length && messageCount > 0;
  const nothing = nUsers + nChannels === 0 && !looseMessages;

  const start = async () => {
    setStarting(true);
    try {
      await api.post('startImport', {
        input: {
          users: part(
            users.map((u) => u.user_id),
            selUsers,
          ),
          channels: part(
            channels.map((c) => c.channel_id),
            selChannels,
          ),
        },
        options: { sendPasswordEmails: sendEmails },
      });
      navigate('/admin/import/progress', { replace: true });
    } catch (e) {
      fail(e);
      setStarting(false);
    }
  };

  const dmSelected = selChannels.has(DIRECT_MESSAGES_ID) && channels.some((c) => c.channel_id === DIRECT_MESSAGES_ID);
  const nRooms = nChannels - (dmSelected ? 1 : 0);
  const summary = [
    nUsers && plural(nUsers, 'usuário', 'usuários'),
    nRooms && plural(nRooms, 'canal', 'canais'),
    dmSelected && 'as mensagens diretas',
    looseMessages && plural(messageCount, 'mensagem', 'mensagens'),
  ].filter(Boolean) as string[];

  return (
    <>
      <ImportTitle title="Escolher o que importar" />
      <p className="muted imp-lead">
        {op.type}
        {op.file ? ` · ${op.file}` : ''}. Tudo começa selecionado: desmarque o que não deve entrar.
        {channels.length > 0 && messageCount > 0 ? ' As mensagens entram junto com os canais escolhidos.' : ''}
      </p>
      {retention && (
        <div className="callout warn">
          <Icon name="warning" />
          <span>A política de retenção está ativa: mensagens importadas mais antigas que o prazo configurado podem ser apagadas na próxima limpeza.</span>
        </div>
      )}
      <Warnings list={op.warnings} />
      {/* Só as abas do que o arquivo traz: uma lista de membros não mostra "Canais (0)". */}
      <div className="tabs" role="tablist">
        {(users.length > 0 || !channels.length) && (
          <TabButton active={tab === 'users'} onClick={() => setTab('users')}>
            Usuários ({selectedLabel(nUsers)})
          </TabButton>
        )}
        {channels.length > 0 && (
          <TabButton active={tab === 'channels'} onClick={() => setTab('channels')}>
            Canais ({selectedLabel(nChannels)})
          </TabButton>
        )}
        {messageCount > 0 && (
          <TabButton disabled title="As mensagens são importadas junto com os canais e as mensagens diretas escolhidos.">
            Mensagens ({num(messageCount)})
          </TabButton>
        )}
      </div>
      {tab === 'users' && (
        <SelectTable<SelectionUser>
          key="users"
          rows={users}
          idOf={(u) => u.user_id}
          selected={selUsers}
          onChange={setSelUsers}
          flag={(u) => u.is_deleted}
          flagTitle="Desmarcar os desativados"
          placeholder="Filtrar por usuário, nome ou e-mail"
          match={(u, q) => [u.username, u.name, u.email].some((v) => v?.toLowerCase().includes(q))}
          empty="Nenhum usuário no arquivo."
          head={
            <>
              <th>Usuário</th>
              <th className="imp-opt">E-mail</th>
              <th />
            </>
          }
          row={(u) => (
            <>
              <td>
                <div className="imp-strong">{u.username ? `@${u.username}` : <span className="muted">(sem nome de usuário)</span>}</div>
                {u.name && u.name !== u.username && <div className="small muted">{u.name}</div>}
                {u.email && <div className="small muted imp-phone-only">{u.email}</div>}
              </td>
              <td className="imp-opt ellipsis-cell">{u.email || <span className="muted">sem e-mail</span>}</td>
              <td className="imp-tags">
                {u.is_deleted && (
                  <span className="pill" title="Desativada na origem: a conta entra desativada">
                    Desativado
                  </span>
                )}
                {u.is_bot && <span className="pill">Bot</span>}
                {u.is_admin && (
                  <span className="pill" title={adminTitle(u, canGrantAdmin)}>
                    Admin
                  </span>
                )}
                {u.is_email_taken && (
                  <span className="pill accent" title="Os dados serão juntados à conta existente">
                    Já existe
                  </span>
                )}
              </td>
            </>
          )}
        />
      )}
      {tab === 'channels' && (
        <SelectTable<SelectionChannel>
          key="channels"
          rows={channels}
          idOf={(c) => c.channel_id}
          selected={selChannels}
          onChange={setSelChannels}
          flag={(c) => c.is_archived}
          flagTitle="Desmarcar os arquivados"
          placeholder="Filtrar por nome"
          match={(c, q) => channelLabel(c).toLowerCase().includes(q)}
          empty="Nenhum canal no arquivo."
          head={
            <>
              <th>Nome</th>
              <th className="imp-opt num">Membros</th>
              <th />
            </>
          }
          row={(c) => (
            <>
              <td>
                <span className="imp-strong imp-room">
                  <Icon name={c.channel_id === DIRECT_MESSAGES_ID ? 'room-direct' : roomIconName({ t: c.is_private ? 'p' : 'c' })} size={16} />
                  {channelLabel(c)}
                </span>
              </td>
              <td className="imp-opt num">{c.channel_id === DIRECT_MESSAGES_ID ? '—' : num(c.members)}</td>
              <td className="imp-tags">
                {c.is_archived && <span className="pill imp-status warn">Arquivado</span>}
                {c.is_private && !c.is_direct && <span className="pill">Privado</span>}
                {c.exists && (
                  <span className="pill accent" title="Já existe uma sala com esse nome (ou ela veio de uma importação anterior): as mensagens vão para ela">
                    Já existe
                  </span>
                )}
              </td>
            </>
          )}
        />
      )}
      {users.length > 0 && (
        <div className="card imp-options">
          <label className="check">
            <input type="checkbox" checked={sendEmails} onChange={(e) => setSendEmails(e.target.checked)} />
            Enviar e-mail para os novos usuários definirem a senha
          </label>
          <p className="field-hint">
            Precisa do envio de e-mail (SMTP) configurado em Configurações › E-mail. Vale só para contas novas e ativas que tenham e-mail; sem isso, a pessoa define a senha em "Esqueci minha senha".
          </p>
        </div>
      )}
      <div className="imp-actionbar">
        <span className="small muted imp-summary">{nothing ? 'Nada selecionado.' : `Para importar: ${joinList(summary)}.`}</span>
        <span className="spacer" />
        <button className="btn danger" disabled={starting} onClick={onCancel}>
          Cancelar
        </button>
        <button className="btn primary" disabled={nothing || starting} onClick={() => void start()}>
          {starting ? 'Começando…' : 'Começar a importação'}
        </button>
      </div>
    </>
  );
}

function channelLabel(c: SelectionChannel) {
  if (c.channel_id === DIRECT_MESSAGES_ID) return `Mensagens diretas (${plural(c.members, 'conversa', 'conversas')})`;
  return c.name || c.channel_id;
}

function joinList(items: string[]) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
}

function countSelected<T>(rows: T[], idOf: (r: T) => string, sel: Set<string>) {
  let n = 0;
  for (const r of rows) if (sel.has(idOf(r))) n++;
  return n;
}

function TabButton({ active, disabled, title, onClick, children }: { active?: boolean; disabled?: boolean; title?: string; onClick?: () => void; children: ReactNode }) {
  return (
    <button role="tab" aria-selected={!!active} className={active ? 'active' : ''} disabled={disabled} title={title} onClick={onClick}>
      {children}
    </button>
  );
}

function HeadCheckbox({ state, title, onClick }: { state: 'none' | 'some' | 'all'; title: string; onClick: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return <input ref={ref} type="checkbox" checked={state !== 'none'} title={title} aria-label={title} onChange={onClick} />;
}

const PAGE_SIZES = [25, 50, 100];

function SelectTable<T>({
  rows,
  idOf,
  selected,
  onChange,
  flag,
  flagTitle,
  placeholder,
  match,
  empty,
  head,
  row,
}: {
  rows: T[];
  idOf: (r: T) => string;
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
  flag?: (r: T) => boolean;
  flagTitle?: string;
  placeholder: string;
  match: (r: T, q: string) => boolean;
  empty: string;
  head: ReactNode;
  row: (r: T) => ReactNode;
}) {
  const [filter, setFilter] = useState('');
  const [size, setSize] = useState(25);
  const [page, setPage] = useState(0);
  const q = filter.trim().toLowerCase();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shown = useMemo(() => (q ? rows.filter((r) => match(r, q)) : rows), [rows, q]);
  const pages = Math.max(1, Math.ceil(shown.length / size));
  const p = Math.min(page, pages - 1);
  const from = p * size;
  const slice = shown.slice(from, from + size);

  // Ciclo do "marcar todos": nada marcado → todos; algum excluído/arquivado marcado → desmarca só esses; senão → nenhum.
  const ids = shown.map(idOf);
  const nSel = ids.filter((id) => selected.has(id)).length;
  const state = nSel === 0 ? 'none' : nSel === ids.length ? 'all' : 'some';
  const flagged = flag ? shown.filter((r) => flag(r) && selected.has(idOf(r))).map(idOf) : [];
  const action = nSel === 0 ? 'all' : flagged.length ? 'flagged' : 'none';
  const actionTitle = action === 'all' ? 'Marcar todos' : action === 'flagged' ? (flagTitle ?? 'Desmarcar') : 'Desmarcar todos';
  const cycle = () => {
    const next = new Set(selected);
    if (action === 'all') ids.forEach((id) => next.add(id));
    else (action === 'flagged' ? flagged : ids).forEach((id) => next.delete(id));
    onChange(next);
  };
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  if (!rows.length) return <Empty>{empty}</Empty>;

  return (
    <div className="imp-select">
      {rows.length > 10 && (
        <div className="filters">
          <input type="search" placeholder={placeholder} value={filter} onChange={(e) => (setFilter(e.target.value), setPage(0))} aria-label={placeholder} />
        </div>
      )}
      {!shown.length ? (
        <Empty>Nada encontrado com esse filtro.</Empty>
      ) : (
        <div className="imp-table-wrap">
          <table className="table imp-sel-table">
            <thead>
              <tr>
                <th className="imp-check">
                  <HeadCheckbox state={state} title={actionTitle} onClick={cycle} />
                </th>
                {head}
              </tr>
            </thead>
            <tbody>
              {slice.map((r, i) => {
                const id = idOf(r);
                const on = selected.has(id);
                return (
                  <tr key={`${id}:${from + i}`} className={`clickable ${on ? '' : 'imp-off'}`} onClick={(e) => (e.target as HTMLElement).tagName !== 'INPUT' && toggle(id)}>
                    <td className="imp-check">
                      <input type="checkbox" checked={on} onChange={() => toggle(id)} aria-label="Importar" />
                    </td>
                    {row(r)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {shown.length > PAGE_SIZES[0] && (
        <div className="imp-pager">
          <label className="small muted">
            Itens por página{' '}
            <select value={size} onChange={(e) => (setSize(Number(e.target.value)), setPage(0))}>
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <span className="spacer" />
          <span className="small muted nowrap">
            {num(from + 1)}–{num(Math.min(from + size, shown.length))} de {num(shown.length)}
          </span>
          <button className="btn small icon-only" disabled={p === 0} onClick={() => setPage(p - 1)} aria-label="Página anterior">
            <Icon name="prev" />
          </button>
          <button className="btn small icon-only" disabled={p >= pages - 1} onClick={() => setPage(p + 1)} aria-label="Próxima página">
            <Icon name="next" />
          </button>
        </div>
      )}
    </div>
  );
}

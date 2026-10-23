import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useStore } from '../../lib/store';
import { Icon, type IconName } from '../../components/Icon';
import { confirmDialog, Empty, Field, Modal, Pager, SearchInput, SkeletonTable, Toggle, useAsync } from '../../components/ui';
import { ActivePill, PageHead, RowMenu, TableWrap, UserCell } from './parts';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const ok = (t: string) => useStore.getState().toast(t);

type Section = 'departments' | 'agents' | 'managers' | 'monitors' | 'units' | 'tags' | 'priorities' | 'sla' | 'hours' | 'fields' | 'triggers' | 'offline' | 'install';

const SECTIONS: { id: Section; label: string; icon: IconName }[] = [
  { id: 'departments', label: 'Departamentos', icon: 'room-team' },
  { id: 'agents', label: 'Agentes', icon: 'nav-omnichannel' },
  { id: 'managers', label: 'Gerentes', icon: 'manage-user' },
  { id: 'monitors', label: 'Monitores', icon: 'show' },
  { id: 'units', label: 'Unidades', icon: 'ldap-ou' },
  { id: 'tags', label: 'Tags', icon: 'tag' },
  { id: 'priorities', label: 'Prioridades', icon: 'priority' },
  { id: 'sla', label: 'SLA', icon: 'wait-time' },
  { id: 'hours', label: 'Horários', icon: 'calendar' },
  { id: 'fields', label: 'Campos personalizados', icon: 'custom-field' },
  { id: 'triggers', label: 'Gatilhos', icon: 'notice' },
  { id: 'offline', label: 'Mensagens offline', icon: 'email' },
  { id: 'install', label: 'Instalação', icon: 'code' },
];

// Confirmação das remoções (no lugar do window.confirm).
const confirmRemove = (title: string, body = 'Não dá para desfazer.') => confirmDialog({ title, body, confirmLabel: 'Remover', danger: true });

// Menu "Mais ações" da linha com a remoção (o nome, em button.link, abre a edição).
function RemoveMenu({ onRemove }: { onRemove: () => void }) {
  return (
    <RowMenu>
      {(close) => (
        <button className="danger" onClick={() => (close(), onRemove())}>
          <Icon name="delete" />
          Remover
        </button>
      )}
    </RowMenu>
  );
}

// Rodapé dos formulários: Cancelar e a ação principal, nessa ordem.
function FormFooter({ onCancel, onSave }: { onCancel: () => void; onSave: () => void }) {
  return (
    <>
      <button className="btn" onClick={onCancel}>
        Cancelar
      </button>
      <button className="btn primary" onClick={onSave}>
        Salvar
      </button>
    </>
  );
}

const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

export function AdminOmnichannel() {
  const [section, setSection] = useState<Section>('departments');
  return (
    <>
      <PageHead title="Omnichannel" />
      <div className="omni-admin">
        {/* As 13 seções numa subnavegação (a classe seg-nav fica: os testes E2E a usam). */}
        <nav className="seg-nav omni-subnav" aria-label="Seções do Omnichannel">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className={section === s.id ? 'on' : ''} aria-current={section === s.id ? 'page' : undefined} onClick={() => setSection(s.id)}>
              <Icon name={s.icon} />
              {s.label}
            </button>
          ))}
        </nav>
        <div className="omni-main">
          {section === 'departments' && <Departments />}
          {section === 'agents' && <LivechatUsers type="agent" />}
          {section === 'managers' && <LivechatUsers type="manager" />}
          {section === 'monitors' && <LivechatUsers type="monitor" />}
          {section === 'units' && <Units />}
          {section === 'tags' && <TagsSection />}
          {section === 'priorities' && <Priorities />}
          {section === 'sla' && <SlaSection />}
          {section === 'hours' && <BusinessHours />}
          {section === 'fields' && <CustomFields />}
          {section === 'triggers' && <Triggers />}
          {section === 'offline' && <OfflineMessages />}
          {section === 'install' && <Install />}
        </div>
      </div>
    </>
  );
}

function useDepartments() {
  return useAsync(() => api.get('livechat/department', { count: 500 }).then((r: any) => r.departments as any[]), []);
}

function MultiCheck({ options, value, onChange }: { options: { id: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  if (!options.length) return <div className="muted small">Nenhuma opção disponível.</div>;
  return (
    <div className="check-list">
      {options.map((o) => (
        <label key={o.id} className="check">
          <input type="checkbox" checked={value.includes(o.id)} onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((x) => x !== o.id))} />
          {o.label}
        </label>
      ))}
    </div>
  );
}

// Lista vazia de cada seção: o que ela é e para que serve (o botão "Novo" fica no cabeçalho do cartão).
const EMPTY: Record<string, { icon: IconName; title: string; body: string }> = {
  Departamentos: { icon: 'room-team', title: 'Nenhum departamento', body: 'Departamentos agrupam agentes e recebem os atendimentos de um assunto ou equipe.' },
  Unidades: { icon: 'ldap-ou', title: 'Nenhuma unidade', body: 'Unidades juntam departamentos para que monitores acompanhem só as conversas deles.' },
  Tags: { icon: 'tag', title: 'Nenhuma tag', body: 'Tags classificam os atendimentos ao encerrar e aparecem nos relatórios.' },
  'Políticas de SLA': { icon: 'wait-time', title: 'Nenhuma política de SLA', body: 'O SLA define o prazo de resposta e ordena a fila pelo que vence primeiro.' },
  'Horários de atendimento': { icon: 'calendar', title: 'Nenhum horário', body: 'Fora do horário, o widget mostra o formulário de mensagem offline.' },
  'Campos personalizados': { icon: 'custom-field', title: 'Nenhum campo personalizado', body: 'Campos extras do visitante ou do atendimento, preenchidos no widget ou pelo agente.' },
  'Gatilhos do widget': { icon: 'notice', title: 'Nenhum gatilho', body: 'Gatilhos enviam uma mensagem automática no widget quando uma condição acontece.' },
  'Mensagens offline': { icon: 'email', title: 'Nenhuma mensagem offline', body: 'Mensagens deixadas no widget fora do horário de atendimento aparecem aqui.' },
};

function SimpleList({ title, onNew, children, loading, empty }: { title?: string; onNew?: () => void; children: React.ReactNode; loading?: boolean; empty?: boolean }) {
  const empt = (title && EMPTY[title]) || { icon: 'nav-omnichannel' as IconName, title: 'Nada cadastrado ainda', body: 'Os itens aparecem aqui assim que existirem.' };
  const newButton = onNew && (
    <button className="btn primary small" onClick={onNew}>
      <Icon name="add" />
      {/* O E2E procura "＋ Novo": o sinal fica no texto, escondido (o ícone faz o papel dele). */}
      <span className="visually-hidden" aria-hidden="true">
        {'＋ '}
      </span>
      Novo
    </button>
  );
  return (
    <div className="card omni-card">
      {(title || onNew) && (
        <div className="card-head">
          <h2>{title}</h2>
          {newButton}
        </div>
      )}
      {loading ? (
        <SkeletonTable rows={4} cols={3} />
      ) : empty ? (
        <Empty icon={empt.icon} title={empt.title}>
          {empt.body}
        </Empty>
      ) : (
        children
      )}
    </div>
  );
}

// ---------- Departamentos ----------

function Departments() {
  const { data, loading, reload } = useDepartments();
  const [edit, setEdit] = useState<any>(null);
  const open = async (id?: string) => {
    if (!id)
      return setEdit({
        department: {
          enabled: true,
          showOnRegistration: true,
          showOnOfflineForm: true,
        },
        agents: [],
      });
    try {
      setEdit(await api.get(`livechat/department/${id}`));
    } catch (e) {
      fail(e);
    }
  };
  const remove = async (d: any) => {
    if (!(await confirmRemove(`Remover o departamento ${d.name}?`))) return;
    await api.del(`livechat/department/${d._id}`).then(reload, fail);
  };
  return (
    <>
      <SimpleList title="Departamentos" onNew={() => open()} loading={loading} empty={!data?.length}>
        <TableWrap>
          <table className="table stack kv">
            <thead>
              <tr>
                <th>Nome</th>
                <th className="num">Agentes</th>
                <th>Status</th>
                <th className="actions-col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data?.map((d) => (
                <tr key={d._id}>
                  <td>
                    <button className="link" onClick={() => open(d._id)}>
                      {d.name}
                    </button>
                    {d.description && <div className="muted small">{d.description}</div>}
                  </td>
                  <td className="num" data-label="Agentes">
                    {d.numAgents ?? 0}
                  </td>
                  <td data-label="Status">
                    <ActivePill active={!!d.enabled} />
                  </td>
                  <td className="actions-col">
                    <div className="row-actions">
                      <RemoveMenu onRemove={() => remove(d)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </SimpleList>
      {edit && <DepartmentForm initial={edit} departments={data ?? []} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), reload())} />}
    </>
  );
}

function DepartmentForm({ initial, departments, onClose, onSaved }: { initial: any; departments: any[]; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<any>({ ...initial.department });
  const [agents, setAgents] = useState<{ agentId: string; username: string; order: number }[]>(initial.agents ?? []);
  const [addName, setAddName] = useState('');
  const allAgents = useAsync(() => api.get('livechat/users/agent', { count: 500 }).then((r: any) => r.users as any[]), []);
  const units = useAsync(
    () =>
      api
        .get('livechat/units')
        .then((r: any) => r.units as any[])
        .catch(() => []),
    [],
  );
  const hours = useAsync(
    () =>
      api
        .get('livechat/business-hours')
        .then((r: any) => r.businessHours as any[])
        .catch(() => []),
    [],
  );
  const set = (k: string, v: unknown) => setD({ ...d, [k]: v });
  const addAgent = () => {
    const a = allAgents.data?.find((x) => x.username === addName.replace(/^@/, ''));
    if (!a) return fail(new Error('Agente não encontrado. Cadastre o usuário como agente primeiro.'));
    if (!agents.some((x) => x.agentId === a._id)) setAgents([...agents, { agentId: a._id, username: a.username, order: agents.length }]);
    setAddName('');
  };
  const save = async () => {
    const body = {
      department: {
        name: d.name,
        description: d.description,
        enabled: d.enabled,
        showOnRegistration: d.showOnRegistration,
        showOnOfflineForm: d.showOnOfflineForm,
        email: d.email,
        requestTagBeforeClosingChat: d.requestTagBeforeClosingChat,
        maxNumberSimultaneousChat: d.maxNumberSimultaneousChat,
        fallbackForwardDepartment: d.fallbackForwardDepartment || null,
        businessHourId: d.businessHourId || null,
        unitId: d.unitId || null,
        waitingQueueMessage: d.waitingQueueMessage,
      },
      agents: agents.map((a, i) => ({ agentId: a.agentId, order: i })),
    };
    try {
      if (d._id) await api.put(`livechat/department/${d._id}`, body);
      else await api.post('livechat/department', body);
      ok('Departamento salvo.');
      onSaved();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Modal
      wide
      title={d._id ? `Departamento: ${initial.department.name}` : 'Novo departamento'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" onClick={save}>
            Salvar
          </button>
        </>
      }
    >
      <div className="grid-2 omni-form-cols">
        <div className="form">
          <Field label="Nome">
            <input value={d.name ?? ''} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Descrição">
            <textarea rows={2} value={d.description ?? ''} onChange={(e) => set('description', e.target.value)} />
          </Field>
          <Field label="E-mail do departamento">
            <input value={d.email ?? ''} onChange={(e) => set('email', e.target.value)} />
          </Field>
          <div className="toggle-list">
            <Toggle checked={!!d.enabled} onChange={(v) => set('enabled', v)} label="Ativo" />
            <Toggle checked={!!d.showOnRegistration} onChange={(v) => set('showOnRegistration', v)} label="Mostrar no formulário de cadastro" />
            <Toggle checked={!!d.showOnOfflineForm} onChange={(v) => set('showOnOfflineForm', v)} label="Mostrar no formulário offline" />
            <Toggle checked={!!d.requestTagBeforeClosingChat} onChange={(v) => set('requestTagBeforeClosingChat', v)} label="Exigir tag ao encerrar" />
          </div>
        </div>
        <div className="form">
          <Field label="Máximo de conversas simultâneas por agente" hint="0 usa o valor geral.">
            <input type="number" min={0} value={d.maxNumberSimultaneousChat ?? 0} onChange={(e) => set('maxNumberSimultaneousChat', Number(e.target.value))} />
          </Field>
          <Field label="Departamento reserva" hint="Recebe as conversas quando ninguém daqui está disponível.">
            <select value={d.fallbackForwardDepartment ?? ''} onChange={(e) => set('fallbackForwardDepartment', e.target.value)}>
              <option value="">Nenhum</option>
              {departments
                .filter((x) => x._id !== d._id)
                .map((x) => (
                  <option key={x._id} value={x._id}>
                    {x.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Horário de atendimento">
            <select value={d.businessHourId ?? ''} onChange={(e) => set('businessHourId', e.target.value)}>
              <option value="">Padrão</option>
              {(hours.data ?? [])
                .filter((h) => h._id !== 'default')
                .map((h) => (
                  <option key={h._id} value={h._id}>
                    {h.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Unidade">
            <select value={d.unitId ?? ''} onChange={(e) => set('unitId', e.target.value)}>
              <option value="">Nenhuma</option>
              {(units.data ?? []).map((u) => (
                <option key={u._id} value={u._id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Mensagem da fila de espera">
            <textarea rows={2} value={d.waitingQueueMessage ?? ''} onChange={(e) => set('waitingQueueMessage', e.target.value)} />
          </Field>
        </div>
      </div>
      <h3 className="omni-form-title">Agentes</h3>
      <div className="row omni-toolbar">
        <input
          list="omni-agents"
          placeholder="@usuário do agente"
          aria-label="Agente para adicionar"
          value={addName}
          onChange={(e) => setAddName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addAgent()}
        />
        <datalist id="omni-agents">
          {(allAgents.data ?? []).map((a) => (
            <option key={a._id} value={a.username} />
          ))}
        </datalist>
        <button className="btn" onClick={addAgent}>
          <Icon name="add" />
          Adicionar
        </button>
      </div>
      {agents.length > 0 && (
        <TableWrap>
          <table className="table omni-agents">
            <tbody>
              {agents.map((a, i) => (
                <tr key={a.agentId}>
                  <td className="num omni-order">{i + 1}</td>
                  <td>
                    <UserCell username={a.username} />
                  </td>
                  <td className="actions-col">
                    {/* Ordem e remoção sempre à vista: dentro do formulário não há hover para revelar. */}
                    <div className="omni-order-actions">
                      <button className="btn small ghost icon-only" disabled={i === 0} onClick={() => setAgents(swap(agents, i, i - 1))} title="Subir" aria-label="Subir">
                        <Icon name="move-up" />
                      </button>
                      <button className="btn small ghost icon-only" disabled={i === agents.length - 1} onClick={() => setAgents(swap(agents, i, i + 1))} title="Descer" aria-label="Descer">
                        <Icon name="move-down" />
                      </button>
                      <button
                        className="btn small ghost icon-only danger"
                        onClick={() => setAgents(agents.filter((x) => x.agentId !== a.agentId))}
                        title={`Tirar @${a.username} do departamento`}
                        aria-label={`Tirar @${a.username} do departamento`}
                      >
                        <Icon name="delete" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {!agents.length && <div className="muted small">Nenhum agente neste departamento.</div>}
    </Modal>
  );
}

function swap<T>(arr: T[], a: number, b: number) {
  const out = [...arr];
  [out[a], out[b]] = [out[b], out[a]];
  return out;
}

// ---------- Agentes, gerentes e monitores ----------

const USER_TITLE = {
  agent: 'Agentes',
  manager: 'Gerentes',
  monitor: 'Monitores',
} as const;
const LIVE_STATUS: Record<string, string> = {
  available: 'Disponível',
  'not-available': 'Indisponível',
};

function LivechatUsers({ type }: { type: 'agent' | 'manager' | 'monitor' }) {
  const [offset, setOffset] = useState(0);
  const [text, setText] = useState('');
  const { data, loading, reload } = useAsync(() => api.get(`livechat/users/${type}`, { text, offset, count: 50 }), [type, text, offset]);
  const [username, setUsername] = useState('');
  const [edit, setEdit] = useState<any>(null);
  const add = async () => {
    if (!username.trim()) return;
    try {
      await api.post(`livechat/users/${type}`, { username: username.trim() });
      setUsername('');
      reload();
    } catch (e) {
      fail(e);
    }
  };
  const remove = async (u: any) => {
    if (!(await confirmRemove(`Remover @${u.username} de ${USER_TITLE[type].toLowerCase()}?`))) return;
    await api.del(`livechat/users/${type}/${u._id}`).then(reload, fail);
  };
  return (
    <div className="card">
      <div className="card-head">
        <h2>{USER_TITLE[type]}</h2>
      </div>
      <div className="row omni-toolbar">
        <input placeholder="@usuário" aria-label="Usuário para adicionar" value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="btn primary" onClick={add}>
          <Icon name="add" />
          Adicionar
        </button>
        <SearchInput className="omni-search" value={text} onChange={(v) => (setText(v), setOffset(0))} placeholder="Buscar" />
      </div>
      {loading || !data ? (
        <SkeletonTable rows={4} cols={4} />
      ) : !data.users.length ? (
        <Empty icon={type === 'agent' ? 'nav-omnichannel' : 'manage-user'} title="Ninguém cadastrado">
          Digite o @usuário acima e use Adicionar.
        </Empty>
      ) : (
        <TableWrap>
          <table className="table stack kv">
            <thead>
              <tr>
                <th>Usuário</th>
                <th className="col-lg">E-mail</th>
                {type === 'agent' && (
                  <>
                    <th>Status</th>
                    <th className="num">Abertas</th>
                    <th className="col-md">Departamentos</th>
                  </>
                )}
                <th className="actions-col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u: any) => (
                <tr key={u._id}>
                  <td>
                    <UserCell username={u.username} name={u.name} />
                  </td>
                  <td className="muted ellipsis-cell col-lg" data-label="E-mail" title={u.emails[0]?.address}>
                    {u.emails[0]?.address ?? '—'}
                  </td>
                  {type === 'agent' && (
                    <>
                      <td data-label="Status">
                        <ActivePill active={u.statusLivechat === 'available'} on={LIVE_STATUS.available} off={LIVE_STATUS[u.statusLivechat] ?? u.statusLivechat} />
                      </td>
                      <td className="num nowrap" data-label="Abertas">
                        {u.openChats}
                        {u.livechat?.maxNumberSimultaneousChat ? ` / ${u.livechat.maxNumberSimultaneousChat}` : ''}
                      </td>
                      <td className="col-md" data-label="Departamentos">
                        {u.departments.length ? u.departments.join(', ') : <span className="muted">—</span>}
                      </td>
                    </>
                  )}
                  <td className="actions-col">
                    <div className="row-actions">
                      {type === 'agent' && (
                        <button className="btn small ghost" onClick={() => setEdit(u)}>
                          <Icon name="edit" />
                          Editar
                        </button>
                      )}
                      <RemoveMenu onRemove={() => remove(u)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {data && <Pager offset={offset} count={50} total={data.total} onChange={setOffset} />}
      {edit && <AgentForm agent={edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), reload())} />}
    </div>
  );
}

function AgentForm({ agent, onClose, onSaved }: { agent: any; onClose: () => void; onSaved: () => void }) {
  const info = useAsync(() => api.get(`livechat/agents/${agent._id}`).then((r: any) => r.agent), [agent._id]);
  const deps = useDepartments();
  const [form, setForm] = useState<{
    max?: string;
    departments?: string[];
    status?: string;
  }>({});
  if (!info.data || !deps.data) return null;
  const max = form.max ?? String(info.data.livechat?.maxNumberSimultaneousChat ?? '');
  const departments = form.departments ?? info.data.departments.map((d: any) => d._id);
  const status = form.status ?? info.data.statusLivechat;
  const save = async () => {
    try {
      await api.post(`livechat/agents/${agent._id}`, {
        maxNumberSimultaneousChat: max === '' ? null : Number(max),
        departments,
        status,
      });
      ok('Agente salvo.');
      onSaved();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Modal title={`Agente @${agent.username}`} onClose={onClose} footer={<FormFooter onCancel={onClose} onSave={save} />}>
      <div className="form">
        <Field label="Status no omnichannel">
          <select value={status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            <option value="available">Disponível</option>
            <option value="not-available">Indisponível</option>
          </select>
        </Field>
        <Field label="Máximo de conversas simultâneas" hint="Vazio usa o limite do departamento ou o geral.">
          <input type="number" min={0} value={max} onChange={(e) => setForm({ ...form, max: e.target.value })} />
        </Field>
        <Field label="Departamentos">
          <MultiCheck options={deps.data.map((d) => ({ id: d._id, label: d.name }))} value={departments} onChange={(v) => setForm({ ...form, departments: v })} />
        </Field>
      </div>
    </Modal>
  );
}

// ---------- Unidades ----------

function Units() {
  const { data, loading, reload } = useAsync(() => api.get('livechat/units').then((r: any) => r.units as any[]), []);
  const [edit, setEdit] = useState<any>(null);
  const remove = async (u: any) => {
    if (!(await confirmRemove(`Remover a unidade ${u.name}?`))) return;
    await api.del(`livechat/units/${u._id}`).then(reload, fail);
  };
  return (
    <>
      <SimpleList title="Unidades" onNew={() => setEdit({ visibility: 'public', departments: [], monitors: [] })} loading={loading} empty={!data?.length}>
        <p className="muted small">Monitores só veem as conversas dos departamentos das suas unidades.</p>
        <TableWrap>
          <table className="table stack kv">
            <thead>
              <tr>
                <th>Nome</th>
                <th className="num">Departamentos</th>
                <th>Monitores</th>
                <th className="actions-col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data?.map((u) => (
                <tr key={u._id}>
                  <td>
                    <button
                      className="link"
                      onClick={() =>
                        setEdit({
                          ...u,
                          monitors: u.monitors.map((m: any) => m._id),
                        })
                      }
                    >
                      {u.name}
                    </button>
                  </td>
                  <td className="num" data-label="Departamentos">
                    {u.departments.length}
                  </td>
                  <td data-label="Monitores">{u.monitors.length ? u.monitors.map((m: any) => '@' + m.username).join(', ') : <span className="muted">—</span>}</td>
                  <td className="actions-col">
                    <div className="row-actions">
                      <RemoveMenu onRemove={() => remove(u)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </SimpleList>
      {edit && <UnitForm initial={edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), reload())} />}
    </>
  );
}

function UnitForm({ initial, onClose, onSaved }: { initial: any; onClose: () => void; onSaved: () => void }) {
  const [u, setU] = useState<any>(initial);
  const deps = useDepartments();
  const monitors = useAsync(() => api.get('livechat/users/monitor', { count: 500 }).then((r: any) => r.users as any[]), []);
  const save = async () => {
    try {
      await api.post('livechat/units', u);
      ok('Unidade salva.');
      onSaved();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Modal title={u._id ? `Unidade: ${initial.name}` : 'Nova unidade'} onClose={onClose} footer={<FormFooter onCancel={onClose} onSave={save} />}>
      <div className="form">
        <Field label="Nome">
          <input value={u.name ?? ''} onChange={(e) => setU({ ...u, name: e.target.value })} />
        </Field>
        <Field label="Visibilidade">
          <select value={u.visibility} onChange={(e) => setU({ ...u, visibility: e.target.value })}>
            <option value="public">Pública</option>
            <option value="private">Privada</option>
          </select>
        </Field>
        <Field label="Departamentos">
          <MultiCheck options={(deps.data ?? []).map((d) => ({ id: d._id, label: d.name }))} value={u.departments} onChange={(v) => setU({ ...u, departments: v })} />
        </Field>
        <Field label="Monitores" hint="Cadastre os monitores na aba Monitores.">
          <MultiCheck
            options={(monitors.data ?? []).map((m) => ({
              id: m._id,
              label: '@' + m.username,
            }))}
            value={u.monitors}
            onChange={(v) => setU({ ...u, monitors: v })}
          />
        </Field>
      </div>
    </Modal>
  );
}

// ---------- Tags ----------

function TagsSection() {
  const { data, loading, reload } = useAsync(() => api.get('livechat/tags').then((r: any) => r.tags as any[]), []);
  const deps = useDepartments();
  const [edit, setEdit] = useState<any>(null);
  const depName = (id: string) => deps.data?.find((d) => d._id === id)?.name ?? id;
  const save = async () => {
    try {
      await api.post('livechat/tags', edit);
      setEdit(null);
      reload();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <>
      <SimpleList title="Tags" onNew={() => setEdit({ departments: [] })} loading={loading} empty={!data?.length}>
        <TableWrap>
          <table className="table stack kv">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Departamentos</th>
                <th className="actions-col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data?.map((t) => (
                <tr key={t._id}>
                  <td>
                    <button className="link" onClick={() => setEdit(t)}>
                      {t.name}
                    </button>
                    {t.description && <div className="muted small">{t.description}</div>}
                  </td>
                  <td data-label="Departamentos">{t.departments.length ? t.departments.map(depName).join(', ') : <span className="muted">Todos</span>}</td>
                  <td className="actions-col">
                    <div className="row-actions">
                      <RemoveMenu onRemove={async () => (await confirmRemove(`Remover a tag ${t.name}?`)) && api.del(`livechat/tags/${t._id}`).then(reload, fail)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </SimpleList>
      {edit && (
        <Modal title={edit._id ? 'Editar tag' : 'Nova tag'} onClose={() => setEdit(null)} footer={<FormFooter onCancel={() => setEdit(null)} onSave={save} />}>
          <div className="form">
            <Field label="Nome">
              <input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            <Field label="Descrição">
              <input value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            </Field>
            <Field label="Departamentos" hint="Sem nenhum marcado, a tag vale para todos.">
              <MultiCheck
                options={(deps.data ?? []).map((d) => ({
                  id: d._id,
                  label: d.name,
                }))}
                value={edit.departments}
                onChange={(v) => setEdit({ ...edit, departments: v })}
              />
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------- Prioridades e SLA ----------

function Priorities() {
  const { data, loading, reload } = useAsync(() => api.get('livechat/priorities').then((r: any) => r.priorities as any[]), []);
  const [names, setNames] = useState<Record<string, string>>({});
  const save = (id: string, reset = false) =>
    api.put(`livechat/priorities/${id}`, reset ? { reset: true } : { name: names[id] }).then(() => (ok('Prioridade salva.'), setNames({ ...names, [id]: undefined as any }), reload()), fail);
  return (
    <SimpleList title="Prioridades" loading={loading}>
      <p className="muted small">A fila é ordenada pela prioridade e depois pelo prazo do SLA.</p>
      <TableWrap>
        <table className="table omni-priorities">
          <thead>
            <tr>
              <th className="num">Ordem</th>
              <th>Nome</th>
              <th className="actions-col">
                <span className="visually-hidden">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data?.map((p) => (
              <tr key={p._id}>
                <td className="num omni-order">{p.sortItem}</td>
                <td>
                  <input aria-label={`Nome da prioridade ${p.sortItem}`} value={names[p._id] ?? p.name} onChange={(e) => setNames({ ...names, [p._id]: e.target.value })} />
                </td>
                <td className="actions-col">
                  <div className="omni-order-actions">
                    {p.dirty && (
                      <button className="btn small ghost" onClick={() => save(p._id, true)}>
                        <Icon name="restore" />
                        Restaurar nome
                      </button>
                    )}
                    <button className="btn small primary" onClick={() => save(p._id)} disabled={names[p._id] === undefined}>
                      Salvar
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </SimpleList>
  );
}

function SlaSection() {
  const { data, loading, reload } = useAsync(() => api.get('livechat/sla').then((r: any) => r.sla as any[]), []);
  const [edit, setEdit] = useState<any>(null);
  const save = async () => {
    try {
      await api.post('livechat/sla', {
        ...edit,
        dueTimeInMinutes: Number(edit.dueTimeInMinutes),
      });
      setEdit(null);
      reload();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <>
      <SimpleList title="Políticas de SLA" onNew={() => setEdit({ dueTimeInMinutes: 15 })} loading={loading} empty={!data?.length}>
        <TableWrap>
          <table className="table stack kv">
            <thead>
              <tr>
                <th>Nome</th>
                <th className="num">Prazo para atender</th>
                <th className="actions-col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data?.map((s) => (
                <tr key={s._id}>
                  <td>
                    <button className="link" onClick={() => setEdit(s)}>
                      {s.name}
                    </button>
                    {s.description && <div className="muted small">{s.description}</div>}
                  </td>
                  <td className="num nowrap" data-label="Prazo">
                    {s.dueTimeInMinutes} min
                  </td>
                  <td className="actions-col">
                    <div className="row-actions">
                      <RemoveMenu onRemove={async () => (await confirmRemove(`Remover o SLA ${s.name}?`)) && api.del(`livechat/sla/${s._id}`).then(reload, fail)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </SimpleList>
      {edit && (
        <Modal title={edit._id ? 'Editar SLA' : 'Novo SLA'} onClose={() => setEdit(null)} footer={<FormFooter onCancel={() => setEdit(null)} onSave={save} />}>
          <div className="form">
            <Field label="Nome">
              <input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            <Field label="Descrição">
              <input value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            </Field>
            <Field label="Prazo em minutos">
              <input type="number" min={1} value={edit.dueTimeInMinutes} onChange={(e) => setEdit({ ...edit, dueTimeInMinutes: e.target.value })} />
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------- Horários de atendimento ----------

const DEFAULT_WEEK = WEEKDAYS.map((_, day) => ({
  day,
  open: '08:00',
  close: '18:00',
  enabled: day >= 1 && day <= 5,
}));

function BusinessHours() {
  const { data, loading, reload } = useAsync(() => api.get('livechat/business-hours').then((r: any) => r.businessHours as any[]), []);
  const [edit, setEdit] = useState<any>(null);
  return (
    <>
      <SimpleList
        title="Horários de atendimento"
        onNew={() =>
          setEdit({
            name: '',
            active: true,
            timezone: 'America/Sao_Paulo',
            workHours: DEFAULT_WEEK,
            departments: [],
          })
        }
        loading={loading}
      >
        <p className="muted small">Ative o controle por horário em Configurações › Omnichannel. Fora do horário, o widget mostra o formulário offline.</p>
        <TableWrap>
          <table className="table stack kv">
            <thead>
              <tr>
                <th>Nome</th>
                <th className="col-md">Fuso</th>
                <th>Agora</th>
                <th>Departamentos</th>
                <th className="actions-col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data?.map((h) => (
                <tr key={h._id}>
                  <td className="omni-hours-name">
                    <button
                      className="link"
                      onClick={() =>
                        setEdit({
                          ...h,
                          timezone: h.timezone.name,
                          departments: h.departments.map((d: any) => d._id),
                        })
                      }
                    >
                      {h.name}
                    </button>
                    {h.type === 'default' && <span className="pill tag">Padrão</span>}
                  </td>
                  <td className="muted nowrap col-md" data-label="Fuso">
                    {h.timezone.name}
                  </td>
                  <td data-label="Agora">
                    {!h.active ? <span className="pill">Desativado</span> : h.isOpenNow ? <span className="pill ok dot">Aberto</span> : <span className="pill dot">Fechado</span>}
                  </td>
                  <td data-label="Departamentos">
                    {h.type === 'default' ? <span className="muted">Os demais</span> : h.departments.length ? h.departments.map((d: any) => d.name).join(', ') : <span className="muted">—</span>}
                  </td>
                  <td className="actions-col">
                    {h.type !== 'default' && (
                      <div className="row-actions">
                        <RemoveMenu onRemove={async () => (await confirmRemove(`Remover ${h.name}?`)) && api.del(`livechat/business-hours/${h._id}`).then(reload, fail)} />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </SimpleList>
      {edit && <BusinessHourForm initial={edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), reload())} />}
    </>
  );
}

function BusinessHourForm({ initial, onClose, onSaved }: { initial: any; onClose: () => void; onSaved: () => void }) {
  const [h, setH] = useState<any>({
    ...initial,
    workHours: WEEKDAYS.map(
      (_, day) =>
        initial.workHours?.find((w: any) => w.day === day) ?? {
          day,
          open: '08:00',
          close: '18:00',
          enabled: false,
        },
    ),
  });
  const deps = useDepartments();
  const setDay = (day: number, patch: object) =>
    setH({
      ...h,
      workHours: h.workHours.map((w: any) => (w.day === day ? { ...w, ...patch } : w)),
    });
  const save = async () => {
    try {
      await api.post('livechat/business-hours', h);
      ok('Horário salvo.');
      onSaved();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Modal wide title={h._id ? `Horário: ${initial.name}` : 'Novo horário'} onClose={onClose} footer={<FormFooter onCancel={onClose} onSave={save} />}>
      <div className="form">
        <div className="grid-2 omni-form-cols">
          <Field label="Nome">
            <input value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} />
          </Field>
          <Field label="Fuso horário">
            <input value={h.timezone} onChange={(e) => setH({ ...h, timezone: e.target.value })} placeholder="America/Sao_Paulo" />
          </Field>
        </div>
        <Toggle checked={h.active} onChange={(v) => setH({ ...h, active: v })} label="Ativo" />
        <table className="table omni-week">
          <tbody>
            {h.workHours.map((w: any) => (
              <tr key={w.day}>
                <td>
                  <label className="check">
                    <input type="checkbox" checked={w.enabled} onChange={(e) => setDay(w.day, { enabled: e.target.checked })} /> {WEEKDAYS[w.day]}
                  </label>
                </td>
                <td>
                  <input type="time" value={w.open} disabled={!w.enabled} onChange={(e) => setDay(w.day, { open: e.target.value })} />
                </td>
                <td>
                  <input type="time" value={w.close} disabled={!w.enabled} onChange={(e) => setDay(w.day, { close: e.target.value })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {h._id !== 'default' && (
          <Field label="Departamentos que seguem este horário">
            <MultiCheck
              options={(deps.data ?? []).map((d) => ({
                id: d._id,
                label: d.name,
              }))}
              value={h.departments}
              onChange={(v) => setH({ ...h, departments: v })}
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}

// ---------- Campos personalizados ----------

function CustomFields() {
  const { data, loading, reload } = useAsync(() => api.get('livechat/custom-fields').then((r: any) => r.customFields as any[]), []);
  const [edit, setEdit] = useState<any>(null);
  const save = async () => {
    try {
      await api.post('livechat/custom-fields', {
        ...edit,
        field: edit.field ?? edit._id,
        options: typeof edit.options === 'string' ? edit.options.split(',').map((s: string) => s.trim()) : edit.options,
      });
      setEdit(null);
      reload();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <>
      <SimpleList
        title="Campos personalizados"
        onNew={() =>
          setEdit({
            isNew: true,
            scope: 'visitor',
            visibility: 'visible',
            public: true,
            options: [],
          })
        }
        loading={loading}
        empty={!data?.length}
      >
        <TableWrap>
          <table className="table stack kv">
            <thead>
              <tr>
                <th>Rótulo</th>
                <th className="col-md">Identificador</th>
                <th>Escopo</th>
                <th>Preenchimento</th>
                <th className="actions-col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data?.map((f) => (
                <tr key={f._id}>
                  <td>
                    <button className="link" onClick={() => setEdit({ ...f, field: f._id })}>
                      {f.label}
                    </button>
                  </td>
                  <td className="mono small muted col-md" data-label="Identificador">
                    {f._id}
                  </td>
                  <td data-label="Escopo">{f.scope === 'room' ? 'Conversa' : 'Contato'}</td>
                  <td data-label="Preenchimento">{f.required ? <span className="pill accent">Obrigatório</span> : <span className="muted">Opcional</span>}</td>
                  <td className="actions-col">
                    <div className="row-actions">
                      <RemoveMenu onRemove={async () => (await confirmRemove(`Remover o campo ${f.label}?`)) && api.del(`livechat/custom-fields/${f._id}`).then(reload, fail)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </SimpleList>
      {edit && (
        <Modal title={edit.isNew ? 'Novo campo' : 'Editar campo'} onClose={() => setEdit(null)} footer={<FormFooter onCancel={() => setEdit(null)} onSave={save} />}>
          <div className="form">
            <Field label="Identificador" hint="Letras, números, - e _.">
              <input value={edit.field ?? ''} disabled={!edit.isNew} onChange={(e) => setEdit({ ...edit, field: e.target.value })} />
            </Field>
            <Field label="Rótulo">
              <input value={edit.label ?? ''} onChange={(e) => setEdit({ ...edit, label: e.target.value })} />
            </Field>
            <Field label="Escopo">
              <select value={edit.scope} onChange={(e) => setEdit({ ...edit, scope: e.target.value })}>
                <option value="visitor">Contato</option>
                <option value="room">Conversa</option>
              </select>
            </Field>
            <Field label="Opções" hint="Separe por vírgula para virar uma lista de escolha.">
              <input value={Array.isArray(edit.options) ? edit.options.join(', ') : edit.options} onChange={(e) => setEdit({ ...edit, options: e.target.value })} />
            </Field>
            <Field label="Validação (expressão regular)">
              <input value={edit.regexp ?? ''} onChange={(e) => setEdit({ ...edit, regexp: e.target.value })} />
            </Field>
            <Field label="Valor padrão">
              <input value={edit.defaultValue ?? ''} onChange={(e) => setEdit({ ...edit, defaultValue: e.target.value })} />
            </Field>
            <div className="toggle-list">
              <Toggle checked={!!edit.required} onChange={(v) => setEdit({ ...edit, required: v })} label="Obrigatório" />
              <Toggle checked={edit.visibility !== 'hidden'} onChange={(v) => setEdit({ ...edit, visibility: v ? 'visible' : 'hidden' })} label="Visível" />
              <Toggle checked={!!edit.public} onChange={(v) => setEdit({ ...edit, public: v })} label="Pedir no widget" />
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------- Gatilhos ----------

const CONDITION_LABEL: Record<string, string> = {
  'time-on-site': 'Tempo no site (segundos)',
  'page-url': 'Endereço da página contém',
  'chat-opened-by-visitor': 'Visitante abriu o chat',
};

function Triggers() {
  const { data, loading, reload } = useAsync(() => api.get('livechat/triggers').then((r: any) => r.triggers as any[]), []);
  const [edit, setEdit] = useState<any>(null);
  const blank = {
    enabled: true,
    runOnce: false,
    conditions: [{ name: 'time-on-site', value: '10' }],
    actions: [{ name: 'send-message', params: { sender: 'queue', name: '', msg: '' } }],
  };
  const save = async () => {
    try {
      await api.post('livechat/triggers', edit);
      setEdit(null);
      reload();
    } catch (e) {
      fail(e);
    }
  };
  const cond = edit?.conditions[0];
  const act = edit?.actions[0]?.params;
  const setCond = (patch: object) => setEdit({ ...edit, conditions: [{ ...cond, ...patch }] });
  const setAct = (patch: object) =>
    setEdit({
      ...edit,
      actions: [{ name: 'send-message', params: { ...act, ...patch } }],
    });
  return (
    <>
      <SimpleList title="Gatilhos do widget" onNew={() => setEdit(blank)} loading={loading} empty={!data?.length}>
        <TableWrap>
          <table className="table stack kv">
            <thead>
              <tr>
                <th>Gatilho</th>
                <th>Status</th>
                <th className="actions-col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data?.map((t) => (
                <tr key={t._id}>
                  <td>
                    <button className="link" onClick={() => setEdit(t)}>
                      {t.name}
                    </button>
                    <div className="muted small">
                      {CONDITION_LABEL[t.conditions[0]?.name]} {t.conditions[0]?.value}
                    </div>
                  </td>
                  <td data-label="Status">
                    <ActivePill active={!!t.enabled} />
                  </td>
                  <td className="actions-col">
                    <div className="row-actions">
                      <RemoveMenu onRemove={async () => (await confirmRemove(`Remover o gatilho ${t.name}?`)) && api.del(`livechat/triggers/${t._id}`).then(reload, fail)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </SimpleList>
      {edit && (
        <Modal title={edit._id ? 'Editar gatilho' : 'Novo gatilho'} onClose={() => setEdit(null)} footer={<FormFooter onCancel={() => setEdit(null)} onSave={save} />}>
          <div className="form">
            <Field label="Nome">
              <input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            <Field label="Descrição">
              <input value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            </Field>
            <div className="toggle-list">
              <Toggle checked={edit.enabled} onChange={(v) => setEdit({ ...edit, enabled: v })} label="Ativo" />
              <Toggle checked={edit.runOnce} onChange={(v) => setEdit({ ...edit, runOnce: v })} label="Executar só uma vez por visitante" />
            </div>
            <Field label="Condição">
              <select value={cond.name} onChange={(e) => setCond({ name: e.target.value })}>
                {Object.entries(CONDITION_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            {cond.name !== 'chat-opened-by-visitor' && (
              <Field label="Valor">
                <input value={cond.value ?? ''} onChange={(e) => setCond({ value: e.target.value })} />
              </Field>
            )}
            <Field label="Remetente">
              <select value={act.sender} onChange={(e) => setAct({ sender: e.target.value })}>
                <option value="queue">Próximo agente da fila</option>
                <option value="custom">Nome personalizado</option>
              </select>
            </Field>
            {act.sender === 'custom' && (
              <Field label="Nome do remetente">
                <input value={act.name ?? ''} onChange={(e) => setAct({ name: e.target.value })} />
              </Field>
            )}
            <Field label="Mensagem">
              <textarea rows={3} value={act.msg ?? ''} onChange={(e) => setAct({ msg: e.target.value })} />
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------- Mensagens offline ----------

function OfflineMessages() {
  const [offset, setOffset] = useState(0);
  const { data, loading } = useAsync(() => api.get('livechat/offline.messages', { offset, count: 50 }), [offset]);
  return (
    <SimpleList title="Mensagens offline" loading={loading} empty={!data?.messages.length}>
      <TableWrap>
        <table className="table stack kv">
          <thead>
            <tr>
              <th>De</th>
              <th>Quando</th>
              <th className="col-md">Departamento</th>
              <th>Mensagem</th>
            </tr>
          </thead>
          <tbody>
            {data?.messages.map((m: any) => (
              <tr key={m._id}>
                <td>
                  <span className="cell-name">{m.name}</span>
                  <span className="cell-sub">{m.email}</span>
                </td>
                <td className="nowrap" data-label="Quando">
                  {formatDateTime(m.ts)}
                </td>
                <td className="col-md" data-label="Departamento">
                  {m.departmentName ?? <span className="muted">—</span>}
                </td>
                <td className="pre-wrap omni-message">{m.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      {data && <Pager offset={offset} count={50} total={data.total} onChange={setOffset} />}
    </SimpleList>
  );
}

// ---------- Instalação ----------

function Install() {
  const snippet = `<script src="${location.origin}/livechat/widget.js" async></script>`;
  const api2 = `<script src="${location.origin}/livechat/widget.js"
  onload="WesccLivechat.setGuest({ name: 'Maria', email: 'maria@exemplo.com' }); WesccLivechat.setDepartment('ID_DO_DEPARTAMENTO');"></script>
<!-- Também disponíveis: WesccLivechat.open() e WesccLivechat.close() -->`;
  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => ok('Copiado.'), fail);
  return (
    <div className="card">
      <div className="card-head">
        <h2>Instalar o widget no seu site</h2>
      </div>
      <p>Cole este código antes de &lt;/body&gt; nas páginas onde o chat deve aparecer:</p>
      <pre className="code-block">{snippet}</pre>
      <button className="btn" onClick={() => copy(snippet)}>
        <Icon name="copy" />
        Copiar
      </button>
      <h3 className="sub-title">Opções</h3>
      <pre className="code-block">{api2}</pre>
      <p className="muted small">
        Para limitar em quais sites o widget pode ser incorporado, preencha "Domínios permitidos" em Configurações › Omnichannel. Para testar agora, abra{' '}
        <a href="/livechat" target="_blank" rel="noreferrer">
          /livechat
        </a>
        .
      </p>
    </div>
  );
}

import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useStore } from '../../lib/store';
import { confirmAction, Empty, Field, Modal, Pager, Spinner, Toggle, useAsync } from '../../components/ui';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const ok = (t: string) => useStore.getState().toast(t);

type Section = 'departments' | 'agents' | 'managers' | 'monitors' | 'units' | 'tags' | 'priorities' | 'sla' | 'hours' | 'fields' | 'triggers' | 'offline' | 'install';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'departments', label: 'Departamentos' },
  { id: 'agents', label: 'Agentes' },
  { id: 'managers', label: 'Gerentes' },
  { id: 'monitors', label: 'Monitores' },
  { id: 'units', label: 'Unidades' },
  { id: 'tags', label: 'Tags' },
  { id: 'priorities', label: 'Prioridades' },
  { id: 'sla', label: 'SLA' },
  { id: 'hours', label: 'Horários' },
  { id: 'fields', label: 'Campos personalizados' },
  { id: 'triggers', label: 'Gatilhos' },
  { id: 'offline', label: 'Mensagens offline' },
  { id: 'install', label: 'Instalação' },
];

const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

export function AdminOmnichannel() {
  const [section, setSection] = useState<Section>('departments');
  return (
    <>
      <div className="page-title-row">
        <h1>Omnichannel</h1>
      </div>
      <div className="seg-nav">
        {SECTIONS.map((s) => (
          <button key={s.id} className={section === s.id ? 'on' : ''} onClick={() => setSection(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
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

function SimpleList({ title, onNew, children, loading, empty }: { title?: string; onNew?: () => void; children: React.ReactNode; loading?: boolean; empty?: boolean }) {
  return (
    <div className="card">
      {(title || onNew) && (
        <div className="page-title-row">
          <h3>{title}</h3>
          {onNew && (
            <button className="btn primary small" onClick={onNew}>
              ＋ Novo
            </button>
          )}
        </div>
      )}
      {loading ? <Spinner /> : empty ? <Empty>Nada cadastrado ainda.</Empty> : children}
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
    if (!confirmAction(`Remover o departamento ${d.name}?`)) return;
    await api.del(`livechat/department/${d._id}`).then(reload, fail);
  };
  return (
    <>
      <SimpleList title="Departamentos" onNew={() => open()} loading={loading} empty={!data?.length}>
        <table className="table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Agentes</th>
              <th>Ativo</th>
              <th />
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
                <td>{d.numAgents ?? 0}</td>
                <td>{d.enabled ? 'Sim' : 'Não'}</td>
                <td className="right">
                  <button className="btn small danger" onClick={() => remove(d)}>
                    Remover
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
      <div className="grid-2">
        <div>
          <Field label="Nome">
            <input value={d.name ?? ''} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Descrição">
            <textarea rows={2} value={d.description ?? ''} onChange={(e) => set('description', e.target.value)} />
          </Field>
          <Field label="E-mail do departamento">
            <input value={d.email ?? ''} onChange={(e) => set('email', e.target.value)} />
          </Field>
          <Toggle checked={!!d.enabled} onChange={(v) => set('enabled', v)} label="Ativo" />
          <Toggle checked={!!d.showOnRegistration} onChange={(v) => set('showOnRegistration', v)} label="Mostrar no formulário de cadastro" />
          <Toggle checked={!!d.showOnOfflineForm} onChange={(v) => set('showOnOfflineForm', v)} label="Mostrar no formulário offline" />
          <Toggle checked={!!d.requestTagBeforeClosingChat} onChange={(v) => set('requestTagBeforeClosingChat', v)} label="Exigir tag ao encerrar" />
        </div>
        <div>
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
      <h3>Agentes</h3>
      <div className="row">
        <input
          list="omni-agents"
          placeholder="@usuário do agente"
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
          Adicionar
        </button>
      </div>
      <table className="table">
        <tbody>
          {agents.map((a, i) => (
            <tr key={a.agentId}>
              <td>{i + 1}.</td>
              <td>@{a.username}</td>
              <td className="right">
                <button className="btn small" disabled={i === 0} onClick={() => setAgents(swap(agents, i, i - 1))} title="Subir">
                  ↑
                </button>
                <button className="btn small" disabled={i === agents.length - 1} onClick={() => setAgents(swap(agents, i, i + 1))} title="Descer">
                  ↓
                </button>
                <button className="btn small danger" onClick={() => setAgents(agents.filter((x) => x.agentId !== a.agentId))}>
                  Remover
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
    if (!confirmAction(`Remover @${u.username} de ${USER_TITLE[type].toLowerCase()}?`)) return;
    await api.del(`livechat/users/${type}/${u._id}`).then(reload, fail);
  };
  return (
    <div className="card">
      <h3>{USER_TITLE[type]}</h3>
      <div className="row">
        <input placeholder="@usuário" value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="btn primary" onClick={add}>
          Adicionar
        </button>
        <input placeholder="Buscar" value={text} onChange={(e) => (setText(e.target.value), setOffset(0))} />
      </div>
      {loading || !data ? (
        <Spinner />
      ) : !data.users.length ? (
        <Empty>Ninguém cadastrado.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Usuário</th>
              <th>E-mail</th>
              {type === 'agent' && (
                <>
                  <th>Status</th>
                  <th>Abertas</th>
                  <th>Departamentos</th>
                </>
              )}
              <th />
            </tr>
          </thead>
          <tbody>
            {data.users.map((u: any) => (
              <tr key={u._id}>
                <td>
                  {u.name} <span className="muted">@{u.username}</span>
                </td>
                <td>{u.emails[0]?.address}</td>
                {type === 'agent' && (
                  <>
                    <td>{LIVE_STATUS[u.statusLivechat] ?? u.statusLivechat}</td>
                    <td>
                      {u.openChats}
                      {u.livechat?.maxNumberSimultaneousChat ? ` / ${u.livechat.maxNumberSimultaneousChat}` : ''}
                    </td>
                    <td>{u.departments.join(', ')}</td>
                  </>
                )}
                <td className="right">
                  {type === 'agent' && (
                    <button className="btn small" onClick={() => setEdit(u)}>
                      Editar
                    </button>
                  )}
                  <button className="btn small danger" onClick={() => remove(u)}>
                    Remover
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
    <Modal
      title={`Agente @${agent.username}`}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={save}>
          Salvar
        </button>
      }
    >
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
    </Modal>
  );
}

// ---------- Unidades ----------

function Units() {
  const { data, loading, reload } = useAsync(() => api.get('livechat/units').then((r: any) => r.units as any[]), []);
  const [edit, setEdit] = useState<any>(null);
  const remove = async (u: any) => {
    if (!confirmAction(`Remover a unidade ${u.name}?`)) return;
    await api.del(`livechat/units/${u._id}`).then(reload, fail);
  };
  return (
    <>
      <SimpleList title="Unidades" onNew={() => setEdit({ visibility: 'public', departments: [], monitors: [] })} loading={loading} empty={!data?.length}>
        <p className="muted small">Monitores só veem as conversas dos departamentos das suas unidades.</p>
        <table className="table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Departamentos</th>
              <th>Monitores</th>
              <th />
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
                <td>{u.departments.length}</td>
                <td>{u.monitors.map((m: any) => '@' + m.username).join(', ')}</td>
                <td className="right">
                  <button className="btn small danger" onClick={() => remove(u)}>
                    Remover
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
    <Modal
      title={u._id ? `Unidade: ${initial.name}` : 'Nova unidade'}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={save}>
          Salvar
        </button>
      }
    >
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
        <table className="table">
          <tbody>
            {data?.map((t) => (
              <tr key={t._id}>
                <td>
                  <button className="link" onClick={() => setEdit(t)}>
                    {t.name}
                  </button>
                  {t.description && <div className="muted small">{t.description}</div>}
                </td>
                <td>{t.departments.length ? t.departments.map(depName).join(', ') : 'Todos os departamentos'}</td>
                <td className="right">
                  <button className="btn small danger" onClick={() => confirmAction(`Remover a tag ${t.name}?`) && api.del(`livechat/tags/${t._id}`).then(reload, fail)}>
                    Remover
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </SimpleList>
      {edit && (
        <Modal
          title={edit._id ? 'Editar tag' : 'Nova tag'}
          onClose={() => setEdit(null)}
          footer={
            <button className="btn primary" onClick={save}>
              Salvar
            </button>
          }
        >
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
    api
      .put(`livechat/priorities/${id}`, reset ? { reset: true } : { name: names[id] })
      .then(() => (ok('Prioridade salva.'), setNames({ ...names, [id]: undefined as any }), reload()), fail);
  return (
    <SimpleList title="Prioridades" loading={loading}>
      <p className="muted small">A fila é ordenada pela prioridade e depois pelo prazo do SLA.</p>
      <table className="table">
        <tbody>
          {data?.map((p) => (
            <tr key={p._id}>
              <td>{p.sortItem}</td>
              <td>
                <input value={names[p._id] ?? p.name} onChange={(e) => setNames({ ...names, [p._id]: e.target.value })} />
              </td>
              <td className="right">
                <button className="btn small primary" onClick={() => save(p._id)} disabled={names[p._id] === undefined}>
                  Salvar
                </button>
                {p.dirty && (
                  <button className="btn small" onClick={() => save(p._id, true)}>
                    Restaurar nome
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
        <table className="table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Prazo para atender</th>
              <th />
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
                <td>{s.dueTimeInMinutes} min</td>
                <td className="right">
                  <button className="btn small danger" onClick={() => confirmAction(`Remover o SLA ${s.name}?`) && api.del(`livechat/sla/${s._id}`).then(reload, fail)}>
                    Remover
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </SimpleList>
      {edit && (
        <Modal
          title={edit._id ? 'Editar SLA' : 'Novo SLA'}
          onClose={() => setEdit(null)}
          footer={
            <button className="btn primary" onClick={save}>
              Salvar
            </button>
          }
        >
          <Field label="Nome">
            <input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          </Field>
          <Field label="Descrição">
            <input value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
          </Field>
          <Field label="Prazo em minutos">
            <input type="number" min={1} value={edit.dueTimeInMinutes} onChange={(e) => setEdit({ ...edit, dueTimeInMinutes: e.target.value })} />
          </Field>
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
        <table className="table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Fuso</th>
              <th>Agora</th>
              <th>Departamentos</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.map((h) => (
              <tr key={h._id}>
                <td>
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
                  {h.type === 'default' && <span className="badge">padrão</span>}
                </td>
                <td>{h.timezone.name}</td>
                <td>{!h.active ? 'Desativado' : h.isOpenNow ? '🟢 Aberto' : '🔴 Fechado'}</td>
                <td>{h.type === 'default' ? 'Os demais' : h.departments.map((d: any) => d.name).join(', ')}</td>
                <td className="right">
                  {h.type !== 'default' && (
                    <button className="btn small danger" onClick={() => confirmAction(`Remover ${h.name}?`) && api.del(`livechat/business-hours/${h._id}`).then(reload, fail)}>
                      Remover
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
    <Modal
      wide
      title={h._id ? `Horário: ${initial.name}` : 'Novo horário'}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={save}>
          Salvar
        </button>
      }
    >
      <div className="grid-2">
        <Field label="Nome">
          <input value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} />
        </Field>
        <Field label="Fuso horário">
          <input value={h.timezone} onChange={(e) => setH({ ...h, timezone: e.target.value })} placeholder="America/Sao_Paulo" />
        </Field>
      </div>
      <Toggle checked={h.active} onChange={(v) => setH({ ...h, active: v })} label="Ativo" />
      <table className="table">
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
        <table className="table">
          <thead>
            <tr>
              <th>Rótulo</th>
              <th>Identificador</th>
              <th>Escopo</th>
              <th>Obrigatório</th>
              <th />
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
                <td>
                  <code>{f._id}</code>
                </td>
                <td>{f.scope === 'room' ? 'Conversa' : 'Contato'}</td>
                <td>{f.required ? 'Sim' : 'Não'}</td>
                <td className="right">
                  <button
                    className="btn small danger"
                    onClick={() => confirmAction(`Remover o campo ${f.label}?`) && api.del(`livechat/custom-fields/${f._id}`).then(reload, fail)}
                  >
                    Remover
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </SimpleList>
      {edit && (
        <Modal
          title={edit.isNew ? 'Novo campo' : 'Editar campo'}
          onClose={() => setEdit(null)}
          footer={
            <button className="btn primary" onClick={save}>
              Salvar
            </button>
          }
        >
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
          <Toggle checked={!!edit.required} onChange={(v) => setEdit({ ...edit, required: v })} label="Obrigatório" />
          <Toggle checked={edit.visibility !== 'hidden'} onChange={(v) => setEdit({ ...edit, visibility: v ? 'visible' : 'hidden' })} label="Visível" />
          <Toggle checked={!!edit.public} onChange={(v) => setEdit({ ...edit, public: v })} label="Pedir no widget" />
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
        <table className="table">
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
                <td>{t.enabled ? 'Ativo' : 'Inativo'}</td>
                <td className="right">
                  <button className="btn small danger" onClick={() => confirmAction(`Remover o gatilho ${t.name}?`) && api.del(`livechat/triggers/${t._id}`).then(reload, fail)}>
                    Remover
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </SimpleList>
      {edit && (
        <Modal
          title={edit._id ? 'Editar gatilho' : 'Novo gatilho'}
          onClose={() => setEdit(null)}
          footer={
            <button className="btn primary" onClick={save}>
              Salvar
            </button>
          }
        >
          <Field label="Nome">
            <input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          </Field>
          <Field label="Descrição">
            <input value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
          </Field>
          <Toggle checked={edit.enabled} onChange={(v) => setEdit({ ...edit, enabled: v })} label="Ativo" />
          <Toggle checked={edit.runOnce} onChange={(v) => setEdit({ ...edit, runOnce: v })} label="Executar só uma vez por visitante" />
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
      <table className="table">
        <thead>
          <tr>
            <th>Quando</th>
            <th>De</th>
            <th>Departamento</th>
            <th>Mensagem</th>
          </tr>
        </thead>
        <tbody>
          {data?.messages.map((m: any) => (
            <tr key={m._id}>
              <td>{formatDateTime(m.ts)}</td>
              <td>
                {m.name}
                <div className="muted small">{m.email}</div>
              </td>
              <td>{m.departmentName ?? '—'}</td>
              <td className="pre-wrap">{m.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
      <h3>Instalar o widget no seu site</h3>
      <p>Cole este código antes de &lt;/body&gt; nas páginas onde o chat deve aparecer:</p>
      <pre className="code-block">{snippet}</pre>
      <button className="btn" onClick={() => copy(snippet)}>
        Copiar
      </button>
      <h3>Opções</h3>
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

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useStore } from '../../lib/store';
import { Field, Modal, Pager, Spinner, Toggle, UserAvatar, useAsync } from '../../components/ui';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const ok = (t: string) => useStore.getState().toast(t);

export function AdminUsers() {
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const editId = params.get('edit');
  const { data, loading, reload } = useAsync(() => api.get('users.list', { filter, status, role, offset, count: 25 }), [filter, status, role, offset]);
  const roles = useAsync(() => api.get('roles.list'), []);

  return (
    <>
      <div className="page-title-row">
        <h1>Usuários</h1>
        <button className="btn primary" onClick={() => setCreating(true)}>
          ＋ Novo usuário
        </button>
      </div>
      <div className="filters">
        <input placeholder="Buscar por nome, usuário ou e-mail" value={filter} onChange={(e) => (setFilter(e.target.value), setOffset(0))} />
        <select value={status} onChange={(e) => (setStatus(e.target.value), setOffset(0))}>
          <option value="">Todos</option>
          <option value="active">Ativos</option>
          <option value="deactivated">Desativados</option>
        </select>
        <select value={role} onChange={(e) => (setRole(e.target.value), setOffset(0))}>
          <option value="">Qualquer papel</option>
          {roles.data?.roles.map((r: any) => (
            <option key={r._id} value={r._id}>
              {r._id}
            </option>
          ))}
        </select>
      </div>
      {loading ? (
        <Spinner />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Usuário</th>
              <th>E-mail</th>
              <th>Papéis</th>
              <th>Origem</th>
              <th>Status</th>
              <th>Último login</th>
            </tr>
          </thead>
          <tbody>
            {data?.users.map((u: any) => (
              <tr key={u._id} className="clickable" onClick={() => setParams({ edit: u._id })}>
                <td>
                  <UserAvatar username={u.username} size={24} status={u.status} /> {u.name}
                </td>
                <td>@{u.username}</td>
                <td>{u.email}</td>
                <td>
                  {u.roles.map((r: string) => (
                    <span key={r} className="pill">
                      {r}
                    </span>
                  ))}
                </td>
                <td>{u.authSource}</td>
                <td>{u.active ? '✅ ativo' : '⛔ desativado'}</td>
                <td className="muted">{formatDateTime(u.lastLogin)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && <Pager offset={offset} count={25} total={data.total} onChange={setOffset} />}
      {creating && <UserForm roles={roles.data?.roles ?? []} onClose={() => setCreating(false)} onSaved={reload} />}
      {editId && <UserForm id={editId} roles={roles.data?.roles ?? []} onClose={() => setParams({})} onSaved={reload} />}
    </>
  );
}

function UserForm({ id, roles, onClose, onSaved }: { id?: string; roles: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<any>({ name: '', username: '', email: '', password: '', roles: ['user'], active: true, verified: true, requirePasswordChange: false, joinDefaultChannels: true, type: 'user' });
  const [loaded, setLoaded] = useState(!id);
  const [sessions, setSessions] = useState<any[]>([]);
  useEffect(() => {
    if (!id) return;
    void api.get('users.info', { userId: id }).then((r) => {
      setF({ ...r.user, email: r.user.email ?? '', password: '', verified: r.user.emailVerified });
      setLoaded(true);
    });
    void api.get('sessions.list.all', { userId: id, count: 50 }).then((r) => setSessions(r.sessions)).catch(() => {});
  }, [id]);

  const save = async () => {
    try {
      if (id) {
        const data: any = { name: f.name, username: f.username, email: f.email, roles: f.roles, active: f.active, verified: f.verified, requirePasswordChange: f.requirePasswordChange, bio: f.bio };
        if (f.password) data.password = f.password;
        await api.post('users.update', { userId: id, data });
      } else {
        await api.post('users.create', f);
      }
      ok('Usuário salvo.');
      onSaved();
      onClose();
    } catch (e) {
      fail(e);
    }
  };
  const toggleRole = (r: string) => setF({ ...f, roles: f.roles.includes(r) ? f.roles.filter((x: string) => x !== r) : [...f.roles, r] });
  const globalRoles = roles.filter((r) => r.scope === 'Users');

  return (
    <Modal
      wide
      title={id ? `Editar @${f.username}` : 'Novo usuário'}
      onClose={onClose}
      footer={
        <>
          {id && (
            <button
              className="btn danger left"
              onClick={() => confirm(`Excluir @${f.username}? As mensagens dele permanecem.`) && api.post('users.delete', { userId: id }).then(() => (onSaved(), onClose())).catch(fail)}
            >
              Excluir
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" onClick={save}>
            Salvar
          </button>
        </>
      }
    >
      {!loaded ? (
        <Spinner />
      ) : (
        <div className="form two-col">
          <Field label="Nome">
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Nome de usuário">
            <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
          </Field>
          <Field label="E-mail">
            <input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </Field>
          <Field label={id ? 'Nova senha (deixe vazio para manter)' : 'Senha'}>
            <input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
          </Field>
          <div className="full">
            <span className="field-label">Papéis</span>
            <div className="chips">
              {globalRoles.map((r) => (
                <label key={r._id} className={`chip selectable ${f.roles.includes(r._id) ? 'on' : ''}`}>
                  <input type="checkbox" hidden checked={f.roles.includes(r._id)} onChange={() => toggleRole(r._id)} />
                  {r._id}
                </label>
              ))}
            </div>
          </div>
          <Toggle checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Ativo" />
          <Toggle checked={f.verified} onChange={(v) => setF({ ...f, verified: v })} label="E-mail verificado" />
          <Toggle checked={f.requirePasswordChange} onChange={(v) => setF({ ...f, requirePasswordChange: v })} label="Exigir troca de senha no próximo login" />
          {!id && <Toggle checked={f.joinDefaultChannels} onChange={(v) => setF({ ...f, joinDefaultChannels: v })} label="Entrar nos canais padrão" />}
          {!id && (
            <Field label="Tipo">
              <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
                <option value="user">Pessoa</option>
                <option value="bot">Bot</option>
              </select>
            </Field>
          )}
          {id && (
            <div className="full">
              <h4>Ações</h4>
              <div className="row-actions wrap">
                {f.twoFactorEnabled && (
                  <button className="btn" onClick={() => api.post('users.resetTOTP', { userId: id }).then(() => ok('2FA redefinido.')).catch(fail)}>
                    Redefinir 2FA
                  </button>
                )}
                <button className="btn" onClick={() => api.post('users.logout', { userId: id }).then((r) => (ok(r.message), setSessions([]))).catch(fail)}>
                  Encerrar todas as sessões
                </button>
                <button className="btn" onClick={() => api.post('users.resetAvatar', { userId: id }).then(() => ok('Avatar removido.')).catch(fail)}>
                  Remover avatar
                </button>
              </div>
              <h4>Sessões ativas ({sessions.length})</h4>
              <ul className="plain-list small">
                {sessions.map((s) => (
                  <li key={s._id}>
                    {s.device.name} · {s.device.ip} · último uso {formatDateTime(s.lastActiveAt)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

import { useMemo, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { useStore } from '../../lib/store';
import { Field, Spinner, Toggle, useAsync } from '../../components/ui';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const ok = (t: string) => useStore.getState().toast(t);

const GROUP_LABEL: Record<string, string> = {
  General: 'Geral',
  Layout: 'Aparência',
  Accounts: 'Contas',
  Message: 'Mensagens',
  FileUpload: 'Upload de arquivos',
  RetentionPolicy: 'Política de retenção',
  Email: 'E-mail',
  LDAP: 'LDAP / Active Directory',
  SAML: 'SAML (SSO)',
  Security: 'Segurança',
  VideoConf: 'Videoconferência',
  Omnichannel: 'Omnichannel',
  Integrations: 'Integrações',
};

export function AdminSettings() {
  const { data, loading, reload } = useAsync(() => api.get('settings'), []);
  const [group, setGroup] = useState('General');
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [filter, setFilter] = useState('');

  const groups = useMemo(() => [...new Set<string>((data?.settings ?? []).map((s: any) => s.group))], [data]);
  const visible = (data?.settings ?? []).filter((s: any) => (filter ? (s.label + s._id).toLowerCase().includes(filter.toLowerCase()) : s.group === group));
  const sections = useMemo(() => {
    const out: Record<string, any[]> = {};
    for (const s of visible) (out[s.section ?? ''] ??= []).push(s);
    return out;
  }, [visible]);

  if (loading) return <Spinner />;
  const value = (s: any) => (s._id in draft ? draft[s._id] : s.value);
  const dirty = Object.keys(draft).length > 0;

  const save = async () => {
    try {
      await api.post('settings', { settings: draft });
      setDraft({});
      reload();
      ok('Configurações salvas.');
    } catch (e) {
      fail(e);
    }
  };

  return (
    <>
      <div className="page-title-row">
        <h1>Configurações</h1>
        <input placeholder="Buscar configuração" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn primary" disabled={!dirty} onClick={save}>
          Salvar alterações
        </button>
      </div>
      {!filter && (
        <div className="tabs wrap">
          {groups.map((g) => (
            <button key={g} className={g === group ? 'active' : ''} onClick={() => setGroup(g)}>
              {GROUP_LABEL[g] ?? g}
            </button>
          ))}
        </div>
      )}
      {Object.entries(sections).map(([section, list]) => (
        <div key={section} className="card form">
          {section && <h3>{section}</h3>}
          {list.map((s: any) => (
            <SettingInput key={s._id} s={s} value={value(s)} onChange={(v) => setDraft({ ...draft, [s._id]: v })} />
          ))}
        </div>
      ))}
      {group === 'LDAP' && !filter && (
        <div className="card row-actions">
          <button className="btn" onClick={() => api.post('ldap.testConnection').then((r) => ok(r.message)).catch(fail)}>
            Testar conexão
          </button>
          <button className="btn" onClick={() => api.post('ldap.syncNow').then((r) => ok(r.message)).catch(fail)}>
            Sincronizar agora
          </button>
        </div>
      )}
      {group === 'RetentionPolicy' && !filter && (
        <div className="card row-actions">
          <button className="btn" onClick={() => confirm('Executar a limpeza agora?') && api.post('retention.run').then((r) => ok(`${r.removed} itens removidos em ${r.rooms} salas.`)).catch(fail)}>
            Executar limpeza agora
          </button>
        </div>
      )}
      {group === 'SAML' && !filter && (
        <div className="card muted small">
          URL de retorno (ACS) para configurar no provedor: <code>{location.origin}/saml/acs</code> · Metadados: <code>{location.origin}/saml/metadata</code>
        </div>
      )}
    </>
  );
}

function SettingInput({ s, value, onChange }: { s: any; value: any; onChange: (v: unknown) => void }) {
  const label = (
    <>
      {s.label} <span className="muted mono small">{s._id}</span>
    </>
  );
  switch (s.type) {
    case 'boolean':
      return <Toggle checked={!!value} onChange={onChange} label={label} />;
    case 'int':
      return (
        <Field label={label}>
          <input type="number" value={value ?? 0} onChange={(e) => onChange(Number(e.target.value))} />
        </Field>
      );
    case 'select':
      return (
        <Field label={label}>
          <select value={value} onChange={(e) => onChange(e.target.value)}>
            {s.values.map((v: any) => (
              <option key={v.key} value={v.key}>
                {v.label}
              </option>
            ))}
          </select>
        </Field>
      );
    case 'code':
    case 'multiline':
      return (
        <Field label={label}>
          <textarea className={s.type === 'code' ? 'mono' : ''} rows={s.type === 'code' ? 6 : 4} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
        </Field>
      );
    case 'password':
      return (
        <Field label={label}>
          <input type="password" value={value ?? ''} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" />
        </Field>
      );
    default:
      return (
        <Field label={label}>
          <input value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
        </Field>
      );
  }
}

import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../../lib/api';
import { plural } from '../../lib/format';
import { useStore } from '../../lib/store';
import { Icon } from '../../components/Icon';
import { RoomPicker } from '../../components/Pickers';
import { Empty, Menu, SearchInput, Skeleton, Toggle, Tooltip, confirmDialog, useAsync } from '../../components/ui';
import { useIsPhone } from '../../components/overlay';
import { PageHead } from './parts';

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
  Omnichannel: 'Atendimento',
  Integrations: 'Integrações',
  Import: 'Importação',
  // Integrações (Jira/Teams): nomes dos grupos novos (aparecem na busca de outras telas, nunca na navegação daqui)
  Jira: 'Jira',
  MSTeams: 'Microsoft Teams',
};

// Integrações (Jira/Teams): estes grupos têm página própria em Administração → Integrações. MSTeams_Inbound_Mode =
// polling só pode ser ligado com o aceite de lá, então eles somem da navegação e da busca daqui.
const HIDDEN_GROUPS = ['Jira', 'MSTeams'];

// Nomes das seções que o servidor manda em inglês.
const SECTION_LABEL: Record<string, string> = {
  Workspace: 'Espaço de trabalho',
  Editing: 'Edição',
  Features: 'Recursos',
  Custom: 'Personalização',
  Home: 'Início',
  Password: 'Senha',
  Session: 'Sessão',
  Queue: 'Fila',
  Routing: 'Roteamento',
  'Read Receipts': 'Confirmações de leitura',
  'Bad Words': 'Palavras bloqueadas',
  SMTP: 'E-mail (SMTP)',
  General: 'Geral',
  Outgoing: 'Envio',
  Scripts: 'Scripts',
  'Direct Messages': 'Conversas diretas',
  Presence: 'Presença',
  Profile: 'Perfil',
  Registration: 'Cadastro',
  'Two Factor': 'Autenticação em dois fatores',
  Notifications: 'Notificações',
  Authentication: 'Autenticação',
  Connection: 'Conexão',
  'Data Sync': 'Sincronização de dados',
  Search: 'Busca',
  Sync: 'Sincronização',
  'Sync Channels': 'Canais sincronizados',
  'Sync Roles': 'Papéis sincronizados',
  'Sync Teams': 'Times sincronizados',
  Mentions: 'Menções',
  'Business Hours': 'Horário de atendimento',
  'File Upload': 'Upload de arquivos',
  Sessions: 'Sessões',
  Widget: 'Widget',
  Global: 'Global',
  Mapping: 'Mapeamento',
  Provider: 'Provedor',
  CORS: 'CORS',
  'Device Management': 'Gestão de dispositivos',
  E2E: 'Criptografia de ponta a ponta',
  Push: 'Notificações push',
  'Rate Limiter': 'Limite de requisições',
  Calls: 'Chamadas',
  Jitsi: 'Jitsi',
};

const LANGUAGES = [
  { key: 'pt-BR', label: 'Português (Brasil)' },
  { key: 'en', label: 'English' },
  { key: 'es', label: 'Español' },
];

// Rótulos do servidor que não valem mais para o controle desta página (os canais padrão viraram chips).
const LABEL_OVERRIDE: Record<string, string> = { Default_Channels: 'Canais padrão' };
const labelOf = (s: any): string => LABEL_OVERRIDE[s._id] ?? s.label;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function AdminSettings() {
  const { data, loading, reload } = useAsync(() => api.get('settings'), []);
  const phone = useIsPhone();
  const [picked, setPicked] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);

  // Integrações (Jira/Teams): sem os grupos que têm página própria (HIDDEN_GROUPS).
  const all: any[] = useMemo(() => (data?.settings ?? []).filter((s: any) => !HIDDEN_GROUPS.includes(s.group)), [data]);
  const groups = useMemo(() => [...new Set<string>(all.map((s: any) => s.group))], [all]);
  // Abre no primeiro grupo; no celular a troca de grupo é pelo botão no alto, que abre a folha com os grupos.
  const group = picked ?? groups[0] ?? 'General';
  const q = filter.trim().toLowerCase();
  const visible = all.filter((s: any) => (q ? `${labelOf(s)} ${s._id} ${GROUP_LABEL[s.group] ?? s.group}`.toLowerCase().includes(q) : s.group === group));
  const sections = useMemo(() => {
    const out: Record<string, any[]> = {};
    for (const s of visible) (out[q ? `${GROUP_LABEL[s.group] ?? s.group} › ${SECTION_LABEL[s.section] ?? s.section ?? ''}` : (s.section ?? '')] ??= []).push(s);
    return out;
  }, [visible, q]);
  const changed = useMemo(() => {
    const byId = new Map(all.map((s: any) => [s._id, s]));
    return Object.keys(draft).filter((id) => !same(draft[id], byId.get(id)?.value));
  }, [draft, all]);
  const changedIn = (g: string) => changed.filter((id) => all.find((s: any) => s._id === id)?.group === g).length;

  if (loading && !data)
    return (
      <>
        <PageHead title="Configurações" />
        <div className="settings-layout">
          <div className="settings-nav-skeleton">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} height={14} width={`${60 + ((i * 17) % 30)}%`} />
            ))}
          </div>
          <div className="settings-main">
            {Array.from({ length: 5 }, (_, i) => (
              <div className="setting-row" key={i}>
                <Skeleton height={14} width="60%" />
                <Skeleton height={36} />
              </div>
            ))}
          </div>
        </div>
      </>
    );

  const value = (s: any) => (s._id in draft ? draft[s._id] : s.value);
  const set = (s: any, v: unknown) => setDraft((d) => ({ ...d, [s._id]: v }));
  const revert = (s: any) =>
    setDraft((d) => {
      const n = { ...d };
      delete n[s._id];
      return n;
    });

  const save = async () => {
    setSaving(true);
    try {
      await api.post('settings', { settings: Object.fromEntries(changed.map((id) => [id, draft[id]])) });
      setDraft({});
      reload();
      ok('Configurações salvas.');
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  };
  const runRetention = async () => {
    const yes = await confirmDialog({
      title: 'Executar a limpeza agora?',
      body: 'Mensagens e arquivos mais antigos que o prazo da política são apagados de vez.',
      confirmLabel: 'Executar limpeza',
      danger: true,
    });
    if (!yes) return;
    api
      .post('retention.run')
      .then((r) => ok(`${r.removed} itens removidos em ${r.rooms} salas.`))
      .catch(fail);
  };
  const onNavKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = groups.indexOf(group);
    const next = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? groups.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const g = groups[(next + groups.length) % groups.length];
    setPicked(g);
    navRef.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(g)}"]`)?.focus();
  };

  const pick = (g: string) => (setPicked(g), setFilter(''));
  const groupPicker = (
    <Menu
      align="left"
      label="Grupos de configurações"
      sheetTitle="Grupo de configurações"
      trigger={
        <button type="button" className="settings-group-pick">
          <span className="settings-nav-label">{q ? 'Escolher grupo' : (GROUP_LABEL[group] ?? group)}</span>
          {changed.length > 0 && <span className="settings-nav-dot" aria-hidden="true" />}
          <Icon name="chevron-down" />
        </button>
      }
    >
      {(close) =>
        groups.map((g) => {
          const n = changedIn(g);
          const current = !q && g === group;
          return (
            <button key={g} role="menuitemradio" aria-checked={current} onClick={() => (close(), pick(g))}>
              {GROUP_LABEL[g] ?? g}
              {n > 0 && (
                <span className="settings-nav-dot" title={plural(n, 'alteração não salva', 'alterações não salvas')}>
                  <span className="visually-hidden">{plural(n, 'alteração não salva', 'alterações não salvas')}</span>
                </span>
              )}
              {current && <Icon name="check" className="menu-check" />}
            </button>
          );
        })
      }
    </Menu>
  );
  return (
    <>
      <PageHead title="Configurações">
        <SearchInput className="head-search" value={filter} onChange={setFilter} placeholder="Buscar configuração" />
      </PageHead>
      <div className="settings-layout">
        {!phone && (
          <div className="tabs settings-nav" role="tablist" aria-label="Grupos de configurações" aria-orientation="vertical" ref={navRef} onKeyDown={onNavKey}>
            {groups.map((g) => {
              const n = changedIn(g);
              const active = !q && g === group;
              return (
                <button
                  key={g}
                  type="button"
                  role="tab"
                  data-tab={g}
                  aria-selected={active}
                  tabIndex={(q ? g === groups[0] : active) ? 0 : -1}
                  className={active ? 'active' : ''}
                  onClick={() => pick(g)}
                >
                  <span className="settings-nav-label">{GROUP_LABEL[g] ?? g}</span>
                  {n > 0 && (
                    <span className="settings-nav-dot" title={plural(n, 'alteração não salva', 'alterações não salvas')}>
                      <span className="visually-hidden">{plural(n, 'alteração não salva', 'alterações não salvas')}</span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <div className="settings-main">
          {phone && groupPicker}
          {/* Sem resultados, o título fica com o vazio logo abaixo; no celular o nome do grupo já está no botão. */}
          {(!q || visible.length > 0) && (
            <h2 className={phone && !q ? 'settings-group-title visually-hidden' : 'settings-group-title'}>{q ? `Resultados para “${filter.trim()}”` : (GROUP_LABEL[group] ?? group)}</h2>
          )}
          {/* Integrações (Jira/Teams) */}
          {group === 'Integrations' && !q && (
            <div className="callout info">
              <Icon name="info" />
              <span>Jira e Microsoft Teams ficam em Administração → Integrações. Esta opção liga só os webhooks.</span>
              <Link className="btn small" to="/admin/integrations">
                Abrir Integrações
              </Link>
            </div>
          )}
          {group === 'LDAP' && !q && (
            <div className="callout info">
              <Icon name="admin-ldap" />
              <span>Mapeamentos, histórico de sincronização e teste de usuário ficam na página LDAP / AD.</span>
              <Link className="btn small" to="/admin/ldap">
                Abrir página LDAP / AD
              </Link>
            </div>
          )}
          {q && !visible.length && (
            <Empty
              icon="search"
              title={`Nada encontrado para “${filter.trim()}”`}
              action={
                <button type="button" className="btn" onClick={() => setFilter('')}>
                  Limpar busca
                </button>
              }
            >
              Busque pelo nome da configuração ou pela chave (por exemplo, Site_Name).
            </Empty>
          )}
          {Object.entries(sections).map(([section, list]) => (
            <section key={section} className="settings-section">
              {section && <h3 className="section-title">{q ? section : (SECTION_LABEL[section] ?? section)}</h3>}
              {list.map((s: any) => (
                <SettingRow key={s._id} s={s} value={value(s)} modified={changed.includes(s._id)} onChange={(v) => set(s, v)} onRevert={() => revert(s)} />
              ))}
            </section>
          ))}
          {group === 'LDAP' && !q && (
            <div className="settings-extra row-actions wrap">
              <button
                className="btn"
                onClick={() =>
                  api
                    .post('ldap.testConnection')
                    .then((r) => ok(r.message))
                    .catch(fail)
                }
              >
                <Icon name="admin-ldap" />
                Testar conexão
              </button>
              <button
                className="btn"
                onClick={() =>
                  api
                    .post('ldap.syncNow')
                    .then((r) => ok(r.message))
                    .catch(fail)
                }
              >
                <Icon name="sync" />
                Sincronizar agora
              </button>
            </div>
          )}
          {group === 'RetentionPolicy' && !q && (
            <div className="settings-extra row-actions">
              <button className="btn danger" onClick={runRetention}>
                <Icon name="retention" />
                Executar limpeza agora
              </button>
            </div>
          )}
          {group === 'SAML' && !q && (
            <div className="callout info">
              <Icon name="info" />
              <span>
                URL de retorno (ACS) para configurar no provedor: <code>{location.origin}/saml/acs</code> · Metadados: <code>{location.origin}/saml/metadata</code>
              </span>
            </div>
          )}
        </div>
      </div>
      {changed.length > 0 && (
        <div className="save-bar" role="region" aria-label="Alterações não salvas">
          <span className="save-bar-text">
            <span className="save-bar-dot" aria-hidden="true" />
            {plural(changed.length, 'alteração não salva', 'alterações não salvas')}
          </span>
          <button className="btn ghost" onClick={() => setDraft({})} disabled={saving}>
            Descartar
          </button>
          <button className="btn primary" onClick={save} disabled={saving} aria-busy={saving || undefined}>
            Salvar alterações
          </button>
        </div>
      )}
    </>
  );
}

// A chave da configuração fica num ícone com dica, em vez de texto mono ao lado do rótulo.
// Rótulo da configuração com a última palavra presa ao (i): se o ícone não couber na linha, os dois descem juntos.
function SettingLabelText({ s }: { s: any }) {
  const text = labelOf(s);
  const i = text.lastIndexOf(' ');
  return (
    <>
      {text.slice(0, i + 1)}
      <span className="setting-tail">{text.slice(i + 1)}</span>
    </>
  );
}

function SettingKey({ id }: { id: string }) {
  return (
    <Tooltip
      label={
        <>
          Chave: <code>{id}</code>
        </>
      }
    >
      <button type="button" className="icon-btn setting-key" aria-label={`Chave: ${id}`} onClick={() => navigator.clipboard?.writeText(id).then(() => ok('Chave copiada.'))}>
        <Icon name="info" size={14} />
      </button>
    </Tooltip>
  );
}

// Linha da página de configurações: rótulo e descrição à esquerda (280px), controle à direita.
function SettingRow({ s, value, modified, onChange, onRevert }: { s: any; value: any; modified: boolean; onChange: (v: unknown) => void; onRevert: () => void }) {
  const id = useId();
  return (
    <div className={`setting-row${s.type === 'boolean' ? ' bool' : ''}${modified ? ' modified' : ''}`}>
      <div className="setting-label">
        <span className="setting-name">
          {modified && <span className="setting-dot" aria-hidden="true" />}
          {s.type === 'boolean' ? (
            <span id={`${id}-l`}>
              <SettingLabelText s={s} />
            </span>
          ) : (
            <label htmlFor={id}>
              <SettingLabelText s={s} />
            </label>
          )}
          <SettingKey id={s._id} />
        </span>
        {s.description && <span className="setting-desc">{s.description}</span>}
      </div>
      <div className="setting-control">
        <SettingControl s={s} value={value} onChange={onChange} id={id} />
        {modified && (
          <button type="button" className="btn small ghost setting-revert" onClick={onRevert}>
            <Icon name="restore" />
            Desfazer
          </button>
        )}
      </div>
    </div>
  );
}

// "Canais padrão": chips das salas e um seletor para acrescentar; o valor continua "geral,avisos".
function ChannelList({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const names = String(value ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return (
    <div className="channel-list">
      {names.length > 0 && (
        <div className="chips">
          {names.map((n) => (
            <span key={n} className="chip">
              <Icon name="room-channel" size={14} />
              {n}
              <button type="button" aria-label={`Remover ${n}`} onClick={() => onChange(names.filter((x) => x !== n).join(','))}>
                <Icon name="close" size={14} />
              </button>
            </span>
          ))}
        </div>
      )}
      <RoomPicker value={null} onChange={(r) => r && onChange([...new Set([...names, r.name])].join(','))} placeholder="Adicionar canal" />
    </div>
  );
}

function SettingControl({ s, value, onChange, id, label }: { s: any; value: any; onChange: (v: unknown) => void; id?: string; label?: ReactNode }) {
  if (s._id === 'Language')
    return (
      <select id={id} value={value ?? 'pt-BR'} onChange={(e) => onChange(e.target.value)}>
        {LANGUAGES.some((l) => l.key === value) || !value ? null : <option value={value}>{value}</option>}
        {LANGUAGES.map((l) => (
          <option key={l.key} value={l.key}>
            {l.label}
          </option>
        ))}
      </select>
    );
  if (s._id === 'Default_Channels') return <ChannelList value={value} onChange={onChange} />;
  switch (s.type) {
    case 'boolean':
      return <Toggle checked={!!value} onChange={onChange} label={label ?? <span className="visually-hidden">{labelOf(s)}</span>} />;
    case 'int':
      return <input id={id} type="number" value={value ?? 0} onChange={(e) => onChange(Number(e.target.value))} />;
    case 'select':
      return (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {s.values.map((v: any) => (
            <option key={v.key} value={v.key}>
              {v.label}
            </option>
          ))}
        </select>
      );
    case 'code':
    case 'multiline':
      return <textarea id={id} className={s.type === 'code' ? 'mono' : ''} rows={s.type === 'code' ? 6 : 4} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'password':
      return <input id={id} type="password" value={value ?? ''} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" />;
    default:
      return <input id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
}

// Campo de uma configuração dentro de um formulário (páginas do LDAP / AD). A chave fica fora do <label>,
// para o rótulo continuar apontando para o controle.
export function SettingInput({ s, value, onChange, hint }: { s: any; value: any; onChange: (v: unknown) => void; hint?: ReactNode }) {
  const id = useId();
  // A chave fica logo depois do texto do rótulo (e não na ponta da linha quando ele quebra), fora do <label>.
  if (s.type === 'boolean')
    return (
      <div className="setting-field toggle-field">
        <label className="toggle">
          <input id={id} type="checkbox" role="switch" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          <span className="toggle-track" />
        </label>
        <span className="toggle-text">
          <span className="setting-name">
            <label htmlFor={id}>
              <SettingLabelText s={s} />
            </label>
            <SettingKey id={s._id} />
          </span>
          {hint && <span className="toggle-desc">{hint}</span>}
        </span>
      </div>
    );
  return (
    <div className="field setting-field">
      <span className="field-label setting-name">
        <label htmlFor={id}>
          <SettingLabelText s={s} />
        </label>
        <SettingKey id={s._id} />
      </span>
      <SettingControl s={s} value={value} onChange={onChange} id={id} />
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

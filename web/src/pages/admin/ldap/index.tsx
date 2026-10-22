import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Setting } from '@shared/index';
import type { LdapStatus } from '@shared/ldap';
import { api, errorMessage } from '../../../lib/api';
import { usePermission, useStore } from '../../../lib/store';
import { Empty, Spinner, Tabs, useAsync } from '../../../components/ui';
import { connectionIdsOf, LdapConnection } from './LdapConnection';
import { LdapMapping } from './LdapMapping';
import { AGENDA_IDS, LdapSync } from './LdapSync';
import { LdapTest } from './LdapTest';
import './ldap.css';

type Tab = 'conexao' | 'mapeamento' | 'sincronizacao' | 'testar';
const TABS: Tab[] = ['conexao', 'mapeamento', 'sincronizacao', 'testar'];

// Configurações do grupo LDAP com um rascunho único: o mesmo campo pode aparecer em duas abas
// (ex.: grupos aninhados) e trocar de aba não perde o que foi digitado.
export interface LdapSettings {
  list: Setting[];
  get(id: string): Setting | undefined;
  value<T = unknown>(id: string): T;
  saved<T = unknown>(id: string): T;
  set(id: string, v: unknown): void;
  setMany(values: Record<string, unknown>): string[];
  isDirty(id: string): boolean;
  dirtyIds(ids: string[]): string[];
  discard(ids: string[]): void;
  save(ids: string[], extra?: Record<string, unknown>): Promise<boolean>;
  reload(): void;
  canEdit: boolean;
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function useLdapSettings(canEdit: boolean) {
  const res = useAsync(() => api.get<{ settings: Setting[] }>('settings', { group: 'LDAP' }), []);
  const [list, setList] = useState<Setting[]>([]);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  useEffect(() => {
    if (res.data) setList(res.data.settings);
  }, [res.data]);

  const byId = useMemo(() => new Map(list.map((x) => [x._id, x])), [list]);
  const settings: LdapSettings = useMemo(() => {
    const saved = (id: string) => byId.get(id)?.value as any;
    return {
      list,
      canEdit,
      get: (id) => byId.get(id),
      saved,
      value: (id) => (id in draft ? draft[id] : saved(id)) as any,
      // Sem permissão para alterar, nada entra no rascunho (os campos também ficam desativados).
      set: (id, v) => {
        if (!canEdit) return;
        setDraft((d) => {
          const next = { ...d };
          // Voltar ao valor salvo limpa o campo do rascunho.
          if (same(v, saved(id))) delete next[id];
          else next[id] = v;
          return next;
        });
      },
      setMany: (values) => {
        if (!canEdit) return [];
        const changed = Object.keys(values).filter((id) => byId.has(id) && !same(values[id], id in draft ? draft[id] : saved(id)));
        if (changed.length)
          setDraft((d) => {
            const next = { ...d };
            for (const id of changed) {
              if (same(values[id], saved(id))) delete next[id];
              else next[id] = values[id];
            }
            return next;
          });
        return changed;
      },
      isDirty: (id) => id in draft,
      dirtyIds: (ids) => ids.filter((id) => id in draft),
      discard: (ids) =>
        setDraft((d) => {
          const next = { ...d };
          for (const id of ids) delete next[id];
          return next;
        }),
      save: async (ids, extra = {}) => {
        const values: Record<string, unknown> = { ...extra };
        for (const id of ids) if (id in draft) values[id] = draft[id];
        if (!Object.keys(values).length) return true;
        try {
          await api.post('settings', { settings: values });
        } catch (e) {
          useStore.getState().toast(errorMessage(e), 'error');
          return false;
        }
        // Mostra os valores novos na hora; a recarga traz a forma que o servidor guardou.
        setList((l) => l.map((x) => (x._id in values ? { ...x, value: x.type === 'password' ? (values[x._id] ? '********' : '') : values[x._id] } : x)));
        setDraft((d) => {
          const next = { ...d };
          for (const id of Object.keys(values)) delete next[id];
          return next;
        });
        res.reload();
        return true;
      },
      reload: res.reload,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, byId, draft, canEdit]);

  return { s: settings, loading: res.loading && !res.data, error: res.data ? null : res.error, anyDirty: Object.keys(draft).length > 0, draft };
}

export function AdminLdap() {
  const canView = usePermission('view-privileged-setting');
  const canEdit = usePermission('edit-privileged-setting');
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') as Tab | null;
  const tab: Tab = raw && TABS.includes(raw) ? raw : 'conexao';
  const [visited, setVisited] = useState<Tab[]>([tab]);
  const [mappingDirty, setMappingDirty] = useState(false);
  const { s, loading, error, anyDirty, draft } = useLdapSettings(canEdit);
  const status = useAsync(() => api.get<LdapStatus>('ldap.status'), []);

  useEffect(() => {
    setVisited((v) => (v.includes(tab) ? v : [...v, tab]));
  }, [tab]);

  // Avisa antes de fechar a aba do navegador com alterações não salvas.
  useEffect(() => {
    if (!anyDirty && !mappingDirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [anyDirty, mappingDirty]);

  const connectionIds = useMemo(() => connectionIdsOf(s.list), [s.list]);
  const dirtyTab = (t: Tab) => {
    if (t === 'conexao') return connectionIds.some((id) => id in draft);
    if (t === 'mapeamento') return mappingDirty;
    if (t === 'sincronizacao') return AGENDA_IDS.some((id) => id in draft);
    return false;
  };
  const reloadStatus = status.reload;

  if (!canView) return <Empty>Você não tem permissão para ver as configurações do LDAP.</Empty>;
  const enabled = status.data ? status.data.enabled : !!s.saved('LDAP_Enable');
  const label = (t: Tab, text: string) => (
    <>
      {text}
      {dirtyTab(t) && <span className="ldap-tab-dot" title="Alterações não salvas" aria-label="Alterações não salvas" />}
    </>
  );

  return (
    <div className="ldap-page">
      <div className="page-title-row">
        <h1>
          LDAP / Active Directory
          {(status.data || s.list.length > 0) && <span className={`pill ldap-state ${enabled ? 'on' : ''}`}>{enabled ? '● Ativo' : '○ Desativado'}</span>}
        </h1>
      </div>
      <p className="muted ldap-lead">Quem entra no Active Directory vira usuário do Wescc Chat automaticamente, com os papéis, canais e times definidos pelos grupos e OUs da rede.</p>
      <Tabs
        value={tab}
        onChange={(t) => setParams({ tab: t })}
        items={[
          { id: 'conexao', label: label('conexao', 'Conexão') },
          { id: 'mapeamento', label: label('mapeamento', 'Mapeamento') },
          { id: 'sincronizacao', label: label('sincronizacao', 'Sincronização') },
          { id: 'testar', label: label('testar', 'Testar usuário') },
        ]}
      />
      {!canEdit && <div className="callout info">Você pode ver estas configurações, mas não alterá-las. Salvar, sincronizar e testar exigem a permissão para alterar configurações privilegiadas.</div>}
      {loading ? (
        <Spinner />
      ) : error ? (
        <div className="form-error">Não foi possível carregar as configurações do LDAP: {error}</div>
      ) : (
        <>
          {visited.includes('conexao') && (
            <div hidden={tab !== 'conexao'}>
              <LdapConnection s={s} ids={connectionIds} onSaved={reloadStatus} />
            </div>
          )}
          {visited.includes('mapeamento') && (
            <div hidden={tab !== 'mapeamento'}>
              <LdapMapping s={s} onDirtyChange={setMappingDirty} />
            </div>
          )}
          {visited.includes('sincronizacao') && (
            <div hidden={tab !== 'sincronizacao'}>
              <LdapSync s={s} status={status.data} statusError={status.error} reloadStatus={reloadStatus} active={tab === 'sincronizacao'} />
            </div>
          )}
          {visited.includes('testar') && (
            <div hidden={tab !== 'testar'}>
              <LdapTest canEdit={canEdit} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

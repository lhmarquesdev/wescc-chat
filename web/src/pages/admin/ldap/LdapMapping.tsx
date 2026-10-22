import { Fragment, useEffect, useMemo, useState } from 'react';
import type { Role } from '@shared/index';
import { api } from '../../../lib/api';
import { usePermission, useStore } from '../../../lib/store';
import { Toggle } from '../../../components/ui';
import { UserPicker } from '../../../components/Pickers';
import type { LdapSettings } from './index';
import { LdapTest } from './LdapTest';
import { findRoom, findTeam, RuleModal, type MappingData } from './RuleModal';
import {
  canonicalMap,
  channelName,
  jsonFromRows,
  mapHasRules,
  MAP_IDS,
  MAP_SETTING,
  MAP_TITLE,
  originOf,
  parseMap,
  rowsFromMaps,
  splitList,
  type MapErrors,
  type MapId,
  type MappingRow,
} from './mapping-model';

const ok = (t: string) => useStore.getState().toast(t);

const ENABLE: Record<MapId, string> = { role: 'LDAP_Enable_Role_Mapping', channel: 'LDAP_Enable_Channel_Mapping', team: 'LDAP_Enable_Team_Mapping' };
const ENABLE_LABEL: Record<MapId, string> = { role: 'Mapear papéis', channel: 'Mapear canais', team: 'Mapear times' };
export const OPTION_IDS = [
  ...Object.values(ENABLE),
  'LDAP_Group_Nested',
  'LDAP_Default_Roles',
  'LDAP_Default_Roles_Skip_Restricted',
  'LDAP_Roles_Auto_Remove',
  'LDAP_Channels_Auto_Remove',
  'LDAP_Teams_Auto_Remove',
  'LDAP_Channels_Admin',
];

// Lê todas as páginas de uma listagem (até `cap` itens); sem permissão, devolve null.
async function loadAll<T>(path: string, field: string, params: Record<string, unknown>, per: number, cap: number): Promise<T[] | null> {
  const out: T[] = [];
  try {
    for (let offset = 0; offset < cap; offset += per) {
      const r = await api.get(path, { ...params, offset, count: per });
      const list = (r[field] ?? []) as T[];
      out.push(...list);
      if (!list.length || out.length >= Number(r.total ?? 0)) break;
    }
    return out;
  } catch {
    return null;
  }
}

function useMappingData(): MappingData {
  const [data, setData] = useState<MappingData>({ roles: null, rooms: null, teams: null });
  // Sem a permissão de cada listagem nem pede: a tela já trata "sem acesso" (null) sem as marcas de canal novo e de time inexistente.
  const canRooms = usePermission('view-room-administration');
  const canTeams = usePermission('view-all-teams');
  useEffect(() => {
    let alive = true;
    api
      .get<{ roles: Role[] }>('roles.list')
      .then((r) => alive && setData((d) => ({ ...d, roles: r.roles })))
      .catch(() => alive && setData((d) => ({ ...d, roles: [] })));
    if (canRooms) void loadAll<any>('rooms.adminRooms', 'rooms', { types: ['c', 'p'] }, 200, 2000).then((rooms) => alive && setData((d) => ({ ...d, rooms: rooms?.filter((r) => r.name) ?? null })));
    if (canTeams) void loadAll<any>('teams.listAll', 'teams', {}, 100, 1000).then((teams) => alive && setData((d) => ({ ...d, teams })));
    return () => {
      alive = false;
    };
  }, [canRooms, canTeams]);
  return data;
}

export function LdapMapping({ s, onDirtyChange }: { s: LdapSettings; onDirtyChange: (dirty: boolean) => void }) {
  const data = useMappingData();
  const saved = useMemo(() => Object.fromEntries(MAP_IDS.map((id) => [id, String(s.saved(MAP_SETTING[id]) ?? '{}')])) as Record<MapId, string>, [s]);
  const [mode, setMode] = useState<'visual' | 'json'>('visual');
  const [rows, setRows] = useState<MappingRow[]>([]);
  const [json, setJson] = useState<Record<MapId, string>>(saved);
  const [ready, setReady] = useState(false);
  const [editing, setEditing] = useState<{ index: number | null } | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    const r = rowsFromMaps(saved.role, saved.channel, saved.team);
    setJson(saved);
    setRows(r.rows);
    // Um mapa salvo que não abre no editor visual vai direto para o modo JSON, com o erro à mostra.
    setMode(Object.keys(r.errors).length ? 'json' : 'visual');
    setReady(true);
  };
  useEffect(() => {
    if (!ready && s.list.length) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.list.length]);

  const current = mode === 'visual' ? jsonFromRows(rows) : json;
  const jsonErrors: MapErrors = mode === 'json' ? Object.fromEntries(MAP_IDS.map((id) => [id, parseMap(json[id]).error]).filter(([, e]) => e)) : {};
  const hasJsonErrors = Object.keys(jsonErrors).length > 0;
  // Só os mapas que mudaram de fato. Quem não pode alterar nunca tem o que salvar.
  const changedMaps = ready && s.canEdit ? MAP_IDS.filter((id) => canonicalMap(current[id]) !== canonicalMap(saved[id])) : [];
  const mapsDirty = changedMaps.length > 0;
  const optionsDirty = s.dirtyIds(OPTION_IDS).length > 0;
  const dirty = mapsDirty || optionsDirty;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const toVisual = () => {
    const r = rowsFromMaps(json.role, json.channel, json.team);
    if (Object.keys(r.errors).length) return;
    setRows(r.rows);
    setMode('visual');
  };
  const toJson = () => {
    // Um mapa igual ao salvo aparece com o texto salvo, na ordem e no formato de quem o escreveu.
    const fromRows = jsonFromRows(rows);
    setJson(Object.fromEntries(MAP_IDS.map((id) => [id, saved[id].trim() && canonicalMap(fromRows[id]) === canonicalMap(saved[id]) ? saved[id] : fromRows[id]])) as Record<MapId, string>);
    setMode('json');
  };
  const save = async () => {
    setSaving(true);
    // Um mapa que não mudou não é regravado: o texto salvo continua o mesmo.
    const maps = Object.fromEntries(changedMaps.map((id) => [MAP_SETTING[id], current[id]]));
    const done = await s.save(OPTION_IDS, maps);
    setSaving(false);
    if (done) ok('Mapeamento salvo.');
  };
  const discard = () => {
    s.discard(OPTION_IDS);
    reset();
  };
  const overrides = () => ({
    ...Object.fromEntries(OPTION_IDS.map((id) => [id, s.value(id)])),
    ...Object.fromEntries(MAP_IDS.map((id) => [MAP_SETTING[id], current[id]])),
  });

  // Regras que existem para um tipo de mapeamento desligado: avisar, senão a pessoa acha que estão valendo.
  const offWithRules = MAP_IDS.filter((id) => !s.value(ENABLE[id]) && (mode === 'visual' ? rows.some((r) => (id === 'role' ? r.roles : id === 'channel' ? r.channels : r.teams).length) : mapHasRules(json[id])));

  return (
    <>
      <MappingOptions s={s} data={data} />

      <div className="card">
        <div className="ldap-card-head">
          <h3>Regras de mapeamento</h3>
          <span className="spacer" />
          {mode === 'visual' ? (
            <>
              <button className="btn" onClick={toJson}>
                Editar como JSON
              </button>
              <button className="btn primary" disabled={!s.canEdit} onClick={() => setEditing({ index: null })}>
                ＋ Nova regra
              </button>
            </>
          ) : (
            <button className="btn" disabled={hasJsonErrors} title={hasJsonErrors ? 'Corrija o JSON para voltar ao editor.' : undefined} onClick={toVisual}>
              Voltar ao editor
            </button>
          )}
        </div>
        <p className="muted small ldap-card-lead">Cada regra diz o que quem está num grupo ou numa OU do AD recebe no Wescc Chat. Uma pessoa recebe tudo das regras que se aplicam a ela.</p>
        {offWithRules.map((id) => (
          <div key={id} className="callout warn">
            <span>
              Há regras com {MAP_TITLE[id].toLowerCase()}, mas “{ENABLE_LABEL[id]}” está desligado nas opções: essa parte das regras não é aplicada.
            </span>
          </div>
        ))}
        {mode === 'visual' ? (
          <RulesTable rows={rows} data={data} canEdit={s.canEdit} onEdit={(index) => setEditing({ index })} onRemove={(index) => setRows(rows.filter((_, i) => i !== index))} />
        ) : (
          <JsonEditor json={json} errors={jsonErrors} readOnly={!s.canEdit} onChange={(id, v) => setJson({ ...json, [id]: v })} />
        )}
      </div>

      <div className={`ldap-actionbar ${dirty ? 'sticky' : ''}`}>
        <button className="btn primary" disabled={!s.canEdit || !dirty || saving || hasJsonErrors} title={hasJsonErrors ? 'Corrija o JSON antes de salvar.' : undefined} onClick={() => void save()}>
          {saving ? 'Salvando…' : 'Salvar mapeamento'}
        </button>
        {dirty && (
          <>
            <span className="muted small">Há alterações não salvas.</span>
            <span className="spacer" />
            <button className="link small" onClick={discard}>
              Descartar alterações
            </button>
          </>
        )}
      </div>

      <LdapTest
        canEdit={s.canEdit}
        overrides={overrides}
        draftBlocked={hasJsonErrors ? 'Corrija o JSON para testar com as alterações não salvas (ou desmarque “Usar as alterações não salvas”).' : undefined}
      />

      {editing && (
        <RuleModal
          row={editing.index === null ? null : rows[editing.index]}
          others={rows.filter((_, i) => i !== editing.index)}
          data={data}
          onClose={() => setEditing(null)}
          onSave={(row) => {
            setRows(editing.index === null ? [...rows, row] : rows.map((r, i) => (i === editing.index ? row : r)));
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function MappingOptions({ s, data }: { s: LdapSettings; data: MappingData }) {
  const toggle = (id: string, label: string) => (
    <div className={`ldap-setting ${s.isDirty(id) ? 'changed' : ''}`}>
      <Toggle checked={!!s.value(id)} onChange={(v) => s.set(id, v)} label={label} />
    </div>
  );
  const defaults = splitList(s.value('LDAP_Default_Roles'));
  const globalRoles = (data.roles ?? []).filter((r) => r.scope === 'Users');
  const unknown = data.roles ? defaults.filter((r) => !globalRoles.some((g) => g._id === r)) : [];
  const setDefaults = (list: string[]) => s.set('LDAP_Default_Roles', list.join(','));
  const owner = String(s.value('LDAP_Channels_Admin') ?? '').replace(/^@/, '');

  return (
    <fieldset className="ldap-fieldset" disabled={!s.canEdit}>
      <div className="card form ldap-options">
        <h3>Opções</h3>
        {MAP_IDS.map((id) => (
          <Fragment key={id}>{toggle(ENABLE[id], ENABLE_LABEL[id])}</Fragment>
        ))}
        {toggle('LDAP_Group_Nested', 'Incluir grupos aninhados (Active Directory)')}
        <span className="field-hint ldap-toggle-hint">Quem está num grupo dentro de outro grupo também conta como membro do grupo de fora.</span>

        <div className={`field ldap-setting ${s.isDirty('LDAP_Default_Roles') ? 'changed' : ''}`}>
          <span className="field-label">Papéis padrão</span>
          {data.roles === null ? (
            <span className="muted small">Carregando papéis…</span>
          ) : (
            <div className="chips">
              {globalRoles.map((r) => {
                const on = defaults.includes(r._id);
                return (
                  <label key={r._id} className={`chip selectable ${on ? 'on' : ''}`} title={r.restrictDirect ? 'Restrito em conversas diretas' : r.description || undefined}>
                    <input type="checkbox" hidden checked={on} disabled={!s.canEdit} onChange={() => setDefaults(on ? defaults.filter((x) => x !== r._id) : [...defaults, r._id])} />
                    {r.restrictDirect ? `🚫 ${r._id}` : r._id}
                  </label>
                );
              })}
              {unknown.map((r) => (
                <span key={r} className="chip ldap-chip bad" title="Papel inexistente ou de sala: a sincronização ignora.">
                  {r}
                  <button type="button" aria-label={`Remover ${r}`} onClick={() => setDefaults(defaults.filter((x) => x !== r))}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <span className="field-hint">{defaults.length ? 'Todo usuário que vem do AD recebe estes papéis, além dos das regras.' : 'Nenhum papel padrão: cada pessoa recebe só os papéis das regras.'}</span>
        </div>
        {toggle('LDAP_Default_Roles_Skip_Restricted', 'Não dar os papéis padrão a quem recebe um papel restrito')}
        <span className="field-hint ldap-toggle-hint">Evita que a operação ganhe o papel user, que permite criar grupos privados e times.</span>

        <h4 className="ldap-subhead">Quando a pessoa sai do grupo ou da OU</h4>
        {toggle('LDAP_Roles_Auto_Remove', 'Remover papéis mapeados de quem sai do grupo ou da OU')}
        {toggle('LDAP_Channels_Auto_Remove', 'Remover dos canais mapeados de quem sai')}
        {toggle('LDAP_Teams_Auto_Remove', 'Remover dos times mapeados de quem sai')}
        <span className="field-hint">Donos, moderadores, líderes e publicadores de um canal ou time nunca são removidos pela sincronização.</span>

        <div className={`field ldap-setting ${s.isDirty('LDAP_Channels_Admin') ? 'changed' : ''}`}>
          <span className="field-label">Dono dos canais criados</span>
          <UserPicker
            single
            value={owner ? [{ _id: owner, username: owner }] : []}
            onChange={(v) => s.set('LDAP_Channels_Admin', v[0]?.username ?? '')}
            placeholder="Buscar pessoa"
          />
          <span className="field-hint">Os canais que a sincronização criar terão esta pessoa como dona. Sem ninguém, eles ficam sem dono.</span>
        </div>
      </div>
    </fieldset>
  );
}

function RulesTable({ rows, data, canEdit, onEdit, onRemove }: { rows: MappingRow[]; data: MappingData; canEdit: boolean; onEdit: (i: number) => void; onRemove: (i: number) => void }) {
  if (!rows.length) return <div className="empty">Nenhuma regra. Use “Nova regra” para mapear um grupo ou uma OU do AD.</div>;
  const role = (id: string) => data.roles?.find((r) => r._id === id);
  return (
    <div className="ldap-rules-wrap">
      <table className="table ldap-rules">
        <thead>
          <tr>
            <th>Origem</th>
            <th>Papéis</th>
            <th>Canais</th>
            <th>Times</th>
            <th aria-label="Ações" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const o = originOf(row.key);
            return (
              <tr key={row.key}>
                <td className="ldap-origin" title={o.title}>
                  <span>
                    {o.icon} <strong>{o.label}</strong>
                  </span>
                  {o.kind === 'group' && <span className="muted small">pelo nome</span>}
                  {o.title && <span className="mono small muted ldap-dn">{o.title}</span>}
                </td>
                <td data-label="Papéis">
                  <Chips
                    items={row.roles.map((r) => {
                      const def = role(r);
                      const bad = !!data.roles && (!def || def.scope !== 'Users');
                      return { text: def?.restrictDirect ? `🚫 ${r}` : r, cls: bad ? 'bad' : '', title: bad ? 'Papel inexistente ou de sala: a sincronização ignora.' : def?.restrictDirect ? 'Restrito em conversas diretas' : undefined };
                    })}
                  />
                </td>
                <td data-label="Canais">
                  <Chips
                    items={row.channels.map((c) => {
                      const missing = !!data.rooms && !findRoom(data, c);
                      return { text: `#${channelName(c)}`, note: missing ? '(será criado)' : undefined, cls: missing ? 'new' : '', title: missing ? 'Ainda não existe: a sincronização cria como grupo privado.' : undefined };
                    })}
                  />
                </td>
                <td data-label="Times">
                  <Chips
                    items={row.teams.map((t) => {
                      const missing = !!data.teams && !findTeam(data, t);
                      return { text: t, cls: missing ? 'bad' : '', title: missing ? 'Time inexistente: a sincronização ignora (times não são criados).' : undefined };
                    })}
                  />
                </td>
                <td className="ldap-row-actions">
                  <div>
                    <button className="btn small" disabled={!canEdit} onClick={() => onEdit(i)}>
                      Editar
                    </button>
                    <button className="btn small danger" disabled={!canEdit} onClick={() => onRemove(i)}>
                      Remover
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Chips({ items }: { items: { text: string; cls?: string; title?: string; note?: string }[] }) {
  if (!items.length) return <span className="muted">—</span>;
  return (
    <div className="chips">
      {items.map((c) => (
        <span key={c.text} className={`chip ldap-chip ${c.cls ?? ''}`} title={c.title}>
          {c.text}
          {c.note && <span className="ldap-chip-note">{c.note}</span>}
        </span>
      ))}
    </div>
  );
}

function JsonEditor({ json, errors, readOnly, onChange }: { json: Record<MapId, string>; errors: MapErrors; readOnly: boolean; onChange: (id: MapId, v: string) => void }) {
  return (
    <div className="form">
      <p className="muted small ldap-json-help">
        Chaves: <code>"*"</code> (todos), <code>"ou:&lt;DN&gt;"</code>, <code>"group:&lt;DN&gt;"</code>, <code>"group:&lt;nome&gt;"</code> ou só o nome do grupo. Valores: um texto ou uma lista de textos.
      </p>
      {MAP_IDS.map((id) => (
        <label key={id} className="field">
          <span className="field-label">
            {MAP_TITLE[id]} <span className="muted mono small">{MAP_SETTING[id]}</span>
          </span>
          <textarea className={`mono ldap-json ${errors[id] ? 'invalid' : ''}`} rows={8} spellCheck={false} readOnly={readOnly} value={json[id]} onChange={(e) => onChange(id, e.target.value)} />
          {errors[id] && <span className="field-hint neg">{errors[id]}</span>}
        </label>
      ))}
      {Object.keys(errors).length > 0 && <div className="form-error">O editor visual fica desativado até o JSON ser corrigido.</div>}
    </div>
  );
}

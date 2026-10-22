import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Role } from '@shared/index';
import type { LdapDirectoryItem } from '@shared/ldap';
import { api, errorMessage } from '../../../lib/api';
import { roomIcon } from '../../../lib/format';
import { Field, Modal } from '../../../components/ui';
import { channelName, keyFor, sameOrigin, targetOf, type GroupIdentity, type MappingRow, type RuleTarget } from './mapping-model';

export interface MappingData {
  roles: Role[] | null; // papéis globais (roles.list)
  rooms: { name: string; fname?: string; t: string; teamMain?: boolean; notice?: boolean; prid?: string | null }[] | null; // canais e grupos (null = sem acesso)
  teams: { name: string }[] | null;
}

export const findRoom = (data: MappingData, name: string) => data.rooms?.find((r) => r.name.toLowerCase() === channelName(name).toLowerCase());
export const findTeam = (data: MappingData, name: string) => data.teams?.find((t) => t.name.toLowerCase() === name.trim().toLowerCase());

export function RuleModal({ row, others, data, onSave, onClose }: { row: MappingRow | null; others: MappingRow[]; data: MappingData; onSave: (row: MappingRow) => void; onClose: () => void }) {
  const init = row ? targetOf(row.key) : { target: 'group' as RuleTarget, value: '', by: 'cn' as GroupIdentity };
  const [target, setTarget] = useState<RuleTarget>(init.target);
  const [value, setValue] = useState(init.value);
  const [by, setBy] = useState<GroupIdentity>(init.by);
  const [picked, setPicked] = useState<LdapDirectoryItem | null>(null);
  const [roles, setRoles] = useState<string[]>(row?.roles ?? []);
  const [channels, setChannels] = useState<string[]>(row?.channels ?? []);
  const [teams, setTeams] = useState<string[]>(row?.teams ?? []);
  // Depois da primeira tentativa de salvar, o erro acompanha o formulário e some assim que é corrigido.
  const [tried, setTried] = useState(false);

  const key = keyFor(target, value, by);
  const globalRoles = (data.roles ?? []).filter((r) => r.scope === 'Users');
  const unknownRoles = data.roles ? roles.filter((r) => !globalRoles.some((g) => g._id === r)) : [];

  const changeTarget = (t: RuleTarget) => {
    if (t === target) return;
    setTarget(t);
    setValue('');
    setPicked(null);
    setBy('cn');
    setTried(false);
  };
  const pick = (item: LdapDirectoryItem) => {
    setPicked(item);
    setValue(target === 'ou' || by === 'dn' ? item.dn : item.name);
  };
  const changeBy = (b: GroupIdentity) => {
    setBy(b);
    if (picked) setValue(b === 'dn' ? picked.dn : picked.name);
  };
  const type = (text: string) => {
    setValue(text);
    setPicked(null);
    // Digitado à mão, um texto com "=" é um DN; sem "=", é o nome do grupo.
    if (target === 'group' && text.trim()) setBy(text.includes('=') ? 'dn' : 'cn');
  };
  const toggleRole = (id: string) => setRoles(roles.includes(id) ? roles.filter((r) => r !== id) : [...roles, id]);

  const problem = (() => {
    if (target !== 'all' && !value.trim()) return target === 'group' ? 'Informe o grupo: busque no AD ou digite o nome ou o DN.' : 'Informe a OU: busque no AD ou digite o DN.';
    if (target === 'ou' && !value.includes('=')) return 'O DN da OU deve ter o formato OU=Nome,DC=empresa,DC=local.';
    if (!roles.length && !channels.length && !teams.length) return 'Escolha pelo menos um papel, um canal ou um time.';
    if (others.some((o) => sameOrigin(o.key, key))) return 'Já existe uma regra para esta origem.';
    return null;
  })();
  const submit = () => {
    setTried(true);
    if (problem) return;
    // A mesma origem escrita do mesmo jeito guarda o texto original da chave (o JSON não muda à toa).
    onSave({ key: row && sameOrigin(row.key, key) ? row.key : key, roles, channels: channels.map(channelName), teams });
  };

  return (
    <Modal
      wide
      title={row ? 'Editar regra' : 'Nova regra'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" onClick={submit}>
            {row ? 'Salvar regra' : 'Adicionar regra'}
          </button>
        </>
      }
    >
      <div className="form ldap-rule-form">
        <div className="field" role="radiogroup" aria-label="Aplicar a">
          <span className="field-label">Aplicar a</span>
          <div className="ldap-choices three">
            {(
              [
                ['group', '👥 Um grupo do AD', 'Membros do grupo.'],
                ['ou', '📁 Uma unidade organizacional (OU)', 'Quem está na OU ou abaixo dela.'],
                ['all', '🌐 Todos os usuários sincronizados', 'Vale para todo mundo que vem do AD.'],
              ] as [RuleTarget, string, string][]
            ).map(([id, title, hint]) => (
              <label key={id} className={`ldap-choice ${target === id ? 'on' : ''}`}>
                <input type="radio" name="ldap-rule-target" checked={target === id} onChange={() => changeTarget(id)} />
                <span>
                  <strong>{title}</strong>
                  <span className="field-hint">{hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {target !== 'all' && (
          <>
            <DirectorySearch key={target} kind={target} selectedDn={picked?.dn} onPick={pick} />
            <Field label={target === 'group' ? 'Nome do grupo ou DN' : 'DN da OU'}>
              <input
                className={value.includes('=') ? 'mono' : ''}
                value={value}
                onChange={(e) => type(e.target.value)}
                placeholder={target === 'group' ? 'GG-Operacao ou CN=GG-Operacao,OU=Grupos,DC=empresa,DC=local' : 'OU=SAC,OU=Operacao,DC=empresa,DC=local'}
              />
            </Field>
            {target === 'group' && (
              <div className="field" role="radiogroup" aria-label="Identificar o grupo por">
                <span className="field-label">Identificar o grupo por</span>
                <div className="ldap-choices">
                  <label className={`ldap-choice ${by === 'cn' ? 'on' : ''}`}>
                    <input type="radio" name="ldap-rule-by" checked={by === 'cn'} onChange={() => changeBy('cn')} />
                    <span>
                      <strong>Nome (cn)</strong>
                      <span className="field-hint">Vale para o grupo com esse cn ou sAMAccountName, onde ele estiver.</span>
                    </span>
                  </label>
                  <label className={`ldap-choice ${by === 'dn' ? 'on' : ''}`}>
                    <input type="radio" name="ldap-rule-by" checked={by === 'dn'} onChange={() => changeBy('dn')} />
                    <span>
                      <strong>DN completo</strong>
                      <span className="field-hint">Vale só para este grupo, mesmo que outro tenha o mesmo nome.</span>
                    </span>
                  </label>
                </div>
              </div>
            )}
          </>
        )}
        {key && (
          <p className="muted small ldap-key">
            Chave no mapa: <code>{key}</code>
          </p>
        )}

        <div className="field">
          <span className="field-label">Papéis</span>
          {data.roles === null ? (
            <span className="muted small">Carregando papéis…</span>
          ) : (
            <div className="chips">
              {globalRoles.map((r) => (
                <label key={r._id} className={`chip selectable ${roles.includes(r._id) ? 'on' : ''}`} title={r.restrictDirect ? 'Restrito em conversas diretas' : r.description || undefined}>
                  <input type="checkbox" hidden checked={roles.includes(r._id)} onChange={() => toggleRole(r._id)} />
                  {r.restrictDirect ? `🚫 ${r._id}` : r._id}
                </label>
              ))}
              {unknownRoles.map((r) => (
                <span key={r} className="chip ldap-chip bad" title="Papel inexistente ou de sala: a sincronização ignora.">
                  {r}
                  <button type="button" aria-label={`Remover ${r}`} onClick={() => toggleRole(r)}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <span className="field-hint">🚫 marca papéis restritos em conversas diretas.</span>
        </div>

        <Field label="Canais" hint="Canais que não existirem serão criados como grupos privados.">
          <NamePicker
            value={channels}
            onChange={setChannels}
            prefix="#"
            placeholder="Buscar canal ou digitar um nome novo"
            allowFree
            options={data.rooms?.map((r) => ({ value: r.name, label: r.fname || r.name, icon: roomIcon(r) })) ?? null}
            missing={(v) => (data.rooms && !findRoom(data, v) ? 'será criado' : undefined)}
            normalize={channelName}
          />
        </Field>

        <Field label="Times" hint={data.teams ? 'Times não são criados pela sincronização: escolha um time que já existe.' : 'Não foi possível listar os times. Digite o nome exato do time.'}>
          <NamePicker
            value={teams}
            onChange={setTeams}
            placeholder="Buscar time"
            allowFree={!data.teams}
            options={data.teams?.map((t) => ({ value: t.name, label: t.name, icon: '👥' })) ?? null}
            missing={(v) => (data.teams && !findTeam(data, v) ? 'não existe' : undefined)}
            missingBad
          />
        </Field>

        {tried && problem && <div className="form-error">{problem}</div>}
      </div>
    </Modal>
  );
}

// Busca de grupos ou OUs no AD (ldap.directory.search), com 300 ms de espera entre teclas.
function DirectorySearch({ kind, selectedDn, onPick }: { kind: 'group' | 'ou'; selectedDn?: string; onPick: (item: LdapDirectoryItem) => void }) {
  const [text, setText] = useState('');
  const [armed, setArmed] = useState(false);
  const [state, setState] = useState<{ loading: boolean; items: LdapDirectoryItem[] | null; error: string | null }>({ loading: false, items: null, error: null });

  useEffect(() => {
    if (!armed) return;
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      api
        .get<{ items: LdapDirectoryItem[] }>('ldap.directory.search', { kind, text: text.trim() })
        .then((r) => alive && setState({ loading: false, items: r.items, error: null }))
        .catch((e) => alive && setState({ loading: false, items: null, error: errorMessage(e) }));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [kind, text, armed]);

  return (
    <div className="field">
      <span className="field-label">Buscar no AD</span>
      <input
        type="search"
        value={text}
        onFocus={() => setArmed(true)}
        onChange={(e) => {
          setArmed(true);
          setText(e.target.value);
        }}
        placeholder={kind === 'group' ? 'Nome do grupo (ex.: Operacao)' : 'Nome da OU (ex.: SAC)'}
      />
      {armed && (
        <div className="ldap-dir" aria-live="polite">
          {state.error ? (
            <div className="ldap-dir-msg neg">Não foi possível buscar no AD: {state.error} Você ainda pode digitar {kind === 'group' ? 'o nome ou o DN' : 'o DN'} abaixo.</div>
          ) : state.loading && !state.items ? (
            <div className="ldap-dir-msg muted">Buscando…</div>
          ) : state.items && !state.items.length ? (
            <div className="ldap-dir-msg muted">{kind === 'group' ? 'Nenhum grupo encontrado.' : 'Nenhuma OU encontrada.'}</div>
          ) : (
            <div className={`ldap-dir-list ${state.loading ? 'busy' : ''}`}>
              {state.items?.map((i) => (
                <button key={i.dn} type="button" className={i.dn === selectedDn ? 'on' : ''} onClick={() => onPick(i)}>
                  <span className="ldap-dir-name">
                    {kind === 'group' ? '👥' : '📁'} <strong>{i.name}</strong>
                    {i.description && <span className="muted"> · {i.description}</span>}
                  </span>
                  <span className="mono small muted ldap-dir-dn">{i.dn}</span>
                </button>
              ))}
            </div>
          )}
          {state.items?.length === 50 && <div className="ldap-dir-msg muted small">Mostrando os primeiros 50. Digite parte do nome para filtrar.</div>}
        </div>
      )}
    </div>
  );
}

interface Option {
  value: string;
  label: string;
  icon?: string;
}

// Lista de nomes com sugestões locais; com allowFree aceita um nome que ainda não existe.
function NamePicker({
  value,
  onChange,
  options,
  allowFree,
  placeholder,
  prefix = '',
  missing,
  missingBad,
  normalize = (v) => v.trim(),
}: {
  value: string[];
  onChange: (v: string[]) => void;
  options: Option[] | null;
  allowFree?: boolean;
  placeholder?: string;
  prefix?: string;
  missing?: (v: string) => string | undefined;
  missingBad?: boolean;
  normalize?: (v: string) => string;
}) {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Num modal a lista fica no fluxo: fechar no blur mudaria a altura no meio do clique e o botão clicado sairia do lugar.
  // Por isso ela fecha depois de um clique fora (ou com Tab/Esc).
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => wrapRef.current && !wrapRef.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('click', h);
    return () => document.removeEventListener('click', h);
  }, [open]);
  const has = (v: string) => value.some((x) => x.toLowerCase() === v.toLowerCase());
  const t = normalize(term).toLowerCase();
  const suggestions = useMemo(
    () => (options ?? []).filter((o) => !has(o.value) && (!t || o.value.toLowerCase().includes(t) || o.label.toLowerCase().includes(t))).slice(0, 30),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options, t, value],
  );
  const exact = (options ?? []).find((o) => o.value.toLowerCase() === t);
  const free = allowFree && t && !exact && !has(normalize(term)) ? normalize(term) : '';

  const add = (v: string) => {
    if (v && !has(v)) onChange([...value, v]);
    setTerm('');
    inputRef.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || (e.key === ',' && allowFree)) {
      e.preventDefault();
      if (exact) add(exact.value);
      else if (free) add(free);
      else if (suggestions.length === 1) add(suggestions[0].value);
    } else if (e.key === 'Backspace' && !term && value.length) onChange(value.slice(0, -1));
    else if (e.key === 'Escape' && open) {
      // Fecha só a lista, não o modal.
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setOpen(false);
    } else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className="picker" ref={wrapRef}>
      <div className="chips">
        {value.map((v) => {
          const m = missing?.(v);
          return (
            <span key={v} className={`chip ${m ? `ldap-chip ${missingBad ? 'bad' : 'new'}` : ''}`} title={m ? `${prefix}${v}: ${m}` : undefined}>
              {prefix}
              {v}
              {m && <span className="ldap-chip-note">({m})</span>}
              <button type="button" aria-label={`Remover ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
                ✕
              </button>
            </span>
          );
        })}
      </div>
      <input
        ref={inputRef}
        value={term}
        onChange={(e) => {
          setTerm(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        placeholder={placeholder}
      />
      {open && (suggestions.length > 0 || free || (t && options && !allowFree)) && (
        // onMouseDown evita que o campo perca o foco antes do clique.
        <div className="picker-list" onMouseDown={(e) => e.preventDefault()}>
          {free && (
            <button type="button" onClick={() => add(free)}>
              ＋ Usar <strong>
                {prefix}
                {free}
              </strong>
              <span className="muted">({missing?.(free) ?? 'novo'})</span>
            </button>
          )}
          {suggestions.map((o) => (
            <button key={o.value} type="button" onClick={() => add(o.value)}>
              {o.icon && <span>{o.icon}</span>}
              <strong>{o.label}</strong>
              {o.label !== o.value && <span className="muted">{o.value}</span>}
            </button>
          ))}
          {!suggestions.length && !free && <div className="ldap-dir-msg muted">Nada encontrado.</div>}
        </div>
      )}
    </div>
  );
}

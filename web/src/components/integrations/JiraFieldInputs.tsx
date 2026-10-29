// Campos obrigatórios de um tipo de issue (createmeta), a busca de pessoas do Jira e o erro de formulário dos modais.
// Os valores saem nos formatos que o servidor converte (toJiraFieldValue): ids de opção, a pessoa ({ accountId }),
// datas locais.
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { JiraAssignable, JiraFieldMeta } from '@shared/integrations';
import { localIso } from '@shared/integrations';
import { errorMessage } from '../../lib/api';
import { jiraApi } from '../../lib/integrations';
import { Icon } from '../Icon';
import { Field, SearchInput, Spinner } from '../ui';
import './integrations.css';

export function FormError({ children }: { children: ReactNode }) {
  return (
    <div className="form-error" role="alert">
      <Icon name="error" size={16} />
      <span>{children}</span>
    </div>
  );
}

// ---------- Busca de pessoas (jira.users.assignable) ----------

export type PersonPick = { kind: 'me' } | { kind: 'none' } | { kind: 'user'; user: JiraAssignable } | null;

// labelId: o rótulo visível do campo (Responsável, Supervisor…) dá nome à busca e à lista; sem ele, a busca leva um
// rótulo escondido com o texto de label.
export function PersonSearch({
  target,
  value,
  onChange,
  chips = ['me', 'none'],
  label = 'Buscar pessoa no Jira',
  listLabel = 'Responsável',
  inputId,
  labelId,
  required,
  invalid,
  describedBy,
}: {
  target: { key?: string; projectKey?: string };
  value: PersonPick;
  onChange: (v: PersonPick) => void;
  chips?: ('me' | 'none')[];
  label?: string;
  listLabel?: string;
  inputId?: string;
  labelId?: string;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<JiraAssignable[] | null>(null);
  const [error, setError] = useState('');
  const name = useId();
  const ownId = useId();
  const searchId = inputId ?? ownId;
  const seq = useRef(0);

  // 250 ms depois da última tecla; a busca vazia traz as primeiras pessoas que podem receber a issue.
  useEffect(() => {
    if (!target.key && !target.projectKey) return;
    const n = ++seq.current;
    const t = setTimeout(() => {
      jiraApi
        .assignable({ key: target.key, projectKey: target.projectKey, query: query.trim() })
        .then((r) => n === seq.current && (setUsers(r.users), setError('')))
        .catch((e) => n === seq.current && (setUsers([]), setError(errorMessage(e))));
    }, 250);
    return () => clearTimeout(t);
  }, [query, target.key, target.projectKey]);

  const picked = value?.kind === 'user' ? value.user : null;
  // A pessoa escolhida continua na lista mesmo quando a busca muda.
  const list = picked && users && !users.some((u) => u.accountId === picked.accountId) ? [picked, ...users] : users;
  return (
    <div className="form" style={{ gap: 'var(--space-2)' }}>
      {chips.length > 0 && (
        <div className="chips" role="group" aria-label="Atalhos">
          {chips.includes('me') && (
            <button type="button" className={value?.kind === 'me' ? 'chip selectable on' : 'chip selectable'} aria-pressed={value?.kind === 'me'} onClick={() => onChange({ kind: 'me' })}>
              Eu
            </button>
          )}
          {chips.includes('none') && (
            <button type="button" className={value?.kind === 'none' ? 'chip selectable on' : 'chip selectable'} aria-pressed={value?.kind === 'none'} onClick={() => onChange({ kind: 'none' })}>
              Ninguém
            </button>
          )}
        </div>
      )}
      {!labelId && (
        <label className="visually-hidden" htmlFor={searchId}>
          {label}
        </label>
      )}
      <SearchInput id={searchId} value={query} onChange={setQuery} placeholder={label} />
      {/* Altura fixa: carregando, vazia, com erro ou com resultados, o modal não pula enquanto a pessoa digita. */}
      <div
        className="check-list"
        data-int="people"
        role="radiogroup"
        aria-labelledby={labelId}
        aria-label={labelId ? undefined : listLabel}
        aria-required={required || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        aria-busy={!list || undefined}
      >
        {!list ? (
          <Spinner size="sm" />
        ) : error ? (
          <FormError>{error}</FormError>
        ) : list.length === 0 ? (
          <span className="muted small">Ninguém encontrado.</span>
        ) : (
          list.map((u) => (
            <label key={u.accountId} className="check">
              <input type="radio" name={name} checked={picked?.accountId === u.accountId} onChange={() => onChange({ kind: 'user', user: u })} />
              <span className="ellipsis">
                {u.displayName}
                {u.username && <span className="muted"> @{u.username}</span>}
              </span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}

// ---------- Campos obrigatórios ----------

// Valor padrão do Jira no formato do formulário: {id} vira o id; lista de {id} vira lista de ids.
export function fieldDefault(f: JiraFieldMeta): unknown {
  const v = f.defaultValue;
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? String((x as { id?: unknown }).id ?? '') : String(x))).filter(Boolean);
  if (typeof v === 'object') {
    const o = v as { id?: unknown; accountId?: unknown; displayName?: unknown };
    // Pessoa: o objeto inteiro (o servidor lê o accountId), para a lista mostrar o nome.
    if (o.accountId !== undefined) return { accountId: String(o.accountId), displayName: String(o.displayName ?? o.accountId) };
    return o.id !== undefined ? String(o.id) : undefined;
  }
  return f.kind === 'number' ? String(v) : v;
}

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);

// O que o chat já sabe conferir antes de enviar: obrigatório vazio e número que não é número (a mesma leitura do
// servidor, com vírgula ou ponto). O 400 error-jira-field do servidor continua valendo para o resto.
export function fieldProblems(fields: JiraFieldMeta[], value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = value[f.key];
    if (isEmpty(v)) {
      if (f.required) out[f.key] = `Preencha o campo ${f.name}.`;
    } else if (f.kind === 'number' && !Number.isFinite(Number(String(v).trim().replace(',', '.')))) out[f.key] = 'Informe um número.';
  }
  return out;
}

// id do controle de cada campo: o modal leva o foco para o primeiro campo com problema.
export const fieldControlId = (key: string) => `jira-field-${key.replace(/[^\w-]/g, '_')}`;

export function JiraFieldInputs({
  fields,
  value,
  onChange,
  errors,
  projectKey,
}: {
  fields: JiraFieldMeta[];
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  errors?: Record<string, string>; // campo → mensagem (conferência do chat ou 400 error-jira-field do servidor)
  projectKey?: string;
}) {
  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });
  return (
    <>
      {fields.map((f) => (
        <Fragment key={f.key}>
          <FieldInput f={f} value={value[f.key]} set={(v) => set(f.key, v)} err={errors?.[f.key]} projectKey={projectKey} />
        </Fragment>
      ))}
    </>
  );
}

// Rótulo dos campos montados à mão (sem o <label> do Field): o asterisco é visual; "obrigatório" vai para o nome.
function FieldLabel({ f, id, htmlFor }: { f: JiraFieldMeta; id: string; htmlFor?: string }) {
  const text = (
    <>
      {f.name}
      {f.required && (
        <>
          <span className="field-required" aria-hidden="true">
            *
          </span>
          <span className="visually-hidden"> (obrigatório)</span>
        </>
      )}
    </>
  );
  return htmlFor ? (
    <label className="field-label" id={id} htmlFor={htmlFor}>
      {text}
    </label>
  ) : (
    <span className="field-label" id={id}>
      {text}
    </span>
  );
}

function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span className="field-error" id={id}>
      <Icon name="error" size={14} />
      {children}
    </span>
  );
}

function FieldInput({ f, value, set, err, projectKey }: { f: JiraFieldMeta; value: unknown; set: (v: unknown) => void; err?: string; projectKey?: string }) {
  const base = useId();
  const id = fieldControlId(f.key);
  const labelId = `${base}-label`;
  const errId = `${base}-err`;
  const str = typeof value === 'string' ? value : '';
  switch (f.kind) {
    case 'string':
      return (
        <Field label={f.name} required={f.required} error={err}>
          <input id={id} value={str} maxLength={255} required={f.required} onChange={(e) => set(e.target.value)} />
        </Field>
      );
    case 'text':
      return (
        <Field label={f.name} required={f.required} error={err}>
          <textarea id={id} rows={3} value={str} maxLength={32000} required={f.required} onChange={(e) => set(e.target.value)} />
        </Field>
      );
    case 'number':
      return (
        <Field label={f.name} required={f.required} error={err}>
          <input id={id} inputMode="decimal" value={str} required={f.required} onChange={(e) => set(e.target.value)} />
        </Field>
      );
    case 'date':
      return (
        <Field label={f.name} required={f.required} error={err}>
          <input id={id} type="date" value={str} required={f.required} onChange={(e) => set(e.target.value)} />
        </Field>
      );
    case 'datetime':
      return <DateTimeInput f={f} id={id} labelId={labelId} errId={errId} value={str} set={set} err={err} />;
    case 'option':
    case 'priority':
      return (
        <Field label={f.name} required={f.required} error={err}>
          <select id={id} value={str} required={f.required} onChange={(e) => set(e.target.value || undefined)}>
            <option value="">Escolha uma opção</option>
            {(f.options ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </Field>
      );
    case 'options': {
      const on = new Set(Array.isArray(value) ? (value as string[]) : []);
      return (
        <div className="field">
          <FieldLabel f={f} id={labelId} />
          <div className="chips" role="group" aria-labelledby={labelId} aria-describedby={err ? errId : undefined}>
            {(f.options ?? []).map((o, i) => (
              <label key={o.id} className={on.has(o.id) ? 'chip selectable on' : 'chip selectable'}>
                <input
                  id={i === 0 ? id : undefined}
                  type="checkbox"
                  checked={on.has(o.id)}
                  aria-invalid={err ? true : undefined}
                  onChange={(e) => {
                    const next = new Set(on);
                    if (e.target.checked) next.add(o.id);
                    else next.delete(o.id);
                    set([...next]);
                  }}
                />
                {o.name}
              </label>
            ))}
          </div>
          {err && <FieldError id={errId}>{err}</FieldError>}
        </div>
      );
    }
    case 'user':
      return (
        <div className="field">
          <FieldLabel f={f} id={labelId} htmlFor={id} />
          <PersonSearch
            target={{ projectKey }}
            chips={[]}
            inputId={id}
            labelId={labelId}
            required={f.required}
            invalid={!!err}
            describedBy={err ? errId : undefined}
            value={value && typeof value === 'object' ? { kind: 'user', user: value as JiraAssignable } : null}
            onChange={(p) => set(p?.kind === 'user' ? p.user : undefined)}
          />
          {err && <FieldError id={errId}>{err}</FieldError>}
        </div>
      );
    case 'labels':
      return <LabelsInput f={f} id={id} labelId={labelId} errId={errId} value={Array.isArray(value) ? (value as string[]) : []} set={set} err={err} />;
    default:
      return null;
  }
}

// Data e hora separadas; sai como "2026-10-22T14:30:00-03:00" (o fuso do navegador).
function DateTimeInput({ f, id, labelId, errId, value, set, err }: { f: JiraFieldMeta; id: string; labelId: string; errId: string; value: string; set: (v: unknown) => void; err?: string }) {
  const [date, setDate] = useState(() => value.slice(0, 10));
  const [time, setTime] = useState(() => value.slice(11, 16));
  const emit = (d: string, t: string) => {
    if (!d || !t) return set(undefined);
    const at = new Date(`${d}T${t}`);
    set(Number.isNaN(at.getTime()) ? undefined : localIso(at, -at.getTimezoneOffset()));
  };
  const described = err ? errId : undefined;
  return (
    <div className="field" role="group" aria-labelledby={labelId}>
      <FieldLabel f={f} id={labelId} />
      <div className="two-col">
        <input
          id={id}
          type="date"
          aria-label={`${f.name}: data`}
          aria-invalid={err ? true : undefined}
          aria-describedby={described}
          value={date}
          required={f.required}
          onChange={(e) => {
            setDate(e.target.value);
            emit(e.target.value, time);
          }}
        />
        <input
          type="time"
          aria-label={`${f.name}: hora`}
          aria-invalid={err ? true : undefined}
          aria-describedby={described}
          value={time}
          required={f.required}
          onChange={(e) => {
            setTime(e.target.value);
            emit(date, e.target.value);
          }}
        />
      </div>
      {err && <FieldError id={errId}>{err}</FieldError>}
    </div>
  );
}

// Rótulos: Enter ou vírgula acrescenta; espaço não vale no Jira.
function LabelsInput({ f, id, labelId, errId, value, set, err }: { f: JiraFieldMeta; id: string; labelId: string; errId: string; value: string[]; set: (v: unknown) => void; err?: string }) {
  const [draft, setDraft] = useState('');
  const [local, setLocal] = useState('');
  const add = () => {
    const t = draft.trim().replace(/,+$/, '');
    if (!t) return;
    if (/\s/.test(t)) {
      setLocal('Rótulos não podem ter espaços.');
      return;
    }
    setLocal('');
    if (!value.includes(t)) set([...value, t]);
    setDraft('');
  };
  const error = local || err;
  return (
    <div className="field">
      <FieldLabel f={f} id={labelId} htmlFor={id} />
      {value.length > 0 && (
        <div className="chips">
          {value.map((l) => (
            <span key={l} className="chip">
              {l}
              <button type="button" aria-label={`Remover ${l}`} onClick={() => set(value.filter((x) => x !== l))}>
                <Icon name="close" size={14} />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        id={id}
        value={draft}
        aria-required={f.required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errId : undefined}
        placeholder="Digite e tecle Enter"
        onChange={(e) => {
          setDraft(e.target.value);
          if (local && !/\s/.test(e.target.value.trim())) setLocal('');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
      {error && <FieldError id={errId}>{error}</FieldError>}
    </div>
  );
}

// Integrações (Jira/Teams): peças comuns das telas de administração (cabeçalho, linhas de configuração, barra de
// salvar, caixa de copiar, campo de chips e o estado do conector).
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { RuleMeta, Tone } from '@shared/integrations';
import { errorMessage } from '../../../lib/api';
import { formatRelative, plural } from '../../../lib/format';
import { realtime } from '../../../lib/realtime';
import { useStore } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { Empty, Skeleton, Toggle } from '../../../components/ui';
import { Portal, useAnchored, useIsPhone } from '../../../components/overlay';
import './integrations-admin.css';

export const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
export const done = (text: string) => useStore.getState().toast(text, 'success');
export const note = (text: string) => useStore.getState().toast(text);

// Recarrega quando a configuração ou os alertas mudam em outra aba ou por outra pessoa.
export function useIntegrationEvents(fn: () => void) {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  useEffect(() => {
    const off = realtime.on((ev) => {
      if (ev.type === 'integrations.changed' || ev.type === 'integrations.alert') ref.current();
    });
    return () => {
      off();
    };
  }, []);
}

// ---------- Estado ----------

const TONE_PILL: Record<Tone, { cls: string; text: string }> = {
  ok: { cls: 'pill ok', text: 'Conectado' },
  warn: { cls: 'pill warn', text: 'Atenção' },
  err: { cls: 'pill err', text: 'Com erro' },
  off: { cls: 'pill', text: 'Desligado' },
  info: { cls: 'pill', text: 'Desligado' },
};

export function StatusPill({ tone, className }: { tone: Tone; className?: string }) {
  const p = TONE_PILL[tone] ?? TONE_PILL.off;
  return <span className={className ? `${p.cls} ${className}` : p.cls}>{p.text}</span>;
}

// Texto de ?motivo= do retorno do OAuth.
const MOTIVO: Record<string, string> = {
  estado: 'o pedido expirou ou foi aberto em outro navegador',
  config: 'a integração não está configurada',
  conflito: 'esta conta já está conectada a outra pessoa do chat',
  conta: 'não foi possível ler os dados da conta',
  erro: 'erro inesperado',
  negado: 'o acesso não foi autorizado',
  rede: 'o servidor não conseguiu se comunicar com o serviço',
  site: 'a conta não tem acesso ao endereço configurado',
  token: 'o código de acesso não foi aceito',
};
// Só os códigos conhecidos: qualquer outro texto do endereço viraria uma frase dentro do aviso de erro do app.
export const motivoText = (m: string | null) => (m && Object.hasOwn(MOTIVO, m) ? MOTIVO[m] : MOTIVO.erro);

// Situação de uma regra na tabela: desligada, com erro (o erro mais novo que o último acerto), funcionando (acerto
// nas últimas 24 h) ou parada. idle: sem nenhum acerto; stale: o último acerto passou de 24 h.
const DAY_MS = 24 * 60 * 60 * 1000;
export function RuleStatus({ rule, idle, stale }: { rule: RuleMeta; idle: string; stale: string }) {
  if (!rule.enabled) return <span className="pill">Desligada</span>;
  const okAt = rule.lastOkAt ? new Date(rule.lastOkAt).getTime() : 0;
  const errAt = rule.lastErrorAt ? new Date(rule.lastErrorAt).getTime() : 0;
  if (rule.lastError && errAt >= okAt)
    return (
      <span className="pill err" title={rule.lastError}>
        Com erro
      </span>
    );
  if (!okAt) return <span className="pill">{idle}</span>;
  const since = `Último ${formatRelative(rule.lastOkAt)}`;
  if (Date.now() - okAt <= DAY_MS)
    return (
      <span className="pill ok" title={since}>
        Funcionando
      </span>
    );
  return (
    <span className="pill" title={since}>
      {stale}
    </span>
  );
}

// ---------- Cabeçalho das páginas do Jira e do Teams ----------

// Enquanto carrega, o selo e o "Ativado" já ocupam o lugar deles: nada pula quando a configuração chega. Na linha
// do texto, o esqueleto fica em linha: a linha mantém a altura do texto que vai chegar.
export const INLINE_SKELETON: CSSProperties = { display: 'inline-block', verticalAlign: 'middle' };

export function SubHead({
  title,
  tone,
  enabled,
  busy,
  loading,
  onToggle,
}: {
  title: string;
  tone: Tone | null;
  enabled: boolean | null;
  busy?: boolean;
  loading?: boolean;
  onToggle: (v: boolean) => void;
}) {
  const phone = useIsPhone();
  return (
    <div className="page-title-row page-head">
      {phone ? (
        <Link className="icon-btn" to="/admin/integrations" aria-label="Voltar para Integrações" title="Integrações">
          <Icon name="back" />
        </Link>
      ) : (
        <Link className="btn ghost small" to="/admin/integrations">
          <Icon name="back" />
          Integrações
        </Link>
      )}
      <h1>
        {title}
        {tone ? <StatusPill tone={tone} className="head-count" /> : loading && <Skeleton width={72} height={20} className="head-count" style={INLINE_SKELETON} />}
      </h1>
      {(enabled !== null || loading) && (
        <div className="page-actions">
          <Toggle checked={!!enabled} disabled={busy || enabled === null} onChange={onToggle} label="Ativado" />
        </div>
      )}
    </div>
  );
}

// ---------- Configurações ----------

export function SettingRow({
  label,
  help,
  children,
  htmlFor,
  modified,
  group,
}: {
  label: ReactNode;
  help?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  modified?: boolean;
  // Rádios: o controle vira o radiogroup, com o nome da linha como rótulo.
  group?: boolean;
}) {
  const id = useId();
  return (
    <div className={modified ? 'setting-row modified' : 'setting-row'}>
      <div className="setting-label">
        <span className="setting-name" id={`${id}-l`}>
          {modified && <span className="setting-dot" aria-hidden="true" />}
          {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : label}
        </span>
        {help && <span className="setting-desc">{help}</span>}
      </div>
      <div className="setting-control" role={group ? 'radiogroup' : undefined} aria-labelledby={group ? `${id}-l` : undefined}>
        {children}
      </div>
    </div>
  );
}

// O design system não tem estado desligado para .check: o texto fica apagado e o cursor avisa. A explicação (ou o
// motivo de a opção estar desligada) vem logo embaixo, no par rótulo + descrição do design system.
const RADIO_OFF: CSSProperties = { cursor: 'not-allowed' };

export function Radio<T extends string>({
  name,
  value,
  current,
  onChange,
  children,
  disabled,
  hint,
}: {
  name: string;
  value: T;
  current: T;
  onChange: (v: T) => void;
  children: ReactNode;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  const id = useId();
  const radio = (
    <label className="check" style={disabled ? RADIO_OFF : undefined}>
      <input type="radio" name={name} checked={current === value} disabled={disabled} aria-describedby={hint ? id : undefined} onChange={() => onChange(value)} />
      <span className={disabled ? 'muted' : undefined}>{children}</span>
    </label>
  );
  if (!hint) return radio;
  return (
    <div className="toggle-text">
      {radio}
      <span className="toggle-desc" id={id}>
        {hint}
      </span>
    </div>
  );
}

// Campo com controle composto (chips, lista de salas): rótulo e ajuda fora de um <label>, que só aceita um controle.
export function FieldBlock({ label, htmlFor, hint, error, errorId, children }: { label: string; htmlFor?: string; hint?: ReactNode; error?: string; errorId?: string; children: ReactNode }) {
  const id = useId();
  // Com htmlFor o rótulo já nomeia o campo; o grupo só existe para conjuntos (chips, caixas, salas).
  return (
    <div className="field" role={htmlFor ? undefined : 'group'} aria-labelledby={htmlFor ? undefined : id}>
      {htmlFor ? (
        <label className="field-label" id={id} htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="field-label" id={id}>
          {label}
        </span>
      )}
      {children}
      {hint && <span className="field-hint">{hint}</span>}
      {error && (
        <span className="field-error" id={errorId}>
          <Icon name="error" size={14} />
          {error}
        </span>
      )}
    </div>
  );
}

// Erro de um campo do formulário: o campo fica marcado (aria-invalid), o texto aparece embaixo dele e o foco vai
// para ele. fields diz o id do elemento que recebe o foco em cada campo.
export interface Invalid<K extends string> {
  field: K;
  text: string;
}

export function useInvalid<K extends string>(fields: Record<K, string>) {
  const [invalid, setInvalid] = useState<Invalid<K> | null>(null);
  const base = useId();
  const target = invalid ? fields[invalid.field] : null;
  useEffect(() => {
    if (!invalid || !target) return;
    const el = document.getElementById(target);
    el?.scrollIntoView({ block: 'center' });
    el?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invalid]);
  const errorId = (k: K) => `${base}-${k}-erro`;
  return {
    invalid,
    show: (v: Invalid<K>) => setInvalid({ ...v }),
    clear: (k?: K) => setInvalid((cur) => (!cur || !k || cur.field === k ? null : cur)),
    error: (k: K) => (invalid?.field === k ? invalid.text : undefined),
    errorId,
    // Para o próprio campo: <input {...v.aria('name')} />
    aria: (k: K) => (invalid?.field === k ? { 'aria-invalid': true as const, 'aria-describedby': errorId(k) } : {}),
  };
}

// Erro do formulário no fim de um modal: rola até ele, senão quem clicou em salvar não vê o que faltou.
export function FormError({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest' });
  }, [text]);
  return (
    <div ref={ref} className="form-error" role="alert">
      <Icon name="error" size={16} />
      <span>{text}</span>
    </div>
  );
}

// Barra presa no pé da página (filho direto do .page-body: quem usa devolve fragmentos).
export function SaveBar({ count, saving, onDiscard, onSave }: { count: number; saving: boolean; onDiscard: () => void; onSave: () => void }) {
  if (!count) return null;
  return (
    <div className="save-bar" role="region" aria-label="Alterações não salvas">
      <span className="save-bar-text">
        <span className="save-bar-dot" aria-hidden="true" />
        {plural(count, 'alteração não salva', 'alterações não salvas')}
      </span>
      <button type="button" className="btn ghost" onClick={onDiscard} disabled={saving}>
        Descartar
      </button>
      <button type="button" className="btn primary" onClick={onSave} disabled={saving} aria-busy={saving || undefined}>
        Salvar alterações
      </button>
    </div>
  );
}

// Conteúdo de uma aba com barra de salvar. Quando a barra aparece, o .page-body vira coluna flexível e as margens
// dos filhos diretos deixam de se juntar: dentro deste bloco (que contém as próprias margens) o espaço é o mesmo
// com e sem a barra, e nada pula ao digitar.
const TAB_BODY: CSSProperties = { display: 'flow-root' };

export function TabBody({ children }: { children: ReactNode }) {
  return <div style={TAB_BODY}>{children}</div>;
}

// Falha ao carregar uma aba ou lista: o estado de erro do design system, com o botão de tentar de novo.
export function LoadError({ text, onRetry }: { text: ReactNode; onRetry: () => void }) {
  return (
    <Empty
      icon="error"
      tone="danger"
      title="Não foi possível carregar"
      action={
        <button type="button" className="btn" onClick={onRetry}>
          <Icon name="int-retry" />
          Tentar de novo
        </button>
      }
    >
      {text}
    </Empty>
  );
}

// Passo a passo recolhido ("Como criar…"): um botão do design system que abre e fecha o conteúdo logo abaixo. Numa
// página de configurações fica afastado do bloco de cima (settings-extra); num formulário, o espaço é o do .form.
export function Disclosure({ label, children, inForm }: { label: string; children: ReactNode; inForm?: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={inForm ? 'toggle-list' : 'settings-extra toggle-list'}>
      <div>
        <button type="button" className="btn small ghost" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
          <Icon name={open ? 'chevron-down' : 'next'} />
          {label}
        </button>
      </div>
      {open && <div id={id}>{children}</div>}
    </div>
  );
}

// Endereços longos de uma frase do servidor: <wbr> depois de cada "/" deixa a linha quebrar dentro do endereço no
// celular, em vez de passar da borda.
export function Breakable({ text }: { text: string | null | undefined }) {
  return (
    <>
      {(text ?? '').split(/(https?:\/\/\S+)/).map((part, i) =>
        i % 2 ? (
          <span key={i}>
            {part.split('/').map((seg, j) => (
              <span key={j}>
                {j > 0 && '/'}
                {j > 0 && <wbr />}
                {seg}
              </span>
            ))}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

// Avisa antes de fechar a aba do navegador com alterações não salvas.
export function useUnsavedGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
}

// ---------- Copiar ----------

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // http sem contexto seguro: cópia pelo campo temporário
    const t = document.createElement('textarea');
    t.value = value;
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  }
}

// O botão vira "Copiado" por 1,5 s (design system §9.2).
export function useCopied(): [boolean, (value: string) => Promise<boolean>] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async (value: string) => {
    const ok = await copyText(value);
    if (!ok) return false;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
    return true;
  };
  return [copied, copy];
}

// A caixa ocupa a coluna toda (a coluna de controle alinha à esquerda) e o campo encolhe dentro dela: um endereço
// longo cabe na largura do campo no computador e não empurra a página para o lado no celular.
const COPY_BOX: CSSProperties = { alignSelf: 'stretch', minWidth: 0 };
const COPY_INPUT: CSSProperties = { minWidth: 0 };

export function CopyBox({ value, label, onCopy, mono = true }: { value: string; label: string; onCopy?: () => void; mono?: boolean }) {
  const [copied, copy] = useCopied();
  return (
    <div className="copy-box" style={COPY_BOX}>
      <input readOnly value={value} style={COPY_INPUT} aria-label={label} className={mono ? 'mono' : undefined} spellCheck={false} onFocus={(e) => e.target.select()} />
      <button
        type="button"
        className="btn"
        onClick={async () => {
          if (await copy(value)) onCopy?.();
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} />
        {copied ? 'Copiado' : 'Copiar'}
      </button>
    </div>
  );
}

// ---------- Lista de sugestões ----------

// Lista ancorada no campo, num portal: flutua sobre o conteúdo em vez de empurrá-lo (o clique no que está embaixo
// não se perde quando ela fecha) e, aberta de dentro de um modal, sobe acima dele (data-layer="modal").
export function SuggestList({ anchor, id, label, onHidden, children }: { anchor: HTMLElement | null; id: string; label: string; onHidden: () => void; children: ReactNode }) {
  const a = useAnchored({ open: true, placement: 'bottom-start', matchWidth: true, onHidden });
  const { setReference } = a;
  useLayoutEffect(() => {
    setReference(anchor);
  }, [anchor, setReference]);
  return (
    <Portal>
      <div ref={a.setFloating} id={id} className="picker-list" role="listbox" aria-label={label} style={a.style} data-side={a.positioned ? a.side : undefined} data-layer={a.layer}>
        {children}
      </div>
    </Portal>
  );
}

// ---------- Chips (projetos, tipos de issue, palavras-chave) ----------

// Campo inválido: a caixa visível é o .chips (o campo de dentro não tem borda), então a borda e o halo de erro do
// design system para input[aria-invalid] vão nela. Fica no style porque vence o :hover e o :focus-within do .chips.
const CHIPS_INVALID: CSSProperties = { borderColor: 'var(--danger)' };
const CHIPS_INVALID_FOCUS: CSSProperties = { borderColor: 'var(--danger)', boxShadow: '0 0 0 3px color-mix(in srgb, var(--danger) 22%, transparent)' };

export interface ChipSuggestion {
  value: string;
  label: ReactNode;
}

export function ChipInput({
  value,
  onChange,
  placeholder,
  label,
  max,
  normalize = (v) => v.trim(),
  mono,
  suggest,
  chipTitle,
  inputId,
  invalid,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  label: string;
  max?: number;
  normalize?: (v: string) => string;
  mono?: boolean;
  // Sugestões opcionais (projetos do Jira); sem resposta, o campo aceita o que for digitado.
  suggest?: (q: string) => Promise<ChipSuggestion[]>;
  chipTitle?: (v: string) => string | undefined;
  inputId?: string;
  // aria-invalid e aria-describedby do erro do campo (useInvalid().aria).
  invalid?: { 'aria-invalid'?: true; 'aria-describedby'?: string };
}) {
  const [term, setTerm] = useState('');
  const [items, setItems] = useState<ChipSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const full = max !== undefined && value.length >= max;

  useEffect(() => {
    if (!suggest || !open) return;
    let alive = true;
    const t = setTimeout(() => {
      suggest(term.trim())
        .then((r) => alive && (setItems(r.filter((i) => !value.includes(i.value)).slice(0, 8)), setActive(0)))
        .catch(() => alive && setItems([]));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [term, open, suggest, value]);

  const add = (raw: string) => {
    const parts = raw
      .split(/[,;\n]+/)
      .map(normalize)
      .filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const p of parts) if (!next.includes(p) && (max === undefined || next.length < max)) next.push(p);
    onChange(next);
    setTerm('');
  };
  // Escolheu da lista: ela fecha (digitar ou ↓ abre de novo).
  const pick = (v: string) => {
    add(v);
    setOpen(false);
  };
  const shown = open && !full ? items : [];
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const t = term.trim();
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && suggest && !open) {
      e.preventDefault();
      setOpen(true);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && shown.length) {
      e.preventDefault();
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length);
    } else if (e.key === 'Enter') {
      // Enter nunca envia o formulário daqui: escolhe a sugestão marcada ou o que foi digitado.
      e.preventDefault();
      if (shown[active]) pick(shown[active].value);
      else if (t) add(t);
    } else if ((e.key === ',' || e.key === 'Tab') && t) {
      if (e.key === ',') e.preventDefault();
      add(t);
    } else if (e.key === 'Backspace' && !term && value.length) {
      onChange(value.slice(0, -1));
    } else if (e.key === 'Escape' && shown.length) {
      // Fecha só a lista, não o modal.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };
  return (
    <div className="picker">
      {/* Toque em qualquer ponto da caixa (44 px no toque) põe o cursor no campo, não só nos 40 px do campo. */}
      <div
        className="chips"
        ref={setBox}
        style={invalid?.['aria-invalid'] ? (focused ? CHIPS_INVALID_FOCUS : CHIPS_INVALID) : undefined}
        onMouseDown={(e) => {
          if (e.target !== e.currentTarget || full) return;
          e.preventDefault();
          inputRef.current?.focus();
          setOpen(true);
        }}
      >
        {value.map((v) => (
          <span key={v} className={mono ? 'chip mono' : 'chip'} title={chipTitle?.(v)}>
            {v}
            <button type="button" aria-label={`Remover ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
              <Icon name="close" size={14} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={inputId}
          value={term}
          disabled={full}
          aria-label={label}
          placeholder={full ? undefined : placeholder}
          spellCheck={false}
          role={suggest ? 'combobox' : undefined}
          aria-expanded={suggest ? shown.length > 0 : undefined}
          aria-controls={suggest && shown.length ? listId : undefined}
          aria-autocomplete={suggest ? 'list' : undefined}
          {...invalid}
          onChange={(e) => (setTerm(e.target.value), setOpen(true))}
          // A lista abre ao clicar, digitar ou com ↓, não só por receber o foco: quando o formulário leva o foco ao
          // campo com erro, ela cobriria a mensagem logo embaixo.
          onFocus={() => setFocused(true)}
          onClick={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setFocused(false);
            if (term.trim()) add(term);
          }}
          onKeyDown={onKey}
        />
      </div>
      {shown.length > 0 && (
        <SuggestList anchor={box} id={listId} label={label} onHidden={() => setOpen(false)}>
          {shown.map((s, i) => (
            <button
              key={s.value}
              type="button"
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : undefined}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s.value)}
            >
              {s.label}
            </button>
          ))}
        </SuggestList>
      )}
    </div>
  );
}

// Chave de projeto do Jira: "ops" → "OPS".
export const projectKey = (v: string) => v.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');

// ---------- Rascunho de um formulário de configurações ----------

// undefined (manter) e null (apagar o segredo ao salvar) são valores diferentes: só iguais a si mesmos.
const same = (a: unknown, b: unknown) => (a === undefined || b === undefined ? a === b : JSON.stringify(a) === JSON.stringify(b));

// Valores salvos (base) + o que a pessoa mudou; changed lista só o que difere do salvo.
export function useDraft<T extends object>(base: T) {
  const [draft, setDraft] = useState<Partial<T>>({});
  const get = <K extends keyof T>(k: K): T[K] => (k in draft ? (draft[k] as T[K]) : base[k]);
  const set = <K extends keyof T>(k: K, v: T[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const changed = (Object.keys(draft) as (keyof T)[]).filter((k) => !same(draft[k], base[k]));
  const reset = () => setDraft({});
  return { get, set, changed, reset, isChanged: (k: keyof T) => changed.includes(k) };
}

// Data da API (ISO) para o campo date ("2026-10-22").
export const isoDay = (iso?: string | null) => (iso ? iso.slice(0, 10) : '');

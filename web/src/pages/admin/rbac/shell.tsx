// Estrutura das telas de Usuários e Papéis (guia de layout): lista com uma faixa única no topo e editor com cabeçalho
// fixo, conteúdo em cards e a barra de abas fixa no rodapé, com o conteúdo deslizando na troca de aba.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, type IconName } from '../../../components/Icon';
import { Tooltip } from '../../../components/ui';

const nf = new Intl.NumberFormat('pt-BR');

// ---------- Lista ----------

export function ListStrip({
  eyebrow,
  title,
  search,
  onSearch,
  placeholder,
  count,
  children,
}: {
  eyebrow: string;
  title: string;
  search?: string;
  onSearch?: (v: string) => void;
  placeholder?: string;
  count?: number;
  children?: ReactNode;
}) {
  return (
    <div className="rbac-strip">
      <div className="rbac-strip-title">
        <span className="rbac-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
      </div>
      {onSearch && (
        <label className="rbac-search">
          <Icon name="search" />
          <input type="search" value={search ?? ''} placeholder={placeholder} aria-label={placeholder} onChange={(e) => onSearch(e.target.value)} />
          {search && (
            <button type="button" aria-label="Limpar busca" onClick={() => onSearch('')}>
              <Icon name="close" size={14} />
            </button>
          )}
        </label>
      )}
      {count !== undefined && (
        <span className="rbac-count">
          <i aria-hidden="true" />
          {nf.format(count)} {count === 1 ? 'registro' : 'registros'}
        </span>
      )}
      <div className="rbac-strip-actions">{children}</div>
    </div>
  );
}

export function Chips<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: { id: T; label: string; count?: number }[]; label: string }) {
  return (
    <div className="rbac-chips" role="radiogroup" aria-label={label}>
      {items.map((i) => (
        <button key={i.id} type="button" role="radio" aria-checked={value === i.id} className={value === i.id ? 'on' : ''} onClick={() => onChange(i.id)}>
          {i.label}
          {i.count !== undefined && <span className="rbac-chip-count">{nf.format(i.count)}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------- Editor ----------

export interface EditorTab<T extends string> {
  id: T;
  label: string;
  icon: IconName;
  hidden?: boolean;
}

export function EditorShell<T extends string>({
  backTo,
  onBack,
  icon,
  iconClass,
  eyebrow,
  title,
  status,
  dirty,
  canWrite,
  saving,
  onRevert,
  onSave,
  saveLabel = 'Salvar',
  notices,
  tabs,
  active,
  onTab,
  label,
  children,
}: {
  backTo: string;
  onBack?: () => Promise<boolean> | boolean;
  icon: ReactNode;
  iconClass?: string;
  eyebrow: string;
  title: ReactNode;
  status?: ReactNode;
  dirty: boolean;
  canWrite: boolean;
  saving?: boolean;
  onRevert?: () => void;
  onSave?: () => void;
  saveLabel?: string;
  notices?: ReactNode;
  tabs: EditorTab<T>[];
  active: T;
  onTab: (t: T) => void;
  label: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const visible = tabs.filter((t) => !t.hidden);
  const index = visible.findIndex((t) => t.id === active);
  // Direção do deslize: aba à direita entra pela direita; voltando, pela esquerda.
  const prev = useRef(index);
  const [dir, setDir] = useState<'next' | 'prev' | null>(null);
  useEffect(() => {
    if (prev.current !== index) setDir(index > prev.current ? 'next' : 'prev');
    prev.current = index;
  }, [index]);
  const back = async () => {
    if (onBack && !(await onBack())) return;
    navigate(backTo);
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    const n = e.key === 'ArrowRight' ? index + 1 : e.key === 'ArrowLeft' ? index - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? visible.length - 1 : null;
    if (n === null) return;
    e.preventDefault();
    const t = visible[(n + visible.length) % visible.length];
    onTab(t.id);
    (e.currentTarget.querySelector(`[data-tab="${t.id}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div className="rbac-shell editor">
      <header className="rbac-editor-bar">
        <button type="button" className="rbac-back-btn" aria-label="Voltar" onClick={() => void back()}>
          <Icon name="back" size={18} />
        </button>
        <span className={`rbac-editor-icon ${iconClass ?? ''}`}>{icon}</span>
        <div className="rbac-editor-heading">
          <span className="rbac-eyebrow">{eyebrow}</span>
          <div className="rbac-editor-name">
            {title}
            {status}
          </div>
        </div>
        <div className="rbac-editor-actions">
          {dirty && (
            <span className="rbac-dirty" role="status">
              <i aria-hidden="true" />
              Alterações não salvas
            </span>
          )}
          {canWrite && onRevert && (
            <button type="button" className="btn small rbac-revert-btn" disabled={!dirty || saving} onClick={onRevert}>
              <Icon name="rbac-revert" size={14} />
              <span>Reverter</span>
            </button>
          )}
          {canWrite && onSave && (
            <button type="button" className="btn primary" disabled={!dirty || saving} aria-busy={saving || undefined} onClick={onSave}>
              <Icon name={saving ? 'loading' : 'check'} className={saving ? 'spin' : undefined} />
              {saveLabel}
            </button>
          )}
        </div>
      </header>
      <div className="rbac-editor-body">
        {notices}
        <div className="rbac-slide">
          <div key={active} className={`rbac-panel${dir ? ` from-${dir}` : ''}`} role="tabpanel" id={`rbac-panel-${active}`} aria-labelledby={`rbac-tab-${active}`}>
            {children}
          </div>
        </div>
      </div>
      <nav className="rbac-tabbar" role="tablist" aria-label={label} onKeyDown={onKey}>
        {visible.map((t) => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`rbac-tab-${t.id}`}
              data-tab={t.id}
              aria-selected={on}
              aria-controls={`rbac-panel-${t.id}`}
              tabIndex={on ? 0 : -1}
              className={on ? 'on' : ''}
              title={t.label}
              onClick={() => onTab(t.id)}
            >
              <Icon name={t.icon} size={16} />
              <span>{t.label}</span>
            </button>
          );
        })}
        <span className="rbac-tab-indicator" aria-hidden="true" style={{ left: `calc(${index} * 100% / ${visible.length} + 12px)`, width: `calc(100% / ${visible.length} - 24px)` }} />
      </nav>
    </div>
  );
}

// Card de seção: ícone na cor de destaque, título com a barrinha, dica, ação e contador opcionais.
export function Section({ icon, title, hint, action, count, id, children, flush }: { icon: IconName; title: ReactNode; hint?: ReactNode; action?: ReactNode; count?: ReactNode; id?: string; children: ReactNode; flush?: boolean }) {
  return (
    <section className="rbac-section" id={id}>
      <header className="rbac-section-header">
        <Icon name={icon} size={20} />
        <div className="rbac-section-titles">
          <h2>
            <i aria-hidden="true" />
            {title}
            {count !== undefined && <span className="pill head-count">{count}</span>}
          </h2>
          {hint && <p>{hint}</p>}
        </div>
        {action}
      </header>
      <div className={flush ? 'rbac-section-body flush' : 'rbac-section-body'}>{children}</div>
    </section>
  );
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'lock' | 'warn'; children: ReactNode }) {
  return (
    <div className={`rbac-notice ${kind}`}>
      <Icon name={kind === 'lock' ? 'rbac-lock' : kind === 'warn' ? 'warning' : 'info'} />
      <span>{children}</span>
    </div>
  );
}

export function LockHint({ text }: { text: string }) {
  return (
    <Tooltip label={text}>
      <span className="rbac-lock-tag" aria-label={text}>
        <Icon name="rbac-lock" size={12} />
      </span>
    </Tooltip>
  );
}

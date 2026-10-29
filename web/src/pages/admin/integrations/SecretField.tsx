// Integrações (Jira/Teams): campo de segredo (§7.6). O valor gravado nunca volta do servidor: só "cadastrado",
// o final e as datas. value: undefined = manter, null = apagar ao salvar, texto = trocar.
import { useEffect, useRef, useState } from 'react';
import type { SecretState } from '@shared/integrations';
import { Icon } from '../../../components/Icon';
import './integrations-admin.css';

const dateFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });
const day = (iso?: string | null) => (iso ? dateFmt.format(new Date(iso)) : '');
// "••••a1b2" → "a1b2"
export const secretTail = (hint?: string) => (hint ?? '').replace(/^[•*.\s]+/, '');

function ExpiryPill({ expiresAt }: { expiresAt?: string | null }) {
  if (!expiresAt) return null;
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return <span className="pill err">Expirado</span>;
  if (days <= 14) return <span className="pill warn">{days === 1 ? 'Expira em 1 dia' : `Expira em ${days} dias`}</span>;
  return null;
}

export function SecretField(p: {
  state: SecretState;
  value: string | null | undefined;
  onChange: (v: string | null | undefined) => void;
  placeholder?: string;
  disabled?: boolean;
  label?: string;
  id?: string;
  // Segredo obrigatório (endereço do fluxo): só dá para trocar, não apagar.
  clearable?: boolean;
  // aria-invalid e aria-describedby do erro do campo (useInvalid().aria).
  invalid?: { 'aria-invalid'?: true; 'aria-describedby'?: string };
}) {
  const { state, value, onChange, placeholder, disabled, label, id, clearable = true, invalid } = p;
  const [editing, setEditing] = useState(false);
  const [shown, setShown] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const focusNext = useRef(false);
  const isEditing = editing || typeof value === 'string' || (!state.set && value === undefined);

  useEffect(() => {
    if (isEditing && focusNext.current) {
      focusNext.current = false;
      input.current?.focus();
    }
  }, [isEditing]);

  if (value === null)
    return (
      <div className="int-secret">
        <span>
          <Icon name="delete" />
          Será apagado ao salvar
        </span>
        <button type="button" className="btn small ghost" disabled={disabled} onClick={() => onChange(undefined)}>
          Desfazer
        </button>
      </div>
    );

  if (!isEditing)
    return (
      <div className="int-secret">
        {state.unreadable ? (
          <span>
            <span className="pill err">Ilegível</span>
            Cadastre de novo
          </span>
        ) : (
          <span>
            <Icon name="encrypted" />
            {`Cadastrado · final ${secretTail(state.hint)}${state.updatedAt ? ` · atualizado ${day(state.updatedAt)}` : ''}`}
            <ExpiryPill expiresAt={state.expiresAt} />
          </span>
        )}
        {/* Os botões ficam sempre embaixo do texto (o div ocupa a linha toda): a quebra não depende do tamanho do final. */}
        <div className="row-actions">
          <button
            type="button"
            className="btn small"
            disabled={disabled}
            onClick={() => {
              focusNext.current = true;
              setEditing(true);
            }}
          >
            Trocar
          </button>
          {clearable && (
            <button type="button" className="btn small ghost" disabled={disabled} onClick={() => onChange(null)}>
              Apagar
            </button>
          )}
        </div>
      </div>
    );

  return (
    <div className="int-secret">
      <input
        ref={input}
        id={id}
        type={shown ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        placeholder={placeholder}
        disabled={disabled}
        value={value ?? ''}
        {...invalid}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
      />
      <button type="button" className="icon-btn" aria-label={shown ? 'Ocultar' : 'Mostrar'} title={shown ? 'Ocultar' : 'Mostrar'} disabled={disabled} onClick={() => setShown((s) => !s)}>
        <Icon name={shown ? 'hide' : 'show'} />
      </button>
      {state.set && (
        <button
          type="button"
          className="btn small ghost"
          disabled={disabled}
          onClick={() => {
            setEditing(false);
            setShown(false);
            onChange(undefined);
          }}
        >
          Cancelar
        </button>
      )}
    </div>
  );
}

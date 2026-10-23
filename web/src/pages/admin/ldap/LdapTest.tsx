import { useState, type FormEvent } from 'react';
import type { LdapMappingTest } from '@shared/ldap';
import { api, errorMessage } from '../../../lib/api';
import { useStore } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { Field } from '../../../components/ui';
import { TestResult } from './TestResult';

// Prévia do que a sincronização faria com uma pessoa. Na aba Mapeamento, `overrides` traz o que ainda não foi salvo;
// `draftBlocked` explica por que o rascunho não pode ser usado agora (ex.: JSON inválido, que o servidor ignoraria).
export function LdapTest({ canEdit, overrides, draftBlocked }: { canEdit: boolean; overrides?: () => Record<string, unknown>; draftBlocked?: string }) {
  const [login, setLogin] = useState('');
  const [useDraft, setUseDraft] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ data: LdapMappingTest; draft: boolean } | null>(null);
  const draft = !!overrides && useDraft;
  const blocked = draft && draftBlocked ? draftBlocked : null;

  const run = async (e: FormEvent) => {
    e.preventDefault();
    const l = login.trim();
    if (!l || blocked) return;
    setBusy(true);
    try {
      const r = await api.post<{ result: LdapMappingTest }>('ldap.testMapping', { login: l, ...(draft ? { overrides: overrides!() } : {}) });
      setResult({ data: r.result, draft });
    } catch (err) {
      useStore.getState().toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form className="card form ldap-test-form" onSubmit={(e) => void run(e)}>
        <h3>{overrides ? 'Testar com um usuário' : 'Testar usuário'}</h3>
        <div className="ldap-test-row">
          <Field label="Login do usuário (sAMAccountName, UPN ou e-mail)">
            <input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="ana.souza" autoComplete="off" spellCheck={false} disabled={!canEdit} />
          </Field>
          <button className="btn primary" type="submit" disabled={!canEdit || busy || !login.trim() || !!blocked}>
            {busy ? 'Testando…' : 'Testar mapeamento'}
          </button>
        </div>
        {!canEdit ? (
          <p className="muted small ldap-note">Testar exige permissão para alterar as configurações.</p>
        ) : (
          blocked && (
            <p className="small ldap-warn-text">
              <Icon name="warning" size={14} />
              {blocked}
            </p>
          )
        )}
        {overrides && (
          <label className="check">
            <input type="checkbox" checked={useDraft} disabled={!canEdit} onChange={(e) => setUseDraft(e.target.checked)} /> Usar as alterações não salvas
          </label>
        )}
        <p className="muted small ldap-note">Nada é gravado: é só uma prévia do que a sincronização faria.</p>
      </form>
      {result && <TestResult r={result.data} draft={result.draft} />}
    </>
  );
}

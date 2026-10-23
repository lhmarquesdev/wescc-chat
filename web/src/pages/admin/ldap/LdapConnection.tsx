import { Fragment, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Setting } from '@shared/index';
import { LDAP_AD_PRESET } from '@shared/ldap';
import { api, errorMessage } from '../../../lib/api';
import { useStore } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { SettingInput } from '../AdminSettings';
import type { LdapSettings } from './index';
import { AGENDA_IDS } from './LdapSync';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const ok = (t: string) => useStore.getState().toast(t);

const CONNECTION_SECTIONS: [string, string][] = [
  ['Connection', 'Conexão'],
  ['Authentication', 'Autenticação'],
  ['Search', 'Busca'],
  ['Data Sync', 'Dados do usuário'],
];
// Os grupos ficam juntos num cartão próprio: o filtro de grupos é o que os padrões do AD mais mudam.
const GROUP_IDS = ['LDAP_Group_BaseDN', 'LDAP_Group_Filter', 'LDAP_Group_Nested'];
// Só os campos que a aba mostra: são eles que o "Salvar" grava e que marcam a aba como alterada. O padrão do AD
// também mexe em LDAP_Sync_AD_Disabled, que fica na Agenda e é salvo por lá.
export const connectionIdsOf = (list: Setting[]) =>
  list
    .filter((x) => CONNECTION_SECTIONS.some(([id]) => id === x.section) && !GROUP_IDS.includes(x._id))
    .map((x) => x._id)
    .concat(GROUP_IDS);

const HINTS: Record<string, ReactNode> = {
  LDAP_Url: 'Use ldaps:// (porta 636) para a conexão ir criptografada.',
  LDAP_CA_Certificate: 'Cole aqui o certificado (-----BEGIN CERTIFICATE-----…) quando o AD usa uma autoridade certificadora interna.',
  LDAP_Authentication_UserDN: 'Ex.: CN=svc-chat,CN=Users,DC=empresa,DC=local. Uma conta só de leitura basta.',
  LDAP_BaseDN: 'Ex.: OU=Empresa,DC=empresa,DC=local. A busca inclui todas as OUs abaixo dele.',
  LDAP_User_Search_Filter: 'Para limitar a um grupo do AD, acrescente (memberOf:1.2.840.113556.1.4.1941:=DN do grupo) ao filtro.',
  LDAP_User_Search_Field: 'Atributos aceitos como login, separados por vírgula (ex.: sAMAccountName,userPrincipalName).',
  LDAP_Group_Filter: '#{userdn} é trocado pelo DN do usuário e #{username} pelo login.',
};

export function LdapConnection({ s, ids, onSaved }: { s: LdapSettings; ids: string[]; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [presetIds, setPresetIds] = useState<string[]>([]);
  const dirty = s.dirtyIds(ids);
  const presetHere = presetIds.filter((id) => ids.includes(id) && s.isDirty(id));
  const presetAgenda = presetIds.filter((id) => AGENDA_IDS.includes(id) && s.isDirty(id));
  const labels = (list: string[]) => list.map((id) => s.get(id)?.label ?? id).join(', ');
  // O que o padrão do AD mudou em outra aba continua no aviso depois de salvar ou descartar esta.
  const keepElsewhere = () => setPresetIds((p) => p.filter((id) => !ids.includes(id)));

  const save = async () => {
    setSaving(true);
    const done = await s.save(ids);
    setSaving(false);
    if (done) {
      ok('Configurações do LDAP salvas.');
      keepElsewhere();
      onSaved();
    }
  };
  const applyPreset = () => {
    const changed = s.setMany(LDAP_AD_PRESET);
    if (!changed.length) return ok('As configurações já seguem os padrões do Active Directory.');
    setPresetIds(changed);
    ok('Padrões do Active Directory aplicados. Revise e salve.');
  };
  const test = async () => {
    setTesting(true);
    try {
      const r = await api.post('ldap.testConnection');
      ok(r.message);
    } catch (e) {
      fail(e);
    } finally {
      setTesting(false);
    }
  };

  const input = (id: string) => {
    const def = s.get(id);
    if (!def) return null;
    return (
      <div key={id} className={`ldap-setting ${s.isDirty(id) ? 'changed' : ''}`}>
        <SettingInput s={def} value={s.value(id)} onChange={(v) => s.set(id, v)} hint={HINTS[id]} />
      </div>
    );
  };
  const sectionIds = (section: string) => s.list.filter((x) => x.section === section && !GROUP_IDS.includes(x._id)).map((x) => x._id);

  return (
    <>
      {(presetHere.length > 0 || presetAgenda.length > 0) && (
        <div className="callout info">
          <Icon name="info" />
          <span>
            {presetHere.length > 0 && <>Padrões do Active Directory no rascunho: {labels(presetHere)}. Revise e clique em Salvar. </>}
            {presetAgenda.length > 0 && (
              <>
                {presetHere.length ? 'Também mudou na aba ' : 'Padrões do Active Directory no rascunho da aba '}
                <Link to="?tab=sincronizacao">Sincronização</Link>: {labels(presetAgenda)}. Salve por lá.
              </>
            )}
          </span>
        </div>
      )}
      <fieldset className="ldap-fieldset" disabled={!s.canEdit}>
        {CONNECTION_SECTIONS.map(([section, title]) => (
          <Fragment key={section}>
            <div className="card form">
              <h3>{title}</h3>
              {sectionIds(section).map(input)}
            </div>
            {section === 'Search' && (
              <div className="card form">
                <h3>Grupos</h3>
                {GROUP_IDS.map(input)}
              </div>
            )}
          </Fragment>
        ))}
      </fieldset>
      <div className={`ldap-actionbar ${dirty.length ? 'sticky' : ''}`}>
        <button className="btn primary" disabled={!s.canEdit || !dirty.length || saving} onClick={() => void save()}>
          {saving ? 'Salvando…' : 'Salvar'}
        </button>
        <button className="btn" disabled={!s.canEdit} onClick={applyPreset}>
          Usar padrões do Active Directory
        </button>
        <button className="btn" disabled={!s.canEdit || dirty.length > 0 || testing} title={dirty.length ? 'Salve antes de testar.' : undefined} onClick={() => void test()}>
          {testing ? 'Testando…' : 'Testar conexão'}
        </button>
        {dirty.length > 0 && (
          <>
            <span className="muted small">Salve antes de testar.</span>
            <span className="spacer" />
            <button
              className="link small"
              onClick={() => {
                s.discard(ids);
                keepElsewhere();
              }}
            >
              Descartar alterações
            </button>
          </>
        )}
      </div>
    </>
  );
}

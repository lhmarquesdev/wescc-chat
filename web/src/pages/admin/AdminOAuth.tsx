import { Fragment, useState } from 'react';
import type { OAuthFieldMap, OAuthPreset, OAuthProvider } from '@shared/index';
import { api, errorMessage } from '../../lib/api';
import { useSetting, useStore } from '../../lib/store';
import { Icon } from '../../components/Icon';
import { ProviderIcon } from '../../components/BrandIcons';
import { Empty, Field, Modal, SkeletonTable, Tabs, Toggle, confirmDialog, useAsync } from '../../components/ui';
import { ActivePill, PageHead, TableWrap } from './parts';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const ok = (t: string) => useStore.getState().toast(t);

const FIELD_LABEL: Record<keyof OAuthFieldMap, string> = {
  id: 'Identificador único',
  username: 'Nome de usuário',
  email: 'E-mail',
  name: 'Nome',
  avatar: 'Foto (URL)',
  emailVerified: 'E-mail verificado (booleano)',
};

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // http sem contexto seguro: cópia pelo campo temporário
    const t = document.createElement('textarea');
    t.value = value;
    document.body.appendChild(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  ok('Copiado.');
}

// A URL só quebra depois de cada "/" (fora do "://"), nunca no meio de um nome.
function breakAtSlashes(url: string) {
  return url.split(/(?<=\/)(?!\/)/).map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}

function CopyBox({ value }: { value: string }) {
  return (
    <div className="copy-box">
      <input readOnly value={value} onFocus={(e) => e.target.select()} />
      <button type="button" className="btn" onClick={() => void copyText(value)}>
        <Icon name="copy" />
        Copiar
      </button>
    </div>
  );
}

function ButtonPreview({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return (
    <span className="oauth-preview" style={{ background: bg, color: fg }}>
      {label || 'Entrar'}
    </span>
  );
}

export function AdminOAuth() {
  const { data, loading, reload } = useAsync(() => api.get('oauth-providers'), []);
  const presets = useAsync(() => api.get('oauth-providers.presets'), []);
  const [picking, setPicking] = useState(false);
  const [edit, setEdit] = useState<{ provider?: OAuthProvider; preset: OAuthPreset } | null>(null);
  const providers: OAuthProvider[] = data?.providers ?? [];
  const presetList: OAuthPreset[] = presets.data?.presets ?? [];
  const presetOf = (t: string) => presetList.find((p) => p.type === t) ?? presetList[presetList.length - 1];
  const newButton = (
    <button className="btn primary" disabled={!presetList.length} onClick={() => setPicking(true)}>
      <Icon name="add" />
      Novo provedor
    </button>
  );

  return (
    <>
      <PageHead title="OAuth">{providers.length > 0 && newButton}</PageHead>
      <p className="page-lead">
        Login com contas externas: Google, GitHub, GitLab, Microsoft ou qualquer servidor OAuth 2.0 / OpenID Connect. Cada provedor ativo vira um botão na tela de login, com sincronização de papéis e
        canais pelos grupos do provedor.
      </p>
      {(loading && !data) || (presets.loading && !presets.data) ? (
        <SkeletonTable rows={3} cols={4} />
      ) : !providers.length ? (
        <Empty icon="tokens" title="Nenhum provedor OAuth" action={newButton}>
          Cada provedor ativo vira um botão “Entrar com…” na tela de login.
        </Empty>
      ) : (
        <TableWrap>
          <table className="table stack kv">
            <thead>
              <tr>
                <th>Provedor</th>
                <th>ID</th>
                <th>Botão</th>
                <th>Status</th>
                <th>URL de callback</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p._id} className="clickable" onClick={() => setEdit({ provider: p, preset: presetOf(p.type) })}>
                  <td>
                    <div className="cell-entity">
                      <span className="cell-icon provider">
                        <ProviderIcon type={p.type} size={16} />
                      </span>
                      <span className="cell-name">{presetOf(p.type)?.name ?? p.type}</span>
                    </div>
                  </td>
                  {/* td.mono com o id: o E2E do OAuth espera a linha por ele. */}
                  <td className="mono muted" data-label="ID">
                    {p._id}
                  </td>
                  <td data-label="Botão">
                    <ButtonPreview label={p.label} bg={p.buttonColor} fg={p.buttonTextColor} />
                  </td>
                  <td data-label="Status">
                    <ActivePill active={p.enabled} />
                  </td>
                  <td className="oauth-callback" data-label="Callback">
                    <code className="small">{breakAtSlashes(p.callbackUrl)}</code>
                    <button className="btn small ghost" title="Copiar URL de callback" aria-label="Copiar URL de callback" onClick={(e) => (e.stopPropagation(), void copyText(p.callbackUrl))}>
                      <Icon name="copy" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {picking && (
        <Modal title="Novo provedor OAuth" onClose={() => setPicking(false)}>
          <div className="oauth-presets">
            {presetList.map((p) => (
              <button key={p.type} className="card action preset-card" onClick={() => (setPicking(false), setEdit({ preset: p }))}>
                <span className="card-icon">
                  <ProviderIcon type={p.type} size={20} />
                </span>
                <span className="preset-text">
                  <strong>{p.name}</strong>
                  <span className="muted small">{p.description}</span>
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {edit && <ProviderForm provider={edit.provider} preset={edit.preset} existingIds={providers.map((p) => p._id)} onClose={() => setEdit(null)} onSaved={reload} />}
    </>
  );
}

type TabId = 'general' | 'connection' | 'users' | 'roles' | 'channels';

const mappingText = (m: Record<string, unknown> | undefined) => (m && Object.keys(m).length ? JSON.stringify(m, null, 2) : '');

function suggestId(type: string, existing: string[]) {
  if (!existing.includes(type)) return type;
  let n = 2;
  while (existing.includes(`${type}-${n}`)) n++;
  return `${type}-${n}`;
}

function initialForm(p: OAuthProvider | undefined, preset: OAuthPreset, existing: string[]) {
  return {
    _id: p?._id ?? suggestId(preset.type, existing),
    enabled: p?.enabled ?? true,
    label: p?.label ?? preset.label,
    buttonColor: p?.buttonColor ?? preset.buttonColor,
    buttonTextColor: p?.buttonTextColor ?? preset.buttonTextColor,
    clientId: p?.clientId ?? '',
    serverUrl: p?.serverUrl ?? '',
    tenant: p?.tenant ?? '',
    authorizeUrl: p?.authorizeUrl ?? '',
    tokenUrl: p?.tokenUrl ?? '',
    identityUrl: p?.identityUrl ?? '',
    scope: p?.scope ?? '',
    tokenAuth: p?.tokenAuth ?? 'post',
    tokenSentVia: p?.tokenSentVia ?? 'header',
    accessTokenParam: p?.accessTokenParam ?? 'access_token',
    identityPath: p?.identityPath ?? '',
    fieldMap: { id: '', username: '', email: '', name: '', avatar: '', emailVerified: '', ...(p?.fieldMap ?? {}) } as OAuthFieldMap,
    mergeUsers: p?.mergeUsers ?? false,
    blockNewUsers: p?.blockNewUsers ?? false,
    rolesClaim: p?.rolesClaim ?? preset.rolesClaim,
    syncRoles: p?.syncRoles ?? false,
    mergeRoles: p?.mergeRoles ?? true,
    roleMapping: mappingText(p?.roleMapping),
    groupsClaim: p?.groupsClaim ?? preset.groupsClaim,
    mapChannels: p?.mapChannels ?? false,
    channelMapping: mappingText(p?.channelMapping),
  };
}

function parseJson(text: string, name: string) {
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {
    // cai no erro abaixo
  }
  throw new Error(`${name}: JSON inválido. Use um objeto, ex.: {"grupo": ["valor"]}.`);
}

const hex6 = (c: string) => (/^#[0-9a-f]{6}$/i.test(c) ? c : /^#[0-9a-f]{3}$/i.test(c) ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : '#000000');

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <div className="copy-box">
        <input type="color" className="color-swatch" value={hex6(value)} onChange={(e) => onChange(e.target.value)} />
        <input value={value} maxLength={7} onChange={(e) => onChange(e.target.value.trim())} />
      </div>
    </Field>
  );
}

function ProviderForm({ provider, preset, existingIds, onClose, onSaved }: { provider?: OAuthProvider; preset: OAuthPreset; existingIds: string[]; onClose: () => void; onSaved: () => void }) {
  const isNew = !provider;
  const siteUrl = String(useSetting<string>('Site_Url') || location.origin).replace(/\/+$/, '');
  const [tab, setTab] = useState<TabId>('general');
  const [f, setF] = useState(() => initialForm(provider, preset, existingIds));
  const [secret, setSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof f>) => setF((s) => ({ ...s, ...patch }));
  const id = f._id.trim().toLowerCase();
  const callback = provider?.callbackUrl ?? `${siteUrl}/oauth/${id || 'id'}/callback`;
  const secretSet = !!provider?.clientSecretSet && !clearSecret;
  const defaults = provider?.effective ?? { ...preset, fieldMap: preset.fieldMap };
  const custom = preset.type === 'custom';

  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        ...f,
        _id: undefined,
        fieldMap: Object.fromEntries(Object.entries(f.fieldMap).filter(([, v]) => v.trim())),
        roleMapping: parseJson(f.roleMapping, 'Mapa de papéis'),
        channelMapping: parseJson(f.channelMapping, 'Mapa de canais'),
      };
      if (secret) body.clientSecret = secret;
      else if (clearSecret) body.clientSecret = null;
      if (isNew) await api.post('oauth-providers', { ...body, _id: id, type: preset.type });
      else await api.put(`oauth-providers/${encodeURIComponent(provider._id)}`, body);
      ok('Provedor salvo.');
      onSaved();
      onClose();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!provider) return;
    const yes = await confirmDialog({
      title: `Excluir o provedor "${provider.label}"?`,
      body: 'As contas continuam existindo, mas não entram mais por este botão.',
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!yes) return;
    try {
      await api.del(`oauth-providers/${encodeURIComponent(provider._id)}`);
      ok('Provedor excluído.');
      onSaved();
      onClose();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <Modal
      wide
      title={
        <span className="modal-title-icon">
          <ProviderIcon type={preset.type} size={18} />
          {isNew ? `Novo provedor: ${preset.name}` : provider.label}
        </span>
      }
      onClose={onClose}
      footer={
        <>
          {!isNew && (
            <button className="btn danger" onClick={remove}>
              <Icon name="delete" />
              Excluir
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy || !id} onClick={save}>
            Salvar
          </button>
        </>
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'general', label: 'Geral' },
          { id: 'connection', label: 'Conexão e campos' },
          { id: 'users', label: 'Usuários' },
          { id: 'roles', label: 'Papéis' },
          { id: 'channels', label: 'Canais' },
        ]}
      />
      {tab === 'general' && (
        <div className="form">
          <Toggle checked={f.enabled} onChange={(v) => set({ enabled: v })} label="Ativo (mostra o botão na tela de login)" />
          <div className="two-col">
            <Field label="ID" hint={isNew ? 'Letras minúsculas, números e hífen. Faz parte da URL de callback e não pode ser alterado.' : 'Não pode ser alterado.'}>
              <input value={f._id} disabled={!isNew} maxLength={40} onChange={(e) => set({ _id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} />
            </Field>
            <Field label="Texto do botão" hint="Vazio = texto padrão do tipo.">
              <input value={f.label} maxLength={80} placeholder={preset.label} onChange={(e) => set({ label: e.target.value })} />
            </Field>
          </div>
          <div className="two-col">
            <ColorField label="Cor do botão" value={f.buttonColor} onChange={(v) => set({ buttonColor: v })} />
            <ColorField label="Cor do texto" value={f.buttonTextColor} onChange={(v) => set({ buttonTextColor: v })} />
          </div>
          <div className="oauth-preview-row">
            <span className="muted small">Prévia:</span>
            <ButtonPreview label={f.label || preset.label} bg={f.buttonColor || preset.buttonColor} fg={f.buttonTextColor || preset.buttonTextColor} />
          </div>
          <Field label="Client ID">
            <input value={f.clientId} autoComplete="off" onChange={(e) => set({ clientId: e.target.value })} />
          </Field>
          <Field
            label="Client secret"
            hint={
              secretSet
                ? 'Definido. Deixe em branco para manter o atual; ele nunca é exibido.'
                : clearSecret
                  ? 'O segredo será removido ao salvar.'
                  : 'Guardado só no servidor e nunca exibido depois de salvo.'
            }
          >
            <div className="copy-box">
              <input
                type="password"
                autoComplete="new-password"
                value={secret}
                placeholder={secretSet ? '•••••••••••• (definido)' : ''}
                onChange={(e) => (setSecret(e.target.value), setClearSecret(false))}
              />
              {provider?.clientSecretSet && (
                <button type="button" className="btn" onClick={() => (setClearSecret(!clearSecret), setSecret(''))}>
                  {clearSecret ? 'Manter' : 'Remover'}
                </button>
              )}
            </div>
          </Field>
          <Field label="URL de callback (redirect URI)" hint="Cadastre exatamente esta URL no provedor.">
            <CopyBox value={callback} />
            {siteUrl !== location.origin && (
              <span className="field-hint neg">
                A URL do site (Configurações › Geral) é {siteUrl}, diferente do endereço atual ({location.origin}). O callback usa a URL do site.
              </span>
            )}
          </Field>
        </div>
      )}
      {tab === 'connection' && (
        <div className="form">
          {!custom && <p className="muted small">Campos vazios usam os padrões do {preset.name}. Preencha só o que precisar sobrescrever.</p>}
          {!isNew && (
            <p className="muted small">
              Trocar o servidor, o diretório ou as URLs desfaz os vínculos de contas deste provedor (o mesmo id pode ser outra pessoa em outro servidor). Cada usuário volta a ser vinculado no próximo
              login, pelo e-mail confirmado, se a vinculação estiver ativa.
            </p>
          )}
          {preset.type === 'github' && (
            <Field label="URL do GitHub Enterprise Server (opcional)" hint="Vazio = github.com.">
              <input value={f.serverUrl} placeholder="https://github.com" onChange={(e) => set({ serverUrl: e.target.value })} />
            </Field>
          )}
          {preset.type === 'gitlab' && (
            <Field label="URL do GitLab" hint="Para GitLab próprio, ex.: https://gitlab.empresa.com.br. Vazio = gitlab.com.">
              <input value={f.serverUrl} placeholder="https://gitlab.com" onChange={(e) => set({ serverUrl: e.target.value })} />
            </Field>
          )}
          {preset.type === 'microsoft' && (
            <Field
              label="Tenant (diretório)"
              hint='ID do diretório (GUID) ou domínio (empresa.onmicrosoft.com). Vazio, "common" ou "organizations" aceitam contas de qualquer diretório da Microsoft: nesse caso papéis e canais não são sincronizados.'
            >
              <input value={f.tenant} placeholder="00000000-0000-0000-0000-000000000000" onChange={(e) => set({ tenant: e.target.value })} />
            </Field>
          )}
          {custom && (
            <Field label="URL base (opcional)" hint="Permite informar as URLs abaixo como caminhos, ex.: /oauth/token.">
              <input value={f.serverUrl} placeholder="https://sso.empresa.com.br" onChange={(e) => set({ serverUrl: e.target.value })} />
            </Field>
          )}
          <Field label="URL de autorização">
            <input value={f.authorizeUrl} placeholder={defaults.authorizeUrl || 'https://sso.exemplo.com/oauth/authorize'} onChange={(e) => set({ authorizeUrl: e.target.value })} />
          </Field>
          <Field label="URL do token">
            <input value={f.tokenUrl} placeholder={defaults.tokenUrl || 'https://sso.exemplo.com/oauth/token'} onChange={(e) => set({ tokenUrl: e.target.value })} />
          </Field>
          <Field label="URL de identidade (userinfo)" hint={custom ? 'Vazio com o escopo "openid" usa os dados do id_token.' : undefined}>
            <input value={f.identityUrl} placeholder={defaults.identityUrl || 'https://sso.exemplo.com/userinfo'} onChange={(e) => set({ identityUrl: e.target.value })} />
          </Field>
          <div className="two-col">
            <Field label="Escopo">
              <input value={f.scope} placeholder={preset.scope} onChange={(e) => set({ scope: e.target.value })} />
            </Field>
            <Field label="Estilo de login">
              <select value="redirect" disabled>
                <option value="redirect">Redirecionar a página</option>
              </select>
            </Field>
          </div>
          <div className="two-col">
            <Field label="Autenticação do cliente no token">
              <select value={f.tokenAuth} onChange={(e) => set({ tokenAuth: e.target.value as 'post' | 'basic' })}>
                <option value="post">No corpo (client_secret_post)</option>
                <option value="basic">Cabeçalho Basic (client_secret_basic)</option>
              </select>
            </Field>
            <Field label="Token enviado na identidade via">
              <select value={f.tokenSentVia} onChange={(e) => set({ tokenSentVia: e.target.value as 'header' | 'query' })}>
                <option value="header">Cabeçalho Authorization: Bearer</option>
                <option value="query">Parâmetro na URL</option>
              </select>
            </Field>
          </div>
          <div className={f.tokenSentVia === 'query' ? 'two-col' : undefined}>
            <Field label="Caminho da identidade (opcional)" hint="Onde está o usuário na resposta, ex.: data.user.">
              <input value={f.identityPath} onChange={(e) => set({ identityPath: e.target.value })} />
            </Field>
            {f.tokenSentVia === 'query' && (
              <Field label="Nome do parâmetro do token">
                <input value={f.accessTokenParam} onChange={(e) => set({ accessTokenParam: e.target.value })} />
              </Field>
            )}
          </div>
          <h3>Mapeamento de campos</h3>
          <p className="muted small">Caminhos com pontos na resposta de identidade (ex.: profile.email). Vazio = padrão.</p>
          <div className="two-col">
            {(Object.keys(FIELD_LABEL) as (keyof OAuthFieldMap)[]).map((k) => (
              <Field key={k} label={FIELD_LABEL[k]}>
                <input
                  className="mono"
                  value={f.fieldMap[k]}
                  placeholder={defaults.fieldMap[k] || (k === 'username' ? 'parte do e-mail antes do @' : '—')}
                  onChange={(e) => set({ fieldMap: { ...f.fieldMap, [k]: e.target.value } })}
                />
              </Field>
            ))}
          </div>
        </div>
      )}
      {tab === 'users' && (
        <div className="form">
          <Toggle checked={f.mergeUsers} onChange={(v) => set({ mergeUsers: v })} label="Vincular a contas existentes com o mesmo e-mail" />
          <p className="field-hint">
            Só vincula quando o provedor confirma o e-mail (email_verified, ou o e-mail principal verificado no GitHub) e a conta existente também tem o e-mail confirmado (Administração › Usuários ›
            E-mail verificado). A conta vinculada mantém a origem e a senha. Sem a vinculação, um e-mail que já pertence a outra conta impede o login; um nome de usuário já em uso recebe um sufixo,
            sem tocar na conta existente.
          </p>
          {preset.type === 'microsoft' && (
            <p className="field-hint">
              Microsoft: o Entra ID não envia email_verified. Para vincular contas, adicione o claim opcional xms_edov ao id_token (Registro de aplicativo › Configuração de token). Com um diretório
              específico, o e-mail do diretório vale para os domínios permitidos de Contas.
            </p>
          )}
          <Toggle checked={f.blockNewUsers} onChange={(v) => set({ blockNewUsers: v })} label="Bloquear criação de novos usuários" />
          <p className="field-hint">Com o bloqueio, só entra quem já tem conta vinculada (ou vinculável pelo e-mail).</p>
          <p className="muted small">Novos usuários seguem as regras de Contas: aprovação manual e domínios de e-mail permitidos. Usuários desativados não entram.</p>
        </div>
      )}
      {tab === 'roles' && (
        <div className="form">
          <Field label="Claim dos papéis" hint="Caminho na identidade com uma lista ou texto separado por vírgulas, ex.: roles, groups, realm_access.roles.">
            <input className="mono" value={f.rolesClaim} placeholder="roles" onChange={(e) => set({ rolesClaim: e.target.value })} />
          </Field>
          <Toggle checked={f.syncRoles} onChange={(v) => set({ syncRoles: v })} label="Sincronizar papéis a cada login" />
          <Toggle checked={f.mergeRoles} onChange={(v) => set({ mergeRoles: v })} label="Mesclar papéis (manter os que não vêm do provedor)" />
          <p className="field-hint">
            Mesclando, só os papéis gerenciados pelo provedor (os do mapa e os que ele concedeu antes) são adicionados ou removidos. Sem mesclar, os papéis do usuário passam a ser exatamente os do
            provedor.
          </p>
          <Field
            label="Mapa valor do claim → papéis (JSON)"
            hint='Obrigatório para sincronizar: só os papéis listados aqui são concedidos (valores fora do mapa são ignorados). Só papéis existentes são aplicados e "user" é sempre mantido.'
          >
            <textarea
              className="mono"
              rows={7}
              value={f.roleMapping}
              placeholder={'{\n  "chat-admins": ["admin"],\n  "suporte": ["livechat-agent"]\n}'}
              onChange={(e) => set({ roleMapping: e.target.value })}
            />
          </Field>
        </div>
      )}
      {tab === 'channels' && (
        <div className="form">
          <Toggle checked={f.mapChannels} onChange={(v) => set({ mapChannels: v })} label="Adicionar a canais conforme os grupos" />
          <Field label="Claim dos grupos" hint="Vazio = usa o claim dos papéis.">
            <input className="mono" value={f.groupsClaim} placeholder={f.rolesClaim || 'groups'} onChange={(e) => set({ groupsClaim: e.target.value })} />
          </Field>
          <Field label="Mapa grupo → canais (JSON)" hint="Canais que não existem são criados como grupos privados. O usuário é adicionado a cada login, nunca removido.">
            <textarea className="mono" rows={7} value={f.channelMapping} placeholder={'{\n  "time-dev": ["dev", "anuncios"]\n}'} onChange={(e) => set({ channelMapping: e.target.value })} />
          </Field>
        </div>
      )}
    </Modal>
  );
}

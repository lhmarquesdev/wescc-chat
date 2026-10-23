import cron from 'node-cron';
import type { Setting, SettingType } from '@shared/index';
import { config } from '../config';
import { many, query } from '../db/pool';
import { bus } from '../realtime/bus';
import { roleScope } from './permissions';

// validate devolve o texto do erro (mostrado ao administrador) ou null quando o valor serve.
type Def = Omit<Setting, '_id' | 'value'> & { default: unknown; validate?: (value: unknown) => string | null };

const defs = new Map<string, Def>();
let sorter = 0;

function add(group: string, section: string, id: string, type: SettingType, def: unknown, opts: Partial<Def> = {}) {
  defs.set(id, { group, section, type, default: def, public: false, sorter: sorter++, label: id, ...opts });
}

function validateCron(v: unknown): string | null {
  const expr = String(v ?? '').trim();
  if (!expr || cron.validate(expr)) return null;
  return 'Expressão cron inválida. Exemplo: */15 * * * * (a cada 15 minutos).';
}

// Mapas do LDAP: {"chave": "valor"} ou {"chave": ["valor", ...]}.
function validateLdapMap(v: unknown): string | null {
  let map: unknown;
  try {
    map = JSON.parse(String(v || '{}'));
  } catch {
    return 'JSON inválido.';
  }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return 'O mapa deve ser um objeto JSON, por exemplo {"GG-Operacao": ["operacao"]}.';
  for (const [k, val] of Object.entries(map)) {
    if (!k.trim()) return 'As chaves do mapa não podem ser vazias.';
    const ok = Array.isArray(val) ? val.every((x) => typeof x === 'string' && x.trim()) : typeof val === 'string' && val.trim();
    if (!ok) return `Valor inválido para a chave "${k}": use um texto ou uma lista de textos.`;
  }
  return null;
}

// ---------- Geral ----------
add('General', 'Workspace', 'Site_Name', 'string', 'Wescc Chat', { public: true, label: 'Nome do workspace' });
add('General', 'Workspace', 'Site_Url', 'string', process.env.SITE_URL ?? 'http://localhost:3000', { public: true, label: 'URL do site' });
add('General', 'Workspace', 'Language', 'string', 'pt-BR', { public: true, label: 'Idioma padrão' });
add('General', 'Workspace', 'Default_Channels', 'string', 'geral', { label: 'Canais padrão (separados por vírgula)' });
add('Layout', 'Home', 'Layout_Home_Title', 'string', 'Início', { public: true, label: 'Título da página inicial' });
add('Layout', 'Home', 'Layout_Home_Body', 'multiline', 'Bem-vindo ao chat interno.', { public: true, label: 'Conteúdo da página inicial (Markdown)' });
add('Layout', 'Custom', 'Layout_Custom_CSS', 'code', '', { public: true, label: 'CSS personalizado' });
add('Layout', 'Custom', 'Layout_Login_Terms', 'multiline', '', { public: true, label: 'Termos exibidos no login' });

// ---------- Contas ----------
add('Accounts', 'Registration', 'Accounts_RegistrationForm', 'select', 'Public', {
  public: true,
  label: 'Formulário de cadastro',
  values: [
    { key: 'Public', label: 'Público' },
    { key: 'Secret', label: 'Somente com link secreto' },
    { key: 'Disabled', label: 'Desativado' },
  ],
});
add('Accounts', 'Registration', 'Accounts_RegistrationForm_SecretURL', 'string', '', { label: 'Código do link secreto de cadastro' });
add('Accounts', 'Registration', 'Accounts_ManuallyApproveNewUsers', 'boolean', false, { label: 'Aprovar novos usuários manualmente' });
add('Accounts', 'Registration', 'Accounts_AllowedDomainsList', 'string', '', { label: 'Domínios de e-mail permitidos (vírgula)' });
add('Accounts', 'Profile', 'Accounts_AllowUserProfileChange', 'boolean', true, { public: true, label: 'Permitir alterar perfil' });
add('Accounts', 'Profile', 'Accounts_AllowUsernameChange', 'boolean', true, { public: true, label: 'Permitir alterar nome de usuário' });
add('Accounts', 'Profile', 'Accounts_AllowEmailChange', 'boolean', true, { public: true, label: 'Permitir alterar e-mail' });
add('Accounts', 'Profile', 'Accounts_AllowPasswordChange', 'boolean', true, { public: true, label: 'Permitir alterar senha' });
add('Accounts', 'Password', 'Accounts_PasswordReset', 'boolean', true, { public: true, label: 'Permitir redefinir a senha por e-mail ("Esqueci minha senha")' });
add('Accounts', 'Profile', 'Accounts_AllowUserAvatarChange', 'boolean', true, { public: true, label: 'Permitir alterar avatar' });
add('Accounts', 'Profile', 'Accounts_AvatarBlockUnauthenticatedAccess', 'boolean', true, { label: 'Avatares só para usuários logados' });
add('Accounts', 'Profile', 'Accounts_AllowDeleteOwnAccount', 'boolean', false, { public: true, label: 'Permitir excluir a própria conta' });
add('Accounts', 'Two Factor', 'Accounts_TwoFactorAuthentication_Enabled', 'boolean', true, { public: true, label: 'Autenticação em dois fatores' });
add('Accounts', 'Two Factor', 'Accounts_TwoFactorAuthentication_Enforce', 'boolean', false, { public: true, label: 'Exigir 2FA de todos os usuários' });
add('Accounts', 'Password', 'Accounts_Password_Policy_MinLength', 'int', 8, { public: true, label: 'Tamanho mínimo da senha' });
add('Accounts', 'Password', 'Accounts_Password_Policy_AtLeastOneUppercase', 'boolean', false, { public: true, label: 'Exigir letra maiúscula' });
add('Accounts', 'Password', 'Accounts_Password_Policy_AtLeastOneNumber', 'boolean', false, { public: true, label: 'Exigir número' });
add('Accounts', 'Password', 'Accounts_Password_Policy_AtLeastOneSpecialCharacter', 'boolean', false, { public: true, label: 'Exigir caractere especial' });
add('Accounts', 'Session', 'Accounts_LoginExpiration', 'int', 90, { label: 'Validade do login (dias)' });
add('Accounts', 'Session', 'Accounts_Block_Failed_Login_Attempts', 'int', 10, { label: 'Bloquear o login após N tentativas falhas (0 = nunca)' });
add('Accounts', 'Session', 'Accounts_Block_Failed_Login_Attempts_By_Ip', 'int', 50, { label: 'Bloquear o IP após N tentativas falhas (0 = nunca)' });
add('Accounts', 'Session', 'Accounts_Block_Failed_Login_Minutes', 'int', 5, { label: 'Minutos de bloqueio após tentativas falhas' });
add('Accounts', 'Presence', 'Accounts_Default_Away_Minutes', 'int', 5, { public: true, label: 'Minutos de inatividade para "ausente"' });
add('Accounts', 'Direct Messages', 'Direct_Restriction_Scope', 'select', 'any', {
  public: true,
  label: 'Bloqueio de conversas diretas entre pessoas com papel restrito',
  values: [
    { key: 'any', label: 'Entre quaisquer pessoas com papel restrito' },
    { key: 'same_role', label: 'Só entre pessoas que têm o mesmo papel restrito' },
  ],
});

// ---------- Mensagens ----------
add('Message', 'Editing', 'Message_AllowEditing', 'boolean', true, { public: true, label: 'Permitir editar mensagens' });
add('Message', 'Editing', 'Message_AllowEditing_BlockEditInMinutes', 'int', 0, { public: true, label: 'Bloquear edição após N minutos (0 = nunca)' });
add('Message', 'Editing', 'Message_AllowDeleting', 'boolean', true, { public: true, label: 'Permitir apagar mensagens' });
add('Message', 'Editing', 'Message_AllowDeleting_BlockDeleteInMinutes', 'int', 0, { public: true, label: 'Bloquear exclusão após N minutos (0 = nunca)' });
add('Message', 'Features', 'Message_AllowPinning', 'boolean', true, { public: true, label: 'Permitir fixar mensagens' });
add('Message', 'Features', 'Message_AllowStarring', 'boolean', true, { public: true, label: 'Permitir favoritar mensagens' });
add('Message', 'Features', 'Message_MaxAllowedSize', 'int', 5000, { public: true, label: 'Tamanho máximo da mensagem' });
add('Message', 'Features', 'Message_ShowEditedStatus', 'boolean', true, { public: true, label: 'Mostrar "editada"' });
add('Message', 'Features', 'Message_KeepHistory', 'boolean', true, { label: 'Manter histórico de edições' });
add('Message', 'Features', 'Threads_enabled', 'boolean', true, { public: true, label: 'Threads' });
add('Message', 'Features', 'Discussion_enabled', 'boolean', true, { public: true, label: 'Discussões' });
add('Message', 'Features', 'Message_GroupingPeriod', 'int', 300, { public: true, label: 'Agrupar mensagens do mesmo autor (segundos)' });
add('Message', 'Mentions', 'Message_MaxAll', 'int', 0, { label: 'Máximo de membros para @all (0 = sem limite)' });
add('Message', 'Read Receipts', 'Message_Read_Receipt_Enabled', 'boolean', true, { public: true, label: 'Confirmação de leitura' });
add('Message', 'Read Receipts', 'Message_Read_Receipt_Store_Users', 'boolean', true, { public: true, label: 'Guardar quem leu cada mensagem' });
add('Message', 'Bad Words', 'Message_AllowBadWordsFilter', 'boolean', false, { label: 'Filtro de palavrões' });
add('Message', 'Bad Words', 'Message_BadWordsFilterList', 'string', '', { label: 'Lista de palavras bloqueadas (vírgula)' });

// ---------- Figurinhas ----------
const intRange = (min: number, max: number) => (v: unknown) =>
  Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? null : `Use um número inteiro entre ${min} e ${max}.`;
// Ids de papéis globais separados por vírgula (um erro de digitação não pode passar calado).
const globalRoleList = (v: unknown) => {
  for (const id of String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (roleScope(id) !== 'Users') return `Papel inexistente: ${id}. Use o id do papel, como aparece em Papéis e permissões.`;
  }
  return null;
};
add('Message', 'Stickers', 'Stickers_Enabled', 'boolean', true, { public: true, label: 'Figurinhas' });
add('Message', 'Stickers', 'Stickers_Personal_Enabled', 'boolean', true, { public: true, label: 'Permitir figurinhas pessoais' });
add('Message', 'Stickers', 'Stickers_Animated_Enabled', 'boolean', true, { public: true, label: 'Permitir figurinhas animadas' });
add('Message', 'Stickers', 'Stickers_Animation_Default', 'select', 'hover', {
  public: true,
  label: 'Animação das figurinhas (padrão de quem não escolheu)',
  values: [
    { key: 'auto', label: 'Reproduzir automaticamente, por até 5 segundos' },
    { key: 'hover', label: 'Só ao passar o mouse ou tocar' },
    { key: 'never', label: 'Nunca (mostrar a imagem parada)' },
  ],
});
add('Message', 'Stickers', 'Stickers_In_Notice_Rooms', 'boolean', false, { public: true, label: 'Permitir figurinhas em canais de avisos (só publicadores)' });
add('Message', 'Stickers', 'Stickers_Max_Static_KB', 'int', 256, { public: true, label: 'Tamanho máximo da figurinha estática (KB)', validate: intRange(16, 1024) });
add('Message', 'Stickers', 'Stickers_Max_Animated_KB', 'int', 1024, { public: true, label: 'Tamanho máximo da figurinha animada (KB)', validate: intRange(64, 4096) });
add('Message', 'Stickers', 'Stickers_Max_Animated_Seconds', 'int', 10, { public: true, label: 'Duração máxima da animação (segundos)', validate: intRange(1, 30) });
add('Message', 'Stickers', 'Stickers_Personal_Max_Packs', 'int', 5, { public: true, label: 'Pacotes pessoais por pessoa', validate: intRange(1, 50) });
add('Message', 'Stickers', 'Stickers_Personal_Max_Per_Pack', 'int', 60, { public: true, label: 'Figurinhas por pacote pessoal', validate: intRange(1, 200) });
add('Message', 'Stickers', 'Stickers_Org_Max_Per_Pack', 'int', 120, { public: true, label: 'Figurinhas por pacote da organização', validate: intRange(1, 500) });
add('Message', 'Stickers', 'Stickers_Personal_Quota_MB', 'int', 20, { public: true, label: 'Espaço para figurinhas pessoais por pessoa (MB)', validate: intRange(1, 1024) });
add('Message', 'Stickers', 'Stickers_Max_Favorites', 'int', 50, { public: true, label: 'Figurinhas favoritas por pessoa', validate: intRange(1, 500) });
add('Message', 'Stickers', 'Stickers_Send_Blocked_Roles', 'string', '', {
  public: true,
  label: 'Papéis que não podem enviar figurinhas (ids separados por vírgula)',
  validate: globalRoleList,
});
add('Message', 'Stickers', 'Stickers_Removed_Keep_Days', 'int', 30, {
  label: 'Dias que a moderação guarda uma figurinha removida (0 = apagar na hora)',
  validate: intRange(0, 365),
});

// ---------- Upload ----------
add('FileUpload', 'General', 'FileUpload_Enabled', 'boolean', true, { public: true, label: 'Upload de arquivos' });
add('FileUpload', 'General', 'FileUpload_MaxFileSize', 'int', 104857600, { public: true, label: 'Tamanho máximo (bytes)' });
add('FileUpload', 'General', 'FileUpload_MediaTypeWhiteList', 'string', '', { public: true, label: 'Tipos permitidos (vírgula; vazio = todos)' });
add('FileUpload', 'General', 'FileUpload_MediaTypeBlackList', 'string', 'image/svg+xml', { public: true, label: 'Tipos bloqueados (vírgula)' });
add('FileUpload', 'General', 'FileUpload_Enabled_Direct', 'boolean', true, { public: true, label: 'Upload em mensagens diretas' });

// ---------- Retenção ----------
add('RetentionPolicy', 'Global', 'RetentionPolicy_Enabled', 'boolean', false, { public: true, label: 'Política de retenção ativa' });
add('RetentionPolicy', 'Global', 'RetentionPolicy_AppliesToChannels', 'boolean', false, { public: true, label: 'Aplicar a canais públicos' });
add('RetentionPolicy', 'Global', 'RetentionPolicy_TTL_Channels', 'int', 30, { public: true, label: 'Dias (canais públicos)' });
add('RetentionPolicy', 'Global', 'RetentionPolicy_AppliesToGroups', 'boolean', false, { public: true, label: 'Aplicar a grupos privados' });
add('RetentionPolicy', 'Global', 'RetentionPolicy_TTL_Groups', 'int', 30, { public: true, label: 'Dias (grupos privados)' });
add('RetentionPolicy', 'Global', 'RetentionPolicy_AppliesToDMs', 'boolean', false, { public: true, label: 'Aplicar a mensagens diretas' });
add('RetentionPolicy', 'Global', 'RetentionPolicy_TTL_DMs', 'int', 30, { public: true, label: 'Dias (mensagens diretas)' });
add('RetentionPolicy', 'Global', 'RetentionPolicy_DoNotPrunePinned', 'boolean', true, { public: true, label: 'Não apagar mensagens fixadas' });
add('RetentionPolicy', 'Global', 'RetentionPolicy_DoNotPruneDiscussion', 'boolean', true, { public: true, label: 'Não apagar mensagens de discussão' });
add('RetentionPolicy', 'Global', 'RetentionPolicy_DoNotPruneThreads', 'boolean', true, { public: true, label: 'Não apagar threads' });
add('RetentionPolicy', 'Global', 'RetentionPolicy_FilesOnly', 'boolean', false, { public: true, label: 'Apagar somente arquivos' });
add('RetentionPolicy', 'Global', 'RetentionPolicy_Precision', 'select', '0 * * * *', {
  label: 'Frequência da limpeza',
  values: [
    { key: '*/30 * * * *', label: 'A cada 30 minutos' },
    { key: '0 * * * *', label: 'A cada hora' },
    { key: '0 */6 * * *', label: 'A cada 6 horas' },
    { key: '0 0 * * *', label: 'Diariamente' },
  ],
});

// ---------- E-mail ----------
add('Email', 'SMTP', 'SMTP_Host', 'string', '', { label: 'Servidor SMTP' });
add('Email', 'SMTP', 'SMTP_Port', 'int', 587, { label: 'Porta' });
add('Email', 'SMTP', 'SMTP_Username', 'string', '', { label: 'Usuário' });
add('Email', 'SMTP', 'SMTP_Password', 'password', '', { label: 'Senha' });
add('Email', 'SMTP', 'From_Email', 'string', 'chat@localhost', { label: 'Remetente' });
add('Email', 'Notifications', 'Email_Notifications_Enabled', 'boolean', false, { label: 'Enviar notificações por e-mail para menções offline' });

// ---------- LDAP ----------
add('LDAP', 'Connection', 'LDAP_Enable', 'boolean', false, { public: true, label: 'Ativar LDAP' });
add('LDAP', 'Connection', 'LDAP_Url', 'string', 'ldap://localhost:389', { label: 'URL do servidor (ldap:// ou ldaps://)' });
add('LDAP', 'Connection', 'LDAP_Reject_Unauthorized', 'boolean', true, { label: 'Rejeitar certificados inválidos' });
add('LDAP', 'Connection', 'LDAP_CA_Certificate', 'multiline', '', { label: 'Certificado da autoridade certificadora (CA) do servidor, em PEM (opcional)' });
add('LDAP', 'Authentication', 'LDAP_Authentication_UserDN', 'string', '', { label: 'DN do usuário de serviço' });
add('LDAP', 'Authentication', 'LDAP_Authentication_Password', 'password', '', { label: 'Senha do usuário de serviço' });
add('LDAP', 'Search', 'LDAP_BaseDN', 'string', '', { label: 'Base DN' });
add('LDAP', 'Search', 'LDAP_User_Search_Filter', 'string', '(objectclass=*)', { label: 'Filtro de usuários' });
add('LDAP', 'Search', 'LDAP_User_Search_Field', 'string', 'sAMAccountName,uid', { label: 'Campo de busca do login' });
add('LDAP', 'Search', 'LDAP_Group_BaseDN', 'string', '', { label: 'Base DN dos grupos (vazio usa o Base DN)' });
add('LDAP', 'Data Sync', 'LDAP_Username_Field', 'string', 'sAMAccountName', { label: 'Atributo do nome de usuário' });
add('LDAP', 'Data Sync', 'LDAP_Name_Field', 'string', 'cn', { label: 'Atributo do nome' });
add('LDAP', 'Data Sync', 'LDAP_Email_Field', 'string', 'mail', { label: 'Atributo do e-mail' });
add('LDAP', 'Data Sync', 'LDAP_Unique_Identifier_Field', 'string', 'objectGUID,entryUUID', { label: 'Identificador único' });
add('LDAP', 'Data Sync', 'LDAP_Login_Fallback', 'boolean', true, { label: 'Permitir login com a senha local quando o servidor LDAP estiver fora do ar' });
add('LDAP', 'Data Sync', 'LDAP_Merge_Existing_Users', 'boolean', false, { label: 'Vincular a contas locais com o mesmo nome de usuário' });
add('LDAP', 'Data Sync', 'LDAP_Sync_Avatar', 'boolean', true, { label: 'Usar a foto do diretório como avatar' });
add('LDAP', 'Data Sync', 'LDAP_Avatar_Field', 'string', 'thumbnailPhoto,jpegPhoto', { label: 'Atributo da foto' });
add('LDAP', 'Sync', 'LDAP_Background_Sync', 'boolean', false, { label: 'Sincronização em segundo plano' });
add('LDAP', 'Sync', 'LDAP_Background_Sync_Interval', 'string', '*/15 * * * *', { label: 'Frequência (cron)', validate: validateCron });
add('LDAP', 'Sync', 'LDAP_Background_Sync_Import_New_Users', 'boolean', true, { label: 'Importar novos usuários' });
add('LDAP', 'Sync', 'LDAP_Sync_User_Active_State', 'boolean', true, { label: 'Desativar usuários removidos do LDAP' });
add('LDAP', 'Sync', 'LDAP_Sync_AD_Disabled', 'boolean', true, { label: 'Desativar contas desativadas no Active Directory (userAccountControl)' });
add('LDAP', 'Sync', 'LDAP_Sync_Reactivate_Users', 'boolean', true, { label: 'Reativar contas que voltarem ao diretório ou forem reativadas no Active Directory' });
add('LDAP', 'Sync', 'LDAP_Sync_Max_Deactivation_Percent', 'int', 50, { label: 'Não desativar ninguém se a sincronização for desativar mais que este % dos usuários do LDAP (0 = sem limite)' });
add('LDAP', 'Sync Roles', 'LDAP_Enable_Role_Mapping', 'boolean', false, { label: 'Mapear grupos e OUs para papéis' });
add('LDAP', 'Sync Roles', 'LDAP_Role_Mapping', 'code', '{}', { label: 'Mapa grupo/OU → papéis (JSON)', validate: validateLdapMap });
add('LDAP', 'Sync Roles', 'LDAP_Group_Filter', 'string', '(&(objectclass=groupOfNames)(member=#{userdn}))', { label: 'Filtro de grupos' });
add('LDAP', 'Sync Roles', 'LDAP_Group_Nested', 'boolean', false, { label: 'Incluir grupos aninhados (Active Directory)' });
add('LDAP', 'Sync Roles', 'LDAP_Default_Roles', 'string', 'user', { label: 'Papéis padrão de todo usuário do LDAP (separados por vírgula)' });
add('LDAP', 'Sync Roles', 'LDAP_Default_Roles_Skip_Restricted', 'boolean', true, { label: 'Não dar os papéis padrão a quem recebe um papel restrito em conversas diretas' });
add('LDAP', 'Sync Roles', 'LDAP_Roles_Auto_Remove', 'boolean', true, { label: 'Remover papéis mapeados de quem não está mais no grupo ou na OU' });
add('LDAP', 'Sync Channels', 'LDAP_Enable_Channel_Mapping', 'boolean', false, { label: 'Mapear grupos e OUs para canais' });
add('LDAP', 'Sync Channels', 'LDAP_Channel_Mapping', 'code', '{}', { label: 'Mapa grupo/OU → canais (JSON)', validate: validateLdapMap });
add('LDAP', 'Sync Channels', 'LDAP_Channels_Auto_Remove', 'boolean', false, { label: 'Remover dos canais mapeados quem não está mais no grupo ou na OU' });
add('LDAP', 'Sync Channels', 'LDAP_Channels_Admin', 'string', '', { label: 'Dono dos canais criados pelo mapeamento (nome de usuário; vazio = sem dono)' });
add('LDAP', 'Sync Teams', 'LDAP_Enable_Team_Mapping', 'boolean', false, { label: 'Mapear grupos e OUs para times' });
add('LDAP', 'Sync Teams', 'LDAP_Team_Mapping', 'code', '{}', { label: 'Mapa grupo/OU → times (JSON)', validate: validateLdapMap });
add('LDAP', 'Sync Teams', 'LDAP_Teams_Auto_Remove', 'boolean', false, { label: 'Remover dos times mapeados quem não está mais no grupo ou na OU' });

// ---------- SAML ----------
add('SAML', 'Provider', 'SAML_Enable', 'boolean', false, { public: true, label: 'Ativar SAML' });
add('SAML', 'Provider', 'SAML_Button_Label', 'string', 'Entrar com SSO', { public: true, label: 'Texto do botão' });
add('SAML', 'Provider', 'SAML_Entry_Point', 'string', '', { label: 'URL de entrada do IdP (SSO)' });
add('SAML', 'Provider', 'SAML_Issuer', 'string', 'wescc-chat', { label: 'Issuer (Entity ID do SP)' });
add('SAML', 'Provider', 'SAML_IdP_Cert', 'multiline', '', { label: 'Certificado do IdP (PEM)' });
add('SAML', 'Mapping', 'SAML_Username_Attribute', 'string', 'username', { label: 'Atributo do usuário' });
add('SAML', 'Mapping', 'SAML_Email_Attribute', 'string', 'email', { label: 'Atributo do e-mail' });
add('SAML', 'Mapping', 'SAML_Name_Attribute', 'string', 'cn', { label: 'Atributo do nome' });
add('SAML', 'Mapping', 'SAML_Role_Attribute', 'string', '', { label: 'Atributo dos papéis' });
add('SAML', 'Mapping', 'SAML_Role_Mapping', 'code', '{}', { label: 'Mapa valor do atributo → papéis (JSON). Vazio usa os nomes dos papéis' });
add('SAML', 'Provider', 'SAML_Want_Assertions_Signed', 'boolean', true, { label: 'Exigir asserções assinadas' });
add('SAML', 'Provider', 'SAML_Want_Response_Signed', 'boolean', false, { label: 'Exigir resposta assinada' });
add('SAML', 'Provider', 'SAML_Logout_Url', 'string', '', { label: 'URL de logout do IdP (opcional)' });
add('SAML', 'Mapping', 'SAML_Allow_New_Users', 'boolean', true, { label: 'Criar usuários no primeiro login' });
add('SAML', 'Mapping', 'SAML_Merge_By_Email', 'boolean', false, { label: 'Vincular a usuário local com o mesmo e-mail' });

// ---------- Segurança / API ----------
add('Security', 'Rate Limiter', 'API_Enable_Rate_Limiter', 'boolean', true, { label: 'Limite de requisições na API' });
add('Security', 'CORS', 'API_Enable_CORS', 'boolean', false, { label: 'Permitir chamadas à API de outros sites (CORS)' });
add('Security', 'CORS', 'API_CORS_Origin', 'string', '', { label: 'Origens permitidas, separadas por vírgula (ex.: https://intranet.empresa.com.br; * libera todas)' });
add('Security', 'Rate Limiter', 'API_Enable_Rate_Limiter_Limit_Calls_Default', 'int', 300, { label: 'Chamadas por minuto' });
add('Security', 'Device Management', 'Device_Management_Enable_Login_Emails', 'boolean', false, { label: 'Enviar e-mail em login de novo dispositivo' });
add('Security', 'Device Management', 'Device_Management_Allow_Logout_All', 'boolean', true, { public: true, label: 'Permitir encerrar todas as sessões' });
add('Security', 'E2E', 'E2E_Enable', 'boolean', false, { public: true, label: 'Criptografia ponta a ponta' });
add('Security', 'Push', 'Push_enable', 'boolean', true, { public: true, label: 'Notificações push no navegador e no app instalado' });
add('Security', 'Push', 'Push_Privacy_Hide_Content', 'boolean', false, { public: true, label: 'Ocultar conteúdo nas notificações push' });
add('Security', 'Push', 'Push_VAPID_Public_Key', 'string', '', { public: true, label: 'Chave pública VAPID (gerada automaticamente)' });
add('Security', 'Push', 'Push_VAPID_Private_Key', 'password', '', { label: 'Chave privada VAPID (gerada automaticamente)' });

// ---------- Chamadas ----------
// intRange vem do bloco das figurinhas (mesma regra e mesmo texto).
// Com a variável de ambiente definida, a configuração não vale: o segredo fica fora do banco.
const envLocked = (name: string, set: () => boolean) => (_v: unknown) =>
  set() ? `Definido no servidor pela variável ${name}. Para mudar, altere a variável e reinicie o chat.` : null;
// Só endereços deste computador ou da rede interna, escritos como IP: um nome de DNS pode apontar para qualquer lugar.
function isInternalHttpUrl(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost') return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  // A URL já normaliza o IPv6 (sem zeros à esquerda): fc00::/7 é o primeiro grupo de fc00 a fdff.
  return host === '[::1]' || /^\[f[cd][0-9a-f]{2}:[0-9a-f:.]*\]$/.test(host);
}
// O chat manda tokens e a sinalização de todos para esse endereço: só deste computador ou da rede interna.
const sfuUrlRule = (v: unknown) => envLocked('LIVEKIT_URL', () => !!config.livekit.url)(v) ?? (isInternalHttpUrl(String(v ?? ''))
  ? null
  : 'Use http:// ou https:// com um endereço deste computador ou da rede interna (por exemplo http://127.0.0.1:7880).');
add('VideoConf', 'Chamadas', 'Calls_Enabled', 'boolean', true, { public: true, label: 'Chamadas de voz e vídeo' });
add('VideoConf', 'Chamadas', 'Calls_Group_Enabled', 'boolean', true, { public: true, label: 'Chamadas em grupo em canais, grupos, times, discussões e conversas com várias pessoas' });
add('VideoConf', 'Chamadas', 'Calls_Direct_Via_SFU', 'boolean', false, { public: true, label: 'Chamadas a dois pelo servidor de chamadas (voltam sozinhas depois de quedas; se ele parar, seguem direto entre os navegadores)' });
add('VideoConf', 'Chamadas', 'Calls_In_Notice_Rooms', 'boolean', true, { public: true, label: 'Transmissões em canais de avisos e salas somente leitura (só quem publica fala)' });
add('VideoConf', 'Chamadas', 'Calls_Ring_Timeout', 'int', 40, { public: true, label: 'Segundos tocando antes de virar chamada perdida', validate: intRange(10, 120) });
add('VideoConf', 'Servidor de chamadas', 'Calls_SFU_Url', 'string', 'http://127.0.0.1:7880', { label: 'Endereço interno do LiveKit (API e sinalização)', validate: sfuUrlRule });
add('VideoConf', 'Servidor de chamadas', 'Calls_SFU_Api_Key', 'string', '', { label: 'Chave da API do LiveKit', validate: envLocked('LIVEKIT_API_KEY', () => !!config.livekit.apiKey) });
add('VideoConf', 'Servidor de chamadas', 'Calls_SFU_Api_Secret', 'password', '', { label: 'Segredo da API do LiveKit', validate: envLocked('LIVEKIT_API_SECRET_FILE', () => !!config.livekit.apiSecret) });
add('VideoConf', 'Limites', 'Calls_Max_Participants', 'int', 30, { public: true, label: 'Pessoas por chamada', validate: intRange(2, 50) });
add('VideoConf', 'Limites', 'Calls_Max_Listeners', 'int', 300, { public: true, label: 'Pessoas por transmissão', validate: intRange(2, 500) });
add('VideoConf', 'Limites', 'Calls_Max_Total_Participants', 'int', 150, { label: 'Pessoas em chamadas ao mesmo tempo neste servidor', validate: intRange(10, 1000) });
add('VideoConf', 'Limites', 'Calls_Max_Video_Publishers', 'int', 16, { public: true, label: 'Câmeras ligadas ao mesmo tempo', validate: intRange(1, 30) });
add('VideoConf', 'Limites', 'Calls_Max_Duration_Hours', 'int', 12, { label: 'Duração máxima de uma chamada (horas)', validate: intRange(1, 24) });
add('VideoConf', 'Restrições', 'Calls_Restricted_Public', 'select', 'pairs', {
  label: 'Em canais públicos, chamadas de pessoas que não podem conversar em particular',
  values: [
    { key: 'pairs', label: 'Pausar quando restarem só duas delas sem um supervisor (três ou mais seguem como conversa de equipe)' },
    { key: 'strict', label: 'Exigir um supervisor presente, como nos grupos privados' },
  ],
});
add('VideoConf', 'Restrições', 'Calls_Restricted_Grace', 'int', 30, { label: 'Segundos de espera por um supervisor antes de encerrar', validate: intRange(10, 300) });
add('VideoConf', 'Histórico', 'Calls_History_Retention_Days', 'int', 0, { label: 'Apagar o histórico de chamadas depois de (dias; 0 = manter)', validate: intRange(0, 3650) });
add('VideoConf', 'Chamada direta (P2P)', 'Calls_STUN_Servers', 'string', '', { label: 'Servidores STUN, separados por vírgula (deixe vazio na rede interna)' });
add('VideoConf', 'Chamada direta (P2P)', 'Calls_TURN_Server', 'string', '', { label: 'Servidor TURN (ex.: turn:turn.empresa.com.br:3478), para redes que bloqueiam conexão direta' });
add('VideoConf', 'Chamada direta (P2P)', 'Calls_TURN_Secret', 'password', '', { label: 'Segredo compartilhado do TURN (credenciais temporárias; substitui usuário e senha)' });
add('VideoConf', 'Chamada direta (P2P)', 'Calls_TURN_Username', 'string', '', { label: 'Usuário do TURN (sem segredo compartilhado)' });
add('VideoConf', 'Chamada direta (P2P)', 'Calls_TURN_Password', 'password', '', { label: 'Senha do TURN (sem segredo compartilhado)' });
add('VideoConf', 'Jitsi', 'VideoConf_Enabled', 'boolean', false, { public: true, label: 'Links do Jitsi com /jitsi (serviço externo)' });
add('VideoConf', 'Jitsi', 'VideoConf_Jitsi_Domain', 'string', 'meet.jit.si', { public: true, label: 'Domínio do Jitsi' });
add('VideoConf', 'Jitsi', 'VideoConf_Jitsi_Prefix', 'string', 'wescc', { public: true, label: 'Prefixo das salas' });

// ---------- Importação ----------
add('Import', 'General', 'Import_MaxFileSize', 'int', 1073741824, { label: 'Tamanho máximo do arquivo de importação (bytes)' });
add('Import', 'General', 'Import_Pending_Files_Concurrency', 'int', 3, { label: 'Downloads simultâneos de arquivos pendentes' });

// ---------- Omnichannel ----------
add('Omnichannel', 'General', 'Livechat_enabled', 'boolean', false, { public: true, label: 'Ativar Omnichannel' });
add('Omnichannel', 'Routing', 'Livechat_Routing_Method', 'select', 'Auto_Selection', {
  public: true,
  label: 'Método de roteamento',
  values: [
    { key: 'Auto_Selection', label: 'Seleção automática (próximo agente)' },
    { key: 'Load_Balancing', label: 'Balanceamento de carga (menos chats abertos)' },
    { key: 'Load_Rotation', label: 'Rodízio (quem recebeu há mais tempo)' },
    { key: 'Manual_Selection', label: 'Fila manual (agentes pegam da fila)' },
    { key: 'External', label: 'Serviço externo' },
  ],
});
add('Omnichannel', 'Routing', 'Livechat_External_Queue_URL', 'string', '', { label: 'URL do serviço externo de roteamento' });
add('Omnichannel', 'Routing', 'Livechat_External_Queue_Token', 'password', '', { label: 'Token do serviço externo' });
add('Omnichannel', 'Routing', 'Livechat_maximum_chats_per_agent', 'int', 0, { label: 'Máximo de chats simultâneos por agente (0 = ilimitado)' });
add('Omnichannel', 'Routing', 'Livechat_accept_chats_with_no_agents', 'boolean', false, { label: 'Aceitar chats sem agentes online (ficam na fila)' });
add('Omnichannel', 'Routing', 'Livechat_assign_new_conversation_to_bot', 'boolean', false, { label: 'Atribuir novas conversas a agentes bot primeiro' });
add('Omnichannel', 'Routing', 'Omnichannel_calculate_dispatch_service_queue_statistics', 'boolean', true, { label: 'Informar posição na fila ao visitante' });
add('Omnichannel', 'Queue', 'Livechat_waiting_queue', 'boolean', true, { label: 'Ativar fila de espera' });
add('Omnichannel', 'Queue', 'Livechat_waiting_queue_message', 'string', 'Todos os atendentes estão ocupados. Você é o número {position} da fila.', { public: true, label: 'Mensagem da fila ({position})' });
add('Omnichannel', 'Queue', 'Livechat_max_queue_wait_time', 'int', 0, { label: 'Tempo máximo na fila em minutos (0 = sem limite)' });
add('Omnichannel', 'Sessions', 'Livechat_auto_close_abandoned_rooms', 'int', 0, { label: 'Fechar chats abandonados pelo visitante após N segundos (0 = nunca)' });
add('Omnichannel', 'Sessions', 'Livechat_abandoned_rooms_closed_custom_message', 'string', 'Chat encerrado por inatividade.', { label: 'Mensagem ao fechar por inatividade' });
add('Omnichannel', 'Sessions', 'Livechat_auto_close_on_hold_chats_timeout', 'int', 0, { label: 'Fechar chats em espera após N segundos (0 = nunca)' });
add('Omnichannel', 'Sessions', 'Livechat_allow_manual_on_hold', 'boolean', true, { label: 'Agentes podem colocar chats em espera' });
add('Omnichannel', 'Sessions', 'Livechat_request_comment_when_closing_conversation', 'boolean', false, { public: true, label: 'Exigir comentário ao encerrar' });
add('Omnichannel', 'Sessions', 'Livechat_enable_transcript', 'boolean', true, { public: true, label: 'Permitir transcrição por e-mail' });
add('Omnichannel', 'Sessions', 'Livechat_transcript_message', 'string', 'Deseja receber a transcrição desta conversa por e-mail?', { public: true, label: 'Texto da transcrição' });
add('Omnichannel', 'Sessions', 'Livechat_show_agent_info', 'boolean', true, { public: true, label: 'Mostrar dados do agente ao visitante' });
add('Omnichannel', 'Sessions', 'Livechat_show_agent_email', 'boolean', false, { public: true, label: 'Mostrar e-mail do agente' });
add('Omnichannel', 'Sessions', 'Livechat_enable_message_character_limit', 'int', 0, { public: true, label: 'Limite de caracteres das mensagens do visitante (0 = padrão)' });
add('Omnichannel', 'Business Hours', 'Livechat_enable_business_hours', 'boolean', false, { public: true, label: 'Respeitar horário de atendimento' });
add('Omnichannel', 'Business Hours', 'Livechat_business_hour_type', 'select', 'Single', {
  label: 'Tipo de horário',
  values: [
    { key: 'Single', label: 'Único para todos' },
    { key: 'Multiple', label: 'Por departamento' },
  ],
});
add('Omnichannel', 'Widget', 'Livechat_title', 'string', 'Fale conosco', { public: true, label: 'Título do widget' });
add('Omnichannel', 'Widget', 'Livechat_title_color', 'string', '#1d74f5', { public: true, label: 'Cor do widget' });
add('Omnichannel', 'Widget', 'Livechat_offline_title', 'string', 'Deixe uma mensagem', { public: true, label: 'Título offline' });
add('Omnichannel', 'Widget', 'Livechat_offline_message', 'string', 'Estamos offline. Deixe sua mensagem.', { public: true, label: 'Mensagem offline' });
add('Omnichannel', 'Widget', 'Livechat_offline_success_message', 'string', 'Obrigado! Responderemos em breve.', { public: true, label: 'Mensagem após enviar o formulário offline' });
add('Omnichannel', 'Widget', 'Livechat_display_offline_form', 'boolean', true, { public: true, label: 'Exibir formulário offline' });
add('Omnichannel', 'Widget', 'Livechat_offline_email', 'string', '', { label: 'E-mail que recebe as mensagens offline' });
add('Omnichannel', 'Widget', 'Livechat_registration_form', 'boolean', true, { public: true, label: 'Formulário de identificação antes do chat' });
add('Omnichannel', 'Widget', 'Livechat_name_field_registration_form', 'boolean', true, { public: true, label: 'Pedir nome' });
add('Omnichannel', 'Widget', 'Livechat_email_field_registration_form', 'boolean', true, { public: true, label: 'Pedir e-mail' });
add('Omnichannel', 'Widget', 'Livechat_registration_form_message', 'string', 'Antes de começar, conte quem é você.', { public: true, label: 'Texto do formulário' });
add('Omnichannel', 'Widget', 'Livechat_conversation_finished_message', 'string', 'Conversa encerrada. Obrigado pelo contato!', { public: true, label: 'Mensagem de conversa encerrada' });
add('Omnichannel', 'Widget', 'Livechat_enable_satisfaction_survey', 'boolean', true, { public: true, label: 'Pesquisa de satisfação ao encerrar' });
add('Omnichannel', 'Widget', 'Livechat_allowed_domains', 'string', '', { label: 'Domínios onde o widget pode ser embutido (vírgula, vazio = todos)' });
add('Omnichannel', 'File Upload', 'Livechat_fileupload_enabled', 'boolean', true, { public: true, label: 'Visitantes podem enviar arquivos' });
add('Omnichannel', 'File Upload', 'Livechat_fileupload_max_total_size', 'int', 209715200, { label: 'Espaço máximo para arquivos por visitante, em bytes (0 = sem limite)' });

// ---------- Integrações ----------
add('Integrations', 'General', 'Integrations_Enabled', 'boolean', true, { label: 'Ativar integrações (webhooks)' });
add('Integrations', 'Scripts', 'Integrations_Scripts_Enabled', 'boolean', false, {
  label: 'Permitir scripts nas integrações (código JavaScript escrito por administradores)',
});
add('Integrations', 'Outgoing', 'Integrations_Outgoing_Timeout', 'int', 10, { label: 'Tempo limite das chamadas de saída (segundos)' });

const cache = new Map<string, unknown>();

export async function loadSettings() {
  cache.clear();
  const rows = await many<{ id: string; value: unknown }>('SELECT id, value FROM settings');
  for (const r of rows) cache.set(r.id, r.value);
}

export function getSetting<T = unknown>(id: string): T {
  if (cache.has(id)) return cache.get(id) as T;
  return defs.get(id)?.default as T;
}

export function setSettingCache(id: string, value: unknown) {
  cache.set(id, value);
}

export function isKnownSetting(id: string) {
  return defs.has(id);
}

// Configurações cujo valor não pode aparecer em logs nem na auditoria.
export function isSecretSetting(id: string) {
  return defs.get(id)?.type === 'password' || /Password|Secret|Token|Private_?Key/i.test(id);
}

function coerce(def: Def, value: unknown): unknown {
  switch (def.type) {
    case 'boolean':
      return value === true || value === 'true';
    case 'int': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error('invalid-int');
      return Math.trunc(n);
    }
    case 'select':
      if (def.values && !def.values.some((v) => v.key === value)) throw new Error('invalid-option');
      return String(value);
    default:
      return value == null ? '' : String(value);
  }
}

export async function updateSettings(values: Record<string, unknown>) {
  // Converte e valida tudo antes de gravar: um valor inválido não deixa a gravação pela metade.
  const accepted: [string, unknown][] = [];
  for (const [id, raw] of Object.entries(values)) {
    const def = defs.get(id);
    if (!def) continue;
    if (def.type === 'password' && raw === '********') continue;
    const value = coerce(def, raw);
    const err = def.validate?.(value);
    if (err) throw new Error(`${def.label}: ${err}`);
    accepted.push([id, value]);
  }
  const changed: { _id: string; value: unknown }[] = [];
  for (const [id, value] of accepted) {
    await query(
      `INSERT INTO settings (id, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [id, JSON.stringify(value)],
    );
    cache.set(id, value);
    changed.push({ _id: id, value });
  }
  if (changed.length) {
    bus.publishSettings(
      changed,
      changed.filter((c) => defs.get(c._id)?.public && defs.get(c._id)?.type !== 'password'),
    );
  }
  return changed;
}

export function listSettings(opts: { publicOnly?: boolean } = {}): Setting[] {
  const out: Setting[] = [];
  for (const [id, def] of defs) {
    if (opts.publicOnly && !def.public) continue;
    let value = getSetting(id);
    if (def.type === 'password' && opts.publicOnly) continue;
    if (def.type === 'password' && value) value = '********';
    const { default: _d, validate: _v, ...rest } = def;
    out.push({ _id: id, value, ...rest });
  }
  return out;
}

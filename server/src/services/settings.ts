import type { Setting, SettingType } from '@shared/index';
import { many, query } from '../db/pool';
import { bus } from '../realtime/bus';

type Def = Omit<Setting, '_id' | 'value'> & { default: unknown };

const defs = new Map<string, Def>();
let sorter = 0;

function add(group: string, section: string, id: string, type: SettingType, def: unknown, opts: Partial<Def> = {}) {
  defs.set(id, { group, section, type, default: def, public: false, sorter: sorter++, label: id, ...opts });
}

// ---------- Geral ----------
add('General', 'Workspace', 'Site_Name', 'string', 'Wescc Chat', { public: true, label: 'Nome do workspace' });
add('General', 'Workspace', 'Site_Url', 'string', 'http://localhost:3000', { public: true, label: 'URL do site' });
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
add('Accounts', 'Profile', 'Accounts_AllowUserAvatarChange', 'boolean', true, { public: true, label: 'Permitir alterar avatar' });
add('Accounts', 'Profile', 'Accounts_AllowDeleteOwnAccount', 'boolean', false, { public: true, label: 'Permitir excluir a própria conta' });
add('Accounts', 'Two Factor', 'Accounts_TwoFactorAuthentication_Enabled', 'boolean', true, { public: true, label: 'Autenticação em dois fatores' });
add('Accounts', 'Two Factor', 'Accounts_TwoFactorAuthentication_Enforce', 'boolean', false, { public: true, label: 'Exigir 2FA de todos os usuários' });
add('Accounts', 'Password', 'Accounts_Password_Policy_MinLength', 'int', 8, { public: true, label: 'Tamanho mínimo da senha' });
add('Accounts', 'Password', 'Accounts_Password_Policy_AtLeastOneUppercase', 'boolean', false, { public: true, label: 'Exigir letra maiúscula' });
add('Accounts', 'Password', 'Accounts_Password_Policy_AtLeastOneNumber', 'boolean', false, { public: true, label: 'Exigir número' });
add('Accounts', 'Password', 'Accounts_Password_Policy_AtLeastOneSpecialCharacter', 'boolean', false, { public: true, label: 'Exigir caractere especial' });
add('Accounts', 'Session', 'Accounts_LoginExpiration', 'int', 90, { label: 'Validade do login (dias)' });
add('Accounts', 'Session', 'Accounts_Block_Failed_Login_Attempts', 'int', 10, { label: 'Bloquear após N tentativas falhas (0 = nunca)' });
add('Accounts', 'Presence', 'Accounts_Default_Away_Minutes', 'int', 5, { public: true, label: 'Minutos de inatividade para "ausente"' });

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
add('LDAP', 'Authentication', 'LDAP_Authentication_UserDN', 'string', '', { label: 'DN do usuário de serviço' });
add('LDAP', 'Authentication', 'LDAP_Authentication_Password', 'password', '', { label: 'Senha do usuário de serviço' });
add('LDAP', 'Search', 'LDAP_BaseDN', 'string', '', { label: 'Base DN' });
add('LDAP', 'Search', 'LDAP_User_Search_Filter', 'string', '(objectclass=*)', { label: 'Filtro de usuários' });
add('LDAP', 'Search', 'LDAP_User_Search_Field', 'string', 'sAMAccountName,uid', { label: 'Campo de busca do login' });
add('LDAP', 'Data Sync', 'LDAP_Username_Field', 'string', 'sAMAccountName', { label: 'Atributo do nome de usuário' });
add('LDAP', 'Data Sync', 'LDAP_Name_Field', 'string', 'cn', { label: 'Atributo do nome' });
add('LDAP', 'Data Sync', 'LDAP_Email_Field', 'string', 'mail', { label: 'Atributo do e-mail' });
add('LDAP', 'Data Sync', 'LDAP_Unique_Identifier_Field', 'string', 'objectGUID,entryUUID', { label: 'Identificador único' });
add('LDAP', 'Data Sync', 'LDAP_Login_Fallback', 'boolean', true, { label: 'Permitir login local se o LDAP falhar' });
add('LDAP', 'Sync', 'LDAP_Background_Sync', 'boolean', false, { label: 'Sincronização em segundo plano' });
add('LDAP', 'Sync', 'LDAP_Background_Sync_Interval', 'string', '0 */6 * * *', { label: 'Frequência (cron)' });
add('LDAP', 'Sync', 'LDAP_Background_Sync_Import_New_Users', 'boolean', true, { label: 'Importar novos usuários' });
add('LDAP', 'Sync', 'LDAP_Sync_User_Active_State', 'boolean', true, { label: 'Desativar usuários removidos do LDAP' });
add('LDAP', 'Sync Roles', 'LDAP_Enable_Role_Mapping', 'boolean', false, { label: 'Mapear grupos para papéis' });
add('LDAP', 'Sync Roles', 'LDAP_Role_Mapping', 'code', '{}', { label: 'Mapa grupo LDAP → papéis (JSON)' });
add('LDAP', 'Sync Roles', 'LDAP_Group_Filter', 'string', '(&(objectclass=groupOfNames)(member=#{userdn}))', { label: 'Filtro de grupos' });
add('LDAP', 'Sync Channels', 'LDAP_Enable_Channel_Mapping', 'boolean', false, { label: 'Mapear grupos para canais' });
add('LDAP', 'Sync Channels', 'LDAP_Channel_Mapping', 'code', '{}', { label: 'Mapa grupo LDAP → canais (JSON)' });

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
add('Security', 'Rate Limiter', 'API_Enable_Rate_Limiter_Limit_Calls_Default', 'int', 300, { label: 'Chamadas por minuto' });
add('Security', 'Device Management', 'Device_Management_Enable_Login_Emails', 'boolean', false, { label: 'Enviar e-mail em login de novo dispositivo' });
add('Security', 'Device Management', 'Device_Management_Allow_Logout_All', 'boolean', true, { public: true, label: 'Permitir encerrar todas as sessões' });
add('Security', 'E2E', 'E2E_Enable', 'boolean', false, { public: true, label: 'Criptografia ponta a ponta' });
add('Security', 'Push', 'Push_Privacy_Hide_Content', 'boolean', false, { public: true, label: 'Ocultar conteúdo nas notificações push' });

// ---------- Vídeo ----------
add('VideoConf', 'Jitsi', 'VideoConf_Enabled', 'boolean', true, { public: true, label: 'Videoconferência' });
add('VideoConf', 'Jitsi', 'VideoConf_Jitsi_Domain', 'string', 'meet.jit.si', { public: true, label: 'Domínio do Jitsi' });
add('VideoConf', 'Jitsi', 'VideoConf_Jitsi_Prefix', 'string', 'wescc', { public: true, label: 'Prefixo das salas' });

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
  const changed: { _id: string; value: unknown }[] = [];
  for (const [id, raw] of Object.entries(values)) {
    const def = defs.get(id);
    if (!def) continue;
    if (def.type === 'password' && raw === '********') continue;
    const value = coerce(def, raw);
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
    const { default: _d, ...rest } = def;
    out.push({ _id: id, value, ...rest });
  }
  return out;
}

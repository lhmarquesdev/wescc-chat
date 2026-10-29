// Papéis e permissões (RBAC): o catálogo único de permissões do chat e as regras puras que o servidor e a tela usam
// iguais (nível por área, acesso efetivo, hierarquia de concessão, diferenças para "Revisar alterações").
//
// Uma permissão continua sendo o id que o servidor checa (ex.: create-c, edit-other-user-info). O catálogo diz, para
// cada uma, o nome em português, a descrição, os papéis que a recebem numa instalação nova e em que área da tela ela
// aparece. Cada área tem níveis cumulativos (Sem acesso → Visualizar → Gerenciar, ou os nomes que fizerem sentido na
// área) e capacidades avulsas. O seed do servidor, as rotas, a navegação da Administração e a tela leem daqui.
//
// Chave nova: entra em RBAC_KEYS e numa área. Ela nasce, numa instalação que já existe, com quem tem alguma das
// permissões de inheritsFrom ("ninguém perde"); sem inheritsFrom, com os papéis de defaults. Para uma funcionalidade
// que só o administrador deve ver até alguém liberar, use defaults: ['admin'] ("ninguém ganha").

export type RoleScope = 'Users' | 'Subscriptions';

export interface RbacKey {
  label: string;
  description?: string;
  // Papéis que recebem a permissão numa instalação nova.
  defaults: string[];
  // Numa instalação existente, a chave nova nasce com todo papel que tem alguma destas.
  inheritsFrom?: string[];
  // Nenhuma rota checa (herança do Rocket.Chat). A tela não mostra, mas o papel que já tem continua tendo ao salvar.
  legacy?: boolean;
  // Coisas de bots e integrações: ficam em "Mostrar permissões técnicas".
  technical?: boolean;
}

const A = 'admin';
const U = 'user';
const B = 'bot';
const G = 'guest';
const O = 'owner';
const M = 'moderator';
const P = 'publisher';
const OP = 'operacao';

export const RBAC_KEYS: Record<string, RbacKey> = {
  // Conversas
  'view-c-room': { label: 'Ver e entrar em canais públicos', defaults: [A, U, B, OP] },
  'create-c': { label: 'Criar canais públicos', defaults: [A, U, B] },
  'create-p': { label: 'Criar grupos privados', defaults: [A, U, B], description: 'Pessoas restritas em conversas diretas não devem ter: um grupo privado vira uma conversa particular.' },
  'join-without-join-code': { label: 'Entrar em salas sem o código', defaults: [A, B] },
  'view-d-room': { label: 'Abrir conversas diretas', defaults: [A, U, B, OP] },
  'create-d': { label: 'Iniciar conversas diretas', defaults: [A, U, B, OP] },
  'start-dm-between-restricted': {
    label: 'Conversar em particular entre pessoas restritas',
    defaults: [A],
    description: 'Exceção à regra dos papéis restritos (Operação): quem tem pode abrir conversas diretas e chamadas com outras pessoas restritas.',
  },
  'delete-own-message': { label: 'Apagar as próprias mensagens', defaults: [A, U, B, OP] },
  'view-message-read-receipts': { label: 'Ver confirmações de leitura', defaults: [A, O, M, U, OP] },
  'mention-all': { label: 'Mencionar @all', defaults: [A, O, M, U, P] },
  'mention-here': { label: 'Mencionar @here', defaults: [A, O, M, U, P] },
  'start-discussion': { label: 'Criar discussões', defaults: [A, U, G, B] },
  'start-discussion-other-user': { label: 'Criar discussões a partir de mensagens de outros', defaults: [A, U, G, B, O] },
  'create-team': { label: 'Criar times', defaults: [A, U] },
  'view-all-teams': { label: 'Ver todos os times', defaults: [A] },
  'create-personal-stickers': { label: 'Criar figurinhas pessoais', defaults: [A, U] },
  'call-management': { label: 'Fazer chamadas de voz e vídeo', defaults: [A, O, M, U] },
  'videoconf-ring-users': { label: 'Chamar pessoas para uma chamada em grupo', defaults: [A, O, M] },
  'create-calendar-meeting': { label: 'Criar reuniões na Agenda (com sala e link)', defaults: [A, U] },
  'use-jira': { label: 'Usar o Jira no chat', defaults: [A, U] },
  'create-jira-issue': { label: 'Criar issues do Jira', defaults: [A, U] },
  'start-msteams-meeting': { label: 'Marcar reuniões do Teams', defaults: [A, U] },
  'create-personal-access-tokens': { label: 'Criar tokens de acesso pessoal', defaults: [A, U], description: 'Tokens para scripts e integrações agirem em nome da pessoa.' },

  // Moderação de salas (valem nas salas onde a pessoa é dona, moderadora ou líder, ou em todas pelo papel global)
  'edit-room': { label: 'Editar nome, tópico e opções da sala', defaults: [A, O, M] },
  'edit-room-avatar': { label: 'Trocar a imagem da sala', defaults: [A, O, M] },
  'set-readonly': { label: 'Deixar a sala somente leitura', defaults: [A, O] },
  'set-react-when-readonly': { label: 'Permitir reações em sala somente leitura', defaults: [A, O] },
  'edit-room-retention-policy': { label: 'Editar a retenção da sala', defaults: [A] },
  'toggle-room-e2e-encryption': { label: 'Ligar e desligar a criptografia da sala', defaults: [O] },
  'add-user-to-joined-room': { label: 'Adicionar pessoas à sala', defaults: [A, O, M] },
  'remove-user': { label: 'Remover pessoas da sala', defaults: [A, O, M] },
  'mute-user': { label: 'Silenciar pessoas', defaults: [A, O, M] },
  'create-invite-links': { label: 'Criar links de convite', defaults: [A, O, M] },
  'view-broadcast-member-list': { label: 'Ver membros de salas de transmissão', defaults: [A, O, M] },
  'set-owner': { label: 'Definir donos da sala', defaults: [A, O] },
  'set-moderator': { label: 'Definir moderadores', defaults: [A, O] },
  'set-leader': { label: 'Definir líderes', defaults: [A, O] },
  'set-publisher': { label: 'Definir publicadores (canais de avisos)', defaults: [A, O] },
  'post-readonly': { label: 'Escrever em salas somente leitura e canais de avisos', defaults: [A, O, M, P] },
  'edit-message': { label: 'Editar mensagens de outras pessoas', defaults: [A, O, M] },
  'delete-message': { label: 'Apagar mensagens de outras pessoas', defaults: [A, O, M] },
  'force-delete-message': { label: 'Apagar mensagens sem limite de tempo', defaults: [A, O] },
  'pin-message': { label: 'Fixar mensagens', defaults: [O, M, A] },
  'moderate-call': { label: 'Moderar chamadas em grupo', defaults: [A, O, M] },
  'archive-room': { label: 'Arquivar salas', defaults: [A, O] },
  'unarchive-room': { label: 'Desarquivar salas', defaults: [A] },
  'delete-c': { label: 'Excluir canais públicos', defaults: [A, O] },
  'delete-p': { label: 'Excluir grupos privados', defaults: [A, O] },
  'delete-d': { label: 'Excluir conversas diretas', defaults: [A] },
  'clean-channel-history': { label: 'Limpar o histórico da sala', defaults: [A] },
  'edit-team': { label: 'Editar times', defaults: [A, O] },
  'delete-team': { label: 'Excluir times', defaults: [A, O] },
  'add-team-member': { label: 'Adicionar membros ao time', defaults: [A, O, M] },
  'edit-team-member': { label: 'Editar membros do time', defaults: [A, O, M] },
  'add-team-channel': { label: 'Adicionar salas ao time', defaults: [A, O, M] },
  'edit-team-channel': { label: 'Editar salas do time', defaults: [A, O, M] },
  'remove-team-channel': { label: 'Remover salas do time', defaults: [A, O, M] },
  'move-room-to-team': { label: 'Mover salas para um time', defaults: [A, O, M] },
  'create-team-channel': { label: 'Criar canais no time', defaults: [A, O] },
  'create-team-group': { label: 'Criar grupos privados no time', defaults: [A, O] },
  'view-all-team-channels': { label: 'Ver todas as salas do time', defaults: [A, O] },

  // Administração
  'view-administration': { label: 'Mostrar o item Administração no menu', defaults: [A] },
  'view-statistics': { label: 'Ver as informações do servidor', defaults: [A] },
  'view-engagement-dashboard': { label: 'Ver o painel de engajamento', defaults: [A] },
  'view-user-administration': { label: 'Ver a lista de usuários', defaults: [A] },
  'view-full-other-user-info': { label: 'Ver dados completos de outras pessoas', defaults: [A], description: 'E-mail, origem da conta e outros dados que a lista resumida não mostra.' },
  'create-user': { label: 'Criar usuários', defaults: [A] },
  'edit-other-user-info': { label: 'Editar dados e papéis de outras pessoas', defaults: [A] },
  'edit-other-user-active-status': { label: 'Ativar e desativar usuários', defaults: [A] },
  'edit-other-user-password': { label: 'Trocar a senha de outras pessoas', defaults: [A] },
  'edit-other-user-avatar': { label: 'Trocar a foto de outras pessoas', defaults: [A] },
  'edit-other-user-totp': { label: 'Redefinir o 2FA de outras pessoas', defaults: [A] },
  'logout-other-user': { label: 'Encerrar sessões de outras pessoas', defaults: [A] },
  'delete-user': { label: 'Excluir usuários', defaults: [A] },
  'assign-admin-role': { label: 'Dar o papel de Administrador', defaults: [A] },
  'view-room-administration': { label: 'Ver a administração de salas e convites', defaults: [A] },
  'add-user-to-any-c-room': { label: 'Adicionar pessoas a qualquer canal', defaults: [A] },
  'add-user-to-any-p-room': { label: 'Adicionar pessoas a qualquer grupo privado', defaults: [] },
  'view-permissions': { label: 'Ver papéis, permissões e o histórico', defaults: [A], inheritsFrom: ['access-permissions', 'manage-roles'] },
  'access-permissions': { label: 'Alterar as permissões dos papéis', defaults: [A] },
  'manage-roles': { label: 'Criar, editar e excluir papéis e dar papéis a pessoas', defaults: [A] },
  'view-device-management': { label: 'Ver dispositivos e sessões', defaults: [A] },
  'can-audit': { label: 'Auditar mensagens', defaults: [A, 'auditor'] },
  'can-audit-log': { label: 'Ver o registro de auditoria', defaults: [A, 'auditor-log'] },
  'view-moderation-console': { label: 'Ver denúncias', defaults: [A] },
  'manage-moderation-actions': { label: 'Agir em denúncias', defaults: [A] },
  'manage-integrations': { label: 'Gerenciar todas as integrações e webhooks', defaults: [A] },
  'manage-own-integrations': { label: 'Gerenciar as próprias integrações', defaults: [A] },
  'manage-jira': { label: 'Configurar o Jira', defaults: [A] },
  'manage-msteams': { label: 'Configurar o Microsoft Teams', defaults: [A] },
  'manage-oauth-apps': { label: 'Gerenciar provedores OAuth', defaults: [A] },
  'manage-emoji': { label: 'Gerenciar emojis personalizados', defaults: [A] },
  'manage-sticker-packs': { label: 'Gerenciar os pacotes de figurinhas da empresa', defaults: [A] },
  'view-import-operations': { label: 'Ver importações', defaults: [A] },
  'run-import': { label: 'Importar dados', defaults: [A] },
  'manage-calls': { label: 'Gerenciar o servidor de chamadas e as chamadas em andamento', defaults: [A] },
  'view-privileged-setting': { label: 'Ver configurações e LDAP / AD', defaults: [A] },
  'edit-privileged-setting': { label: 'Alterar configurações e LDAP / AD', defaults: [A] },
  'manage-retention-policy': { label: 'Rodar a política de retenção', defaults: [A] },


  // Técnicas (bots e integrações)
  'message-impersonate': { label: 'Enviar mensagens com outro nome e avatar', defaults: [B, 'app'], technical: true },
  'bypass-time-limit-edit-and-delete': { label: 'Editar e apagar sem limite de tempo', defaults: [B, 'app'], technical: true },

  // Sem efeito: nenhuma rota checa. Ficam no banco para não apagar nada de quem já tinha.
  'view-p-room': { label: 'Ver grupos privados', defaults: [A, U, B, G, OP], legacy: true },
  'view-joined-room': { label: 'Ver salas em que participa', defaults: [G, B, U, A, OP], legacy: true },
  'preview-c-room': { label: 'Pré-visualizar canais públicos', defaults: [A, U, OP], legacy: true },
  'view-room-members': { label: 'Ver membros de salas', defaults: [A, U, B, OP], legacy: true },
  'view-outside-room': { label: 'Ver pessoas fora das próprias salas', defaults: [A, U, B, OP], legacy: true },
  'view-other-user-channels': { label: 'Ver as salas de outras pessoas', defaults: [A], legacy: true },
  'ban-user': { label: 'Banir pessoas de salas', defaults: [A, O, M], legacy: true },
  'snippet-message': { label: 'Criar trechos de mensagem', defaults: [O, M], legacy: true },
  'send-many-messages': { label: 'Enviar muitas mensagens seguidas', defaults: [A, B, 'app'], legacy: true },
  'mention-team': { label: 'Mencionar o time', defaults: [A, U], legacy: true },
  'edit-other-user-e2ee': { label: 'Redefinir a criptografia de outras pessoas', defaults: [A], legacy: true },
  'bulk-register-user': { label: 'Cadastrar usuários em lote', defaults: [A], legacy: true },
  'access-setting-permissions': { label: 'Alterar permissões de configurações', defaults: [A], legacy: true },
  'manage-selected-settings': { label: 'Alterar configurações escolhidas', defaults: [A], legacy: true },
  'view-logs': { label: 'Ver logs do servidor', defaults: [A], legacy: true },
  'manage-apps': { label: 'Gerenciar apps', defaults: [A], legacy: true },
  'manage-sounds': { label: 'Gerenciar sons personalizados', defaults: [A], legacy: true },
  'manage-email-inbox': { label: 'Gerenciar caixas de e-mail', defaults: [A], legacy: true },
};

// ---------- Áreas da tela ----------

export interface RbacLevel {
  label: string;
  keys: string[];
}

export interface RbacArea {
  id: string;
  label: string;
  description: string;
  // Níveis cumulativos depois de "Sem acesso": o segundo inclui o primeiro, e assim por diante.
  levels: RbacLevel[];
  // Capacidades avulsas da área (ligam e desligam uma a uma).
  extras: string[];
  // Seção da Administração que a área libera (o item do menu aparece com o primeiro nível).
  adminSection?: string;
}

export interface RbacGroup {
  id: string;
  label: string;
  description: string;
  areas: RbacArea[];
}

const VIEW = 'Visualizar';
const MANAGE = 'Gerenciar';

export const RBAC_GROUPS: RbacGroup[] = [
  {
    id: 'chat',
    label: 'Conversas',
    description: 'O que a pessoa faz no dia a dia do chat.',
    areas: [
      {
        id: 'channels',
        label: 'Canais e grupos',
        description: 'Entrar em canais públicos e abrir canais e grupos novos.',
        levels: [
          { label: 'Participar', keys: ['view-c-room'] },
          { label: 'Participar e criar', keys: ['create-c', 'create-p'] },
        ],
        extras: ['join-without-join-code'],
      },
      {
        id: 'direct',
        label: 'Conversas diretas',
        description: 'Mensagens em particular. Papéis restritos (Operação) só conversam com quem não é restrito.',
        levels: [{ label: 'Conversar', keys: ['view-d-room', 'create-d'] }],
        extras: ['start-dm-between-restricted'],
      },
      {
        id: 'messages',
        label: 'Mensagens',
        description: 'O que a pessoa faz com as próprias mensagens e menções.',
        levels: [],
        extras: ['delete-own-message', 'view-message-read-receipts', 'mention-here', 'mention-all'],
      },
      { id: 'discussions', label: 'Discussões', description: 'Conversas derivadas de uma sala ou mensagem.', levels: [], extras: ['start-discussion', 'start-discussion-other-user'] },
      { id: 'teams', label: 'Times', description: 'Times agrupam salas e pessoas.', levels: [{ label: 'Criar times', keys: ['create-team'] }], extras: ['view-all-teams'] },
      { id: 'calls', label: 'Chamadas', description: 'Voz e vídeo em conversas diretas e salas.', levels: [{ label: 'Fazer chamadas', keys: ['call-management'] }], extras: ['videoconf-ring-users'] },
      { id: 'calendar', label: 'Agenda', description: 'Reuniões com sala no chat e link para convidados.', levels: [{ label: 'Criar reuniões', keys: ['create-calendar-meeting'] }], extras: [] },
      { id: 'stickers', label: 'Figurinhas', description: 'Figurinhas pessoais (as da empresa ficam em Administração).', levels: [{ label: 'Criar figurinhas', keys: ['create-personal-stickers'] }], extras: [] },
      {
        id: 'work-tools',
        label: 'Jira e Teams',
        description: 'Uso das integrações nas conversas (a configuração fica em Administração).',
        levels: [],
        extras: ['use-jira', 'create-jira-issue', 'start-msteams-meeting'],
      },
      { id: 'tokens', label: 'Tokens de acesso', description: 'Tokens pessoais para scripts e integrações.', levels: [], extras: ['create-personal-access-tokens'] },
    ],
  },
  {
    id: 'room',
    label: 'Moderação de salas',
    description: 'Num papel de sala (Dono, Moderador, Líder) vale só nas salas onde a pessoa tem o papel. Num papel global vale em todas as salas.',
    areas: [
      {
        id: 'room-settings',
        label: 'Configurar a sala',
        description: 'Nome, tópico, imagem, somente leitura e criptografia.',
        levels: [{ label: MANAGE, keys: ['edit-room', 'edit-room-avatar'] }],
        extras: ['set-readonly', 'set-react-when-readonly', 'edit-room-retention-policy', 'toggle-room-e2e-encryption'],
      },
      {
        id: 'room-members',
        label: 'Membros da sala',
        description: 'Quem entra, sai ou fica em silêncio.',
        levels: [{ label: MANAGE, keys: ['add-user-to-joined-room', 'remove-user', 'mute-user'] }],
        extras: ['create-invite-links', 'view-broadcast-member-list'],
      },
      { id: 'room-roles', label: 'Papéis na sala', description: 'Dar e tirar Dono, Moderador, Líder e Publicador.', levels: [], extras: ['set-owner', 'set-moderator', 'set-leader', 'set-publisher'] },
      {
        id: 'room-messages',
        label: 'Mensagens da sala',
        description: 'Moderar mensagens de outras pessoas e publicar em canais de avisos.',
        levels: [{ label: 'Moderar', keys: ['edit-message', 'delete-message', 'pin-message'] }],
        extras: ['post-readonly', 'force-delete-message', 'moderate-call'],
      },
      {
        id: 'room-lifecycle',
        label: 'Arquivar e excluir',
        description: 'Ações que tiram a sala de uso.',
        levels: [],
        extras: ['archive-room', 'unarchive-room', 'delete-c', 'delete-p', 'delete-d', 'clean-channel-history'],
      },
      {
        id: 'team-admin',
        label: 'Gestão do time',
        description: 'Membros e salas de um time.',
        levels: [{ label: MANAGE, keys: ['add-team-member', 'edit-team-member', 'add-team-channel', 'edit-team-channel', 'remove-team-channel'] }],
        extras: ['edit-team', 'delete-team', 'move-room-to-team', 'create-team-channel', 'create-team-group', 'view-all-team-channels'],
      },
    ],
  },
  {
    id: 'admin',
    label: 'Administração',
    description: 'Cada área é uma seção da Administração. Visualizar mostra a seção; Gerenciar deixa alterar.',
    areas: [
      { id: 'admin-info', label: 'Informações', description: 'Versão, uso e saúde do servidor.', levels: [{ label: VIEW, keys: ['view-statistics'] }], extras: ['view-administration'], adminSection: 'info' },
      { id: 'admin-engagement', label: 'Engajamento', description: 'Painel de uso do chat.', levels: [{ label: VIEW, keys: ['view-engagement-dashboard'] }], extras: [], adminSection: 'engagement' },
      {
        id: 'admin-users',
        label: 'Usuários',
        description: 'Contas, papéis e acesso das pessoas.',
        levels: [
          { label: VIEW, keys: ['view-user-administration'] },
          { label: MANAGE, keys: ['create-user', 'edit-other-user-info', 'edit-other-user-active-status'] },
        ],
        extras: ['view-full-other-user-info', 'edit-other-user-password', 'edit-other-user-avatar', 'edit-other-user-totp', 'logout-other-user', 'delete-user', 'assign-admin-role'],
        adminSection: 'users',
      },
      {
        id: 'admin-rooms',
        label: 'Salas e convites',
        description: 'Todas as salas do chat e os links de convite.',
        levels: [{ label: VIEW, keys: ['view-room-administration'] }],
        extras: ['add-user-to-any-c-room', 'add-user-to-any-p-room'],
        adminSection: 'rooms',
      },
      {
        id: 'admin-permissions',
        label: 'Papéis e permissões',
        description: 'Esta tela. Quem gerencia só dá ou tira o que ele mesmo tem.',
        levels: [
          { label: VIEW, keys: ['view-permissions'] },
          { label: MANAGE, keys: ['access-permissions', 'manage-roles'] },
        ],
        extras: [],
        adminSection: 'permissions',
      },
      { id: 'admin-devices', label: 'Dispositivos', description: 'Sessões abertas de cada pessoa.', levels: [{ label: VIEW, keys: ['view-device-management'] }], extras: [], adminSection: 'devices' },
      { id: 'admin-audit', label: 'Auditoria', description: 'Buscar mensagens e ver quem fez o quê.', levels: [], extras: ['can-audit', 'can-audit-log'], adminSection: 'audit' },
      {
        id: 'admin-moderation',
        label: 'Moderação',
        description: 'Denúncias de mensagens e figurinhas.',
        levels: [
          { label: VIEW, keys: ['view-moderation-console'] },
          { label: MANAGE, keys: ['manage-moderation-actions'] },
        ],
        extras: [],
        adminSection: 'moderation',
      },
      {
        id: 'admin-integrations',
        label: 'Integrações',
        description: 'Jira, Microsoft Teams, webhooks e bots.',
        levels: [{ label: MANAGE, keys: ['manage-integrations'] }],
        extras: ['manage-own-integrations', 'manage-jira', 'manage-msteams'],
        adminSection: 'integrations',
      },
      { id: 'admin-oauth', label: 'OAuth', description: 'Login com provedores externos.', levels: [{ label: MANAGE, keys: ['manage-oauth-apps'] }], extras: [], adminSection: 'oauth' },
      { id: 'admin-emoji', label: 'Emojis', description: 'Emojis personalizados.', levels: [{ label: MANAGE, keys: ['manage-emoji'] }], extras: [], adminSection: 'emoji' },
      { id: 'admin-stickers', label: 'Figurinhas da empresa', description: 'Pacotes oficiais de figurinhas.', levels: [{ label: MANAGE, keys: ['manage-sticker-packs'] }], extras: [], adminSection: 'stickers' },
      {
        id: 'admin-import',
        label: 'Importação',
        description: 'Trazer dados do Slack, CSV e outras fontes.',
        levels: [
          { label: VIEW, keys: ['view-import-operations'] },
          { label: MANAGE, keys: ['run-import'] },
        ],
        extras: [],
        adminSection: 'import',
      },
      { id: 'admin-calls', label: 'Chamadas', description: 'Servidor de chamadas e chamadas em andamento.', levels: [{ label: MANAGE, keys: ['manage-calls'] }], extras: [], adminSection: 'calls' },
      {
        id: 'admin-settings',
        label: 'Configurações e LDAP / AD',
        description: 'Configurações do chat e a sincronização com o AD.',
        levels: [
          { label: VIEW, keys: ['view-privileged-setting'] },
          { label: MANAGE, keys: ['edit-privileged-setting'] },
        ],
        extras: ['manage-retention-policy'],
        adminSection: 'settings',
      },
    ],
  },
  {
    id: 'technical',
    label: 'Técnicas',
    description: 'Para bots e integrações. Pessoas normalmente não precisam.',
    areas: [{ id: 'bots', label: 'Bots e integrações', description: 'Comportamentos que só fazem sentido para robôs.', levels: [], extras: ['message-impersonate', 'bypass-time-limit-edit-and-delete'] }],
  },
];

export const RBAC_AREAS: RbacArea[] = RBAC_GROUPS.flatMap((g) => g.areas);
export const AREA_GROUP: Record<string, string> = Object.fromEntries(RBAC_GROUPS.flatMap((g) => g.areas.map((a) => [a.id, g.id])));
export const KEY_AREA: Record<string, string> = Object.fromEntries(RBAC_AREAS.flatMap((a) => [...a.levels.flatMap((l) => l.keys), ...a.extras].map((k) => [k, a.id])));
// Permissões que a tela mostra (o resto é legado ou de outro sistema e fica preservado ao salvar).
export const VISIBLE_KEYS: string[] = Object.keys(KEY_AREA);

export const rbacLabel = (key: string) => RBAC_KEYS[key]?.label ?? key;

// ---------- Nível de uma área ----------

export type AreaLevel = { kind: 'none' } | { kind: 'level'; index: number } | { kind: 'custom' };

// Nível exato (todas as chaves dos níveis até ele e nenhuma acima); o resto é "Personalizado".
export function areaLevel(area: RbacArea, held: Set<string> | string[]): AreaLevel {
  const has = held instanceof Set ? held : new Set(held);
  const n = area.levels.map((l) => l.keys.filter((k) => has.has(k)).length);
  if (n.every((x) => x === 0)) return { kind: 'none' };
  let top = -1;
  for (let i = 0; i < area.levels.length; i++) if (n[i] > 0) top = i;
  for (let i = 0; i <= top; i++) if (n[i] !== area.levels[i].keys.length) return { kind: 'custom' };
  return { kind: 'level', index: top };
}

// Liga o nível (index -1 = Sem acesso): tira todas as chaves dos níveis e põe as dos níveis até o escolhido.
export function withAreaLevel(area: RbacArea, keys: Set<string>, index: number): Set<string> {
  const out = new Set(keys);
  area.levels.forEach((l, i) => l.keys.forEach((k) => (i <= index ? out.add(k) : out.delete(k))));
  return out;
}

// ---------- Hierarquia de concessão ----------

export interface RoleInfo {
  id: string;
  scope: RoleScope;
  protected: boolean;
  root: boolean;
  permissions: string[];
  delegable: string[];
}

export interface GrantContext {
  userId: string;
  root: boolean;
  held: string[];
  ownRoles: string[];
  delegated: string[];
}

export function grantContextFor(userId: string, ownRoles: string[], roles: RoleInfo[]): GrantContext {
  const byId = new Map(roles.map((r) => [r.id, r]));
  const mine = ownRoles.map((r) => byId.get(r)).filter((r): r is RoleInfo => !!r && r.scope === 'Users');
  const root = mine.some((r) => r.root);
  const held = new Set(mine.flatMap((r) => r.permissions));
  const delegated = new Set(mine.flatMap((r) => r.delegable).filter((id) => !byId.get(id)?.root));
  return { userId, root, held: [...held].sort(), ownRoles: mine.map((r) => r.id), delegated: [...delegated].sort() };
}

const fits = (ctx: GrantContext, keys: string[]) => {
  const held = new Set(ctx.held);
  return keys.every((k) => held.has(k));
};

export type LockReason = 'root-only' | 'superior' | 'own-role' | 'protected' | null;

// Papel gerenciável: não é o de administrador e cabe no que o ator tem, ou foi delegado a um papel dele.
export function roleLock(ctx: GrantContext, role: RoleInfo): LockReason {
  if (ctx.root) return null;
  if (role.root) return 'root-only';
  if (fits(ctx, role.permissions) || ctx.delegated.includes(role.id)) return null;
  return 'superior';
}

// Excluir pede caber no que o ator tem (delegação não basta) e não ser um papel do próprio ator.
export function roleDeleteLock(ctx: GrantContext, role: RoleInfo): LockReason {
  if (role.protected || role.root) return 'protected';
  if (ctx.root) return null;
  if (ctx.ownRoles.includes(role.id)) return 'own-role';
  return fits(ctx, role.permissions) ? null : 'superior';
}

// Chaves que o ator não pode mexer: dá ou tira só o que ele mesmo tem.
export function keysNotHeld(ctx: GrantContext, before: Iterable<string>, after: Iterable<string>): string[] {
  if (ctx.root) return [];
  const b = new Set(before);
  const a = new Set(after);
  const held = new Set(ctx.held);
  const changed = [...[...a].filter((k) => !b.has(k)), ...[...b].filter((k) => !a.has(k))];
  return [...new Set(changed.filter((k) => !held.has(k)))].sort();
}

// Pessoa gerenciável: todos os papéis globais dela são gerenciáveis pelo ator.
export function userLock(ctx: GrantContext, targetId: string, targetRoles: string[], roles: RoleInfo[]): LockReason | 'self' {
  if (ctx.root) return null;
  if (targetId === ctx.userId) return 'self';
  const byId = new Map(roles.map((r) => [r.id, r]));
  for (const id of targetRoles) {
    const r = byId.get(id);
    if (!r || r.scope !== 'Users') continue;
    const lock = roleLock(ctx, r);
    if (lock) return lock;
  }
  return null;
}

export const LOCK_TEXT: Record<Exclude<LockReason, null> | 'self', string> = {
  'root-only': 'Só um administrador mexe no papel Administrador.',
  superior: 'Este papel dá permissões que você não tem.',
  'own-role': 'Você tem este papel: peça a outra pessoa para excluí-lo.',
  protected: 'Papel do sistema: não pode ser excluído.',
  self: 'Você não pode alterar os próprios papéis.',
};

// ---------- Acesso efetivo ----------

export interface EffectiveArea {
  area: string;
  level: AreaLevel;
  keys: { key: string; via: string[] }[];
}

// União das permissões dos papéis globais, com a origem de cada uma ("via Supervisor").
export function effectiveAccess(userRoles: string[], roles: RoleInfo[]): EffectiveArea[] {
  const via = new Map<string, string[]>();
  for (const r of roles) {
    if (r.scope !== 'Users' || !userRoles.includes(r.id)) continue;
    for (const k of r.permissions) via.set(k, [...(via.get(k) ?? []), r.id]);
  }
  const held = new Set(via.keys());
  return RBAC_AREAS.map((a) => {
    const keys = [...a.levels.flatMap((l) => l.keys), ...a.extras].filter((k) => held.has(k)).map((key) => ({ key, via: via.get(key)! }));
    return { area: a.id, level: areaLevel(a, held), keys };
  }).filter((e) => e.keys.length);
}

// ---------- Revisar alterações ----------

export interface AreaChange {
  area: string;
  group: string;
  before: AreaLevel;
  after: AreaLevel;
  added: string[];
  removed: string[];
  // Ampliou, reduziu ou mexeu dos dois lados.
  direction: 'up' | 'down' | 'mixed';
}

export function diffPermissions(before: Iterable<string>, after: Iterable<string>): { areas: AreaChange[]; other: { added: string[]; removed: string[] } } {
  const b = new Set(before);
  const a = new Set(after);
  const areas: AreaChange[] = [];
  for (const area of RBAC_AREAS) {
    const keys = [...area.levels.flatMap((l) => l.keys), ...area.extras];
    const added = keys.filter((k) => a.has(k) && !b.has(k));
    const removed = keys.filter((k) => b.has(k) && !a.has(k));
    if (!added.length && !removed.length) continue;
    areas.push({ area: area.id, group: AREA_GROUP[area.id], before: areaLevel(area, b), after: areaLevel(area, a), added, removed, direction: added.length && removed.length ? 'mixed' : added.length ? 'up' : 'down' });
  }
  const inArea = new Set(VISIBLE_KEYS);
  return {
    areas,
    other: { added: [...a].filter((k) => !b.has(k) && !inArea.has(k)).sort(), removed: [...b].filter((k) => !a.has(k) && !inArea.has(k)).sort() },
  };
}

export function levelText(area: RbacArea, l: AreaLevel) {
  return l.kind === 'none' ? 'Sem acesso' : l.kind === 'custom' ? 'Personalizado' : area.levels[l.index].label;
}

// ---------- Nascimento de chaves novas ----------

// Para cada chave do catálogo que ainda não existe no banco: os papéis que a recebem. Herança encadeada (a mãe também
// é nova) usa o resultado da mãe. Papéis inexistentes ficam de fora.
export function planNewKeys(existing: Map<string, string[]>, roleIds: string[], fresh: boolean): Map<string, string[]> {
  const known = new Set(roleIds);
  const plan = new Map<string, string[]>();
  const rolesOf = (k: string): string[] => existing.get(k) ?? plan.get(k) ?? resolve(k);
  const resolve = (k: string): string[] => {
    if (existing.has(k)) return existing.get(k)!;
    if (plan.has(k)) return plan.get(k)!;
    const def = RBAC_KEYS[k];
    plan.set(k, []); // corta ciclos
    const parents = fresh ? undefined : def.inheritsFrom;
    const out = parents ? [...new Set(parents.flatMap((p) => (RBAC_KEYS[p] || existing.has(p) ? rolesOf(p) : [])))] : def.defaults;
    const roles = out.filter((r) => known.has(r));
    plan.set(k, roles);
    return roles;
  };
  for (const k of Object.keys(RBAC_KEYS)) if (!existing.has(k)) resolve(k);
  return plan;
}

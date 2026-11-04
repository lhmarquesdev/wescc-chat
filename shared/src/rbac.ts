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

import { foldMatches, foldText } from './search';

export type RoleScope = 'Users' | 'Subscriptions';

export interface RbacKey {
  label: string;
  // Obrigatória em toda chave visível (teste): o que a pessoa consegue fazer, em uma frase, terminando com ponto.
  description?: string;
  // Papéis que recebem a permissão numa instalação nova.
  defaults: string[];
  // Numa instalação existente, a chave nova nasce com todo papel que tem alguma destas.
  inheritsFrom?: string[];
  // Nenhuma rota checa (herança do Rocket.Chat). A tela não mostra, mas o papel que já tem continua tendo ao salvar.
  legacy?: boolean;
  // Coisas de bots e integrações: ficam em "Mostrar permissões técnicas".
  technical?: boolean;
  // Chave que dá poder sobre outras pessoas, sobre dados ou sobre o próprio RBAC: a tela marca "Sensível" e a revisão
  // avisa. O texto é o risco em uma frase, terminando com ponto.
  sensitive?: string;
  // Também é checada com os papéis da sala (Dono, Moderador…): vale só nas salas onde a pessoa tem o papel. As chaves
  // do grupo "room" já são de sala; esta marca é para as de outros grupos.
  room?: boolean;
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
  'view-c-room': { label: 'Ver e entrar em canais públicos', defaults: [A, U, B, OP], description: 'Ver a lista de canais públicos, ler e entrar neles.' },
  'create-c': { label: 'Criar canais públicos', defaults: [A, U, B], description: 'Abrir canais novos que qualquer pessoa pode achar e entrar.' },
  'create-p': { label: 'Criar grupos privados', defaults: [A, U, B], description: 'Abrir grupos que só os convidados veem. Pessoas restritas (Operação) não devem ter: um grupo privado vira uma conversa particular.' },
  'join-without-join-code': { label: 'Entrar em salas sem o código', defaults: [A, B], description: 'Entrar em canais protegidos por código sem digitar o código.' },
  'view-d-room': { label: 'Abrir conversas diretas', defaults: [A, U, B, OP], description: 'Ver as próprias conversas diretas e procurar pessoas para conversar.' },
  'create-d': { label: 'Iniciar conversas diretas', defaults: [A, U, B, OP], description: 'Começar uma conversa direta nova com outra pessoa.' },
  'start-dm-between-restricted': {
    label: 'Conversar em particular entre pessoas restritas',
    defaults: [A],
    description: 'Exceção à regra dos papéis restritos (Operação): quem tem pode abrir conversas diretas e chamadas com outras pessoas restritas.',
    sensitive: 'Fura a regra da Operação: pessoas restritas passam a conversar em particular.',
  },
  'delete-own-message': { label: 'Apagar as próprias mensagens', defaults: [A, U, B, OP], description: 'Apagar o que a própria pessoa escreveu, dentro do prazo das configurações.', room: true },
  'view-message-read-receipts': { label: 'Ver confirmações de leitura', defaults: [A, O, M, U, OP], description: 'Ver quem já leu cada mensagem.', room: true },
  'mention-all': { label: 'Mencionar @all', defaults: [A, O, M, U, P], description: 'Avisar todos os membros da sala com @all, mesmo quem está offline.', room: true },
  'mention-here': { label: 'Mencionar @here', defaults: [A, O, M, U, P], description: 'Avisar quem está online na sala com @here.', room: true },
  // Mensagens: encaminhar (regra global; valem as regras de envio de cada destino), enquetes e envio agendado (na sala)
  'forward-message': {
    label: 'Encaminhar mensagens',
    defaults: [A, U, OP],
    description: 'Mandar uma mensagem que a pessoa lê para outras conversas, com os arquivos. Valem as regras de envio de cada destino.',
  },
  'create-poll': { label: 'Criar enquetes', defaults: [A, U, O, M, P], description: 'Em canais, grupos e conversas diretas. Votar não depende desta permissão.', room: true },
  'schedule-message': {
    label: 'Agendar o envio de mensagens',
    defaults: [A, U, O, M, P],
    description: 'A mensagem sai no horário escolhido, em nome da pessoa, se ela ainda puder escrever na sala.',
    room: true,
  },
  // Tradução de mensagens: só leitura (não publica nada na sala); regra global, os papéis da sala não mudam nada.
  'auto-translate': {
    label: 'Traduzir mensagens',
    defaults: [A, U, OP],
    description: 'Pelo servidor de tradução da empresa. A tradução também precisa estar ligada em Configurações.',
  },
  'start-discussion': { label: 'Criar discussões', defaults: [A, U, G, B], description: 'Abrir uma discussão (sala derivada) a partir de uma sala.', room: true },
  'start-discussion-other-user': { label: 'Criar discussões a partir de mensagens de outros', defaults: [A, U, G, B, O], description: 'Abrir uma discussão a partir da mensagem de outra pessoa.', room: true },
  'create-team': { label: 'Criar times', defaults: [A, U], description: 'Criar times, que juntam salas e pessoas.' },
  'view-all-teams': { label: 'Ver todos os times', defaults: [A], description: 'Ver e abrir todos os times, inclusive os privados de que não participa.' },
  'create-personal-stickers': { label: 'Criar figurinhas pessoais', defaults: [A, U], description: 'Criar e guardar figurinhas para uso próprio.' },
  'call-management': { label: 'Fazer chamadas de voz e vídeo', defaults: [A, O, M, U], description: 'Começar chamadas de voz e vídeo em conversas diretas e salas.', room: true },
  'videoconf-ring-users': { label: 'Chamar pessoas para uma chamada em grupo', defaults: [A, O, M], description: 'Fazer tocar o aviso de chamada para os membros ao começar uma chamada em grupo.', room: true },
  'create-calendar-meeting': { label: 'Criar reuniões na Agenda (com sala e link)', defaults: [A, U], description: 'Marcar reuniões na Agenda com sala de chamada e link para convidados.' },
  'use-jira': { label: 'Usar o Jira no chat', defaults: [A, U], description: 'Buscar, ver, comentar e compartilhar issues do Jira nas conversas.' },
  'create-jira-issue': { label: 'Criar issues do Jira', defaults: [A, U], description: 'Abrir issues novas no Jira a partir do chat.' },
  'create-personal-access-tokens': { label: 'Criar tokens de acesso pessoal', defaults: [A, U], description: 'Tokens para scripts e integrações agirem em nome da pessoa.' },

  // Moderação de salas (valem nas salas onde a pessoa é dona, moderadora ou líder, ou em todas pelo papel global)
  'edit-room': { label: 'Editar nome, tópico e opções da sala', defaults: [A, O, M], description: 'Mudar nome, tópico, descrição, anúncio, tipo e código de entrada da sala.' },
  'edit-room-avatar': { label: 'Trocar a imagem da sala', defaults: [A, O, M], description: 'Trocar a imagem da sala.' },
  'set-readonly': { label: 'Deixar a sala somente leitura', defaults: [A, O], description: 'Tornar a sala somente leitura, canal de avisos (com "Ciente") ou de transmissão.' },
  'set-react-when-readonly': { label: 'Permitir reações em sala somente leitura', defaults: [A, O], description: 'Deixar quem só lê reagir às mensagens.' },
  'edit-room-retention-policy': { label: 'Editar a retenção da sala', defaults: [A], description: 'Definir por quanto tempo a sala guarda mensagens e arquivos.' },
  'toggle-room-e2e-encryption': {
    label: 'Ligar e desligar a criptografia de ponta a ponta',
    defaults: [O],
    description: 'Vale em grupos privados. Em conversas diretas, qualquer participante pode ligar.',
  },
  'add-user-to-joined-room': { label: 'Adicionar pessoas à sala', defaults: [A, O, M], description: 'Colocar pessoas nas salas de que participa.' },
  'remove-user': { label: 'Remover pessoas da sala', defaults: [A, O, M], description: 'Tirar pessoas da sala.' },
  'mute-user': { label: 'Silenciar pessoas', defaults: [A, O, M], description: 'Impedir uma pessoa de escrever na sala.' },
  'create-invite-links': { label: 'Criar links de convite', defaults: [A, O, M], description: 'Gerar links que trazem pessoas para a sala.' },
  'view-broadcast-member-list': { label: 'Ver membros de salas de transmissão', defaults: [A, O, M], description: 'Ver quem está numa sala de transmissão (os outros não veem a lista).' },
  'set-owner': { label: 'Definir donos da sala', defaults: [A, O], description: 'Dar e tirar o papel Dono na sala.' },
  'set-moderator': { label: 'Definir moderadores', defaults: [A, O], description: 'Dar e tirar o papel Moderador e os papéis de sala criados aqui.' },
  'set-leader': { label: 'Definir líderes', defaults: [A, O], description: 'Dar e tirar o papel Líder na sala.' },
  'set-publisher': { label: 'Definir publicadores (canais de avisos)', defaults: [A, O], description: 'Escolher quem escreve num canal de avisos ou numa sala somente leitura.' },
  'post-readonly': { label: 'Escrever em salas somente leitura e canais de avisos', defaults: [A, O, M, P], description: 'Escrever em salas somente leitura e em canais de avisos.' },
  'edit-message': { label: 'Editar mensagens de outras pessoas', defaults: [A, O, M], description: 'Corrigir mensagens de outras pessoas.' },
  'delete-message': { label: 'Apagar mensagens de outras pessoas', defaults: [A, O, M], description: 'Apagar mensagens de outras pessoas, de qualquer data.' },
  'force-delete-message': { label: 'Apagar mensagens sem limite de tempo', defaults: [A, O], description: 'Apagar qualquer mensagem da sala, sem o prazo das configurações.' },
  'pin-message': { label: 'Fixar mensagens', defaults: [O, M, A], description: 'Fixar e desafixar mensagens no topo da sala.' },
  'moderate-call': { label: 'Moderar chamadas em grupo', defaults: [A, O, M], description: 'Controlar as chamadas em grupo da sala como o anfitrião.' },
  'archive-room': { label: 'Arquivar salas', defaults: [A, O], description: 'Arquivar a sala: ninguém escreve e o histórico continua visível.' },
  'unarchive-room': { label: 'Desarquivar salas', defaults: [A], description: 'Trazer de volta uma sala arquivada.' },
  'delete-c': { label: 'Excluir canais públicos', defaults: [A, O], description: 'Excluir um canal público com todas as mensagens.', sensitive: 'Apaga a sala e todas as mensagens dela, sem volta.' },
  'delete-p': { label: 'Excluir grupos privados', defaults: [A, O], description: 'Excluir um grupo privado com todas as mensagens.', sensitive: 'Apaga a sala e todas as mensagens dela, sem volta.' },
  'delete-d': { label: 'Excluir conversas diretas', defaults: [A], description: 'Excluir uma conversa direta com todas as mensagens.', sensitive: 'Apaga a conversa e todas as mensagens dela, sem volta.' },
  'clean-channel-history': { label: 'Limpar o histórico da sala', defaults: [A], description: 'Apagar de uma vez as mensagens de um período da sala.', sensitive: 'Apaga mensagens em massa, sem volta.' },
  // Exportar mensagens: só lê (não publica nada na sala); numa DM, só quem tem a permissão por um papel global.
  'export-room-messages': {
    label: 'Exportar as mensagens da sala',
    defaults: [A, O],
    description: 'Baixar as mensagens de um período em HTML, CSV ou JSON, com ou sem os arquivos; cada exportação fica registrada na auditoria.',
  },
  'edit-team': { label: 'Editar times', defaults: [A, O], description: 'Mudar o nome e as opções do time.' },
  'delete-team': { label: 'Excluir times', defaults: [A, O], description: 'Excluir o time.' },
  'add-team-member': { label: 'Adicionar membros ao time', defaults: [A, O, M], description: 'Colocar pessoas no time.' },
  'edit-team-member': { label: 'Editar membros do time', defaults: [A, O, M], description: 'Tirar outras pessoas do time.' },
  'add-team-channel': { label: 'Adicionar salas ao time', defaults: [A, O, M], description: 'Colocar salas que já existem no time.' },
  'edit-team-channel': { label: 'Editar salas do time', defaults: [A, O, M], description: 'Marcar quais salas do time as pessoas entram automaticamente.' },
  'remove-team-channel': { label: 'Remover salas do time', defaults: [A, O, M], description: 'Tirar salas do time (a sala continua existindo).' },
  'move-room-to-team': { label: 'Mover salas para um time', defaults: [A, O, M], description: 'Levar para dentro de um time uma sala que a pessoa modera.' },
  'create-team-channel': { label: 'Criar canais no time', defaults: [A, O], description: 'Criar canais públicos dentro do time.' },
  'create-team-group': { label: 'Criar grupos privados no time', defaults: [A, O], description: 'Criar grupos privados dentro do time.' },
  'view-all-team-channels': { label: 'Ver todas as salas do time', defaults: [A, O], description: 'Ver todas as salas do time, inclusive as privadas de que não participa.' },

  // Administração
  'view-administration': { label: 'Mostrar o item Administração no menu', defaults: [A], description: 'Mostra o item Administração no menu. As seções dependem das outras permissões.' },
  'view-statistics': { label: 'Ver as informações do servidor', defaults: [A], description: 'Abrir Administração › Informações: versão, uso e saúde do servidor.' },
  'view-engagement-dashboard': { label: 'Ver o painel de engajamento', defaults: [A], description: 'Ver gráficos de uso: pessoas ativas, mensagens e salas mais usadas.' },
  'view-user-administration': { label: 'Ver a lista de usuários', defaults: [A], description: 'Abrir a lista de usuários e o acesso efetivo de cada pessoa.' },
  'view-full-other-user-info': { label: 'Ver dados completos de outras pessoas', defaults: [A], description: 'E-mail, origem da conta e outros dados que a lista resumida não mostra.', sensitive: 'Mostra e-mails e dados pessoais de todo mundo.' },
  'create-user': { label: 'Criar usuários', defaults: [A], description: 'Cadastrar contas e escolher o papel inicial (só os que você pode dar).' },
  'edit-other-user-info': { label: 'Editar dados de outras pessoas', defaults: [A], description: 'Nome, usuário, e-mail e bio de quem você gerencia.' },
  'edit-other-user-active-status': { label: 'Ativar e desativar usuários', defaults: [A], description: 'Desativar contas (a pessoa não entra mais) e reativá-las.' },
  'edit-other-user-password': { label: 'Trocar a senha de outras pessoas', defaults: [A], description: 'Definir uma senha nova para outra pessoa.', sensitive: 'Quem troca a senha consegue entrar na conta da pessoa.' },
  'edit-other-user-avatar': { label: 'Trocar a foto de outras pessoas', defaults: [A], description: 'Trocar ou tirar a foto de outra pessoa.' },
  'edit-other-user-totp': { label: 'Redefinir o 2FA de outras pessoas', defaults: [A], description: 'Desligar a verificação em duas etapas de quem perdeu o celular.', sensitive: 'Tira uma proteção da conta de outra pessoa.' },
  'edit-other-user-e2ee': {
    label: 'Redefinir a criptografia de outras pessoas',
    defaults: [A],
    description: 'Apaga as chaves da pessoa e encerra as sessões dela.',
    sensitive: 'A pessoa perde o acesso às mensagens criptografadas antigas.',
  },
  'logout-other-user': { label: 'Encerrar sessões de outras pessoas', defaults: [A], description: 'Tirar a pessoa do chat em todos os dispositivos.' },
  'delete-user': { label: 'Excluir usuários', defaults: [A], description: 'Apagar a conta. As mensagens continuam nas conversas.', sensitive: 'Apaga contas, sem volta.' },
  'assign-roles': {
    label: 'Dar e tirar papéis de pessoas',
    defaults: [A],
    // Até aqui, as três davam papéis a pessoas: numa instalação existente quem tinha alguma continua dando.
    inheritsFrom: ['edit-other-user-info', 'access-permissions', 'manage-roles'],
    description: 'Só papéis que cabem no que você tem, ou que o administrador delegou ao seu papel.',
    sensitive: 'Muda o que outras pessoas podem fazer no chat.',
  },
  'assign-admin-role': { label: 'Dar o papel de Administrador', defaults: [A], description: 'Dar ou tirar o papel Administrador.', sensitive: 'Dá o controle de todo o chat.' },
  'view-room-administration': { label: 'Ver a administração de salas e convites', defaults: [A], description: 'Ver todas as salas e os convites, e marcar canais padrão e em destaque.' },
  'add-user-to-any-c-room': { label: 'Adicionar pessoas a qualquer canal', defaults: [A], description: 'Colocar pessoas em qualquer canal público, mesmo sem participar dele.' },
  'add-user-to-any-p-room': { label: 'Adicionar pessoas a qualquer grupo privado', defaults: [A], description: 'Colocar pessoas em qualquer grupo privado, mesmo sem participar dele.', sensitive: 'Dá acesso a conversas privadas de outras pessoas.' },
  'view-permissions': { label: 'Ver papéis, permissões e o histórico', defaults: [A], inheritsFrom: ['access-permissions', 'manage-roles'], description: 'Ver papéis, a matriz, "Quem pode…?" e o histórico, sem alterar.' },
  'access-permissions': { label: 'Alterar as permissões dos papéis', defaults: [A], description: 'Ligar e desligar permissões nos papéis (só as que você tem).', sensitive: 'Muda o que cada papel pode fazer.' },
  'manage-roles': { label: 'Criar, editar e excluir papéis', defaults: [A], description: 'Nome, escopo, 2FA e restrição. Mexer nas permissões pede Alterar as permissões dos papéis.', sensitive: 'Cria papéis novos e exclui os vazios.' },
  'view-device-management': { label: 'Ver dispositivos e sessões', defaults: [A], description: 'Ver os dispositivos e as sessões abertas de todas as pessoas.' },
  'can-audit': { label: 'Auditar mensagens', defaults: [A, 'auditor'], description: 'Buscar mensagens de qualquer sala ou conversa direta. Cada busca fica registrada.', sensitive: 'Lê mensagens de qualquer conversa, inclusive as diretas.' },
  'can-audit-log': { label: 'Ver o registro de auditoria', defaults: [A, 'auditor-log'], description: 'Ver o registro de auditoria: quem fez o quê na administração.' },
  'view-moderation-console': { label: 'Ver denúncias', defaults: [A], description: 'Ver as denúncias de mensagens e de pessoas.' },
  'manage-moderation-actions': { label: 'Agir em denúncias', defaults: [A], description: 'Arquivar denúncias e apagar as mensagens denunciadas.' },
  'manage-integrations': { label: 'Gerenciar todas as integrações e webhooks', defaults: [A], description: 'Criar e alterar qualquer webhook ou bot, de qualquer pessoa.', sensitive: 'Webhooks e bots leem e mandam mensagens pelo chat.' },
  'manage-own-integrations': { label: 'Gerenciar as próprias integrações', defaults: [A], description: 'Criar e alterar só os webhooks que a própria pessoa criou.' },
  'manage-jira': { label: 'Configurar o Jira', defaults: [A], description: 'Ligar o Jira, definir as regras e as salas que recebem avisos.' },
  'manage-oauth-apps': { label: 'Gerenciar provedores OAuth', defaults: [A], description: 'Configurar o login com Google, Microsoft e outros provedores.', sensitive: 'Muda como as pessoas entram no chat.' },
  'manage-emoji': { label: 'Gerenciar emojis personalizados', defaults: [A], description: 'Adicionar e apagar emojis personalizados.' },
  'manage-sticker-packs': { label: 'Gerenciar os pacotes de figurinhas da empresa', defaults: [A], description: 'Criar e organizar os pacotes oficiais de figurinhas.' },
  'manage-user-status': { label: 'Gerenciar status personalizados', defaults: [A], description: 'Criar, editar e excluir os status que as pessoas escolhem no menu.' },
  'view-import-operations': { label: 'Ver importações', defaults: [A], description: 'Ver as importações já feitas e o resultado delas.' },
  'run-import': { label: 'Importar dados', defaults: [A], description: 'Trazer usuários, salas e mensagens do Slack, de CSV e de outras fontes.', sensitive: 'Cria contas e mensagens em massa.' },
  'manage-calls': { label: 'Gerenciar o servidor de chamadas e as chamadas em andamento', defaults: [A], description: 'Configurar o servidor de chamadas e encerrar chamadas em andamento.' },
  'view-privileged-setting': { label: 'Ver configurações e LDAP / AD', defaults: [A], description: 'Ver as configurações do chat e o estado da sincronização com o AD.' },
  'edit-privileged-setting': { label: 'Alterar configurações e LDAP / AD', defaults: [A], description: 'Mudar as configurações do chat e rodar a sincronização com o AD.', sensitive: 'Muda regras de todo o chat, inclusive login e senhas.' },
  'manage-retention-policy': { label: 'Rodar a política de retenção', defaults: [A], description: 'Rodar agora a limpeza de mensagens antigas de todas as salas.', sensitive: 'Apaga mensagens antigas de todas as salas.' },

  // Arquivos (aba Arquivos: pastas compartilhadas; o acesso a cada pasta é dado na própria pasta)
  'view-files': { label: 'Usar a aba Arquivos', defaults: [A, U, OP], description: 'Mostra as pastas compartilhadas com a pessoa. Cada pasta ainda diz quem vê, quem edita e quem gerencia.' },
  'create-files-folder': { label: 'Criar pastas principais em Arquivos', defaults: [A], description: 'Quem cria a pasta passa a gerenciá-la. Subpastas dependem só da permissão de editar a pasta de cima.' },
  'manage-all-files': { label: 'Gerenciar todas as pastas e arquivos', defaults: [A], description: 'Vê e altera qualquer pasta, mesmo fora do compartilhamento, e esvazia a lixeira de todos.' },


  // Técnicas (bots e integrações)
  'message-impersonate': { label: 'Enviar mensagens com outro nome e avatar', defaults: [B, 'app'], technical: true, description: 'Mandar mensagens com outro nome e outra foto. Feito para bots.', sensitive: 'Permite se passar por outra pessoa.', room: true },
  'bypass-time-limit-edit-and-delete': { label: 'Editar e apagar sem limite de tempo', defaults: [B, 'app'], technical: true, description: 'Editar e apagar as próprias mensagens depois do prazo. Feito para bots.', room: true },

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
        extras: ['delete-own-message', 'view-message-read-receipts', 'mention-here', 'mention-all', 'forward-message', 'create-poll', 'schedule-message', 'auto-translate'],
      },
      { id: 'discussions', label: 'Discussões', description: 'Conversas derivadas de uma sala ou mensagem.', levels: [], extras: ['start-discussion', 'start-discussion-other-user'] },
      { id: 'teams', label: 'Times', description: 'Times agrupam salas e pessoas.', levels: [{ label: 'Criar times', keys: ['create-team'] }], extras: ['view-all-teams'] },
      { id: 'calls', label: 'Chamadas', description: 'Voz e vídeo em conversas diretas e salas.', levels: [{ label: 'Fazer chamadas', keys: ['call-management'] }], extras: ['videoconf-ring-users'] },
      { id: 'calendar', label: 'Agenda', description: 'Reuniões com sala no chat e link para convidados.', levels: [{ label: 'Criar reuniões', keys: ['create-calendar-meeting'] }], extras: [] },
      { id: 'stickers', label: 'Figurinhas', description: 'Figurinhas pessoais (as da empresa ficam em Administração).', levels: [{ label: 'Criar figurinhas', keys: ['create-personal-stickers'] }], extras: [] },
      {
        id: 'work-tools',
        label: 'Jira',
        description: 'Uso das integrações nas conversas (a configuração fica em Administração).',
        levels: [],
        extras: ['use-jira', 'create-jira-issue'],
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
        extras: ['post-readonly', 'force-delete-message', 'moderate-call', 'export-room-messages'],
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
        extras: ['assign-roles', 'assign-admin-role', 'view-full-other-user-info', 'edit-other-user-password', 'edit-other-user-avatar', 'edit-other-user-totp', 'logout-other-user', 'delete-user', 'edit-other-user-e2ee'],
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
        description: 'Jira, webhooks e bots.',
        levels: [{ label: MANAGE, keys: ['manage-integrations'] }],
        extras: ['manage-own-integrations', 'manage-jira'],
        adminSection: 'integrations',
      },
      { id: 'admin-oauth', label: 'OAuth', description: 'Login com provedores externos.', levels: [{ label: MANAGE, keys: ['manage-oauth-apps'] }], extras: [], adminSection: 'oauth' },
      { id: 'admin-emoji', label: 'Emojis', description: 'Emojis personalizados.', levels: [{ label: MANAGE, keys: ['manage-emoji'] }], extras: [], adminSection: 'emoji' },
      {
        id: 'admin-user-status',
        label: 'Status do usuário',
        description: 'Status personalizados que as pessoas escolhem no menu.',
        levels: [{ label: MANAGE, keys: ['manage-user-status'] }],
        extras: [],
        adminSection: 'user-status',
      },
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
  // Arquivos (bloco próprio)
  {
    id: 'files',
    label: 'Arquivos',
    description: 'A aba Arquivos. Quem vê, edita ou gerencia cada pasta é definido no compartilhamento da própria pasta.',
    areas: [
      {
        id: 'files',
        label: 'Pastas e arquivos',
        description: 'Usar a aba e criar pastas principais. Gerenciar todas passa por cima do compartilhamento de cada pasta.',
        levels: [
          { label: 'Usar', keys: ['view-files'] },
          { label: 'Usar e criar pastas', keys: ['create-files-folder'] },
        ],
        extras: ['manage-all-files'],
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

// O papel raiz nunca perde estas (sem elas ninguém administraria papéis nem daria papéis). Servidor e tela leem daqui.
export const ROOT_KEEP = ['view-permissions', 'access-permissions', 'manage-roles', 'assign-roles'];

// Checada também com os papéis da sala: num papel de sala ela vale (nas salas onde a pessoa tem o papel).
export const isRoomChecked = (key: string) => AREA_GROUP[KEY_AREA[key]] === 'room' || !!RBAC_KEYS[key]?.room;
export const isSensitive = (key: string) => !!RBAC_KEYS[key]?.sensitive;

// Normaliza para busca (sem acento, minúsculas). Usada por "Quem pode…?", matriz e editor.
export const searchText = foldText;

// A chave aparece na busca pelo nome, pela descrição, pelo id e pelo nome da área e do grupo.
export function keyMatches(key: string, term: string): boolean {
  if (!term.trim()) return true;
  const def = RBAC_KEYS[key];
  const area = RBAC_AREAS.find((a) => a.id === KEY_AREA[key]);
  const group = RBAC_GROUPS.find((g) => g.id === AREA_GROUP[KEY_AREA[key]]);
  return foldMatches([def?.label ?? '', def?.description ?? '', key, area?.label ?? '', group?.label ?? ''].join(' '), term);
}

// ---------- Para que serve e modelos ----------

// Para que serve cada papel do sistema (a tela mostra quando roles.purpose está vazio).
export const ROLE_PURPOSE: Record<string, string> = {
  admin: 'Controle de todo o chat. Passa por todas as travas de concessão.',
  user: 'Quem usa o chat no dia a dia.',
  bot: 'Contas de robôs e integrações.',
  app: 'Apps internos do chat.',
  guest: 'Visitantes, com o mínimo de acesso.',
  anonymous: 'Quem lê sem entrar, quando liberado.',
  auditor: 'Busca mensagens para auditoria.',
  'auditor-log': 'Vê o registro de auditoria.',
  owner: 'Configura e modera a sala.',
  moderator: 'Modera mensagens e membros da sala.',
  leader: 'Aparece no topo da sala como referência.',
  publisher: 'Escreve em canais de avisos e salas somente leitura.',
};

export interface RbacTemplate {
  // Sugestão de identificador.
  id: string;
  label: string;
  // Vira o "Para que serve".
  description: string;
  scope: RoleScope;
  mandatory2fa: boolean;
  restrictDirect: boolean;
  keys: string[];
  // Só aplicado quando quem cria é o administrador e o papel existe.
  delegable?: string[];
}

const opKeys = () => Object.entries(RBAC_KEYS).filter(([, d]) => d.defaults.includes(OP) && !d.legacy).map(([k]) => k);
const CHAT_BASIC = ['view-c-room', 'view-d-room', 'create-d', 'delete-own-message', 'view-message-read-receipts'];

// Pontos de partida para papéis de operação. Ninguém ganha nada só por existir um modelo: ao criar, o papel leva só o
// que quem cria tem (templatePlan) e depois se ajusta no editor como qualquer outro.
export const RBAC_TEMPLATES: RbacTemplate[] = [
  {
    id: 'operador',
    label: 'Operador',
    description: 'Lê canais, conversa em particular só com quem não é restrito e não abre salas.',
    scope: 'Users',
    mandatory2fa: false,
    restrictDirect: true,
    keys: opKeys(),
  },
  {
    id: 'supervisor-operacao',
    label: 'Supervisor de operação',
    description: 'Cuida da equipe de operação: cadastra, ativa e desativa pessoas, dá o papel Operação, publica avisos e modera mensagens.',
    scope: 'Users',
    mandatory2fa: true,
    restrictDirect: false,
    delegable: ['operacao'],
    keys: [
      ...CHAT_BASIC,
      'create-c',
      'create-p',
      'mention-here',
      'mention-all',
      'start-discussion',
      'call-management',
      'videoconf-ring-users',
      'create-calendar-meeting',
      'post-readonly',
      'pin-message',
      'mute-user',
      'delete-message',
      'set-publisher',
      'view-user-administration',
      'create-user',
      'edit-other-user-info',
      'edit-other-user-active-status',
      'edit-other-user-password',
      'edit-other-user-totp',
      'logout-other-user',
      'assign-roles',
      'view-permissions',
      'view-device-management',
    ],
  },
  {
    id: 'auditor-mensagens',
    label: 'Auditor',
    description: 'Busca mensagens de qualquer conversa e vê o registro de auditoria. Não altera nada.',
    scope: 'Users',
    mandatory2fa: true,
    restrictDirect: false,
    keys: [...CHAT_BASIC, 'can-audit', 'can-audit-log', 'view-user-administration', 'view-permissions'],
  },
  {
    id: 'moderador-conteudo',
    label: 'Moderador de conteúdo',
    description: 'Cuida das denúncias e modera mensagens e chamadas em todas as salas.',
    scope: 'Users',
    mandatory2fa: false,
    restrictDirect: false,
    keys: [...CHAT_BASIC, 'view-moderation-console', 'manage-moderation-actions', 'edit-message', 'delete-message', 'pin-message', 'mute-user', 'remove-user', 'moderate-call', 'view-broadcast-member-list'],
  },
  {
    id: 'gestor-pessoas',
    label: 'Gestor de pessoas',
    description: 'Cadastra contas, mantém os dados em dia e dá os papéis que lhe foram delegados.',
    scope: 'Users',
    mandatory2fa: true,
    restrictDirect: false,
    keys: ['view-user-administration', 'view-full-other-user-info', 'create-user', 'edit-other-user-info', 'edit-other-user-active-status', 'edit-other-user-avatar', 'logout-other-user', 'assign-roles', 'view-permissions'],
  },
];

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

// ---------- Gravar só o que mudou ----------

// Aplica o que a tela mudou (base → draft) sobre o estado atual: mudanças de outra pessoa em outras chaves ficam.
export function applyDelta(current: Iterable<string>, base: Iterable<string>, draft: Iterable<string>): string[] {
  const b = new Set(base);
  const d = new Set(draft);
  const added = [...d].filter((k) => !b.has(k));
  const removed = new Set([...b].filter((k) => !d.has(k)));
  return [...new Set([...[...current].filter((k) => !removed.has(k)), ...added])].sort();
}

// Chaves sensíveis que entram (after − before), na ordem do catálogo.
export function sensitiveAdded(before: Iterable<string>, after: Iterable<string>): string[] {
  const b = new Set(before);
  const a = new Set(after);
  return Object.keys(RBAC_KEYS).filter((k) => RBAC_KEYS[k].sensitive && a.has(k) && !b.has(k));
}

// ---------- Quem pode…? ----------

// Papéis que dão a chave: globais; de sala (só se a chave é checada na sala); e de sala sem efeito.
export function whoCanRoles(key: string, roles: RoleInfo[]): { global: string[]; room: string[]; inert: string[] } {
  const holders = roles.filter((r) => r.permissions.includes(key));
  const roomChecked = isRoomChecked(key);
  const sub = holders.filter((r) => r.scope === 'Subscriptions').map((r) => r.id);
  return {
    global: holders.filter((r) => r.scope === 'Users').map((r) => r.id),
    room: roomChecked ? sub : [],
    inert: roomChecked ? [] : sub,
  };
}

// ---------- Modelos ----------

// O que o modelo leva para quem cria: só o que o ator tem (raiz leva tudo); a delegação só para o raiz e só papéis
// que existem e são globais, não raiz.
export function templatePlan(t: RbacTemplate, ctx: GrantContext, roles: RoleInfo[]): { keys: string[]; stripped: string[]; delegable: string[]; delegationSkipped: string[] } {
  const held = new Set(ctx.held);
  const keys = t.keys.filter((k) => ctx.root || held.has(k));
  const stripped = t.keys.filter((k) => !keys.includes(k));
  const byId = new Map(roles.map((r) => [r.id, r]));
  const valid = (t.delegable ?? []).filter((id) => {
    const r = byId.get(id);
    return !!r && r.scope === 'Users' && !r.root;
  });
  return ctx.root ? { keys, stripped, delegable: valid, delegationSkipped: [] } : { keys, stripped, delegable: [], delegationSkipped: valid };
}

// ---------- Nome de papel ----------

// Um papel criado não pode se passar por outro (o Administrador, sobretudo). O identificador começa e termina com letra
// ou número; nem ele (sem maiúsculas, acentos, espaços e pontuação: "admin.", "Admin " e "ad-min" viram "admin") nem o
// nome de exibição (a descrição curta, ver roleDisplayName) repetem os de outro papel ou os dos papéis padrão.
export const ROLE_NAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9 _.-]*[a-zA-Z0-9])?$/;
export const foldRoleName = (s: string) => foldText(s).replace(/[^a-z0-9]/g, '');

export interface RoleNameProblem {
  code: 'error-invalid-role-name' | 'RBAC_RESERVED_ROLE_NAME' | 'error-duplicate-role-names-not-allowed' | 'RBAC_DUPLICATE_ROLE_LABEL';
  error: string;
}

// id: o identificador (num papel novo, conferido inteiro; ao editar, só o nome de exibição muda). roles: os papéis que
// existem, com a descrição. builtin: os nomes dos papéis padrão (ROLE_LABEL), que valem mesmo se a linha sumir.
export function roleNameProblem(
  id: string,
  description: string | null | undefined,
  roles: { id: string; description?: string | null }[],
  builtin: Record<string, string>,
  opts: { isNew: boolean; displayName: (id: string, description?: string | null) => string },
): RoleNameProblem | null {
  const others = roles.filter((r) => r.id !== id);
  if (opts.isNew) {
    if (!ROLE_NAME_RE.test(id)) return { code: 'error-invalid-role-name', error: 'Use letras, números, espaço, ponto, hífen ou _, começando e terminando com letra ou número.' };
    const f = foldRoleName(id);
    if (f === 'admin' || f === foldRoleName(builtin.admin ?? 'Administrador')) return { code: 'RBAC_RESERVED_ROLE_NAME', error: 'O nome admin é reservado.' };
    const ids = new Set([...Object.keys(builtin), ...others.map((r) => r.id)].map(foldRoleName));
    if (ids.has(f)) return { code: 'error-duplicate-role-names-not-allowed', error: 'Já existe um papel com esse nome.' };
  }
  if (builtin[id]) return null;
  const shown = foldRoleName(opts.displayName(id, description));
  const taken = new Set<string>();
  for (const [k, label] of Object.entries(builtin)) taken.add(foldRoleName(k)).add(foldRoleName(label));
  for (const r of others) taken.add(foldRoleName(r.id)).add(foldRoleName(opts.displayName(r.id, r.description)));
  if (shown && taken.has(shown)) return { code: 'RBAC_DUPLICATE_ROLE_LABEL', error: `Já existe um papel que aparece como “${opts.displayName(id, description)}”. Escolha outro nome de exibição.` };
  return null;
}

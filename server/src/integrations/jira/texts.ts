// Frases dos avisos, dos resumos e das respostas do Jira (puro). Toda a cópia do Jira no servidor fica aqui.
import { JIRA_EVENT_LABEL, type JiraEventKind, type JiraIssueSnapshot } from '@shared/integrations';
import type { NormalizedJiraEvent } from './events';

// "A", "A e B", "A, B e C".
export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
}

// Corte com reticências, contando pontos de código (emoji inteiro).
export function cut(s: string, max: number): string {
  const chars = [...s.replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : chars.join('');
}

export const issueLink = (s: { key: string; url: string }) => `[${s.key}](${s.url})`;
export const resumo = (s: { summary: string }) => cut(s.summary, 120);
const bold = (s: string) => `**${s}**`;

// {campos}: até 3 rótulos; mais que isso, "{n} campos".
export function fieldsText(labels: string[]): string {
  const uniq = [...new Set(labels)];
  return uniq.length > 3 ? `${uniq.length} campos` : joinList(uniq);
}

const change = (ev: NormalizedJiraEvent, field: string) => ev.changes.find((c) => c.field === field || c.label === field);

interface Parts {
  issue: string; // [OPS-1](url), ou só a chave (excluída)
  actor: string | null; // **Nome**
  ev: NormalizedJiraEvent;
  snap: JiraIssueSnapshot;
  mention?: string | null; // @usuario do responsável (§4.5, passo 8)
}

function assignedTarget(p: Parts): { self: boolean; none: boolean; name: string } {
  const to = p.ev.assignee ?? null;
  const name = to?.displayName ?? change(p.ev, 'assignee')?.to ?? p.snap.assignee?.displayName ?? '';
  const none = to ? !to.accountId : !name;
  const self = !!(to?.accountId && p.ev.actor?.accountId && to.accountId === p.ev.actor.accountId);
  return { self, none, name: p.mention ?? bold(name) };
}

// Frase completa do aviso (§4.6).
function sentence(kind: JiraEventKind, p: Parts): string {
  const { issue, actor, ev, snap } = p;
  const sum = resumo(snap);
  switch (kind) {
    case 'created': {
      // Menção do responsável (§4.5, passo 8): a frase do §4.6 não tem a parte do responsável, então ela vai no fim.
      const who = p.mention ? ` (responsável: ${p.mention})` : '';
      return actor ? `${actor} criou ${issue}: ${sum}${who}` : `${issue} foi criada: ${sum}${who}`;
    }
    case 'status': {
      const c = change(ev, 'status');
      const from = bold(c?.from ?? '?');
      const to = bold(c?.to ?? snap.status.name);
      return actor ? `${actor} moveu ${issue} de ${from} para ${to}` : `${issue} mudou de ${from} para ${to}`;
    }
    case 'resolved': {
      const res = change(ev, 'resolution')?.to ?? snap.resolution ?? null;
      if (actor) return res ? `${actor} resolveu ${issue} como ${bold(res)}` : `${actor} resolveu ${issue}`;
      return res ? `${issue} foi resolvida como ${bold(res)}` : `${issue} foi resolvida`;
    }
    case 'assigned': {
      const t = assignedTarget(p);
      if (actor) {
        if (t.none) return `${actor} removeu o responsável de ${issue}`;
        if (t.self) return `${actor} assumiu ${issue}`;
        return `${actor} atribuiu ${issue} a ${t.name}`;
      }
      return t.none ? `${issue} ficou sem responsável` : `${issue} foi atribuída a ${t.name}`;
    }
    case 'priority': {
      const to = bold(change(ev, 'priority')?.to ?? snap.priority?.name ?? '?');
      return actor ? `${actor} mudou a prioridade de ${issue} para ${to}` : `A prioridade de ${issue} mudou para ${to}`;
    }
    case 'commented': {
      const tr = ev.comment?.text ?? '';
      return actor ? `${actor} comentou em ${issue}: “${tr}”` : `Novo comentário em ${issue}: “${tr}”`;
    }
    case 'updated': {
      const campos = fieldsText(ev.changes.map((c) => c.label));
      return actor ? `${actor} alterou ${campos} em ${issue}` : `${issue} teve ${campos} alterados`;
    }
    case 'deleted':
      return actor ? `${actor} excluiu ${snap.key}: ${sum}` : `${snap.key} foi excluída: ${sum}`;
  }
}

// Texto do aviso publicado pelo robô. `mention` só quando o responsável é membro da sala e a regra pede.
export function eventText(kind: JiraEventKind, ev: NormalizedJiraEvent, snap: JiraIssueSnapshot, o: { mention?: string | null } = {}): string {
  const actor = ev.actor?.displayName ? bold(ev.actor.displayName) : null;
  return sentence(kind, { issue: issueLink(snap), actor, ev, snap, mention: o.mention ? `@${o.mention}` : null });
}

// Versão curta (sem a issue) para as linhas do resumo: "[OPS-1](url) Resumo: **Ana** moveu de **A** para **B**".
export function shortEventText(kind: JiraEventKind, ev: NormalizedJiraEvent, snap: JiraIssueSnapshot): string {
  const actor = ev.actor?.displayName ? bold(ev.actor.displayName) : null;
  switch (kind) {
    case 'created':
      return actor ? `${actor} criou` : 'criada';
    case 'status': {
      const c = change(ev, 'status');
      const from = bold(c?.from ?? '?');
      const to = bold(c?.to ?? snap.status.name);
      return actor ? `${actor} moveu de ${from} para ${to}` : `mudou de ${from} para ${to}`;
    }
    case 'resolved': {
      const res = change(ev, 'resolution')?.to ?? snap.resolution ?? null;
      if (actor) return res ? `${actor} resolveu como ${bold(res)}` : `${actor} resolveu`;
      return res ? `resolvida como ${bold(res)}` : 'resolvida';
    }
    case 'assigned': {
      const t = assignedTarget({ issue: '', actor, ev, snap });
      if (actor) return t.none ? `${actor} removeu o responsável` : t.self ? `${actor} assumiu` : `${actor} atribuiu a ${t.name}`;
      return t.none ? 'ficou sem responsável' : `atribuída a ${t.name}`;
    }
    case 'priority': {
      const to = bold(change(ev, 'priority')?.to ?? snap.priority?.name ?? '?');
      return actor ? `${actor} mudou a prioridade para ${to}` : `prioridade mudou para ${to}`;
    }
    case 'commented':
      return actor ? `${actor} comentou: “${ev.comment?.text ?? ''}”` : `novo comentário: “${ev.comment?.text ?? ''}”`;
    case 'updated': {
      const campos = fieldsText(ev.changes.map((c) => c.label));
      return actor ? `${actor} alterou ${campos}` : `teve ${campos} alterados`;
    }
    case 'deleted':
      return actor ? `${actor} excluiu` : 'excluída';
  }
}

// ---------- Resumo de rajadas (digest.ts) ----------

export const digestStatusText = (n: number, projects: string[], status: string) => `${n} issues de ${joinList(projects)} mudaram de status para **${status}**.`;
export const digestGenericText = (n: number, projects: string[]) => `${n} avisos do Jira em ${joinList(projects)} no último minuto.`;
// Issue excluída sai só com a chave (o link do Jira não abre mais).
export const digestLine = (snap: JiraIssueSnapshot, short: string, deleted = false) => `${deleted ? snap.key : issueLink(snap)} ${resumo(snap)}: ${short}`;
export const digestMore = (n: number) => `…e mais ${n}.`;
export const digestActivity = (n: number, room: string) => `${n} avisos do Jira foram agrupados num resumo em #${room}.`;

// ---------- Regras (rules.ts) ----------

export const eventsLabel = (events: JiraEventKind[]) => joinList(events.map((e) => JIRA_EVENT_LABEL[e].toLowerCase()));
export const ruleAnnounce = (projects: string[], events: JiraEventKind[], name: string, by: string) =>
  `A partir de agora, o Jira avisa aqui sobre ${joinList(projects)} (${eventsLabel(events)}). Regra “${name}”, configurada por ${by}.`;
export const ruleRelease = (projects: string[]) => `O Jira deixou de avisar aqui sobre ${joinList(projects)}.`;

export const RULE_TEXT = {
  name: 'Dê um nome à regra (até 80 caracteres).',
  projects: 'Escolha de 1 a 20 projetos.',
  projectMissing: (key: string) => `O projeto ${key} não existe ou a conta da integração não o vê.`,
  events: 'Escolha pelo menos um tipo de aviso.',
  jql: (msg: string) => `O filtro JQL tem um erro: ${msg}`,
  jqlLong: 'O filtro JQL tem um erro: use no máximo 1000 caracteres.',
  rooms: 'Escolha de 1 a 5 salas.',
  limit: 'Limite de 50 regras do Jira atingido.',
  previewEmpty: (key: string) => `O projeto ${key} ainda não tem uma issue visível para mostrar um exemplo.`,
};

export const postedActivity = (key: string, kind: JiraEventKind, room: string) => `${key} (${JIRA_EVENT_LABEL[kind]}) publicado em #${room}.`;
export const postFailed = (room: string, reason: string) => `Não foi possível publicar em #${room}: ${reason}`;
export const restrictedSkipped = (key: string) => `${key}: issue ou comentário com acesso restrito no Jira não é avisado no chat.`;
export const notVisibleSkipped = (key: string) => `${key}: a conta da integração não vê esta issue; o aviso não foi publicado.`;
export const DELETED_STATUS = 'Excluída';

// ---------- Conexão, site e consulta (config.ts, poll.ts, webhook.ts) ----------

export const CONFIG_TEXT = {
  disabled: 'A integração com o Jira está desligada.',
  notConfigured: 'Configure e teste a conexão com o Jira antes de ativar.',
  noCloud: 'Não encontramos um Jira Cloud neste endereço.',
  dataCenter: 'Este endereço parece ser um Jira Data Center. Esta versão do chat funciona com o Jira Cloud.',
  account: (name: string) => `Conta da integração: ${name}`,
  language: (lang: string) => `A conta da integração está em ${lang}. Status, tipos e prioridades vão chegar nesse idioma. Mude o idioma do perfil dessa conta para Português (Brasil).`,
  ipAllowlist: 'Se a organização da Atlassian usa lista de IPs permitidos, o IP público de saída do servidor precisa estar nela.',
  projects: (n: number) => `A conta da integração vê ${n} projetos.`,
  projectMissing: (key: string) => `O projeto ${key} não existe ou a conta da integração não o vê.`,
  tokenExpires: (n: number) => `O token expira em ${n} dias.`,
  ok: (name: string) => `Conectado como ${name}`,
  warn: (name: string) => `Conectado como ${name}, com avisos`,
  off: 'Não configurado',
  noToken: 'Informe o e-mail e o token da conta da integração.',
  siteChanged: (from: string, to: string) => `O endereço do Jira mudou de ${from} para ${to}. Os tokens salvos foram descartados.`,
  linkedSiteChanged: 'O endereço do Jira mudou. Conecte sua conta de novo.',
  oldJobsDropped: (n: number) =>
    n === 1 ? '1 tarefa do endereço antigo do Jira (na fila ou com falha) foi descartada.' : `${n} tarefas do endereço antigo do Jira (na fila ou com falha) foram descartadas.`,
  unreadable: 'O token foi gravado com outra chave de segredos. Cadastre o token de novo.',
  oauthProblem: 'Para entrar com a Atlassian, o chat precisa de um endereço https. Use o token pessoal.',
  webhookProblem: (site: string) =>
    `O Jira Cloud só chama endereços https públicos, com certificado de uma autoridade pública (não serve certificado interno da empresa), na porta 443 ou em outra aceita pela Atlassian. Este chat está em ${site}. Use a consulta periódica, ou publique o chat na internet com https.`,
  badSignature: 'Chegou uma chamada no webhook do Jira com assinatura inválida.',
  staleDelivery: 'Chegou uma chamada no webhook do Jira com data de mais de 24 horas atrás (ou sem data). Ela foi ignorada.',
  otherSiteDelivery: (origin: string) => `Chegou uma chamada no webhook vinda de outro Jira (${origin}). Ela foi ignorada. Se esse Jira não é mais usado, apague o webhook nele.`,
  tooMany: (n: number) => `Muitas mudanças de uma vez (${n} issues). Os avisos mais antigos desta janela foram pulados.`,
};

// Nome do idioma do perfil (locale do Jira) para o aviso do teste de conexão.
export function localeName(locale: string): string {
  const l = locale.toLowerCase();
  if (l.startsWith('en')) return 'inglês';
  if (l.startsWith('es')) return 'espanhol';
  if (l.startsWith('fr')) return 'francês';
  if (l.startsWith('de')) return 'alemão';
  if (l.startsWith('it')) return 'italiano';
  if (l.startsWith('ja')) return 'japonês';
  return locale;
}

// ---------- Erros do Jira (client.ts) ----------

export const JIRA_ERROR_TEXT = {
  authIntegration: 'O Jira recusou o token da conta da integração. Confira o e-mail e o token (os tokens da Atlassian expiram).',
  authUser: 'O Jira recusou o seu token. Conecte a conta de novo em Minha conta → Contas conectadas.',
  forbiddenUser: 'Sua conta do Jira não tem permissão para isso.',
  forbiddenIntegration: 'A conta da integração não tem permissão para isso no Jira.',
  notFound: 'Issue não encontrada, ou sem permissão para vê-la.',
  invalid: (msgs: string) => `O Jira recusou: ${msgs}`,
  busy: (n: number) => `O Jira pediu para esperar um pouco. Tente de novo em ${n} segundos.`,
  unavailable: 'O Jira não respondeu. Tente de novo em alguns minutos.',
  redirect: 'O servidor respondeu com um redirecionamento. Confira o endereço.',
};

// ---------- Issues e /jira (issues.ts, command.ts) ----------

export const ISSUE_TEXT = {
  linkToViewOther: 'Conecte sua conta do Jira para ver issues de outros projetos.',
  linkToSearch: 'Conecte sua conta do Jira para buscar issues.',
  linkForJql: 'Busca com JQL usa a sua conta do Jira. Conecte sua conta com /jira conectar.',
  linkToCreate: 'Conecte sua conta do Jira para criar issues.',
  linkToAct: 'Conecte sua conta do Jira para comentar e atribuir issues.',
  emptyQuery: 'Digite o que procurar.',
  field: (name: string) => `Confira o campo ${name}.`,
  blockers: (fields: string[]) => `Este tipo de issue tem campos obrigatórios que o chat ainda não preenche: ${joinList(fields)}. Crie esta issue pelo Jira.`,
  projectNotAllowed: 'Este projeto não está disponível para criar issues pelo chat.',
  typeNotFound: 'Escolha um tipo de issue deste projeto.',
  summary: 'Dê um resumo à issue (até 255 caracteres).',
  description: 'A descrição pode ter até 32000 caracteres.',
  messageNotFound: 'Mensagem não encontrada nesta sala.',
  createdBy: (name: string, username: string, site: string) => `Criada por ${name} (@${username}) pelo ${site}.`,
  original: (author: string, room: string, when: string) => `Mensagem original de ${author} em #${room}, ${when}:`,
  openIn: (site: string, url: string) => `Abrir no ${site}: ${url}`,
  remoteTitle: (site: string) => `Mensagem no ${site}`,
  created: (snap: JiraIssueSnapshot) => `Criei a issue ${issueLink(snap)}: ${resumo(snap)}`,
  share: (snap: JiraIssueSnapshot) => `${issueLink(snap)}: ${resumo(snap)}`,
  shareConfirm: (room: string, key: string) => `Todos em #${room} vão ver o resumo e o status de ${key}, inclusive quem não tem acesso a este projeto no Jira.`,
  commentLong: 'O comentário pode ter até 10000 caracteres.',
  commentEmpty: 'Escreva o comentário.',
  busy: 'Muitas ações seguidas. Espere um minuto.',
  noAccess: (site: string) => `Sua conta da Atlassian não tem acesso a ${site}.`,
  previewForbidden: 'Só quem enviou a mensagem ou um moderador pode remover a prévia.',
};

export const COMMAND_TEXT = {
  description: 'Buscar, ver, criar e atualizar issues do Jira',
  params: '[CHAVE | buscar | criar | atribuir | comentar | compartilhar]',
  disabled: 'A integração com o Jira está desligada.',
  noPermission: 'Você não tem permissão para usar o Jira no chat.',
  noCreatePermission: 'Você não tem permissão para criar issues do Jira.',
  tooMany: 'Muitos comandos seguidos. Espere um minuto.',
  unknown: 'Não entendi. Use /jira ajuda para ver o que dá para fazer.',
  help: [
    '**Jira no chat**',
    '`/jira OPS-123` mostra a issue',
    '`/jira buscar texto` procura issues pelo texto',
    '`/jira jql consulta` procura com JQL usando a sua conta do Jira, por exemplo `/jira jql assignee = currentUser()`',
    '`/jira criar resumo` abre o formulário de nova issue',
    '`/jira atribuir OPS-123 @pessoa` (ou `eu`, ou `ninguém`)',
    '`/jira comentar OPS-123 texto do comentário`',
    '`/jira compartilhar OPS-123` mostra a issue para a sala',
    '`/jira conectar` e `/jira desconectar` cuidam da sua conta do Jira',
    'Para criar uma issue a partir de uma mensagem, use o menu Mais da mensagem → Criar issue no Jira.',
  ].join('\n'),
  results: (n: number, q: string) => `${n} issues para “${q}”`,
  noResults: (q: string) => `Nenhuma issue encontrada para “${q}”.`,
  jqlResults: (n: number) => `${n} issues encontradas com JQL`,
  jqlNoResults: 'Nenhuma issue encontrada com esta consulta JQL.',
  moreResults: (n: number) => `Mais ${n} issues`,
  opening: 'Abrindo o formulário de nova issue.',
  assignedTo: (key: string, name: string) => `${key} agora está com ${name}.`,
  assignedMe: (key: string) => `${key} agora está com você.`,
  unassigned: (key: string) => `${key} ficou sem responsável.`,
  assigneeNotLinked: (name: string) => `${name} não conectou a conta do Jira. Escolha a pessoa pela lista.`,
  assigneeUnknown: (name: string) => `Não encontramos ${name} no chat. Escolha a pessoa pela lista.`,
  commented: (key: string) => `Comentário publicado em ${key}.`,
  commentedInternal: (key: string) => `Comentário interno publicado em ${key}.`,
  connect: 'Conecte sua conta do Jira para criar, comentar e atribuir issues em seu nome.',
  connectOff: 'A conexão de contas do Jira está desligada pelo administrador.',
  disconnectedToken: 'Sua conta do Jira foi desconectada do chat. O token continua válido na Atlassian: apague-o em id.atlassian.com se não for mais usá-lo.',
  disconnectedOauth: 'Sua conta do Jira foi desconectada do chat. A autorização pode ser removida em id.atlassian.com → Segurança → Aplicativos conectados.',
  notConnected: 'Sua conta do Jira não está conectada ao chat.',
  usageView: 'Use /jira OPS-123 para ver uma issue.',
  usageSearch: 'Use /jira buscar seguido do texto.',
  usageJql: 'Use /jira jql seguido da consulta.',
  usageAssign: 'Use /jira atribuir OPS-123 @pessoa (ou eu, ou ninguém).',
  usageComment: 'Use /jira comentar OPS-123 seguido do comentário.',
  usageShare: 'Use /jira compartilhar OPS-123.',
  // rótulos das ações
  actShare: 'Compartilhar na sala',
  actShareAnyway: 'Compartilhar mesmo assim',
  actComment: 'Comentar',
  actAssign: 'Atribuir',
  actOpen: 'Abrir no Jira',
  actMore: 'Ver mais',
  actCreate: 'Abrir formulário',
  actConnect: 'Conectar conta do Jira',
};

export const LINK_TEXT = {
  tokenFailed: (email: string) =>
    `O Jira não aceitou este e-mail e token. Confira se o token foi copiado inteiro e se é da conta ${email}. Se a organização da Atlassian bloqueia tokens de API, peça ao administrador do chat para usar Entrar com a Atlassian.`,
  email: 'Informe o e-mail da sua conta da Atlassian.',
  token: 'Cole o token de API inteiro (de 20 a 500 caracteres).',
  expiresAt: 'Use a data no formato AAAA-MM-DD.',
  oauthOff: 'Entrar com a Atlassian não está configurado neste chat.',
  tokenOff: 'A conexão por token pessoal não está ativa neste chat.',
  expired: 'A conexão com o Jira expirou. Conecte de novo em Minha conta → Contas conectadas.',
  alertExpires: (n: number) => `Seu token do Jira expira em ${n} dias. Gere um novo e atualize em Minha conta → Contas conectadas.`,
  alertRelink: 'Conecte sua conta do Jira de novo em Minha conta → Contas conectadas.',
};

// O motivo já vem com ponto final; a frase põe o seu.
const reason = (t: string) => t.trim().replace(/[.]+$/, '');
export const ALERT_TEXT = {
  connection: (t: string) => `A conexão com o Jira está com erro há mais de 1 hora: ${reason(t)}.`,
  token: (n: number) => `O token da conta da integração do Jira expira em ${n} dias.`,
};

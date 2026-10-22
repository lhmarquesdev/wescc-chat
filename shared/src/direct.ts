// Política de conversas diretas entre pessoas com papel restrito. A mesma função decide no servidor
// (que bloqueia) e na web (que esconde ou desativa os botões antes do clique).

export type DirectScope = 'any' | 'same_role';
export type DirectAction = 'start' | 'send' | 'call';

export interface DirectParty {
  _id: string;
  username: string;
  roles: string[]; // papéis globais
}

export interface DirectRules {
  restrictedRoles: string[]; // papéis globais com "Restrito em conversas diretas"
  exemptRoles: string[]; // papéis com a permissão start-dm-between-restricted
  scope: DirectScope;
}

export interface DirectVerdict {
  allowed: boolean;
  action: DirectAction;
  pair?: [string, string]; // usernames do par bloqueado; quem pergunta vem primeiro quando faz parte do par
  exemptOther?: string; // em conversa a dois: o outro lado tem a permissão e pode iniciar
}

export interface DirectRestrictionReport {
  scope: DirectScope;
  restrictedRoles: { _id: string; description: string; users: number }[];
  exemptRoles: string[];
  loopholes: { permission: string; viaRoles: string[]; users: number; sample: { _id: string; username: string; name?: string }[] }[];
  blockedDirects: number;
}

const restrictedOf = (p: DirectParty, r: DirectRules) => p.roles.filter((x) => r.restrictedRoles.includes(x));
export const isRestricted = (p: DirectParty, r: DirectRules) => restrictedOf(p, r).length > 0;
export const isExempt = (p: DirectParty, r: DirectRules) => p.roles.some((x) => r.exemptRoles.includes(x));

function conflict(a: DirectParty, b: DirectParty, r: DirectRules) {
  if (a._id === b._id) return false;
  if (r.scope === 'any') return true;
  const ra = restrictedOf(a, r);
  return restrictedOf(b, r).some((x) => ra.includes(x));
}

// Primeiro par de participantes que não pode conversar em particular (preferindo um par com preferId).
export function blockedPair(parties: DirectParty[], r: DirectRules, preferId?: string): [DirectParty, DirectParty] | null {
  const list = parties.filter((p) => isRestricted(p, r));
  if (list.length < 2) return null;
  if (preferId) list.sort((x, y) => Number(y._id === preferId) - Number(x._id === preferId));
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (conflict(list[i], list[j], r)) return [list[i], list[j]];
  return null;
}

// start: abrir conversa nova; send: escrever numa conversa que já existe; call: ligar (conversa a dois).
export function checkDirect(action: DirectAction, actor: DirectParty, others: DirectParty[], r: DirectRules): DirectVerdict {
  const rest = others.filter((o) => o._id !== actor._id);
  const parties = [actor, ...rest];
  const pair = blockedPair(parties, r, actor._id);
  if (!pair) return { allowed: true, action };
  const exempt = action === 'send' ? parties.some((p) => isExempt(p, r)) : isExempt(actor, r);
  if (exempt) return { allowed: true, action };
  const v: DirectVerdict = { allowed: false, action, pair: [pair[0].username, pair[1].username] };
  if (rest.length === 1 && isExempt(rest[0], r)) v.exemptOther = rest[0].username;
  return v;
}

export function directBlockMessage(v: DirectVerdict, viewer: string): string {
  if (v.allowed || !v.pair) return '';
  const [a, b] = v.pair;
  const inPair = a === viewer || b === viewer;
  const other = a === viewer ? b : a;
  if (v.action === 'start') {
    if (!inPair) return `Esta conversa juntaria @${a} e @${b}, que não podem conversar em particular. Use um grupo privado ou um canal.`;
    if (v.exemptOther) return `Você não pode iniciar uma conversa direta com @${other}. Peça para @${other} iniciar a conversa.`;
    return `Você não pode iniciar uma conversa direta com @${other}: conversas particulares entre vocês estão bloqueadas pela política da empresa. Use um canal da equipe ou fale com um supervisor.`;
  }
  if (v.action === 'send') {
    return inPair
      ? `Conversas diretas entre você e @${other} estão bloqueadas pela política da empresa. O histórico continua disponível, mas não é possível enviar mensagens.`
      : `Esta conversa reúne @${a} e @${b}, que não podem conversar em particular. O histórico continua disponível, mas não é possível enviar mensagens.`;
  }
  return v.exemptOther ? `Só @${other} pode iniciar chamadas com você.` : `Você não pode ligar para @${other}: chamadas entre vocês estão bloqueadas pela política da empresa.`;
}

// Sala privada: quem tem papel restrito, sem a exceção, não traz para ela outra pessoa restrita com quem formaria um
// par bloqueado (seria uma conversa particular sem um dono que responda por ela). x é quem entraria; y, com quem formaria
// o par: quem convida, outra pessoa que entra junto ou (escopo same_role) alguém que já está na sala.
export interface BringInMode {
  joinerId?: string; // link de convite: quem entra (quem convida é quem criou o link)
  privatize?: boolean; // a sala vai virar privada com quem já está nela
}

export function bringInBlockMessage(x: DirectParty, y: DirectParty, inviter: DirectParty, mode: BringInMode = {}): string {
  const withInviter = y._id === inviter._id;
  if (mode.joinerId) {
    return withInviter
      ? `Este convite foi criado por @${inviter.username}, e conversas particulares entre vocês estão bloqueadas pela política da empresa. Peça um convite a um supervisor.`
      : `Você não pode entrar nesta sala privada por este convite: conversas particulares entre você e @${y.username} estão bloqueadas pela política da empresa. Peça um convite a um supervisor.`;
  }
  if (mode.privatize) {
    return withInviter
      ? `Você não pode tornar esta sala privada: conversas particulares entre você e @${x.username} estão bloqueadas pela política da empresa.`
      : `Você não pode tornar esta sala privada: @${x.username} e @${y.username} não podem conversar em particular.`;
  }
  return withInviter
    ? `Você não pode adicionar @${x.username} a uma sala privada: conversas particulares entre vocês estão bloqueadas pela política da empresa. Peça a um supervisor para adicionar.`
    : `Você não pode adicionar @${x.username} a esta sala privada: @${x.username} e @${y.username} não podem conversar em particular. Peça a um supervisor para adicionar.`;
}

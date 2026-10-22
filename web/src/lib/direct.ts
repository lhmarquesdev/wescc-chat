import { useMemo } from 'react';
import { blockedPair, bringInBlockMessage, checkDirect, directBlockMessage, isExempt, isRestricted, type DirectParty, type DirectRules } from '@shared/direct';
import type { RoomDirectPolicy, Subscription } from '@shared/index';
import { roomPath } from './format';
import { useStore } from './store';

// Conversas diretas entre pessoas com papel restrito: as mesmas regras do servidor (@shared/direct), para
// desativar botões e explicar o motivo antes do clique. O servidor continua decidindo sozinho.

// O que dá para fazer com a conversa direta com essas pessoas.
export type DirectState =
  | { kind: 'open' } // conversa nova permitida, ou a que já existe aceita mensagens (im.create a reabre)
  | { kind: 'view'; text: string; path: string } // a conversa existe, mas só o histórico: o envio está bloqueado
  | { kind: 'none'; text: string }; // não existe e não pode ser iniciada

export interface DirectPolicy {
  state: (targets: DirectParty[]) => DirectState;
  // Sala privada: o motivo de não poder trazer candidate (com quem já foi escolhido), ou undefined.
  bringIn: (picked: DirectParty[], candidate: DirectParty) => string | undefined;
}

const NONE: string[] = [];

export const partyOf = (u: { _id: string; username: string; roles?: string[] | null }): DirectParty => ({ _id: u._id, username: u.username, roles: u.roles ?? [] });

// As DMs de quem vê, como texto ("rid\tnome" por linha): o seletor só redesenha quando uma DM aparece ou some,
// não a cada mensagem nova. O nome de uma DM em grupo é a lista dos outros participantes, separados por ", ".
const dmIndex = (subs: Record<string, Subscription>) =>
  Object.values(subs)
    .filter((s) => s.t === 'd')
    .map((s) => `${s.rid}\t${s.name}`)
    .join('\n');

function findDirect(index: string, usernames: string[]) {
  const want = new Set(usernames);
  for (const line of index ? index.split('\n') : []) {
    const [rid, name] = line.split('\t');
    const names = name.split(', ');
    if (names.length === want.size && names.every((n) => want.has(n))) return rid;
  }
  return undefined;
}

// O veredito depende das regras, dos papéis das pessoas e das DMs que já existem: o hook lê tudo do store, então a
// tela se atualiza sozinha quando o administrador dá ou tira um papel de quem está olhando ou de quem aparece nela.
// Os papéis do outro lado vêm da busca da tela; um evento "user" que chegou depois vale por cima deles.
export function useDirect(): DirectPolicy {
  const restricted = useStore((s) => s.restrictedRoles);
  const exempt = useStore((s) => s.permMap['start-dm-between-restricted']);
  const scope = useStore((s) => s.settings.Direct_Restriction_Scope);
  const id = useStore((s) => s.me?._id ?? '');
  const username = useStore((s) => s.me?.username ?? '');
  const roles = useStore((s) => s.me?.roles ?? NONE);
  const dms = useStore((s) => dmIndex(s.subscriptions));
  const live = useStore((s) => s.userRoles);
  return useMemo(() => {
    const rules: DirectRules = { restrictedRoles: restricted, exemptRoles: exempt ?? NONE, scope: scope === 'same_role' ? 'same_role' : 'any' };
    const me: DirectParty = { _id: id, username, roles };
    const check = (action: 'start' | 'send', targets: DirectParty[]) => {
      const v = checkDirect(action, me, targets, rules);
      return { allowed: v.allowed, text: directBlockMessage(v, username) };
    };
    const withLive = (t: DirectParty) => (live[t._id] ? { ...t, roles: live[t._id] } : t);
    const state = (list: DirectParty[]): DirectState => {
      const targets = list.map(withLive);
      const begin = check('start', targets);
      if (begin.allowed) return { kind: 'open' };
      // Uma DM que já existe é só reaberta pelo servidor, sem a regra de início; vale a regra de envio.
      const rid = findDirect(dms, targets.filter((t) => t._id !== id).map((t) => t.username));
      if (!rid) return { kind: 'none', text: begin.text };
      const send = check('send', targets);
      // Quem tem a permissão abriu a conversa: os dois continuam escrevendo nela.
      if (send.allowed) return { kind: 'open' };
      return { kind: 'view', text: send.text, path: roomPath({ rid, t: 'd' }) };
    };
    // Quem tem papel restrito, sem a exceção, não traz outra pessoa restrita para uma sala privada (o servidor também
    // confere quem já está na sala; aqui, quem convida e quem entra junto).
    const bringIn = (picked: DirectParty[], candidate: DirectParty) => {
      if (!isRestricted(me, rules) || isExempt(me, rules)) return undefined;
      const x = withLive(candidate);
      if (x._id === id || !isRestricted(x, rules)) return undefined;
      const y = [me, ...picked.map(withLive)].find((p) => p._id !== x._id && blockedPair([x, p], rules));
      return y ? bringInBlockMessage(x, y, me) : undefined;
    };
    return { state, bringIn };
  }, [restricted, exempt, scope, id, username, roles, dms, live]);
}

// Motivo do bloqueio de envio de uma DM aberta, calculado pelo servidor para quem pergunta ('' quando dá para escrever).
export const sendText = (room: { direct?: RoomDirectPolicy } | null | undefined) => (room?.direct?.canSend === false ? room.direct.sendBlockedReason ?? '' : '');

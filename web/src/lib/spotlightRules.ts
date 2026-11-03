// Regras puras da busca da barra lateral (sem React nem store: server/test/web-rules.test.ts testa direto).
import type { SpotlightRoom, SpotlightUser, Subscription } from '@shared/index';
import { foldText, type SpotlightScope } from '@shared/search';

const isPair = (s: Subscription) => s.t === 'd' && !s.name.includes(',');

// Busca local: nome de exibição e nome (usuário da DM), sem acento; respeita @ e #. Inclui conversas ocultas.
// Texto vazio depois do prefixo (só "@" ou "#") casa com tudo do escopo.
export function matchesLocal(s: Subscription, q: { text: string; scope: SpotlightScope }): boolean {
  if (q.scope === 'users' && s.t !== 'd') return false;
  if (q.scope === 'rooms' && s.t === 'd') return false;
  const want = foldText(q.text.trim());
  if (!want) return true;
  return [s.fname, s.name].some((n) => !!n && foldText(n).includes(want));
}

// Some quem já tem DM a dois na lista local (a sub 'd' cujo name é o username) e salas em que a pessoa já está.
export function dedupePeople(users: SpotlightUser[], subs: Subscription[]): SpotlightUser[] {
  const have = new Set(subs.filter(isPair).map((s) => s.name.toLowerCase()));
  return users.filter((u) => !have.has(u.username.toLowerCase()));
}

export function dedupeRooms(rooms: SpotlightRoom[], subs: Record<string, Subscription>): SpotlightRoom[] {
  return rooms.filter((r) => !subs[r._id]);
}

// Ordem estável: quem dá para abrir primeiro; "Sem conversa direta" por último.
export function orderPeople<T>(list: T[], blocked: (x: T) => boolean): T[] {
  const open: T[] = [];
  const closed: T[] = [];
  for (const x of list) (blocked(x) ? closed : open).push(x);
  return [...open, ...closed];
}

// "Nenhum resultado", "1 resultado", "N resultados" (para o leitor de tela).
export const resultCountText = (n: number) => (n === 0 ? 'Nenhum resultado' : n === 1 ? '1 resultado' : `${n} resultados`);

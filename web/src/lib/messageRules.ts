// Regras sobre mensagens que mais de uma tela aplica (conversa, painel do tópico, painéis da sala e compositor), num
// lugar só para não divergirem de novo. Sem store nem React: os testes do servidor importam direto
// (server/test/web-rules.test.ts).
import type { Message } from '@shared/index';
import type { MessageForward, MessagePoll } from '@shared/messages';
import { encryptedContent, messageLink } from '@shared/messages';
import { whenText } from './messageTimes';

// O tipo aceita edição: nem mensagem de sistema, nem figurinha, nem enquete, nem encaminhada (o servidor recusa no chat.update).
export const editableKind = (m: Message) => !m.t && !m.sticker && !m.poll && !m.forward;

// Dá para encaminhar: nem mensagem de sistema, nem enquete, nem figurinha removida, nem mensagem cifrada (o servidor
// também confere a sala; encryptedContent é o lugar único que o E2E ajusta).
export const forwardableKind = (m: Message) => !m.t && !m.poll && !m.sticker?.removed && !encryptedContent(null, m);

// /channel/<rid>?msg=<id>; resposta de tópico abre o tópico: /channel/<rid>/thread/<tmid>. O mesmo do push do lembrete.
export { messageLink };

// Rótulo e link da origem de uma encaminhada para quem vê. Nunca mostra o nome de um grupo privado nem quem está numa
// DM a quem não participa dela.
export function forwardOrigin(f: MessageForward, subs: Record<string, { t: string; name: string; fname?: string }>): { text: string; link: string | null } {
  const lead = f.hops > 1 ? 'Encaminhada várias vezes' : 'Encaminhada';
  const link = messageLink({ rid: f.rid, t: f.t, mid: f.mid, tmid: f.tmid });
  const sub = subs[f.rid];
  if (f.t === 'c' && f.roomName) return { text: `${lead} de #${f.roomName}`, link };
  if (sub) {
    const label = f.t === 'd' ? 'uma conversa direta' : f.t === 'p' ? sub.fname || sub.name : `#${sub.fname || sub.name}`;
    return { text: `${lead} de ${label}`, link };
  }
  return { text: `${lead} de ${f.t === 'p' ? 'um grupo privado' : f.t === 'd' ? 'uma conversa direta' : 'um canal'}`, link: null };
}

// Porcentagem inteira por opção, somando 100 (maior resto; empate fica com a opção de cima). Sem votos: zeros.
export function pollShares(p: MessagePoll): number[] {
  const total = p.options.reduce((n, o) => n + o.votes, 0);
  if (!total) return p.options.map(() => 0);
  const raw = p.options.map((o) => (o.votes * 100) / total);
  const out = raw.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]++;
    left--;
  }
  return out;
}

export const pollClosed = (p: MessagePoll, now: Date) => !!p.closedAt || (!!p.closesAt && new Date(p.closesAt).getTime() <= now.getTime());

// "Várias respostas · Anônima · Encerra amanhã às 18:00" | "Encerrada" | "Uma resposta"
export function pollMeta(p: MessagePoll, now: Date): string {
  if (pollClosed(p, now)) return 'Encerrada';
  const parts = [p.multiple ? 'Várias respostas' : 'Uma resposta'];
  if (p.anonymous) parts.push('Anônima');
  if (p.closesAt) parts.push(`Encerra ${whenText(p.closesAt, now)}`);
  return parts.join(' · ');
}

// Seta para cima no compositor vazio: a última mensagem da pessoa que o "Editar" do menu também ofereceria.
export function lastOwnEditable(list: readonly Message[], meId: string, allowEdit: boolean): Message | undefined {
  if (!allowEdit) return undefined;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].u._id === meId && editableKind(list[i])) return list[i];
  return undefined;
}

// Nome de quem escreveu, como no cabeçalho da mensagem: o alias (webhooks) vem antes do usuário.
export const authorName = (m: Message) => m.alias || m.u.name || m.u.username;

// A mensagem continua o grupo da anterior (sem avatar nem nome): mesmo usuário e mesmo alias (mensagens de webhook são
// todas do robô, com a pessoa no alias), nenhuma das duas de sistema, no mesmo dia e dentro do intervalo.
export function continuesGroup(prev: Message, m: Message, periodMs: number) {
  const a = new Date(prev.ts);
  const b = new Date(m.ts);
  return (
    !prev.t &&
    !m.t &&
    prev.u._id === m.u._id &&
    (prev.alias || '') === (m.alias || '') &&
    a.toDateString() === b.toDateString() &&
    b.getTime() - a.getTime() < periodMs
  );
}

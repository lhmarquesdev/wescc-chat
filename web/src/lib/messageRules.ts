// Regras sobre mensagens que mais de uma tela aplica (conversa, painel do tópico, painéis da sala e compositor), num
// lugar só para não divergirem de novo. Sem store nem React: os testes do servidor importam direto
// (server/test/web-rules.test.ts).
import type { Message } from '@shared/index';

// O tipo aceita edição: nem mensagem de sistema nem figurinha (o servidor recusa as duas no chat.update).
export const editableKind = (m: Message) => !m.t && !m.sticker;

// Seta para cima no compositor vazio: a última mensagem da pessoa que o "Editar" do menu também ofereceria.
export function lastOwnEditable(list: readonly Message[], meId: string, allowEdit: boolean): Message | undefined {
  if (!allowEdit) return undefined;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].u._id === meId && editableKind(list[i])) return list[i];
  return undefined;
}

// Nome de quem escreveu, como no cabeçalho da mensagem: o alias (webhooks, cópias do Teams) vem antes do usuário.
export const authorName = (m: Message) => m.alias || m.u.name || m.u.username;

// A mensagem continua o grupo da anterior (sem avatar nem nome): mesmo usuário e mesmo alias (as cópias do Teams são
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

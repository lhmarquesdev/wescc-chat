// "Marcar como não lida" (menu da sala e menu da mensagem). Com a sala aberta e o fim da lista à vista, a lista a marca
// como lida de novo em 1,5 s (MessageList): como no Rocket.Chat, a pessoa sai da sala, que fica não lida até voltar.
import { api, errorMessage } from './api';
import { useStore } from './store';

const held = new Set<string>();

// A lista não marca como lida uma sala com o pedido em andamento (ou feito), até a sala ser aberta de novo.
export const readHeld = (rid: string) => held.has(rid);
export const releaseRead = (rid: string) => held.delete(rid);

export async function markUnread(rid: string, leave: () => void, fromMessageId?: string) {
  held.add(rid);
  const { toast } = useStore.getState();
  try {
    await api.post('subscriptions.unread', fromMessageId ? { firstUnreadMessage: { _id: fromMessageId } } : { roomId: rid });
  } catch (e) {
    held.delete(rid);
    toast(errorMessage(e), 'error');
    return;
  }
  leave();
  toast('Conversa marcada como não lida.', 'success');
}

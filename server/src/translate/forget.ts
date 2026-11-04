import { many, query } from '../db/pool';

// Traduções que não podem sobreviver ao texto de onde vieram (edição, remoção, sala que passou a ser criptografada).
// Só depende do banco: messages.ts e rooms.ts importam daqui sem criar ciclo com o serviço da tradução.

export async function forgetMessageTranslations(messageId: string): Promise<void> {
  await query('DELETE FROM message_translations WHERE message_id = $1', [messageId]);
  await query('DELETE FROM message_languages WHERE message_id = $1', [messageId]);
}

// Sala que passou a ser criptografada: apaga o que estava guardado e desliga a tradução automática de quem a tinha.
// Devolve as inscrições que foram desligadas (para o evento subscription).
export async function forgetRoomTranslations(rid: string): Promise<any[]> {
  await query('DELETE FROM message_translations WHERE message_id IN (SELECT id FROM messages WHERE room_id = $1)', [rid]);
  await query('DELETE FROM message_languages WHERE message_id IN (SELECT id FROM messages WHERE room_id = $1)', [rid]);
  return many('UPDATE subscriptions SET auto_translate = false, updated_at = now() WHERE room_id = $1 AND auto_translate RETURNING *', [rid]);
}

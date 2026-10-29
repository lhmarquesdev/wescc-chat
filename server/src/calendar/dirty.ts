import { query } from '../db/pool';

// Marca as contas que levam eventos do chat para fora (export/both) das pessoas cujo evento mudou, e chama a
// sincronização logo (sem esperar a rodada periódica). A sincronização registra o chamador em setSyncKicker.
let kicker: ((accountIds: string[]) => void) | null = null;

export function setSyncKicker(fn: ((accountIds: string[]) => void) | null) {
  kicker = fn;
}

export function kick(accountIds: string[]) {
  if (accountIds.length && kicker) kicker(accountIds);
}

export async function markDirty(userIds: string[]): Promise<void> {
  if (!userIds.length) return;
  const r = await query(
    `UPDATE calendar_accounts SET dirty = true WHERE user_id = ANY($1) AND direction IN ('export', 'both') AND status = 'ok' RETURNING id`,
    [userIds],
  );
  if (r.rowCount) kick(r.rows.map((x) => x.id));
}

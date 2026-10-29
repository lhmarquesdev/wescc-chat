// Limite de posts por dono do fluxo (D12): janela deslizante no banco, válida entre instâncias. A Microsoft limita os
// posts do robô do Flow a cerca de 25 a cada 5 minutos por conexão, e a conexão é do dono do fluxo: todos os fluxos
// do mesmo dono dividem a mesma janela. Capacidade = menor budget entre as regras ativas do dono.
//
// Janela deslizante, não balde de tokens: o balde começa cheio e repõe aos poucos, então deixava passar a capacidade
// de uma vez e mais a reposição dentro dos mesmos 5 minutos (39 em 299 s com capacidade 20). Aqui ficam as horas dos
// últimos posts, e um post só sai se houver menos que a capacidade nos 5 minutos antes dele.
import { tx } from '../../db/pool';
import { activity } from '../state';

export const BUDGET_WINDOW_MS = 5 * 60_000;
export const DAILY_WARN = 2000;

export interface BudgetState {
  times: number[]; // ms dos últimos posts (no máximo os que a maior capacidade precisa), em ordem
  day: string; // AAAA-MM-DD (hora do servidor)
  dayCount: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const budgetKey = (owner: string) => `msteams.budget:${owner.trim().toLowerCase()}`;

// Guardados só os últimos posts que a maior capacidade precisa (o budget de uma regra é 5, 10 ou 20).
const KEEP = 25;

// Puro: aceita o post se, nos 5 minutos antes de `now`, houve menos que `capacity`; senão diz quanto falta para o
// mais antigo dos que sobram sair da janela.
export function takeFrom(prev: Partial<BudgetState> | Record<string, unknown> | null, capacity: number, now: number): { state: BudgetState; ok: boolean; waitMs: number } {
  const cap = Math.max(1, Math.floor(Number(capacity) || 1));
  const today = localDay(new Date(now));
  const raw = Array.isArray(prev?.times) ? (prev!.times as unknown[]) : [];
  // Hora no futuro (relógio voltou) continua contando até sair da janela.
  const times = raw.map(Number).filter((t) => Number.isFinite(t) && now - t < BUDGET_WINDOW_MS).sort((x, y) => x - y);
  const dayCount = prev?.day === today ? Number(prev?.dayCount ?? 0) || 0 : 0;
  if (times.length < cap) {
    times.push(now);
    return { state: { times: times.slice(-Math.max(KEEP, cap)), day: today, dayCount: dayCount + 1 }, ok: true, waitMs: 0 };
  }
  const waitMs = Math.max(1, times[times.length - cap] + BUDGET_WINDOW_MS - now);
  return { state: { times, day: today, dayCount }, ok: false, waitMs };
}

const warnText = (owner: string, n: number) =>
  `O dono do fluxo ${owner} já fez ${n} posts hoje. A Microsoft limita as ações diárias de cada licença; acima disso os fluxos ficam lentos e podem ser desligados.`;

// Uma transação curta (SELECT … FOR UPDATE), sem HTTP dentro.
export async function takePost(owner: string, capacity: number): Promise<{ ok: true } | { ok: false; waitMs: number }> {
  const id = budgetKey(owner);
  const r = await tx(async (c) => {
    await c.query(`INSERT INTO integration_state (id, data) VALUES ($1, '{}') ON CONFLICT (id) DO NOTHING`, [id]);
    const row = (await c.query(`SELECT data FROM integration_state WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    const out = takeFrom(row?.data ?? null, capacity, Date.now());
    await c.query(`UPDATE integration_state SET data = $2, updated_at = now() WHERE id = $1`, [id, JSON.stringify(out.state)]);
    return out;
  });
  if (r.ok && r.state.dayCount > DAILY_WARN) {
    const who = owner.trim().toLowerCase();
    await activity({ provider: 'msteams', tone: 'warn', text: warnText(who, r.state.dayCount), onceKey: `budget-day:${who}:${r.state.day}`, oncePerMs: 86_400_000 }).catch(() => {});
  }
  return r.ok ? { ok: true } : { ok: false, waitMs: r.waitMs };
}

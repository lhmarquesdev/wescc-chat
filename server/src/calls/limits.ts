import { ApiError } from '../lib/errors';
import { getSetting } from '../services/settings';

// Limite por pessoa em janela deslizante, dentro do processo. Conta só depois de validar a entrada.
const hits = new Map<string, number[]>();

export function hit(userId: string, key: string, max: number, windowMs: number): void {
  if (!getSetting('API_Enable_Rate_Limiter')) return;
  const id = `${userId}:${key}`;
  const now = Date.now();
  const list = (hits.get(id) ?? []).filter((t) => t > now - windowMs);
  if (list.length >= max) {
    hits.set(id, list);
    throw new ApiError(429, 'error-call-rate-limit', 'Muitas tentativas seguidas. Aguarde um minuto e tente de novo.');
  }
  list.push(now);
  hits.set(id, list);
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (!v.some((t) => t > now - 60_000)) hits.delete(k);
  }
}

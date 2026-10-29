import crypto from 'node:crypto';
import { EPHEMERAL_API_ENDPOINTS, type EphemeralAction, type EphemeralMessage } from '@shared/integrations';
import { newId } from '../lib/ids';
import { bus } from '../realtime/bus';

// Respostas que só a pessoa vê ("Só você vê isto"): vão para as conexões dela e não ficam gravadas em lugar nenhum.

// Marca da sessão de login, para o formulário abrir sozinho só na aba que pediu (o id da sessão não sai do servidor).
export function sessionTag(sessionId: string): string {
  return crypto.createHash('sha256').update(`ephemeral:${sessionId}`).digest('base64url').slice(0, 16);
}

const allowedAction = (a: EphemeralAction): boolean => {
  if (a.kind === 'api') return (EPHEMERAL_API_ENDPOINTS as readonly string[]).includes(a.endpoint);
  if (a.kind === 'url') {
    try {
      return new URL(a.url).protocol === 'https:';
    } catch {
      return false;
    }
  }
  return a.kind === 'modal';
};

export function sendEphemeral(userId: string, m: Omit<EphemeralMessage, '_id' | 'ts'>): EphemeralMessage {
  const message: EphemeralMessage = {
    ...m,
    _id: newId(),
    ts: new Date().toISOString(),
    ...(m.issues ? { issues: m.issues.slice(0, 10) } : {}),
    ...(m.actions ? { actions: m.actions.filter(allowedAction).slice(0, 3) } : {}),
  };
  bus.publish({ user: userId }, { type: 'ephemeral', message });
  return message;
}

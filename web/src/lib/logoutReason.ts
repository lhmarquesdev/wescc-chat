// Motivo de uma saída forçada (o servidor manda junto com force_logout): a tela de entrar explica o que aconteceu.
// Fica no sessionStorage só até a tela de entrar ler.
import type { LogoutReason } from '@shared/index';

const KEY = 'wescc.logoutReason';

export const LOGOUT_REASON_TEXT: Record<LogoutReason, string> = {
  'e2e-reset':
    'Um administrador redefiniu sua criptografia. Entre de novo e configure uma senha nova da criptografia; as mensagens criptografadas antigas não poderão ser lidas.',
};

export function rememberLogoutReason(reason: LogoutReason | undefined) {
  if (!reason || !(reason in LOGOUT_REASON_TEXT)) return;
  try {
    sessionStorage.setItem(KEY, reason);
  } catch {
    // armazenamento indisponível: a tela de entrar abre sem o motivo
  }
}

export function peekLogoutReason(): LogoutReason | null {
  try {
    const v = sessionStorage.getItem(KEY);
    return v && v in LOGOUT_REASON_TEXT ? (v as LogoutReason) : null;
  } catch {
    return null;
  }
}

export function clearLogoutReason() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignora
  }
}

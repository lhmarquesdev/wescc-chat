// Motivo de uma saída forçada (o servidor manda junto com force_logout; "ended" quando a API recusa a sessão): a tela
// de entrar explica o que aconteceu. Fica no sessionStorage até a pessoa sair da tela de entrar (entrando ou indo para
// outra tela): recarregar a página, inclusive o recarregamento que vem logo depois da saída, não apaga o aviso.
import type { LogoutReason } from '@shared/index';
import type { IconName } from '../components/Icon';

const KEY = 'wescc.logoutReason';

export const LOGOUT_REASON_TEXT: Record<LogoutReason, string> = {
  'e2e-reset':
    'Um administrador redefiniu sua criptografia. Entre de novo e configure uma senha nova da criptografia; as mensagens criptografadas antigas não poderão ser lidas.',
  deactivated: 'Sua conta foi desativada. Se precisar de acesso, fale com o administrador.',
  'admin-logout': 'Um administrador encerrou a sua sessão. Entre de novo para continuar.',
  'password-changed': 'Sua senha foi alterada e as sessões abertas foram encerradas. Entre com a senha nova.',
  'session-revoked': 'Sua sessão foi encerrada em outro dispositivo. Entre de novo para continuar.',
  ended: 'Sua sessão terminou. Entre de novo para continuar.',
};

// Ícone do aviso na tela de entrar.
export const LOGOUT_REASON_ICON: Record<LogoutReason, IconName> = {
  'e2e-reset': 'e2e-key',
  deactivated: 'disabled-user',
  'admin-logout': 'logout',
  'password-changed': 'security',
  'session-revoked': 'devices',
  ended: 'logout',
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

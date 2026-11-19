import { plural } from './format';
import { useSetting } from './store';

// Dica dos campos de senha nova com todas as regras ligadas em Administração › Configurações › Contas › Senha, para a
// pessoa não descobrir as regras errando (o servidor confere de novo em validatePassword).
export function passwordPolicyHint(p: { min?: number; upper?: boolean; number?: boolean; special?: boolean }) {
  const extra = [p.upper && 'uma letra maiúscula', p.number && 'um número', p.special && 'um caractere especial'].filter((x): x is string => !!x);
  const list = extra.length > 1 ? `${extra.slice(0, -1).join(', ')} e ${extra[extra.length - 1]}` : extra[0];
  const min = Number(p.min) > 0 ? `Mínimo de ${plural(Number(p.min), 'caractere', 'caracteres')}` : '';
  if (min) return list ? `${min}, com ${list}.` : `${min}.`;
  return list ? `Precisa ter ${list}.` : undefined;
}

export function usePasswordHint() {
  return passwordPolicyHint({
    min: useSetting<number>('Accounts_Password_Policy_MinLength'),
    upper: useSetting<boolean>('Accounts_Password_Policy_AtLeastOneUppercase'),
    number: useSetting<boolean>('Accounts_Password_Policy_AtLeastOneNumber'),
    special: useSetting<boolean>('Accounts_Password_Policy_AtLeastOneSpecialCharacter'),
  });
}

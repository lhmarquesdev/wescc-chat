// Links de convite: a situação que o servidor calcula (listInvites.status), com o rótulo e a cor do selo. O mesmo texto
// no painel da sala e em Administração › Convites.
export type InviteStatus = 'active' | 'expired' | 'used-up' | 'archived' | 'invalid';

export const INVITE_STATUS: Record<InviteStatus, { label: string; tone: string; hint: string }> = {
  active: { label: 'Ativo', tone: 'ok', hint: 'O link funciona.' },
  expired: { label: 'Expirado', tone: 'off', hint: 'O prazo do link acabou.' },
  'used-up': { label: 'Esgotado', tone: 'warn', hint: 'O link já foi usado o número máximo de vezes.' },
  archived: { label: 'Sala arquivada', tone: 'off', hint: 'A sala foi arquivada e não recebe mais pessoas.' },
  invalid: { label: 'Sem efeito', tone: 'err', hint: 'Quem criou o link saiu da sala, foi desativado ou não pode mais convidar.' },
};

export const inviteStatusOf = (s: string) => INVITE_STATUS[s as InviteStatus] ?? INVITE_STATUS.invalid;

// "2 de 5 usos" ou, sem limite, "2 usos".
export function inviteUses(i: { uses: number; maxUses: number }) {
  const n = i.uses.toLocaleString('pt-BR');
  if (i.maxUses) return `${n} de ${i.maxUses.toLocaleString('pt-BR')} ${i.maxUses === 1 ? 'uso' : 'usos'}`;
  return `${n} ${i.uses === 1 ? 'uso' : 'usos'}`;
}

import { ICONS, type IconName } from './icons';

export type { IconName } from './icons';

export type IconSize = 12 | 14 | 16 | 18 | 20 | 22 | 24 | 32;

// Ícone de linha em currentColor. Sem label ele é decorativo (aria-hidden); com label vira uma imagem com nome.
// Botão só com ícone: mantenha o title de hoje (os testes E2E usam) e dê o mesmo texto em aria-label no botão.
export function Icon({ name, size = 16, label, fill, className }: { name: IconName; size?: IconSize; label?: string; fill?: boolean; className?: string }) {
  const C = ICONS[name];
  return (
    <C
      size={size}
      strokeWidth={size >= 24 ? 1.5 : 1.75}
      fill={fill ? 'currentColor' : 'none'}
      className={className ? `icon ${className}` : 'icon'}
      focusable="false"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    />
  );
}

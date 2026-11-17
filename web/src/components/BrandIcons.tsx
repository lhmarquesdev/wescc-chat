import type { OAuthProviderType } from '@shared/index';
import { useId } from 'react';
import { Icon, type IconSize } from './Icon';

// Marcas dos provedores de login. GitHub, GitLab e Google vêm do Simple Icons (CC0-1.0), em currentColor;
// a Microsoft é o logo de quatro quadrados nas cores oficiais.
const PATHS = {
  github:
    'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  gitlab:
    'm23.6 9.593-.033-.086L20.3.98a.851.851 0 0 0-.336-.405.875.875 0 0 0-1 .054.875.875 0 0 0-.29.44L16.47 7.818H7.537L5.333 1.07a.857.857 0 0 0-.29-.441.875.875 0 0 0-1-.054.859.859 0 0 0-.336.405L.433 9.502l-.032.086a6.066 6.066 0 0 0 2.012 7.01l.01.009.03.021 4.977 3.727 2.462 1.863 1.5 1.132a1.008 1.008 0 0 0 1.22 0l1.499-1.132 2.461-1.863 5.006-3.75.013-.01a6.068 6.068 0 0 0 2.01-7.002z',
  google:
    'M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z',
} as const;

const svgProps = (size: number, label?: string) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  className: 'icon brand-icon',
  focusable: 'false' as const,
  'aria-hidden': label ? undefined : true,
  role: label ? 'img' : undefined,
  'aria-label': label,
});

export function GithubIcon({ size = 18, label }: { size?: number; label?: string }) {
  return (
    <svg {...svgProps(size, label)} fill="currentColor">
      <path d={PATHS.github} />
    </svg>
  );
}

export function GitlabIcon({ size = 18, label }: { size?: number; label?: string }) {
  return (
    <svg {...svgProps(size, label)} fill="currentColor">
      <path d={PATHS.gitlab} />
    </svg>
  );
}

export function GoogleIcon({ size = 18, label }: { size?: number; label?: string }) {
  return (
    <svg {...svgProps(size, label)} fill="currentColor">
      <path d={PATHS.google} />
    </svg>
  );
}

export function MicrosoftIcon({ size = 18, label }: { size?: number; label?: string }) {
  return (
    <svg {...svgProps(size, label)}>
      <rect x="1" y="1" width="10.5" height="10.5" fill="#f25022" />
      <rect x="12.5" y="1" width="10.5" height="10.5" fill="#7fba00" />
      <rect x="1" y="12.5" width="10.5" height="10.5" fill="#00a4ef" />
      <rect x="12.5" y="12.5" width="10.5" height="10.5" fill="#ffb900" />
    </svg>
  );
}

// A marca do produto, na linha do logo do Atendeti: um monograma inclinado de fita dobrada, sem moldura.
// O "W" tem os traços que sobem na cor da marca e os que descem em degradê mais escuro (a dobra da fita).
// As cores vêm de --mark-flat, --mark-fold-a e --mark-fold-b (base.css): azul da marca no claro, branco sobre a marca.
// O mesmo desenho está em public/favicon.svg, de onde saem os ícones do PWA (scripts/visual/brand-icons.mjs).
export function BrandMark({ size = 28 }: { size?: number }) {
  const id = useId();
  return (
    <span className="brand-mark" style={{ height: size, width: Math.round((size * 114.5) / 84) }} aria-hidden="true">
      <svg viewBox="-2 -2 114.5 84" strokeLinejoin="round" strokeWidth="3" focusable="false">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0.35" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--mark-fold-a)' }} />
            <stop offset="1" style={{ stopColor: 'var(--mark-fold-b)' }} />
          </linearGradient>
        </defs>
        <g fill={`url(#${id})`} stroke={`url(#${id})`}>
          <polygon points="0,0 18,0 31.6,80 13.6,80" />
          <polygon points="42.6,22 60.6,22 70.46,80 52.46,80" />
        </g>
        <g style={{ fill: 'var(--mark-flat)', stroke: 'var(--mark-flat)' }}>
          <polygon points="13.6,80 31.6,80 60.6,22 42.6,22" />
          <polygon points="52.46,80 70.46,80 110.46,0 92.46,0" />
        </g>
      </svg>
    </span>
  );
}

// Ícone pelo tipo do provedor OAuth; o tipo "custom" usa a chave do registro.
export function ProviderIcon({ type, size = 18 }: { type: OAuthProviderType; size?: IconSize }) {
  if (type === 'github') return <GithubIcon size={size} />;
  if (type === 'gitlab') return <GitlabIcon size={size} />;
  if (type === 'google') return <GoogleIcon size={size} />;
  if (type === 'microsoft') return <MicrosoftIcon size={size} />;
  return <Icon name="tokens" size={size} />;
}

import { Fragment } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useStore } from '../lib/store';
import { ADMIN_SECTIONS } from '../pages/admin/sections';
import { Icon } from './Icon';
import { UserMenu, setTheme, useMyStatus } from './Sidebar';
import { StatusDot } from './ui';

// Barra do topo (padrão Atendeti): recolher o menu, trilha "Wescchat › Área › Página", tema e a pessoa.

const AREAS: [RegExp, string, string][] = [
  [/^\/home/, 'Início', '/home'],
  [/^\/calls/, 'Chamadas', '/calls'],
  [/^\/calendar/, 'Agenda', '/calendar'],
  [/^\/reminders/, 'Lembretes', '/reminders'],
  [/^\/files/, 'Arquivos', '/files'],
  [/^\/directory/, 'Diretório', '/directory'],
  [/^\/meet\//, 'Reunião', ''],
  [/^\/account/, 'Minha conta', '/account/profile'],
  [/^\/admin/, 'Administração', '/admin'],
];
const ACCOUNT: Record<string, string> = {
  profile: 'Perfil',
  preferences: 'Preferências',
  stickers: 'Figurinhas',
  security: 'Segurança',
  devices: 'Dispositivos',
  data: 'Meus dados',
  tokens: 'Tokens de acesso',
  connected: 'Contas conectadas',
};

function useTrail(): { label: string; to?: string }[] {
  const { pathname } = useLocation();
  const subs = useStore((s) => s.subscriptions);
  const rooms = useStore((s) => s.rooms);
  const room = /^\/(channel|group|direct)\/([^/]+)/.exec(pathname);
  if (room) {
    const sub = subs[room[2]] ?? Object.values(subs).find((s) => s.name === room[2]);
    // Sem inscrição (prévia de um canal, sala excluída com a conversa aberta): o nome que se conhece da sala.
    const known = room[1] !== 'direct' ? rooms[room[2]] : undefined;
    return [{ label: 'Conversas', to: '/home' }, { label: sub?.fname || sub?.name || known?.fname || known?.name || 'Conversa' }];
  }
  const area = AREAS.find(([re]) => re.test(pathname));
  if (!area) return [{ label: 'Início' }];
  const [, section] = /^\/(?:admin|account)\/([^/]+)/.exec(pathname) ?? [];
  const leaf = pathname.startsWith('/admin') ? ADMIN_SECTIONS.find((s) => s.id === section)?.label : pathname.startsWith('/account') ? ACCOUNT[section ?? ''] : undefined;
  return leaf ? [{ label: area[1], to: area[2] }, { label: leaf }] : [{ label: area[1] }];
}

export function ThemeToggle() {
  const pref = useStore((s) => String(s.me?.preferences?.theme ?? 'auto'));
  const dark = pref === 'dark' || (pref !== 'light' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  const label = dark ? 'Usar tema claro' : 'Usar tema escuro';
  return (
    <button type="button" className="theme-toggle" title={label} aria-label={label} onClick={() => void setTheme(dark ? 'light' : 'dark')}>
      <Icon name={dark ? 'theme-light' : 'theme-dark'} size={20} fill />
    </button>
  );
}

/** Duas letras para o avatar da marca (nome e sobrenome, ou as duas primeiras do usuário). */
function initials(name: string) {
  // Letras e algarismos de cada parte: um emoji no começo do nome não vira meio caractere ("�").
  const parts = name.trim().split(/\s+/).map((p) => p.match(/[\p{L}\p{N}]/gu) ?? []).filter((p) => p.length);
  const two = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts.length ? parts[0].slice(0, 2).join('') : (Array.from(name.trim())[0] ?? '');
  return two.toUpperCase();
}

export function Topbar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const me = useStore((s) => s.me)!;
  const site = useStore((s) => (s.settings.Site_Name as string | undefined) || 'Wescchat');
  const { status, line, silenced } = useMyStatus();
  const trail = useTrail();
  const toggleLabel = collapsed ? 'Expandir menu' : 'Recolher menu';
  return (
    <header className="topbar">
      <button type="button" className="topbar-trigger" title={toggleLabel} aria-label={toggleLabel} aria-pressed={collapsed} onClick={onToggle}>
        <Icon name="side-toggle" />
      </button>
      <span className="topbar-sep" aria-hidden="true" />
      <nav className="crumbs" aria-label="Você está em">
        <span className="crumb">{site}</span>
        {trail.map((t, i) => (
          <Fragment key={i}>
            <Icon name="next" size={14} className="crumb-sep" />
            {t.to && i < trail.length - 1 ? (
              <Link to={t.to} className="crumb">
                {t.label}
              </Link>
            ) : (
              <span className="crumb current" aria-current="page">
                {t.label}
              </span>
            )}
          </Fragment>
        ))}
      </nav>
      <div className="topbar-end">
        <ThemeToggle />
        <span className="topbar-sep tall" aria-hidden="true" />
        <UserMenu
          placement="bottom-end"
          trigger={
            <button type="button" className="me-btn" title={`${me.name} · ${line}`}>
              {/* O próprio status sempre à vista (o ponto e a linha, com o sino cortado quando silencia): quem fica
                  Ocupado ou Invisível não esquece. */}
              <span className="avatar-wrap" aria-hidden="true">
                <span className="me-avatar">{initials(me.name || me.username)}</span>
                <StatusDot username={me.username} status={status} statusCustom={me.statusCustom} />
              </span>
              <span className="me-text">
                <span className="me-name">{me.name}</span>
                <span className="me-status">
                  <span className="me-status-text">{line}</span>
                  {silenced && <Icon name="notify-silenced" size={12} className="me-silenced" label="Notificações silenciadas" />}
                </span>
              </span>
              <Icon name="chevron-down" className="me-chevron" />
            </button>
          }
        />
      </div>
    </header>
  );
}

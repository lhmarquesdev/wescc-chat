import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { Menu, UserAvatar } from '../../components/ui';
import { formatDateTime, roleLabel } from '../../lib/format';

// Peças comuns das páginas de Administração e Minha conta.

const nf = new Intl.NumberFormat('pt-BR');
const hm = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
});

// Cabeçalho da seção (56px, preso no alto): título com a contagem opcional e as ações à direita, a principal por último.
export function PageHead({ title, count, children }: { title: ReactNode; count?: number; children?: ReactNode }) {
  return (
    <div className="page-title-row page-head">
      <h1>
        {title}
        {count !== undefined && <span className="pill head-count">{nf.format(count)}</span>}
      </h1>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

// Status de conta: pill com ponto, verde quando ativa.
export function ActivePill({ active, on = 'Ativo', off = 'Desativado' }: { active: boolean; on?: string; off?: string }) {
  return <span className={active ? 'pill ok dot' : 'pill dot'}>{active ? on : off}</span>;
}

// Papéis como pills com o nome em português, numa linha só: o administrador primeiro, o papel base
// (Usuário) só quando é o único, e o excedente em "+N". Dois papéis curtos cabem lado a lado.
export function RolePills({ roles }: { roles: string[] }) {
  if (!roles.length) return <span className="muted">—</span>;
  const visible = roles.length > 1 ? roles.filter((r) => r !== 'user') : roles;
  const sorted = [...visible].sort((a, b) => Number(b === 'admin') - Number(a === 'admin'));
  const fitsTwo = sorted.length === 2 && roleLabel(sorted[0]).length + roleLabel(sorted[1]).length <= 24;
  const shown = fitsTwo ? sorted : sorted.slice(0, 1);
  const rest = sorted.slice(shown.length);
  return (
    <span className="role-pills">
      {shown.map((r) => (
        <span key={r} className={r === 'admin' ? 'pill accent' : 'pill'}>
          {roleLabel(r)}
        </span>
      ))}
      {rest.length > 0 && (
        <span className="pill" title={rest.map(roleLabel).join(', ')} aria-label={`Mais ${rest.length}: ${rest.map(roleLabel).join(', ')}`}>
          +{rest.length}
        </span>
      )}
    </span>
  );
}

// Pessoa numa célula: avatar 28, nome 14/500 (com uma etiqueta opcional) e @usuário embaixo. Sem nome
// (as sessões só trazem o usuário), o @usuário vira a linha de cima e não se repete.
export function UserCell({ username, name, status, tag, sub }: { username: string; name?: string; status?: string; tag?: ReactNode; sub?: ReactNode }) {
  const hasName = !!name && name !== username;
  const second = hasName ? (
    <>
      @{username}
      {sub && <> · {sub}</>}
    </>
  ) : (
    sub
  );
  return (
    <div className="cell-entity">
      <UserAvatar username={username} size={28} status={status} />
      <div>
        <span className="cell-name">
          {hasName ? name : `@${username}`}
          {tag}
        </span>
        {second && <span className="cell-sub">{second}</span>}
      </div>
    </div>
  );
}

// Sala numa célula: ícone do tipo num quadrado de 28 e o nome; embaixo, um detalhe opcional.
export function RoomCell({ icon, name, sub }: { icon: ReactNode; name: ReactNode; sub?: ReactNode }) {
  return (
    <div className="cell-entity">
      <span className="cell-icon">{icon}</span>
      <div>
        <span className="cell-name">{name}</span>
        {sub && <span className="cell-sub">{sub}</span>}
      </div>
    </div>
  );
}

// "Agora", "há 4 min", "hoje, 07:58", "ontem, 18:02"; depois disso, a data e a hora.
export function lastSeen(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  const min = Math.round((Date.now() - d.getTime()) / 60000);
  if (min < 1) return 'Agora';
  if (min < 60) return `há ${min} min`;
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return `hoje, ${hm.format(d)}`;
  if (d.toDateString() === yesterday.toDateString()) return `ontem, ${hm.format(d)}`;
  return formatDateTime(iso);
}

type Device = { name?: string; os?: string; browser?: string; type?: string };

// O servidor monta "Chrome em Windows"; partes desconhecidas viram "Navegador desconhecido".
export function deviceLabel(d: Device) {
  const name = String(d.name ?? '');
  if (/^(Outro|API)?\s*em\s+Desconhecido$/i.test(name) || /^Outro\b/i.test(name)) return d.os && d.os !== 'Desconhecido' ? `Navegador desconhecido em ${d.os}` : 'Navegador desconhecido';
  return name.replace(/ em Desconhecido$/, '') || 'Navegador desconhecido';
}

export function isMobileDevice(d: Device) {
  return d.os === 'Android' || d.os === 'iOS' || d.type === 'mobile';
}

// Ícone do dispositivo num quadrado de 28, para a célula da tabela de sessões.
export function DeviceIcon({ device }: { device: Device }) {
  return (
    <span className="cell-icon">
      <Icon name={isMobileDevice(device) ? 'device-mobile' : 'device-desktop'} />
    </span>
  );
}

// Dispositivo numa célula (Minha conta e Administração): ícone, "Chrome em Linux" e o IP embaixo.
export function DeviceCell({ device, tag }: { device: Device & { ip?: string }; tag?: ReactNode }) {
  return (
    <div className="cell-entity">
      <DeviceIcon device={device} />
      <div>
        <span className="cell-name">
          {deviceLabel(device)}
          {tag}
        </span>
        {device.ip && <span className="cell-sub mono">{device.ip}</span>}
      </div>
    </div>
  );
}

// Invólucro das tabelas: rola de lado (com a borda direita esmaecida) para a página nunca rolar, e as
// colunas .col-xl, .col-lg e .col-md somem conforme a largura da área (ver admin.css).
export function TableWrap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `table-wrap ${className}` : 'table-wrap'}>{children}</div>;
}

// Menu "Mais ações" de uma linha de tabela (quando há mais de 2 ações). Os cliques (também os do portal,
// que sobem pela árvore do React) param aqui para não abrir a linha.
export function RowMenu({ label = 'Mais ações', children }: { label?: string; children: (close: () => void) => ReactNode }) {
  return (
    <span className="row-menu" onClick={(e) => e.stopPropagation()}>
      <Menu
        label={label}
        trigger={
          <button type="button" className="btn small ghost icon-only" title={label} aria-label={label}>
            <Icon name="more" />
          </button>
        }
      >
        {children}
      </Menu>
    </span>
  );
}

// Valor de uma configuração/estatística ausente.
export const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
export const num = (v?: number | null) => (v === null || v === undefined ? '—' : nf.format(v));

// Na faixa de seções do celular (navegação que rola de lado), traz a seção ativa para o meio. Mexe só na
// rolagem horizontal da própria faixa; no desktop a lista é vertical e não rola de lado, então nada muda.
export function useActiveNavInView(section: string) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = ref.current;
    const a = nav?.querySelector<HTMLElement>('a.active, [aria-current="page"]');
    if (!nav || !a || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollLeft = a.offsetLeft - (nav.clientWidth - a.offsetWidth) / 2;
  }, [section]);
  return ref;
}

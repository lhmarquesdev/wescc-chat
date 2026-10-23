import { Component, useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { getCredentials } from './lib/api';
import { loadPublicSettings, logout, requestNotificationPermission, startSession } from './lib/session';
import { useStore } from './lib/store';
import { Sidebar } from './components/Sidebar';
import { MobileTabBar } from './components/MobileTabBar';
import { markCallsSeen, useMissedCalls } from './components/navState';
import { useIsPhone } from './components/overlay';
import { BrandMark } from './components/BrandIcons';
import { Icon } from './components/Icon';
import { Empty, Spinner, Toasts } from './components/ui';
import { CallOverlay } from './components/CallOverlay';
import { ChangePasswordPage, ForgotPasswordPage, InvitePage, LoginPage, RegisterPage, ResetPasswordPage } from './pages/AuthPages';
import { DirectoryPage, HomePage } from './pages/HomeDirectory';
import { RoomPage } from './pages/RoomPage';
import { AccountPage, applyTheme, TwoFactorCard } from './pages/AccountPage';
import { AdminPage } from './pages/admin/AdminPage';
import { OmnichannelPage } from './pages/omnichannel/OmnichannelPage';
import { CallsPage } from './pages/CallsPage';

function useCustomCss() {
  const css = useStore((s) => s.settings.Layout_Custom_CSS as string | undefined);
  useEffect(() => {
    let el = document.getElementById('custom-css') as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = 'custom-css';
      document.head.appendChild(el);
    }
    el.textContent = css ?? '';
  }, [css]);
}

function useTitle() {
  const site = useStore((s) => s.settings.Site_Name as string | undefined);
  const unread = useStore((s) => Object.values(s.subscriptions).reduce((n, x) => n + (x.alert || x.unread ? 1 : 0), 0));
  useEffect(() => {
    // Antes das configurações chegarem fica o título do index.html.
    if (site) document.title = `${unread ? `(${unread}) ` : ''}${site}`;
  }, [site, unread]);
}

// Tela de abertura: a marca com o indicador de carregamento embaixo.
function Boot() {
  return (
    <div className="fullscreen-center boot">
      <BrandMark size={40} />
      <Spinner />
    </div>
  );
}

// Erro de renderização numa tela: mostra o estado de erro em vez de uma página em branco.
// Mudar de rota limpa o erro sem remontar a tela que funciona (abrir um tópico mantém a sala).
class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(error);
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page">
        <Empty
          icon="error"
          tone="danger"
          title="Algo deu errado"
          action={
            <>
              <Link className="btn primary" to="/home">
                Voltar às conversas
              </Link>
              <button type="button" className="btn" onClick={() => location.reload()}>
                Recarregar
              </button>
            </>
          }
        >
          Recarregue a página. Se continuar, avise o suporte.
        </Empty>
      </div>
    );
  }
}

const ROOM_ROUTE = /^\/(channel|group|direct|live)\//;

// Abrir Chamadas zera o contador de chamadas perdidas (inclusive as que chegam com a página aberta).
function useCallsSeen(onCalls: boolean) {
  const { count } = useMissedCalls();
  useEffect(() => {
    if (onCalls && count) markCallsSeen();
  }, [onCalls, count]);
}

function Protected() {
  const me = useStore((s) => s.me);
  const connected = useStore((s) => s.connected);
  const [state, setState] = useState<'loading' | 'ready' | 'anon'>(me ? 'ready' : getCredentials() ? 'loading' : 'anon');
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const phone = useIsPhone();
  const { pathname } = location;
  // No celular, /home é a lista de conversas; as salas escondem a barra de abas.
  const view = pathname === '/home' ? 'list' : ROOM_ROUTE.test(pathname) ? 'room' : 'page';
  const asList = phone && view === 'list';
  useCallsSeen(pathname === '/calls');

  useEffect(() => {
    if (state !== 'loading') return;
    startSession()
      .then(() => setState('ready'))
      .catch(() => setState('anon'));
  }, [state]);

  useEffect(() => {
    if (me) {
      applyTheme(String(me.preferences?.theme ?? 'auto'));
      requestNotificationPermission();
    }
  }, [me?._id, me?.preferences?.theme]);

  useEffect(() => setNavOpen(false), [location.pathname]);

  // Celular: a navegação de seções vira uma faixa que rola para o lado; a seção aberta fica no meio dela.
  useEffect(() => {
    if (!phone) return;
    const id = requestAnimationFrame(() => document.querySelector('.page-nav a.active')?.scrollIntoView({ block: 'nearest', inline: 'center' }));
    return () => cancelAnimationFrame(id);
  }, [phone, pathname]);

  if (state === 'anon' || (state === 'ready' && !me)) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (state === 'loading' || !me) return <Boot />;
  if (me.requirePasswordChange) return <ChangePasswordPage onDone={() => void startSession()} />;
  if (me.require2faSetup) {
    // O servidor bloqueia o resto da API até o 2FA ser configurado.
    return (
      <div className="fullscreen-center">
        <div className="narrow">
          <h2>Autenticação em dois fatores obrigatória</h2>
          <p>O administrador exige autenticação em dois fatores. Configure um aplicativo autenticador para continuar.</p>
          <TwoFactorCard />
          <button className="btn" onClick={() => void logout().then(() => navigate('/login'))}>
            Sair
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`layout ${navOpen ? 'nav-open' : ''}`} data-view={view}>
      {/* Celular fora da lista: a gaveta fica fora da tela e fora do Tab e do leitor de tela. */}
      <aside className="sidebar-wrap" inert={phone && !asList && !navOpen}>
        {asList && !connected && <OfflineBar />}
        <Sidebar onNavigate={() => setNavOpen(false)} mode={asList ? 'list' : 'side'} />
      </aside>
      <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} />
      <main className="main">
        {/* Gaveta antiga: fica como reserva, escondida (a barra de abas e o voltar das salas substituem). */}
        <button className="mobile-nav-btn" aria-label="Abrir menu" onClick={() => setNavOpen(true)}>
          <Icon name="nav-menu" />
        </button>
        {!connected && <OfflineBar />}
        {!asList && (
          <ErrorBoundary resetKey={pathname}>
            <Outlet />
          </ErrorBoundary>
        )}
      </main>
      {phone && view !== 'room' && <MobileTabBar />}
      <CallOverlay />
    </div>
  );
}

function OfflineBar() {
  return (
    <div className="offline-bar" role="status">
      <Icon name="offline" size={14} />
      Reconectando…
    </div>
  );
}

function InviteRoute() {
  const me = useStore((s) => s.me);
  return <InvitePage loggedIn={!!me || !!getCredentials()} />;
}

function Shell() {
  const [ready, setReady] = useState(false);
  useCustomCss();
  useTitle();
  useEffect(() => {
    loadPublicSettings()
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);
  if (!ready) return <Boot />;
  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/register/:secret" element={<RegisterPage />} />
        <Route path="/invite/:token" element={<InviteRoute />} />
        <Route element={<Protected />}>
          <Route path="/home" element={<HomePage />} />
          <Route path="/directory" element={<DirectoryPage />} />
          <Route path="/directory/:tab" element={<DirectoryPage />} />
          {['channel', 'group', 'direct', 'live'].map((t) => (
            <Route key={t} path={`/${t}/:rid/*`} element={<RoomPage />} />
          ))}
          <Route path="/calls" element={<CallsPage />} />
          <Route path="/account" element={<Navigate to="/account/profile" replace />} />
          <Route path="/account/:section" element={<AccountPage />} />
          <Route path="/admin" element={<Navigate to="/admin/info" replace />} />
          <Route path="/admin/:section" element={<AdminPage />} />
          <Route path="/admin/:section/:view" element={<AdminPage />} />
          <Route path="/admin/:section/:view/:param" element={<AdminPage />} />
          <Route path="/omnichannel" element={<Navigate to="/omnichannel/queue" replace />} />
          <Route path="/omnichannel/:section" element={<OmnichannelPage />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Route>
      </Routes>
      <Toasts />
    </>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}

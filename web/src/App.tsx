import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { getCredentials } from './lib/api';
import { loadPublicSettings, logout, requestNotificationPermission, startSession } from './lib/session';
import { useStore } from './lib/store';
import { Sidebar } from './components/Sidebar';
import { Spinner, Toasts } from './components/ui';
import { ChangePasswordPage, ForgotPasswordPage, InvitePage, LoginPage, RegisterPage, ResetPasswordPage } from './pages/AuthPages';
import { DirectoryPage, HomePage } from './pages/HomeDirectory';
import { RoomPage } from './pages/RoomPage';
import { AccountPage, applyTheme, TwoFactorCard } from './pages/AccountPage';
import { AdminPage } from './pages/admin/AdminPage';
import { OmnichannelPage } from './pages/omnichannel/OmnichannelPage';

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
    document.title = `${unread ? `(${unread}) ` : ''}${site ?? 'Chat'}`;
  }, [site, unread]);
}

function Protected() {
  const me = useStore((s) => s.me);
  const connected = useStore((s) => s.connected);
  const [state, setState] = useState<'loading' | 'ready' | 'anon'>(me ? 'ready' : getCredentials() ? 'loading' : 'anon');
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

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

  if (state === 'anon' || (state === 'ready' && !me)) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (state === 'loading' || !me) return <div className="fullscreen-center"><Spinner /></div>;
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
    <div className={`layout ${navOpen ? 'nav-open' : ''}`}>
      <aside className="sidebar-wrap">
        <Sidebar onNavigate={() => setNavOpen(false)} />
      </aside>
      <div className="sidebar-backdrop" onClick={() => setNavOpen(false)} />
      <main className="main">
        <button className="mobile-nav-btn" aria-label="Abrir menu" onClick={() => setNavOpen(true)}>
          ☰
        </button>
        {!connected && <div className="offline-bar">Reconectando…</div>}
        <Outlet />
      </main>
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
  if (!ready) return <div className="fullscreen-center"><Spinner /></div>;
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
          <Route path="/account" element={<Navigate to="/account/profile" replace />} />
          <Route path="/account/:section" element={<AccountPage />} />
          <Route path="/admin" element={<Navigate to="/admin/info" replace />} />
          <Route path="/admin/:section" element={<AdminPage />} />
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

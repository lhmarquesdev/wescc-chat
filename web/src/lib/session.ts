import type { Role, UserStatus } from '@shared/index';
import { api, getCredentials, setCredentials, setUnauthorizedHandler } from './api';
import { setCustomEmoji } from './emoji';
import { syncPushSubscription, unsubscribeOnLogout } from './push';
import { realtime } from './realtime';
import { useStore, type Me } from './store';
import { roomPath, setRoleDescriptions } from './format';

export async function loadPublicSettings() {
  const r = await api.get('settings.public');
  useStore.getState().setSettings(Object.fromEntries(r.settings.map((s: any) => [s._id, s.value])));
}

export async function loadSubscriptions() {
  const r = await api.get('subscriptions.get');
  useStore.getState().setSubscriptions(r.update);
}

export async function loadPermissionMap() {
  const [r, roles] = await Promise.all([api.get('permissions.listAll').catch(() => null), api.get('roles.list').catch(() => null)]);
  if (r) useStore.setState({ permMap: Object.fromEntries(r.update.map((p: any) => [p._id, p.roles])) });
  if (roles) {
    setRoleDescriptions(roles.roles as Role[]);
    useStore.setState({ restrictedRoles: (roles.roles as Role[]).filter((x) => x.restrictDirect).map((x) => x._id) });
  }
}

export async function loadCustomEmoji() {
  const r = await api.get('emoji-custom.list').catch(() => null);
  if (r) setCustomEmoji(r.emojis.update);
}

export async function loadLivechat() {
  const st = useStore.getState();
  const me = st.me;
  if (!me || !st.settings.Livechat_enabled) return;
  if (!me.roles.some((r) => ['livechat-agent', 'livechat-manager', 'livechat-monitor', 'admin'].includes(r))) return;
  const [q, status] = await Promise.all([api.get('livechat/inquiries.queuedForUser').catch(() => null), me.roles.includes('livechat-agent') ? api.get('livechat/agent.status').catch(() => null) : null]);
  useStore.setState({
    queue: q ? Object.fromEntries(q.inquiries.map((i: any) => [i.rid, i])) : {},
    agentStatus: status?.status ?? null,
  });
}

let started = false;

// Quem já está online ao abrir o chat (depois disso, os eventos de presença mantêm o mapa em dia).
async function loadPresence() {
  const r = (await api.get('users.presence').catch(() => null)) as { users: { username: string; status: UserStatus; statusText?: string }[] } | null;
  if (!r) return;
  const presence: Record<string, { status: UserStatus; statusText?: string }> = {};
  for (const u of r.users) presence[u.username] = { status: u.status, statusText: u.statusText };
  useStore.setState({ presence });
}

export async function startSession() {
  const me = (await api.get('me')) as Me;
  useStore.getState().setMe(me);
  // Com troca de senha ou 2FA pendente o servidor só aceita as rotas para resolver isso: o resto fica para depois.
  if (me.requirePasswordChange || me.require2faSetup) return me;
  await Promise.all([loadSubscriptions(), loadCustomEmoji(), loadPermissionMap()]);
  void loadPresence();
  void loadLivechat();
  void syncPushSubscription();
  if (!started) {
    started = true;
    realtime.start(() => {
      // Ao reconectar, recarrega o que pode ter mudado. Eventos "user" podem ter se perdido: os papéis anunciados
      // deixam de valer por cima do que as telas buscam.
      useStore.setState({ userRoles: {} });
      void loadSubscriptions();
      void loadPresence();
      void api.get('me').then((m) => useStore.getState().setMe(m));
      void loadLivechat();
    });
    realtime.on((ev) => {
      if (ev.type === 'notification') showNotification(ev);
      if (ev.type === 'permissions.changed') {
        void api.get('me').then((m) => useStore.getState().setMe(m));
        void loadPermissionMap();
      }
      // Papéis trocados: me.permissions é calculado pelo servidor, então busca de novo.
      if (ev.type === 'user' && ev.user.roles && ev.user._id === useStore.getState().me?._id) void api.get('me').then((m) => useStore.getState().setMe(m));
      if (ev.type === 'settings.changed' && ev.settings.some((s) => s._id === '__emoji')) void loadCustomEmoji();
    });
  }
  return me;
}

export async function login(user: string, password: string, code?: string) {
  const r = await api.post('login', { user, password, code });
  setCredentials({ userId: r.data.userId, authToken: r.data.authToken });
  return startSession();
}

// Troca a credencial de uso único devolvida pelo SSO (/saml/acs ou /oauth/:id/callback) por uma sessão.
async function loginWithSso(method: 'saml' | 'oauth', credentialToken: string) {
  const r = await api.post('login', { [method]: true, credentialToken });
  setCredentials({ userId: r.data.userId, authToken: r.data.authToken });
  return startSession();
}

export const loginWithSaml = (credentialToken: string) => loginWithSso('saml', credentialToken);
export const loginWithOAuth = (credentialToken: string) => loginWithSso('oauth', credentialToken);

export async function logout() {
  await api.post('logout').catch(() => {});
  endSession();
}

export function endSession() {
  void unsubscribeOnLogout();
  setCredentials(null);
  realtime.stop();
  started = false;
  useStore.getState().reset();
  clearDrafts();
}

// Rascunhos ficam no navegador: ao sair, não podem ficar para o próximo usuário do computador.
function clearDrafts() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('wescc.draft.')) localStorage.removeItem(k);
  } catch {
    // armazenamento indisponível
  }
}

setUnauthorizedHandler(() => {
  if (getCredentials()) {
    endSession();
    if (!location.pathname.startsWith('/login')) location.href = '/login';
  }
});

// ---------- Notificações ----------

let audioCtx: AudioContext | null = null;
function beep() {
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.08, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.25);
  } catch {
    // sem áudio
  }
}

export function currentRoomId() {
  const m = location.pathname.match(/^\/(channel|group|direct|live)\/([^/]+)/);
  return m?.[2] ?? null;
}

function showNotification(ev: { rid: string; title: string; text: string; messageId: string; tmid?: string | null }) {
  const st = useStore.getState();
  if (!ev.rid) {
    st.toast(ev.text);
    return;
  }
  const focusedHere = document.hasFocus() && currentRoomId() === ev.rid;
  if (focusedHere) return;
  const prefs = st.me?.preferences ?? {};
  if (prefs.notificationSound !== false) beep();
  if ('Notification' in window && Notification.permission === 'granted' && !document.hasFocus()) {
    const sub = st.subscriptions[ev.rid];
    const n = new Notification(ev.title, { body: ev.text, tag: ev.messageId, icon: '/favicon.svg' });
    n.onclick = () => {
      window.focus();
      if (sub) history.pushState({}, '', roomPath(sub) + (ev.tmid ? `/thread/${ev.tmid}` : ''));
      dispatchEvent(new PopStateEvent('popstate'));
      n.close();
    };
  } else if (!focusedHere) {
    st.toast(`${ev.title}: ${ev.text}`);
  }
}

export function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    void Notification.requestPermission().then((p) => p === 'granted' && syncPushSubscription());
  }
}

import { api, getCredentials, setCredentials, setUnauthorizedHandler } from './api';
import { setCustomEmoji } from './emoji';
import { realtime } from './realtime';
import { useStore, type Me } from './store';
import { roomPath } from './format';

export async function loadPublicSettings() {
  const r = await api.get('settings.public');
  useStore.getState().setSettings(Object.fromEntries(r.settings.map((s: any) => [s._id, s.value])));
}

export async function loadSubscriptions() {
  const r = await api.get('subscriptions.get');
  useStore.getState().setSubscriptions(r.update);
}

export async function loadPermissionMap() {
  const r = await api.get('permissions.listAll').catch(() => null);
  if (r) useStore.setState({ permMap: Object.fromEntries(r.update.map((p: any) => [p._id, p.roles])) });
}

export async function loadCustomEmoji() {
  const r = await api.get('emoji-custom.list').catch(() => null);
  if (r) setCustomEmoji(r.emojis.update);
}

let started = false;

export async function startSession() {
  const me = (await api.get('me')) as Me;
  useStore.getState().setMe(me);
  await Promise.all([loadSubscriptions(), loadCustomEmoji(), loadPermissionMap()]);
  if (!started) {
    started = true;
    realtime.start(() => {
      // Ao reconectar, recarrega o que pode ter mudado.
      void loadSubscriptions();
      void api.get('me').then((m) => useStore.getState().setMe(m));
    });
    realtime.on((ev) => {
      if (ev.type === 'notification') showNotification(ev);
      if (ev.type === 'permissions.changed') {
        void api.get('me').then((m) => useStore.getState().setMe(m));
        void loadPermissionMap();
      }
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

export async function logout() {
  await api.post('logout').catch(() => {});
  endSession();
}

export function endSession() {
  setCredentials(null);
  realtime.stop();
  started = false;
  useStore.getState().reset();
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
  if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
}

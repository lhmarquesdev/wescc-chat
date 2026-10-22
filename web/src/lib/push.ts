// Notificações push (Web Push): o navegador recebe as mensagens mesmo com o chat fechado, pelo service worker (public/sw.js).
import { api } from './api';
import { useStore } from './store';

const OPT_OUT_KEY = 'wescc.push.off';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.register('/sw.js').catch(() => {});
}

function keyBytes(b64u: string) {
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function sameKey(a: ArrayBuffer | null | undefined, b64u: string) {
  if (!a) return false;
  const x = new Uint8Array(a);
  const y = keyBytes(b64u);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function optedOut() {
  try {
    return !!localStorage.getItem(OPT_OUT_KEY);
  } catch {
    return false;
  }
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

// Inscreve este navegador quando o push está ligado no servidor, a permissão já foi dada e a pessoa não desligou aqui.
export async function syncPushSubscription() {
  const settings = useStore.getState().settings;
  const key = settings.Push_VAPID_Public_Key as string | undefined;
  if (!pushSupported() || !settings.Push_enable || !key || Notification.permission !== 'granted' || optedOut()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    // A chave do servidor mudou: refaz a inscrição.
    if (sub && !sameKey(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
    await api.post('push.webSubscribe', { subscription: sub.toJSON() });
    return true;
  } catch {
    return false;
  }
}

export async function pushEnabledHere() {
  if (!pushSupported() || optedOut() || Notification.permission !== 'granted') return false;
  return !!(await currentSubscription().catch(() => null));
}

export async function enablePushHere() {
  try {
    localStorage.removeItem(OPT_OUT_KEY);
  } catch {
    // armazenamento indisponível
  }
  if (Notification.permission === 'default') await Notification.requestPermission();
  return syncPushSubscription();
}

export async function disablePushHere() {
  try {
    localStorage.setItem(OPT_OUT_KEY, '1');
  } catch {
    // armazenamento indisponível
  }
  const sub = await currentSubscription().catch(() => null);
  if (!sub) return;
  await api.post('push.webUnsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => false);
}

// Ao sair, o servidor apaga a inscrição junto com a sessão; o navegador também a cancela.
export async function unsubscribeOnLogout() {
  if (!pushSupported()) return;
  const sub = await currentSubscription().catch(() => null);
  await sub?.unsubscribe().catch(() => false);
}

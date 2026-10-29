import type { Role, UserStatus } from '@shared/index';
import { api, getCredentials, setCredentials, setSignedOutElsewhereHandler, setUnauthorizedHandler } from './api';
import { setCustomEmoji } from './emoji';
import { syncPushSubscription, unsubscribeOnLogout } from './push';
import { realtime } from './realtime';
import { handleStickerEvent, initStickers, invalidateStickers, resetStickers } from './stickers';
import { useStore, type Me } from './store';
import { roomPath, setRoleDescriptions } from './format';
// Integrações (Jira/Teams)
import { clearEphemeral, pushEphemeral } from './ephemeral';
import { loadIntegrationsMe, resetIntegrations, setExternalPresence } from './integrations';
import { invalidateSlashCommands } from './commands';
import { checkBuild } from './call/build';

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
  // Figurinhas: só o cache local deste usuário; a rede espera o seletor abrir.
  initStickers(me._id);
  await Promise.all([loadSubscriptions(), loadCustomEmoji(), loadPermissionMap()]);
  // Integrações (Jira/Teams): o estado da pessoa que acabou de entrar (nunca o da anterior na mesma aba)
  void loadIntegrationsMe(true);
  // Comandos de barra: a lista é por pessoa e pode ter mudado desde a última sessão nesta aba.
  invalidateSlashCommands();
  void loadPresence();
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
      // Eventos de figurinha podem ter se perdido na queda.
      invalidateStickers('org');
      invalidateStickers('mine');
      // Integrações (Jira/Teams): integrations.changed pode ter se perdido durante a queda
      void loadIntegrationsMe(true);
      invalidateSlashCommands();
      // A queda pode ter sido uma atualização do chat: o aviso de nova versão aparece logo.
      void checkBuild(true);
    });
    realtime.on((ev) => {
      if (ev.type === 'notification') showNotification(ev);
      if (ev.type === 'stickers.changed' || ev.type === 'sticker.removed') handleStickerEvent(ev);
      if (ev.type === 'permissions.changed') {
        void api.get('me').then((m) => useStore.getState().setMe(m));
        void loadPermissionMap();
        invalidateStickers('org');
        invalidateStickers('mine');
        invalidateSlashCommands();
        // Integrações (Jira/Teams): canMeet, canUse e canCreate de integrations.me saem das permissões
        void loadIntegrationsMe(true);
      }
      // Papéis trocados: me.permissions é calculado pelo servidor, então busca de novo.
      if (ev.type === 'user' && ev.user.roles && ev.user._id === useStore.getState().me?._id) {
        void api.get('me').then((m) => useStore.getState().setMe(m));
        invalidateStickers('org');
        invalidateStickers('mine');
        invalidateSlashCommands();
        void loadIntegrationsMe(true);
      }
      if (ev.type === 'settings.changed' && ev.settings.some((s) => s._id === '__emoji')) void loadCustomEmoji();
      // A cota e os limites pessoais vêm no catálogo pessoal.
      if (ev.type === 'settings.changed' && ev.settings.some((s) => s._id.startsWith('Stickers_Personal_'))) invalidateStickers('mine');
      // Integrações (Jira/Teams)
      if (ev.type === 'ephemeral') pushEphemeral(ev.message);
      if (ev.type === 'integrations.changed') {
        void loadIntegrationsMe(true);
        // /jira e /teams entram ou saem da lista de comandos com a integração.
        invalidateSlashCommands();
      }
      if (ev.type === 'presence.external') setExternalPresence(ev.userId, ev.presence);
      if (ev.type === 'integrations.alert') {
        const { href, text } = ev.alert;
        useStore.getState().toast(text, 'warning', {
          action: {
            label: 'Abrir',
            onClick: () => {
              history.pushState({}, '', href);
              dispatchEvent(new PopStateEvent('popstate'));
            },
          },
        });
      }
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
  // Ao sair o servidor derruba o socket e o realtime iria para /login antes do endSession: a limpeza vem antes do pedido.
  realtime.stop();
  clearDrafts();
  resetStickers();
  await api.post('logout').catch(() => {});
  endSession();
}

export function endSession() {
  void unsubscribeOnLogout();
  setCredentials(null);
  realtime.stop();
  started = false;
  useStore.getState().reset();
  // Integrações (Jira/Teams): nada da pessoa anterior fica na aba
  resetIntegrations();
  clearEphemeral();
  invalidateSlashCommands();
  clearDrafts();
  resetStickers();
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

// Saiu da conta em outra aba (num computador compartilhado, a pessoa acredita ter saído de todas): esta aba também sai.
// Outra pessoa entrou lá: a aba abre de novo com a conta dela (limpar aqui a tiraria da conta na outra aba).
export function signedOutElsewhere(why: 'gone' | 'other') {
  if (why === 'other') return location.reload();
  endSession();
  if (!location.pathname.startsWith('/login')) location.href = '/login';
}
setSignedOutElsewhereHandler(signedOutElsewhere);

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

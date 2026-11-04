// Criptografia de ponta a ponta no navegador: o estado (senha, chaves das conversas), quem entrega a chave para quem
// chega, a troca de chave e o cifrar e decifrar das mensagens. As contas ficam em crypto.ts; a tela, em components/e2e.
import { create } from 'zustand';
import type { E2EContent, E2EEnvelope, E2EFileRef, Message, Room, ServerEvent } from '@shared/index';
import { E2E_BATCH, E2E_FILE_NAME, E2E_FILE_TYPE, E2E_QUOTE_MAX, E2E_TEXT, mentionNames } from '@shared/e2e';
import { api, ApiError, uploadTo } from '../api';
import { useStore } from '../store';
import {
  decryptContent,
  decryptPrivateKey,
  E2eError,
  encryptContent,
  encryptFile,
  encryptPrivateKey,
  exportPkcs8WithPassword,
  fingerprint,
  generatePassphrase,
  generateRoomKey,
  generateUserKeys,
  importPrivateKey,
  importPublicKey,
  keyIdOf,
  newMessageId,
  unwrapRoomKey,
  wrapRoomKey,
} from './crypto';
import { clearKeystore, deleteKey, loadKey, saveKey } from './keystore';

export type E2eStatus = 'loading' | 'unsupported' | 'none' | 'locked' | 'ready';
export type E2eRoomState = 'ready' | 'creating' | 'waiting' | 'rotating' | 'error';
export type E2eViewState = 'ok' | 'pending' | 'waiting' | 'locked' | 'failed' | 'old-key';
export interface E2eView {
  state: E2eViewState;
  content?: E2EContent;
}

interface E2eStore {
  status: E2eStatus;
  rooms: Record<string, E2eRoomState>;
  version: number; // sobe quando chega uma chave ou uma mensagem é decifrada (as mensagens desenham de novo)
  waitUntil: number; // muitas senhas erradas: espera até este momento
}

export const useE2e = create<E2eStore>(() => ({ status: 'loading', rooms: {}, version: 0, waitUntil: 0 }));

// ---------- Textos ----------

export const E2E_UI = {
  ready: 'Esta conversa é criptografada de ponta a ponta.',
  none: 'Para ler e escrever aqui, configure a criptografia.',
  locked: 'Digite a senha da criptografia para ler e escrever nesta conversa.',
  waiting: 'Esperando a chave desta conversa. Ela chega quando outra pessoa da conversa estiver com o chat aberto.',
  preparing: 'Preparando a criptografia…',
  unsupported: 'A criptografia só funciona com o chat aberto em https.',
  error: 'Não foi possível preparar a criptografia desta conversa. Tente de novo.',
  wrongPassword: 'Senha incorreta.',
  tooMany: 'Muitas tentativas. Espere 30 segundos.',
} as const;

export const E2E_PLACEHOLDER: Record<Exclude<E2eViewState, 'ok'>, string> = {
  pending: 'Mensagem criptografada',
  waiting: 'Mensagem criptografada. Esperando a chave.',
  locked: 'Mensagem criptografada. Desbloqueie para ler.',
  'old-key': 'Mensagem criptografada com uma chave que você não tem.',
  failed: 'Não foi possível decifrar esta mensagem.',
};

// ---------- Estado da página (nunca sai da memória) ----------

let myId: string | null = null;
let privateKey: CryptoKey | null = null;
let myPublic: { text: string; key: CryptoKey } | null = null;
const roomKeys = new Map<string, Map<string, CryptoKey>>();
const current = new Map<string, { keyID: string | null; rotate: boolean }>();
const loading = new Map<string, Promise<void>>();
const ensuring = new Map<string, Promise<E2eRoomState | null>>();
const requestedAt = new Map<string, number>();
// Decifradas: chave "id|iv" (a edição troca o iv). LRU de 2000.
const cache = new Map<string, E2EContent | 'failed'>();
const decrypting = new Set<string>();
const loadFailedAt = new Map<string, number>();
let failures = 0;
let settingUp = false; // configurando nesta aba: o aviso e2e.keys "created" é desta aba
let epoch = 0; // troca a cada sessão ou redefinição: respostas antigas são descartadas

const CACHE_MAX = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const status = () => useE2e.getState().status;

let bumpTimer: ReturnType<typeof setTimeout> | null = null;
function bump() {
  if (bumpTimer) return;
  bumpTimer = setTimeout(() => {
    bumpTimer = null;
    useE2e.setState((s) => ({ version: s.version + 1 }));
  }, 16);
}

function setRoom(rid: string, st: E2eRoomState | null) {
  useE2e.setState((s) => {
    if ((s.rooms[rid] ?? null) === st) return s;
    const rooms = { ...s.rooms };
    if (st) rooms[rid] = st;
    else delete rooms[rid];
    return { rooms };
  });
}

function remember(id: string, v: E2EContent | 'failed') {
  cache.delete(id);
  cache.set(id, v);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

function forgetMemory() {
  epoch++;
  privateKey = null;
  myPublic = null;
  roomKeys.clear();
  current.clear();
  loading.clear();
  ensuring.clear();
  requestedAt.clear();
  loadFailedAt.clear();
  cache.clear();
  decrypting.clear();
  failures = 0;
  useE2e.setState((s) => ({ rooms: {}, version: s.version + 1, waitUntil: 0 }));
}

export function e2eSupported() {
  return typeof window !== 'undefined' && !!window.isSecureContext && !!globalThis.crypto?.subtle && typeof indexedDB !== 'undefined';
}

// ---------- Abas do mesmo navegador ----------

type TabMsg = { type: 'unlocked' | 'reset'; userId: string };
let channel: BroadcastChannel | null = null;
function tabs(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel('wescc-e2e');
  channel.onmessage = (e: MessageEvent<TabMsg>) => {
    const msg = e.data;
    if (!msg || msg.userId !== myId) return;
    if (msg.type === 'unlocked' && status() !== 'ready') void restoreFromStore();
    if (msg.type === 'reset') {
      forgetMemory();
      patchMe(null);
      useE2e.setState({ status: 'none' });
    }
  };
  return channel;
}
const tell = (type: TabMsg['type']) => myId && tabs()?.postMessage({ type, userId: myId } satisfies TabMsg);

function patchMe(e2eKeys: string | null) {
  const st = useStore.getState();
  if (st.me && st.me.e2eKeys !== e2eKeys) st.setMe({ ...st.me, e2eKeys });
}

// ---------- Sessão ----------

// Ao entrar (e ao reconectar): sem chaves no servidor, nem abre o IndexedDB.
export async function initE2e(me: { _id: string; e2eKeys?: string | null }) {
  if (myId !== me._id) {
    forgetMemory();
    myId = me._id;
  }
  tabs();
  if (!e2eSupported()) return useE2e.setState({ status: 'unsupported' });
  if (!me.e2eKeys) {
    if (privateKey) forgetMemory();
    return useE2e.setState({ status: 'none' });
  }
  if (privateKey && myPublic && (await fingerprint(myPublic.text)) === me.e2eKeys) return useE2e.setState({ status: 'ready' });
  await restoreFromStore(me.e2eKeys);
}

async function restoreFromStore(expected?: string) {
  const uid = myId;
  if (!uid) return;
  const want = expected ?? useStore.getState().me?.e2eKeys ?? null;
  if (privateKey && myPublic && want && (await fingerprint(myPublic.text)) === want) return useE2e.setState({ status: 'ready' });
  const my = epoch;
  const k = await loadKey(uid);
  if (my !== epoch || uid !== myId) return;
  if (k && want && k.fingerprint === want) {
    privateKey = k.privateKey;
    myPublic = { text: k.publicKey, key: await importPublicKey(k.publicKey) };
    useE2e.setState({ status: 'ready' });
    bump();
    void requestMissing();
    return;
  }
  // Chave de antes de uma redefinição (ou de outra pessoa): sai do navegador.
  if (k) await deleteKey(uid);
  useE2e.setState({ status: want ? 'locked' : 'none' });
}

// Ao sair da conta: nada fica (IndexedDB, memória e mensagens decifradas).
export function resetE2e() {
  forgetMemory();
  myId = null;
  useE2e.setState({ status: 'loading' });
  void clearKeystore();
}

async function becomeReady(priv: CryptoKey, pub: string, fp: string) {
  privateKey = priv;
  myPublic = { text: pub, key: await importPublicKey(pub) };
  if (myId) await saveKey(myId, { privateKey: priv, publicKey: pub, fingerprint: fp });
  failures = 0;
  patchMe(fp);
  useE2e.setState({ status: 'ready', waitUntil: 0 });
  tell('unlocked');
  bump();
  void requestMissing();
}

// ---------- Senha ----------

export { generatePassphrase };

export async function setupKeys(pass: string) {
  settingUp = true;
  try {
    const { publicKey, pkcs8 } = await generateUserKeys();
    const blob = await encryptPrivateKey(pkcs8, pass);
    try {
      await api.post('e2e.setUserPublicAndPrivateKeys', { public_key: publicKey, private_key: blob });
    } catch (e) {
      // Outro aparelho configurou antes: a senha que vale é a de lá.
      if (e instanceof ApiError && e.status === 409) await refreshMe();
      throw e;
    }
    await becomeReady(await importPrivateKey(pkcs8), publicKey, await fingerprint(publicKey));
  } finally {
    settingUp = false;
  }
}

async function refreshMe() {
  const m = await api.get('me').catch(() => null);
  if (!m) return;
  useStore.getState().setMe(m);
  await initE2e(m);
}

export async function unlock(pass: string) {
  const now = Date.now();
  if (useE2e.getState().waitUntil > now) throw new E2eError('wrong-password', E2E_UI.tooMany);
  const r = await api.get<{ publicKey: string | null; privateKey: string | null }>('e2e.fetchMyKeys');
  if (!r.publicKey || !r.privateKey) {
    patchMe(null);
    useE2e.setState({ status: 'none' });
    throw new E2eError('invalid-key', 'Você ainda não configurou a criptografia.');
  }
  let priv: CryptoKey;
  try {
    priv = await decryptPrivateKey(r.privateKey, pass);
  } catch (e) {
    if (e instanceof E2eError && e.code === 'wrong-password') {
      failures++;
      if (failures >= 5) {
        failures = 0;
        useE2e.setState({ waitUntil: Date.now() + 30_000 });
        throw new E2eError('wrong-password', E2E_UI.tooMany);
      }
      throw new E2eError('wrong-password', E2E_UI.wrongPassword);
    }
    throw e;
  }
  await becomeReady(priv, r.publicKey, await fingerprint(r.publicKey));
}

// A chave guardada no navegador não sai de lá: a troca precisa da senha atual.
export async function changePassword(cur: string, next: string) {
  const r = await api.get<{ publicKey: string | null; privateKey: string | null }>('e2e.fetchMyKeys');
  if (!r.publicKey || !r.privateKey) throw new E2eError('invalid-key', 'Você ainda não configurou a criptografia.');
  let pkcs8: ArrayBuffer;
  try {
    pkcs8 = await exportPkcs8WithPassword(r.privateKey, cur);
  } catch {
    throw new E2eError('wrong-password', 'Senha atual incorreta.');
  }
  await api.post('e2e.setUserPublicAndPrivateKeys', { public_key: r.publicKey, private_key: await encryptPrivateKey(pkcs8, next) });
}

export async function resetOwnKeys(opts: { password?: string; code?: string }) {
  await api.post('e2e.resetOwnE2EKey', { password: opts.password || undefined, code: opts.code || undefined });
  await localReset();
}

async function localReset() {
  forgetMemory();
  await clearKeystore();
  patchMe(null);
  useE2e.setState({ status: 'none' });
  tell('reset');
}

// ---------- Chaves das conversas ----------

const keyOf = (rid: string, keyID: string | null | undefined) => (keyID ? (roomKeys.get(rid)?.get(keyID) ?? null) : null);
export const holdsCurrent = (rid: string) => !!keyOf(rid, current.get(rid)?.keyID);

function putKey(rid: string, keyID: string, key: CryptoKey) {
  let m = roomKeys.get(rid);
  if (!m) roomKeys.set(rid, (m = new Map()));
  m.set(keyID, key);
}

// Busca as próprias chaves da conversa e desembrulha as novas. Chave cujo código não confere é recusada.
function loadRoomKeys(rid: string, force = false): Promise<void> {
  const busy = loading.get(rid);
  if (busy) return busy;
  if (!force && current.has(rid)) return Promise.resolve();
  const my = epoch;
  const p = (async () => {
    const r = await api.get<{ keyID: string | null; rotate: boolean; keys: { keyID: string; key: string; providedBy: string | null }[] }>('e2e.fetchRoomKeys', { rid });
    if (my !== epoch || !privateKey) return;
    let added = false;
    for (const k of r.keys) {
      if (keyOf(rid, k.keyID)) continue;
      try {
        const key = await unwrapRoomKey(k.key, privateKey);
        if ((await keyIdOf(key)) !== k.keyID) throw new E2eError('invalid-key');
        putKey(rid, k.keyID, key);
        added = true;
      } catch {
        if (k.providedBy && k.providedBy !== myId) void api.post('e2e.rejectSuggestedGroupKey', { rid, keyID: k.keyID }).catch(() => {});
      }
    }
    current.set(rid, { keyID: r.keyID, rotate: r.rotate });
    loadFailedAt.delete(rid);
    if (added) for (const id of [...cache.keys()]) if (cache.get(id) === 'failed') cache.delete(id);
  })()
    .catch((e) => {
      loadFailedAt.set(rid, Date.now());
      throw e;
    })
    .finally(() => {
      loading.delete(rid);
      // As mensagens que esperavam a resposta desenham de novo (com a chave ou com o aviso).
      bump();
    });
  loading.set(rid, p);
  return p;
}

const encryptedRoom = (room: Pick<Room, 'encrypted' | 'e2eKeyId'> | null | undefined) => !!room && (room.encrypted || !!room.e2eKeyId);

// Deixa a conversa pronta para ler e escrever: cria a primeira chave, pede a que falta ou troca a marcada para troca.
export function ensureRoom(room: Room, opts: { refresh?: boolean } = {}): Promise<E2eRoomState | null> {
  if (!encryptedRoom(room) || status() !== 'ready') return Promise.resolve(null);
  const rid = room._id;
  const busy = ensuring.get(rid);
  if (busy) return busy;
  const p = doEnsure(room, opts).finally(() => ensuring.delete(rid));
  ensuring.set(rid, p);
  return p;
}

async function doEnsure(room: Room, opts: { refresh?: boolean }): Promise<E2eRoomState | null> {
  const rid = room._id;
  const my = epoch;
  try {
    const known = current.get(rid);
    await loadRoomKeys(rid, opts.refresh || !known || (room.e2eKeyId ?? null) !== known.keyID || !!room.e2eRotate !== known.rotate);
    if (my !== epoch) return null;
    let cur = current.get(rid)!;
    if (!cur.keyID) {
      if (!room.encrypted || room.archived) return setRoom(rid, null), null;
      setRoom(rid, 'creating');
      await createFirstKey(rid);
      if (my !== epoch) return null;
      cur = current.get(rid)!;
    }
    if (!keyOf(rid, cur.keyID)) {
      await askForKey(rid);
      setRoom(rid, 'waiting');
      return 'waiting';
    }
    if (cur.rotate && room.encrypted && !room.archived) {
      setRoom(rid, 'rotating');
      await rotate(rid, { manual: false, wait: false });
    }
    setRoom(rid, 'ready');
    return 'ready';
  } catch {
    if (my === epoch) setRoom(rid, 'error');
    return 'error';
  }
}

async function createFirstKey(rid: string) {
  if (!myPublic) throw new E2eError('invalid-key');
  const { key, keyID } = await generateRoomKey();
  try {
    await api.post('e2e.setRoomKeyID', { rid, keyID, key: await wrapRoomKey(key, myPublic.key) });
    putKey(rid, keyID, key);
    current.set(rid, { keyID, rotate: false });
  } catch (e) {
    // Outra pessoa criou antes: fica a dela.
    if (!(e instanceof ApiError && e.status === 409)) throw e;
    await loadRoomKeys(rid, true);
    return;
  }
  void provide(rid, keyID, { wait: false });
}

// Pede a chave (o servidor avisa quem está online); no máximo um pedido a cada 30 s por conversa nesta aba.
async function askForKey(rid: string, force = false) {
  const last = requestedAt.get(rid) ?? 0;
  if (!force && Date.now() - last < 30_000) return;
  requestedAt.set(rid, Date.now());
  await api.post('e2e.requestSubscriptionKeys', { rid }).catch(() => {});
}

export async function askAgain(rid: string) {
  await askForKey(rid, true);
}

// Ao desbloquear: as conversas sem a chave atual pedem de novo (o servidor escolhe até 50).
async function requestMissing() {
  await sleep(1500);
  if (status() === 'ready') await api.post('e2e.requestSubscriptionKeys', {}).catch(() => {});
}

// Uma aba por navegador faz o trabalho de entregar e trocar chaves.
async function exclusive(name: string, fn: () => Promise<void>) {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks?.request) return fn();
  await locks.request(name, { ifAvailable: true }, async (lock) => {
    if (lock) await fn();
  });
}

async function wrapFor(users: { _id: string; e2e?: { public_key?: string } }[], key: CryptoKey) {
  const out: { uid: string; key: string }[] = [];
  for (const u of users) {
    try {
      out.push({ uid: u._id, key: await wrapRoomKey(key, await importPublicKey(String(u.e2e?.public_key ?? ''))) });
    } catch {
      // chave pública inválida: fica sem
    }
  }
  return out;
}

async function sendBatches(rid: string, keyID: string, keys: { uid: string; key: string }[]) {
  for (let i = 0; i < keys.length; i += E2E_BATCH) {
    try {
      await api.post('e2e.updateGroupKey', { rid, keyID, keys: keys.slice(i, i + E2E_BATCH) });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) return;
      throw e;
    }
  }
}

// Alguém da conversa precisa da chave: quem tem entrega (espera de 0 a 3 s para não entregarem todos juntos).
async function provide(rid: string, keyID: string, opts: { wait: boolean }) {
  if (opts.wait) await sleep(Math.random() * 3000);
  const my = epoch;
  await exclusive(`wescc-e2e-${rid}`, async () => {
    const key = keyOf(rid, keyID);
    if (!key || my !== epoch) return;
    const r = await api.get<{ users: { _id: string; e2e: { public_key: string } }[] }>('e2e.getUsersOfRoomWithoutKey', { rid, keyID });
    if (!r.users.length || my !== epoch) return;
    await sendBatches(rid, keyID, await wrapFor(r.users, key));
  }).catch(() => {});
}

// Chave nova: CAS no servidor (quem chega depois recebe 409 e para). Quem participa e tem chaves recebe junto.
async function rotate(rid: string, opts: { manual: boolean; wait: boolean }) {
  if (opts.wait) await sleep(Math.random() * 5000);
  const my = epoch;
  let done = false;
  await exclusive(`wescc-e2e-rotate-${rid}`, async () => {
    await loadRoomKeys(rid, true);
    const cur = current.get(rid);
    if (!cur?.keyID || my !== epoch || !myPublic) return;
    if (!opts.manual && !cur.rotate) return;
    if (!keyOf(rid, cur.keyID)) return;
    const { key, keyID } = await generateRoomKey();
    const r = await api.get<{ users: { _id: string; e2e: { public_key: string } }[] }>('e2e.getUsersOfRoomWithoutKey', { rid, keyID });
    const others = await wrapFor(r.users, key);
    const self = { uid: myId!, key: await wrapRoomKey(key, myPublic.key) };
    try {
      await api.post('e2e.resetRoomKey', { rid, prevKeyID: cur.keyID, keyID, keys: [self, ...others.slice(0, E2E_BATCH - 1)] });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        await loadRoomKeys(rid, true);
        return;
      }
      throw e;
    }
    putKey(rid, keyID, key);
    current.set(rid, { keyID, rotate: false });
    done = true;
    await sendBatches(rid, keyID, others.slice(E2E_BATCH - 1));
  });
  if (opts.manual && !done) await loadRoomKeys(rid, true);
}

// "Gerar chave nova" no menu da conversa.
export async function rotateNow(room: Room) {
  if (status() !== 'ready') throw new E2eError('invalid-key', E2E_TEXT.noKeys);
  setRoom(room._id, 'rotating');
  try {
    await loadRoomKeys(room._id, true);
    if (!holdsCurrent(room._id)) throw new ApiError(403, 'error-e2e-no-key', E2E_TEXT.noKey);
    await rotate(room._id, { manual: true, wait: false });
  } finally {
    setRoom(room._id, holdsCurrent(room._id) ? 'ready' : 'waiting');
  }
}

// ---------- Eventos ----------

export function handleE2eEvent(ev: ServerEvent) {
  if (ev.type === 'e2e.keys') {
    if (ev.action === 'reset') void localReset();
    // Configurou em outro aparelho: aqui falta a senha.
    if (ev.action === 'created' && status() === 'none' && !settingUp) void refreshMe();
    return;
  }
  if (status() !== 'ready') return;
  if (ev.type === 'e2e.keyRequest') {
    void (async () => {
      await loadRoomKeys(ev.rid, !keyOf(ev.rid, ev.keyID)).catch(() => {});
      if (keyOf(ev.rid, ev.keyID)) await provide(ev.rid, ev.keyID, { wait: true });
    })();
  } else if (ev.type === 'e2e.rotate') {
    void (async () => {
      await loadRoomKeys(ev.rid).catch(() => {});
      if (!keyOf(ev.rid, ev.keyID)) return;
      await rotate(ev.rid, { manual: false, wait: true }).catch(() => {});
      if (useE2e.getState().rooms[ev.rid]) setRoom(ev.rid, holdsCurrent(ev.rid) ? 'ready' : 'waiting');
    })();
  } else if (ev.type === 'e2e.keyAvailable') {
    void loadRoomKeys(ev.rid, true)
      .then(() => {
        if (useE2e.getState().rooms[ev.rid] === 'waiting' && holdsCurrent(ev.rid)) setRoom(ev.rid, 'ready');
      })
      .catch(() => {});
  }
}

// ---------- Ler ----------

const cacheId = (m: Pick<Message, '_id'>, env: E2EEnvelope) => `${m._id}|${env.iv}`;

// Quem cifrou precisa ser o autor ou quem editou (moderador). Autor removido (u._id vazio): vale o que veio.
function signerOk(m: Message, env: E2EEnvelope) {
  return !m.u?._id || env.by === m.u._id || env.by === m.editedBy?._id;
}

export function viewOf(m: Message): E2eView | null {
  const env = m.e2e;
  if (!env) return null;
  const id = cacheId(m, env);
  const hit = cache.get(id);
  if (hit) return hit === 'failed' ? { state: 'failed' } : { state: 'ok', content: hit };
  const st = status();
  if (st === 'loading') return { state: 'pending' };
  if (st !== 'ready') return { state: 'locked' };
  if (!signerOk(m, env)) return { state: 'failed' };
  const key = keyOf(m.rid, env.kid);
  if (key) {
    if (!decrypting.has(id)) {
      decrypting.add(id);
      const my = epoch;
      decryptContent(key, env, m.rid, m._id)
        .then((c) => my === epoch && remember(id, c))
        .catch(() => my === epoch && remember(id, 'failed'))
        .finally(() => {
          decrypting.delete(id);
          bump();
        });
    }
    return { state: 'pending' };
  }
  const known = current.get(m.rid);
  if (!known) {
    // Sem resposta do servidor (sem acesso, fora do ar): tenta de novo só depois de 30 s.
    if (Date.now() - (loadFailedAt.get(m.rid) ?? 0) < 30_000) return { state: 'waiting' };
    void loadRoomKeys(m.rid).catch(() => {});
    return { state: 'pending' };
  }
  if (loading.has(m.rid)) return { state: 'pending' };
  return { state: env.kid === known.keyID ? 'waiting' : 'old-key' };
}

// Texto para editar, copiar e citar: o decifrado, ou o msg do servidor quando a mensagem não é cifrada.
export function plainOf(m: Message): string {
  if (!m.e2e) return m.msg;
  const v = viewOf(m);
  return v?.state === 'ok' ? (v.content?.msg ?? '') : '';
}

export function contentOf(m: Message): E2EContent | null {
  const v = m.e2e ? viewOf(m) : null;
  return v?.state === 'ok' ? v.content! : null;
}

// Aviso com o chat aberto: o texto real quando dá para decifrar (senão fica o do servidor).
export async function decryptNotification(ev: { rid: string; messageId: string; e2e?: { envelope: E2EEnvelope; prefix: string } }): Promise<string | null> {
  if (!ev.e2e || status() !== 'ready') return null;
  try {
    if (!keyOf(ev.rid, ev.e2e.envelope.kid)) await loadRoomKeys(ev.rid, true);
    const key = keyOf(ev.rid, ev.e2e.envelope.kid);
    if (!key) return null;
    const c = await decryptContent(key, ev.e2e.envelope, ev.rid, ev.messageId);
    remember(`${ev.messageId}|${ev.e2e.envelope.iv}`, c);
    const text = c.msg || (c.file ? (c.file.voice ? '🎤 Mensagem de voz' : c.file.video ? '🎬 Mensagem de vídeo' : `📎 ${c.file.name}`) : '');
    return ev.e2e.prefix + text.slice(0, 300);
  } catch {
    return null;
  }
}

// ---------- Escrever ----------

async function readyKey(room: Room, refresh = false): Promise<{ key: CryptoKey; keyID: string }> {
  if (status() !== 'ready' || !myId) throw new E2eError('invalid-key', status() === 'none' ? E2E_UI.none : status() === 'unsupported' ? E2E_UI.unsupported : E2E_UI.locked);
  const st = await ensureRoom(room, { refresh });
  const keyID = current.get(room._id)?.keyID ?? null;
  const key = keyOf(room._id, keyID);
  if (!key || !keyID) throw new E2eError('invalid-key', st === 'waiting' ? E2E_UI.waiting : E2E_UI.error);
  return { key, keyID };
}

export async function encryptMessage(room: Room, content: E2EContent, mid = newMessageId(), refresh = false) {
  const { key, keyID } = await readyKey(room, refresh);
  const env = await encryptContent(key, keyID, room._id, mid, myId!, content);
  // A própria mensagem aparece já legível, sem decifrar de volta.
  remember(`${mid}|${env.iv}`, content);
  return { _id: mid, e2e: env };
}

// Quem é mencionado continua visível para o servidor: os @usuário do texto (com @all e @here).
export const e2eMentionsOf = (text: string) => mentionNames(text);

const outdated = (e: unknown) => e instanceof ApiError && e.errorType === 'error-e2e-key-outdated';

export function quoteOf(m: Message) {
  return { mid: m._id, author: m.u.username, ts: m.ts, text: plainOf(m).slice(0, E2E_QUOTE_MAX) };
}

export async function sendEncrypted(room: Room, input: { msg: string; quote?: E2EContent['quote']; tmid?: string; tshow?: boolean; ackRequired?: boolean }) {
  const mid = newMessageId();
  const content: E2EContent = { msg: input.msg, ...(input.quote ? { quote: input.quote } : {}) };
  for (let attempt = 0; ; attempt++) {
    const { e2e } = await encryptMessage(room, content, mid, attempt > 0);
    try {
      return await api.post('chat.sendMessage', {
        message: { _id: mid, rid: room._id, tmid: input.tmid, tshow: input.tshow, ackRequired: input.ackRequired, e2e, e2eMentions: e2eMentionsOf(input.msg) },
      });
    } catch (e) {
      if (attempt === 0 && outdated(e)) continue;
      throw e;
    }
  }
}

// Edição: o arquivo e a citação continuam (só o texto muda).
export async function editEncrypted(room: Room, m: Message, text: string) {
  const old = contentOf(m);
  if (m.e2e && !old) throw new E2eError('decrypt-failed', E2E_PLACEHOLDER.failed);
  const content: E2EContent = { ...(old ?? {}), msg: text };
  for (let attempt = 0; ; attempt++) {
    const { e2e } = await encryptMessage(room, content, m._id, attempt > 0);
    try {
      return await api.post('chat.update', { roomId: room._id, msgId: m._id, e2e, e2eMentions: e2eMentionsOf(text) });
    } catch (e) {
      if (attempt === 0 && outdated(e)) continue;
      throw e;
    }
  }
}

export type E2eFileMeta = Pick<E2EFileRef, 'voice' | 'video' | 'duration' | 'waveform' | 'width' | 'height'>;

// Arquivo cifrado com uma chave só dele; nome, tipo e tamanho reais vão dentro da mensagem cifrada.
export async function sendEncryptedFile(
  room: Room,
  file: File,
  opts: { msg?: string; tmid?: string; meta?: E2eFileMeta; onProgress?: (p: number) => void; signal?: AbortSignal },
) {
  const mid = newMessageId();
  const { data, ref } = await encryptFile(await file.arrayBuffer(), room._id, mid);
  const blob = new File([data], E2E_FILE_NAME, { type: E2E_FILE_TYPE });
  const content: E2EContent = { msg: opts.msg ?? '', file: { name: file.name || 'arquivo', type: file.type || E2E_FILE_TYPE, size: file.size, ...ref, ...(opts.meta ?? {}) } };
  for (let attempt = 0; ; attempt++) {
    const { e2e } = await encryptMessage(room, content, mid, attempt > 0);
    try {
      return await uploadTo(
        `rooms.upload/${room._id}`,
        blob,
        { _id: mid, e2e: JSON.stringify(e2e), tmid: opts.tmid ?? '', e2eMentions: e2eMentionsOf(content.msg).join(',') },
        opts.onProgress,
        opts.signal,
      );
    } catch (e) {
      if (attempt === 0 && outdated(e)) continue;
      throw e;
    }
  }
}

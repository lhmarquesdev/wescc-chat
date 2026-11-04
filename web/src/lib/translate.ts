import { useCallback, useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { Message } from '@shared/index';
import { normalizeLang, targetFor, TRANSLATE_MAX_IDS, type MessageTranslation, type TranslateFailReason, type TranslateLanguage, type TranslateResponse } from '@shared/translate';
import { api, ApiError } from './api';
import { useSetting, useStore } from './store';
import { isTranslatable, languageLabel, translationKey } from './translateRules';

// Tradução de mensagens para quem lê, pelo LibreTranslate da empresa (o servidor guarda as traduções; a web pede só o
// que está na tela). Uma entrada por mensagem + idioma + edição (translationKey): editar troca a chave e pede de novo.

export type Entry = { status: 'pending' } | (MessageTranslation & { at: number; retryAt?: number });

interface Languages {
  list: TranslateLanguage[];
  unavailable: boolean;
  myDefault: string | null;
  at: number;
}

interface TranslateState {
  byKey: Record<string, Entry>;
  view: Record<string, 'translation' | 'original'>; // por mensagem: a escolha da pessoa nesta sessão
  manual: Record<string, true>; // chaves pedidas pelo menu: "Traduzindo…", avisos e "Tentar de novo"
  roomError: Record<string, string>; // sala → o idioma escolhido não existe no servidor de tradução
  languages: Languages | null;
}

export const useTranslations = create<TranslateState>(() => ({ byKey: {}, view: {}, manual: {}, roomError: {}, languages: null }));

const BATCH_WAIT = 80; // junta as mensagens que entram na tela juntas
const RETRY_MIN = 30_000; // falha passageira: nova tentativa depois disso (ou do Retry-After)
const RETRY_TICK = 15_000; // só enquanto houver falha na tela
const LANG_TTL = 10 * 60_000;
const LANG_TTL_FAILED = 30_000;
const RETRYABLE = new Set<TranslateFailReason | undefined>(['rate', 'busy', 'timeout', 'unavailable']);
const FINAL = new Set(['same', 'unknown', 'unsupported']);

const toast = (text: string, kind: 'warning' | 'error' | 'info') => useStore.getState().toast(text, kind);

// Aviso do pedido manual que não virou tradução.
function manualNotice(t: MessageTranslation): string | null {
  if (t.status === 'same') return `Esta mensagem já está em ${languageLabel(t.language)}.`;
  if (t.status === 'unknown') return 'Não deu para identificar o idioma desta mensagem.';
  if (t.status === 'unsupported') {
    return t.source
      ? `O servidor de tradução não traduz do ${languageLabel(t.source)} para o ${languageLabel(t.language)}.`
      : `O servidor de tradução não traduz para o ${languageLabel(t.language)}.`;
  }
  return null;
}

// ---------- Fila por sala e idioma ----------

interface Waiting {
  key: string;
  manual: boolean; // pedido pelo menu agora (avisos); as novas tentativas automáticas não avisam
}

interface Queue {
  rid: string;
  lang: string;
  waiting: Map<string, Waiting>; // mensagem → pedido
  timer: number | null;
  busy: boolean;
  stopped: string | null; // texto do erro de idioma: a fila não pede mais
}

const queues = new Map<string, Queue>();
const inflight = new Set<string>(); // chaves num pedido em voo
const askedDuring = new Set<string>(); // pedido pelo menu enquanto a mesma chave já estava em voo
let epoch = 0; // troca quando outra pessoa entra: respostas antigas são descartadas

const putEntries = (patch: Record<string, Entry>) => useTranslations.setState((s) => ({ byKey: { ...s.byKey, ...patch } }));
const setView = (id: string, v: 'translation' | 'original') => useTranslations.setState((s) => (s.view[id] === v ? s : { view: { ...s.view, [id]: v } }));
const markManual = (key: string) => useTranslations.setState((s) => (s.manual[key] ? s : { manual: { ...s.manual, [key]: true } }));
const failed = (id: string, lang: string, reason: TranslateFailReason, retryAt?: number): Entry => ({
  _id: id,
  status: 'failed',
  language: lang,
  reason,
  at: Date.now(),
  ...(retryAt ? { retryAt } : {}),
});

function request(rid: string, lang: string, id: string, key: string, manual: boolean) {
  if (manual) markManual(key);
  if (inflight.has(key)) {
    if (manual) askedDuring.add(key);
    return;
  }
  const qk = `${rid}|${lang}`;
  let q = queues.get(qk);
  if (!q) {
    q = { rid, lang, waiting: new Map(), timer: null, busy: false, stopped: null };
    queues.set(qk, q);
  }
  if (q.stopped) {
    putEntries({ [key]: failed(id, lang, 'config') });
    if (manual) toast(q.stopped, 'warning');
    return;
  }
  const prev = q.waiting.get(id);
  q.waiting.set(id, { key, manual: manual || (prev?.key === key && prev.manual) });
  putEntries({ [key]: { status: 'pending' } });
  if (q.waiting.size >= TRANSLATE_MAX_IDS && q.timer != null) {
    clearTimeout(q.timer);
    q.timer = null;
  }
  schedule(q);
}

function schedule(q: Queue) {
  if (q.busy || q.timer != null || !q.waiting.size) return;
  q.timer = window.setTimeout(
    () => {
      q.timer = null;
      void flush(q);
    },
    q.waiting.size >= TRANSLATE_MAX_IDS ? 0 : BATCH_WAIT,
  );
}

async function flush(q: Queue) {
  if (q.busy || !q.waiting.size) return;
  const batch = [...q.waiting].slice(0, TRANSLATE_MAX_IDS);
  for (const [id, w] of batch) {
    q.waiting.delete(id);
    inflight.add(w.key);
  }
  q.busy = true;
  const mine = epoch;
  try {
    const r = await api.post<TranslateResponse>('autoTranslate.translateMessages', { roomId: q.rid, messageIds: batch.map(([id]) => id), targetLanguage: q.lang });
    if (mine === epoch) received(batch, r);
  } catch (e) {
    if (mine === epoch) refused(q, batch, e);
  } finally {
    for (const [, w] of batch) {
      inflight.delete(w.key);
      askedDuring.delete(w.key);
    }
    q.busy = false;
    if (mine === epoch) schedule(q);
  }
}

const askedNow = (w: Waiting) => w.manual || askedDuring.has(w.key);

function received(batch: [string, Waiting][], r: TranslateResponse) {
  const now = Date.now();
  const got = new Map(r.translations.map((t) => [t._id, t]));
  const patch: Record<string, Entry> = {};
  const notices: string[] = [];
  let manualFailed = false;
  let retrying = false;
  for (const [id, w] of batch) {
    const key = w.key;
    // Fora da resposta: o servidor não traduz esta mensagem (nunca é traduzida ou não é desta sala).
    const t: MessageTranslation = got.get(id) ?? { _id: id, status: 'unknown', language: r.language };
    const retryAt = t.status === 'failed' && RETRYABLE.has(t.reason) ? now + Math.max(r.retryAfterMs ?? 0, RETRY_MIN) : undefined;
    if (retryAt) retrying = true;
    patch[key] = { ...t, at: now, ...(retryAt ? { retryAt } : {}) };
    if (!askedNow(w)) continue;
    const notice = manualNotice(t);
    if (notice) {
      setView(id, 'original');
      notices.push(notice);
    } else if (t.status === 'failed' && t.reason !== 'changed') manualFailed = true;
  }
  putEntries(patch);
  if (notices.length) toast(notices[0], 'info');
  if (manualFailed && r.notice) toast(r.notice, 'warning');
  if (retrying) ensureTick();
}

function refused(q: Queue, batch: [string, Waiting][], e: unknown) {
  const err = e instanceof ApiError ? e : null;
  const patch: Record<string, Entry> = {};
  if (err?.errorType === 'error-translate-language') {
    // O idioma pedido não existe no servidor de tradução: para de pedir e o painel da sala avisa.
    q.stopped = err.message;
    for (const [id, w] of q.waiting) patch[w.key] = failed(id, q.lang, 'config');
    q.waiting.clear();
    useTranslations.setState((s) => ({ roomError: { ...s.roomError, [q.rid]: err.message } }));
  }
  const passing = !err || err.status === 0 || err.status === 429 || err.status >= 500;
  const reason: TranslateFailReason = err?.status === 429 ? 'rate' : passing ? 'unavailable' : 'config';
  const retryAt = passing ? Date.now() + RETRY_MIN : undefined;
  let anyManual = false;
  for (const [id, w] of batch) {
    patch[w.key] = failed(id, q.lang, reason, retryAt);
    if (askedNow(w)) anyManual = true;
  }
  putEntries(patch);
  if (anyManual) toast(err ? err.message : 'Não foi possível traduzir agora. Confira a conexão.', 'warning');
  if (retryAt) ensureTick();
}

// O painel da sala salvou um idioma novo: a fila daquela sala pode pedir de novo.
export function clearRoomError(rid: string) {
  for (const q of queues.values()) if (q.rid === rid) q.stopped = null;
  useTranslations.setState((s) => {
    if (!(rid in s.roomError)) return s;
    const roomError = { ...s.roomError };
    delete roomError[rid];
    return { roomError };
  });
}

// ---------- O que está na tela ----------

// Um observador por lista que rola (conversa, painel do tópico, painéis da sala): o rootMargin só vale dentro do
// próprio elemento que rola, então cada lista tem o seu.
const watchers = new Map<Element, () => boolean>(); // linha → confere e pede; true = falha esperando a nova tentativa
const visible = new Set<Element>();
const rootOf = new Map<Element, Element | null>();
const observers = new Map<Element | null, { io: IntersectionObserver; count: number }>();
let tick: number | null = null;

function onIntersect(entries: IntersectionObserverEntry[]) {
  let waiting = false;
  for (const e of entries) {
    if (!e.isIntersecting) {
      visible.delete(e.target);
      continue;
    }
    visible.add(e.target);
    if (watchers.get(e.target)?.()) waiting = true;
  }
  if (waiting) ensureTick();
}

function watch(el: Element, check: () => boolean) {
  watchers.set(el, check);
  if (rootOf.has(el) || typeof IntersectionObserver === 'undefined') return;
  const root = el.closest('.messages, .panel-body');
  let o = observers.get(root);
  if (!o) {
    o = { io: new IntersectionObserver(onIntersect, { root, rootMargin: '400px 0px' }), count: 0 };
    observers.set(root, o);
  }
  o.count += 1;
  rootOf.set(el, root);
  o.io.observe(el);
}

function unwatch(el: Element) {
  watchers.delete(el);
  visible.delete(el);
  if (!rootOf.has(el)) return;
  const root = rootOf.get(el) ?? null;
  rootOf.delete(el);
  const o = observers.get(root);
  if (!o) return;
  o.io.unobserve(el);
  o.count -= 1;
  if (o.count <= 0) {
    o.io.disconnect();
    observers.delete(root);
  }
}

function ensureTick() {
  if (tick == null) tick = window.setInterval(runTick, RETRY_TICK);
}

function runTick() {
  let waiting = false;
  for (const el of visible) if (watchers.get(el)?.()) waiting = true;
  if (!waiting && tick != null) {
    clearInterval(tick);
    tick = null;
  }
}

// ---------- Idiomas do servidor ----------

let loadingLanguages = false;

function loadLanguages() {
  const cur = useTranslations.getState().languages;
  if (loadingLanguages || (cur && Date.now() - cur.at < (cur.unavailable ? LANG_TTL_FAILED : LANG_TTL))) return;
  loadingLanguages = true;
  const mine = epoch;
  api
    .get<{ languages?: TranslateLanguage[]; defaultLanguage?: string; unavailable?: boolean }>('autoTranslate.getSupportedLanguages')
    .then((r) => {
      if (mine === epoch) useTranslations.setState({ languages: { list: r.languages ?? [], unavailable: !!r.unavailable, myDefault: r.defaultLanguage ?? null, at: Date.now() } });
    })
    .catch(() => {
      if (mine === epoch) useTranslations.setState({ languages: { list: [], unavailable: true, myDefault: null, at: Date.now() } });
    })
    .finally(() => {
      loadingLanguages = false;
    });
}

// A tradução está ligada na empresa e a pessoa tem a permissão (global: o papel na sala não muda quem lê).
export function useTranslateAllowed(): boolean {
  const enabled = useSetting<boolean>('AutoTranslate_Enabled');
  const allowed = useStore((s) => !!s.me?.permissions.includes('auto-translate'));
  return !!enabled && allowed;
}

// Lista do servidor de tradução (guardada 10 minutos; 30 s quando ele não respondeu).
export function useLanguages(): { list: TranslateLanguage[] | null; unavailable: boolean; myDefault: string | null } {
  const allowed = useTranslateAllowed();
  const languages = useTranslations((s) => s.languages);
  useEffect(() => {
    if (allowed) loadLanguages();
  }, [allowed, languages]);
  return { list: languages ? languages.list : null, unavailable: !!languages?.unavailable, myDefault: languages?.myDefault ?? null };
}

// O idioma da pessoa (Minha conta › Preferências) ou o padrão da empresa.
export function useMyLanguage(): string {
  const pref = useStore((s) => s.me?.preferences?.language);
  const site = useSetting<string>('Language');
  return normalizeLang(targetFor({ prefs: { language: pref }, siteLanguage: site }));
}

// on: a pessoa pode traduzir nesta sala; auto: tradução automática ligada no painel da sala; lang: destino.
export function useRoomTranslate(rid: string): { on: boolean; auto: boolean; lang: string } {
  const allowed = useTranslateAllowed();
  const encrypted = useStore((s) => !!s.rooms[rid]?.encrypted);
  const subAuto = useStore((s) => !!s.subscriptions[rid]?.autoTranslate);
  const subLang = useStore((s) => s.subscriptions[rid]?.autoTranslateLanguage ?? null);
  const pref = useStore((s) => s.me?.preferences?.language);
  const site = useSetting<string>('Language');
  const on = allowed && !encrypted;
  const lang = normalizeLang(targetFor({ sub: { autoTranslateLanguage: subLang }, prefs: { language: pref }, siteLanguage: site }));
  return { on, auto: on && subAuto, lang };
}

export interface MessageTranslationView {
  can: boolean; // mostra "Traduzir" / "Ver original"
  shown: 'original' | 'translation';
  text?: string; // a tradução (com shown === 'translation')
  source?: string; // idioma do original, quando já traduzida
  ready: boolean; // tradução pronta (mesmo com o original na tela)
  state: 'idle' | 'pending' | 'failed';
  reason?: TranslateFailReason;
  auto: boolean;
  manual: boolean; // pedida pelo menu desta mensagem
  wanted: boolean; // a pessoa quer ver a tradução (automática ou pelo menu)
  toggle(): void;
  retry(): void;
  observe(el: HTMLElement | null): void; // ref da linha da mensagem
}

export function useMessageTranslation(m: Message): MessageTranslationView {
  const meId = useStore((s) => s.me?._id ?? '');
  const encrypted = useStore((s) => !!s.rooms[m.rid]?.encrypted);
  const rt = useRoomTranslate(m.rid);
  const can = rt.on && isTranslatable(m, meId, { encrypted });
  const key = translationKey(m, rt.lang);
  const entry = useTranslations((s) => (can ? s.byKey[key] : undefined));
  const choice = useTranslations((s) => (can ? s.view[m._id] : undefined));
  const manual = useTranslations((s) => (can ? !!s.manual[key] : false));
  const wanted = can && (choice ?? (rt.auto ? 'translation' : 'original')) === 'translation';
  const done = entry && entry.status !== 'pending' ? entry : null;
  const ready = !!done && done.status === 'translated' && !!done.text;
  const shown = wanted && ready ? 'translation' : 'original';

  // O que a linha confere quando entra na tela (ou na nova tentativa): sem entrada, ou com a falha vencida, pede.
  const check = (): boolean => {
    if (!wanted) return false;
    const e = useTranslations.getState().byKey[key];
    if (!e) {
      request(m.rid, rt.lang, m._id, key, false);
      return false;
    }
    if (e.status === 'failed' && e.retryAt) {
      if (e.retryAt > Date.now()) return true;
      request(m.rid, rt.lang, m._id, key, false);
    }
    return false;
  };
  const live = useRef({ check, watching: false });
  live.current.check = check;
  live.current.watching = wanted;
  const elRef = useRef<HTMLElement | null>(null);

  const observe = useCallback((el: HTMLElement | null) => {
    if (elRef.current && elRef.current !== el) unwatch(elRef.current);
    elRef.current = el;
    if (el && live.current.watching) watch(el, () => live.current.check());
  }, []);

  // Começou a querer a tradução (sala ligada, idioma novo, mensagem editada): registra a linha e, se já está na tela,
  // pede agora.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    if (!wanted) {
      unwatch(el);
      return;
    }
    watch(el, () => live.current.check());
    if (visible.has(el) && live.current.check()) ensureTick();
  }, [wanted, key]);

  useEffect(
    () => () => {
      if (elRef.current) unwatch(elRef.current);
    },
    [],
  );

  const toggle = () => {
    if (!can) return;
    if (shown === 'translation') {
      setView(m._id, 'original');
      return;
    }
    const e = useTranslations.getState().byKey[key];
    if (e && e.status !== 'pending' && FINAL.has(e.status)) {
      // Já se sabe que não há o que traduzir: avisa sem pedir de novo.
      setView(m._id, 'original');
      const notice = manualNotice(e);
      if (notice) toast(notice, 'info');
      return;
    }
    setView(m._id, 'translation');
    if (!e || e.status === 'failed') request(m.rid, rt.lang, m._id, key, true);
    else markManual(key);
  };

  const retry = () => {
    if (!can) return;
    setView(m._id, 'translation');
    request(m.rid, rt.lang, m._id, key, true);
  };

  return {
    can,
    shown,
    text: shown === 'translation' && done?.status === 'translated' ? done.text : undefined,
    source: ready && done?.status === 'translated' ? done.source : undefined,
    ready,
    state: !can || !entry ? 'idle' : entry.status === 'pending' ? 'pending' : entry.status === 'failed' ? 'failed' : 'idle',
    reason: done?.status === 'failed' ? done.reason : undefined,
    auto: rt.auto,
    manual,
    wanted,
    toggle,
    retry,
    observe,
  };
}

// Outra pessoa entrou no navegador: as traduções e escolhas da anterior não valem mais.
useStore.subscribe((s, prev) => {
  if (s.me?._id === prev.me?._id) return;
  epoch += 1;
  for (const q of queues.values()) if (q.timer != null) clearTimeout(q.timer);
  queues.clear();
  inflight.clear();
  askedDuring.clear();
  useTranslations.setState({ byKey: {}, view: {}, manual: {}, roomError: {}, languages: null });
});

import type { ClientEvent, ServerEvent } from '@shared/index';
import { getCredentials } from './api';
import { applyEvent, useStore } from './store';
import { rememberLogoutReason } from './logoutReason';

type Listener = (ev: ServerEvent) => void;

class Realtime {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private retry = 0;
  private stopped = true;
  private pingTimer: number | null = null;
  private watched = new Set<string>();
  private onReconnect: (() => void) | null = null;
  // Sem interação há N minutos (ausência automática). Vai ao servidor a cada conexão: ele decide pelo conjunto das abas.
  private idle = false;
  private timer: number | null = null;
  // Id desta conexão no servidor (as chamadas usam para a sinalização).
  connectionId: string | null = null;

  start(onReconnect: () => void) {
    this.stopped = false;
    this.onReconnect = onReconnect;
    this.connect();
    this.setupIdle();
    this.setupWake();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
  }

  private connect() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const creds = getCredentials();
    if (!creds || this.stopped) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/websocket`);
    this.ws = ws;
    let first = true;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: creds.authToken }));
    ws.onmessage = (e) => {
      const ev = JSON.parse(e.data) as ServerEvent;
      if (ev.type === 'connected') {
        this.connectionId = ev.connectionId;
        useStore.getState().setConnected(true);
        const wasRetry = this.retry > 0;
        this.retry = 0;
        for (const rid of this.watched) this.send({ type: 'watch', rid });
        this.send({ type: 'idle', idle: this.idle });
        if (wasRetry || !first) this.onReconnect?.();
        first = false;
      }
      if (ev.type === 'force_logout') {
        rememberLogoutReason(ev.reason);
        location.href = '/login';
        return;
      }
      applyEvent(ev);
      for (const l of this.listeners) l(ev);
    };
    ws.onclose = (e) => {
      this.connectionId = null;
      useStore.getState().setConnected(false);
      if (this.stopped) return;
      if (e.code === 4001 || e.code === 4003) {
        // Sessão inválida.
        location.href = '/login';
        return;
      }
      if (e.code === 4005) {
        // Troca de senha ou 2FA passou a ser obrigatório: recarrega para mostrar a tela de configuração.
        location.reload();
        return;
      }
      // 1, 2, 4, 8 e depois 10 s (com um pouco de variação, para as abas não voltarem todas juntas).
      const delay = Math.min(10_000, 1000 * 2 ** this.retry++) * (0.8 + Math.random() * 0.4);
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => this.send({ type: 'ping' }), 25_000);
  }

  // "Tentar agora", a rede voltou ou a pessoa voltou para a aba: reconecta já, sem esperar a próxima tentativa.
  reconnectNow() {
    if (this.stopped || !this.timer) return;
    this.connect();
  }

  private setupWake() {
    window.addEventListener('online', () => this.reconnectNow());
    window.addEventListener('focus', () => this.reconnectNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.reconnectNow();
    });
  }

  send(ev: ClientEvent) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(ev));
  }

  watch(rid: string) {
    this.watched.add(rid);
    this.send({ type: 'watch', rid });
  }

  unwatch(rid: string) {
    this.watched.delete(rid);
    this.send({ type: 'unwatch', rid });
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  // Ausência automática após N minutos sem interação.
  private setupIdle() {
    let last = Date.now();
    const bump = () => {
      last = Date.now();
      if (this.idle) {
        this.idle = false;
        this.send({ type: 'idle', idle: false });
      }
    };
    for (const ev of ['mousemove', 'keydown', 'mousedown', 'touchstart', 'focus']) window.addEventListener(ev, bump, { passive: true });
    setInterval(() => {
      const minutes = Number(useStore.getState().settings.Accounts_Default_Away_Minutes ?? 5);
      if (!this.idle && minutes > 0 && Date.now() - last > minutes * 60_000) {
        this.idle = true;
        this.send({ type: 'idle', idle: true });
      }
    }, 15_000);
  }
}

export const realtime = new Realtime();

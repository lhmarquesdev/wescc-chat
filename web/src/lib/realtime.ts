import type { ClientEvent, ServerEvent } from '@shared/index';
import { getCredentials } from './api';
import { applyEvent, useStore } from './store';

type Listener = (ev: ServerEvent) => void;

class Realtime {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private retry = 0;
  private stopped = true;
  private pingTimer: number | null = null;
  private watched = new Set<string>();
  private onReconnect: (() => void) | null = null;

  start(onReconnect: () => void) {
    this.stopped = false;
    this.onReconnect = onReconnect;
    this.connect();
    this.setupIdle();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
  }

  private connect() {
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
        useStore.getState().setConnected(true);
        const wasRetry = this.retry > 0;
        this.retry = 0;
        for (const rid of this.watched) this.send({ type: 'watch', rid });
        if (wasRetry || !first) this.onReconnect?.();
        first = false;
      }
      if (ev.type === 'force_logout') {
        location.href = '/login';
        return;
      }
      applyEvent(ev);
      for (const l of this.listeners) l(ev);
    };
    ws.onclose = (e) => {
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
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => this.send({ type: 'ping' }), 25_000);
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
    let idle = false;
    const bump = () => {
      last = Date.now();
      if (idle) {
        idle = false;
        this.send({ type: 'idle', idle: false });
      }
    };
    for (const ev of ['mousemove', 'keydown', 'mousedown', 'touchstart', 'focus']) window.addEventListener(ev, bump, { passive: true });
    setInterval(() => {
      const minutes = Number(useStore.getState().settings.Accounts_Default_Away_Minutes ?? 5);
      if (!idle && minutes > 0 && Date.now() - last > minutes * 60_000) {
        idle = true;
        this.send({ type: 'idle', idle: true });
      }
    }, 15_000);
  }
}

export const realtime = new Realtime();

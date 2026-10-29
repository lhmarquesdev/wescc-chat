// Contrato comum dos dois motores de mídia: P2P (chamada a dois, como sempre) e SFU (em grupo, pelo LiveKit).
// O motor certo só é carregado quando a chamada começa: o LiveKit fica num pedaço próprio do build.
import type { Call, CallJoin, CallMedia, CallSource, UserRef } from '@shared/index';
import type { LivePeer } from './store';
import { useStore } from '../store';

export interface CallEngine {
  readonly media: CallMedia;
  connect(o: { call: Call; join?: CallJoin; mic: boolean; camera: boolean; tracks?: MediaStreamTrack[] }): Promise<void>;
  disconnect(): Promise<void>;
  setMic(on: boolean): Promise<void>;
  setCamera(on: boolean): Promise<void>;
  setScreen(on: boolean, o?: { tabAudio?: boolean }): Promise<void>;
  setReceiveVideo(on: boolean): void;
  switchDevice(kind: MediaDeviceKind, deviceId: string): Promise<void>;
  attach(peerId: string, source: 'camera' | 'screen' | 'audio', el: HTMLMediaElement): () => void;
  startAudio(): Promise<void>;
  on(fn: (e: EngineEvent) => void): () => void;
  // Faixa do meu microfone (para o medidor e o aviso de fala com o microfone desligado).
  micTrack(): MediaStreamTrack | null;
}

export type EngineEvent =
  | { type: 'peers'; peers: LivePeer[] } // em lotes: no máximo 4 por segundo
  | { type: 'speaking'; ids: string[] }
  | { type: 'state'; state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected'; reason?: string }
  | { type: 'permissions'; canPublish: boolean; sources: CallSource[] }
  | { type: 'audio-blocked'; blocked: boolean }
  | { type: 'refused'; status: 401 | 403 | 429 }
  | { type: 'device-error'; kind: 'mic' | 'camera' | 'screen'; error: string };

export interface EngineContext {
  me: UserRef;
  // Nome de quem ainda não foi carregado (identidade desconhecida no LiveKit).
  userOf(id: string): UserRef | null;
  lookup(id: string): void;
}

// Erro de conexão já traduzido para a pessoa (sala cheia no servidor de chamadas, rede, mídia bloqueada).
export class EngineError extends Error {
  constructor(
    message: string,
    public kind: 'full' | 'network' | 'media' | 'refused' | 'other',
    public status?: number,
  ) {
    super(message);
  }
}

export async function createEngine(media: CallMedia, ctx: EngineContext): Promise<CallEngine> {
  if (media === 'sfu') {
    const { createSfuEngine } = await import('./sfu');
    return createSfuEngine(ctx);
  }
  const { createP2pEngine } = await import('./p2p');
  return createP2pEngine(ctx);
}

// Carrega o motor de grupo antes de precisar dele (ao passar o mouse num botão de chamada, na faixa da sala). Sem o
// tempo real (servidor fora do ar, na atualização) não tenta: a falha não ajuda ninguém. Uma falha aqui fica aqui: a
// recarga por pedaço ausente (build.ts) não roda para a pré-carga, e o import de verdade tenta de novo.
let prefetched = false;
let prefetching = 0;
export const isPrefetching = () => prefetching > 0;
export function prefetchSfu() {
  if (prefetched || !useStore.getState().connected) return;
  prefetched = true;
  prefetching++;
  void import('./sfu')
    .catch(() => {
      prefetched = false;
    })
    .finally(() => {
      prefetching--;
    });
}

// Emissor simples para os motores.
export function emitter() {
  const fns = new Set<(e: EngineEvent) => void>();
  return {
    on(fn: (e: EngineEvent) => void) {
      fns.add(fn);
      return () => void fns.delete(fn);
    },
    emit(e: EngineEvent) {
      for (const f of fns) f(e);
    },
  };
}

// Lote de pessoas: junta mudanças no mesmo quadro e solta no máximo 4 por segundo.
export function peerBatcher(build: () => LivePeer[], emit: (e: EngineEvent) => void) {
  let pending = false;
  let timer = 0;
  let raf = 0;
  let last = 0;
  const flush = () => {
    pending = false;
    raf = 0;
    last = Date.now();
    emit({ type: 'peers', peers: build() });
  };
  return {
    schedule() {
      if (pending) return;
      pending = true;
      timer = window.setTimeout(
        () => {
          timer = 0;
          // Com a aba escondida o requestAnimationFrame não roda: solta direto.
          if (document.hidden) flush();
          else raf = requestAnimationFrame(flush);
        },
        Math.max(0, 250 - (Date.now() - last)),
      );
    },
    cancel() {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      pending = false;
    },
  };
}

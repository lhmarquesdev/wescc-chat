// Palco da chamada em grupo: grade (1, 2, 4, 6 ou 9 quadros) ou destaque (um grande e a faixa dos demais).
// Quem fica em destaque e a ordem saem de layoutCall (shared/call-layout.ts); aqui só se mede e desenha.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { CALL_LIMITS } from '@shared/calls';
import { layoutCall, type LayoutPeer } from '@shared/call-layout';
import { inviteRoom, setView, setWindow, speakingSince, useCallStore, type LivePeer } from '../../lib/call/store';
import { Icon } from '../Icon';
import { RingPicker } from './RingPicker';
import { MoreTile, Tile } from './Tile';

const GAP = 8;

// Largura do quadro 16:9 que cabe em w × h com cols colunas.
function fitWidth(n: number, cols: number, w: number, h: number) {
  const rows = Math.ceil(n / cols);
  const cw = (w - GAP * (cols - 1)) / cols;
  const ch = (h - GAP * (rows - 1)) / rows;
  return Math.min(cw, (ch * 16) / 9);
}

function gridShape(n: number, phone: boolean, w: number, h: number) {
  if (phone) {
    const cols = n <= 2 ? 1 : 2;
    return { cols, rows: Math.ceil(n / cols) };
  }
  let cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
  // De 5 em diante, num palco estreito (lista aberta, janela menor), 2 colunas dão quadros maiores que 3.
  if (cols === 3 && fitWidth(n, 2, w, h) > fitWidth(n, 3, w, h)) cols = 2;
  return { cols, rows: Math.ceil(n / cols) };
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

// Quem fala há 1,5 s toma o destaque: o palco se recalcula nesse momento, sem esperar outra mudança.
function useSpeakerTick(peers: Record<string, LivePeer>) {
  const [, tick] = useState(0);
  const speaking = Object.values(peers)
    .filter((p) => p.speaking && !p.isMe)
    .map((p) => p.id)
    .join();
  useEffect(() => {
    if (!speaking) return;
    const t = window.setTimeout(() => tick((n) => n + 1), CALL_LIMITS.speakerStickyMs + 50);
    return () => clearTimeout(t);
  }, [speaking]);
}

export function useLayout(phone: boolean) {
  const peers = useCallStore((s) => s.peers);
  const view = useCallStore((s) => s.view);
  const featured = useRef<string | null>(null);
  useSpeakerTick(peers);
  const list: LayoutPeer[] = Object.values(peers).map((p) => ({
    id: p.id,
    isMe: p.isMe,
    screen: p.screen,
    camera: p.camera,
    pinned: view.pinned === p.id,
    handAt: p.handAt,
    speakingSince: speakingSince(p.id),
    lastSpokeAt: p.lastSpokeAt,
    joinedAt: p.joinedAt,
  }));
  const r = layoutCall({ peers: list, now: Date.now(), layout: view.layout, maxTiles: phone ? CALL_LIMITS.tilesPhone : CALL_LIMITS.tilesDesktop, featured: featured.current });
  featured.current = r.featured;
  return { ...r, peers };
}

function Alone({ big }: { big: boolean }) {
  const room = useCallStore((s) => s.room);
  const mine = useCallStore((s) => s.call?.mine);
  const [ring, setRing] = useState(false);
  return (
    <div className="call-alone">
      <span className="call-alone-icon">
        <Icon name="call-people" size={24} />
      </span>
      <strong>Aguardando outras pessoas…</strong>
      {room?.t !== 'd' && <span>Os membros da sala veem a chamada e podem entrar.</span>}
      {big && (mine?.canRing || mine?.canInvite) && (
        <div className="call-alone-actions">
          {mine?.canRing && (
            <button type="button" className="btn" onClick={() => setRing(true)}>
              <Icon name="call-ring" />
              Chamar pessoas
            </button>
          )}
          {mine?.canInvite && room?.t !== 'd' && (
            <button type="button" className="btn" onClick={() => void inviteRoom()}>
              <Icon name="announcement" />
              Avisar a sala
            </button>
          )}
        </div>
      )}
      {ring && <RingPicker onClose={() => setRing(false)} />}
    </div>
  );
}

const openPeople = () => {
  setWindow('big');
  setView({ panel: 'people' });
};

// Janela encaixada: só o quadro em destaque (a tela de quem compartilha, se houver).
export function DockedStage() {
  const { featured, peers } = useLayout(false);
  const list = Object.values(peers);
  if (!list.length) return <div className="call-alone">Conectando…</div>;
  if (list.length === 1 && list[0].isMe && !list[0].screen) return <Alone big={false} />;
  const p = (featured && peers[featured]) || list[0];
  return <Tile peer={p} source={p.screen ? 'screen' : 'camera'} size="md" menu={false} />;
}

export function BigStage({ phone }: { phone: boolean }) {
  const { layout, featured, tiles, hidden, peers } = useLayout(phone);
  const [ref, size] = useSize<HTMLDivElement>();
  const list = Object.values(peers);
  const alone = list.length === 1 && list[0].isMe && !list[0].screen;
  const ptt = useCallStore((s) => s.ptt);

  let body;
  if (!list.length) body = <div className="call-alone">Conectando…</div>;
  else if (alone)
    body = (
      <>
        <Alone big />
        <div className="call-self-tile">
          <Tile peer={list[0]} size="sm" menu={false} />
        </div>
      </>
    );
  else if (layout === 'spotlight' && featured && peers[featured]) {
    const f = peers[featured];
    // A tela vai para o destaque; a câmera de quem compartilha continua na faixa.
    const strip = tiles.filter((id) => id !== featured || f.screen).filter((id) => peers[id]);
    body = (
      <div className={strip.length || hidden ? 'call-spot' : 'call-spot solo'}>
        <div className="call-spot-main">
          <Tile peer={f} source={f.screen ? 'screen' : 'camera'} size="lg" fit />
        </div>
        {(strip.length > 0 || hidden > 0) && (
          <div className="call-strip" role="list" aria-label="Participantes">
            {strip.map((id) => (
              <div key={id} role="listitem" className="call-strip-item">
                <Tile peer={peers[id]} size="sm" />
              </div>
            ))}
            {hidden > 0 && <MoreTile hidden={hidden} onOpen={openPeople} />}
          </div>
        )}
      </div>
    );
  } else {
    const n = tiles.length + (hidden > 0 ? 1 : 0);
    const { cols, rows } = gridShape(n, phone, size.w, size.h);
    const w = Math.max(0, (size.w - GAP * (cols - 1)) / cols);
    const h = Math.max(0, (size.h - GAP * (rows - 1)) / rows);
    // Computador: quadros 16:9 do maior tamanho que cabe; celular: os quadros ocupam o palco todo.
    const tileW = phone ? w : Math.min(w, (h * 16) / 9);
    const tileH = phone ? h : (tileW * 9) / 16;
    const style = { '--tile-w': `${Math.floor(tileW)}px`, '--tile-h': `${Math.floor(tileH)}px` } as CSSProperties;
    const tileSize = tileW >= 480 ? 'lg' : tileW >= 220 ? 'md' : 'sm';
    body = (
      <div className="call-grid" style={style} role="list" aria-label="Participantes">
        {size.w > 0 &&
          tiles
            .filter((id) => peers[id])
            .map((id) => (
              <div key={id} role="listitem" className="call-grid-item">
                <Tile peer={peers[id]} size={tileSize} />
              </div>
            ))}
        {size.w > 0 && hidden > 0 && (
          <div className="call-grid-item">
            <MoreTile hidden={hidden} onOpen={() => setView({ panel: 'people' })} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div className={`call-stage-body ${layout}`} ref={ref}>
      {body}
      {ptt && (
        <span className="call-ptt" role="status">
          <Icon name="mic" size={14} />
          Falando (Espaço)
        </span>
      )}
    </div>
  );
}

// Quadro de uma pessoa: vídeo (câmera ou tela) ou avatar, nome, microfone desligado, mão levantada, o anel de
// quem fala e o menu da pessoa (fixar e, para moderadores, silenciar, desligar vídeo, baixar a mão e remover).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { callUserLabel } from '@shared/calls';
import { currentEngine, moderate, togglePin, useCallStore, type LivePeer } from '../../lib/call/store';
import { Icon } from '../Icon';
import { Avatar, Menu } from '../ui';

// Sem sinal de "compartilhando a tela" do outro lado: preenche o quadro só quando o corte é pequeno.
export function fitFor(video: { w: number; h: number } | null, box: { w: number; h: number } | null, maxCrop: number) {
  if (!video || !box?.h) return 'cover';
  const a = video.w / video.h;
  const b = box.w / box.h;
  return 1 - Math.min(a / b, b / a) > maxCrop ? 'contain' : 'cover';
}

// Vídeo ligado pelo motor: liga de novo quando o motor muda (reconexão).
export function EngineVideo({ peerId, source, className, onSize }: { peerId: string; source: 'camera' | 'screen'; className?: string; onSize?: (w: number, h: number) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const engineId = useCallStore((s) => s.engineId);
  useEffect(() => {
    const el = ref.current;
    const eng = currentEngine();
    if (!el || !eng) return;
    return eng.attach(peerId, source, el);
  }, [engineId, peerId, source]);
  useEffect(() => {
    const v = ref.current;
    if (!v || !onSize) return;
    const report = () => v.videoWidth && onSize(v.videoWidth, v.videoHeight);
    v.addEventListener('resize', report);
    v.addEventListener('loadedmetadata', report);
    return () => {
      v.removeEventListener('resize', report);
      v.removeEventListener('loadedmetadata', report);
    };
  }, [onSize]);
  return <video ref={ref} className={className} autoPlay playsInline muted />;
}

export const peerName = (p: LivePeer) => (p.isMe ? 'Você' : p.user ? callUserLabel(p.user) : 'Alguém');
const fullName = (p: LivePeer) => (p.user ? callUserLabel(p.user) : 'Alguém');

// Ações sobre uma pessoa (quadro e lista de participantes).
export function PeopleActions({ peer, close }: { peer: LivePeer; close: () => void }): ReactNode {
  const pinned = useCallStore((s) => s.view.pinned === peer.id);
  const canModerate = useCallStore((s) => !!s.call?.mine?.canModerate);
  const run = (f: () => void) => () => {
    close();
    f();
  };
  return (
    <>
      <button type="button" onClick={run(() => togglePin(peer.id))}>
        <Icon name={pinned ? 'call-unpin' : 'call-pin'} />
        {pinned ? 'Desafixar' : 'Fixar'}
      </button>
      {canModerate && !peer.isMe && (
        <>
          <hr />
          {peer.mic && (
            <button type="button" onClick={run(() => void moderate(peer.id, 'mute'))}>
              <Icon name="mic-off" />
              Silenciar microfone
            </button>
          )}
          {(peer.camera || peer.screen) && (
            <button type="button" onClick={run(() => void moderate(peer.id, 'stopVideo'))}>
              <Icon name="cam-off" />
              Desligar vídeo
            </button>
          )}
          {peer.handAt && (
            <button type="button" onClick={run(() => void moderate(peer.id, 'lowerHand'))}>
              <Icon name="call-hand" />
              Baixar a mão
            </button>
          )}
          <hr />
          <button type="button" className="danger" onClick={run(() => void moderate(peer.id, 'remove'))}>
            <Icon name="call-remove" />
            Remover da chamada
          </button>
        </>
      )}
    </>
  );
}

export function PeopleMenu({ peer, className }: { peer: LivePeer; className?: string }) {
  const title = `Opções de ${fullName(peer)}`;
  return (
    <Menu
      label={title}
      sheetTitle={fullName(peer)}
      trigger={
        <button type="button" className={className ?? 'call-tile-menu'} title={title} aria-label={title}>
          <Icon name="more-vertical" size={16} />
        </button>
      }
    >
      {(close) => <PeopleActions peer={peer} close={close} />}
    </Menu>
  );
}

// Tamanho do quadro (só no destaque, que decide entre preencher e caber a câmera).
function useBox(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const ro = new ResizeObserver(() => setBox((s) => (s?.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);
  return [ref, box] as const;
}

// fit: quadro do destaque. A câmera cortaria mais de 20% (celular em pé num quadro largo, ou o contrário): cabe
// inteira, com uma cópia borrada atrás no lugar das faixas, como na chamada a dois.
export function Tile({ peer, source = 'camera', size = 'md', menu = true, fit = false }: { peer: LivePeer; source?: 'camera' | 'screen'; size?: 'sm' | 'md' | 'lg'; menu?: boolean; fit?: boolean }) {
  const receiveVideo = useCallStore((s) => s.view.receiveVideo);
  const screen = source === 'screen';
  const has = screen ? peer.screen : peer.camera;
  // Sem receber vídeo, as câmeras dos outros param; telas compartilhadas continuam.
  const paused = has && !screen && !peer.isMe && !receiveVideo;
  const show = has && !paused;
  const name = screen ? (peer.isMe ? 'Sua tela' : `Tela de ${fullName(peer)}`) : peerName(peer);
  const cls = ['call-tile', screen && 'screen', peer.isMe && 'me', peer.speaking && !screen && 'speaking', show && 'has-video'].filter(Boolean).join(' ');
  const avatar = size === 'lg' ? 96 : size === 'md' ? 64 : 40;
  const fitting = fit && show && !screen;
  const [boxRef, box] = useBox(fitting);
  const [video, setVideo] = useState<{ w: number; h: number } | null>(null);
  const onSize = useCallback((w: number, h: number) => setVideo((s) => (s?.w === w && s.h === h ? s : { w, h })), []);
  const contain = screen || (fitting && fitFor(video, box, 0.2) === 'contain');
  const videoCls = [peer.isMe ? 'call-tile-video' : 'call-tile-video call-remote', contain && 'contain', contain && !screen && 'over', peer.isMe && !screen && 'mirror'].filter(Boolean).join(' ');
  return (
    <div className={cls} data-size={size} ref={boxRef}>
      {fitting && contain && <EngineVideo peerId={peer.id} source={source} className="call-backdrop" />}
      {show ? (
        <EngineVideo peerId={peer.id} source={source} className={videoCls} onSize={fitting ? onSize : undefined} />
      ) : (
        <div className="call-tile-face">
          <Avatar username={peer.user?.username} size={avatar} />
          {paused && <span className="call-tile-paused">Vídeo pausado</span>}
        </div>
      )}
      <div className="call-tile-name">
        {!peer.mic && !screen && <Icon name="mic-off" size={14} label="Microfone desligado" className="call-muted" />}
        {peer.handAt && !screen && <Icon name="call-hand" size={14} label="Mão levantada" className="call-hand-up" />}
        <span className="ellipsis">{name}</span>
      </div>
      {menu && !screen && <PeopleMenu peer={peer} />}
    </div>
  );
}

// Último quadro "+N": abre a lista de participantes.
export function MoreTile({ hidden, onOpen }: { hidden: number; onOpen: () => void }) {
  return (
    <button type="button" className="call-tile call-more-tile" title="Ver todos os participantes" aria-label="Ver todos os participantes" onClick={onOpen}>
      <span>+{hidden}</span>
    </button>
  );
}

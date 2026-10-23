import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import type { Call } from '@shared/index';
import { acceptCall, canShareScreen, declineCall, hangup, toggleCamera, toggleMute, toggleScreenShare, useCalls } from '../lib/calls';
import { useSetting, useStore } from '../lib/store';
import { BrandMark } from './BrandIcons';
import { Icon, type IconName } from './Icon';
import { useIsPhone } from './overlay';
import { Avatar } from './ui';

function Video({ stream, muted, className, onSize }: { stream: MediaStream | null; muted?: boolean; className?: string; onSize?: (w: number, h: number) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
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
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} />;
}

function useElapsed(since: string | null | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return '';
  const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- Posição da janela: presa a um canto da área principal ----------

type Corner = 'tr' | 'tl' | 'br' | 'bl';
type View = 'float' | 'big' | 'pill';
const CORNER_KEY = 'wescc.call.corner';

function loadCorner(): Corner {
  try {
    const v = localStorage.getItem(CORNER_KEY);
    if (v === 'tl' || v === 'br' || v === 'bl') return v;
  } catch {
    // sem armazenamento local
  }
  return 'tr';
}
function saveCorner(c: Corner) {
  try {
    localStorage.setItem(CORNER_KEY, c);
  } catch {
    // sem armazenamento local
  }
}

interface Dock {
  vw: number;
  vh: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
  panelLeft: number | null;
  composerTop: number | null;
}

function measureDock(): Dock {
  const main = document.querySelector<HTMLElement>('.layout > .main');
  const r = main?.getBoundingClientRect();
  const box = r && r.width && r.height ? r : new DOMRect(0, 0, innerWidth, innerHeight);
  const pr = main?.querySelector('.panel')?.getBoundingClientRect();
  const cr = main?.querySelector('.room-main .composer')?.getBoundingClientRect();
  return {
    vw: innerWidth,
    vh: innerHeight,
    top: Math.round(box.top),
    left: Math.round(box.left),
    right: Math.round(box.right),
    bottom: Math.round(box.bottom),
    // Painel aberto à direita: a janela anda para a esquerda dele (se ainda couber).
    panelLeft: pr && pr.width && pr.left - box.left > 420 ? Math.round(pr.left) : null,
    composerTop: cr && cr.height ? Math.round(cr.top) : null,
  };
}
const sameDock = (a: Dock | null, b: Dock) => !!a && (Object.keys(b) as (keyof Dock)[]).every((k) => a[k] === b[k]);

// Mede a área principal (e o painel e o compositor dentro dela) enquanto a janela está aberta.
function useDock(active: boolean) {
  const [dock, setDock] = useState<Dock | null>(null);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const next = measureDock();
      setDock((prev) => (sameDock(prev, next) ? prev : next));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    const main = document.querySelector('.layout > .main');
    const ro = new ResizeObserver(schedule);
    const mo = new MutationObserver(schedule);
    if (main) {
      ro.observe(main);
      mo.observe(main, { childList: true, subtree: true });
    }
    addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      removeEventListener('resize', schedule);
    };
  }, [active]);
  return dock;
}

// Abaixo do cabeçalho (56 + 16) no alto; acima do compositor embaixo, para nunca cobrir o "Enviar".
function cornerStyle(d: Dock | null, corner: Corner): CSSProperties {
  if (!d) return {};
  const top = corner[0] === 't';
  const left = corner[1] === 'l';
  return {
    top: top ? d.top + 72 : 'auto',
    bottom: top ? 'auto' : d.vh - (d.composerTop ?? d.bottom) + 16,
    left: left ? d.left + 16 : 'auto',
    right: left ? 'auto' : d.vw - (d.panelLeft ?? d.right) + 16,
  };
}

// Sem sinal de "compartilhando a tela" do outro lado: preenche o palco só quando o corte é pequeno.
function fitFor(video: { w: number; h: number } | null, stage: { w: number; h: number } | null, maxCrop: number) {
  if (!video || !stage?.h) return 'cover';
  const a = video.w / video.h;
  const b = stage.w / stage.h;
  return 1 - Math.min(a / b, b / a) > maxCrop ? 'contain' : 'cover';
}

// ---------- Botões ----------

function CallButton({
  icon,
  title,
  label,
  className,
  onClick,
  size = 22,
}: {
  icon: IconName;
  title: string;
  label?: string;
  className?: string;
  onClick: () => void;
  size?: 22 | 24;
}) {
  return (
    <div className="call-ctl">
      <button type="button" className={className ? `call-btn ${className}` : 'call-btn'} title={title} aria-label={title} onClick={onClick}>
        <Icon name={icon} size={size} />
      </button>
      {label && (
        <span className="call-btn-label" aria-hidden="true">
          {label}
        </span>
      )}
    </div>
  );
}

function ToolButton({ icon, title, onClick }: { icon: IconName; title: string; onClick: () => void }) {
  return (
    <button type="button" className="call-tool" title={title} aria-label={title} onClick={onClick}>
      <Icon name={icon} size={18} />
    </button>
  );
}

// ---------- Chamada recebida ----------

function IncomingCall({ call }: { call: Call }) {
  const phone = useIsPhone();
  const who = call.caller;
  const name = who.name || who.username;
  const video = call.kind === 'video';
  const statusText = useStore((s) => s.presence[who.username]?.statusText);
  const last = useStore((s) => s.rooms[call.rid]?.lastMessage);
  const site = useSetting<string>('Site_Name');
  // A última mensagem de quem liga, se acabou de chegar, costuma dizer o assunto ("vou mostrar a planilha").
  const quote = last && last.u._id === who._id && last.msg && Date.now() - new Date(last.ts).getTime() < 10 * 60000 ? last.msg : '';
  const kindIcon: IconName = video ? 'call-video' : 'call-audio';
  const decline = <CallButton icon="call-hangup" title="Recusar" label="Recusar" className="hang" size={phone ? 24 : 22} onClick={() => void declineCall()} />;
  const accept = <CallButton icon={kindIcon} title="Atender" label="Atender" className="accept" size={phone ? 24 : 22} onClick={() => void acceptCall()} />;

  if (phone) {
    return (
      <div className="call-incoming full" role="alertdialog" aria-label={`Chamada recebida de ${name}`}>
        {site && (
          <div className="call-brand">
            <BrandMark size={20} />
            <span>{site}</span>
          </div>
        )}
        <div className="call-hero">
          <span className="call-rings">
            <i />
            <i />
            <i />
            <Avatar username={who.username} size={120} />
          </span>
          <strong className="call-name">{name}</strong>
          <span className="call-kind">
            <Icon name={kindIcon} />
            {video ? 'Chamada de vídeo recebida' : 'Chamada de voz recebida'}
          </span>
          {quote && (
            <span className="call-quote">
              <Icon name="room-dm" size={14} />
              <span>“{quote}”</span>
            </span>
          )}
        </div>
        <div className="call-answer">
          {video && (
            <button type="button" className="call-audio-only" title="Atender só com áudio" onClick={() => void acceptCall(true)}>
              <Icon name="call-audio" />
              Só áudio
            </button>
          )}
          <div className="call-buttons">
            {decline}
            {accept}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="call-incoming" role="alertdialog" aria-label={`Chamada recebida de ${name}`}>
      <div className="call-incoming-head">
        <span className="call-ring">
          <Avatar username={who.username} size={48} />
        </span>
        <div className="call-who">
          <strong>{name}</strong>
          <span className="call-kind">
            <Icon name={kindIcon} size={14} />
            <span className="ellipsis">
              {video ? 'Chamada de vídeo' : 'Chamada de voz'}
              {statusText ? ` · ${statusText}` : ''}
            </span>
          </span>
        </div>
      </div>
      <div className="call-buttons">
        {decline}
        {video && <CallButton icon="call-audio" title="Atender só com áudio" label="Só áudio" onClick={() => void acceptCall(true)} />}
        {accept}
      </div>
    </div>
  );
}

// ---------- Janela da chamada ----------

function CallWindow({ call, me }: { call: Call; me: { _id: string; username: string } }) {
  const { local, remote, muted, cameraOff, sharing, connected } = useCalls();
  const phone = useIsPhone();
  const [state, setView] = useState<View>(() => (phone ? 'big' : 'float'));
  // No celular não existe a janela flutuante: é a tela cheia ou a pílula.
  const view: View = phone && state === 'float' ? 'big' : state;
  const big = view === 'big';
  const [corner, setCorner] = useState<Corner>(loadCorner);
  const dock = useDock(!phone);
  const elapsed = useElapsed(connected ? call.answeredAt : null);
  const ref = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [remoteSize, setRemoteSize] = useState<{ w: number; h: number } | null>(null);
  const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null);
  const onRemoteSize = useCallback((w: number, h: number) => setRemoteSize((s) => (s?.w === w && s.h === h ? s : { w, h })), []);
  const [idle, setIdle] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const other = call.caller._id === me._id ? call.callee : call.caller;
  const name = other.name || other.username;
  const ringing = call.status === 'ringing';
  const hasRemoteVideo = !!remote?.getVideoTracks().some((t) => t.readyState === 'live');
  const hasCamera = !!local?.getVideoTracks().length;
  const hasLocalVideo = hasCamera && !cameraOff;
  const status = ringing ? 'Chamando…' : !connected ? 'Conectando…' : elapsed;
  const canShare = connected && canShareScreen();

  // Celular: saiu da tela (navegou), a chamada vira a pílula no alto.
  const { pathname } = useLocation();
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    if (phone) setView('pill');
  }, [pathname, phone]);

  // Ampliada: os controles somem depois de 3 s parados e voltam com qualquer movimento ou toque.
  useEffect(() => {
    const el = ref.current;
    if (!big || !connected || !el) return setIdle(false);
    let t = window.setTimeout(() => setIdle(true), 3000);
    const wake = () => {
      setIdle(false);
      clearTimeout(t);
      t = window.setTimeout(() => setIdle(true), 3000);
    };
    el.addEventListener('pointermove', wake);
    el.addEventListener('pointerdown', wake);
    el.addEventListener('keydown', wake);
    return () => {
      clearTimeout(t);
      el.removeEventListener('pointermove', wake);
      el.removeEventListener('pointerdown', wake);
      el.removeEventListener('keydown', wake);
    };
  }, [big, connected]);

  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement && document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  // Tamanho do palco, para decidir entre preencher e caber o vídeo do outro lado.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageSize((s) => (s?.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void ref.current?.requestFullscreen?.().catch(() => {});
  };
  const setMode = (v: View) => {
    if (v !== 'big' && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    setView(v);
  };

  // Arrastar pelo palco (ou pela pílula) e soltar perto de um canto: a janela encaixa nele.
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const flip = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const [snap, setSnap] = useState(0);
  const draggable = !phone && view !== 'big';
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggable || e.button !== 0) return;
    const btn = (e.target as HTMLElement).closest('button');
    if (btn && !btn.classList.contains('call-pill-main')) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || d.id !== e.pointerId || !el) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      el.setPointerCapture(e.pointerId);
      el.dataset.drag = '';
    }
    el.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    const el = ref.current;
    if (!d || d.id !== e.pointerId || !d.moved || !el) return;
    suppressClick.current = true;
    const r = el.getBoundingClientRect();
    flip.current = { x: r.left, y: r.top };
    const box = dock ?? measureDock();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const next = `${cy < (box.top + box.bottom) / 2 ? 't' : 'b'}${cx < (box.left + box.right) / 2 ? 'l' : 'r'}` as Corner;
    setCorner(next);
    saveCorner(next);
    setSnap((n) => n + 1);
  };
  // Encaixe animado: parte de onde foi solta e desliza até o canto (FLIP).
  useLayoutEffect(() => {
    const el = ref.current;
    const f = flip.current;
    if (!el || !f) return;
    flip.current = null;
    delete el.dataset.drag;
    el.style.transform = '';
    const r = el.getBoundingClientRect();
    el.style.transition = 'none';
    el.style.transform = `translate(${f.x - r.left}px, ${f.y - r.top}px)`;
    void el.offsetWidth;
    el.style.transition = '';
    el.style.transform = '';
  }, [snap]);

  const style: CSSProperties | undefined = phone
    ? undefined
    : big
      ? dock
        ? { top: dock.top, left: dock.left, width: dock.right - dock.left, height: dock.bottom - dock.top }
        : undefined
      : cornerStyle(dock, corner);

  const labels = phone;
  const micBtn = (
    <CallButton
      icon={muted ? 'mic-off' : 'mic'}
      title={muted ? 'Ligar microfone' : 'Desligar microfone'}
      label={labels ? 'Microfone' : undefined}
      className={muted ? 'off' : ''}
      onClick={toggleMute}
    />
  );
  const hangBtn = <CallButton icon="call-hangup" title="Desligar" label={labels ? 'Desligar' : undefined} className="hang" onClick={() => void hangup()} />;
  const classes = ['call-window', view === 'float' ? '' : view, phone ? 'phone' : '', idle ? 'idle' : '', hasRemoteVideo ? 'has-video' : ''].filter(Boolean).join(' ');
  const common = {
    ref,
    className: classes,
    style,
    role: 'dialog',
    'aria-label': `Chamada com ${name}`,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onClickCapture: (e: { stopPropagation: () => void; preventDefault: () => void }) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      e.stopPropagation();
      e.preventDefault();
    },
  };

  if (view === 'pill') {
    return (
      <div {...common} className={`${classes} call-pill`}>
        {/* O áudio do outro lado continua tocando com a janela recolhida. */}
        <Video stream={remote} className="call-hidden" />
        <div className="call-bar">
          <button type="button" className="call-pill-main" title="Abrir chamada" aria-label={`Abrir chamada com ${name}`} onClick={() => setMode(phone ? 'big' : 'float')}>
            <Avatar username={other.username} size={phone ? 28 : 32} />
            <span className="call-who">
              <strong>{name}</strong>
              <span className="call-status">{status}</span>
            </span>
          </button>
          <div className="call-buttons">
            {micBtn}
            {hangBtn}
          </div>
        </div>
      </div>
    );
  }

  const fit = fitFor(remoteSize, stageSize, big ? 0.2 : 0.35);
  const placeholder: ReactNode = (
    <div className="call-placeholder">
      <span className={ringing ? 'call-ring out' : 'call-ring idle'}>
        <Avatar username={other.username} size={big ? (phone ? 120 : 96) : 72} />
      </span>
      {big && (
        <>
          <strong className="call-name">{name}</strong>
          <span className="call-status">{status}</span>
        </>
      )}
      {/* Áudio do outro lado quando não há vídeo. */}
      <Video stream={remote} className="call-hidden" />
    </div>
  );
  return (
    <div {...common}>
      <div className="call-stage" ref={stageRef}>
        {/* Vídeo que não preenche o palco (tela compartilhada, câmera deitada no celular): uma cópia borrada atrás, no lugar das faixas pretas. */}
        {hasRemoteVideo && fit === 'contain' && <Video stream={remote} muted className="call-backdrop" />}
        {hasRemoteVideo ? <Video stream={remote} className={fit === 'contain' ? 'call-remote contain' : 'call-remote'} onSize={onRemoteSize} /> : placeholder}
        {hasLocalVideo ? (
          <Video stream={local} muted className={`call-local ${sharing ? 'screen' : ''}`} />
        ) : (
          big &&
          call.kind === 'video' && (
            <div className="call-self" title="Sua câmera está desligada">
              <Avatar username={me.username} size={48} />
            </div>
          )
        )}
      </div>
      <div className="call-bar">
        <div className="call-bar-head">
          <div className={big ? (hasRemoteVideo ? 'call-who call-chip' : 'call-who visually-hidden') : 'call-who'}>
            <strong>{name}</strong>
            <span className="call-status">{status}</span>
          </div>
          <div className="call-tools">
            {!phone && big && <ToolButton icon="fullscreen" title={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'} onClick={toggleFullscreen} />}
            {!phone && <ToolButton icon={big ? 'shrink' : 'enlarge'} title={big ? 'Diminuir' : 'Ampliar'} onClick={() => setMode(big ? 'float' : 'big')} />}
            <ToolButton icon="call-minimize" title="Minimizar" onClick={() => setMode('pill')} />
          </div>
        </div>
        <div className="call-buttons">
          {micBtn}
          {hasCamera && !sharing && (
            <CallButton
              icon={cameraOff ? 'cam-off' : 'cam'}
              title={cameraOff ? 'Ligar câmera' : 'Desligar câmera'}
              label={labels ? 'Câmera' : undefined}
              className={cameraOff ? 'off' : ''}
              onClick={toggleCamera}
            />
          )}
          {canShare && (
            <CallButton
              icon={sharing ? 'screen-stop' : 'screen-share'}
              title={sharing ? 'Parar de compartilhar' : 'Compartilhar tela'}
              label={labels ? 'Tela' : undefined}
              className={sharing ? 'on' : ''}
              onClick={() => void toggleScreenShare()}
            />
          )}
          {hangBtn}
        </div>
      </div>
    </div>
  );
}

// Toque de chamada recebida e janela da chamada em andamento (fica por cima de qualquer tela).
export function CallOverlay() {
  const { call, incoming } = useCalls();
  const me = useStore((s) => s.me);
  if (incoming && !call) return <IncomingCall call={incoming} />;
  if (!call || !me) return null;
  return <CallWindow key={call._id} call={call} me={me} />;
}

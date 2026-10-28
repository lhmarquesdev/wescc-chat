// Janela da chamada: encaixada (360 px, arrastável para os 4 cantos), pílula e ampliada (cobre a área principal; no
// celular, a tela toda). A chamada a dois mantém a janela de sempre; a em grupo tem palco, cabeçalho, barra e lista.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';
import { formatCallClock, formatCallDuration } from '@shared/calls';
import type { Call, UserRef } from '@shared/index';
import { bringHere, callRoomName, dismissElsewhere, dismissEnded, expandCall, leaveCall, serverNow, setView, setWindow, toggleCamera, toggleMic, toggleScreen, useCallStore } from '../../lib/call/store';
import { roomIconName } from '../../lib/format';
import { useStore } from '../../lib/store';
import { Icon } from '../Icon';
import { useIsPhone } from '../overlay';
import { Avatar, GroupAvatar } from '../ui';
import { CallButton, canShareScreen, GroupControls, PeopleChip, ToolButton } from './ControlBar';
import { cornerStyle, loadCorner, mainStyle, measureDock, saveCorner, useDock, type Corner, type Dock } from './dock';
import { CallBanners } from './GuardBanner';
import { PeoplePanel } from './PeoplePanel';
import { BigStage, DockedStage } from './Stage';
import { EngineVideo, fitFor } from './Tile';

// Tempo de chamada pelo relógio do servidor (nunca negativo).
function useCallClock(since: string | null | undefined) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!since) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return '';
  return formatCallClock((serverNow() - Date.parse(since)) / 1000);
}

// Ampliada com vídeo na tela: os controles somem depois de 3 s parados e voltam com qualquer movimento ou toque.
function useIdle(ref: RefObject<HTMLDivElement | null>, active: boolean) {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return setIdle(false);
    // Menu aberto fica num portal, fora da janela: enquanto ele estiver aberto os controles não somem por baixo.
    const rest = () => {
      if (el.querySelector('[aria-expanded="true"]')) t = window.setTimeout(rest, 3000);
      else setIdle(true);
    };
    let t = window.setTimeout(rest, 3000);
    const wake = () => {
      setIdle(false);
      clearTimeout(t);
      t = window.setTimeout(rest, 3000);
    };
    el.addEventListener('pointermove', wake);
    el.addEventListener('pointerdown', wake);
    el.addEventListener('keydown', wake);
    el.addEventListener('focusin', wake);
    return () => {
      clearTimeout(t);
      el.removeEventListener('pointermove', wake);
      el.removeEventListener('pointerdown', wake);
      el.removeEventListener('keydown', wake);
      el.removeEventListener('focusin', wake);
    };
  }, [ref, active]);
  return idle;
}

// Tela cheia na raiz da chamada (.call-root): a camada dos menus e avisos continua visível.
function useFullscreen(ref: RefObject<HTMLDivElement | null>) {
  const fullscreen = useCallStore((s) => s.view.fullscreen);
  useEffect(() => {
    const onChange = () => {
      const root = ref.current?.closest('.call-root');
      setView({ fullscreen: !!document.fullscreenElement && document.fullscreenElement === root });
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [ref]);
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void (ref.current?.closest('.call-root') as HTMLElement | null)?.requestFullscreen?.().catch(() => {});
  };
  return { fullscreen, toggle };
}

// Celular: saiu da tela (navegou), a chamada vira a pílula no alto.
function usePillOnNavigate(phone: boolean) {
  const { pathname } = useLocation();
  const last = useRef(pathname);
  useEffect(() => {
    if (last.current === pathname) return;
    last.current = pathname;
    if (phone) setWindow('pill');
  }, [pathname, phone]);
}

// Arrastar pelo palco (ou pela pílula) e soltar perto de um canto: a janela encaixa nele (FLIP).
function useDrag(ref: RefObject<HTMLDivElement | null>, enabled: boolean, dock: Dock | null) {
  const [corner, setCorner] = useState<Corner>(loadCorner);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const flip = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const [snap, setSnap] = useState(0);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || e.button !== 0) return;
    const btn = (e.target as HTMLElement).closest('button, [role="menu"]');
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
  }, [snap, ref]);
  return {
    corner,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      // Texto ou imagem arrastados pelo navegador cancelam o ponteiro (pointercancel) e a janela fica no meio do caminho.
      onDragStart: (e: { preventDefault: () => void }) => {
        if (enabled) e.preventDefault();
      },
      onClickCapture: (e: { stopPropagation: () => void; preventDefault: () => void }) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        e.stopPropagation();
        e.preventDefault();
      },
    },
  };
}

// Pílula: avatar (ou ícone da sala), nome, tempo, microfone e sair.
function Pill({ name, status, avatar, hangTitle, phone, label, common }: { name: string; status: string; avatar: ReactNode; hangTitle: string; phone: boolean; label: string; common: Record<string, unknown> }) {
  const mic = useCallStore((s) => s.me.mic);
  return (
    <div {...common} className={['call-window', 'call-pill', phone && 'phone'].filter(Boolean).join(' ')} role="dialog" aria-label={label}>
      <div className="call-bar">
        <button type="button" className="call-pill-main" title="Abrir a chamada" aria-label={`Abrir a chamada: ${name}`} onClick={expandCall}>
          {avatar}
          <span className="call-who">
            <strong>{name}</strong>
            <span className="call-status">{status}</span>
          </span>
        </button>
        <div className="call-buttons">
          <CallButton icon={mic ? 'mic' : 'mic-off'} title={mic ? 'Desligar microfone' : 'Ligar microfone'} className={mic ? '' : 'off'} onClick={() => void toggleMic()} />
          <CallButton icon="call-hangup" title={hangTitle} className="hang" onClick={() => void leaveCall()} />
        </div>
      </div>
    </div>
  );
}

// ---------- Chamada a dois (a janela de sempre) ----------

function DirectWindow({ call, me }: { call: Call; me: UserRef }) {
  const phone = useIsPhone();
  const phase = useCallStore((s) => s.phase);
  const mode = useCallStore((s) => s.view.window);
  const local = useCallStore((s) => s.me);
  const other = (call.caller._id === me._id ? call.callee : call.caller) ?? call.caller;
  const remote = useCallStore((s) => s.peers[other._id]);
  // No celular não existe a janela flutuante: é a tela cheia ou a pílula.
  const view = phone && mode === 'docked' ? 'big' : mode;
  const big = view === 'big';
  const connected = phase === 'in-call';
  const ringing = phase === 'ringing-out' || call.status === 'ringing';
  const elapsed = useCallClock(connected ? call.answeredAt : null);
  const ref = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dock = useDock(!phone);
  const { fullscreen, toggle } = useFullscreen(ref);
  const [remoteSize, setRemoteSize] = useState<{ w: number; h: number } | null>(null);
  const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null);
  const onRemoteSize = useCallback((w: number, h: number) => setRemoteSize((s) => (s?.w === w && s.h === h ? s : { w, h })), []);
  usePillOnNavigate(phone);
  const { corner, handlers } = useDrag(ref, !phone && !big, dock);

  const name = other.name || other.username;
  const hasRemoteVideo = !!remote?.camera;
  const sharing = local.screen;
  const hasCamera = call.kind === 'video' || local.camera;
  const hasLocalVideo = local.camera || sharing;
  const muted = !local.mic;
  const cameraOff = !local.camera;
  const status = ringing ? 'Chamando…' : !connected ? 'Conectando…' : elapsed;
  const canShare = connected && canShareScreen();
  const idle = useIdle(ref, big && connected && (hasRemoteVideo || hasLocalVideo));

  // Tamanho do palco, para decidir entre preencher e caber o vídeo do outro lado.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageSize((s) => (s?.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);

  const style: CSSProperties | undefined = phone || fullscreen ? undefined : big ? mainStyle(dock) : cornerStyle(dock, corner);
  const labels = phone;
  const micBtn = (
    <CallButton icon={muted ? 'mic-off' : 'mic'} title={muted ? 'Ligar microfone' : 'Desligar microfone'} label={labels ? 'Microfone' : undefined} className={muted ? 'off' : ''} onClick={() => void toggleMic()} />
  );
  const hangBtn = <CallButton icon="call-hangup" title="Desligar" label={labels ? 'Desligar' : undefined} className="hang" onClick={() => void leaveCall()} />;
  const classes = ['call-window', view === 'docked' ? '' : view, phone ? 'phone' : '', idle ? 'idle' : '', hasRemoteVideo ? 'has-video' : ''].filter(Boolean).join(' ');
  const common = { ref, style, ...handlers };

  if (view === 'pill') return <Pill name={name} status={status} avatar={<Avatar username={other.username} size={phone ? 28 : 32} />} hangTitle="Desligar" phone={phone} label={`Chamada com ${name}`} common={common} />;

  const fit = fitFor(remoteSize, stageSize, big ? 0.2 : 0.35);
  const placeholder = (
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
    </div>
  );
  return (
    <div {...common} className={classes} role="dialog" aria-label={`Chamada com ${name}`}>
      <div className="call-stage" ref={stageRef}>
        {/* Vídeo que não preenche o palco (tela compartilhada, câmera deitada no celular): uma cópia borrada atrás, no lugar das faixas pretas. */}
        {hasRemoteVideo && fit === 'contain' && <EngineVideo peerId={other._id} source="camera" className="call-backdrop" />}
        {hasRemoteVideo ? <EngineVideo peerId={other._id} source="camera" className={fit === 'contain' ? 'call-remote contain' : 'call-remote'} onSize={onRemoteSize} /> : placeholder}
        {hasLocalVideo ? (
          <EngineVideo peerId={me._id} source="camera" className={`call-local ${sharing ? 'screen' : ''}`} />
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
            {!phone && big && <ToolButton icon={fullscreen ? 'call-exit-fullscreen' : 'call-fullscreen'} title={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'} onClick={toggle} />}
            {!phone && <ToolButton icon={big ? 'shrink' : 'enlarge'} title={big ? 'Diminuir' : 'Ampliar'} onClick={() => setWindow(big ? 'docked' : 'big')} />}
            <ToolButton icon="call-minimize" title="Minimizar" onClick={() => setWindow('pill')} />
          </div>
        </div>
        <div className="call-buttons">
          {micBtn}
          {hasCamera && !sharing && (
            <CallButton icon={cameraOff ? 'cam-off' : 'cam'} title={cameraOff ? 'Ligar câmera' : 'Desligar câmera'} label={labels ? 'Câmera' : undefined} className={cameraOff ? 'off' : ''} onClick={() => void toggleCamera()} />
          )}
          {canShare && (
            <CallButton
              icon={sharing ? 'screen-stop' : 'screen-share'}
              title={sharing ? 'Parar de compartilhar' : 'Compartilhar tela'}
              label={labels ? 'Tela' : undefined}
              className={sharing ? 'on' : ''}
              onClick={() => void toggleScreen()}
            />
          )}
          {hangBtn}
        </div>
      </div>
    </div>
  );
}

// ---------- Chamada em grupo ----------

function RoomBadge({ size }: { size: number }) {
  const room = useCallStore((s) => s.room);
  const me = useStore((s) => s.me?.username);
  if (room?.t === 'd') return <GroupAvatar usernames={(room.usernames ?? []).filter((u) => u !== me)} size={size} />;
  return (
    <span className="call-room-icon" style={{ width: size, height: size }}>
      <Icon name={room ? roomIconName(room) : 'room-channel'} size={size >= 32 ? 18 : 16} />
    </span>
  );
}

function SignalLow() {
  const poor = useCallStore((s) => {
    const mine = Object.values(s.peers).find((p) => p.isMe);
    return mine?.quality === 'poor' || mine?.quality === 'lost';
  });
  if (!poor) return null;
  return (
    <span className="call-signal" title="Sua conexão está instável">
      <Icon name="call-signal-low" label="Sua conexão está instável" />
    </span>
  );
}

function useGroupStatus(call: Call) {
  const phase = useCallStore((s) => s.phase);
  const clock = useCallClock(call.createdAt);
  return phase === 'connecting' ? 'Conectando…' : phase === 'reconnecting' ? 'Reconectando…' : clock;
}

function GroupWindow({ call }: { call: Call }) {
  const phone = useIsPhone();
  const mode = useCallStore((s) => s.view.window);
  const panel = useCallStore((s) => s.view.panel);
  const room = useCallStore((s) => s.room);
  // Os controles somem só com vídeo de outra pessoa na tela: sozinho, com a própria câmera, ficam à mão.
  const watching = useCallStore((s) => Object.values(s.peers).some((p) => !p.isMe && (p.camera || p.screen)));
  const view = phone && mode === 'docked' ? 'big' : mode;
  const big = view === 'big';
  const ref = useRef<HTMLDivElement>(null);
  const dock = useDock(!phone);
  const { fullscreen, toggle } = useFullscreen(ref);
  usePillOnNavigate(phone);
  const { corner, handlers } = useDrag(ref, !phone && !big, dock);
  const idle = useIdle(ref, big && watching && !panel);
  const name = callRoomName(room) || 'Chamada em grupo';
  const status = useGroupStatus(call);
  const style: CSSProperties | undefined = phone || fullscreen ? undefined : big ? mainStyle(dock) : cornerStyle(dock, corner);
  const common = { ref, style, ...handlers };
  const label = `Chamada em ${name}`;

  if (view === 'pill') return <Pill name={name} status={status} avatar={<RoomBadge size={phone ? 28 : 32} />} hangTitle="Sair da chamada" phone={phone} label={label} common={common} />;

  if (!big)
    return (
      <div {...common} className="call-window group" role="dialog" aria-label={label}>
        <div className="call-stage" onClick={() => setWindow('big')}>
          <DockedStage />
          <CallBanners />
        </div>
        <div className="call-bar">
          <div className="call-bar-head">
            <div className="call-who">
              <strong>{name}</strong>
              <span className="call-status">{status}</span>
            </div>
            <PeopleChip docked />
            <SignalLow />
            <div className="call-tools">
              <ToolButton icon="enlarge" title="Ampliar" onClick={() => setWindow('big')} />
              <ToolButton icon="call-minimize" title="Minimizar" onClick={() => setWindow('pill')} />
            </div>
          </div>
          <GroupControls mode="docked" />
        </div>
      </div>
    );

  const classes = ['call-window', 'group', 'g-big', phone && 'g-phone', idle && 'idle', panel && !phone && 'with-panel'].filter(Boolean).join(' ');
  return (
    <div {...common} className={classes} role="dialog" aria-label={label}>
      <div className="call-head">
        <div className="call-who">
          <strong>{name}</strong>
          <span className="call-status">{status}</span>
        </div>
        <PeopleChip />
        <SignalLow />
        <div className="call-tools">
          {!phone && <ToolButton icon={fullscreen ? 'call-exit-fullscreen' : 'call-fullscreen'} title={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'} onClick={toggle} />}
          {!phone && <ToolButton icon="shrink" title="Diminuir" onClick={() => setWindow('docked')} />}
          <ToolButton icon="call-minimize" title="Minimizar" onClick={() => setWindow('pill')} />
        </div>
      </div>
      {/* Depois do cabeçalho no DOM, como na tela: o Tab vai do cabeçalho às faixas, aos quadros e à barra. As faixas
          ficam no palco, acima dos quadros (não por cima da primeira linha nem dos menus dela). */}
      <div className="call-stage" tabIndex={0} aria-label="Palco da chamada">
        <div className="call-banners-slot">
          <CallBanners />
        </div>
        <BigStage phone={phone} />
      </div>
      <div className="call-bar">
        <GroupControls mode={phone ? 'phone' : 'big'} />
      </div>
      {panel === 'people' && <PeoplePanel phone={phone} />}
    </div>
  );
}

// ---------- Fim, outro aparelho ----------

function Notice({ icon, title, lines, actions }: { icon: 'call-hangup' | 'call-switch-camera'; title: string; lines: string[]; actions: ReactNode }) {
  const phone = useIsPhone();
  const mode = useCallStore((s) => s.view.window);
  const big = phone || mode === 'big';
  const dock = useDock(!phone);
  const style = phone ? undefined : big ? mainStyle(dock) : cornerStyle(dock, loadCorner());
  return (
    <div className={['call-window', 'group', big && 'g-big', phone && 'g-phone'].filter(Boolean).join(' ')} style={style} role="dialog" aria-label={title}>
      <div className="call-end" role="status">
        <span className="call-end-icon">
          <Icon name={icon} size={24} />
        </span>
        <strong>{title}</strong>
        {lines.filter(Boolean).map((l) => (
          <span key={l}>{l}</span>
        ))}
        <div className="call-end-actions">{actions}</div>
      </div>
    </div>
  );
}

export function CallWindow() {
  const call = useCallStore((s) => s.call);
  const phase = useCallStore((s) => s.phase);
  const ended = useCallStore((s) => s.ended);
  const elsewhere = useCallStore((s) => s.elsewhere);
  const me = useStore((s) => s.me);
  // No celular a tela é cheia: botões no tamanho de toque (44 px), não os pequenos da janela encaixada.
  const btn = useIsPhone() ? 'btn' : 'btn small';
  if (phase === 'ended' && ended)
    return (
      <Notice
        icon="call-hangup"
        title={ended.title}
        lines={[`Você ficou ${formatCallDuration(ended.seconds)}`, ended.text]}
        actions={
          <button type="button" className={btn} onClick={dismissEnded}>
            Fechar
          </button>
        }
      />
    );
  if (!call || !me || phase === 'idle' || phase === 'preflight') return null;
  if (elsewhere)
    return (
      <Notice
        icon="call-switch-camera"
        title={elsewhere === 'tab' ? 'Você entrou nesta chamada em outra aba.' : 'Você entrou nesta chamada em outro dispositivo.'}
        lines={[]}
        actions={
          <>
            <button type="button" className={btn} onClick={dismissElsewhere}>
              Fechar
            </button>
            <button type="button" className={`${btn} primary`} onClick={() => void bringHere()}>
              Trazer para cá
            </button>
          </>
        }
      />
    );
  if (call.scope === 'direct') return <DirectWindow key={call._id} call={call} me={me} />;
  return <GroupWindow key={call._id} call={call} />;
}

// Tela de entrada da chamada em grupo: prévia da câmera, microfone com medidor, aparelhos e o aviso de quem vai
// receber a chamada. As faixas abertas aqui vão direto para a chamada (sem pedir a permissão de novo).
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { CALL_LIMITS, callNamesLabel } from '@shared/calls';
import type { Call, CallRoomRef } from '@shared/index';
import { api } from '../../lib/api';
import { createMeter, lowResFor, openMedia, openTrack, PROBLEM_TEXT, problemOf, type MediaProblem } from '../../lib/call/devices';
import { callRoomName, cancelPreflight, confirmPreflight, isInCall, useCallStore } from '../../lib/call/store';
import { useStore } from '../../lib/store';
import { Icon } from '../Icon';
import { focusables, useEscape, useIsPhone } from '../overlay';
import { Avatar } from '../ui';
import { CallButton } from './ControlBar';
import { DeviceMenu } from './DeviceMenu';
import { mainStyle, useDock } from './dock';
import { SelfTest } from './SelfTest';

const MUTED_LINE = 'Você entra com o microfone desligado porque a chamada já tem várias pessoas.';
const OTHER_DEVICE_LINE = 'Você está nesta chamada em outro dispositivo.';
const IOS_LINE = 'No iPhone, a chamada para quando a tela bloqueia ou o Safari vai para segundo plano.';
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

function Meter({ track, on }: { track: MediaStreamTrack | null; on: boolean }) {
  const bar = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!track) return;
    const m = createMeter(track);
    if (!m) return;
    let raf = 0;
    let last = -1;
    const loop = () => {
      const v = Math.round(m.level() * 100);
      if (bar.current) bar.current.style.transform = `scaleX(${v / 100})`;
      // O valor para leitores de tela muda em degraus de 10, não a cada quadro.
      const step = Math.round(v / 10) * 10;
      if (step !== last && box.current) box.current.setAttribute('aria-valuenow', String((last = step)));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      m.stop();
    };
  }, [track]);
  return (
    <div ref={box} className={on ? 'call-meter' : 'call-meter off'} role="meter" aria-label="Nível do microfone" aria-valuemin={0} aria-valuemax={100} aria-valuenow={0}>
      <Icon name={on ? 'mic' : 'mic-off'} size={14} />
      <span className="call-meter-track">
        <span ref={bar} className="call-meter-bar" />
      </span>
    </div>
  );
}

export function Preflight() {
  const pf = useCallStore((s) => s.preflight)!;
  const phone = useIsPhone();
  const dock = useDock(!phone);
  const room = useStore((s) => s.rooms[pf.rid]);
  const sub = useStore((s) => s.subscriptions[pf.rid]);
  const me = useStore((s) => s.me);
  const titleId = useId();
  const [info, setInfo] = useState<Call | null>(null);
  const infoRef = useRef<Call | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(pf.kind === 'video');
  const [mic, setMic] = useState<MediaStreamTrack | null>(null);
  const [cam, setCam] = useState<MediaStreamTrack | null>(null);
  const [problem, setProblem] = useState<MediaProblem | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState(false);
  const [mutedByCount, setMutedByCount] = useState(false);
  const tracks = useRef<{ mic: MediaStreamTrack | null; cam: MediaStreamTrack | null; handed: boolean }>({ mic: null, cam: null, handed: false });
  const video = useRef<HTMLVideoElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const touchedCam = useRef(false);

  const keep = (m: MediaStreamTrack | null, c: MediaStreamTrack | null) => {
    tracks.current.mic = m;
    tracks.current.cam = c;
    setMic(m);
    setCam(c);
  };

  // Entrar: quantos já estão e de que tipo é a chamada (a câmera começa ligada numa chamada de vídeo).
  useEffect(() => {
    if (pf.mode === 'start' || !pf.callId) return;
    let alive = true;
    api
      .get('calls.info', { callId: pf.callId })
      .then((r: { call: Call }) => {
        if (!alive) return;
        infoRef.current = r.call;
        setInfo(r.call);
        if (r.call.participantsCount >= CALL_LIMITS.joinMutedFrom) {
          setMicOn(false);
          setMutedByCount(true);
        }
        if (!touchedCam.current && r.call.kind === 'video') setCamOn(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pf.mode, pf.callId]);

  // Navegador sem chamadas: o motor de grupo diz (o pedaço do LiveKit já fica carregado para a chamada).
  useEffect(() => {
    void import('../../lib/call/sfu').then((m) => setUnsupported(!m.browserSupported())).catch(() => {});
  }, []);

  const camWant = useRef(camOn);
  camWant.current = camOn;
  // Cada montagem (o StrictMode monta duas vezes) e cada "Tentar de novo" é uma nova geração: o que uma abertura
  // antiga devolver depois é solto, sem mexer nas faixas nem no aviso da atual.
  const gen = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const stale = (g: number) => g !== gen.current || tracks.current.handed;
  // Uma operação de aparelho por vez: duas aberturas ao mesmo tempo deixavam uma câmera acesa sem dono.
  const run = (op: (g: number) => Promise<void>) => {
    const g = gen.current;
    queue.current = queue.current.then(() => (stale(g) ? undefined : op(g))).catch(() => {});
  };
  // Chamada pesada ou computador fraco: a prévia já abre em 360p, como a câmera vai na chamada.
  const lowRes = () => lowResFor((infoRef.current?.participantsCount ?? 0) + 1);

  // Deixa a câmera como o botão manda: abre (pedindo a permissão uma vez) ou solta o aparelho (a luz apaga).
  const syncCam = () =>
    run(async (g) => {
      const want = camWant.current;
      if (!want && tracks.current.cam) {
        tracks.current.cam.stop();
        keep(tracks.current.mic, null);
        return;
      }
      if (!want || tracks.current.cam) return;
      try {
        const t = await openTrack('cam', undefined, { lowRes: lowRes() });
        if (stale(g) || !camWant.current) return t.stop();
        keep(tracks.current.mic, t);
        setProblem((p) => (p === 'no-camera' ? null : p));
      } catch (e) {
        if (stale(g)) return;
        const p = problemOf(e);
        setProblem(p === 'no-mic' ? 'no-camera' : p);
        setCamOn(false);
      }
    });

  const open = () =>
    run(async (g) => {
      setBusy(true);
      const m = await openMedia({ audio: true, video: camWant.current, lowRes: lowRes() });
      if (stale(g)) {
        m.audio?.stop();
        m.video?.stop();
        return;
      }
      setBusy(false);
      tracks.current.mic?.stop();
      tracks.current.cam?.stop();
      keep(m.audio, m.video);
      setProblem(m.problem);
      if (camWant.current && !m.video && m.problem) setCamOn(false);
      else syncCam();
    });

  const retry = () => {
    gen.current++;
    open();
  };

  useEffect(() => {
    open();
    return () => {
      gen.current++;
      // Cancelou ou fechou: solta os aparelhos (na chamada, quem cuida deles é o motor).
      if (tracks.current.handed) return;
      tracks.current.mic?.stop();
      tracks.current.cam?.stop();
      tracks.current.mic = tracks.current.cam = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    syncCam();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camOn]);

  useEffect(() => {
    const v = video.current;
    if (v) v.srcObject = cam ? new MediaStream([cam]) : null;
  }, [cam]);

  const pickDevice = (kind: 'mic' | 'cam' | 'out', id: string) => {
    if (kind === 'out') return;
    run(async (g) => {
      try {
        const t = await openTrack(kind, id, { lowRes: lowRes() });
        if (stale(g)) return t.stop();
        if (kind === 'mic') {
          tracks.current.mic?.stop();
          keep(t, tracks.current.cam);
        } else if (camWant.current) {
          tracks.current.cam?.stop();
          keep(tracks.current.mic, t);
        } else t.stop();
      } catch (e) {
        if (!stale(g)) setProblem(problemOf(e));
      }
    });
  };

  const blocked = problem === 'insecure' || problem === 'unsupported' || unsupported;
  const join = async (withMic = micOn) => {
    if (blocked || busy) return;
    setBusy(true);
    const list = [tracks.current.mic, camOn ? tracks.current.cam : null].filter((t): t is MediaStreamTrack => !!t);
    tracks.current.handed = true;
    const ok = await confirmPreflight({ mic: withMic && !!tracks.current.mic, camera: camOn && !!tracks.current.cam, tracks: list });
    if (!ok) tracks.current.handed = false;
    setBusy(false);
  };

  // Abre com o foco no botão principal (Enter entra); se o navegador não pode entrar, no Cancelar.
  useEffect(() => {
    const a = document.activeElement;
    if (a === document.body || a === primary.current || !card.current?.contains(a)) (blocked ? cancelBtn : primary).current?.focus({ preventScroll: true });
  }, [blocked]);

  useEscape(!test, cancelPreflight);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    // Teclas de dentro de um menu ou do teste de conexão (em portal) não são da tela de entrada.
    if (e.defaultPrevented || !e.currentTarget.contains(t)) return;
    if (e.key === 'Tab') {
      // O Tab fica no cartão, como num diálogo.
      const list = focusables(e.currentTarget);
      if (!list.length) return;
      const i = list.indexOf(t);
      const next = e.shiftKey ? (i <= 0 ? list[list.length - 1] : null) : i < 0 || i === list.length - 1 ? list[0] : null;
      if (next) {
        e.preventDefault();
        next.focus();
      }
      return;
    }
    if (e.key !== 'Enter' || t.closest('button, a, input, select, textarea, [role="menu"]')) return;
    e.preventDefault();
    void join();
  };

  const roomRef: CallRoomRef = info?.room ?? {
    _id: pf.rid,
    t: (room?.t ?? sub?.t ?? 'c') as CallRoomRef['t'],
    name: room?.name ?? sub?.name ?? null,
    fname: room?.fname ?? sub?.fname ?? null,
    usernames: room?.usernames,
  };
  const roomName = callRoomName(roomRef);
  const multiDm = roomRef.t === 'd';
  const count = info?.participantsCount ?? 0;
  const who = count ? `${callNamesLabel(info?.sample ?? [], count)} na chamada` : 'Ninguém na chamada ainda';
  // O título segue o botão da câmera: desligou a câmera, a chamada que vai começar é de voz.
  const title = pf.mode === 'join' ? 'Entrar na chamada' : camOn ? 'Iniciar chamada de vídeo' : 'Iniciar chamada de voz';
  const note = pf.mode === 'start' ? (multiDm ? 'Todos desta conversa vão receber a chamada.' : 'Ninguém será chamado: os membros veem a chamada na sala e entram quando quiserem.') : null;
  const primaryLabel = pf.mode === 'join' ? 'Entrar agora' : 'Iniciar chamada';
  const inCall = isInCall();
  const otherDevice = !inCall && (info?.mine?.state === 'joined' || info?.mine?.state === 'joining');
  const problemText = unsupported ? PROBLEM_TEXT.unsupported : problem ? PROBLEM_TEXT[problem] : null;

  return (
    <div className={phone ? 'call-preflight phone' : 'call-preflight'} style={phone ? undefined : mainStyle(dock)} role="dialog" aria-labelledby={titleId} onKeyDown={onKey}>
      <div ref={card} className="call-preflight-card">
        <div className="call-preflight-head">
          <h2 id={titleId}>{title}</h2>
          {roomName && <p className="call-preflight-room ellipsis">{roomName}</p>}
          <p className="call-preflight-who">{who}</p>
        </div>
        <div className="call-preflight-preview">
          {cam && camOn ? (
            <video ref={video} className="call-preflight-video" autoPlay playsInline muted />
          ) : (
            <div className="call-preflight-off">
              <Avatar username={me?.username} size={64} />
              <span>Câmera desligada</span>
            </div>
          )}
          <div className="call-preflight-toggles">
            <CallButton icon={micOn ? 'mic' : 'mic-off'} title={micOn ? 'Desligar microfone' : 'Ligar microfone'} className={micOn ? '' : 'off'} onClick={() => setMicOn(!micOn)} />
            <CallButton
              icon={camOn ? 'cam' : 'cam-off'}
              title={camOn ? 'Desligar câmera' : 'Ligar câmera'}
              className={camOn ? '' : 'off'}
              onClick={() => {
                touchedCam.current = true;
                setCamOn(!camOn);
              }}
            />
          </div>
        </div>
        {mic && <Meter track={mic} on={micOn} />}
        {mutedByCount && !micOn && <p className="call-preflight-note">{MUTED_LINE}</p>}
        {note && <p className="call-preflight-note">{note}</p>}
        {otherDevice && <p className="call-preflight-note">{OTHER_DEVICE_LINE}</p>}
        {problemText && (
          <div className="callout warn" role="alert">
            <Icon name="warning" />
            <span>{problemText}</span>
            {(problem === 'denied' || problem === 'busy' || problem === 'other') && (
              <button type="button" className="btn small" onClick={retry}>
                Tentar de novo
              </button>
            )}
            {problem === 'no-mic' && (
              <button type="button" className="btn small" onClick={() => void join(false)}>
                Entrar sem microfone
              </button>
            )}
          </div>
        )}
        {isIOS() && (
          <div className="callout info">
            <Icon name="info" />
            <span>{IOS_LINE}</span>
          </div>
        )}
        <DeviceMenu refreshKey={mic?.id} onPick={(k, id) => void pickDevice(k, id)} />
        <div className="call-preflight-foot">
          <button type="button" className="btn ghost small call-preflight-test" disabled={inCall} title={inCall ? 'Saia da chamada para testar a conexão.' : undefined} onClick={() => setTest(true)}>
            <Icon name="call-server" />
            Testar conexão
          </button>
          <span className="call-preflight-actions">
            <button type="button" ref={cancelBtn} className="btn" onClick={cancelPreflight}>
              Cancelar
            </button>
            {/* Ocupado (abrindo os aparelhos) o botão continua focável: o foco e o Enter já ficam nele. */}
            <button type="button" ref={primary} className="btn primary" disabled={blocked} aria-disabled={busy || undefined} onClick={() => void join()}>
              {primaryLabel}
            </button>
          </span>
        </div>
      </div>
      {test && <SelfTest onClose={() => setTest(false)} />}
    </div>
  );
}

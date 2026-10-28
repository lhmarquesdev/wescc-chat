// Botões da chamada: o controle redondo (com o estado "indisponível" que se explica), as ferramentas da janela e a
// barra da chamada em grupo, com o menu "Mais opções da chamada" e os diálogos que ele abre.
import { useEffect, useId, useState, type ReactNode } from 'react';
import { CALL_LIMITS, callPeopleLabel } from '@shared/calls';
import { api } from '../../lib/api';
import {
  cameraBlocked,
  endForAll,
  inviteRoom,
  inviteWaitMinutes,
  leaveCall,
  micBlocked,
  refreshRoster,
  ringPeople,
  screenBlocked,
  setView,
  setWindow,
  toggleCamera,
  toggleHand,
  toggleMic,
  toggleScreen,
  useCallStore,
} from '../../lib/call/store';
import { canShareScreen } from '../../lib/call/devices';
import { pttEnabled, setPttEnabled, shortcutLabel } from '../../lib/call/shortcuts';
import { useStore } from '../../lib/store';
import { Icon, type IconName } from '../Icon';
import { Menu, Modal, Toggle } from '../ui';
import { DeviceMenu } from './DeviceMenu';
import { RingPicker } from './RingPicker';

export { canShareScreen };

// Controle indisponível: continua focável, diz o motivo no title e na descrição e avisa ao clicar.
export function CallButton({
  icon,
  title,
  label,
  className,
  onClick,
  size = 22,
  blocked,
  pressed,
}: {
  icon: IconName;
  title: string;
  label?: string;
  className?: string;
  onClick: () => void;
  size?: 22 | 24;
  blocked?: string | null;
  pressed?: boolean;
}) {
  const id = useId();
  const cls = ['call-btn', className, blocked && 'blocked'].filter(Boolean).join(' ');
  return (
    <div className="call-ctl">
      <button
        type="button"
        className={cls}
        title={blocked ?? title}
        aria-label={title}
        aria-disabled={blocked ? true : undefined}
        aria-describedby={blocked ? id : undefined}
        aria-pressed={pressed}
        onClick={() => (blocked ? useStore.getState().toast(blocked, 'warning') : onClick())}
      >
        <Icon name={icon} size={size} />
      </button>
      {blocked && (
        <span id={id} className="visually-hidden">
          {blocked}
        </span>
      )}
      {label && (
        <span className="call-btn-label" aria-hidden="true">
          {label}
        </span>
      )}
    </div>
  );
}

export function ToolButton({ icon, title, onClick, pressed }: { icon: IconName; title: string; onClick: () => void; pressed?: boolean }) {
  return (
    <button type="button" className="call-tool" title={title} aria-label={title} aria-pressed={pressed} onClick={onClick}>
      <Icon name={icon} size={18} />
    </button>
  );
}

// Um moderador parou minha tela: o bloqueio vence sozinho, e o botão volta sem esperar outra mudança.
function useScreenUnblock() {
  const until = useCallStore((s) => s.screenBlockedUntil);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!until || until <= Date.now()) return;
    const t = window.setTimeout(() => tick((n) => n + 1), until - Date.now() + 50);
    return () => clearTimeout(t);
  }, [until]);
}

type Dialog = 'ring' | 'devices' | 'shortcuts' | null;

// Barra da chamada em grupo. docked: a janela de 360 px (a tela vai para o "Mais"); big e phone: a barra inteira.
export function GroupControls({ mode }: { mode: 'docked' | 'big' | 'phone' }) {
  const me = useCallStore((s) => s.me);
  const view = useCallStore((s) => s.view);
  useCallStore((s) => s.peers); // os bloqueios dependem de quem liga a câmera ou compartilha
  useCallStore((s) => s.call?.guardUntil);
  useScreenUnblock();
  const [dialog, setDialog] = useState<Dialog>(null);
  const labels = mode === 'phone';
  const share = mode === 'big' && canShareScreen();
  const panelOpen = view.panel === 'people';

  return (
    <div className="call-buttons">
      <CallButton
        icon={me.mic ? 'mic' : 'mic-off'}
        title={me.mic ? 'Desligar microfone' : 'Ligar microfone'}
        label={labels ? 'Microfone' : undefined}
        className={me.mic ? '' : 'off'}
        blocked={me.mic ? null : micBlocked()}
        onClick={() => void toggleMic()}
      />
      <CallButton
        icon={me.camera ? 'cam' : 'cam-off'}
        title={me.camera ? 'Desligar câmera' : 'Ligar câmera'}
        label={labels ? 'Câmera' : undefined}
        className={me.camera ? '' : 'off'}
        blocked={me.camera ? null : cameraBlocked()}
        onClick={() => void toggleCamera()}
      />
      {share && <ScreenButton />}
      <CallButton
        icon="call-hand"
        title={me.handAt ? 'Baixar a mão' : 'Levantar a mão'}
        label={labels ? 'Mão' : undefined}
        className={me.handAt ? 'on' : ''}
        pressed={!!me.handAt}
        onClick={() => void toggleHand()}
      />
      {mode !== 'docked' && (
        <CallButton
          icon="call-people"
          title="Participantes"
          label={labels ? 'Pessoas' : undefined}
          className={panelOpen ? 'on' : ''}
          pressed={panelOpen}
          onClick={() => setView({ panel: panelOpen ? null : 'people' })}
        />
      )}
      <div className="call-ctl">
        <MoreMenu docked={mode === 'docked'} open={setDialog} />
        {labels && (
          <span className="call-btn-label" aria-hidden="true">
            Mais
          </span>
        )}
      </div>
      <CallButton icon="call-hangup" title="Sair da chamada" label={labels ? 'Sair' : undefined} className="hang" onClick={() => void leaveCall()} />
      {dialog === 'ring' && <RingPicker onClose={() => setDialog(null)} />}
      {dialog === 'devices' && <DeviceSettings onClose={() => setDialog(null)} />}
      {dialog === 'shortcuts' && <ShortcutsDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

// Tela: o botão e a seta de opções ("Compartilhar uma aba com som").
function ScreenButton() {
  const sharing = useCallStore((s) => s.me.screen);
  const blocked = sharing ? null : screenBlocked();
  const id = useId();
  const title = sharing ? 'Parar de compartilhar' : 'Compartilhar tela';
  const run = (tabAudio?: boolean) => (blocked ? useStore.getState().toast(blocked, 'warning') : void toggleScreen({ tabAudio }));
  return (
    <div className="call-ctl">
      <div className="call-split">
        <button
          type="button"
          className={['call-btn', sharing && 'on', blocked && 'blocked'].filter(Boolean).join(' ')}
          title={blocked ?? title}
          aria-label={title}
          aria-disabled={blocked ? true : undefined}
          aria-describedby={blocked ? id : undefined}
          onClick={() => run()}
        >
          <Icon name={sharing ? 'screen-stop' : 'screen-share'} size={22} />
        </button>
        {!sharing && (
          <Menu
            placement="top"
            label="Opções de compartilhamento"
            trigger={
              <button type="button" className="call-split-arrow" title="Opções de compartilhamento" aria-label="Opções de compartilhamento">
                <Icon name="chevron-down" size={14} />
              </button>
            }
          >
            {(close) => (
              <>
                <button type="button" onClick={() => (close(), run(false))}>
                  <Icon name="screen-share" />
                  Compartilhar tela
                </button>
                <button type="button" onClick={() => (close(), run(true))}>
                  <Icon name="call-speaker" />
                  Compartilhar uma aba com som
                </button>
              </>
            )}
          </Menu>
        )}
      </div>
      {blocked && (
        <span id={id} className="visually-hidden">
          {blocked}
        </span>
      )}
    </div>
  );
}

interface Member {
  _id: string;
  username: string;
  name?: string;
}

// "Chamar todos (n)": só em salas com até 10 outras pessoas, contando quem ainda não está na chamada.
function useRingAll(open: boolean) {
  const rid = useCallStore((s) => s.call?.rid);
  const peers = useCallStore((s) => s.peers);
  const roster = useCallStore((s) => s.roster);
  const meId = useStore((s) => s.me?._id);
  const [members, setMembers] = useState<Member[] | null>(null);
  useEffect(() => {
    if (!open || !rid) return;
    let alive = true;
    // O roster só chega no join e nas consultas de nome: sem isto, quem saiu ficaria fora da contagem.
    void refreshRoster();
    api
      .get('rooms.membersOrderedByRole', { roomId: rid, count: CALL_LIMITS.ringAllMaxMembers + 2 })
      .then((r: { total: number; members: Member[] }) => alive && setMembers(r.total - 1 <= CALL_LIMITS.ringAllMaxMembers ? r.members : []))
      .catch(() => alive && setMembers([]));
    return () => {
      alive = false;
    };
  }, [open, rid]);
  const busy = new Set([...Object.keys(peers), ...roster.filter((p) => p.state === 'ringing' || p.state === 'joined' || p.state === 'joining').map((p) => p.user._id)]);
  return (members ?? []).filter((m) => m._id !== meId && !busy.has(m._id)).map((m) => m._id);
}

function MoreMenu({ docked, open }: { docked: boolean; open: (d: Dialog) => void }) {
  const [isOpen, setOpen] = useState(false);
  const call = useCallStore((s) => s.call);
  const room = useCallStore((s) => s.room);
  const view = useCallStore((s) => s.view);
  const sharing = useCallStore((s) => s.me.screen);
  const ringAll = useRingAll(isOpen);
  const mine = call?.mine;
  const someoneShares = useCallStore((s) => Object.values(s.peers).some((p) => p.screen));
  const forced = someoneShares || !!view.pinned;
  const layout = forced ? 'spotlight' : view.layout;
  const wait = inviteWaitMinutes();
  const showInvite = room?.t !== 'd' && (mine?.canInvite || (mine?.canRing && wait > 0));
  const shareHere = docked && canShareScreen();
  const blockedScreen = sharing ? null : screenBlocked();
  const shareRun = (tabAudio: boolean) => (blockedScreen ? useStore.getState().toast(blockedScreen, 'warning') : void toggleScreen({ tabAudio }));
  return (
    <Menu
      placement="top"
      label="Mais opções da chamada"
      sheetTitle="Mais opções da chamada"
      className="call-menu"
      onOpenChange={setOpen}
      trigger={
        <button type="button" className="call-btn" title="Mais opções da chamada" aria-label="Mais opções da chamada">
          <Icon name="more" size={22} />
        </button>
      }
    >
      {(close) => {
        const pick = (f: () => void) => () => {
          close();
          f();
        };
        return (
          <>
            {shareHere && (
              <>
                <button type="button" onClick={pick(() => shareRun(false))}>
                  <Icon name={sharing ? 'screen-stop' : 'screen-share'} />
                  {sharing ? 'Parar de compartilhar' : 'Compartilhar tela'}
                </button>
                {!sharing && (
                  <button type="button" onClick={pick(() => shareRun(true))}>
                    <Icon name="call-speaker" />
                    Compartilhar uma aba com som
                  </button>
                )}
                <hr />
              </>
            )}
            {mine?.canRing && (
              <button type="button" onClick={pick(() => open('ring'))}>
                <Icon name="call-ring" />
                Chamar pessoas
              </button>
            )}
            {mine?.canRing && ringAll.length > 0 && (
              <button type="button" onClick={pick(() => void ringPeople(ringAll))}>
                <Icon name="add-people" />
                Chamar todos ({ringAll.length})
              </button>
            )}
            {showInvite && (
              <button type="button" disabled={!mine?.canInvite} onClick={pick(() => void inviteRoom())}>
                <Icon name="announcement" />
                <span className="menu-text">
                  Avisar a sala
                  {!mine?.canInvite && wait > 0 && <span className="menu-desc">Você poderá avisar de novo em {wait} min.</span>}
                </span>
              </button>
            )}
            {(mine?.canRing || showInvite) && <hr />}
            <div className="menu-label" role="presentation">
              Layout
            </div>
            <button type="button" role="menuitemradio" aria-checked={layout === 'grid'} disabled={forced} onClick={pick(() => setView({ layout: 'grid' }))}>
              <Icon name="call-grid" />
              Grade
              {layout === 'grid' && <Icon name="check" className="menu-check" />}
            </button>
            <button type="button" role="menuitemradio" aria-checked={layout === 'spotlight'} disabled={forced} onClick={pick(() => setView({ layout: 'spotlight' }))}>
              <Icon name="call-spotlight" />
              Destaque
              {layout === 'spotlight' && <Icon name="check" className="menu-check" />}
            </button>
            <button type="button" onClick={pick(() => setView({ receiveVideo: !view.receiveVideo }))}>
              <Icon name={view.receiveVideo ? 'cam-off' : 'cam'} />
              {view.receiveVideo ? 'Não receber vídeo' : 'Receber vídeo'}
            </button>
            <hr />
            <button type="button" onClick={pick(() => open('devices'))}>
              <Icon name="call-settings" />
              Configurações de áudio e vídeo
            </button>
            <button type="button" disabled>
              <Icon name="call-server" />
              <span className="menu-text">
                Testar conexão
                <span className="menu-desc">Saia da chamada para testar a conexão.</span>
              </span>
            </button>
            <button type="button" onClick={pick(() => open('shortcuts'))}>
              <Icon name="call-shortcuts" />
              Atalhos do teclado
            </button>
            {mine?.canEnd && (
              <>
                <hr />
                <button type="button" className="danger" onClick={pick(() => void endForAll())}>
                  <Icon name="call-hangup" />
                  Encerrar para todos
                </button>
              </>
            )}
          </>
        );
      }}
    </Menu>
  );
}

function DeviceSettings({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="Configurações de áudio e vídeo"
      onClose={onClose}
      size="sm"
      className="call-devices-dialog"
      footer={
        <button type="button" className="btn primary" onClick={onClose}>
          Fechar
        </button>
      }
    >
      <DeviceMenu inCall />
    </Modal>
  );
}

function Keys({ text }: { text: string }) {
  return <kbd>{text}</kbd>;
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const [ptt, setPtt] = useState(pttEnabled);
  const rows: [string, string][] = [
    ['Ligar ou desligar o microfone', shortcutLabel('mic')],
    ['Ligar ou desligar a câmera', shortcutLabel('camera')],
    ['Levantar ou baixar a mão', shortcutLabel('hand')],
  ];
  return (
    <Modal
      title="Atalhos do teclado"
      onClose={onClose}
      size="sm"
      className="call-shortcuts"
      footer={
        <button type="button" className="btn primary" onClick={onClose}>
          Fechar
        </button>
      }
    >
      <dl className="call-keys">
        {rows.map(([what, keys]) => (
          <div key={what} className="call-key-row">
            <dt>{what}</dt>
            <dd>
              <Keys text={keys} />
            </dd>
          </div>
        ))}
      </dl>
      <Toggle
        checked={ptt}
        onChange={(v) => {
          setPtt(v);
          setPttEnabled(v);
        }}
        label="Segurar Espaço para falar"
        description="Falar com o microfone desligado"
      />
    </Modal>
  );
}

// Selo de pessoas no cabeçalho: abre a lista (na janela encaixada, amplia antes).
export function PeopleChip({ docked }: { docked?: boolean }): ReactNode {
  const count = useCallStore((s) => Math.max(Object.keys(s.peers).length, s.call?.participantsCount ?? 0));
  const open = useCallStore((s) => s.view.panel === 'people');
  const title = `${callPeopleLabel(count)} na chamada`;
  return (
    <button
      type="button"
      className="call-people-chip"
      title={title}
      aria-label={title}
      aria-pressed={docked ? undefined : open}
      onClick={() => {
        if (docked) setWindow('big');
        setView({ panel: open && !docked ? null : 'people' });
      }}
    >
      <Icon name="call-people" size={14} />
      <span>{count}</span>
    </button>
  );
}

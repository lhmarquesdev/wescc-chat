// Fachada das chamadas: os nomes de sempre, agora em cima do estado da chamada (lib/call/store.ts). A conversa a
// dois toca na hora, como antes; nas outras salas abre a tela de entrada.
import type { CallKind } from '@shared/index';
import { acceptIncoming, declineIncoming, leaveCall, openCall, toggleCamera as toggleCam, toggleMic, toggleScreen, useCallStore } from './call/store';

export { canShareScreen } from './call/devices';
// Carrega o motor de grupo antes da chamada (passar o mouse ou focar um botão de chamada).
export { prefetchSfu } from './call/engine';

export function startCall(rid: string, kind: CallKind) {
  return openCall(rid, kind);
}

// Atende (ou recusa) o primeiro toque da fila.
export async function acceptCall(audioOnly = false) {
  const first = useCallStore.getState().incoming[0];
  if (first) await acceptIncoming(first._id, audioOnly);
}

export async function declineCall() {
  const first = useCallStore.getState().incoming[0];
  if (first) await declineIncoming(first._id);
}

export function hangup() {
  return leaveCall();
}

export function toggleMute() {
  return toggleMic();
}

export function toggleCamera() {
  return toggleCam();
}

export function toggleScreenShare() {
  return toggleScreen();
}

// Respostas que só a pessoa vê (evento "ephemeral"): ficam no navegador, por sala, e somem no logout ou ao recarregar.
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { useMemo } from 'react';
import type { EphemeralMessage } from '@shared/integrations';
import { openIntegrationModal, useIntegrations, type IntegrationModalRequest } from './integrations';
import { useStore } from './store';

const MAX_PER_ROOM = 20;
const NONE: EphemeralMessage[] = [];

export const useEphemeral: UseBoundStore<StoreApi<{ byRoom: Record<string, EphemeralMessage[]> }>> = create<{ byRoom: Record<string, EphemeralMessage[]> }>(() => ({ byRoom: {} }));

// Estado dos botões de cada resposta ("a:0" para actions[0], "share:OPS-1" para o Compartilhar de um cartão). Fica fora
// da linha: ela é montada de novo quando muda de lugar na lista, e um botão que já deu certo não pode voltar.
export type EphemeralActionState = 'busy' | 'done';
type ActionStates = Readonly<Record<string, EphemeralActionState>>;
const NO_STATE: ActionStates = {};
const useActions = create<{ byId: Record<string, ActionStates> }>(() => ({ byId: {} }));

export function setEphemeralAction(id: string, key: string, st: EphemeralActionState | null): void {
  const byId = useActions.getState().byId;
  const cur = { ...(byId[id] ?? NO_STATE) };
  if (st) cur[key] = st;
  else delete cur[key];
  useActions.setState({ byId: { ...byId, [id]: cur } });
}

export function getEphemeralAction(id: string, key: string): EphemeralActionState | undefined {
  return useActions.getState().byId[id]?.[key];
}

export function useEphemeralActions(id: string): ActionStates {
  return useActions((s) => s.byId[id] ?? NO_STATE);
}

function forgetActions(ids: string[]) {
  const byId = useActions.getState().byId;
  if (!ids.some((id) => id in byId)) return;
  const next = { ...byId };
  for (const id of ids) delete next[id];
  useActions.setState({ byId: next });
}

// Até 20 por sala (as mais antigas saem); abre o modal autoOpen só nesta sessão e aba.
export function pushEphemeral(m: EphemeralMessage): void {
  const byRoom = useEphemeral.getState().byRoom;
  const all = [...(byRoom[m.rid] ?? NONE).filter((x) => x._id !== m._id), m].sort((a, b) => a.ts.localeCompare(b.ts));
  const list = all.slice(-MAX_PER_ROOM);
  useEphemeral.setState({ byRoom: { ...byRoom, [m.rid]: list } });
  forgetActions(all.slice(0, all.length - list.length).map((x) => x._id));
  autoOpen(m);
}

export function dismissEphemeral(rid: string, id: string): void {
  const byRoom = useEphemeral.getState().byRoom;
  const list = byRoom[rid];
  if (!list?.some((x) => x._id === id)) return;
  useEphemeral.setState({ byRoom: { ...byRoom, [rid]: list.filter((x) => x._id !== id) } });
  forgetActions([id]);
}

// Um modal aberto por uma resposta ("Abrir formulário", ou sozinho pelo autoOpen) terminou bem: a resposta já cumpriu
// o papel e sai, para não oferecer de novo o mesmo formulário vazio.
export function settleEphemeralRequest(req: IntegrationModalRequest): void {
  if (req.ephemeralId) dismissEphemeral(req.rid, req.ephemeralId);
}

// Logout: nada da pessoa anterior fica na aba.
export function clearEphemeral(): void {
  useEphemeral.setState({ byRoom: {} });
  useActions.setState({ byId: {} });
}

export function useRoomEphemeral(rid: string, tmid: string | null): EphemeralMessage[] {
  const list = useEphemeral((s) => s.byRoom[rid] ?? NONE);
  return useMemo(() => {
    const out = list.filter((x) => (x.tmid ?? null) === tmid);
    return out.length ? out : NONE;
  }, [list, tmid]);
}

// Lugar de cada resposta entre as linhas, pela hora: antes da primeira mensagem mais nova que ela, ou no fim.
// A lista de mensagens chega em ordem; as respostas também (pushEphemeral ordena).
export function placeEphemeral(eph: EphemeralMessage[], msgs: { _id: string; ts: string }[]): { before: Map<string, EphemeralMessage[]>; end: EphemeralMessage[] } {
  const before = new Map<string, EphemeralMessage[]>();
  const end: EphemeralMessage[] = [];
  let i = 0;
  for (const e of eph) {
    while (i < msgs.length && msgs[i].ts <= e.ts) i++;
    if (i >= msgs.length) end.push(e);
    else before.set(msgs[i]._id, [...(before.get(msgs[i]._id) ?? NONE), e]);
  }
  return { before, end };
}

// Só a aba em foco da sessão que digitou o comando abre o formulário sozinha (D11). Nas outras, fica o botão
// "Abrir formulário" na própria resposta.
function autoOpen(m: EphemeralMessage) {
  const me = useIntegrations.getState().me;
  if (!me || !m.autoOpenFor || m.autoOpenFor !== me.sessionTag || !document.hasFocus()) return;
  const action = m.actions?.find((a) => a.kind === 'modal' && a.autoOpen);
  if (!action || action.kind !== 'modal') return;
  if (action.modal === 'msteams-meeting') {
    // Na DM, a mesma política das chamadas (rooms.info calcula room.direct para quem pergunta).
    const room = useStore.getState().rooms[m.rid];
    if (room?.t === 'd' && room.direct?.canCall === false) return;
  }
  openIntegrationModal({ modal: action.modal, rid: m.rid, tmid: m.tmid ?? null, params: action.params, ephemeralId: m._id });
}

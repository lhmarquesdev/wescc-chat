// Busca da barra lateral (Ctrl+K): depois das conversas da lista, pessoas para conversar e canais para entrar,
// vindos de GET spotlight. As linhas são .side-item, então as setas, o Enter e o Esc da barra valem para elas.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SpotlightRoom, SpotlightUser } from '@shared/index';
import { parseSpotlightQuery, spotlightReady } from '@shared/search';
import { api, errorMessage } from '../lib/api';
import { partyOf, useDirect } from '../lib/direct';
import { plural, roomIconName, roomPath } from '../lib/format';
import { dedupePeople, dedupeRooms, orderPeople, resultCountText } from '../lib/spotlightRules';
import { useStore } from '../lib/store';
import { Icon } from './Icon';
import { Spinner, UserAvatar, useDelay } from './ui';

interface SpotData {
  users: SpotlightUser[];
  rooms: SpotlightRoom[];
}

// Cache pequeno em memória: as últimas 20 buscas valem por 30 s (apagar e voltar a digitar não pergunta de novo).
const CACHE_MAX = 20;
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; data: SpotData }>();
const cached = (key: string) => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  if (hit) cache.delete(key);
  return null;
};
const remember = (key: string, data: SpotData) => {
  cache.delete(key);
  cache.set(key, { at: Date.now(), data });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
};

// A chave da busca: "@ ana" e "@ana" são a mesma pergunta.
export const spotlightKey = (raw: string) => {
  const q = parseSpotlightQuery(raw);
  return spotlightReady(q) ? `${q.scope}:${q.text.toLowerCase()}` : '';
};

const EMPTY: SpotData = { users: [], rooms: [] };

export interface SpotlightState extends SpotData {
  key: string; // a busca de agora ('' = curta demais, não vai ao servidor)
  loading: boolean;
  error: boolean;
  retry: () => void;
  settledFor: string | null; // a busca cujo resultado está na tela (já respondida)
}

// Espera 200 ms sem digitar; uma resposta atrasada (de um texto anterior) é descartada pelo número de sequência.
export function useSpotlight(raw: string, enabled = true): SpotlightState {
  const key = enabled ? spotlightKey(raw) : '';
  const [state, setState] = useState<{ key: string; data: SpotData; error: boolean } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    if (!key) {
      setLoadingKey(null);
      return;
    }
    const hit = cached(key);
    if (hit) {
      setState({ key, data: hit, error: false });
      setLoadingKey(null);
      return;
    }
    setLoadingKey(key);
    const t = setTimeout(() => {
      api
        .get<SpotData>('spotlight', { query: raw.trim() })
        .then((r) => {
          if (n !== seq.current) return;
          const data = { users: r.users ?? [], rooms: r.rooms ?? [] };
          remember(key, data);
          setState({ key, data, error: false });
        })
        .catch(() => n === seq.current && setState({ key, data: EMPTY, error: true }))
        .finally(() => n === seq.current && setLoadingKey(null));
    }, 200);
    return () => clearTimeout(t);
    // raw muda junto com key; a busca vai com o texto do momento.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  const retry = useCallback(() => {
    if (key) cache.delete(key);
    setAttempt((a) => a + 1);
  }, [key]);

  const current = state && state.key === key ? state : null;
  return {
    key,
    users: current?.data.users ?? [],
    rooms: current?.data.rooms ?? [],
    loading: !!key && (loadingKey === key || !current),
    error: !!current?.error && loadingKey !== key,
    retry,
    settledFor: current && loadingKey !== key ? key : null,
  };
}

// As linhas que o servidor trouxe, sem o que já está na lista local, na ordem da tela.
export function useSpotlightRows(spot: SpotlightState) {
  const subs = useStore((s) => s.subscriptions);
  const direct = useDirect();
  const people = orderPeople(dedupePeople(spot.users, Object.values(subs)), (u) => direct.state([partyOf(u)]).kind === 'none');
  const rooms = dedupeRooms(spot.rooms, subs);
  return { people, rooms, direct };
}

function Loading() {
  const ready = useDelay(300);
  if (!ready) return null;
  return (
    <div className="spot-status">
      <Spinner size="sm" /> Buscando…
    </div>
  );
}

function PersonResult({ u, big, state, onDone }: { u: SpotlightUser; big?: boolean; state: ReturnType<ReturnType<typeof useDirect>['state']>; onDone: () => void }) {
  const navigate = useNavigate();
  const blocked = state.kind === 'none';
  const open = async () => {
    if (state.kind === 'none') return useStore.getState().toast(state.text, 'info');
    if (state.kind === 'view') {
      navigate(state.path);
      return onDone();
    }
    try {
      const r = await api.post('im.create', { username: u.username });
      navigate(roomPath({ _id: r.room._id, t: 'd' }));
      onDone();
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
    }
  };
  return (
    <button type="button" className={blocked ? 'side-item spot-item blocked' : 'side-item spot-item'} title={state.kind === 'open' ? undefined : state.text} onClick={() => void open()}>
      <UserAvatar username={u.username} size={big ? 24 : 20} status={u.status} statusCustom={u.statusCustom} />
      <span className="side-name">{u.name || u.username}</span>
      <span className="side-hint">{state.kind === 'view' ? 'Ver conversa' : `@${u.username}`}</span>
      {blocked && (
        <span className="pill blocked">
          <Icon name="direct-blocked" size={12} />
          <span className="pill-label">Sem conversa direta</span>
        </span>
      )}
    </button>
  );
}

function RoomResult({ r, big, onDone }: { r: SpotlightRoom; big?: boolean; onDone: () => void }) {
  const navigate = useNavigate();
  const [joining, setJoining] = useState(false);
  const members = plural(r.usersCount, 'membro', 'membros');
  const hint = r.teamMain ? `Time · ${members}` : r.teamName ? `${r.teamName} · ${members}` : members;
  const path = roomPath({ _id: r._id, t: 'c' });
  const join = async () => {
    setJoining(true);
    try {
      await api.post('channels.join', { roomId: r._id });
      navigate(path);
      onDone();
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
      setJoining(false);
    }
  };
  return (
    <div className="spot-room">
      {/* Abre a prévia da sala ("Entrar no canal" e o código de acesso ficam lá). */}
      <button type="button" className="side-item spot-item" title={r.teamName ? `Canal do time ${r.teamName}` : undefined} onClick={() => (navigate(path), onDone())}>
        <span className="side-icon">
          <Icon name={roomIconName({ t: 'c', teamMain: r.teamMain, notice: r.notice })} size={big ? 18 : 16} />
        </span>
        <span className="side-name">{r.fname || r.name}</span>
        <span className="side-hint">{hint}</span>
      </button>
      {r.joinCodeRequired ? (
        <span className="spot-code">
          <Icon name="join-code" size={14} label="Precisa de código de acesso" />
        </span>
      ) : (
        <button type="button" className="btn small ghost side-join" aria-label={`Entrar em #${r.fname || r.name}`} disabled={joining} onClick={() => void join()}>
          Entrar
        </button>
      )}
    </div>
  );
}

// Grupos "Pessoas" e "Canais e times", o carregamento, o erro e a contagem para o leitor de tela.
export function SpotlightResults({ spot, localCount, big, onDone }: { spot: SpotlightState; localCount: number; big?: boolean; onDone: () => void }) {
  const { people, rooms, direct } = useSpotlightRows(spot);
  const settled = spot.settledFor === spot.key && !!spot.key;
  return (
    <>
      {people.length > 0 && (
        <div className="side-group spot-group" role="group" aria-labelledby="spot-people">
          <div className="side-group-head">
            <span className="side-group-title static" id="spot-people">
              Pessoas
            </span>
          </div>
          {people.map((u) => (
            <PersonResult key={u._id} u={u} big={big} state={direct.state([partyOf(u)])} onDone={onDone} />
          ))}
        </div>
      )}
      {rooms.length > 0 && (
        <div className="side-group spot-group" role="group" aria-labelledby="spot-rooms">
          <div className="side-group-head">
            <span className="side-group-title static" id="spot-rooms">
              Canais e times
            </span>
          </div>
          {rooms.map((r) => (
            <RoomResult key={r._id} r={r} big={big} onDone={onDone} />
          ))}
        </div>
      )}
      {spot.loading && <Loading key={spot.key} />}
      {spot.error && (
        <div className="spot-status">
          Não foi possível buscar agora.{' '}
          <button type="button" className="link" onClick={spot.retry}>
            Tentar de novo
          </button>
        </div>
      )}
      <div className="visually-hidden" aria-live="polite">
        {settled || !spot.key ? resultCountText(localCount + people.length + rooms.length) : ''}
      </div>
    </>
  );
}


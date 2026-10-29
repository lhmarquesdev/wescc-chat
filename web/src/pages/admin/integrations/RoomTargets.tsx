// Integrações (Jira/Teams): salas de destino ou de origem de uma regra (§7.8). A busca só traz canais e grupos
// privados que a pessoa acessa; cada sala escolhida mostra se o robô pode usá-la (integrations.targets.check).
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { IntegrationRoomRef, TargetCheck } from '@shared/integrations';
import type { IconName } from '../../../components/icons';
import { Icon } from '../../../components/Icon';
import { Skeleton } from '../../../components/ui';
import { coreAdmin } from './admin-api';
import { SuggestList } from './parts';
import './integrations-admin.css';

const BOT_NAME = { jira: 'Jira', msteams: 'Microsoft Teams' } as const;

export const roomIcon = (r: Pick<IntegrationRoomRef, 't' | 'notice'>): IconName => (r.notice ? 'announcement' : r.t === 'p' ? 'room-private' : 'room-channel');
export const roomName = (r: Pick<IntegrationRoomRef, 'name' | 'fname'>) => r.fname || r.name;

function Status({ check, grantPublisher }: { check: TargetCheck | undefined; grantPublisher: boolean }) {
  if (!check) return <Skeleton width={64} height={20} />;
  if (check.ok) return <span className="pill ok">Pronto</span>;
  if (check.needsPublisher && !grantPublisher) return <span className="pill warn">{check.room.notice ? 'Canal de avisos' : 'Somente leitura'}</span>;
  return <small>{check.problem ?? 'Esta sala não pode ser usada.'}</small>;
}

export function RoomTargets(p: {
  provider: 'jira' | 'msteams';
  mode: 'post' | 'read';
  value: string[];
  onChange: (ids: string[]) => void;
  max: number;
  grantPublisher: boolean;
  onGrantPublisher: (v: boolean) => void;
  single?: boolean;
  // Salas já conhecidas (regra em edição), para mostrar os nomes antes da conferência.
  known?: IntegrationRoomRef[];
  // Avisa qual sala foi escolhida (o modal de recebimento cita o nome dela no aceite do canal privado).
  onPicked?: (room: IntegrationRoomRef) => void;
  // id do campo de busca e o erro do campo (useInvalid), para o formulário marcar e focar.
  inputId?: string;
  invalid?: { 'aria-invalid'?: true; 'aria-describedby'?: string };
}) {
  const { provider, mode, value, onChange, max, grantPublisher, onGrantPublisher, single, known, onPicked, inputId, invalid } = p;
  const [checks, setChecks] = useState<Record<string, TargetCheck>>({});
  const [names, setNames] = useState<Record<string, IntegrationRoomRef>>(() => Object.fromEntries((known ?? []).map((r) => [r._id, r])));
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<IntegrationRoomRef[]>([]);
  // A dica de "nenhuma sala" só depois da primeira resposta (antes dela, found vazio não quer dizer nada).
  const [answered, setAnswered] = useState(false);
  const [active, setActive] = useState(0);
  const [checkError, setCheckError] = useState<string | null>(null);
  const listId = useId();
  const hintId = useId();
  const [anchor, setAnchor] = useState<HTMLInputElement | null>(null);
  const full = value.length >= max;
  const key = value.join(',');

  // Confere de novo quando a lista ou a autorização de publicar mudam.
  useEffect(() => {
    if (!value.length) {
      setChecks({});
      return;
    }
    let alive = true;
    coreAdmin
      .checkTargets({ provider, mode, roomIds: value, grantPublisher })
      .then((r) => {
        if (!alive) return;
        setCheckError(null);
        setChecks(Object.fromEntries(r.targets.map((t) => [t.room._id, t])));
        setNames((n) => ({ ...n, ...Object.fromEntries(r.targets.filter((t) => t.room.name).map((t) => [t.room._id, t.room])) }));
      })
      .catch((e) => alive && setCheckError(e?.message ?? String(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, grantPublisher, provider, mode]);

  useEffect(() => {
    if (!open || full) return;
    let alive = true;
    const t = setTimeout(() => {
      coreAdmin
        .searchRooms(term.trim(), 10)
        .then((r) => {
          if (!alive) return;
          setFound(r.rooms.filter((room) => !value.includes(room._id)));
          setAnswered(true);
          setActive(0);
        })
        .catch(() => alive && (setFound([]), setAnswered(false)));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, open, full, key]);

  const add = (room: IntegrationRoomRef) => {
    setNames((n) => ({ ...n, [room._id]: room }));
    onChange(single ? [room._id] : [...value, room._id]);
    onPicked?.(room);
    setTerm('');
    // A lista fecha depois de escolher (digitar ou ↓ abre de novo): aberta, ela cobriria os campos de baixo.
    setOpen(false);
  };
  const remove = (id: string) => onChange(value.filter((x) => x !== id));
  const shown = open && !full ? found : [];
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
      e.preventDefault();
      setOpen(true);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && shown.length) {
      e.preventDefault();
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[active]) add(shown[active]);
    } else if (e.key === 'Escape' && shown.length) {
      // Fecha só a lista, não o modal.
      e.preventDefault();
      setOpen(false);
    }
  };
  const needsPublisher = value.some((id) => checks[id]?.needsPublisher);
  const hideSearch = single && value.length > 0;
  // A dica fica enquanto o texto da busca não acha nada, com ou sem foco: se ela sumisse quando o campo perde o foco,
  // tudo embaixo subiria entre o mousedown e o clique, e o clique cairia em outro lugar.
  const none = answered && !full && term.trim() !== '' && !found.length;
  const describedBy = [invalid?.['aria-describedby'], none ? hintId : undefined].filter(Boolean).join(' ') || undefined;

  return (
    <div className="int-targets">
      {value.length > 0 && (
        <ul aria-label="Salas escolhidas">
          {value.map((id) => {
            const room = checks[id]?.room.name ? checks[id].room : names[id];
            return (
              <li key={id} className="int-target-row">
                <Icon name={room ? roomIcon(room) : 'room-channel'} />
                <strong>{room ? roomName(room) : <Skeleton width="40%" height={14} />}</strong>
                {/* Num span próprio: no celular o estado desce para a segunda linha sem mexer no selo. */}
                <span>
                  <Status check={checks[id]} grantPublisher={grantPublisher} />
                </span>
                <button type="button" className="icon-btn" aria-label={`Remover ${room ? roomName(room) : 'sala'}`} title="Remover" onClick={() => remove(id)}>
                  <Icon name="close" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {!hideSearch && (
        <div className="picker">
          <input
            ref={setAnchor}
            id={inputId}
            type="search"
            value={term}
            disabled={full}
            placeholder={full ? `Máximo de ${max} salas.` : 'Buscar canal ou grupo privado'}
            aria-label="Buscar canal ou grupo privado"
            role="combobox"
            aria-expanded={shown.length > 0}
            aria-controls={shown.length ? listId : undefined}
            aria-autocomplete="list"
            {...invalid}
            aria-describedby={describedBy}
            onChange={(e) => (setTerm(e.target.value), setOpen(true))}
            // Abre ao clicar, digitar ou com ↓ (não ao receber o foco): o foco levado ao campo com erro não cobre a
            // mensagem com a lista.
            onClick={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={onKey}
          />
          {shown.length > 0 && (
            <SuggestList anchor={anchor} id={listId} label="Salas" onHidden={() => setOpen(false)}>
              {shown.map((r, i) => (
                <button
                  key={r._id}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? 'active' : undefined}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => add(r)}
                >
                  <Icon name={roomIcon(r)} />
                  <strong>{roomName(r)}</strong>
                  {r.notice && <span className="muted">Canal de avisos</span>}
                </button>
              ))}
            </SuggestList>
          )}
          {none && (
            <span className="field-hint" id={hintId}>
              Nenhum canal ou grupo privado encontrado.
            </span>
          )}
        </div>
      )}
      {checkError && <span className="field-error">{checkError}</span>}
      {needsPublisher && (
        <label className="check">
          <input type="checkbox" checked={grantPublisher} onChange={(e) => onGrantPublisher(e.target.checked)} />
          <span>
            {provider === 'jira'
              ? 'Permitir que o Jira publique nos canais de avisos escolhidos'
              : single
                ? 'Permitir que o Microsoft Teams publique neste canal de avisos'
                : `Permitir que o ${BOT_NAME[provider]} publique nos canais de avisos escolhidos`}
          </span>
        </label>
      )}
      {needsPublisher && <span className="field-hint">Só quem pode definir publicadores na sala consegue marcar.</span>}
    </div>
  );
}

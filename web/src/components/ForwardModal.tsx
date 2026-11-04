import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Message, Subscription } from '@shared/index';
import { encryptedContent, FORWARD_MAX_TARGETS } from '@shared/messages';
import { foldText } from '@shared/search';
import { messagePreviewText } from '@shared/stickers';
import { api, errorMessage } from '../lib/api';
import { partyOf, useDirect } from '../lib/direct';
import { roomIconName, roomPath } from '../lib/format';
import { authorName } from '../lib/messageRules';
import { nameOf, namesIn, useNames } from '../lib/names';
import { canWithRoles, useSetting, useStore } from '../lib/store';
import { Icon } from './Icon';
import { briefReason, closeAfterPointer, useListKeys } from './Pickers';
import { Avatar, Modal } from './ui';

// Encaminhar uma mensagem para até 10 conversas ou pessoas. Cada destino passa pelas regras de envio dele no servidor;
// aqui as linhas que o servidor recusaria já aparecem desativadas, com o motivo.

type Target = { key: string; kind: 'room'; rid: string; label: string; sub: Subscription } | { key: string; kind: 'user'; username: string; label: string; userId: string };

interface Candidate {
  target: Target;
  reason?: string; // linha desativada
}

interface Failure {
  key: string;
  label: string;
  error: string;
}

export function ForwardModal({ m, onClose }: { m: Message; onClose: () => void }) {
  const navigate = useNavigate();
  const subs = useStore((s) => s.subscriptions);
  const rooms = useStore((s) => s.rooms);
  const me = useStore((s) => s.me)!;
  const direct = useDirect();
  const max = useSetting<number>('Message_MaxAllowedSize') || 5000;
  useNames();
  const [term, setTerm] = useState('');
  const [picked, setPicked] = useState<Target[]>([]);
  const [people, setPeople] = useState<{ _id: string; username: string; name?: string; roles?: string[] }[]>([]);
  const [peopleFor, setPeopleFor] = useState(''); // termo da última busca de pessoas que voltou
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<Failure[]>([]);
  const [summary, setSummary] = useState('');
  const [listOpen, setListOpen] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!term.trim()) {
      setPeople([]);
      setPeopleFor('');
      return;
    }
    const t = setTimeout(async () => {
      const q = term.trim();
      const r = await api.get('users.autocomplete', { term: q, exclude: [me.username] }).catch(() => ({ items: [] }));
      setPeople(r.items);
      setPeopleFor(q);
    }, 150);
    return () => clearTimeout(t);
  }, [term, me.username]);

  // Motivo de não poder enviar a uma inscrição (o mesmo que o servidor diria). A sala só está no store depois de aberta
  // nesta página; sem ela, valem os sinais que a inscrição traz da sala.
  const roomReason = (s: Subscription): string | undefined => {
    const room = rooms[s.rid];
    const encrypted = room ? encryptedContent(room) : !!s.encrypted;
    const archived = room ? !!room.archived : !!s.archived;
    const ro = room ? !!room.ro : !!s.ro;
    if (encrypted) return 'Não dá para encaminhar para uma sala criptografada.';
    if (archived) return 'Esta sala está arquivada.';
    if (s.notice && !canWithRoles('post-readonly', [...me.roles, ...s.roles])) return 'Só os publicadores enviam aqui.';
    if (ro && !s.notice && !canWithRoles('post-readonly', [...me.roles, ...s.roles])) return 'Esta sala é somente leitura.';
    if ((room as { muted?: string[] } | undefined)?.muted?.includes(me.username)) return 'Você está silenciado nesta sala.';
    if (room?.direct?.canSend === false) return room.direct.sendBlockedReason || 'Você não pode enviar mensagens nesta conversa.';
    return undefined;
  };

  const full = picked.length >= FORWARD_MAX_TARGETS;
  const pickedKeys = new Set(picked.map((p) => p.key));
  const sections = useMemo(() => {
    const all = Object.values(subs).filter((s) => s.open !== false || s.lm);
    const q = foldText(term.trim());
    // Sem busca, as recentes não trazem a conversa de onde a mensagem sai (encaminhar para ela mesma quase nunca é o
    // que se quer); buscando pelo nome, ela aparece.
    const recent = all.filter((s) => s.rid !== m.rid).sort((a, b) => (b.lm ?? '').localeCompare(a.lm ?? ''));
    const roomCands = (q ? all.filter((s) => foldText(`${s.fname || ''} ${s.name || ''}`).includes(q)) : recent)
      .filter((s) => !pickedKeys.has(`r:${s.rid}`))
      .slice(0, 8)
      .map<Candidate>((s) => ({ target: { key: `r:${s.rid}`, kind: 'room', rid: s.rid, label: s.fname || s.name, sub: s }, reason: roomReason(s) }));
    // Pessoas: sem quem já tem a DM listada nas conversas.
    const listedDm = new Set(roomCands.filter((c) => c.target.kind === 'room' && c.target.sub.t === 'd').map((c) => (c.target as { sub: Subscription }).sub.name));
    const userCands = q
      ? people
          .filter((u) => !listedDm.has(u.username) && !pickedKeys.has(`u:${u.username.toLowerCase()}`))
          .map<Candidate>((u) => {
            const st = direct.state([partyOf(u)]);
            // A conversa direta que já existe (fora das 8 listadas) é para onde a mensagem iria: valem as regras dela.
            const dm = Object.values(subs).find((s) => s.t === 'd' && s.name.toLowerCase() === u.username.toLowerCase());
            return {
              target: { key: `u:${u.username.toLowerCase()}`, kind: 'user', username: u.username, label: u.name || u.username, userId: u._id },
              reason: (dm && roomReason(dm)) || (st.kind !== 'open' ? st.text : undefined),
            };
          })
      : [];
    return { rooms: roomCands, users: userCands };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subs, rooms, term, people, picked, direct]);
  const flat = [...sections.rooms, ...sections.users];
  const reasonOf = (c: Candidate) => c.reason ?? (full ? `Até ${FORWARD_MAX_TARGETS} destinos por vez.` : undefined);
  const add = (c: Candidate) => {
    if (reasonOf(c)) return;
    setPicked((p) => [...p, c.target]);
    setTerm('');
    setFailures([]);
    setSummary('');
    inputRef.current?.focus();
  };
  const keys = useListKeys(listOpen ? flat.length : 0, (i) => add(flat[i]), () => setListOpen(false));

  const submit = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    try {
      const targets = picked.map((p) => (p.kind === 'room' ? { rid: p.rid } : { username: p.username }));
      const r = await api.post('chat.forwardMessage', { messageId: m._id, targets, comment: comment.trim() || undefined });
      const results = r.results as { ok: boolean; rid?: string; error?: string }[];
      const okCount = results.filter((x) => x.ok).length;
      if (okCount === results.length) {
        const st = useStore.getState();
        if (okCount === 1) {
          const rid = results[0].rid!;
          const sub = st.subscriptions[rid];
          st.toast('Mensagem encaminhada.', 'success', sub ? { action: { label: 'Abrir', onClick: () => navigate(roomPath(sub)) } } : undefined);
        } else st.toast(`Mensagem encaminhada para ${okCount} conversas.`, 'success');
        onClose();
        return;
      }
      // Parcial: os enviados saem da lista; cada recusado fica com o motivo.
      const fails: Failure[] = [];
      const keep: Target[] = [];
      results.forEach((x, i) => {
        if (x.ok) return;
        keep.push(picked[i]);
        fails.push({ key: picked[i].key, label: picked[i].label, error: namesIn(x.error ?? 'Não foi possível encaminhar.') });
      });
      setPicked(keep);
      setFailures(fails);
      setSummary(`Encaminhada para ${okCount} de ${results.length} ${results.length === 1 ? 'conversa' : 'conversas'}.`);
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const failureOf = (key: string) => failures.find((f) => f.key === key);
  // Prévia do que vai sair: texto, figurinha ou arquivo. Numa encaminhada, o comentário de quem encaminhou antes não
  // vai junto, e o autor é o da original.
  const preview = messagePreviewText({ msg: m.msg, sticker: m.sticker, files: m.files }, { withName: false }) || 'Mensagem';
  const origin = m.forward ? { username: m.forward.u.username, name: m.forward.alias || m.forward.u.name || m.forward.u.username } : { username: m.u.username, name: authorName(m) };
  const searching = !!term.trim() && peopleFor !== term.trim();
  const done = !!summary;

  const row = (c: Candidate, i: number) => {
    const reason = reasonOf(c);
    const t = c.target;
    const icon =
      t.kind === 'user' ? (
        <Avatar username={t.username} size={24} />
      ) : t.sub.t === 'd' ? (
        <Avatar username={t.sub.name.split(', ')[0]} size={24} />
      ) : (
        <span className="fwd-room-icon" aria-hidden="true">
          <Icon name={roomIconName(t.sub)} size={16} />
        </span>
      );
    const sub = t.kind === 'user' ? `@${t.username}` : t.sub.t === 'd' ? 'Conversa direta' : undefined;
    return (
      <button
        key={t.key}
        type="button"
        role="option"
        aria-selected={i === keys.active}
        aria-disabled={reason ? 'true' : undefined}
        {...keys.optionProps(i)}
        className={[i === keys.active && 'active', reason && 'blocked'].filter(Boolean).join(' ') || undefined}
        title={reason}
        onMouseEnter={() => keys.hover(i)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => add(c)}
      >
        {icon}
        <span className="picker-item">
          <span>
            <strong>{t.label}</strong> {sub && <span className="muted">{sub}</span>}
          </span>
          {reason && <span className="picker-reason">{namesIn(briefReason(reason), (x) => nameOf(x))}</span>}
        </span>
      </button>
    );
  };

  return (
    <Modal
      title="Encaminhar mensagem"
      onClose={onClose}
      className="forward-modal"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {done ? 'Fechar' : 'Cancelar'}
          </button>
          <button type="button" className="btn primary" disabled={!picked.length || busy} onClick={() => void submit()}>
            {busy ? 'Encaminhando…' : 'Encaminhar'}
          </button>
        </>
      }
    >
      <div className="fwd-preview">
        <Avatar username={origin.username} size={16} />
        <strong title={origin.name}>{origin.name}</strong>
        <span className="fwd-preview-text">{preview}</span>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="fwd-to">
          Para
        </label>
        <div className="picker fwd-picker">
          <div className="chips">
            {picked.map((p) => (
              <span key={p.key} className={`chip ${failureOf(p.key) ? 'chip-error' : ''}`} title={failureOf(p.key)?.error ?? p.label}>
                {p.kind === 'user' ? <Avatar username={p.username} size={20} /> : <Icon name={roomIconName(p.sub)} size={14} />}
                <span className="chip-label">{p.label}</span>
                <button type="button" aria-label={`Remover ${p.label}`} onClick={() => setPicked((x) => x.filter((y) => y.key !== p.key))}>
                  <Icon name="close" size={14} />
                </button>
              </span>
            ))}
            <input
              id="fwd-to"
              ref={inputRef}
              value={term}
              autoComplete="off"
              onChange={(e) => (setTerm(e.target.value), setListOpen(true))}
              onFocus={() => setListOpen(true)}
              onBlur={() => closeAfterPointer(() => setListOpen(false))}
              onKeyDown={(e) => {
                if (e.key === 'Backspace' && !term && picked.length) setPicked((x) => x.slice(0, -1));
                keys.onKeyDown(e);
              }}
              placeholder="Buscar pessoas e conversas"
              role="combobox"
              aria-expanded={listOpen && flat.length > 0}
              aria-autocomplete="list"
              {...keys.inputProps}
            />
          </div>
        </div>
        {failures.length > 0 && (
          <div className="fwd-failures" role="alert">
            <p>{summary}</p>
            <ul>
              {failures.map((f) => (
                <li key={f.key}>
                  <strong>{f.label}</strong>: {f.error}
                </li>
              ))}
            </ul>
          </div>
        )}
        {listOpen && flat.length > 0 && (
          <div className="picker-list fwd-list" role="listbox" aria-label="Destinos" data-inline="" data-nav={keys.nav}>
            {sections.rooms.length > 0 && <div className="fwd-section">{term.trim() ? 'Conversas' : 'Conversas recentes'}</div>}
            {sections.rooms.map((c, i) => row(c, i))}
            {sections.users.length > 0 && <div className="fwd-section">Pessoas</div>}
            {sections.users.map((c, i) => row(c, sections.rooms.length + i))}
          </div>
        )}
        {listOpen && !flat.length && !!term.trim() && (
          <div className="picker-list fwd-list fwd-empty" role="status" data-inline="">
            {searching ? 'Buscando…' : `Nenhuma pessoa ou conversa encontrada para “${term.trim()}”.`}
          </div>
        )}
      </div>
      <div className="field">
        <label className="field-label" htmlFor="fwd-comment">
          Comentário (opcional)
        </label>
        <textarea id="fwd-comment" rows={3} value={comment} maxLength={max} onChange={(e) => setComment(e.target.value)} />
        {comment.length >= max * 0.8 && (
          <div className="muted small fwd-count">
            {comment.length}/{max}
          </div>
        )}
      </div>
    </Modal>
  );
}

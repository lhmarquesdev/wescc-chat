import { useEffect, useId, useRef, useState } from 'react';
import type { Message, UserRef } from '@shared/index';
import { POLL_DEADLINE_MIN_MINUTES, POLL_MAX_OPTIONS, POLL_OPTION_MAX, POLL_QUESTION_MAX, pollInputIssue, type MessagePoll } from '@shared/messages';
import { api, errorMessage } from '../lib/api';
import { renderMarkdown } from '../lib/markdown';
import { pollClosed, pollMeta, pollShares } from '../lib/messageRules';
import { fromLocalInput, toLocalInput } from '../lib/messageTimes';
import { plural } from '../lib/format';
import { useStore } from '../lib/store';
import { Icon } from './Icon';
import { Avatar, confirmDialog, Empty, Field, Modal, SkeletonList, Toggle, useAsync } from './ui';

// Enquetes: o cartão na conversa, o modal de criar e a lista de quem votou.

// ---------- Meus votos: um pedido por lote de enquetes que aparecem juntas ----------

const pending = new Set<string>();
let timer: number | null = null;
function askMyVotes(id: string) {
  if (useStore.getState().pollVotes[id] || pending.has(id)) return;
  pending.add(id);
  timer ??= window.setTimeout(() => {
    timer = null;
    const ids = [...pending].slice(0, 100);
    for (const x of ids) pending.delete(x);
    void api
      .get('polls.myVotes', { messageIds: ids.join(',') })
      .then((r) => {
        const votes: Record<string, string[]> = Object.fromEntries(ids.map((x) => [x, []]));
        useStore.getState().setPollVotes({ ...votes, ...r.votes });
      })
      .catch(() => {});
    if (pending.size) askMyVotes([...pending][0]);
  }, 50);
}

export interface PollGate {
  voteBlocked?: string; // motivo de não poder votar ('' = pode)
  canClosePolls?: boolean; // delete-message na sala
  canSeePollVoters?: boolean;
}

export function PollCard({ m, gate }: { m: Message; gate: PollGate }) {
  const poll = m.poll!;
  const me = useStore((s) => s.me)!;
  const mine = useStore((s) => s.pollVotes[m._id]);
  const [busy, setBusy] = useState(false);
  const [voters, setVoters] = useState(false);
  const [, tick] = useState(0);
  const qid = useId();
  useEffect(() => askMyVotes(m._id), [m._id]);
  // O prazo vence sem evento até o próximo ciclo do servidor: o cartão se fecha sozinho na hora.
  useEffect(() => {
    if (!poll.closesAt || poll.closedAt) return;
    const ms = new Date(poll.closesAt).getTime() - Date.now();
    if (ms <= 0 || ms > 2 ** 31 - 1) return;
    const t = window.setTimeout(() => tick((x) => x + 1), ms + 50);
    return () => clearTimeout(t);
  }, [poll.closesAt, poll.closedAt]);
  const now = new Date();
  const closed = pollClosed(poll, now);
  const shares = pollShares(poll);
  const chosen = new Set(mine ?? []);
  const blocked = gate.voteBlocked || '';
  const total = poll.options.reduce((n, o) => n + o.votes, 0);
  const top = Math.max(...poll.options.map((o) => o.votes));
  const own = m.u._id === me._id;
  const canClose = !closed && (own || !!gate.canClosePolls);
  const canSee = !poll.anonymous && gate.canSeePollVoters !== false && total > 0;
  const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');

  const vote = async (id: string) => {
    if (closed || busy) return;
    if (blocked) {
      useStore.getState().toast(blocked, 'warning');
      return;
    }
    const next = poll.multiple ? (chosen.has(id) ? [...chosen].filter((x) => x !== id) : [...chosen, id]) : chosen.has(id) ? [] : [id];
    setBusy(true);
    try {
      const r = await api.post('polls.vote', { messageId: m._id, optionIds: next });
      useStore.getState().setPollVotes({ [m._id]: r.optionIds });
      useStore.getState().upsertMessage(r.message);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const close = async () => {
    const ok = await confirmDialog({ title: 'Encerrar esta enquete?', body: 'Ninguém mais poderá votar.', confirmLabel: 'Encerrar' });
    if (!ok) return;
    try {
      const r = await api.post('polls.close', { messageId: m._id });
      useStore.getState().upsertMessage(r.message);
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className={`poll-card ${closed ? 'closed' : ''}`} role="group" aria-labelledby={qid}>
      <div className="poll-head">
        <Icon name="poll" size={16} />
        <span>Enquete</span>
        <span aria-hidden="true">·</span>
        <span>{pollMeta(poll, now)}</span>
      </div>
      <div className="poll-q" id={qid}>
        {renderMarkdown(poll.question, { me: me.username, mentions: m.mentions, channels: m.channels })}
      </div>
      <div className="poll-opts" role={poll.multiple ? 'group' : 'radiogroup'} aria-labelledby={qid}>
        {poll.options.map((o, i) => {
          const on = chosen.has(o.id);
          return (
            <button
              key={o.id}
              type="button"
              role={poll.multiple ? 'checkbox' : 'radio'}
              aria-checked={on}
              className={['poll-opt', on && 'on', closed && total > 0 && o.votes === top && 'top'].filter(Boolean).join(' ')}
              disabled={closed}
              aria-disabled={!!blocked || undefined}
              title={blocked || undefined}
              onClick={() => void vote(o.id)}
            >
              <span className="poll-bar" style={{ width: `${shares[i]}%` }} aria-hidden="true" />
              <span className="poll-check" aria-hidden="true">
                {on && <Icon name="check" size={14} />}
              </span>
              <span className="poll-text">{o.text}</span>
              <span className="poll-count">
                {shares[i]}% · {o.votes}
              </span>
            </button>
          );
        })}
      </div>
      <div className="poll-foot">
        <span className="muted">
          {plural(total, 'voto', 'votos')} · {plural(poll.voters, 'pessoa', 'pessoas')}
        </span>
        {canSee && (
          <button type="button" className="btn ghost small" onClick={() => setVoters(true)}>
            Ver votos
          </button>
        )}
        {canClose && (
          <button type="button" className="btn ghost small" onClick={() => void close()}>
            <Icon name="poll-close" size={14} />
            Encerrar
          </button>
        )}
      </div>
      {voters && <PollVotersModal m={m} poll={poll} onClose={() => setVoters(false)} />}
    </div>
  );
}

function PollVotersModal({ m, poll, onClose }: { m: Message; poll: MessagePoll; onClose: () => void }) {
  const { data, error, loading } = useAsync(() => api.get('polls.voters', { messageId: m._id }) as Promise<{ options: { id: string; total: number; users: UserRef[] }[] }>, [m._id, m._updatedAt]);
  return (
    <Modal title="Votos" onClose={onClose} className="poll-voters">
      {loading && !data ? (
        <SkeletonList n={4} />
      ) : error ? (
        <Empty icon="error" tone="danger" title="Não foi possível carregar">
          {error}
        </Empty>
      ) : (
        data!.options.map((o) => {
          const text = poll.options.find((x) => x.id === o.id)?.text ?? o.id;
          return (
            <section key={o.id} className="poll-voters-opt">
              <h3>
                {text} · {o.total}
              </h3>
              {o.users.length ? (
                <ul>
                  {o.users.map((u) => (
                    <li key={u._id}>
                      <Avatar username={u.username} size={24} />
                      <span>{u.name || u.username}</span>
                    </li>
                  ))}
                  {o.total > o.users.length && <li className="muted">e mais {o.total - o.users.length}</li>}
                </ul>
              ) : (
                <p className="muted small">Ninguém votou nesta opção.</p>
              )}
            </section>
          );
        })
      )}
    </Modal>
  );
}

// ---------- Criar ----------

type Deadline = 'none' | '1h' | '1d' | '1w' | 'custom';
const DEADLINES: { id: Deadline; label: string; ms?: number }[] = [
  { id: 'none', label: 'Sem prazo' },
  { id: '1h', label: 'Em 1 hora', ms: 3600_000 },
  { id: '1d', label: 'Em 1 dia', ms: 86400_000 },
  { id: '1w', label: 'Em 1 semana', ms: 7 * 86400_000 },
  { id: 'custom', label: 'Escolher data e hora…' },
];

export function PollModal({ rid, tmid, onClose }: { rid: string; tmid?: string | null; onClose: () => void }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [deadline, setDeadline] = useState<Deadline>('none');
  const [custom, setCustom] = useState(() => toLocalInput(new Date(Date.now() + 86400_000)));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const focusNext = useRef<number | null>(null);
  useEffect(() => {
    if (focusNext.current !== null) {
      refs.current[focusNext.current]?.focus();
      focusNext.current = null;
    }
  });

  const closesAt = (() => {
    const d = DEADLINES.find((x) => x.id === deadline);
    if (d?.ms) return new Date(Date.now() + d.ms).toISOString();
    if (deadline === 'custom') return fromLocalInput(custom)?.toISOString() ?? 'inválido';
    return null;
  })();
  const issue = pollInputIssue({ question, options, closesAt }, new Date());
  const show = (field: string) => (issue?.field === field && touched[field] ? issue.text : undefined);

  const submit = async () => {
    setTouched({ question: true, options: true, deadline: true });
    if (issue || busy) return;
    setBusy(true);
    try {
      await api.post('polls.create', { rid, tmid: tmid ?? undefined, question: question.trim(), options, multiple, anonymous, closesAt: closesAt ?? undefined });
      onClose();
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Nova enquete"
      onClose={onClose}
      className="poll-modal"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn primary" disabled={!!issue || busy} onClick={() => void submit()}>
            {busy ? 'Criando…' : 'Criar enquete'}
          </button>
        </>
      }
    >
      <Field label="Pergunta" error={show('question')}>
        <input
          value={question}
          maxLength={POLL_QUESTION_MAX}
          placeholder="O que você quer perguntar?"
          onChange={(e) => setQuestion(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, question: true }))}
        />
      </Field>
      <Field label="Opções" error={show('options')}>
        <div className="poll-modal-opts">
          {options.map((o, i) => (
            <div key={i} className="poll-modal-opt">
              <input
                ref={(el) => {
                  refs.current[i] = el;
                }}
                value={o}
                maxLength={POLL_OPTION_MAX + 20}
                placeholder={`Opção ${i + 1}`}
                aria-label={`Opção ${i + 1}`}
                onChange={(e) => {
                  setOptions((list) => list.map((x, j) => (j === i ? e.target.value : x)));
                  setTouched((t) => ({ ...t, options: true }));
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  if (i < options.length - 1) refs.current[i + 1]?.focus();
                  else if (options.length < POLL_MAX_OPTIONS) {
                    focusNext.current = i + 1;
                    setOptions((list) => [...list, '']);
                  }
                }}
              />
              {i >= 2 && (
                <button type="button" className="icon-btn" aria-label="Remover opção" title="Remover opção" onClick={() => setOptions((list) => list.filter((_, j) => j !== i))}>
                  <Icon name="close" size={16} />
                </button>
              )}
            </div>
          ))}
          {options.length < POLL_MAX_OPTIONS && (
            <button
              type="button"
              className="btn ghost poll-add"
              onClick={() => {
                focusNext.current = options.length;
                setOptions((list) => [...list, '']);
              }}
            >
              <Icon name="add" size={16} />
              Adicionar opção
            </button>
          )}
        </div>
      </Field>
      <Toggle checked={multiple} onChange={setMultiple} label="Permitir mais de uma resposta" />
      <Toggle
        checked={anonymous}
        onChange={setAnonymous}
        label="Votação anônima"
        description={anonymous ? 'Ninguém vê quem votou em cada opção, nem você.' : 'Quem está na sala vê quem votou em cada opção.'}
      />
      <Field label="Encerrar" error={show('deadline')}>
        <select
          value={deadline}
          onChange={(e) => {
            setDeadline(e.target.value as Deadline);
            setTouched((t) => ({ ...t, deadline: true }));
          }}
        >
          {DEADLINES.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </Field>
      {deadline === 'custom' && (
        <Field label="Data e hora">
          <input type="datetime-local" value={custom} min={toLocalInput(new Date(Date.now() + POLL_DEADLINE_MIN_MINUTES * 60_000))} onChange={(e) => setCustom(e.target.value)} />
        </Field>
      )}
    </Modal>
  );
}

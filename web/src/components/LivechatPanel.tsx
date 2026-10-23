import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { LivechatRoomInfo } from '@shared/index';
import { api, errorMessage } from '../lib/api';
import { formatDateTime, formatRelative } from '../lib/format';
import { usePermission, useSetting, useStore } from '../lib/store';
import { Icon } from './Icon';
import { Empty, Field, Modal, Segmented, SkeletonList, Spinner } from './ui';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const ok = (t: string) => useStore.getState().toast(t);

export const LIVECHAT_STATUS: Record<string, string> = { queued: 'Na fila', open: 'Em atendimento', onhold: 'Em espera', closed: 'Encerrada' };
// Situação com cor de status (nunca a cor de destaque): na fila = atenção, em atendimento = ok.
const LIVECHAT_TONE: Record<string, string> = { queued: 'pill warn dot', open: 'pill ok dot', onhold: 'pill dot', closed: 'pill' };

export function LivechatStatus({ status }: { status: string }) {
  return <span className={LIVECHAT_TONE[status] ?? 'pill'}>{LIVECHAT_STATUS[status] ?? status}</span>;
}

// Visitante não tem foto: as iniciais do nome num círculo neutro, com a mesma regra dos avatares do
// servidor (primeiras letras das duas primeiras palavras), para o mesmo nome dar as mesmas letras no app todo.
export function VisitorAvatar({ name, size = 32 }: { name?: string | null; size?: number }) {
  const clean = (name ?? '').trim() || '?';
  const parts = clean.split(/[\s._-]+/).filter(Boolean);
  const initials = (parts.length > 1 ? parts[0][0] + parts[1][0] : clean.slice(0, 2)).toUpperCase();
  return (
    <span className="visitor-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }} aria-hidden="true">
      {initials}
    </span>
  );
}

export function useLivechatRoom(rid: string) {
  const live = useStore((s) => s.livechatRooms[rid]);
  const [data, setData] = useState<{ room: LivechatRoomInfo; visitor: any; previousChats: any[] } | null>(null);
  const [error, setError] = useState('');
  const reload = () =>
    api
      .get('livechat/room.info', { rid })
      .then((r) => {
        setData(r);
        useStore.setState({ livechatRooms: { ...useStore.getState().livechatRooms, [rid]: r.room } });
      })
      .catch((e) => setError(errorMessage(e)));
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rid]);
  return { room: live ?? data?.room ?? null, visitor: data?.visitor, previousChats: data?.previousChats ?? [], error, reload };
}

// Ações rápidas no cabeçalho de uma conversa de atendimento.
export function LivechatActions({ rid, onPanel }: { rid: string; onPanel: () => void }) {
  const { room } = useLivechatRoom(rid);
  const me = useStore((s) => s.me)!;
  const [modal, setModal] = useState<'close' | 'forward' | null>(null);
  const canClose = usePermission('close-livechat-room');
  const canForward = usePermission('transfer-livechat-guest');
  const canHold = usePermission('on-hold-livechat-room');
  const allowHold = useSetting<boolean>('Livechat_allow_manual_on_hold');
  if (!room || room.status === 'closed') return null;
  const mine = room.servedBy?._id === me._id;
  return (
    <>
      {room.status === 'queued' && (
        <button className="btn small primary" onClick={() => api.post('livechat/inquiries.take', { inquiryId: rid }).catch(fail)}>
          Assumir
        </button>
      )}
      {/* No celular o nome do visitante tem prioridade no cabeçalho: espera e transferência vão para o painel. */}
      {canHold && allowHold && room.status === 'open' && (
        <button className="icon-btn lc-secondary" title="Colocar em espera" aria-label="Colocar em espera" onClick={() => api.post('livechat/room.onHold', { roomId: rid }).catch(fail)}>
          <Icon name="on-hold" size={18} />
        </button>
      )}
      {room.status === 'onhold' && (
        <button className="icon-btn lc-secondary" title="Retomar" aria-label="Retomar" onClick={() => api.post('livechat/room.resumeOnHold', { roomId: rid }).catch(fail)}>
          <Icon name="resume" size={18} />
        </button>
      )}
      {canForward && room.status !== 'queued' && (
        <button className="icon-btn lc-secondary" title="Transferir" aria-label="Transferir" onClick={() => setModal('forward')}>
          <Icon name="transfer" size={18} />
        </button>
      )}
      {canClose && (mine || room.status !== 'queued') && (
        <button className="btn small danger lc-close" title="Encerrar atendimento" onClick={() => setModal('close')}>
          <Icon name="livechat-close" size={18} />
          {/* No celular só o ícone aparece; o texto continua para leitores de tela. */}
          <span className="lc-close-label">Encerrar</span>
        </button>
      )}
      <button className="icon-btn" title="Dados do atendimento" aria-label="Dados do atendimento" onClick={onPanel}>
        <Icon name="livechat-details" size={18} />
      </button>
      {modal === 'close' && <CloseModal room={room} onClose={() => setModal(null)} />}
      {modal === 'forward' && <ForwardModal room={room} onClose={() => setModal(null)} />}
    </>
  );
}

// Espera, retomada e transferência no topo do painel: no celular elas saem do cabeçalho para o nome caber.
function PanelActions({ room }: { room: LivechatRoomInfo }) {
  const [forward, setForward] = useState(false);
  const canForward = usePermission('transfer-livechat-guest');
  const canHold = usePermission('on-hold-livechat-room');
  const allowHold = useSetting<boolean>('Livechat_allow_manual_on_hold');
  const hold = canHold && allowHold && room.status === 'open';
  const resume = room.status === 'onhold';
  const transfer = canForward && room.status !== 'queued' && room.status !== 'closed';
  if (!hold && !resume && !transfer) return null;
  return (
    <div className="lc-actions">
      {transfer && (
        <button type="button" className="btn" onClick={() => setForward(true)}>
          <Icon name="transfer" />
          Transferir
        </button>
      )}
      {hold && (
        <button type="button" className="btn" onClick={() => api.post('livechat/room.onHold', { roomId: room.rid }).catch(fail)}>
          <Icon name="on-hold" />
          Colocar em espera
        </button>
      )}
      {resume && (
        <button type="button" className="btn" onClick={() => api.post('livechat/room.resumeOnHold', { roomId: room.rid }).catch(fail)}>
          <Icon name="resume" />
          Retomar
        </button>
      )}
      {forward && <ForwardModal room={room} onClose={() => setForward(false)} />}
    </div>
  );
}

function TagEditor({ value, onChange, departmentId }: { value: string[]; onChange: (v: string[]) => void; departmentId?: string | null }) {
  const [tags, setTags] = useState<{ _id: string; name: string }[]>([]);
  const [text, setText] = useState('');
  useEffect(() => {
    api.get('livechat/tags', departmentId ? { departmentId } : undefined).then((r) => setTags(r.tags)).catch(() => {});
  }, [departmentId]);
  const add = (t: string) => {
    const v = t.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setText('');
  };
  return (
    <div className="picker lc-tags">
      <div className="chips">
        {value.map((t) => (
          <span key={t} className="chip">
            {t}
            <button type="button" title="Remover" aria-label={`Remover ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>
              <Icon name="close" size={14} />
            </button>
          </span>
        ))}
        {/* O campo fica dentro da caixa das tags, como no seletor de pessoas. */}
        <input
          list="livechat-tags"
          placeholder="Adicionar tag"
          aria-label="Adicionar tag"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(text);
            }
          }}
          onBlur={() => text && add(text)}
        />
      </div>
      <datalist id="livechat-tags">
        {tags.map((t) => (
          <option key={t._id} value={t.name} />
        ))}
      </datalist>
    </div>
  );
}

function CloseModal({ room, onClose }: { room: LivechatRoomInfo; onClose: () => void }) {
  const [comment, setComment] = useState('');
  const [tags, setTags] = useState<string[]>(room.tags ?? []);
  const requireComment = useSetting<boolean>('Livechat_request_comment_when_closing_conversation');
  const submit = async () => {
    try {
      await api.post('livechat/room.closeByUser', { rid: room.rid, comment, tags });
      ok('Atendimento encerrado.');
      onClose();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Modal
      title="Encerrar atendimento"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={requireComment && !comment.trim()} onClick={submit}>
            Encerrar
          </button>
        </>
      }
    >
      <div className="form">
        <Field label={`Comentário${requireComment ? ' (obrigatório)' : ''}`}>
          <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} autoFocus />
        </Field>
        <Field label="Tags">
          <TagEditor value={tags} onChange={setTags} departmentId={room.departmentId} />
        </Field>
      </div>
    </Modal>
  );
}

function ForwardModal({ room, onClose }: { room: LivechatRoomInfo; onClose: () => void }) {
  const [mode, setMode] = useState<'agent' | 'department'>('agent');
  const [agents, setAgents] = useState<any[] | null>(null);
  const [departments, setDepartments] = useState<any[]>([]);
  const [target, setTarget] = useState('');
  const [comment, setComment] = useState('');
  useEffect(() => {
    api.get('livechat/users/agent', { count: 200 }).then((r) => setAgents(r.users)).catch(() => setAgents([]));
    api.get('livechat/department', { enabled: true, count: 200 }).then((r) => setDepartments(r.departments)).catch(() => {});
  }, []);
  const submit = async () => {
    try {
      await api.post('livechat/room.forward', { roomId: room.rid, comment, ...(mode === 'agent' ? { userId: target } : { departmentId: target }) });
      ok('Atendimento transferido.');
      onClose();
    } catch (e) {
      fail(e);
    }
  };
  return (
    <Modal
      title="Transferir atendimento"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => api.post('livechat/inquiries.returnAsInquiry', { roomId: room.rid }).then(onClose).catch(fail)}>
            Devolver para a fila
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!target} onClick={submit}>
            Transferir
          </button>
        </>
      }
    >
      <div className="form">
        <Segmented
          label="Transferir para"
          value={mode}
          onChange={(m) => (setMode(m), setTarget(''))}
          items={[
            { id: 'agent', label: 'Para um agente' },
            { id: 'department', label: 'Para um departamento' },
          ]}
        />
        {mode === 'agent' ? (
          agents === null ? (
            <Spinner />
          ) : (
            <Field label="Agente" hint="Só agentes online e disponíveis podem receber.">
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Escolha</option>
                {agents
                  .filter((a) => a._id !== room.servedBy?._id)
                  .map((a) => (
                    <option key={a._id} value={a._id} disabled={a.statusLivechat !== 'available' || a.status === 'offline'}>
                      {a.name} (@{a.username}) — {a.status === 'offline' ? 'offline' : a.statusLivechat === 'available' ? `${a.openChats} chats` : 'indisponível'}
                    </option>
                  ))}
              </select>
            </Field>
          )
        ) : (
          <Field label="Departamento">
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Escolha</option>
              {departments
                .filter((d) => d._id !== room.departmentId)
                .map((d) => (
                  <option key={d._id} value={d._id}>
                    {d.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <Field label="Comentário (opcional)">
          <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export function LivechatInfoPanel({ rid }: { rid: string }) {
  const { room, visitor, previousChats, error, reload } = useLivechatRoom(rid);
  const navigate = useNavigate();
  const [edit, setEdit] = useState(false);
  const [priorities, setPriorities] = useState<any[]>([]);
  const [slas, setSlas] = useState<any[]>([]);
  const [fields, setFields] = useState<any[]>([]);
  const canEdit = usePermission('edit-livechat-contact');
  useEffect(() => {
    api.get('livechat/priorities').then((r) => setPriorities(r.priorities)).catch(() => {});
    api.get('livechat/sla').then((r) => setSlas(r.sla)).catch(() => {});
    api.get('livechat/custom-fields').then((r) => setFields(r.customFields)).catch(() => {});
  }, []);
  if (error)
    return (
      <Empty icon="error" tone="danger" title="Não foi possível carregar o atendimento">
        {error}
      </Empty>
    );
  if (!room || !visitor) return <SkeletonList n={6} />;
  const save = (roomData: Record<string, unknown>) => api.post('livechat/room.saveInfo', { rid, roomData }).then(reload).catch(fail);
  const closed = room.status === 'closed';
  const roomFields = fields.filter((f) => f.scope === 'room');
  const visitorFields = fields.filter((f) => f.scope === 'visitor');
  const rating = room.survey?.satisfaction != null ? Math.max(0, Math.min(5, Number(room.survey.satisfaction) || 0)) : null;
  return (
    <div className="info livechat-info">
      <div className="info-hero">
        <VisitorAvatar name={visitor.name} size={64} />
        <h3>{visitor.name}</h3>
        <LivechatStatus status={room.status} />
      </div>
      <PanelActions room={room} />
      {edit ? (
        <ContactForm visitor={visitor} rid={rid} onDone={() => (setEdit(false), reload())} />
      ) : (
        <div className="lc-section">
          <div className="lc-label">
            Contato
            {canEdit && (
              <button type="button" className="btn small ghost" onClick={() => setEdit(true)}>
                <Icon name="edit" size={14} />
                Editar
              </button>
            )}
          </div>
          <div className="lc-line">
            <Icon name="email" size={14} />
            {visitor.email ? <a href={`mailto:${visitor.email}`}>{visitor.email}</a> : <span className="muted">Sem e-mail</span>}
          </div>
          {visitor.phone && (
            <div className="lc-line">
              <Icon name="call-audio" size={14} />
              <span className="num">{visitor.phone}</span>
            </div>
          )}
          {visitorFields.map((f) =>
            visitor.customFields?.[f._id] ? (
              <div key={f._id} className="lc-line">
                <span className="muted">{f.label}</span> {String(visitor.customFields[f._id])}
              </div>
            ) : null,
          )}
          {visitor.ip && <div className="lc-line muted">IP {visitor.ip}</div>}
        </div>
      )}
      <div className="lc-section">
        <div className="lc-label">Atendimento</div>
        <dl className="lc-kv">
          <dt>Departamento</dt>
          <dd>{room.departmentName ?? '—'}</dd>
          <dt>Agente</dt>
          <dd>{room.servedBy ? room.servedBy.name || `@${room.servedBy.username}` : '—'}</dd>
          <dt>Na fila desde</dt>
          <dd>{formatDateTime(room.queuedAt)}</dd>
          {room.servedAt && (
            <>
              <dt>Atendido em</dt>
              <dd>{formatDateTime(room.servedAt)}</dd>
            </>
          )}
          {room.closedAt && (
            <>
              <dt>Encerrado em</dt>
              <dd>{formatDateTime(room.closedAt)}</dd>
            </>
          )}
          {room.closeComment && (
            <>
              <dt>Comentário</dt>
              <dd>{room.closeComment}</dd>
            </>
          )}
          {room.source?.url && (
            <>
              <dt>Página</dt>
              <dd className="ellipsis">
                <a href={room.source.url} target="_blank" rel="noopener noreferrer">
                  {room.source.url}
                </a>
              </dd>
            </>
          )}
          {rating != null && (
            <>
              <dt>Satisfação</dt>
              <dd className="lc-rating" title={`${rating} de 5`}>
                {Array.from({ length: 5 }, (_, i) => (
                  <Icon key={i} name="rating" size={14} fill={i < rating} className={i < rating ? 'on' : ''} />
                ))}
                <span>{rating} de 5</span>
              </dd>
            </>
          )}
          {room.survey?.additionalFeedback != null && (
            <>
              <dt>Feedback</dt>
              <dd>{String(room.survey.additionalFeedback)}</dd>
            </>
          )}
        </dl>
      </div>
      <section className="form">
        <Field label="Prioridade">
          <select disabled={closed} value={room.priority?._id ?? ''} onChange={(e) => save({ priorityId: e.target.value || null })}>
            <option value="">Sem prioridade</option>
            {priorities.map((p) => (
              <option key={p._id} value={p._id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="SLA" hint={room.sla && room.status === 'queued' ? `Prazo de ${room.sla.dueTimeInMinutes} min` : undefined}>
          <select disabled={closed} value={room.sla?._id ?? ''} onChange={(e) => save({ slaId: e.target.value || null })}>
            <option value="">Sem SLA</option>
            {slas.map((s) => (
              <option key={s._id} value={s._id}>
                {s.name} ({s.dueTimeInMinutes} min)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tags">
          <TagEditor value={room.tags ?? []} onChange={(tags) => save({ tags })} departmentId={room.departmentId} />
        </Field>
        <TopicField value={room.topic ?? ''} disabled={closed} onSave={(topic) => save({ topic })} />
        {roomFields.map((f) => (
          <CustomFieldInput key={f._id} field={f} value={room.livechatData?.[f._id]} disabled={closed} onSave={(v) => save({ livechatData: { [f._id]: v } })} />
        ))}
      </section>
      {closed && visitor.email && (
        <button className="btn" onClick={() => api.post('livechat/room.transcript', { rid, email: visitor.email }).then(() => ok('Transcrição enviada.')).catch(fail)}>
          <Icon name="email" />
          Enviar transcrição para {visitor.email}
        </button>
      )}
      {previousChats.length > 0 && (
        <div className="lc-section">
          <div className="lc-label">Conversas anteriores</div>
          {previousChats.map((c) => (
            <button key={c.rid} type="button" className="list-row link-row lc-prev" onClick={() => navigate(`/live/${c.rid}`)}>
              <Icon name="room-livechat" />
              <span className="num">{formatDateTime(c.ts)}</span>
              <span className="spacer" />
              <LivechatStatus status={c.status} />
            </button>
          ))}
        </div>
      )}
      <div className="lc-foot">Conversa iniciada {formatRelative(room.ts)}</div>
    </div>
  );
}

function TopicField({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <Field label="Assunto">
      <input disabled={disabled} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)} />
    </Field>
  );
}

function CustomFieldInput({ field, value, disabled, onSave }: { field: any; value: unknown; disabled: boolean; onSave: (v: string) => void }) {
  const [v, setV] = useState(String(value ?? field.defaultValue ?? ''));
  useEffect(() => setV(String(value ?? '')), [value]);
  return (
    <Field label={field.label}>
      {field.options?.length ? (
        <select disabled={disabled} value={v} onChange={(e) => (setV(e.target.value), onSave(e.target.value))}>
          <option value="" />
          {field.options.map((o: string) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      ) : (
        <input disabled={disabled} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== String(value ?? '') && onSave(v)} />
      )}
    </Field>
  );
}

function ContactForm({ visitor, rid, onDone }: { visitor: any; rid: string; onDone: () => void }) {
  const [f, setF] = useState({ name: visitor.name ?? '', email: visitor.email ?? '', phone: visitor.phone ?? '' });
  return (
    <section className="form">
      <Field label="Nome">
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <Field label="E-mail">
        <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      </Field>
      <Field label="Telefone">
        <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
      </Field>
      <div className="row-actions">
        <button className="btn" onClick={onDone}>
          Cancelar
        </button>
        <button className="btn primary" onClick={() => api.post('livechat/room.saveInfo', { rid, guestData: f }).then(onDone).catch(fail)}>
          Salvar
        </button>
      </div>
    </section>
  );
}

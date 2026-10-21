import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { LivechatRoomInfo } from '@shared/index';
import { api, errorMessage } from '../lib/api';
import { formatDateTime, formatRelative } from '../lib/format';
import { usePermission, useSetting, useStore } from '../lib/store';
import { Field, Modal, Spinner } from './ui';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const ok = (t: string) => useStore.getState().toast(t);

export const LIVECHAT_STATUS: Record<string, string> = { queued: 'Na fila', open: 'Em atendimento', onhold: 'Em espera', closed: 'Encerrada' };

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
      {canHold && allowHold && room.status === 'open' && (
        <button className="icon-btn" title="Colocar em espera" onClick={() => api.post('livechat/room.onHold', { roomId: rid }).catch(fail)}>
          ⏸
        </button>
      )}
      {room.status === 'onhold' && (
        <button className="icon-btn" title="Retomar" onClick={() => api.post('livechat/room.resumeOnHold', { roomId: rid }).catch(fail)}>
          ▶
        </button>
      )}
      {canForward && room.status !== 'queued' && (
        <button className="icon-btn" title="Transferir" onClick={() => setModal('forward')}>
          ⇄
        </button>
      )}
      {canClose && (mine || room.status !== 'queued') && (
        <button className="btn small danger" onClick={() => setModal('close')}>
          Encerrar
        </button>
      )}
      <button className="icon-btn" title="Dados do atendimento" onClick={onPanel}>
        🎧
      </button>
      {modal === 'close' && <CloseModal room={room} onClose={() => setModal(null)} />}
      {modal === 'forward' && <ForwardModal room={room} onClose={() => setModal(null)} />}
    </>
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
    <div className="picker">
      <div className="chips">
        {value.map((t) => (
          <span key={t} className="chip">
            {t}
            <button onClick={() => onChange(value.filter((x) => x !== t))}>✕</button>
          </span>
        ))}
      </div>
      <input
        list="livechat-tags"
        placeholder="Adicionar tag"
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
          <button className="btn primary" disabled={!target} onClick={submit}>
            Transferir
          </button>
        </>
      }
    >
      <div className="form">
        <div className="tabs">
          <button className={mode === 'agent' ? 'active' : ''} onClick={() => (setMode('agent'), setTarget(''))}>
            Para um agente
          </button>
          <button className={mode === 'department' ? 'active' : ''} onClick={() => (setMode('department'), setTarget(''))}>
            Para um departamento
          </button>
        </div>
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
  if (error) return <div className="form-error">{error}</div>;
  if (!room || !visitor) return <Spinner />;
  const save = (roomData: Record<string, unknown>) => api.post('livechat/room.saveInfo', { rid, roomData }).then(reload).catch(fail);
  const closed = room.status === 'closed';
  const roomFields = fields.filter((f) => f.scope === 'room');
  const visitorFields = fields.filter((f) => f.scope === 'visitor');
  return (
    <div className="info">
      <div className="info-hero">
        <h3>{visitor.name}</h3>
        <span className={`pill ${room.status === 'open' ? 'accent' : ''}`}>{LIVECHAT_STATUS[room.status]}</span>
      </div>
      {edit ? (
        <ContactForm visitor={visitor} rid={rid} onDone={() => (setEdit(false), reload())} />
      ) : (
        <section>
          <h4>Contato</h4>
          <div>{visitor.email ? <a href={`mailto:${visitor.email}`}>{visitor.email}</a> : <span className="muted">sem e-mail</span>}</div>
          {visitor.phone && <div>📞 {visitor.phone}</div>}
          {visitorFields.map((f) =>
            visitor.customFields?.[f._id] ? (
              <div key={f._id} className="small">
                <span className="muted">{f.label}:</span> {String(visitor.customFields[f._id])}
              </div>
            ) : null,
          )}
          {visitor.ip && <div className="muted small">IP {visitor.ip}</div>}
          {canEdit && (
            <button className="link small" onClick={() => setEdit(true)}>
              Editar contato
            </button>
          )}
        </section>
      )}
      <section>
        <h4>Atendimento</h4>
        <div className="small">
          <div>Departamento: {room.departmentName ?? '—'}</div>
          <div>Agente: {room.servedBy ? `${room.servedBy.name ?? ''} (@${room.servedBy.username})` : '—'}</div>
          <div>Na fila desde: {formatDateTime(room.queuedAt)}</div>
          {room.servedAt && <div>Atendido em: {formatDateTime(room.servedAt)}</div>}
          {room.closedAt && <div>Encerrado em: {formatDateTime(room.closedAt)}</div>}
          {room.closeComment && <div>Comentário: {room.closeComment}</div>}
          {room.source?.url && (
            <div className="ellipsis">
              Página: <a href={room.source.url} target="_blank" rel="noopener noreferrer">{room.source.url}</a>
            </div>
          )}
          {room.survey?.satisfaction != null && <div>Satisfação: {'⭐'.repeat(Number(room.survey.satisfaction) || 0)}</div>}
          {room.survey?.additionalFeedback != null && <div>Feedback: {String(room.survey.additionalFeedback)}</div>}
        </div>
      </section>
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
          ✉ Enviar transcrição para {visitor.email}
        </button>
      )}
      {previousChats.length > 0 && (
        <section>
          <h4>Conversas anteriores</h4>
          {previousChats.map((c) => (
            <button key={c.rid} className="list-row link-row" onClick={() => navigate(`/live/${c.rid}`)}>
              <span>{formatDateTime(c.ts)}</span>
              <span className="spacer" />
              <span className="pill">{LIVECHAT_STATUS[c.status]}</span>
            </button>
          ))}
        </section>
      )}
      <div className="muted small">Conversa iniciada {formatRelative(room.ts)}</div>
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

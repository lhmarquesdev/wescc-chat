import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useStore } from '../../lib/store';
import { Empty, Field, Modal, Pager, Spinner, Tabs, Toggle, useAsync } from '../../components/ui';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const ok = (t: string) => useStore.getState().toast(t);

const EVENT_LABEL: Record<string, string> = {
  sendMessage: 'Mensagem enviada',
  fileUploaded: 'Arquivo enviado',
  roomArchived: 'Sala arquivada',
  roomCreated: 'Sala criada',
  roomJoined: 'Usuário entrou na sala',
  roomLeft: 'Usuário saiu da sala',
  userCreated: 'Usuário criado',
};

const INCOMING_SCRIPT = `class Script {
  // request: { url, headers, content, content_raw }
  process_incoming_request({ request }) {
    return {
      content: {
        text: 'Recebido: ' + JSON.stringify(request.content),
      },
    };
  }
}`;

const OUTGOING_SCRIPT = `class Script {
  // Retorne null para não chamar a URL, ou o request alterado.
  prepare_outgoing_request({ request }) {
    return request;
  }
  // Retorne { content: { text } } para responder na sala.
  process_outgoing_response({ request, response }) {
    return { content: response.content };
  }
}`;

type Kind = 'webhook-incoming' | 'webhook-outgoing';

export function AdminIntegrations() {
  const [tab, setTab] = useState<Kind>('webhook-incoming');
  const [offset, setOffset] = useState(0);
  const { data, loading, reload } = useAsync(() => api.get('integrations.list', { type: tab, offset, count: 50 }), [tab, offset]);
  const [edit, setEdit] = useState<any>(null);
  const [historyOf, setHistoryOf] = useState<any>(null);

  return (
    <>
      <div className="page-title-row">
        <h1>Integrações</h1>
        <button className="btn primary" onClick={() => setEdit({ type: tab, isNew: true })}>
          ＋ Nova integração
        </button>
      </div>
      <Tabs
        value={tab}
        onChange={(t) => (setTab(t), setOffset(0))}
        items={[
          { id: 'webhook-incoming', label: 'Webhooks de entrada' },
          { id: 'webhook-outgoing', label: 'Webhooks de saída' },
        ]}
      />
      {loading ? (
        <Spinner />
      ) : !data?.integrations.length ? (
        <Empty>{tab === 'webhook-incoming' ? 'Nenhum webhook de entrada. Use para que sistemas externos publiquem mensagens no chat.' : 'Nenhum webhook de saída. Use para avisar sistemas externos sobre eventos do chat.'}</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>{tab === 'webhook-incoming' ? 'Canal' : 'Evento'}</th>
              <th>Publica como</th>
              <th>Status</th>
              <th>Criada</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.integrations.map((i: any) => (
              <tr key={i._id} className="clickable" onClick={() => setEdit(i)}>
                <td>
                  <strong>{i.name}</strong> {i.scriptEnabled && <span className="pill">script</span>}
                </td>
                <td>{tab === 'webhook-incoming' ? i.channel.join(', ') : EVENT_LABEL[i.event] ?? i.event}</td>
                <td>@{i.username}</td>
                <td>{i.enabled ? <span className="pill accent">ativa</span> : <span className="pill">desativada</span>}</td>
                <td className="muted">{formatDateTime(i._createdAt)}</td>
                <td>
                  {tab === 'webhook-outgoing' && (
                    <button className="btn small" onClick={(e) => (e.stopPropagation(), setHistoryOf(i))}>
                      Histórico
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && <Pager offset={offset} count={50} total={data.total} onChange={setOffset} />}
      {edit && <IntegrationForm initial={edit} onClose={() => setEdit(null)} onSaved={reload} />}
      {historyOf && <History integration={historyOf} onClose={() => setHistoryOf(null)} />}
    </>
  );
}

function IntegrationForm({ initial, onClose, onSaved }: { initial: any; onClose: () => void; onSaved: () => void }) {
  const incoming = initial.type === 'webhook-incoming';
  const [f, setF] = useState({
    name: initial.name ?? '',
    enabled: initial.enabled ?? true,
    username: initial.username ?? 'admin',
    channel: (initial.channel ?? []).join(', '),
    event: initial.event ?? 'sendMessage',
    urls: (initial.urls ?? []).join('\n'),
    triggerWords: (initial.triggerWords ?? []).join(', '),
    triggerWordAnywhere: initial.triggerWordAnywhere ?? false,
    alias: initial.alias ?? '',
    emoji: initial.emoji ?? '',
    avatar: initial.avatar ?? '',
    impersonateUser: initial.impersonateUser ?? false,
    runOnEdits: initial.runOnEdits ?? false,
    retryFailedCalls: initial.retryFailedCalls ?? true,
    retryCount: initial.retryCount ?? 5,
    retryDelay: initial.retryDelay ?? 'powers-of-ten',
    targetRoom: initial.targetRoom ?? '',
    scriptEnabled: initial.scriptEnabled ?? false,
    script: initial.script || (incoming ? INCOMING_SCRIPT : OUTGOING_SCRIPT),
  });
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });
  const hookUrl = initial._id ? `${location.origin}/hooks/${initial._id}/${initial.token}` : '';

  const save = async () => {
    const body = {
      ...f,
      type: initial.type,
      channel: f.channel.split(',').map((s: string) => s.trim()).filter(Boolean),
      urls: f.urls.split('\n').map((s: string) => s.trim()).filter(Boolean),
      triggerWords: f.triggerWords.split(',').map((s: string) => s.trim()).filter(Boolean),
      retryCount: Number(f.retryCount),
    };
    try {
      if (initial.isNew) await api.post('integrations.create', body);
      else await api.put('integrations.update', { ...body, integrationId: initial._id });
      ok('Integração salva.');
      onSaved();
      onClose();
    } catch (e) {
      fail(e);
    }
  };
  const remove = async () => {
    if (!confirm(`Excluir a integração ${initial.name}?`)) return;
    try {
      await api.post('integrations.remove', { type: initial.type, integrationId: initial._id });
      onSaved();
      onClose();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <Modal
      wide
      title={initial.isNew ? (incoming ? 'Novo webhook de entrada' : 'Novo webhook de saída') : initial.name}
      onClose={onClose}
      footer={
        <>
          {!initial.isNew && (
            <button className="btn danger" onClick={remove}>
              Excluir
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" onClick={save}>
            Salvar
          </button>
        </>
      }
    >
      <div className="form">
        <Toggle checked={f.enabled} onChange={(v) => set({ enabled: v })} label="Ativa" />
        <Field label="Nome">
          <input value={f.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        {!incoming && (
          <Field label="Evento">
            <select value={f.event} onChange={(e) => set({ event: e.target.value })}>
              {Object.entries(EVENT_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field
          label={incoming ? 'Canal de destino' : 'Canais observados (vazio = todos)'}
          hint={incoming ? '#canal ou @usuário; vários separados por vírgula.' : '#canal, @usuário, all_public_channels, all_private_groups ou all_direct_messages.'}
        >
          <input value={f.channel} onChange={(e) => set({ channel: e.target.value })} />
        </Field>
        <Field label="Publicar como (usuário)" hint="As mensagens aparecem com este usuário. Ele precisa participar dos canais privados.">
          <input value={f.username} onChange={(e) => set({ username: e.target.value.replace(/^@/, '') })} />
        </Field>
        {!incoming && (
          <>
            {f.event === 'sendMessage' && (
              <>
                <Field label="Palavras-gatilho (vírgula; vazio = toda mensagem)">
                  <input value={f.triggerWords} onChange={(e) => set({ triggerWords: e.target.value })} />
                </Field>
                <Toggle checked={f.triggerWordAnywhere} onChange={(v) => set({ triggerWordAnywhere: v })} label="Gatilho em qualquer posição do texto" />
                <Toggle checked={f.runOnEdits} onChange={(v) => set({ runOnEdits: v })} label="Disparar também em edições" />
              </>
            )}
            <Field label="URLs (uma por linha)">
              <textarea rows={3} value={f.urls} onChange={(e) => set({ urls: e.target.value })} />
            </Field>
            <Field label="Responder em outra sala (opcional)" hint="#canal ou @usuário. Vazio = responde na sala do evento.">
              <input value={f.targetRoom} onChange={(e) => set({ targetRoom: e.target.value })} />
            </Field>
            <Toggle checked={f.impersonateUser} onChange={(v) => set({ impersonateUser: v })} label="Responder como o usuário que disparou" />
            <Toggle checked={f.retryFailedCalls} onChange={(v) => set({ retryFailedCalls: v })} label="Tentar de novo quando falhar" />
            {f.retryFailedCalls && (
              <div className="two-col">
                <Field label="Tentativas">
                  <input type="number" min={0} max={10} value={f.retryCount} onChange={(e) => set({ retryCount: Number(e.target.value) })} />
                </Field>
                <Field label="Intervalo">
                  <select value={f.retryDelay} onChange={(e) => set({ retryDelay: e.target.value })}>
                    <option value="powers-of-ten">Potências de 10</option>
                    <option value="powers-of-two">Potências de 2</option>
                    <option value="increments-of-two">Incrementos de 2s</option>
                  </select>
                </Field>
              </div>
            )}
          </>
        )}
        <div className="two-col">
          <Field label="Apelido (opcional)">
            <input value={f.alias} onChange={(e) => set({ alias: e.target.value })} />
          </Field>
          <Field label="Emoji como avatar (ex.: :robot:)">
            <input value={f.emoji} onChange={(e) => set({ emoji: e.target.value })} />
          </Field>
        </div>
        <Field label="URL do avatar (opcional)">
          <input value={f.avatar} onChange={(e) => set({ avatar: e.target.value })} />
        </Field>
        <Toggle checked={f.scriptEnabled} onChange={(v) => set({ scriptEnabled: v })} label="Usar script" />
        {f.scriptEnabled && (
          <Field label="Script" hint="Só roda se a configuração Integrações → Permitir scripts estiver ligada.">
            <textarea className="mono" rows={12} value={f.script} onChange={(e) => set({ script: e.target.value })} />
          </Field>
        )}
        {hookUrl && incoming && (
          <Field label="URL do webhook" hint="Envie POST com JSON { text, attachments, channel, alias, emoji }.">
            <div className="copy-box">
              <input readOnly value={hookUrl} />
              <button className="btn" onClick={() => (navigator.clipboard?.writeText(hookUrl), ok('URL copiada.'))}>
                Copiar
              </button>
            </div>
            <code className="small muted">{`curl -X POST -H 'Content-Type: application/json' --data '{"text":"Olá"}' ${hookUrl}`}</code>
          </Field>
        )}
        {!incoming && initial.token && (
          <Field label="Token enviado no corpo (para validar a origem)">
            <input readOnly value={initial.token} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

function History({ integration, onClose }: { integration: any; onClose: () => void }) {
  const [offset, setOffset] = useState(0);
  const { data, loading, reload } = useAsync(() => api.get('integrations.history', { id: integration._id, offset, count: 25 }), [offset]);
  return (
    <Modal
      wide
      title={`Histórico: ${integration.name}`}
      onClose={onClose}
      footer={
        <button className="btn" onClick={() => api.post('integrations.clearHistory', { integrationId: integration._id }).then(reload).catch(fail)}>
          Limpar histórico
        </button>
      }
    >
      {loading ? (
        <Spinner />
      ) : !data?.history.length ? (
        <Empty>Nenhuma chamada ainda.</Empty>
      ) : (
        <ul className="plain-list">
          {data.history.map((h: any) => (
            <li key={h._id}>
              <div>
                <strong className={h.step === 'sent' ? 'pos' : h.step === 'failed' || h.step === 'script-error' ? 'neg' : ''}>{h.step}</strong> <span className="muted">· {EVENT_LABEL[h.event] ?? h.event} · {formatDateTime(h._createdAt)}</span>
                {h.httpStatus ? <span className="pill">HTTP {h.httpStatus}</span> : null}
              </div>
              {h.url && <div className="mono small">{h.url}</div>}
              {h.error && <div className="neg small">{h.error}</div>}
              {h.response && <pre className="md-pre small">{h.response.slice(0, 600)}</pre>}
            </li>
          ))}
        </ul>
      )}
      {data && <Pager offset={offset} count={25} total={data.total} onChange={setOffset} />}
    </Modal>
  );
}

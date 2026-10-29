// Administração › Chamadas: o servidor de chamadas (LiveKit), o HTTPS (câmera e microfone dependem dele) e as chamadas
// em andamento, com "Encerrar". Só com manage-calls.
import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Call } from '@shared/index';
import { formatCallClock } from '@shared/calls';
import { api, errorMessage } from '../../../lib/api';
import { callRoomName } from '../../../lib/call/store';
import { useNames } from '../../../lib/names';
import { roomIconName } from '../../../lib/format';
import { callRoomLabel, useNow } from '../../../lib/roomcall';
import { useStore } from '../../../lib/store';
import { SelfTest } from '../../../components/call/SelfTest';
import { Icon } from '../../../components/Icon';
import { Empty, Skeleton, SkeletonTable, confirmDialog, useAsync } from '../../../components/ui';
import { PageHead, RoomCell, TableWrap, UserCell, num } from '../parts';
import { SETTINGS_GROUP, settingsPath } from '../sections';
import '../../../components/callroom.css';

interface SfuStatus {
  configured: boolean;
  reachable: boolean;
  latencyMs: number | null;
  rooms: number | null;
  participants: number | null;
  error?: string;
  url: string;
  urlFromEnv: boolean;
  groupEnabled: boolean;
  directViaSfu: boolean;
  tls: { enabled: boolean; subject?: string; validFrom?: string; validTo?: string; daysLeft?: number; error?: string };
  secure: boolean;
  bridges: { open: number; refusedLastMinute: number };
  present: number;
  maxPresent: number;
}

const day = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });
const onOff = (v: boolean) => (v ? 'Ligadas' : 'Desligadas');

export function AdminCalls() {
  const status = useAsync(() => api.get<SfuStatus>('calls.sfu.status'), []);
  const [testing, setTesting] = useState(false);
  // O cabeçalho fica fora do invólucro: o layout da administração o espera como filho direto de .page-body.
  return (
    <>
      <PageHead title="Chamadas" />
      <div className="admin-calls">
        <ServerCard data={status.data} loading={status.loading} error={status.error} onReload={status.reload} onTest={() => setTesting(true)} />
        {status.data ? <HttpsCard s={status.data} /> : status.loading && <HttpsSkeleton />}
        <ActiveCalls onEnded={status.reload} />
        {testing && <SelfTest onClose={() => setTesting(false)} />}
      </div>
    </>
  );
}

function ServerCard({
  data,
  loading,
  error,
  onReload,
  onTest,
}: {
  data: SfuStatus | null;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onTest: () => void;
}) {
  const pill = !data ? null : !data.configured ? (
    <span className="pill dot">Não configurado</span>
  ) : data.reachable ? (
    <span className="pill ok dot">Funcionando</span>
  ) : (
    <span className="pill err dot">Sem resposta</span>
  );
  return (
    <section className="card" aria-labelledby="calls-server-title">
      <div className="card-head">
        <h2 id="calls-server-title">Servidor de chamadas</h2>
        {pill}
      </div>
      {!data && loading && <RowsSkeleton />}
      {error && (
        <div className="callout err admin-calls-error">
          <Icon name="error" />
          <span>{error}</span>
        </div>
      )}
      {data && !data.configured && (
        <div className="callout info admin-calls-error">
          <Icon name="info" />
          <span>Chamadas em grupo precisam do servidor de chamadas LiveKit. Veja a seção “Chamadas em grupo” do README para instalar no Windows ou no Linux.</span>
        </div>
      )}
      {data && (
        <dl className="admin-calls-rows">
          {data.configured && (
            <>
              <dt>Endereço interno</dt>
              <dd>
                <span className="mono">{data.url}</span>
                {data.urlFromEnv && <span className="cell-sub">definido pela variável LIVEKIT_URL</span>}
              </dd>
              <dt>Sinalização</dt>
              <dd>Este chat, em /sfu</dd>
              <dt>Latência</dt>
              <dd>{data.reachable && data.latencyMs != null ? `${num(Math.round(data.latencyMs))} ms` : '—'}</dd>
              <dt>Salas abertas</dt>
              <dd>{num(data.rooms)}</dd>
            </>
          )}
          <dt>Pessoas em chamadas</dt>
          <dd>{`${num(data.present)} de ${num(data.maxPresent)}`}</dd>
          <dt>Conexões de sinalização abertas</dt>
          <dd>{num(data.bridges.open)}</dd>
          <dt>Chamadas em grupo</dt>
          <dd>{onOff(data.groupEnabled)}</dd>
          <dt>Chamadas a dois pelo servidor</dt>
          <dd>{onOff(data.directViaSfu)}</dd>
        </dl>
      )}
      {data?.configured && !data.reachable && data.error && (
        <div className="callout err admin-calls-error">
          <Icon name="call-server-down" />
          <span>{data.error}</span>
        </div>
      )}
      <div className="admin-calls-actions">
        <button type="button" className="btn" onClick={onTest}>
          <Icon name="call-server" />
          Testar minha conexão
        </button>
        <button type="button" className="btn" onClick={onReload} disabled={loading}>
          <Icon name="call-retry" />
          Atualizar
        </button>
        <Link className="admin-calls-link" to={settingsPath(SETTINGS_GROUP.calls)}>
          Configurações de chamadas
        </Link>
      </div>
    </section>
  );
}

// Esqueletos do tamanho do que vem (as oito linhas do servidor, o aviso do HTTPS): o cartão de baixo não pula.
const SK_ROWS = [64, 40, 52, 36, 44, 56, 30, 46];
function RowsSkeleton() {
  return (
    <dl className="admin-calls-rows skeleton-group" role="status" aria-label="Carregando" aria-busy="true">
      {SK_ROWS.map((w, i) => (
        <Fragment key={i}>
          <dt>
            <Skeleton width={`${w + 30}%`} />
          </dt>
          <dd>
            <Skeleton width={`${w}%`} />
            {/* O endereço tem a linha de baixo ("definido pela variável LIVEKIT_URL"). */}
            {i === 0 && <Skeleton width="38%" height={10} />}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

function HttpsSkeleton() {
  return (
    <section className="card" aria-labelledby="calls-https-title" aria-busy="true">
      <div className="card-head">
        <h2 id="calls-https-title">HTTPS</h2>
      </div>
      <Skeleton height={46} className="admin-calls-sk-callout" />
    </section>
  );
}

function HttpsCard({ s }: { s: SfuStatus }) {
  const t = s.tls;
  let body;
  if (t.enabled && t.daysLeft != null && t.daysLeft < 30)
    body = (
      <div className="callout warn">
        <Icon name="warning" />
        <span>O certificado HTTPS vence em {t.daysLeft} dias. Renove antes para as chamadas continuarem funcionando.</span>
      </div>
    );
  else if (t.enabled && t.validTo)
    body = (
      <div className="callout ok">
        <Icon name="success" />
        <span>
          Certificado válido até {day.format(new Date(t.validTo))} ({t.daysLeft} dias).
        </span>
      </div>
    );
  else if (s.secure)
    body = (
      <div className="callout info">
        <Icon name="info" />
        <span>HTTPS feito por um proxy reverso.</span>
      </div>
    );
  else
    body = (
      <div className="callout err">
        <Icon name="error" />
        <span>Este chat não está em HTTPS: câmera e microfone só funcionam neste computador. Ative o HTTPS (veja o README).</span>
      </div>
    );
  return (
    <section className="card" aria-labelledby="calls-https-title">
      <div className="card-head">
        <h2 id="calls-https-title">HTTPS</h2>
      </div>
      {body}
      {t.error && (
        <div className="callout err admin-calls-error">
          <Icon name="error" />
          <span>{t.error}</span>
        </div>
      )}
    </section>
  );
}

const kindLabel = (c: Call) => (c.scope === 'direct' ? 'A dois' : c.listenOnly ? 'Transmissão' : c.kind === 'video' ? 'Vídeo' : 'Voz');

// Lista viva: busca a cada 10 s enquanto a aba está visível. Encerrar também atualiza os números do servidor.
function ActiveCalls({ onEnded }: { onEnded: () => void }) {
  const { data, loading, error, reload } = useAsync(() => api.get<{ calls: Call[] }>('calls.admin.active'), []);
  useEffect(() => {
    const tick = () => document.visibilityState === 'visible' && reload();
    const timer = window.setInterval(tick, 10_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const calls = data?.calls ?? [];
  const now = useNow(calls.length > 0);
  useNames(); // conversas em grupo têm o nome das pessoas, que chega depois da lista
  const end = async (c: Call) => {
    const sala = callRoomLabel(c.room, 'esta sala');
    const ok = await confirmDialog({ title: `Encerrar a chamada em ${sala}?`, body: 'Todos saem da chamada agora.', confirmLabel: 'Encerrar', danger: true });
    if (!ok) return;
    try {
      await api.post('calls.admin.end', { callId: c._id });
      useStore.getState().toast('Chamada encerrada.', 'success');
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
    }
    reload();
    onEnded();
  };
  return (
    <section className="card" aria-labelledby="calls-active-title">
      <div className="card-head">
        <h2 id="calls-active-title">Chamadas em andamento</h2>
        {calls.length > 0 && <span className="pill">{num(calls.length)}</span>}
      </div>
      {loading && !data ? (
        <SkeletonTable rows={3} cols={5} />
      ) : error && !data ? (
        <div className="callout err">
          <Icon name="error" />
          <span>{error}</span>
        </div>
      ) : !calls.length ? (
        <Empty>Nenhuma chamada em andamento.</Empty>
      ) : (
        <TableWrap>
          <table className="table stack kv">
            <thead>
              <tr>
                <th>Sala</th>
                <th>Iniciada por</th>
                <th className="num">Pessoas</th>
                <th className="num">Duração</th>
                <th>Tipo</th>
                <th className="actions-col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => {
                const room = c.room;
                const name = callRoomName(room ?? null) || '—';
                const since = c.answeredAt ?? c.createdAt;
                return (
                  <tr key={c._id}>
                    {/* No celular a sala é o título do cartão; o resto vira pares rótulo e valor, como nas outras tabelas. */}
                    <td>
                      <RoomCell icon={<Icon name={room ? roomIconName(room) : 'room-channel'} />} name={name} />
                    </td>
                    <td data-label="Iniciada por">
                      <UserCell username={c.caller.username} name={c.caller.name} />
                    </td>
                    <td className="num" data-label="Pessoas">
                      {num(c.participantsCount)}
                    </td>
                    <td className="num" data-label="Duração">
                      {c.status === 'ringing' ? 'Tocando' : formatCallClock(Math.max(0, (now - Date.parse(since)) / 1000))}
                    </td>
                    <td data-label="Tipo">{kindLabel(c)}</td>
                    <td className="actions-col">
                      <div className="row-actions">
                        <button type="button" className="btn small danger" onClick={() => void end(c)}>
                          Encerrar
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
    </section>
  );
}

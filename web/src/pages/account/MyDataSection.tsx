// Minha conta › Meus dados (LGPD): pedir uma cópia dos próprios dados. O servidor monta o .zip em segundo plano e avisa
// em tempo real (userdata.changed); o arquivo fica disponível pelo prazo da configuração.
import { useEffect, useState } from 'react';
import type { UserDataRequest } from '@shared/index';
import { api, errorMessage } from '../../lib/api';
import { formatBytes, formatDateTime, formatTime } from '../../lib/format';
import { realtime } from '../../lib/realtime';
import { useSetting, useStore } from '../../lib/store';
import { Icon } from '../../components/Icon';
import { Skeleton, Spinner, useAsync } from '../../components/ui';
import { PageHead } from '../admin/parts';

interface DataDownloads {
  enabled: boolean;
  expirationHours: number;
  nextAllowedAt: string | null;
  requests: UserDataRequest[];
}

function RequestStatus({ r }: { r: UserDataRequest }) {
  switch (r.status) {
    case 'pending':
      return (
        <p className="my-data-status" role="status">
          <Spinner size="sm" />
          Na fila desde {formatTime(r.requestedAt)}.
        </p>
      );
    case 'running':
      return (
        <p className="my-data-status" role="status">
          <Spinner size="sm" />
          Preparando seus dados…
        </p>
      );
    case 'ready':
      return (
        <div className="my-data-ready">
          <p className="my-data-status">
            <Icon name="success" size={16} />
            Pronto · {formatBytes(r.size ?? 0)} · disponível até {formatDateTime(r.expiresAt)}
          </p>
          <a className="btn" href={`/api/v1/users.dataDownloads.file?id=${encodeURIComponent(r._id)}`} download>
            <Icon name="download" />
            Baixar
          </a>
        </div>
      );
    case 'failed':
      return (
        <p className="field-error my-data-status">
          <Icon name="error" size={14} />
          Não foi possível preparar seus dados: {r.error ?? 'erro desconhecido.'} Peça de novo.
        </p>
      );
    case 'expired':
      return <p className="muted my-data-status">O arquivo expirou em {formatDateTime(r.expiresAt)}.</p>;
    default:
      return null;
  }
}

export function MyDataSection() {
  const site = useSetting<string>('Site_Name') || 'Wescc Chat';
  const { data, loading, reload } = useAsync(() => api.get<DataDownloads>('users.dataDownloads.list'), []);
  const [busy, setBusy] = useState(false);

  // O pedido muda de estado em segundo plano (fila, preparando, pronto, vencido).
  useEffect(() => {
    const off = realtime.on((ev) => {
      if (ev.type === 'userdata.changed') reload();
    });
    return () => {
      off();
    };
  }, [reload]);

  // Quando as 24 horas passam com a página aberta, o botão volta sozinho.
  const next = data?.nextAllowedAt ?? null;
  useEffect(() => {
    if (!next) return;
    const wait = new Date(next).getTime() - Date.now();
    if (wait <= 0 || wait > 2 ** 31 - 1) return;
    const t = setTimeout(reload, wait + 1000);
    return () => clearTimeout(t);
  }, [next, reload]);

  const ask = async () => {
    setBusy(true);
    try {
      await api.post('users.requestDataDownload');
      useStore.getState().toast('Pedido feito. Avisamos quando ficar pronto.', 'success');
      reload();
    } catch (e) {
      useStore.getState().toast(errorMessage(e), 'error');
      reload();
    } finally {
      setBusy(false);
    }
  };

  const latest = data?.requests[0];
  const hours = data?.expirationHours ?? 72;
  return (
    <>
      <PageHead title="Meus dados" />
      <p className="page-lead">
        Baixe uma cópia dos seus dados no {site}: perfil, mensagens que você escreveu (com o nome de cada conversa), arquivos que você enviou, reações e eventos da
        Agenda. É um direito seu pela LGPD.
      </p>
      <div className="account-col">
        <section className="card" aria-labelledby="my-data-title">
          <div className="card-head">
            <span className="card-icon">
              <Icon name="my-data" size={20} />
            </span>
            <div className="my-data-body">
              <h2 id="my-data-title">Pedir uma cópia</h2>
              <p className="card-desc">
                Preparamos um arquivo .zip em segundo plano. Quando ficar pronto, avisamos aqui, por notificação e por e-mail. O arquivo fica disponível por{' '}
                {hours === 1 ? '1 hora' : `${hours} horas`}.
              </p>
              {loading && !data ? (
                <Skeleton width={180} height={36} />
              ) : (
                <>
                  {latest && <RequestStatus r={latest} />}
                  <div className="my-data-actions">
                    <button type="button" className={latest?.status === 'ready' ? 'btn' : 'btn primary'} disabled={busy || !!next || !data?.enabled} onClick={ask}>
                      <Icon name="my-data" />
                      Pedir meus dados
                    </button>
                    {next && <p className="muted small">Você poderá pedir de novo em {formatDateTime(next)}.</p>}
                  </div>
                </>
              )}
            </div>
          </div>
        </section>
        <p className="muted small my-data-foot">
          O .zip traz uma página (meus-dados.html) para ler no navegador e os mesmos dados em JSON. Para corrigir ou excluir dados, fale com o administrador.
        </p>
      </div>
    </>
  );
}

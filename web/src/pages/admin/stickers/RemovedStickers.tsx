// Figurinhas: as imagens removidas de todas as conversas (lista de bloqueio), com a cópia guardada para a moderação.
import { useState } from 'react';
import type { BlockedStickerFile } from '@shared/stickers';
import { formatDateTime, formatRelative } from '../../../lib/format';
import { stickerAdmin, stickerErrorText, useStickerCaps } from '../../../lib/stickers';
import { useStore } from '../../../lib/store';
import { Icon } from '../../../components/Icon';
import { Empty, Pager, SearchInput, SkeletonTable, confirmDialog, useAsync } from '../../../components/ui';
import { TableWrap } from '../parts';

const PAGE = 25;
const day = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

export function RemovedStickers() {
  const caps = useStickerCaps();
  const [text, setText] = useState('');
  const [offset, setOffset] = useState(0);
  const q = text.trim();
  const { data, error, loading, reload } = useAsync(() => stickerAdmin.blockedList({ text: q || undefined, offset, count: PAGE }), [q, offset]);
  const files = data?.files ?? [];

  const unblock = async (f: BlockedStickerFile) => {
    const ok = await confirmDialog({
      title: 'Permitir esta imagem de novo?',
      body: 'Ela poderá ser criada ou importada outra vez. As mensagens antigas continuam como “Figurinha removida”, e a cópia guardada para a moderação é apagada.',
      confirmLabel: 'Permitir',
    });
    if (!ok) return;
    try {
      await stickerAdmin.unblock(f.fileId);
      useStore.getState().toast('Imagem liberada. Ela pode ser adicionada de novo.', 'success');
      reload();
    } catch (e) {
      useStore.getState().toast(stickerErrorText(e), 'error');
    }
  };

  return (
    <>
      <div className="filters admin-filters">
        <SearchInput
          value={text}
          onChange={(v) => {
            setText(v);
            setOffset(0);
          }}
          placeholder="Buscar por nome ou motivo"
        />
      </div>
      {loading && !data ? (
        <SkeletonTable rows={5} cols={6} />
      ) : error ? (
        <Empty
          icon="error"
          tone="danger"
          title="Não foi possível carregar as figurinhas removidas"
          action={
            <button type="button" className="btn" onClick={reload}>
              Tentar de novo
            </button>
          }
        >
          {error}
        </Empty>
      ) : !files.length && q ? (
        <Empty
          icon="search"
          title={`Nada encontrado para “${q}”`}
          action={
            <button type="button" className="btn" onClick={() => setText('')}>
              Limpar busca
            </button>
          }
        >
          Busque pelo nome da figurinha ou pelo motivo da remoção.
        </Empty>
      ) : !files.length ? (
        <Empty icon="sticker-removed" title="Nenhuma figurinha removida" />
      ) : (
        <TableWrap>
          <table className="table stack kv stk-removed">
            <thead>
              <tr>
                <th>Figurinha</th>
                <th>Motivo</th>
                <th>Removida por</th>
                <th>Quando</th>
                <th className="num">Mensagens</th>
                <th>Cópia para a moderação</th>
                {caps.canModerate && (
                  <th className="actions-col">
                    <span className="visually-hidden">Ações</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.fileId}>
                  <td>
                    <RemovedCell file={f} />
                  </td>
                  <td data-label="Motivo">{f.reason || <span className="muted">—</span>}</td>
                  <td className="nowrap" data-label="Removida por">
                    {f.blockedBy ? `@${f.blockedBy.username}` : <span className="muted">—</span>}
                  </td>
                  <td className="nowrap" data-label="Quando">
                    <span title={formatDateTime(f.blockedAt)}>{formatRelative(f.blockedAt)}</span>
                  </td>
                  <td className="num" data-label="Mensagens">
                    {f.messages.toLocaleString('pt-BR')}
                  </td>
                  <td className="nowrap" data-label="Cópia para a moderação">
                    {f.quarantined && f.quarantineUntil ? `Até ${day.format(new Date(f.quarantineUntil))}` : 'Apagada'}
                  </td>
                  {caps.canModerate && (
                    <td className="actions-col">
                      <div className="row-actions">
                        <button type="button" className="btn small ghost" onClick={() => void unblock(f)}>
                          Permitir de novo
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {data && !error && <Pager offset={offset} count={PAGE} total={data.total} onChange={setOffset} />}
    </>
  );
}

// Nada aparece até alguém pedir: "Mostrar" carrega a cópia (o servidor registra cada vez) e "Ocultar" esconde.
function RemovedCell({ file: f }: { file: BlockedStickerFile }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="stk-removed-cell">
      <span className="stk-removed-tile">{shown ? <img src={stickerAdmin.quarantineUrl(f)} alt="" /> : <Icon name="hide" size={16} />}</span>
      <span className="stk-removed-name">{f.name}</span>
      {f.quarantined && (
        <button type="button" className="btn small ghost" aria-label={`${shown ? 'Ocultar' : 'Mostrar'} ${f.name}`} onClick={() => setShown((v) => !v)}>
          {shown ? 'Ocultar' : 'Mostrar'}
        </button>
      )}
    </div>
  );
}

import { useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, plural } from '../../lib/format';
import { useStore } from '../../lib/store';
import { Icon } from '../../components/Icon';
import { Empty, Field, FileButton, Modal, Pager, SearchInput, SkeletonList, SkeletonTable, confirmDialog, useAsync } from '../../components/ui';
import { DeviceCell, PageHead, RoomCell, TableWrap, UserCell, deviceLabel, lastSeen } from './parts';

const fail = (e: unknown) => useStore.getState().toast(errorMessage(e), 'error');
const ok = (t: string) => useStore.getState().toast(t);

export function AdminDevices() {
  const [filter, setFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const { data, loading, reload } = useAsync(() => api.get('sessions.list.all', { filter, offset, count: 50 }), [filter, offset]);
  const sessions: any[] = data?.sessions ?? [];
  const end = async (s: any) => {
    const yes = await confirmDialog({
      title: `Encerrar a sessão de @${s.username}?`,
      body: `${deviceLabel(s.device)} sai da conta e precisa entrar de novo.`,
      confirmLabel: 'Encerrar sessão',
      danger: true,
    });
    if (!yes) return;
    api.post('sessions.logout', { sessionId: s._id }).then(reload).catch(fail);
  };
  return (
    <>
      <PageHead title="Dispositivos" count={data && !filter ? data.total : undefined} />
      <div className="filters admin-filters">
        <SearchInput value={filter} onChange={(v) => (setFilter(v), setOffset(0))} placeholder="Filtrar por usuário ou IP" />
      </div>
      {loading && !data ? (
        <SkeletonTable rows={8} cols={5} />
      ) : !sessions.length ? (
        <Empty icon="devices" title={filter ? 'Nenhuma sessão encontrada' : 'Nenhuma sessão ativa'}>
          {filter ? 'Confira o usuário ou o IP digitado.' : 'As sessões aparecem aqui quando as pessoas entram no chat.'}
        </Empty>
      ) : (
        <TableWrap>
          <table className="table stack kv">
            <thead>
              <tr>
                <th>Usuário</th>
                <th>Dispositivo</th>
                <th className="col-xl">Login</th>
                <th>Último uso</th>
                <th className="actions-col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s: any) => (
                <tr key={s._id}>
                  <td>
                    <UserCell username={s.username} name={s.name} />
                  </td>
                  <td data-label="Dispositivo">
                    <DeviceCell device={s.device} />
                  </td>
                  <td className="muted nowrap col-xl" data-label="Login">
                    {formatDateTime(s.createdAt)}
                  </td>
                  <td className="nowrap" data-label="Último uso">
                    {lastSeen(s.lastActiveAt)}
                  </td>
                  <td className="actions-col">
                    <div className="row-actions">
                      <button className="btn small ghost danger" onClick={() => end(s)}>
                        <Icon name="logout" />
                        Encerrar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {data && data.total > 0 && <Pager offset={offset} count={50} total={data.total} onChange={setOffset} />}
    </>
  );
}

export function AdminModeration() {
  const { data, loading, reload } = useAsync(() => api.get('moderation.reportsByUsers', { count: 100 }), []);
  const [user, setUser] = useState<any>(null);
  return (
    <>
      <PageHead title="Moderação" count={data?.reports.length || undefined} />
      {loading && !data ? (
        <SkeletonTable rows={5} cols={3} />
      ) : !data?.reports.length ? (
        <Empty icon="report" title="Nenhuma denúncia pendente">
          Mensagens denunciadas pelas pessoas aparecem aqui para você analisar.
        </Empty>
      ) : (
        <TableWrap>
          <table className="table stack kv">
            <thead>
              <tr>
                <th>Usuário denunciado</th>
                <th className="num">Denúncias</th>
                <th>Última</th>
              </tr>
            </thead>
            <tbody>
              {data.reports.map((r: any) => (
                <tr key={r.userId} className="clickable" onClick={() => setUser(r)}>
                  <td>
                    <UserCell username={r.username} name={r.name} />
                  </td>
                  <td className="num" data-label="Denúncias">
                    <span className="pill err">{r.count}</span>
                  </td>
                  <td className="nowrap" data-label="Última">
                    {lastSeen(r.ts)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {user && <UserReports user={user} onClose={() => (setUser(null), reload())} />}
    </>
  );
}

function UserReports({ user, onClose }: { user: any; onClose: () => void }) {
  const { data, loading } = useAsync(() => api.get('moderation.userReports', { userId: user.userId }), [user.userId]);
  const deleteMessages = async () => {
    const yes = await confirmDialog({
      title: 'Apagar as mensagens denunciadas?',
      body: `As mensagens de @${user.username} que foram denunciadas somem das conversas.`,
      confirmLabel: 'Apagar mensagens',
      danger: true,
    });
    if (yes) api.post('moderation.user.deleteReportedMessages', { userId: user.userId }).then(onClose).catch(fail);
  };
  const deactivate = async () => {
    const yes = await confirmDialog({
      title: `Desativar @${user.username}?`,
      body: 'A pessoa não consegue entrar até ser reativada. As mensagens permanecem.',
      confirmLabel: 'Desativar',
      danger: true,
    });
    if (yes) api.post('users.setActiveStatus', { userId: user.userId, activeStatus: false }).then(onClose).catch(fail);
  };
  return (
    <Modal
      wide
      title={`Denúncias contra @${user.username}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn left" onClick={() => api.post('moderation.dismissReports', { userId: user.userId }).then(onClose).catch(fail)}>
            Descartar denúncias
          </button>
          <button className="btn danger" onClick={deleteMessages}>
            <Icon name="delete" />
            Apagar mensagens denunciadas
          </button>
          <button className="btn danger" onClick={deactivate}>
            <Icon name="disabled-user" />
            Desativar usuário
          </button>
        </>
      }
    >
      {loading && !data ? (
        <SkeletonList n={3} />
      ) : (
        <ul className="report-list">
          {data?.reports.map((r: any) => (
            <li key={r._id}>
              <div className="report-meta">
                <strong>{r.reporter}</strong> denunciou {lastSeen(r.ts).toLowerCase()}
                {r.roomName && (
                  <span className="muted">
                    {' '}
                    · <Icon name="room-channel" size={12} />
                    {r.roomName}
                  </span>
                )}
              </div>
              {r.msg && <blockquote>{r.msg}</blockquote>}
              {r.description && <div className="muted small">Motivo: {r.description}</div>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export function AdminEmoji() {
  const emojiVersion = useStore((s) => s.emojiVersion);
  const { data, loading, reload } = useAsync(() => api.get('emoji-custom.list'), [emojiVersion]);
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [adding, setAdding] = useState(false);
  const emojis: any[] = data?.emojis.update ?? [];
  const create = async () => {
    if (!file) return;
    const fd = new FormData();
    fd.append('name', name);
    fd.append('aliases', aliases);
    fd.append('emoji', file);
    try {
      await api.post('emoji-custom.create', fd);
      setName('');
      setAliases('');
      setFile(null);
      setAdding(false);
      ok('Emoji adicionado.');
      reload();
    } catch (e) {
      fail(e);
    }
  };
  const remove = async (e: any) => {
    const yes = await confirmDialog({ title: `Remover :${e.name}:?`, body: 'Nas mensagens antigas ele aparece como texto.', confirmLabel: 'Remover', danger: true });
    if (yes) api.post('emoji-custom.delete', { emojiId: e._id }).then(reload).catch(fail);
  };
  const newButton = (
    <button className="btn primary" onClick={() => setAdding(true)}>
      <Icon name="add" />
      Novo emoji
    </button>
  );
  return (
    <>
      <PageHead title="Emojis" count={emojis.length || undefined}>
        {emojis.length > 0 && newButton}
      </PageHead>
      {loading && !data ? (
        <SkeletonList n={4} />
      ) : !emojis.length ? (
        <Empty icon="emoji" title="Nenhum emoji personalizado" action={newButton}>
          Emojis do workspace, como o logo da empresa, para usar com :nome: nas mensagens e reações.
        </Empty>
      ) : (
        <div className="emoji-admin">
          {emojis.map((e: any) => (
            <div key={e._id} className="card emoji-card">
              <img src={`/emoji-custom/${e.name}?v=${emojiVersion}`} alt={e.name} />
              <code>:{e.name}:</code>
              {e.aliases.length > 0 && <span className="muted small">{e.aliases.join(', ')}</span>}
              <button className="btn small ghost danger" onClick={() => remove(e)}>
                Remover
              </button>
            </div>
          ))}
        </div>
      )}
      {adding && (
        <Modal
          title="Novo emoji"
          onClose={() => setAdding(false)}
          footer={
            <>
              <button className="btn" onClick={() => setAdding(false)}>
                Cancelar
              </button>
              <button className="btn primary" disabled={!name || !file} onClick={create}>
                Adicionar emoji
              </button>
            </>
          }
        >
          <div className="form">
            <Field label="Nome" hint={name ? `Use como :${name}:` : 'Letras minúsculas, números, _ + e -.'}>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_+-]/g, ''))} />
            </Field>
            <Field label="Apelidos" hint="Separados por vírgula.">
              <input value={aliases} onChange={(e) => setAliases(e.target.value)} />
            </Field>
            <Field label="Imagem" hint="PNG, GIF, JPEG ou WebP, de preferência quadrada.">
              <FileButton accept="image/png,image/gif,image/jpeg,image/webp" file={file} label="Escolher imagem" onChange={(f) => setFile(f[0] ?? null)} />
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}

export function AdminInvites() {
  const { data, loading, reload } = useAsync(() => api.get('listInvites'), []);
  const invites: any[] = data?.invites ?? [];
  const copy = (id: string) =>
    navigator.clipboard
      .writeText(`${location.origin}/invite/${id}`)
      .then(() => ok('Link copiado.'))
      .catch(fail);
  const revoke = async (i: any) => {
    const yes = await confirmDialog({ title: 'Revogar o convite?', body: `O link para #${i.roomName} para de funcionar.`, confirmLabel: 'Revogar', danger: true });
    if (yes) api.del(`removeInvite/${i._id}`).then(reload).catch(fail);
  };
  return (
    <>
      <PageHead title="Convites" count={invites.length || undefined} />
      {loading && !data ? (
        <SkeletonTable rows={4} cols={5} />
      ) : !invites.length ? (
        <Empty icon="panel-invite" title="Nenhum convite">
          Os links de convite criados nas salas (menu da sala › Convidar) aparecem aqui.
        </Empty>
      ) : (
        <TableWrap>
          <table className="table stack kv">
            <thead>
              <tr>
                <th>Sala</th>
                <th className="col-lg">Link</th>
                <th className="num">Usos</th>
                <th>Expira</th>
                <th className="col-xl">Criado</th>
                <th className="actions-col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {invites.map((i: any) => (
                <tr key={i._id}>
                  <td>
                    <RoomCell icon={<Icon name="room-channel" />} name={i.roomName} />
                  </td>
                  <td className="mono small ellipsis-cell col-lg" data-label="Link" title={`${location.origin}/invite/${i._id}`}>
                    {`${location.origin}/invite/${i._id}`}
                  </td>
                  <td className="num nowrap" data-label="Usos">
                    {i.uses}
                    {i.maxUses ? ` / ${i.maxUses}` : ''}
                  </td>
                  <td className="nowrap" data-label="Expira">
                    {i.expires ? formatDateTime(i.expires) : <span className="muted">Nunca</span>}
                  </td>
                  <td className="muted nowrap col-xl" data-label="Criado">
                    {formatDateTime(i.createdAt)}
                  </td>
                  <td className="actions-col">
                    <div className="row-actions">
                      <button className="btn small ghost" onClick={() => copy(i._id)}>
                        <Icon name="copy" />
                        Copiar link
                      </button>
                      <button className="btn small ghost danger" onClick={() => revoke(i)}>
                        <Icon name="delete" />
                        Revogar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {invites.length > 0 && <p className="table-foot muted small">{plural(invites.length, 'convite ativo', 'convites ativos')}.</p>}
    </>
  );
}

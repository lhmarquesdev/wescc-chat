import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../../lib/api';
import { formatDateTime, plural } from '../../lib/format';
import { customEmojiUrl } from '../../lib/emoji';
import { messageLink } from '../../lib/messageRules';
import { useStore } from '../../lib/store';
import { Icon } from '../../components/Icon';
import { Empty, Field, FileButton, Modal, Pager, SearchInput, SkeletonList, SkeletonTable, confirmDialog, useAsync, ThLabel } from '../../components/ui';
import { DeviceCell, NewDevicePill, PageHead, RoomCell, TableWrap, UserCell, deviceLabel, lastSeen } from './parts';
// Figurinhas: a figurinha denunciada e "Remover figurinha de todas as conversas".
import { ReportSticker } from './stickers';

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
      <PageHead title="Dispositivos" count={data && !filter ? data.total : undefined}>
        <SearchInput value={filter} onChange={(v) => (setFilter(v), setOffset(0))} placeholder="Filtrar por usuário ou IP" />
      </PageHead>
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
                <th>
                  <ThLabel>Usuário</ThLabel>
                </th>
                <th>
                  <ThLabel>Dispositivo</ThLabel>
                </th>
                <th className="col-xl">
                  <ThLabel>Login</ThLabel>
                </th>
                <th>
                  <ThLabel>Último uso</ThLabel>
                </th>
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
                    <DeviceCell device={s.device} tag={s.device?.newDevice && <NewDevicePill />} />
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
                <th>
                  <ThLabel>Usuário denunciado</ThLabel>
                </th>
                <th className="num">
                  <ThLabel>Denúncias</ThLabel>
                </th>
                <th>
                  <ThLabel>Última</ThLabel>
                </th>
                <th className="actions-col">
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.reports.map((r: any) => (
                <tr key={r.userId} className="clickable" onClick={() => setUser(r)}>
                  <td>
                    {/* Conta excluída depois da denúncia: sem nome de usuário (antes aparecia "@null"). */}
                    {r.username ? <UserCell username={r.username} name={r.name} /> : <RoomCell icon={<Icon name="disabled-user" />} name="Usuário excluído" sub="A conta não existe mais" />}
                  </td>
                  <td className="num" data-label="Denúncias">
                    <span className="pill err">{r.count}</span>
                  </td>
                  <td className="nowrap" data-label="Última">
                    {lastSeen(r.ts)}
                  </td>
                  <td className="actions-col">
                    {/* Botão de verdade: a linha abre pelo teclado (Tab + Enter) e pelo leitor de tela. */}
                    <div className="row-actions">
                      <button type="button" className="btn small ghost" onClick={(e) => (e.stopPropagation(), setUser(r))}>
                        <Icon name="show" />
                        Analisar
                      </button>
                    </div>
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

// Denúncias da mesma mensagem ficam juntas: as ações de cada item valem para a mensagem (ou para a denúncia da pessoa).
function groupReports(reports: any[]) {
  const groups: { key: string; first: any; reports: any[] }[] = [];
  const byKey = new Map<string, (typeof groups)[number]>();
  for (const r of reports) {
    const key = r.messageId ? `m:${r.messageId}` : `r:${r._id}`;
    const g = byKey.get(key);
    if (g) g.reports.push(r);
    else {
      const ng = { key, first: r, reports: [r] };
      byKey.set(key, ng);
      groups.push(ng);
    }
  }
  return groups;
}

function UserReports({ user, onClose }: { user: any; onClose: () => void }) {
  // Figurinhas: reload para atualizar a lista depois de remover uma figurinha de todas as conversas.
  const { data, loading, reload } = useAsync(() => api.get('moderation.userReports', { userId: user.userId }), [user.userId]);
  // Depois de agir num item (descartar, apagar, remover a figurinha), sem nenhuma denúncia pendente o modal fecha.
  const [acted, setActed] = useState(false);
  const [busy, setBusy] = useState(false);
  // "Abrir na conversa" só onde o moderador entra: numa DM ou grupo de outras pessoas o link dava em "Sala não encontrada".
  const subs = useStore((s) => s.subscriptions);
  useEffect(() => {
    if (acted && !loading && data && !data.reports.length) onClose();
  }, [acted, loading, data, onClose]);
  const who = user.username ? `@${user.username}` : 'usuário excluído';
  const run = async (call: () => Promise<unknown>, done: string, closeAfter = false) => {
    setBusy(true);
    try {
      await call();
      ok(done);
      if (closeAfter) return onClose();
      setActed(true);
      reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const dismissAll = async () => {
    const yes = await confirmDialog({
      title: `Descartar as denúncias contra ${who}?`,
      body: 'As mensagens continuam nas conversas e as denúncias saem da lista. Não dá para desfazer.',
      confirmLabel: 'Descartar denúncias',
    });
    if (yes) void run(() => api.post('moderation.dismissReports', { userId: user.userId }), 'Denúncias descartadas.', true);
  };
  const deleteMessages = async () => {
    const yes = await confirmDialog({
      title: 'Apagar as mensagens denunciadas?',
      body: `As mensagens de ${who} que foram denunciadas somem das conversas.`,
      confirmLabel: 'Apagar mensagens',
      danger: true,
    });
    if (yes) void run(() => api.post('moderation.user.deleteReportedMessages', { userId: user.userId }), 'Mensagens denunciadas apagadas.', true);
  };
  const deactivate = async () => {
    const yes = await confirmDialog({
      title: `Desativar @${user.username}?`,
      body: 'A pessoa não consegue entrar até ser reativada. As mensagens permanecem.',
      confirmLabel: 'Desativar',
      danger: true,
    });
    if (yes) void run(() => api.post('users.setActiveStatus', { userId: user.userId, activeStatus: false }), `@${user.username} foi desativado.`, true);
  };
  const dismissOne = (g: ReturnType<typeof groupReports>[number]) =>
    run(
      () => api.post('moderation.dismissReports', g.first.messageId ? { msgId: g.first.messageId } : { reportId: g.first._id }),
      g.reports.length > 1 ? 'Denúncias descartadas.' : 'Denúncia descartada.',
    );
  const deleteOne = async (r: any) => {
    const yes = await confirmDialog({
      title: 'Apagar esta mensagem?',
      body: 'A mensagem some da conversa para todos e as denúncias dela saem da lista.',
      confirmLabel: 'Apagar mensagem',
      danger: true,
    });
    if (yes) void run(() => api.post('moderation.user.deleteReportedMessages', { userId: user.userId, msgId: r.messageId }), 'Mensagem apagada.');
  };
  const groups = groupReports(data?.reports ?? []);
  return (
    <Modal
      wide
      className="report-modal"
      title={`Denúncias contra ${who}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn left" disabled={busy} onClick={dismissAll}>
            Descartar todas
          </button>
          <button className="btn danger" disabled={busy} onClick={deleteMessages}>
            <Icon name="delete" />
            Apagar mensagens denunciadas
          </button>
          {user.username && (
            <button className="btn danger" disabled={busy} onClick={deactivate}>
              <Icon name="disabled-user" />
              Desativar usuário
            </button>
          )}
        </>
      }
    >
      {loading && !data ? (
        <SkeletonList n={3} />
      ) : !groups.length ? (
        <Empty icon="report" title="Nenhuma denúncia pendente" />
      ) : (
        <ul className="report-list">
          {groups.map((g) => {
            const r = g.first;
            const reporters = [...new Set(g.reports.map((x: any) => x.reporter ?? 'usuário excluído'))];
            const canOpen = r.messageId && r.rid && r.roomType && !r.messageRemoved && (r.roomType === 'c' || !!subs[r.rid]);
            return (
              <li key={g.key}>
                <div className="report-meta">
                  <strong>{reporters.join(', ')}</strong> {reporters.length > 1 ? 'denunciaram' : 'denunciou'} {lastSeen(r.ts).toLowerCase()}
                  {r.roomName && (
                    <span className="muted">
                      {' '}
                      · <Icon name="room-channel" size={12} />
                      {r.roomName}
                    </span>
                  )}
                </div>
                {!r.messageId ? (
                  <div className="muted small">Denúncia da pessoa (sem mensagem).</div>
                ) : r.messageRemoved ? (
                  <blockquote className="muted">
                    <em>A mensagem já foi apagada</em>
                  </blockquote>
                ) : r.e2e ? (
                  <blockquote className="muted">
                    <em>Mensagem criptografada (a moderação não vê o conteúdo)</em>
                  </blockquote>
                ) : (
                  r.msg && <blockquote>{r.msg}</blockquote>
                )}
                {/* Figurinhas */}
                {r.sticker && <ReportSticker sticker={r.sticker} messageId={r.messageId} onDone={() => (setActed(true), reload())} />}
                {g.reports
                  .filter((x: any) => x.description)
                  .map((x: any) => (
                    <div key={x._id} className="muted small">
                      Motivo{g.reports.length > 1 ? ` (${x.reporter ?? 'usuário excluído'})` : ''}: {x.description}
                    </div>
                  ))}
                <div className="row-actions report-actions">
                  {canOpen && (
                    <Link className="btn small ghost" to={messageLink({ rid: r.rid, t: r.roomType, mid: r.messageId, tmid: r.tmid })}>
                      <Icon name="open-external" />
                      Abrir na conversa
                    </Link>
                  )}
                  <button type="button" className="btn small ghost" disabled={busy} onClick={() => void dismissOne(g)}>
                    <Icon name="check" />
                    Descartar
                  </button>
                  {r.messageId && !r.messageRemoved && (
                    <button type="button" className="btn small ghost danger" disabled={busy} onClick={() => void deleteOne(r)}>
                      <Icon name="delete" />
                      Apagar mensagem
                    </button>
                  )}
                </div>
              </li>
            );
          })}
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
    // Mesmo limite do servidor: o emoji é baixado por todo mundo a cada vez que aparece.
    if (file.size > 256 * 1024) return fail(new Error('A imagem passa de 256 KB. Use uma imagem menor (o emoji aparece pequeno).'));
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
    if (yes) api.post('emoji-custom.delete', { emojiId: e._id }).then(() => (ok('Emoji removido.'), reload())).catch(fail);
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
              <img src={customEmojiUrl(e)} alt={e.name} />
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
            <Field label="Apelidos" hint="Outros nomes para o mesmo emoji, separados por vírgula, com as mesmas letras do nome.">
              <input value={aliases} onChange={(e) => setAliases(e.target.value)} />
            </Field>
            <Field label="Imagem" hint="PNG, GIF, JPEG ou WebP de até 256 KB, de preferência quadrada.">
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
                <th>
                  <ThLabel>Sala</ThLabel>
                </th>
                <th className="col-lg">
                  <ThLabel>Link</ThLabel>
                </th>
                <th className="num">
                  <ThLabel>Usos</ThLabel>
                </th>
                <th>
                  <ThLabel>Expira</ThLabel>
                </th>
                <th className="col-xl">
                  <ThLabel>Criado</ThLabel>
                </th>
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

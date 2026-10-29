// Figurinhas: importar várias de uma vez (pacote do Wescc Chat, .wastickers ou imagens soltas): escolher, revisar,
// enviar uma por vez dentro do limite do servidor e resumir. Também guarda a lista de pacotes de destino do editor.
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_STICKER_NAME, nameFromFileName, STICKER_LIMITS, type StickerPack } from '@shared/stickers';
import { inflateRawStream, readStickerPack, readZip, ZIP_LIMITS, ZipError, type ZipEntry } from '@shared/zipRead';
import { ApiError } from '../../lib/api';
import { plural } from '../../lib/format';
import { normalizeForImport } from '../../lib/stickerImage';
import { createSticker, finishStickerImport, loadStickers, stickerAdmin, stickerErrorText, useStickerCaps, useStickers, type StickerCaps } from '../../lib/stickers';
import { Icon } from '../Icon';
import { useIsPhone } from '../overlay';
import { Field, FileButton, Modal, Spinner } from '../ui';
import { NewPackDialog } from './StickerMenuItems';
import './studio.css';

// ---------- Pacotes de destino (também usados pelo editor) ----------

export interface PackTargets {
  personal: StickerPack[]; // quando canCreate
  org: StickerPack[]; // quando canManage, com rascunhos
  autoPersonal: boolean; // posso criar e não tenho pacote: o servidor cria "Minhas figurinhas"
  ready: boolean;
  add(pack: StickerPack): void;
}

export function usePackTargets(caps: StickerCaps): PackTargets {
  const mine = useStickers((s) => s.mine);
  const [org, setOrg] = useState<StickerPack[] | null>(null);
  useEffect(() => {
    if (caps.canCreate) void loadStickers('mine').catch(() => undefined);
  }, [caps.canCreate]);
  useEffect(() => {
    if (!caps.canManage) return;
    let alive = true;
    // Rascunhos têm versão própria no servidor: vêm de orgWithDrafts, fora do cache do seletor.
    stickerAdmin
      .orgWithDrafts()
      .then((c) => alive && setOrg(c.packs))
      .catch(() => alive && setOrg(useStickers.getState().org?.packs ?? []));
    return () => {
      alive = false;
    };
  }, [caps.canManage]);
  const personal = caps.canCreate ? (mine?.packs ?? []) : [];
  return {
    personal,
    org: caps.canManage ? (org ?? []) : [],
    autoPersonal: caps.canCreate && personal.length === 0,
    ready: (!caps.canCreate || !!mine) && (!caps.canManage || org !== null),
    add: (p) => {
      if (p.scope === 'org') setOrg((cur) => (cur && !cur.some((x) => x._id === p._id) ? [...cur, p] : cur));
    },
  };
}

// O pacote pedido, se for um destino permitido; senão o primeiro pessoal, "Minhas figurinhas" ou o primeiro da organização.
export function defaultPackId(t: Pick<PackTargets, 'personal' | 'org' | 'autoPersonal'>, wanted?: string): string | null {
  if (wanted && [...t.personal, ...t.org].some((p) => p._id === wanted)) return wanted;
  if (t.personal[0]) return t.personal[0]._id;
  if (t.autoPersonal) return '';
  return t.org[0]?._id ?? null;
}

// ---------- Importação ----------

const ACCEPT = '.zip,.wastickers,image/png,image/jpeg,image/webp,image/gif';
const IMAGE_RE = /\.(png|apng|jpe?g|webp|gif)$/i;
const PACK_FILE = '__packfile';
const NEW_PACK = '__new';

// invalid: passou de um limite; error: o arquivo não abre (corrompido, ilegível); ignored: não é figurinha.
type Status = 'pending' | 'ready' | 'reduced' | 'invalid' | 'error' | 'ignored';

interface Row {
  key: number;
  name: string;
  emojis: string[];
  keywords: string[];
  source: { kind: 'entry'; entry: ZipEntry; poster?: ZipEntry } | { kind: 'file'; file: File } | null;
  status: Status;
  reason?: string;
  file?: Blob;
  poster?: Blob;
  phash?: string;
  thumb?: string;
  checked: boolean;
  sent?: 'ok' | 'fail';
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => (e instanceof ZipError ? e.message : stickerErrorText(e));
const sentence = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const isNetwork = (e: unknown) => e instanceof TypeError || (e instanceof ApiError && e.status === 0);

// "Tente novamente em {n}s." do limitador; sem número, 15 s (no máximo 60).
function retrySeconds(message: string): number {
  const n = Number(/Tente novamente em (\d+)\s*s/i.exec(message)?.[1]);
  return Number.isFinite(n) && n > 0 ? Math.min(60, n) : 15;
}

async function looksLikeZip(f: File): Promise<boolean> {
  if (/\.(zip|wastickers)$/i.test(f.name)) return true;
  const b = new Uint8Array(await f.slice(0, 4).arrayBuffer());
  return b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6);
}

export function ImportStickersModal({
  packId,
  scope,
  onClose,
  onDone,
}: {
  packId?: string;
  scope?: 'org' | 'personal';
  onClose(): void;
  onDone?(r: { ok: number; failed: number }): void;
}) {
  const caps = useStickerCaps();
  const phone = useIsPhone();
  const targets = usePackTargets(caps);
  const [step, setStep] = useState<'choose' | 'prepare' | 'review' | 'upload' | 'done'>('choose');
  const [rows, setRows] = useState<Row[]>([]);
  const [packFile, setPackFile] = useState<{ name: string; description: string } | null>(null);
  const [dest, setDest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prep, setPrep] = useState({ i: 0, n: 0 });
  const [up, setUp] = useState({ i: 0, n: 0, wait: 0 });
  const [over, setOver] = useState(false);
  const [newPack, setNewPack] = useState(false);
  const alive = useRef(true);
  const cancel = useRef(false);
  const finished = useRef(true);
  const finishScope = useRef<'org' | 'mine'>('mine');
  const urls = useRef<string[]>([]);
  const keySeq = useRef(0);

  useEffect(() => {
    alive.current = true;
    const list = urls.current;
    return () => {
      alive.current = false;
      cancel.current = true;
      for (const u of list) URL.revokeObjectURL(u);
    };
  }, []);

  // Só os destinos do escopo pedido (a administração importa para a organização; a conta, para os pessoais).
  const personal = scope === 'org' ? [] : targets.personal;
  const org = scope === 'personal' ? [] : targets.org;
  const autoPersonal = scope !== 'org' && targets.autoPersonal;
  const newScope: 'org' | 'personal' = scope ?? (caps.canCreate ? 'personal' : 'org');
  const destValue = dest ?? (packFile ? PACK_FILE : defaultPackId({ personal, org, autoPersonal }, packId));
  const destPack = [...personal, ...org].find((p) => p._id === destValue);
  const destScope: 'org' | 'personal' = destPack?.scope ?? (destValue === '' ? 'personal' : newScope);
  const max = destScope === 'org' ? caps.limits.orgMaxPerPack : caps.limits.maxPerPack;
  const room = Math.max(0, max - (destPack?.count ?? 0));
  const usable = rows.filter((r) => r.status === 'ready' || r.status === 'reduced');
  const selected = usable.filter((r) => r.checked);
  const sending = selected.slice(0, room);

  const finish = async () => {
    if (finished.current) return;
    finished.current = true;
    await finishStickerImport(finishScope.current).catch(() => undefined);
  };

  const close = () => {
    cancel.current = true;
    onClose();
  };

  const patch = (key: number, p: Partial<Row>) => setRows((cur) => cur.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const prepare = async (list: Row[]) => {
    const todo = list.filter((r) => r.source);
    let done = 0;
    for (const r of todo) {
      if (cancel.current || !alive.current) return;
      setPrep({ i: ++done, n: todo.length });
      const src = r.source!;
      let blob: Blob;
      let poster: Blob | undefined;
      try {
        if (src.kind === 'entry') {
          blob = new Blob([await src.entry.read()]);
          if (src.poster)
            poster = await src.poster.read().then(
              (b) => new Blob([b]),
              () => undefined,
            );
        } else blob = src.file;
      } catch (e) {
        patch(r.key, { status: 'error', reason: errText(e), checked: false });
        continue;
      }
      const res = await normalizeForImport(blob, r.name, caps, { poster });
      if (!alive.current) return;
      if (res.ok) {
        const thumb = URL.createObjectURL(res.poster ?? res.file);
        urls.current.push(thumb);
        patch(r.key, { status: res.reduced ? 'reduced' : 'ready', file: res.file, poster: res.poster, phash: res.phash, thumb, checked: true });
      } else patch(r.key, { status: res.ignored ? 'ignored' : res.broken ? 'error' : 'invalid', reason: res.reason, checked: false });
    }
    if (alive.current) setStep('review');
  };

  const choose = async (files: File[]) => {
    if (!files.length) return;
    setError(null);
    const list: Row[] = [];
    let pack: { name: string; description: string } | null = null;
    const row = (p: Omit<Row, 'key' | 'checked' | 'status'> & { status?: Status }): Row => ({ key: ++keySeq.current, checked: false, status: 'pending', ...p });
    try {
      for (const f of files) {
        if (await looksLikeZip(f)) {
          // readStickerPack também recusa com ZipError('too-many'): os dois no mesmo try.
          const entries = readZip(new Uint8Array(await f.arrayBuffer()), inflateRawStream);
          const p = await readStickerPack(entries, { fileName: f.name });
          if (!pack && p.name) pack = { name: p.name, description: p.description };
          for (const it of p.items) list.push(row({ name: it.name, emojis: it.emojis, keywords: it.keywords, source: { kind: 'entry', entry: it.entry, poster: it.poster } }));
          for (const ig of p.ignored) list.push(row({ name: ig.name, emojis: [], keywords: [], source: null, status: 'ignored', reason: ig.reason }));
        } else if (IMAGE_RE.test(f.name) || f.type.startsWith('image/')) {
          list.push(row({ name: nameFromFileName(f.name), emojis: [], keywords: [], source: { kind: 'file', file: f } }));
        } else list.push(row({ name: f.name, emojis: [], keywords: [], source: null, status: 'ignored', reason: 'formato não suportado' }));
      }
      if (list.filter((r) => r.source).length > ZIP_LIMITS.maxEntries) throw new ZipError('too-many');
    } catch (e) {
      setError(errText(e));
      return;
    }
    setRows(list);
    setPackFile(pack);
    setDest(null);
    setPrep({ i: 0, n: list.filter((r) => r.source).length });
    setStep('prepare');
    cancel.current = false;
    await prepare(list);
  };

  const upload = async (list: Row[]) => {
    if (!list.length) return;
    setStep('upload');
    setError(null);
    cancel.current = false;
    let target = destValue ?? '';
    try {
      if (target === PACK_FILE && packFile) {
        const p = await stickerAdmin.createPack({
          scope: newScope,
          name: packFile.name,
          description: newScope === 'org' && packFile.description ? packFile.description : undefined,
        });
        targets.add(p);
        target = p._id;
        if (alive.current) {
          setDest(p._id);
          setPackFile(null);
        }
      }
    } catch (e) {
      if (alive.current) {
        setError(errText(e));
        setStep('review');
      }
      return;
    }
    // O escopo de import.done: "mine" para pacotes pessoais (o servidor não aceita "personal").
    finishScope.current = destScope === 'org' ? 'org' : 'mine';
    finished.current = false;
    useStickers.setState({ importing: true });
    let lastStart = 0;
    try {
      for (let i = 0; i < list.length; i++) {
        if (cancel.current) break;
        const r = list[i];
        if (alive.current) setUp({ i: i + 1, n: list.length, wait: 0 });
        let retried = false;
        for (;;) {
          const gap = 1000 / STICKER_LIMITS.importPerSecond - (performance.now() - lastStart);
          if (gap > 0) await sleep(gap);
          lastStart = performance.now();
          try {
            await createSticker(
              {
                file: r.file!,
                poster: r.poster,
                packId: target || undefined,
                name: r.name.trim() || DEFAULT_STICKER_NAME,
                emojis: r.emojis,
                keywords: r.keywords,
                phash: r.phash,
                batch: true,
              },
              { reload: false },
            );
            patch(r.key, { sent: 'ok', error: undefined });
            break;
          } catch (e) {
            // 429 é pausa, nunca falha: espera o que o servidor pediu e tenta a mesma de novo.
            if (e instanceof ApiError && e.status === 429) {
              for (let left = retrySeconds(e.message); left > 0 && !cancel.current; left--) {
                if (alive.current) setUp((u) => ({ ...u, wait: left }));
                await sleep(1000);
              }
              if (alive.current) setUp((u) => ({ ...u, wait: 0 }));
              if (cancel.current) break;
              continue;
            }
            if (!retried && isNetwork(e)) {
              retried = true;
              await sleep(2000);
              continue;
            }
            patch(r.key, { sent: 'fail', error: stickerErrorText(e) });
            break;
          }
        }
      }
    } finally {
      await finish();
      if (alive.current) setStep('done');
    }
  };

  const okCount = rows.filter((r) => r.sent === 'ok').length;
  const failed = rows.filter((r) => r.sent === 'fail');

  const footer =
    step === 'review' ? (
      <>
        <button type="button" className="btn ghost" onClick={close}>
          Cancelar
        </button>
        <button type="button" className="btn primary" disabled={!sending.length || destValue === null} onClick={() => void upload(sending)}>
          Importar {sending.length}
        </button>
      </>
    ) : step === 'done' ? (
      <>
        {failed.length > 0 && (
          <button type="button" className="btn" onClick={() => void upload(failed)}>
            Tentar de novo as que falharam
          </button>
        )}
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            onDone?.({ ok: okCount, failed: failed.length });
            onClose();
          }}
        >
          Concluir
        </button>
      </>
    ) : (
      <button type="button" className="btn ghost" onClick={step === 'upload' ? () => (cancel.current = true) : close}>
        Cancelar
      </button>
    );

  const pill = (r: Row) =>
    r.status === 'ready' ? (
      <span className="pill ok">Pronta</span>
    ) : r.status === 'reduced' ? (
      <span className="pill warn">Será reduzida</span>
    ) : r.status === 'invalid' ? (
      <span className="pill err">Fora dos limites</span>
    ) : r.status === 'error' ? (
      <span className="pill err">Com erro</span>
    ) : r.status === 'ignored' ? (
      <span className="pill">Ignorada</span>
    ) : (
      <span className="pill">…</span>
    );

  return (
    <>
      <Modal size="lg" variant={phone ? 'fullscreen' : undefined} title="Importar figurinhas" onClose={close} className="stk-modal stk-import" footer={footer}>
        {step === 'choose' && (
          <div className="stk-pick">
            <div
              className={over ? 'stk-drop small over' : 'stk-drop small'}
              onDragEnter={(e) => {
                if ([...e.dataTransfer.types].includes('Files')) {
                  e.preventDefault();
                  setOver(true);
                }
              }}
              onDragOver={(e) => {
                if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                void choose([...e.dataTransfer.files]);
              }}
            >
              <span className="stk-drop-icon">
                <Icon name="sticker-import" size={32} />
              </span>
              <p className="stk-drop-title">Arraste um arquivo .zip ou .wastickers, ou várias imagens</p>
              <span className="stk-drop-or">ou</span>
              <FileButton label="Escolher arquivos" multiple accept={ACCEPT} onChange={(files) => void choose(files)} />
            </div>
            <p className="stk-hint">Aceita pacotes do Wescc Chat, pacotes .wastickers (de apps de figurinhas para WhatsApp) e imagens PNG, JPEG, WebP ou GIF.</p>
          </div>
        )}
        {step === 'prepare' && (
          <div className="stk-busy" aria-live="polite">
            <Spinner />
            <span>
              Preparando {prep.i} de {prep.n}…
            </span>
          </div>
        )}
        {step === 'review' && (
          <div className="stk-review">
            <Field label="Pacote de destino">
              <select value={destValue ?? ''} onChange={(e) => (e.target.value === NEW_PACK ? setNewPack(true) : setDest(e.target.value))}>
                {destValue === null && (
                  <option value="" disabled>
                    Escolha um pacote
                  </option>
                )}
                {packFile && <option value={PACK_FILE}>Novo pacote: {packFile.name}</option>}
                {personal.map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.name}
                  </option>
                ))}
                {autoPersonal && <option value="">Minhas figurinhas</option>}
                {org.length > 0 && (
                  <optgroup label="Organização">
                    {org.map((p) => (
                      <option key={p._id} value={p._id}>
                        {p.status === 'draft' ? `${p.name} (rascunho)` : p.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value={NEW_PACK}>Novo pacote…</option>
              </select>
            </Field>
            <p className="stk-count">
              {selected.length} de {usable.length} selecionadas
            </p>
            {selected.length > room && (
              <div className="callout warn">
                <Icon name="warning" />
                <span>O pacote comporta mais {room} figurinhas; as demais ficam de fora.</span>
              </div>
            )}
            <ul className="stk-import-list">
              {rows.map((r) => {
                const can = r.status === 'ready' || r.status === 'reduced';
                return (
                  <li key={r.key} data-off={can ? undefined : ''}>
                    <input type="checkbox" checked={r.checked} disabled={!can} aria-label={r.name} onChange={(e) => patch(r.key, { checked: e.target.checked })} />
                    <span className="stk-thumb">{r.thumb ? <img src={r.thumb} alt="" /> : <Icon name="sticker" size={16} />}</span>
                    {can ? (
                      <input
                        className="stk-import-name"
                        value={r.name}
                        maxLength={STICKER_LIMITS.nameMax}
                        aria-label="Nome"
                        onChange={(e) => patch(r.key, { name: e.target.value })}
                      />
                    ) : (
                      // O motivo vai embaixo do nome: no pill ele quebrava em duas linhas.
                      <span className="stk-import-text">
                        <span className="stk-import-name muted" title={r.name}>
                          {r.name}
                        </span>
                        {r.reason && <span className="stk-import-reason">{sentence(r.reason)}</span>}
                      </span>
                    )}
                    {pill(r)}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {step === 'upload' && (
          <div className="stk-upload" aria-live="polite">
            <div className="stk-progress" role="progressbar" aria-valuemin={0} aria-valuemax={up.n} aria-valuenow={up.i}>
              <span style={{ width: `${up.n ? Math.round(((up.i - 1) / up.n) * 100) : 0}%` }} />
            </div>
            <p>{up.wait ? `Aguardando o limite do servidor… ${up.wait} s` : `Importando ${up.i} de ${up.n}…`}</p>
          </div>
        )}
        {step === 'done' && (
          <div className="stk-summary" aria-live="polite">
            <p>
              {plural(okCount, 'figurinha importada', 'figurinhas importadas')}.{failed.length > 0 && ` ${failed.length} com erro.`}
            </p>
            {failed.length > 0 && (
              <details>
                <summary>{plural(failed.length, 'figurinha com erro', 'figurinhas com erro')}</summary>
                <ul>
                  {failed.map((r) => (
                    <li key={r.key}>
                      <strong>{r.name}</strong>: {r.error}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        {error && (
          <div className="callout warn stk-error" role="alert">
            <Icon name="error" />
            <span>{error}</span>
          </div>
        )}
      </Modal>
      {newPack && (
        <NewPackDialog
          scope={newScope}
          onClose={() => setNewPack(false)}
          onCreated={(p) => {
            targets.add(p);
            setDest(p._id);
            setNewPack(false);
          }}
        />
      )}
    </>
  );
}

export default ImportStickersModal;

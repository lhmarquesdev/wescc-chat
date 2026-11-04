// Arquivo de conversa criptografada: baixa o conteúdo cifrado, decifra no navegador e mostra pelo endereço blob: que
// este código criou (nunca um endereço que veio na mensagem). Imagens até 20 MB decifram quando aparecem na tela;
// áudio, vídeo e arquivos maiores, com um toque.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { E2EFileRef, Message } from '@shared/index';
import { E2E_AUTO_DECRYPT_MAX, E2E_FILE_NAME, safeBlobType } from '@shared/e2e';
import { formatVoiceDuration } from '@shared/stickers';
import { getCredentials } from '../../lib/api';
import { decryptFile } from '../../lib/e2e/crypto';
import { formatBytes } from '../../lib/format';
import { Icon } from '../Icon';
import { FileTile, ImageView } from '../MessageItem';
import { useIsPhone } from '../overlay';
import { VideoMessage } from '../VideoMessage';
import { VoicePlayer } from '../VoicePlayer';

type State = { st: 'idle' | 'loading' | 'error' | 'gone' } | { st: 'ready'; url: string };

async function fetchAndDecrypt(m: Message, fileId: string, ref: E2EFileRef): Promise<Blob> {
  const c = getCredentials();
  const res = await fetch(`/file-upload/${encodeURIComponent(fileId)}/${E2E_FILE_NAME}`, {
    headers: c ? { 'X-User-Id': c.userId, 'X-Auth-Token': c.authToken } : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 404) throw new Error('gone');
  if (!res.ok) throw new Error('fetch');
  const plain = await decryptFile(await res.arrayBuffer(), ref, m.rid, m._id);
  return new Blob([plain], { type: safeBlobType(ref.type) });
}

function kindOf(ref: E2EFileRef): 'image' | 'audio' | 'video' | 'file' {
  const t = safeBlobType(ref.type);
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('video/')) return 'video';
  return 'file';
}

export function E2eFile({ m, file }: { m: Message; file: E2EFileRef }) {
  const fileId = m.files?.[0]?._id ?? m.file?._id ?? '';
  const kind = kindOf(file);
  const auto = kind === 'image' && file.size <= E2E_AUTO_DECRYPT_MAX;
  const phone = useIsPhone();
  const [state, setState] = useState<State>({ st: 'idle' });
  const box = useRef<HTMLDivElement>(null);
  const urlRef = useRef<string | null>(null);
  const saveAfter = useRef(false);
  const link = useRef<HTMLAnchorElement>(null);

  const load = useCallback(async () => {
    if (!fileId) return setState({ st: 'gone' });
    setState({ st: 'loading' });
    try {
      const blob = await fetchAndDecrypt(m, fileId, file);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = URL.createObjectURL(blob);
      setState({ st: 'ready', url: urlRef.current });
    } catch (e) {
      setState({ st: (e as Error).message === 'gone' ? 'gone' : 'error' });
    }
  }, [fileId, file, m]);

  // Imagem: decifra quando aparece na tela.
  useEffect(() => {
    if (!auto || state.st !== 'idle' || !box.current) return;
    const el = box.current;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          void load();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [auto, state.st, load]);

  // Arquivo comum: depois de decifrar no toque, baixa com o nome real.
  useEffect(() => {
    if (state.st === 'ready' && saveAfter.current) {
      saveAfter.current = false;
      link.current?.click();
    }
  }, [state]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const meta = [file.name.includes('.') ? file.name.split('.').pop()!.toUpperCase() : '', formatBytes(file.size)].filter(Boolean).join(' · ');
  const tapText = phone ? 'Toque para abrir' : 'Clique para abrir';

  if (state.st === 'gone')
    return (
      <div className="att e2e-file-note" ref={box}>
        <Icon name="attach" size={14} />
        <span>Arquivo removido.</span>
      </div>
    );
  if (state.st === 'error')
    return (
      <div className="att e2e-file-note" ref={box}>
        <Icon name="e2e-warning" size={14} />
        <span>Não foi possível decifrar o arquivo.</span>
        <button type="button" className="link" onClick={() => void load()}>
          Tentar de novo
        </button>
      </div>
    );

  if (kind === 'image') {
    if (state.st === 'ready')
      return (
        <div className="att att-media">
          <ImageView src={state.url} title={file.name} download={state.url} blobName={file.name} m={m} />
        </div>
      );
    const ratio = file.width && file.height ? `${file.width} / ${file.height}` : undefined;
    return (
      <div className="att att-media" ref={box}>
        <button
          type="button"
          className="e2e-image-wait"
          style={ratio ? { aspectRatio: ratio, width: Math.min(360, file.width ?? 360) } : undefined}
          disabled={state.st === 'loading'}
          onClick={() => void load()}
          aria-label={`Abrir imagem criptografada ${file.name}`}
        >
          <Icon name={state.st === 'loading' ? 'e2e-waiting' : 'encrypted'} size={18} />
          <span>{state.st === 'loading' ? 'Decifrando…' : auto ? 'Imagem criptografada' : `${tapText} · ${formatBytes(file.size)}`}</span>
        </button>
      </div>
    );
  }

  if (kind === 'audio' && state.st === 'ready')
    return (
      <div className="att att-voice">
        <VoicePlayer src={state.url} duration={file.duration} waveform={file.waveform} title={file.name} voice={!!file.voice} />
      </div>
    );
  if (kind === 'video' && state.st === 'ready')
    return file.video ? (
      <VideoMessage src={state.url} duration={file.duration} />
    ) : (
      <video className="att-video" src={state.url} controls preload="metadata" />
    );

  const label = file.voice ? 'Mensagem de voz' : file.video ? 'Mensagem de vídeo' : file.name;
  const ready = state.st === 'ready' ? state.url : null;
  return (
    <div className="att" ref={box}>
      {/* Toque: decifra; pronto, o mesmo cartão baixa com o nome real. */}
      <a
        ref={link}
        className="att-file e2e-file"
        href={ready ?? '#'}
        download={ready ? file.name : undefined}
        aria-busy={state.st === 'loading' || undefined}
        title={ready ? `Baixar ${file.name}` : `Abrir ${label}`}
        onClick={(e) => {
          if (ready) return;
          e.preventDefault();
          if (state.st === 'loading') return;
          saveAfter.current = kind === 'file';
          void load();
        }}
      >
        <FileTile name={file.name} mime={file.type} />
        <span className="att-file-meta">
          <strong className="att-file-name">{label}</strong>
          <span className="att-file-size">
            {state.st === 'loading' ? 'Decifrando…' : kind === 'file' ? meta : `${file.duration ? `${formatVoiceDuration(file.duration)} · ` : ''}${tapText}`}
          </span>
        </span>
        <span className="att-file-dl" aria-hidden="true">
          <Icon name={kind === 'file' ? 'download' : 'encrypted'} size={16} />
        </span>
      </a>
    </div>
  );
}

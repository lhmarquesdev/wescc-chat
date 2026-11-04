// Criptografia de ponta a ponta (opcional, E2E_Enable): formatos, limites e regras puras que o servidor e a web usam
// iguais. O servidor só confere o formato do que recebe; cifrar e decifrar acontece no navegador (web/src/lib/e2e).
import { ENCRYPTED_PLACEHOLDER } from './dataExport';
import { MENTION_RE } from './messages';

export const E2E_VERSION = 1;
export const E2E_PREVIEW = ENCRYPTED_PLACEHOLDER; // 'Mensagem criptografada'
export const E2E_FILE_NAME = 'arquivo-criptografado';
export const E2E_FILE_TYPE = 'application/octet-stream';
export const E2E_KEY_ID = /^[A-Za-z0-9_-]{16}$/;
export const E2E_WRAPPED = /^[A-Za-z0-9_-]{342}$/; // RSA-2048 → 256 bytes → 342 base64url
export const E2E_IV = /^[A-Za-z0-9_-]{16}$/; // 12 bytes
export const E2E_MESSAGE_ID = /^[A-Za-z0-9]{10,24}$/;
export const E2E_BATCH = 200; // chaves por chamada
export const E2E_PBKDF2_ITER = 600_000;
export const E2E_MIN_OWN_PASSWORD = 12;
export const E2E_MENTIONS_MAX = 50;
export const E2E_QUOTE_MAX = 300;
// Imagens até este tamanho decifram sozinhas quando aparecem na tela; maiores, e áudio e vídeo, com um toque.
export const E2E_AUTO_DECRYPT_MAX = 20 * 1024 * 1024;

export interface E2EEnvelope {
  v: 1;
  kid: string; // geração da chave da sala
  iv: string; // 16 caracteres (12 bytes)
  ct: string; // conteúdo cifrado (E2EContent em JSON), base64url
  by: string; // quem cifrou (vai no AAD)
}

export interface E2EFileRef {
  name: string; // os dados reais do arquivo, só dentro da cifra
  type: string;
  size: number;
  key: string; // AES-GCM do arquivo (base64url)
  iv: string;
  voice?: boolean;
  video?: boolean;
  duration?: number;
  waveform?: number[];
  width?: number;
  height?: number;
}

export interface E2EContent {
  msg: string; // texto (a legenda, no caso de arquivo)
  file?: E2EFileRef; // um arquivo por mensagem, como o upload de hoje
  quote?: { mid: string; author: string; ts: string; text: string }; // text ≤ 300
}

export const e2eAad = (rid: string, mid: string, by: string) => `wescc.e2e.v1|${rid}|${mid}|${by}`;
export const e2eFileAad = (rid: string, mid: string) => `wescc.e2e.file.v1|${rid}|${mid}`;

// Maior ct aceito: texto no limite em UTF-8 (até 4 bytes por caractere) + 16 KB de metadados + a tag, em base64url.
export const e2eMaxCiphertext = (maxChars: number) => Math.ceil(((Math.max(0, maxChars) * 4 + 16384 + 16) * 4) / 3);

const B64U = /^[A-Za-z0-9_-]+$/;
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

// Exatamente {v, kid, iv, ct, by}: qualquer campo a mais é recusado (o servidor guarda o envelope como veio).
export function isEnvelope(x: unknown, maxCt: number): x is E2EEnvelope {
  if (!isObj(x)) return false;
  const keys = Object.keys(x).sort().join(',');
  if (keys !== 'by,ct,iv,kid,v') return false;
  return (
    x.v === 1 &&
    typeof x.kid === 'string' &&
    E2E_KEY_ID.test(x.kid) &&
    typeof x.iv === 'string' &&
    E2E_IV.test(x.iv) &&
    typeof x.ct === 'string' &&
    x.ct.length >= 24 &&
    x.ct.length <= maxCt &&
    B64U.test(x.ct) &&
    typeof x.by === 'string' &&
    x.by.length >= 1 &&
    x.by.length <= 40
  );
}

// JWK RSA público → JSON canônico {"alg":"RSA-OAEP-256","e":"AQAB","kty":"RSA","n":"<342>"}; null se não for isso.
// Uma chave com partes privadas (d, p, q…) nunca passa.
export function canonicalPublicKey(text: string): string | null {
  let j: unknown;
  try {
    j = typeof text === 'string' && text.length <= 4000 ? JSON.parse(text) : null;
  } catch {
    return null;
  }
  if (!isObj(j)) return null;
  if (j.kty !== 'RSA' || j.e !== 'AQAB' || typeof j.n !== 'string' || !/^[A-Za-z0-9_-]{342}$/.test(j.n)) return null;
  if (j.alg !== undefined && j.alg !== 'RSA-OAEP-256') return null;
  if (['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].some((k) => k in j)) return null;
  return JSON.stringify({ alg: 'RSA-OAEP-256', e: 'AQAB', kty: 'RSA', n: j.n });
}

export interface E2EPrivateKeyBlob {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iter: number;
  salt: string; // 16 bytes
  iv: string; // 12 bytes
  ct: string; // PKCS#8 cifrado com AES-GCM
}

// {"v":1,"kdf":"PBKDF2-SHA256","iter":100000..10000000,"salt":22 chars,"iv":16 chars,"ct":base64url 1000..3800}
export function parsePrivateKeyBlob(text: string): E2EPrivateKeyBlob | null {
  let j: unknown;
  try {
    j = typeof text === 'string' && text.length <= 4000 ? JSON.parse(text) : null;
  } catch {
    return null;
  }
  if (!isObj(j) || Object.keys(j).sort().join(',') !== 'ct,iter,iv,kdf,salt,v') return null;
  const ok =
    j.v === 1 &&
    j.kdf === 'PBKDF2-SHA256' &&
    Number.isInteger(j.iter) &&
    (j.iter as number) >= 100_000 &&
    (j.iter as number) <= 10_000_000 &&
    typeof j.salt === 'string' &&
    /^[A-Za-z0-9_-]{22}$/.test(j.salt) &&
    typeof j.iv === 'string' &&
    E2E_IV.test(j.iv) &&
    typeof j.ct === 'string' &&
    j.ct.length >= 1000 &&
    j.ct.length <= 3800 &&
    B64U.test(j.ct);
  return ok ? (j as unknown as E2EPrivateKeyBlob) : null;
}

export const isPrivateKeyBlob = (text: string) => parsePrivateKeyBlob(text) !== null;

// ---------- Senha da criptografia ----------

// Senha gerada: 25 símbolos Crockford (0-9 e A-Z sem I, L, O e U), mostrada em 5 grupos.
export const PASSPHRASE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function formatPassphrase(raw25: string): string {
  return (raw25.match(/.{1,5}/g) ?? []).join('-');
}

// Se, sem espaços e hífens, sobram 25 letras ou números (a senha gerada, digitada de qualquer jeito): maiúsculas, O→0 e
// I/L→1. Senão (senha própria): só normalize('NFC'), para o mesmo texto dar a mesma chave em qualquer teclado.
export function normalizePassphrase(s: string): string {
  const compact = s.replace(/[\s-]+/g, '');
  if (/^[0-9A-Za-z]{25}$/.test(compact)) return compact.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
  return s.normalize('NFC');
}

// ---------- Comandos que só publicam texto ----------

// A sala criptografada monta o texto no navegador e envia cifrado. O servidor usa os mesmos textos
// (server/src/services/commands.ts), então /shrug sai igual com ou sem criptografia.
const SAY: Record<string, string> = {
  shrug: '¯\\\\_(ツ)_/¯',
  tableflip: '(╯°□°）╯︵ ┻━┻',
  unflip: '┬─┬ ノ( ゜-゜ノ)',
  lennyface: '( ͡° ͜ʖ ͡°)',
};
export const LOCAL_TEXT_COMMANDS = ['me', 'gimme', ...Object.keys(SAY)];

export function localCommandText(command: string, args: string): string | null {
  if (command === 'me') return `_${args}_`;
  if (command === 'gimme') return `༼ つ ◕_◕ ༽つ ${args}`.trim();
  const text = SAY[command];
  if (text === undefined) return null;
  return args ? `${args} ${text}` : text;
}

// ---------- Menções ----------

// Quem é mencionado continua visível para o servidor (selos e notificações): a web manda os @usuário do texto, e o
// servidor monta as menções com as mesmas regras de @all e @here.
export function mentionNames(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    const n = m[1].replace(/\.+$/, '');
    if (n) out.add(n);
  }
  return [...out].slice(0, E2E_MENTIONS_MAX);
}

// ---------- Arquivos ----------

// Tipo do Blob decifrado: só imagem raster, áudio e vídeo abrem na página; o resto vira download.
export function safeBlobType(type: string): string {
  const t = String(type ?? '').toLowerCase();
  if (/^image\/(png|jpeg|gif|webp)$/.test(t)) return t;
  if (/^audio\/(webm|ogg|mpeg|mp4|wav)$/.test(t)) return t;
  if (/^video\/(mp4|webm)$/.test(t)) return t;
  return E2E_FILE_TYPE;
}

// ---------- Ligar e desligar numa conversa ----------

export const E2E_TEXT = {
  disabled: 'A criptografia de ponta a ponta está desligada nas configurações do chat.',
  roomType: 'Só conversas diretas e grupos privados podem ser criptografados.',
  public: 'Desligue a criptografia antes de tornar o grupo público.',
  noKeys: 'Configure a sua senha da criptografia antes.',
  userNoKeys: 'Esta pessoa não configurou a criptografia.',
  invalidKey: 'Chave de criptografia inválida.',
  keysExist: 'Você já tem chaves da criptografia. Para trocar, redefina a criptografia.',
  notEncrypted: 'A criptografia não está ligada nesta conversa.',
  notMember: 'Só quem participa da conversa recebe a chave.',
  noKey: 'Você ainda não tem a chave desta conversa.',
  keyExists: 'Esta conversa já tem uma chave. Atualize a página.',
  keyOutdated: 'A chave desta conversa mudou. Tente de novo.',
  required: 'Esta conversa é criptografada: o servidor não pode publicar texto aqui.',
  sticker: 'Figurinhas não podem ser enviadas em conversas criptografadas.',
  invalid: 'Mensagem criptografada inválida.',
  plainField: 'Em conversa criptografada, texto, citações e anexos vão cifrados.',
  id: 'Já existe uma mensagem com este código.',
  reply: 'Em discussão criptografada, a primeira mensagem vai depois de criar.',
  batch: 'Envie no máximo 200 chaves por vez.',
  toggleForbidden: 'Sem permissão para ligar ou desligar a criptografia desta conversa.',
  rotateForbidden: 'Só quem pode ligar a criptografia gera uma chave nova.',
  archived: 'A sala está arquivada.',
} as const;

export type E2EToggle = { ok: true } | { ok: false; status: 400 | 403; code: string; text: string };

// Ordem (servidor e tela): tipo da sala, arquivada, configuração do chat (só para ligar), quem pode, chaves (só para
// ligar). Desligar nunca precisa da configuração nem das chaves.
export function e2eToggleVerdict(i: {
  t: string;
  archived: boolean;
  on: boolean;
  settingOn: boolean;
  isDm: boolean;
  isParticipant: boolean;
  canToggle: boolean;
  hasKeys: boolean;
}): E2EToggle {
  if (i.t !== 'd' && i.t !== 'p') return { ok: false, status: 400, code: 'error-e2e-room-type', text: E2E_TEXT.roomType };
  if (i.archived) return { ok: false, status: 400, code: 'error-room-archived', text: E2E_TEXT.archived };
  if (i.on && !i.settingOn) return { ok: false, status: 400, code: 'error-e2e-disabled', text: E2E_TEXT.disabled };
  if (i.isDm ? !i.isParticipant : !i.canToggle) return { ok: false, status: 403, code: 'error-not-allowed', text: E2E_TEXT.toggleForbidden };
  if (i.on && !i.hasKeys) return { ok: false, status: 400, code: 'error-e2e-no-keys', text: E2E_TEXT.noKeys };
  return { ok: true };
}

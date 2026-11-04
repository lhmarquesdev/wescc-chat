// Criptografia de ponta a ponta: as contas, sem estado e sem tela. Só Web Crypto (globalThis.crypto.subtle), para
// rodar igual no navegador e nos testes do servidor (Node 22).
//
// - Cada pessoa tem um par RSA-OAEP 2048 (SHA-256). A chave privada sai do navegador só cifrada com a senha da
//   criptografia (PBKDF2-SHA256 → AES-GCM 256); o servidor nunca vê a senha.
// - Cada conversa tem uma chave AES-GCM 256, entregue a cada participante cifrada com a chave pública dele.
// - A mensagem vai cifrada com a chave da conversa; o AAD amarra a cifra à sala, à mensagem e a quem cifrou.
import {
  canonicalPublicKey,
  e2eAad,
  e2eFileAad,
  E2E_PBKDF2_ITER,
  E2E_VERSION,
  formatPassphrase,
  normalizePassphrase,
  parsePrivateKeyBlob,
  PASSPHRASE_ALPHABET,
  type E2EContent,
  type E2EEnvelope,
  type E2EFileRef,
} from '@shared/e2e';

export type E2eErrorCode = 'wrong-password' | 'decrypt-failed' | 'invalid-key' | 'unsupported';

export class E2eError extends Error {
  constructor(
    readonly code: E2eErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'E2eError';
  }
}

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new E2eError('unsupported', 'Este navegador não tem criptografia (Web Crypto).');
  return s;
};
const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const utf8 = (s: string) => new TextEncoder().encode(s);
const RSA = { name: 'RSA-OAEP', hash: 'SHA-256' } as const;

// ---------- base64url (sem "=") ----------

export function b64u(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256(data: Uint8Array<ArrayBuffer> | ArrayBuffer) {
  return new Uint8Array(await subtle().digest('SHA-256', data));
}

// ---------- Senha da criptografia ----------

// 25 símbolos (32 possíveis cada: 125 bits), mostrados em 5 grupos.
export function generatePassphrase(): string {
  const bytes = random(25);
  let raw = '';
  for (const b of bytes) raw += PASSPHRASE_ALPHABET[b & 31];
  return formatPassphrase(raw);
}

async function passwordKey(pass: string, salt: Uint8Array<ArrayBuffer>, iter: number) {
  const base = await subtle().importKey('raw', utf8(normalizePassphrase(pass)), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// ---------- Par de chaves de cada pessoa ----------

// publicKey: JWK no formato canônico (o mesmo texto que o servidor guarda e usa na impressão digital).
export async function generateUserKeys(): Promise<{ publicKey: string; pkcs8: ArrayBuffer }> {
  const pair = await subtle().generateKey({ ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']);
  const jwk = await subtle().exportKey('jwk', pair.publicKey);
  const publicKey = canonicalPublicKey(JSON.stringify({ kty: jwk.kty, e: jwk.e, n: jwk.n, alg: 'RSA-OAEP-256' }));
  if (!publicKey) throw new E2eError('invalid-key');
  return { publicKey, pkcs8: await subtle().exportKey('pkcs8', pair.privateKey) };
}

// A chave privada (PKCS#8) cifrada com a senha: o texto que vai para o servidor.
export async function encryptPrivateKey(pkcs8: ArrayBuffer, pass: string, iter = E2E_PBKDF2_ITER): Promise<string> {
  const salt = random(16);
  const iv = random(12);
  const key = await passwordKey(pass, salt, iter);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, pkcs8);
  return JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA256', iter, salt: b64u(salt), iv: b64u(iv), ct: b64u(ct) });
}

// O PKCS#8 aberto (só para trocar a senha: a chave guardada no navegador não é exportável).
export async function exportPkcs8WithPassword(blob: string, pass: string): Promise<ArrayBuffer> {
  const b = parsePrivateKeyBlob(blob);
  if (!b) throw new E2eError('invalid-key');
  try {
    const key = await passwordKey(pass, unb64u(b.salt), b.iter);
    return await subtle().decrypt({ name: 'AES-GCM', iv: unb64u(b.iv) }, key, unb64u(b.ct));
  } catch {
    throw new E2eError('wrong-password', 'Senha incorreta.');
  }
}

// A chave privada pronta para uso, não exportável (é assim que fica guardada no navegador).
export async function importPrivateKey(pkcs8: ArrayBuffer): Promise<CryptoKey> {
  try {
    return await subtle().importKey('pkcs8', pkcs8, RSA, false, ['unwrapKey', 'decrypt']);
  } catch {
    throw new E2eError('invalid-key');
  }
}

export async function decryptPrivateKey(blob: string, pass: string): Promise<CryptoKey> {
  return importPrivateKey(await exportPkcs8WithPassword(blob, pass));
}

export async function importPublicKey(text: string): Promise<CryptoKey> {
  const canon = canonicalPublicKey(text);
  if (!canon) throw new E2eError('invalid-key');
  const j = JSON.parse(canon);
  return subtle().importKey('jwk', { kty: j.kty, e: j.e, n: j.n, alg: j.alg, ext: true }, RSA, true, ['wrapKey', 'encrypt']);
}

// Impressão digital da chave pública: a mesma conta do servidor (me.e2eKeys).
export async function fingerprint(publicKey: string): Promise<string> {
  return b64u(await sha256(utf8(publicKey))).slice(0, 16);
}

// ---------- Chave de cada conversa ----------

// Extraível só na memória da página: quem tem a chave entrega para quem chega (embrulhada com a chave pública).
export async function generateRoomKey(): Promise<{ key: CryptoKey; keyID: string }> {
  const key = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  return { key, keyID: await keyIdOf(key) };
}

// A geração da chave: os 16 primeiros caracteres do SHA-256 da chave. Quem recebe confere (chave trocada é recusada).
export async function keyIdOf(key: CryptoKey): Promise<string> {
  return b64u(await sha256(await subtle().exportKey('raw', key))).slice(0, 16);
}

export async function wrapRoomKey(key: CryptoKey, publicKey: CryptoKey): Promise<string> {
  return b64u(await subtle().wrapKey('raw', key, publicKey, { name: 'RSA-OAEP' }));
}

export async function unwrapRoomKey(wrapped: string, privateKey: CryptoKey): Promise<CryptoKey> {
  try {
    return await subtle().unwrapKey('raw', unb64u(wrapped), privateKey, { name: 'RSA-OAEP' }, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  } catch {
    throw new E2eError('invalid-key');
  }
}

// ---------- Mensagens ----------

export async function encryptContent(key: CryptoKey, keyID: string, rid: string, mid: string, by: string, content: E2EContent): Promise<E2EEnvelope> {
  const iv = random(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8(e2eAad(rid, mid, by)) }, key, utf8(JSON.stringify(content)));
  return { v: E2E_VERSION, kid: keyID, iv: b64u(iv), ct: b64u(ct), by };
}

const isFileRef = (f: any): f is E2EFileRef =>
  !!f && typeof f === 'object' && typeof f.name === 'string' && typeof f.type === 'string' && typeof f.size === 'number' && typeof f.key === 'string' && typeof f.iv === 'string';

export async function decryptContent(key: CryptoKey, env: E2EEnvelope, rid: string, mid: string): Promise<E2EContent> {
  let text: string;
  try {
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: unb64u(env.iv), additionalData: utf8(e2eAad(rid, mid, env.by)) }, key, unb64u(env.ct));
    text = new TextDecoder().decode(plain);
  } catch {
    throw new E2eError('decrypt-failed');
  }
  let c: any;
  try {
    c = JSON.parse(text);
  } catch {
    throw new E2eError('decrypt-failed');
  }
  if (!c || typeof c !== 'object' || typeof c.msg !== 'string') throw new E2eError('decrypt-failed');
  const out: E2EContent = { msg: c.msg };
  if (c.file !== undefined) {
    if (!isFileRef(c.file)) throw new E2eError('decrypt-failed');
    out.file = c.file;
  }
  if (c.quote && typeof c.quote === 'object' && typeof c.quote.mid === 'string' && typeof c.quote.text === 'string') {
    out.quote = { mid: c.quote.mid, author: String(c.quote.author ?? ''), ts: String(c.quote.ts ?? ''), text: c.quote.text.slice(0, 300) };
  }
  return out;
}

// ---------- Arquivos ----------

// Cada arquivo com uma chave própria, guardada (com o iv) dentro da mensagem cifrada.
export async function encryptFile(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>, rid: string, mid: string): Promise<{ data: ArrayBuffer; ref: { key: string; iv: string } }> {
  const key = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = random(12);
  const data = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8(e2eFileAad(rid, mid)) }, key, bytes);
  return { data, ref: { key: b64u(await subtle().exportKey('raw', key)), iv: b64u(iv) } };
}

export async function decryptFile(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>, ref: { key: string; iv: string }, rid: string, mid: string): Promise<ArrayBuffer> {
  try {
    const key = await subtle().importKey('raw', unb64u(ref.key), { name: 'AES-GCM' }, false, ['decrypt']);
    return await subtle().decrypt({ name: 'AES-GCM', iv: unb64u(ref.iv), additionalData: utf8(e2eFileAad(rid, mid)) }, key, bytes);
  } catch {
    throw new E2eError('decrypt-failed');
  }
}

// ---------- Código da mensagem ----------

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// 17 caracteres, como os do servidor: o código vai no AAD, então a web escolhe antes de cifrar.
export function newMessageId(): string {
  let out = '';
  while (out.length < 17) {
    for (const b of random(32)) {
      if (b < 248 && out.length < 17) out += BASE62[b % 62];
    }
  }
  return out;
}

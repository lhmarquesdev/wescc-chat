// Criptografia de ponta a ponta: as contas do navegador (web/src/lib/e2e/crypto.ts) e as regras puras de @shared/e2e.
// Sem banco: Web Crypto do Node 22.
import { describe, expect, it } from 'vitest';
import {
  canonicalPublicKey,
  e2eMaxCiphertext,
  e2eToggleVerdict,
  isEnvelope,
  isPrivateKeyBlob,
  localCommandText,
  normalizePassphrase,
  safeBlobType,
  type E2EContent,
} from '@shared/e2e';
import {
  b64u,
  decryptContent,
  decryptFile,
  decryptPrivateKey,
  E2eError,
  encryptContent,
  encryptFile,
  encryptPrivateKey,
  exportPkcs8WithPassword,
  fingerprint,
  generatePassphrase,
  generateRoomKey,
  generateUserKeys,
  importPublicKey,
  keyIdOf,
  newMessageId,
  unwrapRoomKey,
  wrapRoomKey,
} from '../../web/src/lib/e2e/crypto';

// PBKDF2 com menos voltas nos testes (o formato aceita de 100 mil a 10 milhões); o padrão do navegador é 600 mil.
const ITER = 100_000;

describe('criptografia: contas', () => {
  it('senha gerada e normalização', () => {
    const a = generatePassphrase();
    const b = generatePassphrase();
    expect(a).toMatch(/^([0-9A-HJKMNP-TV-Z]{5}-){4}[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(a).not.toBe(b);
    // Digitada com minúsculas, espaços e hífens; O vira 0, I e L viram 1.
    expect(normalizePassphrase(' abcde-fghjo kmnpq-rstvw-xyzil ')).toBe('ABCDEFGHJ0KMNPQRSTVWXYZ11');
    expect(normalizePassphrase(a.toLowerCase().replace(/-/g, ' '))).toBe(a.replace(/-/g, ''));
    // Senha própria (não tem 25 letras e números): só NFC.
    expect(normalizePassphrase('minha senha 12')).toBe('minha senha 12');
    expect(normalizePassphrase('café com pão')).toBe('café com pão');
  });

  it('par de chaves: cifra a privada com a senha, abre de novo e desembrulha a chave da sala', async () => {
    const { publicKey, pkcs8 } = await generateUserKeys();
    const pass = generatePassphrase();
    const blob = await encryptPrivateKey(pkcs8, pass, ITER);
    expect(isPrivateKeyBlob(blob)).toBe(true);
    expect(blob.length).toBeLessThanOrEqual(4000);
    expect(publicKey.length).toBeGreaterThanOrEqual(300);
    expect(publicKey.length).toBeLessThanOrEqual(1000);
    // Digitada de outro jeito (minúsculas, espaços): a mesma senha.
    const priv = await decryptPrivateKey(blob, pass.toLowerCase().replace(/-/g, ' '));
    expect(priv.extractable).toBe(false);
    const room = await generateRoomKey();
    const wrapped = await wrapRoomKey(room.key, await importPublicKey(publicKey));
    const back = await unwrapRoomKey(wrapped, priv);
    expect(await keyIdOf(back)).toBe(room.keyID);
  });

  it('senha errada: E2eError wrong-password', async () => {
    const { pkcs8 } = await generateUserKeys();
    const blob = await encryptPrivateKey(pkcs8, 'uma senha bem comprida', ITER);
    const err = await decryptPrivateKey(blob, 'outra senha comprida').catch((e) => e);
    expect(err).toBeInstanceOf(E2eError);
    expect(err.code).toBe('wrong-password');
  });

  it('chave pública canônica e formato da privada', async () => {
    const { publicKey, pkcs8 } = await generateUserKeys();
    expect(canonicalPublicKey(publicKey)).toBe(publicKey);
    expect(JSON.parse(publicKey)).toEqual({ alg: 'RSA-OAEP-256', e: 'AQAB', kty: 'RSA', n: expect.any(String) });
    // Ordem dos campos e campos extras do JWK (key_ops, ext) não mudam o texto canônico.
    const j = JSON.parse(publicKey);
    expect(canonicalPublicKey(JSON.stringify({ n: j.n, kty: 'RSA', e: 'AQAB', ext: true, key_ops: ['encrypt'] }))).toBe(publicKey);
    expect(canonicalPublicKey(JSON.stringify({ ...j, n: j.n.slice(1) }))).toBeNull();
    expect(canonicalPublicKey(JSON.stringify({ ...j, d: 'x' }))).toBeNull();
    const blob = await encryptPrivateKey(pkcs8, 'uma senha bem comprida', ITER);
    expect(isPrivateKeyBlob(blob)).toBe(true);
    const { salt: _salt, ...noSalt } = JSON.parse(blob);
    expect(isPrivateKeyBlob(JSON.stringify(noSalt))).toBe(false);
  });

  it('keyID e chave embrulhada', async () => {
    const a = await generateRoomKey();
    const b = await generateRoomKey();
    expect(a.keyID).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(await keyIdOf(a.key)).toBe(a.keyID);
    expect(a.keyID).not.toBe(b.keyID);
    const { publicKey } = await generateUserKeys();
    const wrapped = await wrapRoomKey(a.key, await importPublicKey(publicKey));
    expect(wrapped).toMatch(/^[A-Za-z0-9_-]{342}$/);
    expect(await fingerprint(publicKey)).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it('mensagem: ida e volta com acentos, emoji e arquivo', async () => {
    const { key, keyID } = await generateRoomKey();
    const mid = newMessageId();
    expect(mid).toMatch(/^[A-Za-z0-9]{17}$/);
    const content: E2EContent = {
      msg: 'Olá, ação às 9h 😀👍🏽 — “aspas”',
      file: { name: 'relatório.pdf', type: 'application/pdf', size: 1234, key: 'k', iv: 'i' },
      quote: { mid: 'abcdefghij12345', author: 'ana', ts: '2026-11-01T10:00:00Z', text: 'citado' },
    };
    const env = await encryptContent(key, keyID, 'sala1', mid, 'user1', content);
    expect(isEnvelope(env, e2eMaxCiphertext(5000))).toBe(true);
    expect(env).toMatchObject({ v: 1, kid: keyID, by: 'user1' });
    expect(env.iv).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(await decryptContent(key, env, 'sala1', mid)).toEqual(content);
  });

  it('AAD: outra sala, outra mensagem, outro autor ou um caractere trocado não abrem', async () => {
    const { key, keyID } = await generateRoomKey();
    const env = await encryptContent(key, keyID, 'sala1', 'mensagem00001', 'user1', { msg: 'segredo' });
    const fails = async (p: Promise<unknown>) => expect(((await p.catch((e) => e)) as E2eError).code).toBe('decrypt-failed');
    await fails(decryptContent(key, env, 'sala2', 'mensagem00001'));
    await fails(decryptContent(key, env, 'sala1', 'mensagem00002'));
    await fails(decryptContent(key, { ...env, by: 'user2' }, 'sala1', 'mensagem00001'));
    const flipped = env.ct[5] === 'A' ? 'B' : 'A';
    await fails(decryptContent(key, { ...env, ct: env.ct.slice(0, 5) + flipped + env.ct.slice(6) }, 'sala1', 'mensagem00001'));
    await fails(decryptContent((await generateRoomKey()).key, env, 'sala1', 'mensagem00001'));
  });

  it('arquivo: 1 MB ida e volta; cifrado = original + 16 bytes; outra mensagem não abre', async () => {
    const plain = new Uint8Array(1024 * 1024);
    for (let i = 0; i < plain.length; i += 65536) globalThis.crypto.getRandomValues(plain.subarray(i, i + 65536));
    const { data, ref } = await encryptFile(plain, 'sala1', 'mensagem00001');
    expect(data.byteLength).toBe(plain.byteLength + 16);
    const back = new Uint8Array(await decryptFile(data, ref, 'sala1', 'mensagem00001'));
    expect(b64u(back)).toBe(b64u(plain));
    expect((await decryptFile(data, ref, 'sala1', 'mensagem00002').catch((e) => e)).code).toBe('decrypt-failed');
  });

  it('troca de senha: abre com a nova, não com a antiga; a chave pública é a mesma', async () => {
    const { publicKey, pkcs8 } = await generateUserKeys();
    const blob = await encryptPrivateKey(pkcs8, 'senha antiga comprida', ITER);
    const again = await encryptPrivateKey(await exportPkcs8WithPassword(blob, 'senha antiga comprida'), 'senha nova bem comprida', ITER);
    expect((await decryptPrivateKey(again, 'senha antiga comprida').catch((e) => e)).code).toBe('wrong-password');
    const priv = await decryptPrivateKey(again, 'senha nova bem comprida');
    const room = await generateRoomKey();
    const back = await unwrapRoomKey(await wrapRoomKey(room.key, await importPublicKey(publicKey)), priv);
    expect(await keyIdOf(back)).toBe(room.keyID);
  });
});

describe('criptografia: regras puras', () => {
  it('comandos que só publicam texto: o mesmo texto do servidor', () => {
    // O texto do /shrug leva a barra escapada para o markdown (aparece uma barra só).
    expect(localCommandText('shrug', 'oi')).toBe('oi ¯\\\\_(ツ)_/¯');
    expect(localCommandText('shrug', '')).toBe('¯\\\\_(ツ)_/¯');
    expect(localCommandText('me', 'sai')).toBe('_sai_');
    expect(localCommandText('tableflip', '')).toBe('(╯°□°）╯︵ ┻━┻');
    expect(localCommandText('unflip', '')).toBe('┬─┬ ノ( ゜-゜ノ)');
    expect(localCommandText('lennyface', '')).toBe('( ͡° ͜ʖ ͡°)');
    expect(localCommandText('gimme', 'café')).toBe('༼ つ ◕_◕ ༽つ café');
    expect(localCommandText('join', 'geral')).toBeNull();
  });

  it('quem liga e desliga: ordem dos erros', () => {
    const base = { t: 'p', archived: false, on: true, settingOn: true, isDm: false, isParticipant: false, canToggle: true, hasKeys: true };
    const code = (o: Partial<typeof base>) => {
      const v = e2eToggleVerdict({ ...base, ...o });
      return v.ok ? 'ok' : `${v.status} ${v.code}`;
    };
    expect(code({})).toBe('ok');
    expect(code({ t: 'c' })).toBe('400 error-e2e-room-type');
    expect(code({ t: 'c', archived: true })).toBe('400 error-e2e-room-type');
    expect(code({ archived: true })).toBe('400 error-room-archived');
    expect(code({ settingOn: false })).toBe('400 error-e2e-disabled');
    expect(code({ settingOn: false, on: false })).toBe('ok'); // desligar não depende da configuração
    expect(code({ canToggle: false })).toBe('403 error-not-allowed');
    expect(code({ t: 'd', isDm: true, isParticipant: false, canToggle: true })).toBe('403 error-not-allowed');
    expect(code({ t: 'd', isDm: true, isParticipant: true, canToggle: false })).toBe('ok');
    expect(code({ hasKeys: false })).toBe('400 error-e2e-no-keys');
    expect(code({ hasKeys: false, on: false })).toBe('ok');
  });

  it('tipo do Blob decifrado', () => {
    expect(safeBlobType('image/svg+xml')).toBe('application/octet-stream');
    expect(safeBlobType('text/html')).toBe('application/octet-stream');
    expect(safeBlobType('image/png')).toBe('image/png');
    expect(safeBlobType('audio/webm')).toBe('audio/webm');
  });

  it('limite do conteúdo cifrado aceita 5000 emojis', async () => {
    const { key, keyID } = await generateRoomKey();
    const env = await encryptContent(key, keyID, 'sala1', 'mensagem00001', 'user1', { msg: '😀'.repeat(5000) });
    expect(isEnvelope(env, e2eMaxCiphertext(5000))).toBe(true);
    expect(isEnvelope({ ...env, extra: 1 }, e2eMaxCiphertext(5000))).toBe(false);
  });
});

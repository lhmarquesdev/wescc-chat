import { Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { parseTrustProxy, readSecret } from '../src/config';
import { redactUrl, safeReq } from '../src/tls';
import { runServer } from './run-server';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wescc-secrets-'));
const f = (name: string, content?: string | Buffer) => {
  const p = path.join(dir, name);
  if (content !== undefined) fs.writeFileSync(p, content);
  return p;
};
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

// A mensagem inteira do erro (toThrow com texto só confere um trecho).
async function messageOf(fn: () => unknown) {
  try {
    await fn();
  } catch (e) {
    return (e as Error).message;
  }
  return null;
}

// config.ts lido de novo com outro ambiente, como num processo novo.
const KNOWN = ['DATABASE_URL_FILE', 'TLS_PFX_FILE', 'TLS_PFX_PASSPHRASE', 'TLS_PFX_PASSPHRASE_FILE', 'TLS_CERT_FILE', 'TLS_KEY_FILE', 'TRUST_PROXY',
  'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_API_SECRET_FILE', 'PORT', 'INTERNAL_PORT', 'HTTP_REDIRECT_PORT'];
async function freshConfig(env: Record<string, string>) {
  vi.unstubAllEnvs();
  for (const k of KNOWN) vi.stubEnv(k, undefined);
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  return (await import('../src/config')).config;
}

describe('segredos em arquivo, TRUST_PROXY e log das requisições', () => {
  it('NOME_FILE tem precedência sobre NOME; arquivo ilegível dá erro claro', async () => {
    const file = f('segredo.txt', 'do-arquivo \r\n\n');
    expect(readSecret('SEGREDO', { SEGREDO: 'da-variavel', SEGREDO_FILE: file })).toBe('do-arquivo');
    expect(readSecret('SEGREDO', { SEGREDO: 'da-variavel' })).toBe('da-variavel');
    expect(readSecret('SEGREDO', { SEGREDO: 'da-variavel', SEGREDO_FILE: '' })).toBe('da-variavel');
    expect(readSecret('SEGREDO', {})).toBeNull();
    // Só o fim é aparado; espaços no começo e no meio fazem parte do valor.
    expect(readSecret('SEGREDO', { SEGREDO_FILE: f('espacos.txt', '  a b\t\n') })).toBe('  a b');
    // Arquivos do Windows: UTF-8 com BOM e UTF-16 (Out-File do PowerShell 5.1).
    expect(readSecret('SEGREDO', { SEGREDO_FILE: f('bom.txt', Buffer.from('﻿senha-çã\r\n', 'utf8')) })).toBe('senha-çã');
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('senha-çã\r\n', 'utf16le')]);
    expect(readSecret('SEGREDO', { SEGREDO_FILE: f('utf16.txt', utf16) })).toBe('senha-çã');

    const missing = path.join(dir, 'nao-existe.txt');
    expect(() => readSecret('LIVEKIT_API_SECRET', { LIVEKIT_API_SECRET: 'x', LIVEKIT_API_SECRET_FILE: missing })).toThrow(
      `Não foi possível ler LIVEKIT_API_SECRET_FILE: ${missing}`,
    );
    expect(() => readSecret('DATABASE_URL', { DATABASE_URL_FILE: dir })).toThrow(`Não foi possível ler DATABASE_URL_FILE: ${dir}`);
    // O motivo vai junto: arquivo que não existe não é o mesmo problema que uma permissão faltando.
    expect(await messageOf(() => readSecret('LIVEKIT_API_SECRET', { LIVEKIT_API_SECRET_FILE: missing }))).toBe(
      `Não foi possível ler LIVEKIT_API_SECRET_FILE: ${missing} (o arquivo não existe)`,
    );
    expect(await messageOf(() => readSecret('DATABASE_URL', { DATABASE_URL_FILE: dir }))).toBe(
      `Não foi possível ler DATABASE_URL_FILE: ${dir} (o caminho é uma pasta, não um arquivo)`,
    );

    // O config usa os arquivos para o banco, a senha do PFX e o segredo do LiveKit.
    const c = await freshConfig({
      DATABASE_URL: 'postgres://errado@127.0.0.1/x',
      DATABASE_URL_FILE: f('database-url.txt', 'postgres://chat:<segredo>@127.0.0.1:5432/chat\n'),
      TLS_PFX_FILE: path.join(dir, 'chat.pfx'),
      TLS_PFX_PASSPHRASE_FILE: f('tls-pfx-passphrase.txt', '<senha>\n'),
      LIVEKIT_URL: 'http://127.0.0.1:7880',
      LIVEKIT_API_KEY: 'APIabcdefghijkl',
      LIVEKIT_API_SECRET_FILE: f('livekit-api-secret.txt', '<segredo-livekit>\n'),
    });
    expect(c.databaseUrl).toBe('postgres://chat:<segredo>@127.0.0.1:5432/chat');
    expect(c.tls).toMatchObject({ pfxFile: path.join(dir, 'chat.pfx'), pfxPassphrase: '<senha>', certFile: null, keyFile: null });
    expect(c.livekit).toEqual({ url: 'http://127.0.0.1:7880', apiKey: 'APIabcdefghijkl', apiSecret: '<segredo-livekit>' });
    await expect(freshConfig({ LIVEKIT_API_SECRET_FILE: missing })).rejects.toThrow(`Não foi possível ler LIVEKIT_API_SECRET_FILE: ${missing}`);
  });

  it('TRUST_PROXY: padrão false com HTTPS próprio e true sem ele; lista de endereços aceita', async () => {
    expect(parseTrustProxy(undefined, true)).toBe(false);
    expect(parseTrustProxy(undefined, false)).toBe(true);
    expect(parseTrustProxy('  ', true)).toBe(false);
    expect(parseTrustProxy('true', true)).toBe(true);
    expect(parseTrustProxy('FALSE', false)).toBe(false);
    expect(parseTrustProxy('1', true)).toBe(true);
    expect(parseTrustProxy('0', false)).toBe(false);
    expect(parseTrustProxy('127.0.0.1, 10.0.0.0/8,::1,fc00::/7,loopback,192.168.0.0/255.255.0.0', true)).toEqual([
      '127.0.0.1',
      '10.0.0.0/8',
      '::1',
      'fc00::/7',
      'loopback',
      '192.168.0.0/255.255.0.0',
    ]);
    // Máscara com buracos ou faixa vazia (/0): o proxy-addr do Fastify recusa.
    for (const bad of ['proxy.empresa.local', '10.0.0.0/33', '10.0.0.1/8/1', 'sim', '10.0.0.0/255.0.255.0', '10.0.0.0/0.0.0.255', '10.0.0.0/256.0.0.0',
      '10.0.0.0/0', '0.0.0.0/0.0.0.0', '::/0', 'fc00::/129']) {
      expect(() => parseTrustProxy(bad, true)).toThrow(/^TRUST_PROXY inválido: /);
    }
    // Tudo o que parseTrustProxy aceita o Fastify também aceita (senão o erro dele sairia em inglês).
    for (const ok of ['127.0.0.1, 10.0.0.0/8,::1,fc00::/7,loopback,192.168.0.0/255.255.0.0', '10.0.0.0/255.255.255.255', '10.0.0.0/255.255.240.0', '10.0.0.0/1', '::/1']) {
      const list = parseTrustProxy(ok, true);
      expect(Array.isArray(list)).toBe(true);
      await Fastify({ trustProxy: list }).close();
    }

    expect((await freshConfig({ TLS_PFX_FILE: path.join(dir, 'chat.pfx') })).trustProxy).toBe(false);
    expect((await freshConfig({ TLS_CERT_FILE: path.join(dir, 'chat.crt'), TLS_KEY_FILE: path.join(dir, 'chat.key') })).trustProxy).toBe(false);
    expect((await freshConfig({ TLS_PFX_FILE: path.join(dir, 'chat.pfx'), TRUST_PROXY: '10.0.0.5' })).trustProxy).toEqual(['10.0.0.5']);
    expect((await freshConfig({})).trustProxy).toBe(true);

    // Com HTTPS próprio, qualquer um poderia mandar X-Forwarded-For: o IP real vale.
    const ipWith = async (trustProxy: boolean | string[], remoteAddress: string) => {
      const app = Fastify({ trustProxy });
      app.get('/ip', async (req) => ({ ip: req.ip }));
      const r = await app.inject({ url: '/ip', remoteAddress, headers: { 'x-forwarded-for': '203.0.113.9' } });
      await app.close();
      return r.json().ip;
    };
    expect(await ipWith(parseTrustProxy(undefined, true), '10.1.2.3')).toBe('10.1.2.3');
    expect(await ipWith(parseTrustProxy(undefined, false), '10.1.2.3')).toBe('203.0.113.9');
    expect(await ipWith(parseTrustProxy('10.0.0.5', true), '10.0.0.5')).toBe('203.0.113.9');
    expect(await ipWith(parseTrustProxy('10.0.0.5', true), '10.1.2.3')).toBe('10.1.2.3');
  });

  it('o log da requisição esconde access_token e join_request', async () => {
    const url = '/sfu/rtc?access_token=eyJhbGciOi.eyJzdWIi.c2ln&auto_subscribe=1&join_request=H4sIAAAA%2Bxyz&sdk=js';
    expect(safeReq({ method: 'GET', url, hostname: 'chat.exemplo.test', ip: '10.0.0.9', socket: { remotePort: 51515 } })).toEqual({
      method: 'GET',
      url: '/sfu/rtc?access_token=***&auto_subscribe=1&join_request=***&sdk=js',
      hostname: 'chat.exemplo.test',
      remoteAddress: '10.0.0.9',
      remotePort: 51515,
    });
    expect(redactUrl('/api/v1/me')).toBe('/api/v1/me');
    expect(redactUrl('/sfu/rtc/v1/validate?access%5Ftoken=abc&x=1')).toBe('/sfu/rtc/v1/validate?access%5Ftoken=***&x=1');
    expect(redactUrl('/sfu/rtc?join_request&access_token=')).toBe('/sfu/rtc?join_request=***&access_token=***');
    expect(redactUrl('/a?b=%E0%A4%A&access_token=abc')).toBe('/a?b=%E0%A4%A&access_token=***');

    // Pelo logger de verdade (pino), com as mesmas opções do app.
    const lines: string[] = [];
    const stream = new Writable({ write: (chunk, _enc, cb) => (lines.push(String(chunk)), cb()) });
    const app = Fastify({ logger: { level: 'info', serializers: { req: safeReq }, stream } });
    app.get('/sfu/rtc', async () => {
      throw new Error('falha de teste');
    });
    await app.inject({ url });
    await app.close();
    const log = lines.join('');
    expect(log).toContain('access_token=***');
    expect(log).toContain('join_request=***');
    expect(log).not.toContain('eyJhbGciOi');
    expect(log).not.toContain('H4sIAAAA');
  });

  it('PORT e INTERNAL_PORT vazios usam o padrão; porta inválida dá erro claro', async () => {
    const c = await freshConfig({ PORT: '', INTERNAL_PORT: '', TLS_PFX_FILE: path.join(dir, 'chat.pfx') });
    expect(c.port).toBe(3000);
    expect(c.internalPort).toBe(3080);
    expect((await freshConfig({ PORT: ' 443 ', INTERNAL_PORT: '3081' })).internalPort).toBe(3081);
    for (const [name, v] of [['INTERNAL_PORT', 'abc'], ['INTERNAL_PORT', '0'], ['PORT', '70000'], ['PORT', '44.3']]) {
      expect(await messageOf(() => freshConfig({ [name]: v }))).toBe(`${name} inválido: "${v}". Use um número de porta de 1 a 65535.`);
    }
  });

  it('erro de configuração ao subir mostra só a mensagem em português, sem rastro de pilha', async () => {
    const bad = await runServer({ TRUST_PROXY: 'proxy.local', DATABASE_URL: 'postgres://ninguem:x@127.0.0.1:1/nada' });
    expect(bad.code).toBe(1);
    expect(bad.stderr.trim()).toBe(
      'TRUST_PROXY inválido: "proxy.local". Use true, false ou os endereços e faixas dos proxies separados por vírgula (por exemplo 127.0.0.1,10.0.0.0/8).',
    );
    const missing = path.join(dir, 'nao-existe-db.txt');
    const noFile = await runServer({ DATABASE_URL_FILE: missing });
    expect(noFile.code).toBe(1);
    expect(noFile.stderr.trim()).toBe(`Não foi possível ler DATABASE_URL_FILE: ${missing} (o arquivo não existe)`);
    // O instalador do Windows lê a resposta do --check-tls em JSON.
    const check = await runServer({ TRUST_PROXY: 'proxy.local' }, ['--check-tls']);
    expect(check.code).toBe(2);
    expect(JSON.parse(check.stdout.trim())).toEqual({ enabled: false, error: expect.stringMatching(/^TRUST_PROXY inválido: "proxy\.local"/) });
  });
});

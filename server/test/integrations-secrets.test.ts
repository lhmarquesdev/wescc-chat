import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aadFor, decryptSecret, encryptSecret, integrationsPaused, keyInfo, reloadSecretsKey, secretHint } from '../src/lib/secrets';

// Segredos das integrações, sem banco: cifra, AAD, chave por variável ou arquivo, chave anterior e dicas.

const KEYS = ['SECRETS_KEY', 'SECRETS_KEY_FILE', 'SECRETS_KEY_PREVIOUS', 'SECRETS_KEY_PREVIOUS_FILE'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wescc-segredos-'));
const newKey = () => crypto.randomBytes(32).toString('base64');
const kidOf = (key: string) => crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 8);

function useEnv(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  reloadSecretsKey();
}

beforeEach(() => useEnv({}));
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  reloadSecretsKey();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('segredos das integrações: cifra', () => {
  it('ida e volta; o valor gravado nunca é o texto puro; o formato é v1.<kid>.<iv>.<tag>.<ct>', () => {
    const key = newKey();
    useEnv({ SECRETS_KEY: key });
    const plain = 'ATATT3xFfGF0-token-de-teste-ção';
    const blob = encryptSecret(plain, aadFor.secret('jira.apiToken'));
    expect(blob).not.toBe(plain);
    expect(blob).not.toContain(plain);
    expect(blob).not.toContain(Buffer.from(plain).toString('base64url'));
    const parts = blob.split('.');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('v1');
    expect(parts[1]).toBe(kidOf(key));
    expect(decryptSecret(blob, aadFor.secret('jira.apiToken'))).toBe(plain);
    // Duas cifras do mesmo valor não são iguais (IV novo a cada vez).
    expect(encryptSecret(plain, aadFor.secret('jira.apiToken'))).not.toBe(blob);
    expect(keyInfo()).toEqual({ source: 'env', created: false, previous: false });
    expect(integrationsPaused()).toBe(false);
  });

  it('AAD errado não abre (valor copiado para outro lugar ou para outra origem do Jira)', () => {
    useEnv({ SECRETS_KEY: newKey() });
    const blob = encryptSecret('segredo', aadFor.secret('jira.apiToken', 'https://explorer.atlassian.net'));
    expect(decryptSecret(blob, aadFor.secret('jira.apiToken', 'https://explorer.atlassian.net'))).toBe('segredo');
    for (const aad of [aadFor.secret('jira.apiToken'), aadFor.secret('jira.apiToken', 'https://outra.atlassian.net'), aadFor.secret('msteams.clientSecret'), aadFor.rule('abc')]) {
      expect(() => decryptSecret(blob, aad)).toThrow(expect.objectContaining({ statusCode: 500, errorType: 'error-secret-key' }));
    }
    // Um byte trocado no texto cifrado também não abre.
    const parts = blob.split('.');
    const ct = Buffer.from(parts[4], 'base64url');
    ct[0] ^= 1;
    expect(() => decryptSecret([...parts.slice(0, 4), ct.toString('base64url')].join('.'), aadFor.secret('jira.apiToken', 'https://explorer.atlassian.net'))).toThrow();
    expect(() => decryptSecret('texto qualquer', 'x')).toThrow(expect.objectContaining({ errorType: 'error-secret-key' }));
  });

  it('chave errada não abre; com SECRETS_KEY_PREVIOUS a chave anterior abre', () => {
    const old = newKey();
    useEnv({ SECRETS_KEY: old });
    const blob = encryptSecret('valor antigo', aadFor.rule('regra1'));
    useEnv({ SECRETS_KEY: newKey() });
    expect(() => decryptSecret(blob, aadFor.rule('regra1'))).toThrow(
      expect.objectContaining({ errorType: 'error-secret-key', message: 'Não foi possível ler um segredo das integrações (a chave de segredos mudou). Cadastre o segredo de novo.' }),
    );
    const current = newKey();
    useEnv({ SECRETS_KEY: current, SECRETS_KEY_PREVIOUS: old });
    expect(keyInfo().previous).toBe(true);
    expect(decryptSecret(blob, aadFor.rule('regra1'))).toBe('valor antigo');
    // O que é cifrado agora usa a chave atual.
    expect(encryptSecret('novo', 'x').split('.')[1]).toBe(kidOf(current));
    // Chave anterior em arquivo também serve.
    const prevFile = path.join(tmp, 'anterior.txt');
    fs.writeFileSync(prevFile, `${old}\r\n`);
    useEnv({ SECRETS_KEY: current, SECRETS_KEY_PREVIOUS_FILE: prevFile });
    expect(decryptSecret(blob, aadFor.rule('regra1'))).toBe('valor antigo');
  });

  it('dica: só os 4 últimos caracteres, e nada para valores curtos', () => {
    expect(secretHint('abc')).toBe('••••');
    expect(secretHint('12345678901')).toBe('••••');
    expect(secretHint('abcdefghijkl')).toBe('••••ijkl');
    expect(secretHint('https://prod-00.westus.logic.azure.com/workflows/abc?sig=XYZW')).toBe('••••XYZW');
  });

  it('AAD de cada lugar tem o formato combinado entre os módulos', () => {
    expect(aadFor.secret('jira.apiToken')).toBe('secret:jira.apiToken');
    expect(aadFor.secret('jira.apiToken', 'https://explorer.atlassian.net')).toBe('secret:jira.apiToken:https://explorer.atlassian.net');
    expect(aadFor.rule('r1')).toBe('integration:r1:secret');
    expect(aadFor.linked('u1', 'jira', 'access', 'https://explorer.atlassian.net')).toBe('linked:u1:jira:access:https://explorer.atlassian.net');
    expect(aadFor.linked('u1', 'jira', 'refresh', null)).toBe('linked:u1:jira:refresh:');
    expect(aadFor.linked('u1', 'microsoft', 'refresh', 'ignorado')).toBe('linked:u1:microsoft:refresh');
    expect(aadFor.oauth('abc')).toBe('oauth:abc');
  });
});

describe('segredos das integrações: chave', () => {
  it('arquivo de chave criado uma vez (0600, 44 caracteres) e lido nas próximas subidas', () => {
    const file = path.join(tmp, `chave-${crypto.randomBytes(3).toString('hex')}.txt`);
    useEnv({ SECRETS_KEY_FILE: file });
    expect(keyInfo()).toEqual({ source: 'file', file, created: true, previous: false });
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const blob = encryptSecret('persistente', 'x');
    useEnv({ SECRETS_KEY_FILE: file });
    expect(keyInfo().created).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    expect(decryptSecret(blob, 'x')).toBe('persistente');
  });

  it('corrida ao criar o arquivo (wx): quem perde lê a chave de quem criou', () => {
    const file = path.join(tmp, `corrida-${crypto.randomBytes(3).toString('hex')}.txt`);
    const other = newKey();
    // Outra instância criou o arquivo entre a conferência e a escrita desta.
    fs.writeFileSync(file, other, { mode: 0o600 });
    const real = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => (p === file ? false : real(p)));
    useEnv({ SECRETS_KEY_FILE: file });
    expect(keyInfo()).toEqual({ source: 'file', file, created: false, previous: false });
    expect(fs.readFileSync(file, 'utf8')).toBe(other);
    expect(encryptSecret('x', 'y').split('.')[1]).toBe(kidOf(other));
  });

  it('SECRETS_KEY_FILE relativo é recusado e nenhum arquivo aparece na pasta de trabalho', () => {
    const rel = path.join('segredos-teste', 'integrations-key.txt');
    const before = fs.readdirSync(process.cwd()).sort();
    useEnv({ SECRETS_KEY_FILE: rel });
    const info = keyInfo();
    expect(info.problem).toBe('SECRETS_KEY_FILE precisa de um caminho completo, por exemplo C:\\Wescc\\secrets\\integrations-key.txt.');
    expect(integrationsPaused()).toBe(true);
    expect(() => encryptSecret('x', 'y')).toThrow(expect.objectContaining({ statusCode: 500, errorType: 'error-secret-key-missing', message: info.problem }));
    expect(fs.existsSync(path.resolve(rel))).toBe(false);
    expect(fs.readdirSync(process.cwd()).sort()).toEqual(before);
  });

  it('sem chave: salvar responde error-secret-key-missing e nenhum arquivo aparece na pasta de trabalho', () => {
    const before = fs.readdirSync(process.cwd()).sort();
    useEnv({});
    expect(keyInfo()).toEqual({ source: 'none', created: false, previous: false });
    expect(integrationsPaused()).toBe(true);
    expect(() => encryptSecret('token', aadFor.secret('jira.apiToken'))).toThrow(
      expect.objectContaining({
        statusCode: 500,
        errorType: 'error-secret-key-missing',
        message: 'O servidor não tem a chave de segredos das integrações. Defina SECRETS_KEY_FILE com o caminho completo de um arquivo de chave e reinicie o serviço.',
      }),
    );
    expect(fs.readdirSync(process.cwd()).sort()).toEqual(before);
  });

  it('chave com tamanho errado ou caracteres inválidos: problema explicado e integrações paradas', () => {
    for (const bad of ['curta', crypto.randomBytes(16).toString('base64'), `${newKey().slice(0, 40)}!!!=`]) {
      useEnv({ SECRETS_KEY: bad });
      expect(keyInfo().problem).toBe('SECRETS_KEY precisa ter 32 bytes aleatórios em base64 (44 caracteres). A chave atual não serve: nenhum segredo das integrações pode ser lido ou salvo.');
      expect(integrationsPaused()).toBe(true);
    }
    const file = path.join(tmp, 'ruim.txt');
    fs.writeFileSync(file, 'nao-e-uma-chave');
    useEnv({ SECRETS_KEY_FILE: file });
    expect(keyInfo().problem).toContain('SECRETS_KEY_FILE precisa ter 32 bytes');
    // Arquivo salvo pelo Bloco de Notas (UTF-8 com BOM e quebra de linha) continua valendo.
    const key = newKey();
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${key}\r\n`)]));
    useEnv({ SECRETS_KEY_FILE: file });
    expect(keyInfo().problem).toBeUndefined();
    expect(encryptSecret('x', 'y').split('.')[1]).toBe(kidOf(key));
  });

  it('SECRETS_KEY tem prioridade sobre SECRETS_KEY_FILE (e o arquivo não é criado)', () => {
    const file = path.join(tmp, `nao-criar-${crypto.randomBytes(3).toString('hex')}.txt`);
    const key = newKey();
    useEnv({ SECRETS_KEY: key, SECRETS_KEY_FILE: file });
    expect(keyInfo().source).toBe('env');
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('segredos das integrações: revisão', () => {
  it('a etiqueta do GCM tem de ter 16 bytes e o IV 12: um blob com a etiqueta cortada não abre', () => {
    useEnv({ SECRETS_KEY: newKey() });
    const aad = aadFor.secret('jira.apiToken');
    const blob = encryptSecret('tok-teste-123456789', aad);
    const p = blob.split('.');
    const tag = Buffer.from(p[3], 'base64url');
    for (const n of [4, 8, 12, 15]) {
      const cut = [p[0], p[1], p[2], tag.subarray(0, n).toString('base64url'), p[4]].join('.');
      expect(() => decryptSecret(cut, aad), `etiqueta de ${n} bytes`).toThrow(expect.objectContaining({ errorType: 'error-secret-key' }));
    }
    const iv = Buffer.from(p[2], 'base64url');
    expect(() => decryptSecret([p[0], p[1], iv.subarray(0, 8).toString('base64url'), p[3], p[4]].join('.'), aad)).toThrow(expect.objectContaining({ errorType: 'error-secret-key' }));
    expect(decryptSecret(blob, aad)).toBe('tok-teste-123456789');
  });

  it('a falha ao criar ou ler o arquivo da chave não leva o caminho nem o erro do sistema para fora (só em detail, para o admin e o log)', () => {
    const file = path.join(tmp, 'pasta-que-nao-existe', 'integrations-key.txt');
    useEnv({ SECRETS_KEY_FILE: file });
    const info = keyInfo();
    expect(info.problem).toBe('Não foi possível criar a chave de segredos das integrações no arquivo de SECRETS_KEY_FILE. Confira se a pasta existe e se o serviço pode gravar nela.');
    expect(info.detail).toContain(file);
    expect(info.detail).toContain('ENOENT');
    expect(() => encryptSecret('x', 'y')).toThrow(expect.objectContaining({ errorType: 'error-secret-key-missing', message: info.problem }));
    // Um caminho que existe mas não é um arquivo legível.
    useEnv({ SECRETS_KEY_FILE: tmp });
    const dir = keyInfo();
    expect(dir.problem).toBe('Não foi possível ler o arquivo de SECRETS_KEY_FILE. Confira o caminho e se o serviço pode ler o arquivo.');
    expect(dir.problem).not.toContain(tmp);
    expect(dir.detail).toContain(tmp);
  });
});

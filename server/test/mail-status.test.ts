import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, api, newUser, startServer, stopServer, type Auth } from './helpers';

// E-mail: a falha de envio não fica calada. O log do servidor, a última falha em Administração › Configurações ›
// E-mail e o e-mail de teste com o motivo em português.

// SMTP falso mínimo (sem STARTTLS, sem autenticação).
async function startSmtp() {
  const mails: string[] = [];
  const server = net.createServer((s) => {
    let buf = '';
    let inData = false;
    s.on('error', () => {});
    s.write('220 smtp.falso ESMTP\r\n');
    s.on('data', (d) => {
      buf += d.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          mails.push(buf.slice(0, end));
          buf = buf.slice(end + 5);
          inData = false;
          s.write('250 OK\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const cmd = buf.slice(0, 4).toUpperCase();
        buf = buf.slice(i + 2);
        if (cmd === 'EHLO' || cmd === 'HELO') s.write('250-smtp.falso\r\n250 8BITMIME\r\n');
        else if (cmd === 'DATA') {
          inData = true;
          s.write('354 Pode mandar\r\n');
        } else if (cmd === 'QUIT') s.end('221 Tchau\r\n');
        else s.write('250 OK\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { port: (server.address() as net.AddressInfo).port, mails, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// Uma porta sem ninguém escutando.
async function closedPort() {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

let A: Auth;
let smtp: Awaited<ReturnType<typeof startSmtp>>;
beforeAll(async () => {
  await startServer();
  A = await admin();
  smtp = await startSmtp();
  await api('POST', 'settings', { settings: { API_Enable_Rate_Limiter: false } }, A);
});
afterAll(async () => {
  await api('POST', 'settings', { settings: { SMTP_Host: '', SMTP_Port: 587 } }, A);
  await smtp?.close();
  await stopServer();
});

describe('e-mail (SMTP)', () => {
  it('sem SMTP, o teste diz o que falta; com a porta fechada, o motivo aparece no teste e na última falha', async () => {
    await api('POST', 'settings', { settings: { SMTP_Host: '' } }, A);
    const none = await api('POST', 'email.sendTest', {}, A);
    expect(none.status).toBe(400);
    expect(none.error).toBe('Preencha o servidor SMTP e salve antes de testar.');
    expect((await api('GET', 'email.status', undefined, A)).status).toMatchObject({ configured: false });

    const port = await closedPort();
    await api('POST', 'settings', { settings: { SMTP_Host: '127.0.0.1', SMTP_Port: port } }, A);
    const r = await api('POST', 'email.sendTest', { to: 'teste@empresa.com.br' }, A);
    expect(r.status).toBe(400);
    expect(r.errorType).toBe('error-smtp-failed');
    expect(r.error).toBe(`O servidor SMTP 127.0.0.1:${port} recusou a conexão. Confira o servidor e a porta.`);
    // Um envio do dia a dia (redefinição de senha, em segundo plano) também fica registrado.
    const u = await newUser(A);
    await api('POST', 'users.forgotPassword', { email: `${u.username}@test.local` });
    let st: any;
    for (let i = 0; i < 40; i++) {
      st = (await api('GET', 'email.status', undefined, A)).status;
      if (st.lastFailure?.subject?.includes('Redefinição de senha')) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(st).toMatchObject({ configured: true, lastFailure: { subject: expect.stringContaining('Redefinição de senha'), error: expect.stringContaining('recusou a conexão') } });
  });

  it('com o SMTP no ar, o teste chega e a tela passa a mostrar o último envio bem-sucedido', async () => {
    await api('POST', 'settings', { settings: { SMTP_Host: '127.0.0.1', SMTP_Port: smtp.port } }, A);
    const r = await api('POST', 'email.sendTest', { to: 'teste@empresa.com.br' }, A);
    expect(r.success).toBe(true);
    expect(r.message).toBe('E-mail de teste enviado para teste@empresa.com.br.');
    expect(smtp.mails.at(-1)).toContain('E-mail de teste');
    const st = (await api('GET', 'email.status', undefined, A)).status;
    expect(st.lastSuccessAt > st.lastFailure.at).toBe(true);
  });

  it('só quem configura o servidor testa', async () => {
    const u = await newUser(A);
    expect((await api('POST', 'email.sendTest', {}, u)).status).toBe(403);
    expect((await api('GET', 'email.status', undefined, u)).status).toBe(403);
  });
});

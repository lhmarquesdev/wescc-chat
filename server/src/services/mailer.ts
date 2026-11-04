import nodemailer, { type Transporter } from 'nodemailer';
import { appLog } from '../lib/log';
import { getSetting } from './settings';

let transport: Transporter | null = null;
let transportKey = '';

// Último envio desta instância, para Administração › Configurações › E-mail ("Último envio falhou em …").
export interface MailStatus {
  configured: boolean;
  lastSuccessAt: string | null;
  lastFailure: { at: string; error: string; subject: string } | null;
}
let lastSuccessAt: string | null = null;
let lastFailure: MailStatus['lastFailure'] = null;

export function mailStatus(): MailStatus {
  return { configured: !!getSetting<string>('SMTP_Host'), lastSuccessAt, lastFailure };
}

// Testes.
export function resetMailStatus() {
  lastSuccessAt = null;
  lastFailure = null;
}

function getTransport() {
  const host = getSetting<string>('SMTP_Host');
  if (!host) return null;
  const key = [host, getSetting('SMTP_Port'), getSetting('SMTP_Username'), getSetting('SMTP_Password')].join('|');
  if (!transport || key !== transportKey) {
    const user = getSetting<string>('SMTP_Username');
    transport = nodemailer.createTransport({
      host,
      port: getSetting<number>('SMTP_Port'),
      secure: getSetting<number>('SMTP_Port') === 465,
      auth: user ? { user, pass: getSetting<string>('SMTP_Password') } : undefined,
      // Servidor fora do ar: desiste em segundos (o teste da tela espera a resposta).
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
    transportKey = key;
  }
  return transport;
}

// O motivo da falha em português, para a tela (o log guarda o original).
export function smtpErrorText(e: any): string {
  const code = String(e?.code ?? '');
  const raw = String(e?.message ?? '');
  const host = getSetting<string>('SMTP_Host');
  const port = getSetting<number>('SMTP_Port');
  // O nodemailer embrulha o erro do sistema (ESOCKET, EDNS); o código original vem no texto.
  if (code === 'ECONNREFUSED' || /\bECONNREFUSED\b/.test(raw)) return `O servidor SMTP ${host}:${port} recusou a conexão. Confira o servidor e a porta.`;
  if (code === 'EDNS' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /\b(ENOTFOUND|EAI_AGAIN)\b/.test(raw)) return `O servidor SMTP ${host} não foi encontrado. Confira o endereço.`;
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION') return `Sem resposta do servidor SMTP ${host}:${port}. Confira o servidor, a porta e o firewall.`;
  if (code === 'EAUTH') return 'O servidor SMTP recusou o usuário ou a senha.';
  if (code === 'EENVELOPE') return 'O servidor SMTP recusou o remetente ou o destinatário. Confira o remetente.';
  if (code === 'ETLS') return 'Falha na conexão segura (TLS) com o servidor SMTP.';
  const msg = raw.slice(0, 200);
  return msg ? `O servidor SMTP respondeu com erro: ${msg}` : 'Falha ao enviar o e-mail.';
}

// Envia; com throwOnError, a falha sobe (o teste da tela mostra o motivo). Sem SMTP configurado: false.
export async function sendMail(opts: { to: string; subject: string; text: string; html?: string }, how: { throwOnError?: boolean } = {}) {
  const t = getTransport();
  if (!t) return false;
  try {
    await t.sendMail({ from: getSetting<string>('From_Email'), ...opts });
    lastSuccessAt = new Date().toISOString();
    return true;
  } catch (e: any) {
    const error = smtpErrorText(e);
    lastFailure = { at: new Date().toISOString(), error, subject: opts.subject.slice(0, 120) };
    // No log, sem o texto do e-mail nem o endereço inteiro.
    appLog.warn({ err: { code: e?.code, message: e?.message }, toDomain: String(opts.to).split('@')[1] ?? '', subject: opts.subject }, 'falha ao enviar e-mail');
    if (how.throwOnError) throw Object.assign(new Error(error), { smtp: true });
    return false;
  }
}

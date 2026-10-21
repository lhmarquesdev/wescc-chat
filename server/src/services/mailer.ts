import nodemailer, { type Transporter } from 'nodemailer';
import { getSetting } from './settings';

let transport: Transporter | null = null;
let transportKey = '';

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
    });
    transportKey = key;
  }
  return transport;
}

export async function sendMail(opts: { to: string; subject: string; text: string; html?: string }) {
  const t = getTransport();
  if (!t) return false;
  try {
    await t.sendMail({ from: getSetting<string>('From_Email'), ...opts });
    return true;
  } catch {
    return false;
  }
}

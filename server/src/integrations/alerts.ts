import type { IntegrationAlert, Provider } from '@shared/integrations';
import { many, one, query } from '../db/pool';
import { bus } from '../realtime/bus';
import { sendMail } from '../services/mailer';
import { rolesWithPermission } from '../services/permissions';
import { getSetting } from '../services/settings';
import { excerpt } from './text';

// Alertas para quem configura (ou para a própria pessoa, nos tokens pessoais): no chat e por e-mail, no máximo
// uma vez por dia por chave enquanto o problema durar.

export interface AlertInput {
  key: string;
  provider: Provider;
  tone: 'warn' | 'err';
  text: string;
  href: string;
  to: 'managers' | 'admins' | { userId: string };
}

interface AlertState {
  text: string;
  tone: 'warn' | 'err';
  href: string;
  provider: Provider;
  to: AlertInput['to'];
  since: string;
  lastSentAt: string;
}

const DAY = 24 * 3600_000;
const MANAGE: Record<Provider, string> = { jira: 'manage-jira', msteams: 'manage-msteams' };

async function recipients(a: Pick<AlertInput, 'provider' | 'to'>): Promise<{ id: string; email: string | null }[]> {
  if (typeof a.to === 'object') return many(`SELECT id, email FROM users WHERE id = $1 AND active`, [a.to.userId]);
  if (a.to === 'admins') return many(`SELECT id, email FROM users WHERE active AND type = 'user' AND 'admin' = ANY(roles)`);
  const roles = rolesWithPermission(MANAGE[a.provider]);
  if (!roles.length) return [];
  return many(`SELECT id, email FROM users WHERE active AND type = 'user' AND roles && $1::text[]`, [roles]);
}

const toAlert = (key: string, s: AlertState): IntegrationAlert => ({ key, provider: s.provider, tone: s.tone, text: s.text, href: s.href, since: s.since });

export async function raiseAlert(a: AlertInput): Promise<void> {
  const now = new Date().toISOString();
  const data: AlertState = { text: a.text, tone: a.tone, href: a.href, provider: a.provider, to: a.to, since: now, lastSentAt: now };
  // Uma instrução só: duas instâncias com o mesmo problema entregam uma vez.
  const r = await one(
    `INSERT INTO integration_state (id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data || jsonb_build_object(
         'since', COALESCE(integration_state.data->'since', EXCLUDED.data->'since'),
         'lastSentAt', CASE WHEN (integration_state.data->>'lastSentAt')::timestamptz > now() - interval '24 hours'
                            THEN integration_state.data->'lastSentAt' ELSE EXCLUDED.data->'lastSentAt' END),
       updated_at = now()
     RETURNING data`,
    [`alert:${a.key}`, JSON.stringify(data)],
  );
  const stored = r?.data as AlertState | undefined;
  if (!stored || stored.lastSentAt !== now) return;
  const people = await recipients(a);
  if (!people.length) return;
  const alert = toAlert(a.key, stored);
  bus.publish({ users: people.map((p) => p.id) }, { type: 'integrations.alert', alert });
  const site = String(getSetting('Site_Name') || 'Chat');
  const base = String(getSetting('Site_Url') ?? '').replace(/\/+$/, '');
  // Assunto: a primeira frase (ou o trecho antes de ":"), sem a pontuação do fim.
  const subject = `${site}: ${excerpt(a.text.split(/(?<=[.:])\s/)[0].replace(/[.:]$/, ''), 90)}`;
  const text = `${a.text}\n\n${base ? `Abrir: ${base}${a.href}` : `Abra o ${site} em ${a.href}.`}`;
  for (const p of people) if (p.email) await sendMail({ to: p.email, subject, text });
}

export async function clearAlert(key: string): Promise<void> {
  await query('DELETE FROM integration_state WHERE id = $1', [`alert:${key}`]);
}

// provider: os alertas para quem gerencia aquele fornecedor (e os de administradores); userId: os da própria pessoa.
export async function activeAlerts(o: { provider?: Provider; userId?: string }): Promise<IntegrationAlert[]> {
  const rows = await many(`SELECT id, data FROM integration_state WHERE id LIKE 'alert:%' ORDER BY updated_at DESC`);
  const out: IntegrationAlert[] = [];
  for (const r of rows) {
    const s = r.data as AlertState;
    const personal = typeof s.to === 'object';
    if (o.userId && !(personal && (s.to as { userId: string }).userId === o.userId)) continue;
    if (o.provider && !o.userId && (personal || (s.to === 'managers' && s.provider !== o.provider))) continue;
    out.push(toAlert(String(r.id).slice('alert:'.length), s));
  }
  return out;
}

// Para a API: o que esta pessoa pode ver, conforme as permissões que tem.
export async function alertsFor(userId: string, can: { jira: boolean; msteams: boolean; admin: boolean }): Promise<IntegrationAlert[]> {
  const rows = await many(`SELECT id, data FROM integration_state WHERE id LIKE 'alert:%' ORDER BY updated_at DESC`);
  return rows
    .filter((r) => {
      const s = r.data as AlertState;
      if (typeof s.to === 'object') return s.to.userId === userId;
      if (s.to === 'admins') return can.admin;
      return s.provider === 'jira' ? can.jira : can.msteams;
    })
    .map((r) => toAlert(String(r.id).slice('alert:'.length), r.data as AlertState));
}

export const ALERT_DAY_MS = DAY;

// "{prefixo}: {texto}." sem ponto dobrado quando o texto já termina a frase.
export function alertText(prefix: string, detail: string): string {
  const d = String(detail ?? '').trim();
  if (!d) return `${prefix}.`;
  return `${prefix}: ${/[.!?…]$/.test(d) ? d : `${d}.`}`;
}

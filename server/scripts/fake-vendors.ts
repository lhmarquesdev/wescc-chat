// Servidor falso do Jira Cloud, para desenvolver a integração sem conta de verdade. É o mesmo dos testes
// (test/fake-jira.ts), com uma
// tela de consentimento e rotas para simular eventos. Uso, em server/:
//
//   INTEGRATIONS_DEV_ENDPOINTS=1 npm run dev:fake-vendors
//
// e, em outro terminal, exporte as variáveis que ele mostra antes de `npm run dev`. Nunca roda em produção: sem
// INTEGRATIONS_DEV_ENDPOINTS=1 ele se recusa a subir (e o servidor do chat só troca as URLs base com essa variável).
// Nenhum token daqui é de verdade.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FakeReply } from '../test/fake-http';
import { startFakeJira, type FakeAccount } from '../test/fake-jira';

if (process.env.INTEGRATIONS_DEV_ENDPOINTS !== '1' || process.env.NODE_ENV === 'production') {
  console.error('fake-vendors é só para desenvolvimento: rode com INTEGRATIONS_DEV_ENDPOINTS=1 (e sem NODE_ENV=production).');
  process.exit(1);
}

const jira = await startFakeJira();

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const html = (body: string): FakeReply => ({ headers: { 'content-type': 'text/html; charset=utf-8' }, body: `<!doctype html><meta charset="utf-8"><title>Consentimento (falso)</title>${body}` });
const bad = (text: string): FakeReply => ({ status: 400, body: { error: 'invalid_request', error_description: text } });

// Só volta para um endereço http(s); o código e o state vão na query, como no OAuth de verdade.
function backTo(redirectUri: string, params: Record<string, string | undefined>): FakeReply {
  let u: URL;
  try {
    u = new URL(redirectUri);
  } catch {
    return bad('redirect_uri inválido');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return bad('redirect_uri inválido');
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return { status: 302, headers: { location: u.toString() } };
}

// ---------- Jira ----------

// Pessoas que entram com token pessoal (Minha conta → Contas conectadas) e pelo OAuth.
const PEOPLE: Record<string, { account: FakeAccount; token: string }> = {
  ana: { account: jira.ana, token: 'tok-teste-pessoal-ana-0123456789' },
  bruno: { account: jira.bruno, token: 'tok-teste-pessoal-bruno-0123456789' },
};
for (const p of Object.values(PEOPLE)) jira.allowBasic(p.account, p.token);

jira.addIssue({ key: 'OPS-1', summary: 'Fila de atendimento parada no turno da noite', status: 'Tarefas pendentes', statusCategory: 'new', assignee: jira.ana });
jira.addIssue({ key: 'SUP-1', summary: 'Cliente sem acesso ao portal', status: 'Em andamento', reporter: jira.bruno });

// OAuth 2.0 (3LO): a "tela de consentimento" escolhe quem está entrando; o código vale para essa pessoa.
jira.server.on('GET', '/authorize', (r) => {
  const q = r.query;
  if (!q.redirect_uri) return bad('redirect_uri ausente');
  const choose = (extra: Record<string, string>) => `/authorize/escolher?${esc(new URLSearchParams({ ...extra, redirect_uri: q.redirect_uri, state: q.state ?? '' }).toString())}`;
  const links = Object.entries(PEOPLE)
    .map(([id, p]) => `<li><a href="${choose({ conta: id })}">${esc(p.account.displayName)} (${esc(p.account.email)})</a></li>`)
    .join('');
  return html(`<h1>Jira falso</h1><p>Quem está autorizando o Wescc Chat?</p><ul>${links}</ul><p><a href="${choose({ negar: '1' })}">Negar</a></p>`);
});
jira.server.on('GET', '/authorize/escolher', (r) => {
  const q = r.query;
  if (q.negar) return backTo(q.redirect_uri, { error: 'access_denied', state: q.state });
  const p = PEOPLE[q.conta];
  if (!p) return bad('conta desconhecida');
  const code = `tok-teste-codigo-jira-${crypto.randomBytes(8).toString('hex')}`;
  jira.oauthCodes.set(code, p.account.accountId);
  return backTo(q.redirect_uri, { code, state: q.state });
});

// Webhook opcional: com FAKE_JIRA_WEBHOOK_URL e FAKE_JIRA_WEBHOOK_SECRET (os da tela do Jira no chat), cada evento
// simulado também é entregue assinado. Sem eles, o modo de consulta acha a mudança na próxima rodada.
async function deliverJira(body: Record<string, unknown>): Promise<string> {
  const url = process.env.FAKE_JIRA_WEBHOOK_URL;
  const secret = process.env.FAKE_JIRA_WEBHOOK_SECRET;
  if (!url || !secret) return 'sem webhook (o modo de consulta acha a mudança)';
  const raw = JSON.stringify({ timestamp: Date.now(), ...body });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature': `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`,
        'x-atlassian-webhook-identifier': crypto.randomUUID(),
      },
      body: raw,
      signal: AbortSignal.timeout(10_000),
    });
    return `webhook ${res.status}`;
  } catch (e) {
    return `webhook falhou: ${(e as Error).message}`;
  }
}

const personRef = (a: FakeAccount | null) => (a ? { accountId: a.accountId, displayName: a.displayName, active: true } : null);

// POST /__fake/jira/issue-updated {key, summary?, status?, comment?, assignee?: 'ana' | 'bruno' | null, autor?: 'ana' | 'bruno'}
jira.server.on('POST', '/__fake/jira/issue-updated', async (r) => {
  const b = r.json ?? {};
  const key = String(b.key ?? '').toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) return bad('key precisa ser como OPS-1');
  const author = PEOPLE[String(b.autor ?? 'bruno')]?.account ?? jira.bruno;
  const issue = jira.issues.get(key);
  if (!issue) {
    const created = jira.addIssue({ key, summary: b.summary ? String(b.summary) : undefined, reporter: author });
    const via = await deliverJira({ webhookEvent: 'jira:issue_created', issue: created, user: personRef(author) });
    return { body: { ok: true, created: key, entrega: via } };
  }
  const items: { field: string; fromString?: string | null; toString?: string | null; from?: string | null; to?: string | null }[] = [];
  if (typeof b.status === 'string' && b.status) {
    items.push({ field: 'status', fromString: issue.fields.status?.name ?? null, toString: b.status });
    issue.fields.status = { name: b.status, statusCategory: { key: /conclu|feito|done|resolv/i.test(b.status) ? 'done' : 'indeterminate' } };
  }
  if (typeof b.summary === 'string' && b.summary) {
    items.push({ field: 'summary', fromString: issue.fields.summary, toString: b.summary });
    issue.fields.summary = b.summary;
  }
  if (b.assignee !== undefined) {
    const to = b.assignee === null ? null : (PEOPLE[String(b.assignee)]?.account ?? null);
    items.push({ field: 'assignee', fromString: issue.fields.assignee?.displayName ?? null, toString: to?.displayName ?? null, from: issue.fields.assignee?.accountId ?? null, to: to?.accountId ?? null });
    issue.fields.assignee = personRef(to);
  }
  const out: string[] = [];
  if (items.length) {
    const h = jira.addHistory(key, items, { author });
    out.push(await deliverJira({ webhookEvent: 'jira:issue_updated', issue, user: personRef(author), changelog: { id: h.id, items: h.items } }));
  }
  if (typeof b.comment === 'string' && b.comment) {
    const c = jira.addComment(key, b.comment, { author });
    out.push(await deliverJira({ webhookEvent: 'comment_created', issue, user: personRef(author), comment: c }));
  }
  if (!out.length) return bad('nada para mudar: mande status, summary, assignee ou comment');
  return { body: { ok: true, updated: key, entrega: out } };
});

// GET /__fake/jira/calls: as chamadas que o Jira falso recebeu (método, caminho e query; sem cabeçalhos nem corpo).
jira.server.on('GET', '/__fake/jira/calls', () => ({ body: { calls: jira.server.calls.filter((c) => !c.path.startsWith('/__fake/')).map((c) => ({ method: c.method, path: c.path, query: c.query })) } }));

// ---------- Registro das chamadas (sem cabeçalhos: nada de token na tela) ----------

const seen = { jira: 0 };
setInterval(() => {
  for (; seen.jira < jira.server.calls.length; seen.jira++) console.log(`[Jira falso] ${jira.server.calls[seen.jira].method} ${jira.server.calls[seen.jira].path}`);
}, 500).unref();

// ---------- Chave de segredos para desenvolvimento (fora da pasta do projeto) ----------

const keyFile = path.join(os.tmpdir(), 'wescc-dev-integrations-key.txt');
try {
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
}

// GET /__fake/info: o mesmo que a tela mostra, em JSON, para scripts de teste. Tudo falso.
const info = {
  env: {
    INTEGRATIONS_DEV_ENDPOINTS: '1',
    INTEGRATIONS_ALLOWED_HOSTS: jira.host,
    JIRA_API_GATEWAY: jira.origin,
    ATLASSIAN_AUTH_URL: jira.origin,
    SECRETS_KEY_FILE: keyFile,
  },
  jira: {
    siteUrl: jira.origin,
    accountEmail: jira.service.email,
    apiToken: jira.serviceToken,
    projects: jira.projects.map((p) => p.key),
    people: Object.fromEntries(Object.entries(PEOPLE).map(([id, p]) => [id, { email: p.account.email, token: p.token }])),
  },
};
jira.server.on('GET', '/__fake/info', () => ({ body: info }));

const tokens = Object.values(PEOPLE)
  .map((p) => `    ${p.account.email}, token ${p.token}`)
  .join('\n');
console.log(`Servidor falso no ar: Jira em ${jira.origin}. Exporte antes de "npm run dev":

export INTEGRATIONS_DEV_ENDPOINTS=1
export INTEGRATIONS_ALLOWED_HOSTS=${jira.host}
export JIRA_API_GATEWAY=${jira.origin}
export ATLASSIAN_AUTH_URL=${jira.origin}
export SECRETS_KEY_FILE=${keyFile}

Jira (Administração → Integrações → Jira):
  Endereço do Jira: ${jira.origin}
  Conta da integração: ${jira.service.email}, token ${jira.serviceToken}
  OAuth: ID e segredo do aplicativo, qualquer valor (o consentimento falso deixa escolher Ana ou Bruno)
  Token pessoal (Minha conta → Contas conectadas):
${tokens}
  Simular uma mudança: curl -X POST ${jira.origin}/__fake/jira/issue-updated -H 'content-type: application/json' -d '{"key":"OPS-1","status":"Concluído"}'
  (com FAKE_JIRA_WEBHOOK_URL e FAKE_JIRA_WEBHOOK_SECRET, a mudança também chega pelo webhook assinado)

Os mesmos dados em JSON: GET ${jira.origin}/__fake/info

Ctrl+C encerra.`);

const stop = () => {
  void Promise.allSettled([jira.close()]).finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

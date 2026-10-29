// Servidores falsos do Jira Cloud, do Microsoft 365 (login e Graph) e do Workflows do Teams, para desenvolver as
// integrações sem contas de verdade. São os mesmos dos testes (test/fake-jira.ts e test/fake-microsoft.ts), com uma
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
import type { FakeReply, FakeRequest } from '../test/fake-http';
import { startFakeJira, type FakeAccount } from '../test/fake-jira';
import { startFakeMicrosoft, type FakeChannel, type MsUser } from '../test/fake-microsoft';

if (process.env.INTEGRATIONS_DEV_ENDPOINTS !== '1' || process.env.NODE_ENV === 'production') {
  console.error('fake-vendors é só para desenvolvimento: rode com INTEGRATIONS_DEV_ENDPOINTS=1 (e sem NODE_ENV=production).');
  process.exit(1);
}

const jira = await startFakeJira();
const ms = await startFakeMicrosoft();

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

// ---------- Microsoft 365 ----------

const team = ms.addTeam('Operação (teste)', [{ name: 'Avisos do turno' }, { name: 'Suporte' }]);
const msPeople: Record<string, MsUser> = {
  ana: ms.addUser('Ana Souza', 'ana.souza@explorer-teste.com.br'),
  bruno: ms.addUser('Bruno Lima', 'bruno.lima@explorer-teste.com.br'),
};
const flowId = 'fluxo-falso-0001';

// Recebimento por notificações: o Graph chama o endereço público do chat (Site_Url, https). Com FAKE_MS_PUBLIC_URL
// (o Site_Url) e FAKE_MS_DELIVER_TO (onde o chat ouve aqui, http://127.0.0.1:porta), o aperto de mão e as
// notificações vão para o chat local.
if (process.env.FAKE_MS_PUBLIC_URL && process.env.FAKE_MS_DELIVER_TO) {
  ms.validation = { from: process.env.FAKE_MS_PUBLIC_URL.replace(/\/+$/, ''), to: process.env.FAKE_MS_DELIVER_TO.replace(/\/+$/, '') };
}

// Login da conta de serviço (código + PKCE): volta na hora com um código que o falso aceita na troca.
ms.server.on('GET', /^\/[^/]+\/oauth2\/v2\.0\/authorize$/, (r) => {
  const q = r.query;
  if (!q.redirect_uri || !q.code_challenge) return bad('redirect_uri e code_challenge são obrigatórios');
  const code = ms.issueCode({ challenge: q.code_challenge, redirectUri: q.redirect_uri, scope: q.scope ?? '' });
  return backTo(q.redirect_uri, { code, state: q.state });
});

const findChannel = (teamName: unknown, channelName: unknown): FakeChannel | null => {
  const t = ms.teams.find((x) => !teamName || x.displayName === teamName) ?? null;
  return t?.channels.find((c) => !channelName || c.displayName === channelName) ?? null;
};

// POST /__fake/teams/message {texto, canal?, time?, autor?: 'ana' | 'bruno', resposta?: id da mensagem raiz}
ms.server.on('POST', '/__fake/teams/message', async (r: FakeRequest) => {
  const b = r.json ?? {};
  const text = String(b.texto ?? b.text ?? '').trim();
  if (!text) return bad('texto é obrigatório');
  const channel = findChannel(b.time, b.canal);
  if (!channel) return bad('canal não encontrado');
  const author = msPeople[String(b.autor ?? 'ana')] ?? msPeople.ana;
  const root = b.resposta ? channel.messages.find((x) => x.data.id === String(b.resposta)) : null;
  if (b.resposta && !root) return bad('mensagem raiz não encontrada');
  const opts = { author, html: `<p>${esc(text)}</p>` };
  const msg = root ? ms.reply(root, opts) : ms.post(channel, opts);
  // Avisa as assinaturas deste canal, como o Graph faria (sem elas, a consulta delta acha a mensagem).
  const subs = [...ms.subscriptions.values()].filter((s) => {
    const res = decodeURIComponent(s.resource);
    return res.includes(channel.team.id) && res.includes(channel.id);
  });
  const avisos: string[] = [];
  for (const s of subs) {
    try {
      avisos.push(`assinatura ${(await ms.notify(s, msg)).status}`);
    } catch (e) {
      avisos.push(`assinatura falhou: ${(e as Error).message}`);
    }
  }
  return { body: { ok: true, id: msg.data.id, canal: channel.displayName, avisos } };
});

// GET /__fake/jira/calls: as chamadas que o Jira falso recebeu (método, caminho e query; sem cabeçalhos nem corpo).
jira.server.on('GET', '/__fake/jira/calls', () => ({ body: { calls: jira.server.calls.filter((c) => !c.path.startsWith('/__fake/')).map((c) => ({ method: c.method, path: c.path, query: c.query })) } }));

// GET /__fake/teams/flow-calls: os cartões que o fluxo recebeu (sem os cabeçalhos), para scripts de teste.
ms.server.on('GET', '/__fake/teams/flow-calls', () => ({ body: { calls: ms.flowCalls(flowId).map((c) => ({ at: c.at, card: c.card })) } }));

// ---------- Registro das chamadas (sem cabeçalhos: nada de token na tela) ----------

const seen = { jira: 0, ms: 0, flow: 0 };
setInterval(() => {
  for (; seen.jira < jira.server.calls.length; seen.jira++) console.log(`[Jira falso] ${jira.server.calls[seen.jira].method} ${jira.server.calls[seen.jira].path}`);
  for (; seen.ms < ms.server.calls.length; seen.ms++) console.log(`[Microsoft falso] ${ms.server.calls[seen.ms].method} ${ms.server.calls[seen.ms].path}`);
  const flows = ms.flowCalls(flowId);
  for (; seen.flow < flows.length; seen.flow++) {
    const first = flows[seen.flow].card?.body?.find?.((x: any) => typeof x?.text === 'string')?.text ?? '(sem texto)';
    console.log(`[Workflows falso] cartão recebido: ${String(first).slice(0, 120)}`);
  }
}, 500).unref();

// ---------- Chave de segredos para desenvolvimento (fora da pasta do projeto) ----------

const keyFile = path.join(os.tmpdir(), 'wescc-dev-integrations-key.txt');
try {
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
}

// GET /__fake/info (nos dois servidores): o mesmo que a tela mostra, em JSON, para scripts de teste. Tudo falso.
const info = {
  env: {
    INTEGRATIONS_DEV_ENDPOINTS: '1',
    INTEGRATIONS_ALLOWED_HOSTS: `${jira.host},${ms.host}`,
    JIRA_API_GATEWAY: jira.origin,
    ATLASSIAN_AUTH_URL: jira.origin,
    MS_LOGIN_URL: ms.url,
    MS_GRAPH_URL: ms.url,
    SECRETS_KEY_FILE: keyFile,
  },
  jira: {
    siteUrl: jira.origin,
    accountEmail: jira.service.email,
    apiToken: jira.serviceToken,
    projects: jira.projects.map((p) => p.key),
    people: Object.fromEntries(Object.entries(PEOPLE).map(([id, p]) => [id, { email: p.account.email, token: p.token }])),
  },
  msteams: {
    tenantId: ms.tenantId,
    clientId: ms.clientId,
    clientSecret: ms.clientSecret,
    serviceAccount: ms.service.userPrincipalName,
    team: team.displayName,
    channels: team.channels.map((c) => c.displayName),
    flowUrl: ms.flowUrl(flowId),
    people: Object.fromEntries(Object.entries(msPeople).map(([id, u]) => [id, u.mail ?? u.userPrincipalName])),
  },
};
jira.server.on('GET', '/__fake/info', () => ({ body: info }));
ms.server.on('GET', '/__fake/info', () => ({ body: info }));

const tokens = Object.values(PEOPLE)
  .map((p) => `    ${p.account.email}, token ${p.token}`)
  .join('\n');
console.log(`Servidores falsos no ar: Jira em ${jira.origin}, Microsoft em ${ms.url}. Exporte antes de "npm run dev":

export INTEGRATIONS_DEV_ENDPOINTS=1
export INTEGRATIONS_ALLOWED_HOSTS=${jira.host},${ms.host}
export JIRA_API_GATEWAY=${jira.origin}
export ATLASSIAN_AUTH_URL=${jira.origin}
export MS_LOGIN_URL=${ms.url}
export MS_GRAPH_URL=${ms.url}
export SECRETS_KEY_FILE=${keyFile}

Jira (Administração → Integrações → Jira):
  Endereço do Jira: ${jira.origin}
  Conta da integração: ${jira.service.email}, token ${jira.serviceToken}
  OAuth: ID e segredo do aplicativo, qualquer valor (o consentimento falso deixa escolher Ana ou Bruno)
  Token pessoal (Minha conta → Contas conectadas):
${tokens}
  Simular uma mudança: curl -X POST ${jira.origin}/__fake/jira/issue-updated -H 'content-type: application/json' -d '{"key":"OPS-1","status":"Concluído"}'
  (com FAKE_JIRA_WEBHOOK_URL e FAKE_JIRA_WEBHOOK_SECRET, a mudança também chega pelo webhook assinado)

Teams (Administração → Integrações → Teams):
  ID do locatário: ${ms.tenantId}
  ID do aplicativo (cliente): ${ms.clientId}
  Segredo do aplicativo: ${ms.clientSecret}
  Conta de serviço: ${ms.service.userPrincipalName}
  Time "${team.displayName}", canais: ${team.channels.map((c) => `"${c.displayName}"`).join(', ')}
  Endereço do fluxo do Workflows: ${ms.flowUrl(flowId)}
  Simular uma mensagem do Teams: curl -X POST ${ms.url}/__fake/teams/message -H 'content-type: application/json' -d '{"canal":"Avisos do turno","texto":"Bom dia, turno"}'
  Recebimento por notificações: suba com FAKE_MS_PUBLIC_URL (o Site_Url https do chat) e FAKE_MS_DELIVER_TO
  (http://127.0.0.1:<porta do chat>). Cartões recebidos pelo fluxo: GET ${ms.url}/__fake/teams/flow-calls

Os mesmos dados em JSON: GET ${ms.url}/__fake/info

Ctrl+C encerra.`);

const stop = () => {
  void Promise.allSettled([jira.close(), ms.close()]).finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

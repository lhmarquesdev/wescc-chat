import type { FakeReply, FakeRequest, FakeServer } from './fake-http';
import { startFake } from './fake-http';

// Jira Cloud falso para os testes: REST v3 (busca por JQL com nextPageToken, issues, comentários, histórico, createmeta),
// o gateway da Atlassian (/ex/jira/{cloudId}/…) e o OAuth 2.0 (3LO). Um servidor só faz o papel do site, do gateway e do
// auth.atlassian.com: os testes põem fake.host em INTEGRATIONS_ALLOWED_HOSTS e JIRA_API_GATEWAY / ATLASSIAN_AUTH_URL em fake.url.
// Os tokens são valores falsos (tok-teste-…); nada aqui é de uma conta real.

export interface FakeAccount {
  accountId: string;
  displayName: string;
  email: string;
  locale?: string;
}

export interface IssueInput {
  key: string;
  id?: string;
  summary?: string;
  status?: string;
  statusCategory?: 'new' | 'indeterminate' | 'done';
  type?: string;
  priority?: string;
  assignee?: FakeAccount | null;
  reporter?: FakeAccount | null;
  resolution?: string | null;
  security?: boolean;
  created?: Date | string;
  updated?: Date | string;
  labels?: string[];
}

export interface FakeJira {
  server: FakeServer;
  origin: string;
  host: string;
  cloudId: string;
  ana: FakeAccount;
  bruno: FakeAccount;
  service: FakeAccount; // a conta da integração
  serviceToken: string;
  deploymentType: string;
  issues: Map<string, any>; // por chave
  histories: Map<string, any[]>; // por id da issue, da mais antiga para a mais nova
  comments: Map<string, any[]>; // por id da issue
  projects: any[];
  createmeta: Record<string, { issueTypes: any[]; fields: Record<string, any[]> }>;
  created: any[]; // corpos de POST /issue
  remoteLinks: { key: string; body: any }[];
  postedComments: { key: string; body: any }[];
  assignments: { key: string; accountId: string | null }[];
  // Autorização aceita → accountId. gatewayOnly: só vale pelo gateway (/ex/jira/…), como os tokens com escopos.
  auth: Map<string, { accountId: string; gatewayOnly?: boolean }>;
  oauthCodes: Map<string, string>; // código → accountId
  refreshTokens: Map<string, string>; // refresh → accountId
  basic(email: string, token: string): string;
  allowBasic(account: FakeAccount, token: string, o?: { gatewayOnly?: boolean }): void;
  addIssue(p: IssueInput): any;
  addHistory(key: string, items: { field: string; from?: string | null; to?: string | null; fromString?: string | null; toString?: string | null; fieldId?: string }[], o?: { id?: string; at?: Date; author?: FakeAccount | null }): any;
  addComment(key: string, text: string, o?: { id?: string; at?: Date; author?: FakeAccount; jsdPublic?: boolean; visibility?: any; internalProperty?: boolean }): any;
  calls(match?: string | RegExp): FakeRequest[];
  // Resposta forçada (erro 500, 404…) antes das rotas normais; devolve a função que a remove. null/undefined: segue normal.
  intercept(fn: (req: FakeRequest) => FakeReply | null | undefined): () => void;
  close(): Promise<void>;
}

const ACC = (n: string): FakeAccount => ({ accountId: `712020:00000000-0000-4000-8000-0000000000${n}`, displayName: '', email: '' });

let seq = 0;
const iso = (d: Date | string | undefined, fallback = new Date()) => {
  const v = d === undefined ? fallback : typeof d === 'string' ? new Date(d) : d;
  return v.toISOString().replace('Z', '+0000');
};
const person = (a: FakeAccount | null | undefined) => (a ? { accountId: a.accountId, displayName: a.displayName, active: true, accountType: 'atlassian' } : null);
const adf = (text: string) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

// ---------- JQL mínimo: o bastante para o que o chat envia ----------

type Tok = { t: 'str' | 'word' | 'op' | 'p'; v: string };

function lex(jql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < jql.length) {
    const c = jql[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < jql.length && jql[j] !== '"') s += jql[j++];
      if (jql[j] !== '"') throw new Error('aspas sem fechar');
      out.push({ t: 'str', v: s });
      i = j + 1;
    } else if ('(),'.includes(c)) {
      out.push({ t: 'p', v: c });
      i++;
    } else if (/[=!~<>]/.test(c)) {
      let j = i;
      while (/[=!~<>]/.test(jql[j] ?? '')) j++;
      out.push({ t: 'op', v: jql.slice(i, j) });
      i = j;
    } else {
      let j = i;
      while (j < jql.length && !/[\s(),="!~<>]/.test(jql[j])) j++;
      out.push({ t: 'word', v: jql.slice(i, j) });
      i = j;
    }
  }
  return out;
}

type Pred = (issue: any) => boolean;

function parseJql(jql: string): { pred: Pred; order: { field: string; desc: boolean } | null } {
  const m = /\s+ORDER\s+BY\s+(\w+)(\s+(ASC|DESC))?\s*$/i.exec(jql);
  const order = m ? { field: m[1].toLowerCase(), desc: (m[3] ?? 'ASC').toUpperCase() === 'DESC' } : null;
  const body = m ? jql.slice(0, m.index) : jql;
  const toks = lex(body);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const word = (w: string) => peek()?.t === 'word' && peek()!.v.toUpperCase() === w;
  const value = (): string => {
    const t = next();
    if (!t || (t.t !== 'str' && t.t !== 'word')) throw new Error('valor esperado');
    return t.v;
  };
  const list = (): string[] => {
    if (next()?.v !== '(') throw new Error('( esperado');
    const vs: string[] = [];
    while (peek() && peek()!.v !== ')') {
      vs.push(value());
      if (peek()?.v === ',') next();
    }
    next();
    return vs;
  };
  const fieldOf = (issue: any, f: string): string[] => {
    const x = issue.fields;
    switch (f) {
      case 'issuekey':
      case 'key':
        return [issue.key];
      case 'project':
        return [x.project.key];
      case 'priority':
        return [x.priority?.name ?? ''];
      case 'status':
        return [x.status?.name ?? ''];
      case 'labels':
        return x.labels ?? [];
      case 'type':
      case 'issuetype':
        return [x.issuetype?.name ?? ''];
      default:
        throw new Error(`campo desconhecido: ${f}`);
    }
  };
  const clause = (): Pred => {
    if (peek()?.v === '(') {
      next();
      const e = expr();
      if (next()?.v !== ')') throw new Error(') esperado');
      return e;
    }
    const f = value().toLowerCase();
    if (word('IN')) {
      next();
      const vs = list().map((v) => v.toLowerCase());
      return (i) => fieldOf(i, f).some((v) => vs.includes(v.toLowerCase()));
    }
    if (word('IS')) {
      next();
      const not = word('NOT') ? (next(), true) : false;
      if (!word('EMPTY')) throw new Error('EMPTY esperado');
      next();
      if (f !== 'level') throw new Error('IS EMPTY só para level');
      return (i) => (not ? !!i.fields.security : !i.fields.security);
    }
    const op = next();
    if (op?.t !== 'op') throw new Error('operador esperado');
    const v = value();
    if (f === 'text' && op.v === '~') {
      const words = v.toLowerCase().split(/\s+/).filter(Boolean);
      return (i) => words.every((w) => `${i.fields.summary} ${i.fields.descriptionText ?? ''}`.toLowerCase().includes(w));
    }
    if (f === 'updated' || f === 'created') {
      const mm = /^-(\d+)m$/.exec(v);
      if (!mm) throw new Error('data relativa esperada');
      const since = Date.now() - Number(mm[1]) * 60_000;
      return (i) => new Date(i.fields[f]).getTime() >= since;
    }
    if (op.v === '=') return (i) => fieldOf(i, f).some((x) => x.toLowerCase() === v.toLowerCase());
    if (op.v === '!=') return (i) => !fieldOf(i, f).some((x) => x.toLowerCase() === v.toLowerCase());
    throw new Error(`operador ${op.v} não suportado`);
  };
  const and = (): Pred => {
    let l = clause();
    while (word('AND')) {
      next();
      const r = clause();
      const a = l;
      l = (i) => a(i) && r(i);
    }
    return l;
  };
  function expr(): Pred {
    let l = and();
    while (word('OR')) {
      next();
      const r = and();
      const a = l;
      l = (i) => a(i) || r(i);
    }
    return l;
  }
  const pred = toks.length ? expr() : () => true;
  if (p < toks.length) throw new Error(`sobrou: ${toks[p].v}`);
  return { pred, order };
}

// ---------- Servidor ----------

export async function startFakeJira(): Promise<FakeJira> {
  const server = await startFake();
  const cloudId = '11111111-2222-4333-8444-555555555555';
  const ana = { ...ACC('a1'), displayName: 'Ana Teste', email: 'ana.teste@explorer-teste.com.br' };
  const bruno = { ...ACC('b2'), displayName: 'Bruno Teste', email: 'bruno.teste@explorer-teste.com.br' };
  const service = { ...ACC('c3'), displayName: 'Conta de Serviço', email: 'jira.servico@explorer-teste.com.br', locale: 'pt_BR' };
  const accounts = new Map<string, FakeAccount>([ana, bruno, service].map((a) => [a.accountId, a]));
  const basic = (email: string, token: string) => `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  const serviceToken = 'tok-teste-integracao-0123456789';
  const interceptors: ((req: FakeRequest) => FakeReply | null | undefined)[] = [];

  const j: FakeJira = {
    server,
    origin: server.url,
    host: server.host,
    cloudId,
    ana,
    bruno,
    service,
    serviceToken,
    deploymentType: 'Cloud',
    issues: new Map(),
    histories: new Map(),
    comments: new Map(),
    projects: [
      { id: '10000', key: 'OPS', name: 'Operação', projectTypeKey: 'software' },
      { id: '10001', key: 'SUP', name: 'Suporte', projectTypeKey: 'service_desk' },
      { id: '10002', key: 'SECRET', name: 'Projeto restrito', projectTypeKey: 'software' },
    ],
    createmeta: {},
    created: [],
    remoteLinks: [],
    postedComments: [],
    assignments: [],
    auth: new Map([[basic(service.email, serviceToken), { accountId: service.accountId }]]),
    oauthCodes: new Map(),
    refreshTokens: new Map(),
    basic,
    allowBasic(account, token, o = {}) {
      accounts.set(account.accountId, account);
      j.auth.set(basic(account.email, token), { accountId: account.accountId, gatewayOnly: o.gatewayOnly });
    },
    addIssue(p) {
      const project = j.projects.find((x) => x.key === p.key.split('-')[0]) ?? { id: '10099', key: p.key.split('-')[0], name: p.key.split('-')[0], projectTypeKey: 'software' };
      const id = p.id ?? String(20000 + ++seq);
      const created = iso(p.created ?? new Date(Date.now() - 3600_000));
      const issue = {
        id,
        key: p.key,
        fields: {
          summary: p.summary ?? `Issue ${p.key}`,
          status: { name: p.status ?? 'Em andamento', statusCategory: { key: p.statusCategory ?? 'indeterminate' } },
          issuetype: { id: '10002', name: p.type ?? 'Tarefa', subtask: false, hierarchyLevel: 0 },
          priority: { id: '3', name: p.priority ?? 'Média' },
          assignee: person(p.assignee),
          reporter: person(p.reporter === undefined ? ana : p.reporter),
          project: { id: project.id, key: project.key, name: project.name, projectTypeKey: project.projectTypeKey },
          resolution: p.resolution ? { name: p.resolution } : null,
          security: p.security ? { id: '10100', name: 'Restrito' } : null,
          created,
          updated: iso(p.updated ?? created),
          labels: p.labels ?? [],
          description: adf('Descrição de teste.'),
          descriptionText: 'Descrição de teste.',
        },
      };
      j.issues.set(p.key, issue);
      return issue;
    },
    addHistory(key, items, o = {}) {
      const issue = j.issues.get(key)!;
      const at = o.at ?? new Date();
      const h = {
        id: o.id ?? String(50000 + ++seq),
        author: person(o.author === undefined ? bruno : o.author),
        created: iso(at),
        items: items.map((x) => ({ field: x.field, fieldId: x.fieldId ?? x.field, fieldtype: 'jira', from: x.from ?? null, fromString: x.fromString ?? null, to: x.to ?? null, toString: x.toString ?? null })),
      };
      const list = j.histories.get(issue.id) ?? [];
      list.push(h);
      j.histories.set(issue.id, list);
      if (new Date(issue.fields.updated) < at) issue.fields.updated = iso(at);
      return h;
    },
    addComment(key, text, o = {}) {
      const issue = j.issues.get(key)!;
      const at = o.at ?? new Date();
      const c: any = { id: o.id ?? String(60000 + ++seq), author: person(o.author ?? bruno), body: adf(text), created: iso(at), updated: iso(at) };
      if (o.jsdPublic !== undefined) c.jsdPublic = o.jsdPublic;
      if (o.visibility) c.visibility = o.visibility;
      if (o.internalProperty !== undefined) c.properties = [{ key: 'sd.public.comment', value: { internal: o.internalProperty } }];
      const list = j.comments.get(issue.id) ?? [];
      list.push(c);
      j.comments.set(issue.id, list);
      if (new Date(issue.fields.updated) < at) issue.fields.updated = iso(at);
      return c;
    },
    calls(match) {
      return server.calls.filter((c) => (match === undefined ? true : typeof match === 'string' ? c.path.endsWith(match) : match.test(c.path)));
    },
    intercept(fn) {
      interceptors.push(fn);
      return () => {
        const i = interceptors.indexOf(fn);
        if (i >= 0) interceptors.splice(i, 1);
      };
    },
    close: () => server.close(),
  };

  // Tipos de issue para criar: um simples, um com um campo obrigatório de cada tipo suportado e um com um campo que o
  // chat não preenche (lista em cascata).
  const priorities = [
    { id: '1', name: 'Alta' },
    { id: '3', name: 'Média' },
  ];
  const baseFields = [
    { key: 'summary', fieldId: 'summary', name: 'Resumo', required: true, schema: { type: 'string', system: 'summary' } },
    { key: 'description', fieldId: 'description', name: 'Descrição', required: false, schema: { type: 'string', system: 'description' } },
    { key: 'priority', fieldId: 'priority', name: 'Prioridade', required: false, schema: { type: 'priority', system: 'priority' }, allowedValues: priorities },
    { key: 'assignee', fieldId: 'assignee', name: 'Responsável', required: false, schema: { type: 'user', system: 'assignee' } },
    { key: 'reporter', fieldId: 'reporter', name: 'Relator', required: true, hasDefaultValue: true, schema: { type: 'user', system: 'reporter' } },
  ];
  const custom = (id: number, name: string, schema: any, extra: any = {}) => ({ key: `customfield_${id}`, fieldId: `customfield_${id}`, name, required: true, schema: { ...schema, customId: id }, ...extra });
  const meta = () => ({
    issueTypes: [
      { id: '10002', name: 'Tarefa', subtask: false, hierarchyLevel: 0 },
      { id: '10010', name: 'Chamado', subtask: false, hierarchyLevel: 0 },
      { id: '10011', name: 'Mudança', subtask: false, hierarchyLevel: 0 },
      { id: '10003', name: 'Subtarefa', subtask: true, hierarchyLevel: -1 },
    ],
    fields: {
      '10002': baseFields,
      '10010': [
        ...baseFields,
        custom(10101, 'Cliente', { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' }),
        custom(10102, 'Detalhes técnicos', { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea' }),
        custom(10103, 'Ramais afetados', { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' }),
        custom(10104, 'Data do incidente', { type: 'date', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker' }),
        custom(10105, 'Início', { type: 'datetime', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:datetime' }),
        custom(10106, 'Turno', { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' }, { allowedValues: [{ id: '201', value: 'Manhã' }, { id: '202', value: 'Noite' }] }),
        custom(10107, 'Canais', { type: 'array', items: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:multiselect' }, { allowedValues: [{ id: '301', value: 'Voz' }, { id: '302', value: 'Chat' }] }),
        custom(10108, 'Etiquetas', { type: 'array', items: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:labels' }),
        custom(10109, 'Supervisor', { type: 'user', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker' }),
      ],
      '10011': [...baseFields, custom(10120, 'Local e sala', { type: 'option-with-child', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:cascadingselect' })],
    },
  });
  j.createmeta.OPS = meta();
  j.createmeta.SUP = meta();

  const who = (req: FakeRequest, gateway: boolean): string | null => {
    const a = j.auth.get(req.headers.authorization ?? '');
    if (!a || (a.gatewayOnly && !gateway)) return null;
    return a.accountId;
  };
  const json = (body: unknown, status = 200): FakeReply => ({ status, body });
  const err = (status: number, msg: string): FakeReply => ({ status, body: { errorMessages: [msg], errors: {} } });
  const findIssue = (idOrKey: string) => [...j.issues.values()].find((i) => i.id === idOrKey || i.key === idOrKey) ?? null;
  const out = (issue: any) => {
    const { descriptionText: _d, ...fields } = issue.fields;
    return { id: issue.id, key: issue.key, fields };
  };

  async function api(req: FakeRequest, path: string, gateway: boolean): Promise<FakeReply> {
    const me = who(req, gateway);
    if (!me) return err(401, 'Client must be authenticated to access this resource.');
    const q = req.query;
    let m: RegExpExecArray | null;
    if (req.method === 'GET' && path === '/rest/api/3/serverInfo') return json({ baseUrl: j.origin, deploymentType: j.deploymentType, version: '1001.0.0' });
    if (req.method === 'GET' && path === '/rest/api/3/myself') {
      const a = accounts.get(me)!;
      return json({ accountId: a.accountId, displayName: a.displayName, emailAddress: a.email, locale: a.locale ?? 'pt_BR', active: true });
    }
    if (req.method === 'GET' && path === '/rest/api/3/project/search') {
      const query = String(q.query ?? '').toLowerCase();
      const values = j.projects.filter((p) => !query || p.key.toLowerCase().includes(query) || p.name.toLowerCase().includes(query));
      return json({ values, total: values.length, isLast: true });
    }
    if (req.method === 'GET' && (m = /^\/rest\/api\/3\/project\/([^/]+)$/.exec(path))) {
      const p = j.projects.find((x) => x.key === decodeURIComponent(m![1]));
      return p ? json(p) : err(404, 'Projeto não encontrado.');
    }
    if (req.method === 'POST' && path === '/rest/api/3/jql/parse') {
      const queries = (req.json?.queries ?? []).map((query: string) => {
        try {
          parseJql(query);
          return { query, errors: [] };
        } catch (e) {
          return { query, errors: [`Erro na consulta: ${(e as Error).message}.`] };
        }
      });
      return json({ queries });
    }
    if ((req.method === 'GET' && path === '/rest/api/3/search/jql') || (req.method === 'POST' && path === '/rest/api/3/search/approximate-count')) {
      const jql = String(req.method === 'GET' ? q.jql : req.json?.jql ?? '');
      let parsed;
      try {
        parsed = parseJql(jql);
      } catch (e) {
        return err(400, `Erro na consulta JQL: ${(e as Error).message}.`);
      }
      let list = [...j.issues.values()].filter(parsed.pred);
      if (req.method === 'POST') return json({ count: list.length });
      const o = parsed.order;
      list.sort((a, b) => {
        if (!o) return a.key.localeCompare(b.key);
        const va = new Date(a.fields[o.field] ?? 0).getTime();
        const vb = new Date(b.fields[o.field] ?? 0).getTime();
        return o.desc ? vb - va : va - vb;
      });
      const start = q.nextPageToken ? Number(Buffer.from(q.nextPageToken, 'base64url').toString()) : 0;
      const max = Math.min(100, Number(q.maxResults ?? 50));
      const page = list.slice(start, start + max);
      const more = start + max < list.length;
      const expand = String(q.expand ?? '').split(',').includes('changelog');
      const issues = page.map((i) => {
        const o2: any = out(i);
        if (expand) {
          const hs = j.histories.get(i.id) ?? [];
          // Como o Jira: no máximo 100 históricos junto da busca (os mais antigos), total com todos.
          o2.changelog = { startAt: 0, maxResults: Math.min(100, hs.length), total: hs.length, histories: hs.slice(0, 100) };
        }
        return o2;
      });
      return json({ issues, ...(more ? { nextPageToken: Buffer.from(String(start + max)).toString('base64url') } : {}), isLast: !more });
    }
    if (req.method === 'GET' && (m = /^\/rest\/api\/3\/issue\/createmeta\/([^/]+)\/issuetypes(?:\/([^/]+))?$/.exec(path))) {
      const cm = j.createmeta[decodeURIComponent(m[1])];
      if (!cm) return err(404, 'Projeto não encontrado.');
      if (!m[2]) return json({ issueTypes: cm.issueTypes, maxResults: 50, startAt: 0, total: cm.issueTypes.length });
      const fields = cm.fields[m[2]];
      return fields ? json({ fields, maxResults: 200, startAt: 0, total: fields.length }) : err(404, 'Tipo não encontrado.');
    }
    if (req.method === 'POST' && path === '/rest/api/3/issue') {
      const f = req.json?.fields ?? {};
      const projectKey = String(f.project?.key ?? '');
      const cm = j.createmeta[projectKey];
      if (!cm) return err(400, 'Projeto inválido.');
      const type = cm.issueTypes.find((t) => t.id === f.issuetype?.id);
      if (!type) return err(400, 'Tipo de issue inválido.');
      const n = [...j.issues.keys()].filter((k) => k.startsWith(`${projectKey}-`)).length + 100;
      const key = `${projectKey}-${n}`;
      const issue = j.addIssue({ key, summary: String(f.summary ?? ''), type: type.name, priority: f.priority?.id === '1' ? 'Alta' : 'Média', reporter: accounts.get(me) ?? null, status: 'Aberta', statusCategory: 'new' });
      if (f.assignee?.accountId) issue.fields.assignee = person(accounts.get(f.assignee.accountId) ?? { accountId: f.assignee.accountId, displayName: 'Alguém', email: '' });
      issue.fields.created = issue.fields.updated = iso(new Date());
      j.created.push({ by: me, body: req.json, key });
      return json({ id: issue.id, key, self: `${j.origin}/rest/api/3/issue/${issue.id}` }, 201);
    }
    if ((m = /^\/rest\/api\/3\/issue\/([^/]+)(\/.*)?$/.exec(path))) {
      const issue = findIssue(decodeURIComponent(m[1]));
      const rest = m[2] ?? '';
      if (!issue) return err(404, 'Issue does not exist or you do not have permission to see it.');
      if (req.method === 'GET' && !rest) return json(out(issue));
      if (req.method === 'GET' && rest === '/changelog') {
        const hs = j.histories.get(issue.id) ?? [];
        const startAt = Number(q.startAt ?? 0);
        const max = Number(q.maxResults ?? 100);
        const values = hs.slice(startAt, startAt + max);
        return json({ startAt, maxResults: max, total: hs.length, isLast: startAt + max >= hs.length, values });
      }
      if (req.method === 'GET' && rest === '/comment') {
        const cs = [...(j.comments.get(issue.id) ?? [])].sort((a, b) => (String(q.orderBy).startsWith('-') ? b.created.localeCompare(a.created) : a.created.localeCompare(b.created)));
        return json({ startAt: 0, maxResults: 50, total: cs.length, comments: cs.slice(0, Number(q.maxResults ?? 50)) });
      }
      if (req.method === 'GET' && (m = /^\/comment\/([^/]+)$/.exec(rest))) {
        const c = (j.comments.get(issue.id) ?? []).find((x) => x.id === m![1]);
        return c ? json(c) : err(404, 'Comentário não encontrado.');
      }
      if (req.method === 'POST' && rest === '/comment') {
        j.postedComments.push({ key: issue.key, body: req.json });
        const internal = (req.json?.properties ?? []).some((p: any) => p.key === 'sd.public.comment' && p.value?.internal);
        const c = j.addComment(issue.key, 'comentário do chat', { author: accounts.get(me), jsdPublic: !internal });
        return json({ id: c.id }, 201);
      }
      if (req.method === 'PUT' && rest === '/assignee') {
        const acc = req.json?.accountId ?? null;
        j.assignments.push({ key: issue.key, accountId: acc });
        issue.fields.assignee = acc ? person(accounts.get(acc) ?? { accountId: acc, displayName: 'Alguém', email: '' }) : null;
        return { status: 204 };
      }
      if (req.method === 'POST' && rest === '/remotelink') {
        j.remoteLinks.push({ key: issue.key, body: req.json });
        return json({ id: 1, self: `${j.origin}/rest/api/3/issue/${issue.key}/remotelink/1` }, 201);
      }
    }
    if (req.method === 'GET' && path === '/rest/api/3/user/assignable/search') {
      const query = String(q.query ?? '').toLowerCase();
      return json([...accounts.values()].filter((a) => a !== service && (!query || a.displayName.toLowerCase().includes(query))).map((a) => ({ accountId: a.accountId, displayName: a.displayName, accountType: 'atlassian', active: true })));
    }
    return err(404, `Não implementado no falso: ${req.method} ${path}`);
  }

  async function oauth(req: FakeRequest): Promise<FakeReply> {
    const b = req.json ?? {};
    if (b.grant_type === 'authorization_code') {
      const acc = j.oauthCodes.get(String(b.code));
      if (!acc) return json({ error: 'invalid_grant' }, 403);
      j.oauthCodes.delete(String(b.code));
      return json(issueTokens(acc));
    }
    if (b.grant_type === 'refresh_token') {
      const acc = j.refreshTokens.get(String(b.refresh_token));
      if (!acc) return json({ error: 'invalid_grant', error_description: 'Unknown or invalid refresh token.' }, 403);
      j.refreshTokens.delete(String(b.refresh_token)); // a Atlassian gira o refresh token
      return json(issueTokens(acc));
    }
    return json({ error: 'unsupported_grant_type' }, 400);
  }
  function issueTokens(accountId: string) {
    const n = ++seq;
    const access = `tok-teste-acesso-${n}`;
    const refresh = `tok-teste-renovacao-${n}`;
    j.auth.set(`Bearer ${access}`, { accountId, gatewayOnly: true });
    j.refreshTokens.set(refresh, accountId);
    return { access_token: access, refresh_token: refresh, expires_in: 3600, scope: 'read:jira-work write:jira-work read:jira-user read:me offline_access', token_type: 'Bearer' };
  }

  server.on('*', /.*/, async (req) => {
    for (const fn of [...interceptors]) {
      const r = fn(req);
      if (r) return r;
    }
    if (req.method === 'GET' && req.path === '/_edge/tenant_info') return json({ cloudId });
    if (req.method === 'POST' && req.path === '/oauth/token') return oauth(req);
    if (req.method === 'GET' && req.path === '/oauth/token/accessible-resources') {
      if (!j.auth.has(req.headers.authorization ?? '')) return err(401, 'Unauthorized');
      return json([{ id: cloudId, url: j.origin, name: 'explorer-teste', scopes: ['read:jira-work', 'write:jira-work'] }]);
    }
    const gw = /^\/ex\/jira\/([^/]+)(\/.*)$/.exec(req.path);
    if (gw) {
      if (gw[1] !== cloudId) return err(404, 'Site não encontrado.');
      return api(req, gw[2], true);
    }
    return api(req, req.path, false);
  });

  return j;
}

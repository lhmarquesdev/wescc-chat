import http from 'node:http';

// Servidor HTTP falso para os testes das integrações (Jira, Microsoft 365, Workflows). Nada sai para a internet:
// os testes põem fake.host em INTEGRATIONS_ALLOWED_HOSTS e apontam as URLs base (endpoints.ts) para fake.url.

export interface FakeRequest {
  method: string;
  path: string; // só o caminho, sem a query
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  json: any; // corpo como JSON, ou null quando não é JSON
}

export interface FakeReply {
  status?: number; // padrão 200
  headers?: Record<string, string>;
  body?: unknown; // string e Buffer vão como estão; o resto vira JSON
  delayMs?: number; // espera antes de responder (testes de tempo limite)
}

export type FakeHandler = (req: FakeRequest) => FakeReply | Promise<FakeReply>;

export interface FakeServer {
  url: string; // http://127.0.0.1:<porta>
  host: string; // 127.0.0.1:<porta>
  calls: FakeRequest[]; // todas as chamadas recebidas, em ordem (também as sem handler)
  // O handler registrado por último ganha. method '*' vale para qualquer método; path string compara o caminho inteiro.
  on(method: string, path: string | RegExp, h: FakeHandler): void;
  reset(): void; // esquece as chamadas e os handlers
  close(): Promise<void>;
}

// http em 127.0.0.1:0; responde 404 JSON ao que não foi registrado.
export async function startFake(): Promise<FakeServer> {
  const handlers: { method: string; path: string | RegExp; h: FakeHandler }[] = [];
  const calls: FakeRequest[] = [];
  const sockets = new Set<import('node:net').Socket>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const u = new URL(req.url ?? '/', 'http://fake.local');
        const body = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try {
          json = body ? JSON.parse(body) : null;
        } catch {
          json = null;
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
        const fr: FakeRequest = { method: req.method ?? 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), headers, body, json };
        calls.push(fr);
        const match = [...handlers]
          .reverse()
          .find((x) => (x.method === '*' || x.method.toUpperCase() === fr.method) && (typeof x.path === 'string' ? x.path === fr.path : x.path.test(fr.path)));
        let reply: FakeReply;
        try {
          reply = match ? await match.h(fr) : { status: 404, body: { error: 'not-found', path: fr.path } };
        } catch (e) {
          reply = { status: 500, body: { error: String((e as Error)?.message ?? e) } };
        }
        if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
        if (res.destroyed) return;
        const out = { ...(reply.headers ?? {}) };
        let payload: string | Buffer = '';
        if (typeof reply.body === 'string' || Buffer.isBuffer(reply.body)) payload = reply.body;
        else if (reply.body !== undefined) {
          payload = JSON.stringify(reply.body);
          if (!Object.keys(out).some((k) => k.toLowerCase() === 'content-type')) out['content-type'] = 'application/json';
        }
        res.writeHead(reply.status ?? 200, out);
        res.end(payload);
      })();
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as import('node:net').AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    calls,
    on(method, path, h) {
      handlers.push({ method, path, h });
    },
    reset() {
      handlers.length = 0;
      calls.length = 0;
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

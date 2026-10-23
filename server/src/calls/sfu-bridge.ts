import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import type { CallSource } from '@shared/index';
import { config } from '../config';
import { one } from '../db/pool';
import { parseJoinClaims, sfuConfig, verifyJwt, type JoinClaims } from './livekit';
import { bridgeAdmission } from './model';

// Ponte do /sfu: o navegador fala com o LiveKit só pela origem do chat. Cada conexão (inclusive as retomadas que o
// LiveKit faz com tokens renovados por ele) passa pela admissão antes de qualquer coisa ir para o LiveKit.

const BRIDGED = /^\/sfu\/rtc(?:\/v1)?\/?$/;
const MAX_PER_IDENTITY = 4;
const MAX_PER_IP = 50;
const MAX_BUFFER = 8 << 20;
// Duração máxima (exp - nbf) de um token de autoteste: os 10 min do token renovado pelo LiveKit, mais a folga.
const SELF_TEST_MAX_SECONDS = 610;
const TEXTS: Record<number, string> = {
  401: 'acesso recusado',
  403: 'acesso recusado',
  404: 'Não encontrado.',
  429: 'acesso recusado',
  502: 'Servidor de chamadas indisponível.',
  503: 'Servidor de chamadas indisponível.',
};

type Log = { info: (o: object, m: string) => void; debug: (o: object, m: string) => void; warn: (o: object, m: string) => void };
let log: Log = { info() {}, debug() {}, warn() {} };
// O app passa o logger dele (pino), para os registros da ponte saírem junto com os do chat.
export function useBridgeLogger(l: Log) {
  log = l;
}

// /sfu ou /sfu/...
export function isSfuUpgrade(url: string | undefined): boolean {
  const p = (url ?? '').split('?')[0];
  return p === '/sfu' || p.startsWith('/sfu/');
}

// ---------- IP de quem conecta ----------

// Mesmos nomes que o Fastify aceita em TRUST_PROXY.
const NAMED: Record<string, [string, number, 'ipv4' | 'ipv6'][]> = {
  loopback: [['127.0.0.0', 8, 'ipv4'], ['::1', 128, 'ipv6']],
  linklocal: [['169.254.0.0', 16, 'ipv4'], ['fe80::', 10, 'ipv6']],
  uniquelocal: [['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['fc00::', 7, 'ipv6']],
};

const plainIp = (a: string) => {
  const s = a.trim().replace(/^\[|\]$/g, '');
  return /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s) ? s.slice(7) : s;
};
const family = (a: string): 'ipv4' | 'ipv6' => (net.isIPv4(a) ? 'ipv4' : 'ipv6');

function maskBits(mask: string) {
  return mask.split('.').reduce((n, o) => n + (Number(o) >>> 0).toString(2).replace(/0/g, '').length, 0);
}

let trustCache: { src: unknown; check: (a: string) => boolean } | null = null;
function trusted(addr: string): boolean {
  const t = config.trustProxy;
  if (t === true) return true;
  if (!t || !Array.isArray(t)) return false;
  if (trustCache?.src !== t) {
    const list = new net.BlockList();
    for (const e of t) {
      if (NAMED[e]) {
        for (const [a, bits, f] of NAMED[e]) list.addSubnet(a, bits, f);
        continue;
      }
      const [a, bits] = e.split('/');
      const f = family(a);
      if (bits === undefined) list.addAddress(a, f);
      else list.addSubnet(a, net.isIPv4(bits) ? maskBits(bits) : Number(bits), f);
    }
    trustCache = { src: t, check: (a) => net.isIP(a) > 0 && list.check(a, family(a)) };
  }
  return trustCache.check(addr);
}

// Endereço do cliente: o do socket; o X-Forwarded-For só conta a partir de um proxy confiável (TRUST_PROXY), da
// direita para a esquerda, como o Fastify faz para req.ip.
export function clientIp(remote: string | undefined, forwarded: string | string[] | undefined): string {
  const socketIp = plainIp(remote ?? '');
  const chain = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '')
    .split(',')
    .map(plainIp)
    .filter((x) => net.isIP(x) > 0)
    .reverse();
  let ip = socketIp;
  for (const hop of chain) {
    if (!trusted(ip)) break;
    ip = hop;
  }
  return ip;
}

// ---------- Admissão ----------

const openByIdentity = new Map<string, number>();
const openByIp = new Map<string, number>();

const bump = (m: Map<string, number>, k: string, d: number) => {
  const n = (m.get(k) ?? 0) + d;
  if (n > 0) m.set(k, n);
  else m.delete(k);
};

// Recusas do último minuto, contadas por segundo: custo e memória fixos por recusa, mesmo com uma enxurrada de
// tokens lixo (que não passa pelo limitador do Fastify).
const SLOTS = 60;
const slotCount = new Array<number>(SLOTS).fill(0);
const slotSecond = new Array<number>(SLOTS).fill(-1);
// No log, no máximo LOGGED_PER_SECOND recusas por segundo; o resto só entra na contagem.
const LOGGED_PER_SECOND = 20;

// Devolve quantas recusas já houve neste segundo, contando esta.
function noteRefusal(): number {
  const second = Math.floor(Date.now() / 1000);
  const i = second % SLOTS;
  if (slotSecond[i] !== second) {
    slotSecond[i] = second;
    slotCount[i] = 0;
  }
  return ++slotCount[i];
}

export function bridgeStats(): { open: number; refusedLastMinute: number } {
  const second = Math.floor(Date.now() / 1000);
  let refused = 0;
  for (let i = 0; i < SLOTS; i++) if (slotSecond[i] > second - SLOTS && slotSecond[i] <= second) refused += slotCount[i];
  let open = 0;
  for (const n of openByIdentity.values()) open += n;
  return { open, refusedLastMinute: refused };
}

const ALL_SOURCES: CallSource[] = ['microphone', 'camera', 'screen_share', 'screen_share_audio'];

// Nenhuma fonte além das que a linha concede agora. O LiveKit monta a sessão nova com o que o token traz, e um token
// de antes de uma pausa (o primeiro, ou um renovado por ele antes do UpdateParticipant) ainda vale por até 10 min.
async function publishWithinGrant(j: JoinClaims): Promise<boolean> {
  if (!j.canPublish) return true;
  const row = await one('SELECT granted_publish, granted_sources FROM call_participants WHERE call_id = $1 AND user_id = $2', [j.room.slice(3), j.identity]);
  if (!row?.granted_publish) return false;
  const granted = new Set<string>(row.granted_sources ?? []);
  return (j.sources ?? ALL_SOURCES).every((s) => granted.has(s));
}

export type SfuAdmission =
  | { ok: true; identity: string; room: string; ip: string; release: () => void }
  | { ok: false; status: 401 | 403 | 429 | 503; identity: string | null; room: string | null; ip: string };

// A mesma admissão vale para o WebSocket e para o /validate. Com reserve, ocupa uma vaga (liberada por release);
// a contagem e a reserva acontecem juntas, depois da consulta, para conexões simultâneas não passarem do limite.
export async function sfuAdmission(token: string | null, ip: string, o: { reserve?: boolean } = {}): Promise<SfuAdmission> {
  const refuse = (status: 401 | 403 | 429 | 503, identity: string | null = null, room: string | null = null): SfuAdmission => {
    const n = noteRefusal();
    if (n <= LOGGED_PER_SECOND) log.info({ identity, room, ip, status }, 'Ponte do servidor de chamadas recusou a conexão.');
    else if (n === LOGGED_PER_SECOND + 1) log.warn({ ip, status }, 'Muitas recusas na ponte do servidor de chamadas: as demais deste segundo só entram na contagem.');
    return { ok: false, status, identity, room, ip };
  };
  const c = sfuConfig();
  if (!c.configured) return refuse(503);
  if (!token) return refuse(401);
  const claims = verifyJwt(token, c.apiSecret, { issuer: c.apiKey });
  if (!claims) return refuse(401);
  const j = parseJoinClaims(claims);
  if (j.forbidden) return refuse(403, j.identity || null, j.room || null);
  if (j.room.startsWith('wc_test_')) {
    // Autoteste: não há linha de participante; basta uma pessoa ativa e um token curto. O nosso vale 5 min; o que o
    // LiveKit renova logo depois da entrada vale 10 min, e é com ele que a etapa de retomada do ConnectionCheck volta.
    const active = await one('SELECT 1 FROM users WHERE id = $1 AND active', [j.identity]);
    if (!active || j.exp - j.nbf > SELF_TEST_MAX_SECONDS) return refuse(403, j.identity, j.room);
  } else {
    const a = await bridgeAdmission({ identity: j.identity, sfuRoom: j.room, hidden: j.hidden });
    if (!a.ok || !(await publishWithinGrant(j))) return refuse(403, j.identity, j.room);
  }
  if ((openByIdentity.get(j.identity) ?? 0) >= MAX_PER_IDENTITY || (openByIp.get(ip) ?? 0) >= MAX_PER_IP) return refuse(429, j.identity, j.room);
  let released = !o.reserve;
  if (o.reserve) {
    bump(openByIdentity, j.identity, 1);
    bump(openByIp, ip, 1);
  }
  return {
    ok: true,
    identity: j.identity,
    room: j.room,
    ip,
    release: () => {
      if (released) return;
      released = true;
      bump(openByIdentity, j.identity, -1);
      bump(openByIp, ip, -1);
    },
  };
}

// ---------- Ponte ----------

const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20, perMessageDeflate: false });
// Pontes abertas (e as que ainda esperam o LiveKit), para fechar tudo quando o chat para: o livekit-client
// retoma sozinho na outra instância ou quando o chat volta.
const live = new Set<() => void>();

export function closeBridges() {
  for (const close of [...live]) close();
}

function writeStatus(socket: Duplex, status: number, body = TEXTS[status] ?? http.STATUS_CODES[status] ?? '') {
  if (socket.destroyed) return;
  const text = `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Erro'}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  socket.once('finish', () => socket.destroy());
  socket.end(text);
}

// Quando o ws recusa um quadro (grande demais, UTF-8 inválido) ele fecha com o código certo, mas o evento de close
// chega com 1006 porque o socket para de ser lido; o código vem do erro, para o outro lado receber o mesmo.
const ERROR_CLOSE: Record<string, number> = { WS_ERR_UNSUPPORTED_MESSAGE_LENGTH: 1009, WS_ERR_INVALID_UTF8: 1007 };
// Códigos que não podem ir num quadro de fechamento viram 1011.
const sendable = (code: number) => (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999);

export function sfuUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
  socket.on('error', () => socket.destroy());
  const url = req.url ?? '/';
  const q = url.indexOf('?');
  const pathname = q < 0 ? url : url.slice(0, q);
  const query = q < 0 ? '' : url.slice(q);
  // Só a sinalização; nunca /sfu/twirp nem outro caminho do LiveKit.
  if (!BRIDGED.test(pathname)) return writeStatus(socket, 404);
  // As mesmas conferências do handleUpgrade do ws, antes de abrir o LiveKit à toa.
  const key = String(req.headers['sec-websocket-key'] ?? '');
  const version = String(req.headers['sec-websocket-version'] ?? '');
  if (req.method !== 'GET' || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || !/^[+/0-9A-Za-z]{22}==$/.test(key) || (version !== '13' && version !== '8')) {
    return writeStatus(socket, 400, 'Requisição inválida.');
  }
  const ip = clientIp(req.socket.remoteAddress, req.headers['x-forwarded-for']);
  const token = new URLSearchParams(query.slice(1)).get('access_token');
  void sfuAdmission(token, ip, { reserve: true })
    .then((a) => {
      if (!a.ok) return writeStatus(socket, a.status);
      if (socket.destroyed) return a.release();
      openUpstream(req, socket, head, pathname, query, a);
    })
    .catch((e) => {
      log.warn({ ip, err: (e as Error)?.message }, 'Falha na admissão da ponte do servidor de chamadas.');
      writeStatus(socket, 503);
    });
}

function openUpstream(req: http.IncomingMessage, socket: Duplex, head: Buffer, pathname: string, query: string, a: Extract<SfuAdmission, { ok: true }>) {
  const base = sfuConfig().url.replace(/^http/, 'ws');
  const path = pathname.replace(/^\/sfu/, '').replace(/\/$/, '');
  const headers: Record<string, string> = {};
  if (req.headers['user-agent']) headers['user-agent'] = String(req.headers['user-agent']);
  const started = Date.now();
  let settled = false;
  const upstream = new WebSocket(base + path + query, { maxPayload: 8 << 20, perMessageDeflate: false, handshakeTimeout: 10_000, headers });

  const fail = (status: number, body?: string) => {
    live.delete(abort);
    if (settled) return;
    settled = true;
    a.release();
    writeStatus(socket, status, body);
  };
  // O cliente desistiu antes do LiveKit responder.
  const onClientGone = () => {
    live.delete(abort);
    if (settled) return;
    settled = true;
    a.release();
    upstream.terminate();
  };
  const abort = () => {
    onClientGone();
    socket.destroy();
  };
  live.add(abort);
  socket.once('close', onClientGone);

  // Recusa do LiveKit (por exemplo, sala que não existe): mesmo status e o texto curto dele.
  upstream.on('unexpected-response', (_r, res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (d: string) => {
      if (body.length < 1024) body += d;
    });
    const done = () => {
      fail(res.statusCode ?? 502, body.slice(0, 1024));
      upstream.terminate();
    };
    res.once('end', done);
    res.once('error', done);
    res.once('aborted', done);
  });
  upstream.on('error', () => fail(502));
  upstream.once('open', () => {
    live.delete(abort);
    if (settled) return upstream.terminate();
    settled = true;
    socket.off('close', onClientGone);
    let upgraded = false;
    socket.once('close', () => {
      if (upgraded) return;
      a.release();
      upstream.terminate();
    });
    wss.handleUpgrade(req, socket, head, (client) => {
      upgraded = true;
      pump(client, upstream, a, started);
    });
  });
}

function pump(client: WebSocket, upstream: WebSocket, a: Extract<SfuAdmission, { ok: true }>, started: number) {
  let closing = false;
  let done = false;
  let code = 1000;
  const finish = () => {
    if (!done && client.readyState === WebSocket.CLOSED && upstream.readyState === WebSocket.CLOSED) {
      done = true;
      live.delete(goingAway);
      a.release();
      log.debug({ identity: a.identity, room: a.room, durationMs: Date.now() - started, code }, 'Ponte do servidor de chamadas fechada.');
    }
  };
  const closeBoth = (c: number) => {
    if (closing) return;
    closing = true;
    code = c;
    for (const w of [client, upstream]) if (w.readyState === WebSocket.OPEN) w.close(c);
    // Um lado travado pode nunca responder ao fechamento.
    setTimeout(() => {
      client.terminate();
      upstream.terminate();
    }, 2000).unref();
  };
  const forward = (from: WebSocket, to: WebSocket) => {
    let errorCode = 0;
    from.on('message', (data, isBinary) => {
      if (to.readyState !== WebSocket.OPEN) return;
      to.send(data, { binary: isBinary });
      if (to.bufferedAmount > MAX_BUFFER) closeBoth(1013);
    });
    from.on('close', (closeCode, reason) => {
      const c = closeCode === 1006 && errorCode ? errorCode : closeCode;
      if (!closing) {
        closing = true;
        code = c;
        if (to.readyState === WebSocket.OPEN) to.close(sendable(c) ? c : 1011, reason);
        else if (to.readyState === WebSocket.CONNECTING) to.terminate();
        setTimeout(() => to.terminate(), 2000).unref();
      }
      finish();
    });
    from.on('error', (e: Error & { code?: string }) => {
      errorCode = ERROR_CLOSE[e.code ?? ''] ?? (e.code?.startsWith('WS_ERR_') ? 1002 : 0);
    });
  };
  const goingAway = () => closeBoth(1001);
  live.add(goingAway);
  forward(client, upstream);
  forward(upstream, client);
}

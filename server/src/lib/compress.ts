import { promisify } from 'node:util';
import zlib from 'node:zlib';
import type { FastifyReply, FastifyRequest } from 'fastify';

// Compressão das respostas JSON da API (br ou gzip, o que o navegador aceitar). A lista de conversas e o histórico de
// uma sala têm dezenas de KB e caem para um décimo; numa VPN ou no 4G isso pesa na abertura do chat. O JS e o CSS do
// build já saem comprimidos do disco (preCompressed em app.ts).

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const MIN_BYTES = 1024;

// O primeiro formato aceito (q > 0), preferindo br.
function pickEncoding(header: string | string[] | undefined): 'br' | 'gzip' | null {
  const accepted = new Set<string>();
  for (const part of String(header ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    if (name && !(q && Number(q.slice(2)) === 0)) accepted.add(name);
  }
  return accepted.has('br') ? 'br' : accepted.has('gzip') ? 'gzip' : null;
}

function addVary(reply: FastifyReply) {
  const vary = String(reply.getHeader('vary') ?? '');
  if (!/\baccept-encoding\b/i.test(vary)) reply.header('vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
}

export async function compressJson(req: FastifyRequest, reply: FastifyReply, payload: unknown) {
  if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload; // arquivos e downloads saem como estão
  if (reply.hasHeader('content-encoding') || !String(reply.getHeader('content-type') ?? '').startsWith('application/json')) return payload;
  const size = Buffer.byteLength(payload);
  if (size < MIN_BYTES) return payload;
  addVary(reply);
  const encoding = pickEncoding(req.headers['accept-encoding']);
  if (!encoding) return payload;
  // Nível rápido: a resposta é comprimida a cada pedido.
  const out =
    encoding === 'br'
      ? await brotli(payload, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size } })
      : await gzip(payload, { level: 6 });
  reply.header('content-encoding', encoding);
  reply.removeHeader('content-length');
  return out;
}

// Arquivos de web/dist/assets têm o hash do conteúdo no nome: ficam no cache do navegador sem revalidar a cada recarga.
// Os demais (sw.js, manifest, build.json, ícones) continuam revalidando, para uma versão nova chegar logo.
export function assetCacheHeaders(reply: FastifyReply, rel: string) {
  if (/^assets[/\\]/.test(rel)) reply.header('cache-control', 'public, max-age=31536000, immutable');
}

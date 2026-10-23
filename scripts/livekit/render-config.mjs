// Gera o livekit.yaml do servidor de chamadas a partir de livekit.yaml.tpl. É o único código que escreve essa
// configuração: install-windows.ps1, install-linux.sh e os testes usam este script.
//
//   node render-config.mjs --node-ip 10.0.0.5 --lan-cidr 10.0.0.0/16,10.20.0.0/16 --api-key APIxxxxxxxxxxxx
//     --secret-file <arquivo> --webhook-url http://127.0.0.1:3080/sfu-webhook --cores 4 --max-mbps 480 --out livekit.yaml
//
// --cores são os processadores lógicos, como o próprio LiveKit conta: num_tracks = 400 por processador, até 8000,
// ou o valor de --max-tracks.
//
// O segredo só vem de arquivo: a linha de comando de um processo fica visível para os outros usuários do computador.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEMPLATE_FILE = fileURLToPath(new URL('./livekit.yaml.tpl', import.meta.url));
export const DEFAULT_WEBHOOK_URL = 'http://127.0.0.1:3080/sfu-webhook';
export const DEFAULT_MAX_MBPS = 480;

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

// IPv4 em decimal, sem zeros à esquerda (o LiveKit recusa "010.0.0.5").
export function parseIpv4(v) {
  const m = IPV4.exec(String(v ?? ''));
  return m ? m.slice(1, 5).map(Number) : null;
}

// RFC 1918: 10/8, 172.16/12 e 192.168/16.
export function isPrivateIpv4(v) {
  const o = parseIpv4(v);
  if (!o) return false;
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
}

function nodeIpOf(v) {
  const s = String(v ?? '').trim();
  if (!s) throw new Error('Informe o IP do servidor (--node-ip), por exemplo 10.10.0.5.');
  const o = parseIpv4(s);
  // 0.x, multicast e broadcast não são o endereço de um computador.
  if (!o || o[0] === 0 || o[0] >= 224) throw new Error(`IP do servidor inválido: ${s}`);
  return s;
}

function cidrsOf(v, warnings) {
  const list = (Array.isArray(v) ? v : [v])
    .flatMap((x) => String(x ?? '').split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) throw new Error('Informe ao menos uma faixa de rede (--lan-cidr), por exemplo 10.10.0.0/16.');
  const out = [];
  for (const c of list) {
    const m = /^([^/]+)\/(3[0-2]|[12]?\d)$/.exec(c);
    if (!m || !parseIpv4(m[1])) throw new Error(`Faixa de rede inválida: ${c}`);
    if (m[2] === '0') warnings.push(`A faixa ${c} aceita qualquer endereço, inclusive de fora da empresa. Prefira listar só a rede local e as das filiais.`);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

function apiKeyOf(v) {
  const s = String(v ?? '').trim();
  if (!/^API[A-Za-z0-9]{12}$/.test(s)) throw new Error(`Chave da API inválida: ${s || '(vazia)'}. Use API seguido de 12 letras ou números.`);
  return s;
}

// Mesmo tratamento do chat (readSecret): sem BOM (UTF-8 ou UTF-16 LE, do PowerShell e do Bloco de Notas) e sem
// espaços no fim. O conteúdo nunca aparece numa mensagem.
export function readSecretFile(file) {
  if (!file) throw new Error('Informe o arquivo do segredo (--secret-file).');
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    throw new Error(`Não foi possível ler o arquivo do segredo: ${file}`);
  }
  const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.subarray(2).toString('utf16le') : raw.toString('utf8');
  const secret = text.replace(/^﻿/, '').trimEnd();
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) {
    throw new Error(`O arquivo ${file} não traz um segredo válido: são 43 caracteres base64url (32 bytes aleatórios).`);
  }
  return secret;
}

function webhookOf(v) {
  const s = String(v ?? '').trim();
  const m = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/sfu-webhook$/.exec(s);
  if (!m || Number(m[1]) > 65535) {
    throw new Error(`Endereço do webhook inválido: ${s || '(vazio)'}. Use http://127.0.0.1:<porta>/sfu-webhook (o chat neste mesmo computador).`);
  }
  return s;
}

function intIn(v, min, max, message) {
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s) || Number(s) < min || Number(s) > max) throw new Error(message(s || '(vazio)'));
  return Number(s);
}

// Texto de dentro das aspas duplas do YAML. Os valores já foram validados; isto só garante que nada escapa delas.
const inQuotes = (v) => JSON.stringify(String(v)).slice(1, -1);

export function renderConfig(o) {
  const warnings = [];
  const nodeIp = nodeIpOf(o.nodeIp);
  if (!isPrivateIpv4(nodeIp)) {
    warnings.push(`O IP ${nodeIp} não é de rede privada (10.x, 172.16 a 172.31 ou 192.168.x). Confira se é mesmo o endereço deste servidor na rede da empresa.`);
  }
  const cidrs = cidrsOf(o.lanCidr, warnings);
  const apiKey = apiKeyOf(o.apiKey);
  const secret = readSecretFile(o.secretFile);
  const webhookUrl = webhookOf(o.webhookUrl);
  const cores = intIn(o.cores, 1, 64, (s) => `Número de núcleos inválido: ${s}. Use de 1 a 64.`);
  const maxMbps = intIn(o.maxMbps, 10, 10000, (s) => `Limite de banda inválido: ${s}. Use de 10 a 10000 (Mbps).`);
  const autoTracks = o.maxTracks === undefined || o.maxTracks === null || String(o.maxTracks).trim() === '';
  const numTracks = autoTracks ? Math.min(400 * cores, 8000) : intIn(o.maxTracks, 100, 100_000, (s) => `Limite de faixas inválido: ${s}. Use de 100 a 100000.`);

  const values = {
    NODE_IP: inQuotes(nodeIp),
    LAN_CIDRS: cidrs.map((c) => `      - "${inQuotes(c)}"`).join('\n'),
    API_KEY: inQuotes(apiKey),
    API_SECRET: inQuotes(secret),
    WEBHOOK_URL: inQuotes(webhookUrl),
    NUM_TRACKS: String(numTracks),
    BYTES_PER_SEC: String(maxMbps * 125_000),
  };
  const template = fs.readFileSync(TEMPLATE_FILE, 'utf8').replace(/\r\n/g, '\n');
  const text = template.replace(/\{\{([A-Z_]+)\}\}/g, (all, k) => {
    if (!Object.hasOwn(values, k)) throw new Error(`O modelo ${TEMPLATE_FILE} tem um campo desconhecido: ${all}.`);
    return values[k];
  });
  const warn = o.warn ?? ((m) => process.stderr.write(`AVISO: ${m}\n`));
  for (const w of warnings) warn(w);
  return text;
}

const FLAGS = {
  '--node-ip': 'nodeIp',
  '--lan-cidr': 'lanCidr',
  '--api-key': 'apiKey',
  '--secret-file': 'secretFile',
  '--webhook-url': 'webhookUrl',
  '--cores': 'cores',
  '--max-mbps': 'maxMbps',
  '--max-tracks': 'maxTracks',
  '--out': 'out',
};

export const USAGE = `Uso: node render-config.mjs --node-ip <IP do servidor> --lan-cidr <faixa>[,<faixa>...] --api-key <chave>
  --secret-file <arquivo com o segredo> [--webhook-url ${DEFAULT_WEBHOOK_URL}] [--cores <processadores lógicos>]
  [--max-mbps ${DEFAULT_MAX_MBPS}] [--max-tracks <faixas>] [--out livekit.yaml]

Sem --out, o YAML sai na saída padrão. O segredo nunca vai na linha de comando, só no arquivo de --secret-file.
`;

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i];
    let value;
    const eq = flag.indexOf('=');
    if (flag.startsWith('--') && eq > 0) {
      value = flag.slice(eq + 1);
      flag = flag.slice(0, eq);
    }
    if (flag === '--help' || flag === '-h') {
      o.help = true;
      continue;
    }
    if (flag === '--secret' || flag === '--api-secret') {
      throw new Error('O segredo não vai na linha de comando (outros usuários a veem): grave-o num arquivo e use --secret-file.');
    }
    const key = FLAGS[flag];
    if (!key) throw new Error(`Opção desconhecida: ${flag}`);
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`Falta o valor de ${flag}.`);
    }
    if (key === 'lanCidr') o.lanCidr = [...(o.lanCidr ?? []), value];
    else o[key] = value;
  }
  return o;
}

function defaultCores() {
  const n = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(64, n || 1));
}

// Grava ao lado e troca de uma vez: o LiveKit nunca lê um arquivo pela metade.
function writeOut(file, text) {
  const tmp = path.join(path.dirname(path.resolve(file)), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Não foi possível gravar ${file}: ${e.message}`);
  }
}

export function main(argv = process.argv.slice(2)) {
  try {
    const a = parseArgs(argv);
    if (a.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    const text = renderConfig({
      ...a,
      webhookUrl: a.webhookUrl ?? DEFAULT_WEBHOOK_URL,
      cores: a.cores ?? defaultCores(),
      maxMbps: a.maxMbps ?? DEFAULT_MAX_MBPS,
    });
    if (a.out) writeOut(a.out, text);
    else process.stdout.write(text);
    return 0;
  } catch (e) {
    process.stderr.write(`ERRO: ${e.message}\n`);
    return 1;
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    const a = fs.realpathSync(process.argv[1]);
    const b = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = main();

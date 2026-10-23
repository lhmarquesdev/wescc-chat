import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { parseArgs, renderConfig, type RenderOptions } from '../../scripts/livekit/render-config.mjs';

// Configuração do LiveKit gerada pelos instaladores (scripts/livekit/render-config.mjs). Teste puro: sem banco e
// sem LiveKit; a chave e o segredo são gerados aqui. Os testes dos instaladores rodam funções deles isoladas (e o
// install-windows.ps1 inteiro, com o Windows simulado), sem mexer no computador: o install-linux.sh com o bash, o
// install-windows.ps1 com o pwsh (PWSH=<caminho> ou no PATH).

const SCRIPT = path.resolve(import.meta.dirname, '../../scripts/livekit/render-config.mjs');
const LIVEKIT_DIR = path.dirname(SCRIPT);
const WIN_SCRIPT = path.join(LIVEKIT_DIR, 'install-windows.ps1');
const LINUX_SCRIPT = path.join(LIVEKIT_DIR, 'install-linux.sh');
const README = path.resolve(LIVEKIT_DIR, '../../README.md');

function onPath(name: string): string {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const f = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
    if (dir && fs.existsSync(f)) return f;
  }
  return '';
}
const PWSH = process.env.PWSH || onPath('pwsh');
const SKIP_PWSH = 'PWSH não definido e pwsh fora do PATH: testes do install-windows.ps1 ignorados';
const BASH = process.platform === 'win32' ? '' : onPath('bash');
const SKIP_BASH = 'bash fora do PATH: testes do install-linux.sh ignorados';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'livekit-config-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const KEY = 'API' + Array.from(crypto.randomBytes(12), (b) => ALNUM[b % ALNUM.length]).join('');
const SECRET = crypto.randomBytes(32).toString('base64url');

let seq = 0;
function secretFile(content: string | Buffer): string {
  const f = path.join(TMP, `segredo-${++seq}.txt`);
  fs.writeFileSync(f, content, { mode: 0o600 });
  return f;
}
const FILE = secretFile(`${SECRET}\n`);

function opts(over: Partial<RenderOptions> = {}): RenderOptions {
  return {
    nodeIp: '10.10.0.5',
    lanCidr: ['10.10.0.0/16'],
    apiKey: KEY,
    secretFile: FILE,
    webhookUrl: 'http://127.0.0.1:3080/sfu-webhook',
    cores: 4,
    maxMbps: 480,
    ...over,
  };
}
function render(over: Partial<RenderOptions> = {}) {
  const warnings: string[] = [];
  const text = renderConfig({ ...opts(over), warn: (m) => warnings.push(m) });
  return { text, warnings };
}
function errorOf(over: Partial<RenderOptions>): string {
  const warnings: string[] = [];
  try {
    renderConfig({ ...opts(over), warn: (m) => warnings.push(m) });
  } catch (e) {
    // Um erro nunca vem depois de um aviso já mostrado.
    expect(warnings).toEqual([]);
    return (e as Error).message;
  }
  throw new Error(`deveria recusar: ${JSON.stringify(over)}`);
}
function cli(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 20_000 });
}

// Zip sem compressão com um arquivo só, como o pacote do LiveKit para Windows (o instalador só lê a entrada).
function storeZip(name: string, data: Buffer): Buffer {
  const file = Buffer.from(name);
  const crc = zlib.crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x21, 12); // 1º de janeiro de 1980
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(file.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + file.length, 12);
  end.writeUInt32LE(local.length + file.length + data.length, 16);
  return Buffer.concat([local, file, data, central, file, end]);
}

// O Windows que o install-windows.ps1 inteiro vê no teste. O estado (serviço, regras do firewall, o que foi chamado)
// fica em mock.json e as permissões em acl.json, na raiz do teste: uma rodada continua de onde a anterior parou.
// Caminho sem entrada em acl.json: dono Administradores, sem permissões a mais (como o que o instalador cria).
const WIN_MOCKS = String.raw`
$global:StatePath = Join-Path $global:CRoot 'mock.json'
$global:AclPath = Join-Path $global:CRoot 'acl.json'
$global:M = @{ Service = $false; Running = $false; Account = 'LocalSystem'; Rules = @(); Started = 0 }
if (Test-Path -LiteralPath $global:StatePath) {
  $s = Get-Content -Raw -LiteralPath $global:StatePath | ConvertFrom-Json -AsHashtable
  foreach ($k in @($s.Keys)) { $global:M[$k] = $s[$k] }
}
$global:M.Rules = @($global:M.Rules | Where-Object { $_ } | ForEach-Object { [pscustomobject]$_ })
$global:M.Calls = @()
$global:Acl = @{}
if (Test-Path -LiteralPath $global:AclPath) {
  $h = Get-Content -Raw -LiteralPath $global:AclPath | ConvertFrom-Json -AsHashtable
  foreach ($k in @($h.Keys)) {
    $v = $h[$k]
    $global:Acl[$k] = @{ Protected = [bool]$v.Protected; Owner = [string]$v.Owner; Rules = @($v.Rules | Where-Object { $_ } | ForEach-Object { @{ Sid = [string]$_.Sid; Rights = [int64]$_.Rights } }) }
  }
}
function global:Save-Mock {
  $global:M | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $global:StatePath -Encoding utf8
  $global:Acl | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $global:AclPath -Encoding utf8
}
function global:Log-Mock([string]$Text) { $global:M.Calls += $Text }
function global:Sid-Of([string]$Name) {
  if ($Name -like 'NT SERVICE\*') {
    $hash = [Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::Unicode.GetBytes($Name.Substring(11).ToUpperInvariant()))
    return 'S-1-5-80-' + ((0..4 | ForEach-Object { [BitConverter]::ToUInt32($hash, $_ * 4) }) -join '-')
  }
  return $Name.TrimStart('*')
}
function global:Acl-Of([string]$Path) {
  $k = $Path.TrimEnd('/')
  if (-not $k) { $k = '/' }
  if (-not $global:Acl.ContainsKey($k)) { $global:Acl[$k] = @{ Protected = $false; Owner = 'S-1-5-32-544'; Rules = @() } }
  return $global:Acl[$k]
}
function global:icacls {
  $a = @($args | ForEach-Object { [string]$_ })
  Log-Mock ('icacls ' + ($a -join ' '))
  $global:LASTEXITCODE = 0
  if ($a[0].EndsWith('*')) { return }
  $st = Acl-Of $a[0]
  for ($i = 1; $i -lt $a.Count; $i++) {
    $x = $a[$i]
    if ($x -eq '/setowner') { $st.Owner = Sid-Of $a[$i + 1]; $i++ }
    elseif ($x -eq '/inheritance:r') { $st.Protected = $true }
    elseif ($x -eq '/remove') { $sid = Sid-Of $a[$i + 1]; $st.Rules = @($st.Rules | Where-Object { $_.Sid -ne $sid }); $i++ }
    elseif ($x -eq '/reset') { $st.Protected = $false; $st.Rules = @() }
    elseif ($x -match '^([^:/][^:]*):(?:\([A-Z]+\))*([A-Z]+)$') {
      $sid = Sid-Of $Matches[1]
      $rights = 0x1200A9
      if ($Matches[2] -eq 'F') { $rights = 0x1F01FF } elseif ($Matches[2] -eq 'M') { $rights = 0x1301BF }
      $st.Rules = @(@($st.Rules | Where-Object { $_.Sid -ne $sid }) + @(@{ Sid = $sid; Rights = $rights }))
    }
  }
}
function global:Get-Acl { [CmdletBinding()] param([string]$LiteralPath)
  if (-not (Test-Path -LiteralPath $LiteralPath)) { throw "Não achei $LiteralPath (simulado)" }
  $st = Acl-Of $LiteralPath
  $o = [pscustomobject]@{ AreAccessRulesProtected = [bool]$st.Protected; State = $st }
  $o | Add-Member ScriptMethod GetOwner { param($t) [pscustomobject]@{ Value = $this.State.Owner } }
  $o | Add-Member ScriptMethod GetAccessRules { param($e, $i, $t) @($this.State.Rules | ForEach-Object { [pscustomobject]@{ IdentityReference = [pscustomobject]@{ Value = $_.Sid }; AccessControlType = 'Allow'; PropagationFlags = 0; FileSystemRights = $_.Rights } }) }
  return $o
}
function global:Get-Service { [CmdletBinding()] param([string]$Name)
  if ($Name -eq 'wescc-livekit' -and $global:M.Service) { [pscustomobject]@{ Name = $Name; Status = $(if ($global:M.Running) { 'Running' } else { 'Stopped' }) } }
}
function global:Stop-Service { [CmdletBinding()] param([string]$Name, [switch]$Force)
  Log-Mock "Stop-Service $Name"
  if ($Name -eq 'wescc-livekit') { $global:M.Running = $false }
}
function global:Start-Service { [CmdletBinding()] param([string]$Name)
  Log-Mock "Start-Service $Name"
  if ($Name -eq 'wescc-livekit') { $global:M.Running = $true; $global:M.Started = [int]$global:M.Started + 1 }
}
function global:Get-CimInstance { [CmdletBinding()] param([Parameter(Position = 0)][string]$ClassName, [string]$Filter)
  if ($ClassName -eq 'Win32_ComputerSystem') { return [pscustomobject]@{ NumberOfLogicalProcessors = 4 } }
  if ($ClassName -eq 'Win32_Service' -and $Filter -eq "Name='wescc-livekit'" -and $global:M.Service) {
    return [pscustomobject]@{ Name = 'wescc-livekit'; ProcessId = $(if ($global:M.Running) { 900 } else { 0 }); State = $(if ($global:M.Running) { 'Running' } else { 'Stopped' }); StartName = $global:M.Account }
  }
  if ($ClassName -eq 'Win32_Process' -and $Filter -eq 'ParentProcessId=900' -and $global:M.Running) { return [pscustomobject]@{ ProcessId = 901; Name = 'livekit-server.exe' } }
}
function global:Get-Process { [CmdletBinding()] param($Id) }
function global:Get-NetIPAddress { [CmdletBinding()] param([string]$AddressFamily)
  [pscustomobject]@{ IPAddress = '127.0.0.1'; InterfaceIndex = 1 }
  [pscustomobject]@{ IPAddress = '10.10.0.5'; InterfaceIndex = 5 }
}
function global:Get-NetConnectionProfile { [CmdletBinding()] param()
  [pscustomobject]@{ InterfaceIndex = 5; InterfaceAlias = 'Ethernet'; Name = 'empresa.local'; NetworkCategory = 'DomainAuthenticated' }
}
function global:Get-NetTCPConnection { [CmdletBinding()] param($LocalPort, $State)
  if ($global:M.Running -and [int]$LocalPort -eq 7880) { [pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 901 } }
  if ($global:M.Running -and [int]$LocalPort -eq 7881) { [pscustomobject]@{ LocalAddress = '0.0.0.0'; OwningProcess = 901 } }
}
function global:Get-NetUDPEndpoint { [CmdletBinding()] param()
  if ($global:M.Running) { foreach ($p in 7882..7885) { [pscustomobject]@{ LocalAddress = '10.10.0.5'; LocalPort = $p; OwningProcess = 901 } } }
}
function global:Get-NetFirewallApplicationFilter { [CmdletBinding()] param() }
function global:Get-NetFirewallRule { [CmdletBinding()] param([string]$Group, [Parameter(ValueFromPipeline = $true)]$InputObject)
  end { if ($Group) { @($global:M.Rules) | Where-Object { $_.Group -eq $Group } } }
}
function global:Remove-NetFirewallRule { [CmdletBinding()] param([Parameter(ValueFromPipeline = $true)]$InputObject)
  process {
    Log-Mock "Remove-NetFirewallRule $($InputObject.Name)"
    $global:M.Rules = @(@($global:M.Rules) | Where-Object { $_.Name -ne $InputObject.Name })
  }
}
function global:New-NetFirewallRule { [CmdletBinding()] param($DisplayName, $Group, $Direction, $Action, $Protocol, $LocalPort, $RemoteAddress, $Profile)
  if ($global:Scenario -eq 'firewall' -and $Protocol -eq 'TCP') { throw 'Acesso negado (simulado)' }
  Log-Mock "New-NetFirewallRule $DisplayName"
  $rule = [pscustomobject]@{ Name = [guid]::NewGuid().ToString(); DisplayName = $DisplayName; Group = $Group }
  $global:M.Rules = @(@($global:M.Rules) + $rule)
  $rule
}
function global:Invoke-WebRequest { [CmdletBinding()] param($Uri, $OutFile, [switch]$UseBasicParsing, $Proxy, [switch]$ProxyUseDefaultCredentials, $TimeoutSec)
  if ($OutFile) { throw "Sem internet no teste ($Uri)" }
  if ($global:M.Running) { return [pscustomobject]@{ StatusCode = 200; Content = 'OK' } }
  throw 'Não é possível conectar ao servidor remoto (simulado)'
}
function global:Unblock-File { [CmdletBinding()] param([string]$LiteralPath)
  Log-Mock "Unblock-File $LiteralPath"
  if ($global:Scenario -eq 'antivirus') { throw 'O antivírus bloqueou o arquivo (simulado)' }
}
function global:netsh {
  $a = $args -join ' '
  Log-Mock "netsh $a"
  $global:LASTEXITCODE = 0
  if ($a -like '*show excludedportrange*') { 'Intervalos de exclusão de porta'; ''; 'Porta Inicial    Porta Final'; '-------------    -----------'; ''; '* - Exclusões de porta administradas.' }
  elseif ($a -like '*show dynamicport*') { 'Protocolo Intervalo de Portas Dinâmicas'; '---------------------------------'; 'Porta Inicial      : 49152'; 'Número de Portas    : 16384' }
  else { 'Ok.' }
}
function global:sc.exe {
  Log-Mock "sc.exe $($args -join ' ')"
  if ($args[0] -eq 'config') { $global:M.Account = [string]$args[3] } elseif ($args[0] -eq 'delete') { $global:M.Service = $false; $global:M.Running = $false }
  $global:LASTEXITCODE = 0
}
function global:winsw-mock {
  Log-Mock "winsw $($args -join ' ')"
  if ($args[0] -eq 'install') { $global:M.Service = $true }
  $global:LASTEXITCODE = 0
}
`;

describe('configuração do LiveKit (render-config.mjs)', () => {
  it('IP e faixas inválidos são recusados com mensagem em português; IP público só avisa', () => {
    for (const ip of ['10.10.0', '10.10.0.256', '010.10.0.5', '10.10.0.5/16', 'servidor-chat', '::1', '0.0.0.0', '224.0.0.1', '10.10.0.5:7880']) {
      expect(errorOf({ nodeIp: ip }), ip).toBe(`IP do servidor inválido: ${ip}`);
    }
    expect(errorOf({ nodeIp: '' })).toBe('Informe o IP do servidor (--node-ip), por exemplo 10.10.0.5.');

    for (const c of ['10.10.0.0/33', '10.10.0.0', '10.10.0/16', '10.10.0.0/-1', '10.10.0.0/016', 'rede/8', '10.10.0.256/24', '10.10.0.0/16/8']) {
      expect(errorOf({ lanCidr: [c] }), c).toBe(`Faixa de rede inválida: ${c}`);
    }
    // A faixa ruim no meio de uma lista também é apontada pelo nome.
    expect(errorOf({ lanCidr: ['10.10.0.0/16,10.20.0.0/40'] })).toBe('Faixa de rede inválida: 10.20.0.0/40');
    for (const empty of [[], [''], [' , ']]) {
      expect(errorOf({ lanCidr: empty })).toBe('Informe ao menos uma faixa de rede (--lan-cidr), por exemplo 10.10.0.0/16.');
    }

    // IP fora da RFC 1918 (por exemplo uma VPN com endereços públicos): gera a configuração e só avisa.
    for (const ip of ['200.160.2.3', '172.32.0.1', '127.0.0.1']) {
      const { text, warnings } = render({ nodeIp: ip });
      expect(text).toContain(`  node_ip: "${ip}"\n`);
      expect(warnings).toEqual([`O IP ${ip} não é de rede privada (10.x, 172.16 a 172.31 ou 192.168.x). Confira se é mesmo o endereço deste servidor na rede da empresa.`]);
    }
    for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.0.10']) {
      expect(render({ nodeIp: ip }).warnings, ip).toEqual([]);
    }
  });

  it('todos os valores saem entre aspas; segredo que parece número ou começa com hífen continua texto', () => {
    const tricky = [
      '1234567890'.repeat(5).slice(0, 43), // só dígitos: sem aspas viraria número
      '-' + crypto.randomBytes(32).toString('base64url').slice(0, 42), // começaria um item de lista
      '1e' + '9'.repeat(41), // notação científica
      '0x' + 'f'.repeat(41), // hexadecimal
      '_-' + crypto.randomBytes(32).toString('base64url').slice(0, 41),
    ];
    // Valores sem aspas que o próprio modelo traz (números, booleanos e o nível do log).
    const literal = new Set(['7880', '7881', 'false', 'true', '120', '40', 'info', '1600', '60000000']);
    for (const s of tricky) {
      expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const { text } = render({ secretFile: secretFile(s), lanCidr: ['10.10.0.0/16', '10.20.0.0/16'] });
      expect(text).toContain(`keys:\n  "${KEY}": "${s}"\nroom:`);
      expect(text.split(s).length - 1, 'o segredo aparece uma vez só').toBe(1);
      expect(text).not.toContain('{{');
      for (const line of text.split('\n')) {
        if (!line.trim() || line.startsWith('#')) continue;
        const item = /^\s*- (.*)$/.exec(line);
        const pair = /^\s*("[^"]*"|[a-z_]+):(?: (.*))?$/.exec(line);
        expect(item || pair, line).toBeTruthy();
        const value = item ? item[1] : pair![2];
        if (value === undefined) continue; // abre um mapa
        expect(/^"[A-Za-z0-9_./:-]*"$/.test(value) || literal.has(value), line).toBe(true);
      }
      expect(text).toContain('  node_ip: "10.10.0.5"\n');
      expect(text).toContain(`  api_key: "${KEY}"\n`);
      expect(text).toContain('    - "http://127.0.0.1:3080/sfu-webhook"\n');
    }
  });

  it('uma linha por faixa em ips.includes; udp_port 7882-7885; num_tracks e bytes_per_sec a partir dos núcleos e do limite', () => {
    // O documento inteiro é o modelo do §8.3 com os valores preenchidos.
    const { text } = render({ lanCidr: ['10.10.0.0/16, 10.20.0.0/16', '192.168.50.0/24', '10.10.0.0/16'] });
    expect(text).toBe(
      [
        '# Gerado por scripts/livekit/render-config.mjs. Não edite à mão: rode o instalador de novo.',
        'port: 7880',
        'bind_addresses:',
        '  - "127.0.0.1"',
        'rtc:',
        '  tcp_port: 7881',
        '  udp_port: "7882-7885"',
        '  use_external_ip: false',
        '  node_ip: "10.10.0.5"',
        '  ips:',
        '    includes:',
        '      - "10.10.0.0/16"',
        '      - "10.20.0.0/16"',
        '      - "192.168.50.0/24"',
        '  enable_loopback_candidate: false',
        '  allow_tcp_fallback: true',
        'keys:',
        `  "${KEY}": "${SECRET}"`,
        'room:',
        '  auto_create: false',
        '  empty_timeout: 120',
        '  departure_timeout: 40',
        '  enable_remote_unmute: false',
        'webhook:',
        `  api_key: "${KEY}"`,
        '  urls:',
        '    - "http://127.0.0.1:3080/sfu-webhook"',
        'turn:',
        '  enabled: false',
        'limit:',
        '  num_tracks: 1600',
        '  bytes_per_sec: 60000000',
        'logging:',
        '  level: info',
        '',
      ].join('\n'),
    );
    expect(text).not.toContain('port_range');

    for (const [cores, tracks] of [[1, 400], [4, 1600], [16, 6400], [20, 8000], [64, 8000]]) {
      expect(render({ cores }).text, `${cores} núcleos`).toContain(`  num_tracks: ${tracks}\n`);
    }
    for (const [mbps, bytes] of [[10, 1_250_000], [480, 60_000_000], ['1000', 125_000_000], [10_000, 1_250_000_000]]) {
      expect(render({ maxMbps: mbps }).text, `${mbps} Mbps`).toContain(`  bytes_per_sec: ${bytes}\n`);
    }
    for (const cores of [0, 65, 2.5, -1, '4 núcleos']) {
      expect(errorOf({ cores })).toBe(`Número de núcleos inválido: ${cores}. Use de 1 a 64.`);
    }
    for (const mbps of [9, 10_001, 'muito']) {
      expect(errorOf({ maxMbps: mbps })).toBe(`Limite de banda inválido: ${mbps}. Use de 10 a 10000 (Mbps).`);
    }
  });

  it('webhook só em 127.0.0.1; chave e segredo no formato esperado; segredo lido do arquivo', () => {
    // A 3080 é o ouvinte interno do chat com HTTPS próprio; sem ele, a porta do próprio chat.
    for (const url of ['http://127.0.0.1:3080/sfu-webhook', 'http://127.0.0.1:3000/sfu-webhook']) {
      expect(render({ webhookUrl: url }).text).toContain(`  urls:\n    - "${url}"\n`);
    }
    for (const url of [
      'https://127.0.0.1:3080/sfu-webhook',
      'http://localhost:3080/sfu-webhook',
      'http://10.10.0.5:3080/sfu-webhook',
      'http://0.0.0.0:3080/sfu-webhook',
      'http://user@127.0.0.1:3080/sfu-webhook',
      'http://127.0.0.1/sfu-webhook',
      'http://127.0.0.1:70000/sfu-webhook',
      'http://127.0.0.1:03080/sfu-webhook',
      'http://127.0.0.1:3080/sfu-webhook/',
      'http://127.0.0.1:3080/sfu-webhook?x=1',
      'http://127.0.0.1:3080/outra',
    ]) {
      expect(errorOf({ webhookUrl: url }), url).toBe(`Endereço do webhook inválido: ${url}. Use http://127.0.0.1:<porta>/sfu-webhook (o chat neste mesmo computador).`);
    }

    for (const k of ['APIcurta', 'XYZabcdefABCDEF', 'APIabcdef-BCDEF', 'apiabcdefABCDEF', 'APIabcdefABCDEFG']) {
      expect(errorOf({ apiKey: k }), k).toBe(`Chave da API inválida: ${k}. Use API seguido de 12 letras ou números.`);
    }

    // O segredo vem do arquivo, do jeito que o PowerShell e o Bloco de Notas gravam (BOM, CRLF).
    const variants = [
      Buffer.from(`${SECRET}\r\n`),
      Buffer.from(`﻿${SECRET}\n`),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${SECRET}\r\n`, 'utf16le')]),
    ];
    for (const v of variants) {
      expect(render({ secretFile: secretFile(v) }).text).toContain(`  "${KEY}": "${SECRET}"\n`);
    }
    const base64 = crypto.randomBytes(32).toString('base64'); // 44 caracteres, com = e talvez + ou /
    for (const bad of [SECRET.slice(0, 42), `${SECRET}A`, `${SECRET.slice(0, 42)}+`, `${SECRET.slice(0, 42)}/`, base64, '', `${SECRET.slice(0, 21)} ${SECRET.slice(22)}`]) {
      const f = secretFile(bad);
      const msg = errorOf({ secretFile: f });
      expect(msg).toBe(`O arquivo ${f} não traz um segredo válido: são 43 caracteres base64url (32 bytes aleatórios).`);
      if (bad) expect(msg).not.toContain(bad);
    }
    const missing = path.join(TMP, 'nao-existe.txt');
    expect(errorOf({ secretFile: missing })).toBe(`Não foi possível ler o arquivo do segredo: ${missing}`);
    expect(errorOf({ secretFile: '' })).toBe('Informe o arquivo do segredo (--secret-file).');

    // Nunca pela linha de comando.
    for (const flag of ['--secret', '--api-secret', `--secret=${SECRET}`]) {
      expect(() => parseArgs(['--node-ip', '10.10.0.5', flag, SECRET])).toThrow('O segredo não vai na linha de comando (outros usuários a veem): grave-o num arquivo e use --secret-file.');
    }
    expect(() => parseArgs(['--algo', '1'])).toThrow('Opção desconhecida: --algo');
    expect(() => parseArgs(['--node-ip'])).toThrow('Falta o valor de --node-ip.');
    expect(parseArgs(['--lan-cidr', '10.10.0.0/16', '--lan-cidr=10.20.0.0/16', '--cores', '4'])).toEqual({ lanCidr: ['10.10.0.0/16', '10.20.0.0/16'], cores: '4' });

    // Pela linha de comando, como os instaladores chamam: grava --out só para o dono e não mostra o segredo.
    const out = path.join(TMP, 'livekit.yaml');
    const ok = cli(['--node-ip', '10.10.0.5', '--lan-cidr', '10.10.0.0/16', '--api-key', KEY, '--secret-file', FILE, '--cores', '4', '--max-mbps', '480', '--out', out]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout + ok.stderr).not.toContain(SECRET);
    expect(fs.readFileSync(out, 'utf8')).toBe(render().text);
    if (process.platform !== 'win32') expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(TMP).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    const bad = cli(['--node-ip', '10.10.0.999', '--lan-cidr', '10.10.0.0/16', '--api-key', KEY, '--secret-file', FILE, '--out', path.join(TMP, 'nao.yaml')]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toBe('ERRO: IP do servidor inválido: 10.10.0.999\n');
    expect(fs.existsSync(path.join(TMP, 'nao.yaml'))).toBe(false);

    const warned = cli(['--node-ip', '200.160.2.3', '--lan-cidr', '10.10.0.0/16', '--api-key', KEY, '--secret-file', FILE]);
    expect(warned.status).toBe(0);
    expect(warned.stdout).toContain('  node_ip: "200.160.2.3"\n');
    expect(warned.stdout).toContain('    - "http://127.0.0.1:3080/sfu-webhook"\n'); // padrão sem --webhook-url
    expect(warned.stderr).toBe('AVISO: O IP 200.160.2.3 não é de rede privada (10.x, 172.16 a 172.31 ou 192.168.x). Confira se é mesmo o endereço deste servidor na rede da empresa.\n');
  });

  it('--max-tracks troca o cálculo por processador; fora de 100 a 100000 é recusado', () => {
    // O teste de carga do README passa de 1600 faixas: num PC de 4 processadores lógicos a TI sobe o limite.
    for (const [tracks, text] of [[2000, '2000'], ['12000', '12000'], [100, '100'], [100_000, '100000']] as const) {
      expect(render({ cores: 4, maxTracks: tracks }).text, String(tracks)).toContain(`  num_tracks: ${text}\n`);
    }
    for (const empty of [undefined, null, '']) {
      expect(render({ cores: 4, maxTracks: empty }).text).toContain('  num_tracks: 1600\n');
    }
    for (const bad of [99, 0, 100_001, 1.5, '2 mil', -5]) {
      expect(errorOf({ maxTracks: bad })).toBe(`Limite de faixas inválido: ${bad}. Use de 100 a 100000.`);
    }
    expect(parseArgs(['--max-tracks', '2000'])).toEqual({ maxTracks: '2000' });
    const ok = cli(['--node-ip', '10.10.0.5', '--lan-cidr', '10.10.0.0/16', '--api-key', KEY, '--secret-file', FILE, '--cores', '4', '--max-tracks=3000']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('  num_tracks: 3000\n');
  });
});

describe('instaladores do servidor de chamadas', () => {
  it('README: os SHA-256 são os de versions.json (inclusive o lk.exe do teste de carga) e diz como remover tudo', () => {
    const pins = JSON.parse(fs.readFileSync(path.join(LIVEKIT_DIR, 'versions.json'), 'utf8'));
    const readme = fs.readFileSync(README, 'utf8');
    const lower = readme.toLowerCase();
    for (const [what, hash] of [
      ['livekit-server.exe', pins.livekit.exe_sha256.windows_amd64],
      ['WinSW', pins.winsw.sha256],
      ['pacote do lk', pins.lk.sha256.windows_amd64],
      ['lk.exe', pins.lk.exe_sha256.windows_amd64],
    ]) {
      expect(hash, what).toMatch(/^[0-9a-f]{64}$/);
      expect(lower.includes(hash), `${what}: ${hash}`).toBe(true);
    }
    // O lk vai para uma pasta só do Administrador e sai dela no fim; nada em C:\Wescc\lk, que herda as permissões de C:\.
    expect(readme).not.toContain('C:\\Wescc\\lk');
    const remove = readme.slice(readme.indexOf('### Remover o servidor de chamadas'));
    expect(remove.length).toBeGreaterThan(40);
    expect(remove).toContain('install-windows.ps1 -Uninstall');
    expect(remove).toContain('install-chat-service.ps1 -Reconfigure');
    expect(remove).toContain('install-linux.sh --uninstall');
  });

  describe.skipIf(!BASH)('install-linux.sh (bash)', () => {
    it('o proxy vai só pelo ambiente do curl; usuário e senha em --proxy são recusados', () => {
      const src = fs.readFileSync(LINUX_SCRIPT, 'utf8');
      const has = /^has\(\) \{.*\}$/m.exec(src)?.[0];
      const download = /^download\(\) \{[\s\S]*?^\}$/m.exec(src)?.[0];
      expect(has && download).toBeTruthy();
      const dir = fs.mkdtempSync(path.join(TMP, 'proxy-'));
      const shims = path.join(dir, 'shims');
      fs.mkdirSync(shims);
      // Cada programa anota a própria linha de comando; o curl anota também o proxy que recebeu pelo ambiente.
      for (const name of ['env', 'curl', 'wget']) {
        const extra = name === 'env' ? '\nexec /usr/bin/env "$@"' : '\necho "$0 ambiente: ${https_proxy:-}|${HTTPS_PROXY:-}" >> "$LOG"';
        fs.writeFileSync(path.join(shims, name), `#!/bin/sh\necho "$0 argv: $*" >> "$LOG"${extra}\n`, { mode: 0o755 });
      }
      fs.writeFileSync(path.join(dir, 'funcoes.sh'), `${has}\n${download}\n`);
      const LOG = path.join(dir, 'log.txt');
      const proxy = 'http://usuario:SenhaDoProxy@proxy.local:8080';
      const run = (proxyArg: string, inherited?: string) => {
        fs.writeFileSync(LOG, '');
        const env: NodeJS.ProcessEnv = { PATH: `${shims}:/usr/bin:/bin`, LOG, PROXY: proxyArg };
        if (inherited) env.https_proxy = inherited;
        const r = spawnSync(BASH, ['-c', `set -euo pipefail; source '${dir}/funcoes.sh'; download https://exemplo.invalid/pacote.tar.gz '${dir}/pacote.tar.gz'`], { encoding: 'utf8', env, timeout: 20_000 });
        expect(r.status, r.stderr).toBe(0);
        return fs.readFileSync(LOG, 'utf8').trim().split('\n');
      };
      const lines = run(proxy);
      expect(lines.filter((l) => l.includes(' argv: ')).length).toBeGreaterThan(0);
      for (const l of lines.filter((x) => x.includes(' argv: '))) expect(l).not.toContain('SenhaDoProxy');
      expect(lines).toContain(`${path.join(shims, 'curl')} ambiente: ${proxy}|${proxy}`);
      // Sem --proxy, o https_proxy que já estava no ambiente (sudo --preserve-env) chega intacto ao curl.
      expect(run('', 'http://proxy.herdado:3128')).toContain(`${path.join(shims, 'curl')} ambiente: http://proxy.herdado:3128|`);

      // Com ou sem http:// na frente: o curl entende usuario:senha@proxy:8080 como http:// e manda a senha.
      for (const form of [proxy, 'usuario:SenhaDoProxy@proxy.local:8080', '//usuario:SenhaDoProxy@proxy.local:8080', 'socks5h://usuario:SenhaDoProxy@proxy.local:1080']) {
        for (const args of [['--proxy', form], [`--proxy=${form}`]]) {
          const r = spawnSync(BASH, [LINUX_SCRIPT, ...args, '--dry-run'], { encoding: 'utf8', timeout: 20_000 });
          expect(r.status, args.join(' ')).toBe(1);
          expect(r.stderr).toContain('ERRO: Usuário e senha do proxy não vão na linha de comando (outros usuários a veem): rode sem --proxy, com a variável https_proxy no ambiente (veja o README, seção Chamadas em grupo).');
          expect(r.stdout + r.stderr).not.toContain('SenhaDoProxy');
        }
      }
    });

    it('--uninstall só apaga o segredo quando o serviço do chat não aponta mais para ele, nem num arquivo de EnvironmentFile=', () => {
      const src = fs.readFileSync(LINUX_SCRIPT, 'utf8');
      const fns = ['mentions_secret', 'chat_uses_secret'].map((n) => new RegExp(`^${n}\\(\\) \\{[\\s\\S]*?^\\}$`, 'm').exec(src)?.[0]);
      expect(fns.every(Boolean)).toBe(true);
      const dir = fs.mkdtempSync(path.join(TMP, 'segredo-'));
      const etc = path.join(dir, 'etc');
      const units = path.join(dir, 'systemd');
      const shims = path.join(dir, 'shims');
      for (const d of [etc, units, shims]) fs.mkdirSync(d);
      const SECRET_PATH = path.join(etc, 'livekit-api-secret');
      const CHAT_ENV = path.join(etc, 'chat-livekit.env');
      const OWN_ENV = path.join(etc, 'chat.env');
      const UNIT_TEXT = path.join(dir, 'systemctl-cat.txt');
      const CHAT_UNIT = path.join(units, 'wescc-chat.service');
      // systemctl cat imprime o serviço do chat quando o arquivo existe; sem ele, falha como sem o systemd.
      fs.writeFileSync(path.join(shims, 'systemctl'), `#!/bin/sh\n[ "$1" = cat ] && [ -f '${UNIT_TEXT}' ] && exec cat '${UNIT_TEXT}'\nexit 1\n`, { mode: 0o755 });
      fs.writeFileSync(
        path.join(dir, 'funcoes.sh'),
        [`CHAT_SERVICE=wescc-chat`, `CHAT_UNIT_FILE='${CHAT_UNIT}'`, `CHAT_ENV_FILE='${CHAT_ENV}'`, `SECRET_FILE='${SECRET_PATH}'`, ...fns, ''].join('\n'),
      );
      fs.writeFileSync(CHAT_ENV, `LIVEKIT_API_SECRET_FILE=${SECRET_PATH}\n`);
      const uses = (unitText: string | null, ownEnv: string | null, onDisk: Record<string, string> = {}) => {
        fs.rmSync(UNIT_TEXT, { force: true });
        fs.rmSync(OWN_ENV, { force: true });
        fs.rmSync(units, { recursive: true, force: true });
        fs.mkdirSync(units);
        if (unitText !== null) fs.writeFileSync(UNIT_TEXT, `# ${CHAT_UNIT}\n${unitText}`);
        if (ownEnv !== null) fs.writeFileSync(OWN_ENV, ownEnv);
        for (const [rel, text] of Object.entries(onDisk)) {
          fs.mkdirSync(path.dirname(path.join(units, rel)), { recursive: true });
          fs.writeFileSync(path.join(units, rel), text);
        }
        const r = spawnSync(BASH, ['-c', `set -euo pipefail; source '${dir}/funcoes.sh'; if chat_uses_secret; then echo usa; else echo livre; fi`], {
          encoding: 'utf8',
          env: { PATH: `${shims}:/usr/bin:/bin` },
          timeout: 20_000,
        });
        expect(r.status, r.stderr).toBe(0);
        return r.stdout.trim();
      };
      const line = `LIVEKIT_API_SECRET_FILE=${SECRET_PATH}\n`;
      // O caso do verificador: o chat lê o caminho do segredo de um arquivo próprio.
      expect(uses(`[Service]\nEnvironmentFile=${OWN_ENV}\n`, `# banco\nDATABASE_URL_FILE=/etc/wescc/database-url\n${line}`)).toBe('usa');
      expect(uses(`[Service]\nEnvironmentFile=-${OWN_ENV}\n`, line)).toBe('usa');
      expect(uses(`[Service]\nEnvironmentFile = ${OWN_ENV}  \n`, line)).toBe('usa');
      expect(uses(`[Service]\nEnvironmentFile=${OWN_ENV}\n`, `# ${line}; ${line}`)).toBe('livre');
      expect(uses(`[Service]\nEnvironmentFile=${OWN_ENV}\n`, null)).toBe('livre');
      // O chat-livekit.env sai junto com o segredo (fica só um comentário).
      expect(uses(`[Service]\nEnvironmentFile=${CHAT_ENV}\n`, null)).toBe('livre');
      expect(uses(`[Service]\nEnvironment=${line}`, null)).toBe('usa');
      expect(uses(`[Service]\n# Environment=${line}; Environment=${line}`, null)).toBe('livre');
      // Sem o systemctl (ou com o systemd parado): os arquivos do serviço e o .d dele.
      expect(uses(null, line, { 'wescc-chat.service': `[Service]\nEnvironmentFile=${OWN_ENV}\n` })).toBe('usa');
      expect(uses(null, null, { 'wescc-chat.service': '[Service]\n', 'wescc-chat.service.d/livekit.conf': `[Service]\nEnvironment=${line}` })).toBe('usa');
      expect(uses(null, null)).toBe('livre');
    });

    it('--uninstall existe e, com --dry-run, só mostra o que faria (nenhum passo da instalação roda)', () => {
      const r = spawnSync(BASH, [LINUX_SCRIPT, '--uninstall', '--dry-run'], {
        encoding: 'utf8',
        timeout: 20_000,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: TMP },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('Remover o servidor de chamadas');
      expect(r.stdout).toContain('Reinicie o chat para ele deixar de oferecer as chamadas em grupo: sudo systemctl restart wescc-chat');
      expect(r.stdout).toContain('Simulação concluída: nada foi alterado.');
      expect(r.stdout).not.toContain('[1/11]');
      expect(r.stdout).not.toMatch(/^ {4}-> /m);
    });
  });

  if (!BASH) it.skip(SKIP_BASH, () => {});

  describe.skipIf(!PWSH)('install-windows.ps1 (pwsh)', () => {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    // Roda um trecho com as funções pedidas do install-windows.ps1 já carregadas (o script em si não roda), e as
    // variáveis de $vars com o valor que o script dá a elas. Fail, Ok, Info e Warn viram anotações; a última linha da
    // saída é o JSON de $out.
    function ps(functions: string[], body: string, vars: string[] = []): Record<string, any> {
      const file = path.join(TMP, `teste-${++seq}.ps1`);
      fs.writeFileSync(
        file,
        [
          "$ErrorActionPreference = 'Stop'",
          `$ast = [System.Management.Automation.Language.Parser]::ParseFile(${q(WIN_SCRIPT)}, [ref]$null, [ref]$null)`,
          `$wantedVars = @(${vars.map(q).join(', ')})`,
          '$assigned = @($ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.AssignmentStatementAst] -and $_.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and $wantedVars -contains $_.Left.VariablePath.UserPath })',
          'foreach ($a in $assigned) { . ([scriptblock]::Create($a.Extent.Text)) }',
          '$missingVars = @($wantedVars | Where-Object { @($assigned | ForEach-Object { $_.Left.VariablePath.UserPath }) -notcontains $_ })',
          'if ($missingVars.Count) { throw "variáveis ausentes no install-windows.ps1: $($missingVars -join \', \')" }',
          `$wanted = @(${functions.map(q).join(', ')})`,
          '$found = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false) | Where-Object { $wanted -contains $_.Name })',
          'foreach ($f in $found) { . ([scriptblock]::Create($f.Extent.Text)) }',
          '$missing = @($wanted | Where-Object { @($found | ForEach-Object Name) -notcontains $_ })',
          'if ($missing.Count) { throw "funções ausentes no install-windows.ps1: $($missing -join \', \')" }',
          '$global:said = @()',
          'function Fail([string]$Message) { throw "ERRO: $Message" }',
          'function Ok([string]$Message) { $global:said += "OK $Message" }',
          'function Info([string]$Message) { $global:said += $Message }',
          'function Warn([string]$Message) { $global:said += "AVISO $Message" }',
          '$Utf8 = New-Object System.Text.UTF8Encoding $false',
          `$root = ${q(fs.mkdtempSync(path.join(TMP, 'ps-')))}`,
          '$out = [ordered]@{}',
          body,
          '$out.said = @($global:said)',
          '$out | ConvertTo-Json -Compress -Depth 5',
        ].join('\n'),
      );
      const r = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', file], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, HOME: TMP, POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off' },
      });
      expect(r.status, r.stderr + r.stdout).toBe(0);
      return JSON.parse(r.stdout.trim().split('\n').pop()!);
    }

    it('parâmetros só por nome: um valor solto é recusado e não vira -InstallDir; -InstallDir só com caminho completo', () => {
      const src = fs.readFileSync(WIN_SCRIPT, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
      const block = /^\[CmdletBinding\([^\n]*\)\]\nparam\(\n[\s\S]*?\n\)\n/m.exec(src)?.[0];
      expect(block).toBeTruthy();
      const bind = path.join(TMP, 'parametros.ps1');
      fs.writeFileSync(bind, `${block}[pscustomobject]@{ InstallDir = $InstallDir; LanCidr = @($LanCidr) } | ConvertTo-Json -Compress\n`);
      const call = (...args: string[]) => spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', bind, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: TMP } });
      // "-LanCidr a b" (espaço em vez de vírgula) instalava em .\b e deixava a segunda rede de fora.
      const stray = call('-NodeIp', '10.10.0.5', '-LanCidr', '10.10.0.0/16', '10.20.0.0/16', '-WhatIf');
      expect(stray.status).not.toBe(0);
      expect(stray.stdout + stray.stderr).toMatch(/positional parameter cannot be found that accepts argument '10\.20\.0\.0\/16'/);
      const comma = call('-NodeIp', '10.10.0.5', '-LanCidr', '10.10.0.0/16,10.20.0.0/16', '-WhatIf');
      expect(comma.status, comma.stderr).toBe(0);
      expect(JSON.parse(comma.stdout)).toEqual({ InstallDir: 'C:\\Wescc\\livekit', LanCidr: ['10.10.0.0/16,10.20.0.0/16'] });
      // O README manda ver o Get-Help: a ajuda é achada e diz que nenhum parâmetro vale pela posição.
      const help = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Help ${q(WIN_SCRIPT)}).Synopsis; @(Get-Help ${q(WIN_SCRIPT)} -Parameter * | ForEach-Object { "$($_.name)=$($_.position)" }) -join ' '`], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: TMP } });
      const [synopsis, positions] = help.stdout.trim().split('\n');
      expect(synopsis).toMatch(/^Instala ou atualiza o servidor de chamadas em grupo/);
      for (const name of ['NodeIp', 'LanCidr', 'InstallDir', 'MaxTracks', 'Offline', 'Proxy', 'Uninstall']) expect(positions).toContain(`${name}=named`);
      expect(positions).not.toMatch(/=\d/);

      const r = ps(['Test-FullPath'], `$out.full = @(@('C:\\Wescc\\livekit', 'D:/Wescc/livekit', 'e:\\x') | ForEach-Object { Test-FullPath $_ })
$out.partial = @(@('10.20.0.0/16', '.\\livekit', 'livekit', '\\Wescc\\livekit', 'C:Wescc', '\\\\servidor\\pasta', '') | ForEach-Object { Test-FullPath $_ })`);
      expect(r.full).toEqual([true, true, true]);
      expect(r.partial).toEqual([false, false, false, false, false, false, false]);
    });

    it('-Offline: o arquivo é copiado para a pasta temporária e conferido lá; uma cópia que não confere, ou que não pôde ser gravada, nunca troca o instalado', () => {
      const r = ps(['Get-Sha256', 'Get-PinnedFile', 'Install-VerifiedFile', 'Remove-Leftover'], `
$script:workDir = Join-Path $root 'temporaria'
[void][IO.Directory]::CreateDirectory($script:workDir)
$Offline = Join-Path $root 'pendrive'
[void][IO.Directory]::CreateDirectory($Offline)
$Simulate = $false
$Proxy = $null
$onStick = Join-Path $Offline 'WinSW-x64.exe'
[IO.File]::WriteAllText($onStick, 'WINSW-FIXADO')
$hash = Get-Sha256 $onStick
$got = Get-PinnedFile 'WinSW-x64.exe' 'https://exemplo.invalid/WinSW-x64.exe' $hash 'WinSW 2.12.0'
# Alguém troca o arquivo no pendrive depois da conferência.
[IO.File]::WriteAllText($onStick, 'EVIL-WINSW')
$out.inWork = [IO.Path]::GetDirectoryName($got) -eq $script:workDir
$out.copyIntact = (Get-Sha256 $got) -eq $hash

$dir = Join-Path $root 'instalado'
[void][IO.Directory]::CreateDirectory($dir)
$dest = Join-Path $dir 'wescc-livekit.exe'
[IO.File]::WriteAllText($dest, 'VERSAO-ANTERIOR')
try { Install-VerifiedFile $onStick $dest $hash; $out.badError = '' } catch { $out.badError = "$($_.Exception.Message)" }
$out.afterBad = [IO.File]::ReadAllText($dest)
$out.filesAfterBad = @(Get-ChildItem -LiteralPath $dir | ForEach-Object Name)
Install-VerifiedFile $got $dest $hash
$out.afterGood = [IO.File]::ReadAllText($dest)
$out.filesAfterGood = @(Get-ChildItem -LiteralPath $dir | ForEach-Object Name)
$fresh = Join-Path $dir 'livekit-server.exe'
Install-VerifiedFile $got $fresh $hash
$out.fresh = [IO.File]::ReadAllText($fresh)
# Disco cheio, antivírus: a cópia nem chega a ser gravada (aqui, um .novo que é uma pasta). Antes, uma exceção crua.
[IO.File]::WriteAllText($dest, 'VERSAO-ANTERIOR')
[void][IO.Directory]::CreateDirectory("$dest.novo")
try { Install-VerifiedFile $got $dest $hash; $out.copyError = '' } catch { $out.copyError = "$($_.Exception.Message)" }
$out.afterCopyError = [IO.File]::ReadAllText($dest)
[IO.Directory]::Delete("$dest.novo")
$out.filesAfterCopyError = @(Get-ChildItem -LiteralPath $dir | ForEach-Object Name)

[IO.File]::WriteAllText((Join-Path $Offline 'livekit_1.13.9_windows_amd64.zip'), 'PACOTE-ERRADO')
try { $null = Get-PinnedFile 'livekit_1.13.9_windows_amd64.zip' 'https://exemplo.invalid/x.zip' $hash 'LiveKit 1.13.9'; $out.zipError = '' } catch { $out.zipError = "$($_.Exception.Message)" }`);
      expect(r.inWork).toBe(true);
      expect(r.copyIntact).toBe(true);
      expect(r.badError).toBe('ERRO: A cópia de wescc-livekit.exe não confere com o hash esperado (antivírus ou erro no disco?) e foi apagada; o que estava instalado continua como estava.');
      expect(r.afterBad).toBe('VERSAO-ANTERIOR');
      expect(r.filesAfterBad).toEqual(['wescc-livekit.exe']);
      expect(r.afterGood).toBe('WINSW-FIXADO');
      // A troca é por renomes: nem .novo nem .anterior ficam para trás.
      expect(r.filesAfterGood).toEqual(['wescc-livekit.exe']);
      expect(r.fresh).toBe('WINSW-FIXADO');
      expect(r.copyError).toMatch(/^ERRO: Não consegui gravar wescc-livekit\.exe em .*instalado \(.+\)\. Veja se o disco está cheio ou se o antivírus bloqueou o arquivo; o que estava instalado continua como estava\.$/);
      expect(r.afterCopyError).toBe('VERSAO-ANTERIOR');
      expect(r.filesAfterCopyError).toEqual(['livekit-server.exe', 'wescc-livekit.exe']);
      expect(r.zipError).toBe('ERRO: O arquivo baixado não confere com o hash esperado. Nada foi instalado.');
      expect(r.said).toEqual(['OK WinSW 2.12.0 conferido (SHA-256).']);
    });

    it('núcleos = processadores lógicos, como o LiveKit (400 faixas por CPU) e o nproc do install-linux.sh', () => {
      const r = ps(['Get-LogicalProcessorCount'], `
function Get-CimInstance { param($ClassName, $Filter, $ErrorAction)
  if ($ClassName -eq 'Win32_ComputerSystem') { return [pscustomobject]@{ NumberOfLogicalProcessors = $global:logical } }
  if ($ClassName -eq 'Win32_Processor') { return [pscustomobject]@{ NumberOfCores = 4 } }
}
$global:logical = 8
$out.eight = Get-LogicalProcessorCount
$global:logical = 128
$out.capped = Get-LogicalProcessorCount
function Get-CimInstance { throw 'WMI fora do ar' }
$out.fallback = Get-LogicalProcessorCount
$out.dotnet = [Environment]::ProcessorCount`);
      expect(r.eight).toBe(8);
      expect(r.capped).toBe(64);
      expect(r.fallback).toBe(Math.max(1, Math.min(64, r.dotnet)));
    });

    it('-Uninstall: o segredo só sai quando o wescc-chat.xml já não aponta para ele (na dúvida, fica)', () => {
      const r = ps(['Test-ChatUsesSecret'], `
$ChatServiceName = 'wescc-chat'
$SecretFile = 'C:\\Wescc\\secrets\\livekit-api-secret.txt'
$chatDir = Join-Path $root 'Wescc chat'
[void][IO.Directory]::CreateDirectory($chatDir)
$exe = Join-Path $chatDir 'wescc-chat.exe'
$global:svc = [pscustomobject]@{ PathName = '"' + $exe + '"' }
function Get-CimInstance { param($ClassName, $Filter, $ErrorAction) if ($ClassName -eq 'Win32_Service' -and $Filter -eq "Name='wescc-chat'") { return $global:svc } }
$xml = Join-Path $chatDir 'wescc-chat.xml'
[IO.File]::WriteAllText($xml, '<service><env name="LIVEKIT_API_SECRET_FILE" value="c:\\wescc\\SECRETS\\livekit-api-secret.txt"/></service>')
$out.uses = Test-ChatUsesSecret
[IO.File]::WriteAllText($xml, '<service><env name="NODE_ENV" value="production"/></service>')
$out.reconfigured = Test-ChatUsesSecret
Remove-Item -LiteralPath $xml
$out.noXml = Test-ChatUsesSecret
$global:svc = $null
$out.noService = Test-ChatUsesSecret`);
      expect(r).toMatchObject({ uses: true, reconfigured: false, noXml: true, noService: false });
    });

    it('pastas: criada por outra conta, com algo que outra conta altera, com um atalho ou com o que não é do servidor de chamadas, o instalador para; trancada, fica como está', () => {
      const r = ps(
        ['Invoke-Native', 'Get-ExplicitSids', 'Test-Locked', 'Get-AccountName', 'Get-UnsafeAccess', 'Get-NormalPath', 'Test-SamePath', 'Get-Ancestors', 'Test-ReparsePoint', 'Assert-OwnFolder', 'Assert-SafeLocation', 'Protect-Folder', 'Protect-Root', 'Reset-FileAcl', 'Write-ProtectedFile'],
        `
$out.root = $root
$CurrentSid = $null
$global:calls = @()
function icacls { $global:calls += ($args -join ' '); $global:LASTEXITCODE = 0 }
# Get-Acl como o Windows mostra: o dono, se a pasta herda e as permissões (SID e direitos). Sem anotação, dos
# Administradores, herdando, sem permissões de outras contas.
$global:acl = @{}
function Get-Acl { param([string]$LiteralPath)
  if (-not (Test-Path -LiteralPath $LiteralPath)) { throw "não existe: $LiteralPath" }
  $s = $global:acl[$LiteralPath]
  if (-not $s) { $s = @{ Protected = $false; Owner = 'S-1-5-32-544'; Rules = @() } }
  $o = [pscustomobject]@{ AreAccessRulesProtected = $s.Protected; State = $s }
  $o | Add-Member ScriptMethod GetOwner { param($t) [pscustomobject]@{ Value = $this.State.Owner } }
  $o | Add-Member ScriptMethod GetAccessRules { param($explicit, $inherited, $t) @($this.State.Rules | ForEach-Object { [pscustomobject]@{ IdentityReference = [pscustomobject]@{ Value = $_.Sid }; AccessControlType = 'Allow'; PropagationFlags = 0; FileSystemRights = $_.Rights } }) }
  return $o
}
function Try-It([scriptblock]$Do) { try { & $Do; return '' } catch { return "$($_.Exception.Message)" } }
$Full = 0x1F01FF
$Modify = 0x1301BF
$Read = 0x1200A9
$other = 'S-1-5-21-1-2-3-1001'
$service = 'S-1-5-80-1-2-3-4-5'
$WesccRoot = 'C:\\Wescc'

# Criada por outra conta, com um livekit.yaml com a chave dela (o caso do verificador): nada é usado nem mudado.
$planted = Join-Path $root 'plantada/livekit'
[void][IO.Directory]::CreateDirectory($planted)
[IO.File]::WriteAllText((Join-Path $planted 'livekit.yaml'), 'keys:')
$global:acl[$planted] = @{ Protected = $false; Owner = $other; Rules = @(@{ Sid = $other; Rights = $Full }) }
$out.planted = Try-It { Assert-OwnFolder $planted 'pasta do serviço' @($service) $OwnNames }

# Dos Administradores, mas com um install.json que outra conta pode alterar (outro -NodeExe, rodado como Administrador).
$loose = Join-Path $root 'solta/livekit'
[void][IO.Directory]::CreateDirectory($loose)
[IO.File]::WriteAllText((Join-Path $loose 'install.json'), '{}')
$global:acl[(Join-Path $loose 'install.json')] = @{ Protected = $false; Owner = 'S-1-5-32-544'; Rules = @(@{ Sid = 'S-1-5-11'; Rights = $Modify }) }
$out.writable = Try-It { Assert-OwnFolder $loose 'pasta do serviço' @($service) $OwnNames }

# Dos Administradores, outros só leem: segue, e a pasta é trancada com o que está dentro.
$admin = Join-Path $root 'admin/livekit'
[void][IO.Directory]::CreateDirectory($admin)
[IO.File]::WriteAllText((Join-Path $admin 'livekit.yaml'), 'keys:')
$global:acl[$admin] = @{ Protected = $false; Owner = 'S-1-5-32-544'; Rules = @(@{ Sid = 'S-1-5-32-545'; Rights = $Read }) }
$out.adminCheck = Try-It { Assert-OwnFolder $admin 'pasta do serviço' @($service) $OwnNames }
$global:calls = @()
$out.adminProtect = Try-It { Protect-Folder $admin 'pasta do serviço' @($service) $OwnNames }
$out.adminCalls = @($global:calls)

# Um arquivo que entra depois da conferência do passo 1: Protect-Folder confere de novo com o topo já trancado.
$race = Join-Path $root 'corrida/livekit'
[void][IO.Directory]::CreateDirectory($race)
$out.raceCheck = Try-It { Assert-OwnFolder $race 'pasta do serviço' @($service) $OwnNames }
[IO.File]::WriteAllText((Join-Path $race 'livekit.yaml'), 'keys:')
$global:acl[(Join-Path $race 'livekit.yaml')] = @{ Protected = $false; Owner = $other; Rules = @() }
$global:calls = @()
$out.race = Try-It { Protect-Folder $race 'pasta do serviço' @($service) $OwnNames }
$out.raceCalls = @($global:calls)

# Trancada: o que não é do servidor de chamadas (uma DLL ao lado do WinSW) e atalhos param o instalador; o resto fica.
$locked = Join-Path $root 'trancada/livekit'
[void][IO.Directory]::CreateDirectory((Join-Path $locked 'logs'))
foreach ($n in @('livekit-server.exe', 'wescc-livekit.exe', 'livekit-server.exe.anterior', '.livekit.yaml.4242.tmp', 'VERSION.dll')) { [IO.File]::WriteAllText((Join-Path $locked $n), 'x') }
$global:acl[$locked] = @{ Protected = $true; Owner = 'S-1-5-32-544'; Rules = @(@{ Sid = 'S-1-5-18'; Rights = $Full }, @{ Sid = 'S-1-5-32-544'; Rights = $Full }, @{ Sid = $service; Rights = $Read }) }
$out.unknown = Try-It { Assert-OwnFolder $locked 'pasta do serviço' @($service) $OwnNames }
Remove-Item -LiteralPath (Join-Path $locked 'VERSION.dll')
$out.lockedCheck = Try-It { Assert-OwnFolder $locked 'pasta do serviço' @($service) $OwnNames }
$global:calls = @()
Protect-Folder $locked 'pasta do serviço' @($service) $OwnNames
$out.lockedCalls = @($global:calls)
$null = New-Item -ItemType SymbolicLink -Path (Join-Path $locked 'logs/fora') -Target $root
$out.link = Try-It { Assert-OwnFolder $locked 'pasta do serviço' @($service) $OwnNames }
Remove-Item -LiteralPath (Join-Path $locked 'logs/fora')

# Pasta nova: dono e permissões, sem percorrer o que não existe.
$global:calls = @()
$fresh = Join-Path $root 'novo/livekit'
Protect-Folder $fresh 'pasta do serviço' @($service) $OwnNames
$out.fresh = @($global:calls)
$out.freshExists = Test-Path -LiteralPath $fresh

# Pastas acima: uma que outra conta renomeia, ou um atalho, param o instalador; o C:\\Wescc ele mesmo ajusta.
$apps = Join-Path $root 'D/Apps'
[void][IO.Directory]::CreateDirectory($apps)
$global:acl[$apps] = @{ Protected = $false; Owner = 'S-1-5-32-544'; Rules = @(@{ Sid = 'S-1-5-11'; Rights = $Modify }) }
$deep = Join-Path $apps 'livekit'
$out.renameable = Try-It { Assert-SafeLocation $deep 'pasta do serviço' }
[void][IO.Directory]::CreateDirectory((Join-Path $root 'E/real'))
$null = New-Item -ItemType SymbolicLink -Path (Join-Path $root 'E/atalho') -Target (Join-Path $root 'E/real')
$out.linkedParent = Try-It { Assert-SafeLocation (Join-Path $root 'E/atalho/livekit') 'pasta do serviço' }
$WesccRoot = $apps
$out.rootSkipped = Try-It { Assert-SafeLocation $deep 'pasta do serviço' }

# C:\\Wescc como o instalador do chat deixa: dono Administradores, os usuários só leem, as outras contas saem.
$global:calls = @()
$wescc = Join-Path $root 'Wescc'
[void][IO.Directory]::CreateDirectory($wescc)
$global:acl[$wescc] = @{ Protected = $false; Owner = $other; Rules = @(@{ Sid = 'S-1-5-11'; Rights = $Modify }, @{ Sid = 'S-1-5-32-545'; Rights = $Read }) }
Protect-Root $wescc
$out.rootCalls = @($global:calls)

# O arquivo é sempre novo: quem abriu o antigo antes de a pasta ser trancada continua lendo só o antigo.
$global:calls = @()
$envFile = Join-Path $locked 'chat-livekit.env'
[IO.File]::WriteAllText($envFile, 'LIVEKIT_URL=http://10.66.6.6:7880')
$handle = [IO.File]::Open($envFile, 'Open', 'Read', 'ReadWrite, Delete')
Write-ProtectedFile $envFile "LIVEKIT_URL=http://127.0.0.1:7880\`r\`n"
$reader = New-Object IO.StreamReader($handle)
$out.oldHandle = $reader.ReadToEnd()
$reader.Dispose()
$out.file = @($global:calls)
$out.text = [IO.File]::ReadAllText($envFile)
$out.filesAfterWrite = @(Get-ChildItem -LiteralPath $locked -Force -Filter 'chat-livekit.env*' | ForEach-Object Name)`,
        ['TrustedSids', 'UsersSid', 'RenameRights', 'WriteRights', 'ServiceName', 'OwnNames'],
      );
      const aside = (p: string) => `Confira com a TI quem criou isso, tire a pasta do caminho (Rename-Item -LiteralPath "${p}" -NewName "livekit.antiga") e rode o instalador de novo.`;
      const p = (rel: string) => path.join(r.root, rel);
      expect(r.planted).toBe(`ERRO: A pasta do serviço (${p('plantada/livekit')}) foi criada pela conta S-1-5-21-1-2-3-1001, não pelos Administradores nem por você. Quem cria uma pasta pode mantê-la aberta e continuar mexendo nela depois que as permissões mudam. ${aside(p('plantada/livekit'))}`);
      expect(r.writable).toBe(`ERRO: A pasta do serviço (${p('solta/livekit')}) não estava protegida pelo instalador, e ${p('solta/livekit/install.json')} pode ter sido gravado ou alterado por S-1-5-11: o instalador não usa o que outra conta pôde mudar. ${aside(p('solta/livekit'))}`);
      expect(r.adminCheck).toBe('');
      expect(r.adminProtect).toBe('');
      expect(r.adminCalls).toEqual([
        `${p('admin/livekit')} /setowner *S-1-5-32-544 /Q`,
        `${p('admin/livekit')} /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F /Q`,
        `${p('admin/livekit')} /remove *S-1-5-32-545 /Q`,
        `${p('admin/livekit')}/* /setowner *S-1-5-32-544 /T /C /L /Q`,
        `${p('admin/livekit')}/* /reset /T /C /L /Q`,
      ]);
      expect(r.raceCheck).toBe('');
      expect(r.race).toBe(`ERRO: A pasta do serviço (${p('corrida/livekit')}) não estava protegida pelo instalador, e ${p('corrida/livekit/livekit.yaml')} pode ter sido gravado ou alterado por S-1-5-21-1-2-3-1001 (dono): o instalador não usa o que outra conta pôde mudar. ${aside(p('corrida/livekit'))}`);
      // O topo já trancado, nada do que está dentro passou para os Administradores.
      expect(r.raceCalls).toHaveLength(2);
      expect(r.unknown).toBe(`ERRO: A pasta do serviço (${p('trancada/livekit')}) tem o que não é do servidor de chamadas: VERSION.dll. Use uma pasta só para ele (o padrão é C:\\Wescc\\livekit).`);
      expect(r.lockedCheck).toBe('');
      expect(r.lockedCalls).toEqual([]);
      expect(r.link).toBe(`ERRO: Há um atalho (link ou junção) para outro lugar em ${p('trancada/livekit/logs/fora')}, dentro da pasta do serviço (${p('trancada/livekit')}): o instalador e o serviço gravariam lá. ${aside(p('trancada/livekit'))}`);
      expect(r.freshExists).toBe(true);
      expect(r.fresh).toEqual([
        `${p('novo/livekit')} /setowner *S-1-5-32-544 /Q`,
        `${p('novo/livekit')} /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F /Q`,
      ]);
      expect(r.renameable).toBe(`ERRO: A pasta ${p('D/Apps')}, acima da pasta do serviço (${p('D/Apps/livekit')}), pode ser renomeada ou ter as permissões trocadas por S-1-5-11: outra pessoa poderia pôr no lugar o que o serviço roda. Use uma pasta dentro de C:\\Wescc (o padrão é C:\\Wescc\\livekit) ou peça à TI para proteger ${p('D/Apps')}.`);
      expect(r.linkedParent).toBe(`ERRO: A pasta ${p('E/atalho')}, acima da pasta do serviço (${p('E/atalho/livekit')}), é um atalho (link ou junção) para outra pasta. Use uma pasta de verdade, como C:\\Wescc\\livekit.`);
      expect(r.rootSkipped).toBe('');
      expect(r.rootCalls).toEqual([
        `${p('Wescc')} /setowner *S-1-5-32-544 /Q`,
        `${p('Wescc')} /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-32-545:(OI)(CI)RX /Q`,
        `${p('Wescc')} /remove *S-1-5-11 /Q`,
      ]);
      expect(r.oldHandle).toBe('LIVEKIT_URL=http://10.66.6.6:7880');
      expect(r.file).toEqual([`${p('trancada/livekit/chat-livekit.env.novo')} /setowner *S-1-5-32-544 /Q`, `${p('trancada/livekit/chat-livekit.env.novo')} /reset /Q`]);
      expect(r.text).toBe('LIVEKIT_URL=http://127.0.0.1:7880\r\n');
      expect(r.filesAfterWrite).toEqual(['chat-livekit.env']);
    });

    // O install-windows.ps1 inteiro, com o Windows simulado: serviços, firewall, icacls e netsh são funções que anotam
    // o que receberam; os caminhos C:\Wescc vão para uma pasta do teste. O LiveKit e o WinSW são arquivos de texto com
    // os SHA-256 de um versions.json do teste.
    describe('o script inteiro, com o Windows simulado', () => {
      let kit: { dir: string; script: string; offline: string; runner: string } | null = null;
      function winKit() {
        if (kit) return kit;
        const dir = fs.mkdtempSync(path.join(TMP, 'win-'));
        const lk = path.join(dir, 'scripts', 'livekit');
        const offline = path.join(dir, 'offline');
        fs.mkdirSync(lk, { recursive: true });
        fs.mkdirSync(offline);
        for (const f of ['render-config.mjs', 'livekit.yaml.tpl']) fs.copyFileSync(path.join(LIVEKIT_DIR, f), path.join(lk, f));
        const pins = JSON.parse(fs.readFileSync(path.join(LIVEKIT_DIR, 'versions.json'), 'utf8'));
        const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
        const exe = Buffer.from('LIVEKIT-FIXADO');
        const zip = storeZip('livekit-server.exe', exe);
        const winsw = Buffer.from('WINSW-FIXADO');
        fs.writeFileSync(path.join(offline, `livekit_${String(pins.livekit.version).replace(/^v/, '')}_windows_amd64.zip`), zip);
        fs.writeFileSync(path.join(offline, pins.winsw.file ?? 'WinSW-x64.exe'), winsw);
        pins.livekit.sha256.windows_amd64 = sha(zip);
        pins.livekit.exe_sha256.windows_amd64 = sha(exe);
        pins.winsw.sha256 = sha(winsw);
        fs.writeFileSync(path.join(lk, 'versions.json'), JSON.stringify(pins, null, 2));
        let src = fs.readFileSync(WIN_SCRIPT, 'utf8').replace(/^\uFEFF/, '');
        const swaps: [string, string][] = [
          [
            '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()\n$isAdmin = (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
            '$identity = $null\n$isAdmin = $true',
          ],
          ["[string]$InstallDir = 'C:\\Wescc\\livekit'", "[string]$InstallDir = (Join-Path $global:CRoot 'Wescc/livekit')"],
          ["$WesccRoot = 'C:\\Wescc'", "$WesccRoot = (Join-Path $global:CRoot 'Wescc')"],
          ["$SecretsDir = 'C:\\Wescc\\secrets'", "$SecretsDir = (Join-Path $global:CRoot 'Wescc/secrets')"],
          ["$ChatEnvFile = 'C:\\Wescc\\livekit\\chat-livekit.env'", "$ChatEnvFile = (Join-Path $global:CRoot 'Wescc/livekit/chat-livekit.env')"],
          ["$ChatInstallJson = 'C:\\Wescc\\chat\\install.json'", "$ChatInstallJson = (Join-Path $global:CRoot 'Wescc/chat/install.json')"],
          ["Invoke-Native $ServiceExe @('install')", "Invoke-Native 'winsw-mock' @('install')"],
          ["function Test-FullPath([string]$Path) { return ($Path -match '^[A-Za-z]:[\\\\/]') }", "function Test-FullPath([string]$Path) { return ($Path -match '^([A-Za-z]:[\\\\/]|/)') }"],
        ];
        for (const [from, to] of swaps) {
          expect(src.split(from).length - 1, from).toBe(1);
          src = src.replace(from, () => to);
        }
        const script = path.join(lk, 'install-windows.ps1');
        fs.writeFileSync(script, src);
        fs.writeFileSync(path.join(dir, 'mocks.ps1'), WIN_MOCKS);
        const runner = path.join(dir, 'run.ps1');
        fs.writeFileSync(
          runner,
          [
            'param([string]$Root, [string]$Scenario, [string]$ParamsJson)',
            '$global:CRoot = $Root',
            '$global:Scenario = $Scenario',
            `. ${q(path.join(dir, 'mocks.ps1'))}`,
            '$p = ConvertFrom-Json $ParamsJson -AsHashtable',
            '$global:LASTEXITCODE = 0',
            '$code = 0',
            `try { & ${q(script)} @p; $code = $LASTEXITCODE } finally { Save-Mock }`,
            'exit $code',
          ].join('\n'),
        );
        kit = { dir, script, offline, runner };
        return kit;
      }
      function run(root: string, scenario: string, params: Record<string, unknown>) {
        const k = winKit();
        const tmp = path.join(root, 'tmp');
        fs.mkdirSync(tmp, { recursive: true });
        const r = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', k.runner, '-Root', root, '-Scenario', scenario, '-ParamsJson', JSON.stringify(params)], {
          encoding: 'utf8',
          timeout: 120_000,
          env: { ...process.env, HOME: TMP, TMPDIR: tmp, POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off', NO_COLOR: '1' },
        });
        const state = JSON.parse(fs.readFileSync(path.join(root, 'mock.json'), 'utf8'));
        return { status: r.status, out: r.stdout + r.stderr, state, leftovers: fs.readdirSync(tmp).filter((n) => n.startsWith('wescc-livekit-')) };
      }
      const base = () => ({ NodeIp: '10.10.0.5', LanCidr: '10.10.0.0/16', Offline: winKit().offline, NodeExe: process.execPath });
      const restarted = 'O serviço wescc-livekit, parado no passo 8, foi iniciado de novo.';
      const names = (state: any) => (state.Rules ?? []).map((x: any) => x.Name);

      it('um erro com o serviço parado (antivírus, disco, Firewall do Windows) inicia o serviço de novo, apaga a pasta temporária e não tira as regras do firewall que valiam', () => {
        const root = fs.mkdtempSync(path.join(TMP, 'falhas-'));
        const old = [
          { Name: 'antiga-udp', DisplayName: 'Wescc LiveKit mídia UDP 7882-7885', Group: 'Wescc LiveKit' },
          { Name: 'antiga-tcp', DisplayName: 'Wescc LiveKit mídia TCP 7881', Group: 'Wescc LiveKit' },
        ];
        // Uma instalação que já roda (o serviço registrado, as regras do firewall no lugar).
        fs.writeFileSync(path.join(root, 'mock.json'), JSON.stringify({ Service: true, Running: true, Account: 'NT SERVICE\\wescc-livekit', Rules: old, Started: 0 }));

        // 1. Exceção que não passa por um Fail (o Unblock-File, depois de o serviço parar): antes, erro cru e chamadas fora do ar.
        let r = run(root, 'antivirus', base());
        expect(r.status, r.out).toBe(1);
        expect(r.out).toContain('ERRO: Erro inesperado no passo 8 (Serviço): O antivírus bloqueou o arquivo (simulado)');
        expect(r.out).toContain(restarted);
        expect(r.state.Calls.indexOf('Stop-Service wescc-livekit')).toBeGreaterThan(-1);
        expect(r.state.Calls.indexOf('Start-Service wescc-livekit')).toBeGreaterThan(r.state.Calls.indexOf('Stop-Service wescc-livekit'));
        expect(r.state.Running).toBe(true);
        expect(names(r.state)).toEqual(['antiga-udp', 'antiga-tcp']);
        expect(r.leftovers).toEqual([]);

        // 2. O Firewall do Windows recusa a segunda regra: a primeira nova sai, as antigas ficam.
        r = run(root, 'firewall', base());
        expect(r.status, r.out).toBe(1);
        expect(r.out).toMatch(/OK {2}Chave API[A-Za-z0-9]{12} mantida/);
        expect(r.out).toContain('ERRO: O Firewall do Windows não aceitou as regras do LiveKit (Acesso negado (simulado)). As regras que já existiam ficaram como estavam. Confira se o serviço Firewall do Windows (mpssvc) está ligado e rode o instalador de novo.');
        expect(r.out).toContain(restarted);
        expect(r.state.Calls.filter((c: string) => c.startsWith('New-NetFirewallRule'))).toEqual(['New-NetFirewallRule Wescc LiveKit mídia UDP 7882-7885']);
        expect(names(r.state)).toEqual(['antiga-udp', 'antiga-tcp']);
        expect(r.state.Running).toBe(true);
        expect(r.leftovers).toEqual([]);

        // 3. A cópia do livekit-server.exe nem chega a ser gravada (disco cheio; aqui, um .novo que é uma pasta).
        const lkDir = path.join(root, 'Wescc', 'livekit');
        fs.writeFileSync(path.join(lkDir, 'livekit-server.exe'), 'CORROMPIDO');
        fs.mkdirSync(path.join(lkDir, 'livekit-server.exe.novo'));
        r = run(root, 'ok', { Offline: winKit().offline });
        expect(r.status, r.out).toBe(1);
        expect(r.out).toContain(`ERRO: Não consegui gravar livekit-server.exe em ${lkDir} (`);
        expect(r.out).toContain('o que estava instalado continua como estava.');
        expect(r.out).toContain(restarted);
        expect(fs.readFileSync(path.join(lkDir, 'livekit-server.exe'), 'utf8')).toBe('CORROMPIDO');
        expect(r.state.Running).toBe(true);
        expect(r.leftovers).toEqual([]);

        // 4. Sem o problema, instala: o executável conferido no lugar, as regras novas, as antigas fora.
        fs.rmdirSync(path.join(lkDir, 'livekit-server.exe.novo'));
        r = run(root, 'ok', { Offline: winKit().offline });
        expect(r.status, r.out).toBe(0);
        expect(r.out).toContain('Pronto: o servidor de chamadas está rodando como serviço (LiveKit');
        expect(fs.readFileSync(path.join(lkDir, 'livekit-server.exe'), 'utf8')).toBe('LIVEKIT-FIXADO');
        expect(fs.readdirSync(lkDir).filter((n) => /\.(novo|anterior)$/.test(n))).toEqual([]);
        expect(r.state.Rules.map((x: any) => x.DisplayName)).toEqual(['Wescc LiveKit mídia UDP 7882-7885', 'Wescc LiveKit mídia TCP 7881']);
        expect(names(r.state).filter((n: string) => n.startsWith('antiga'))).toEqual([]);
        expect(r.state.Running).toBe(true);
        expect(r.leftovers).toEqual([]);
      }, 240_000);

      it('pasta criada por outra conta, pasta com o que não é do servidor de chamadas, -InstallDir na raiz ou acima dos segredos: para antes de mudar qualquer coisa e não usa a chave que estava lá', () => {
        // O caso do verificador: C:\Wescc\livekit criada por outro usuário, com um livekit.yaml com a chave dele.
        const planted = fs.mkdtempSync(path.join(TMP, 'plantada-'));
        const plantedDir = path.join(planted, 'Wescc', 'livekit');
        fs.mkdirSync(plantedDir, { recursive: true });
        fs.writeFileSync(path.join(plantedDir, 'livekit.yaml'), 'keys:\n  "APIatacante1234": "AtacanteConheceEsteSegredo_0123456789abcdef"\n');
        fs.writeFileSync(path.join(planted, 'acl.json'), JSON.stringify({ [plantedDir]: { Protected: false, Owner: 'S-1-5-21-9-9-9-1001', Rules: [{ Sid: 'S-1-5-21-9-9-9-1001', Rights: 0x1f01ff }] } }));
        let r = run(planted, 'ok', base());
        expect(r.status, r.out).toBe(1);
        expect(r.out).toContain(`ERRO: A pasta do serviço (${plantedDir}) foi criada pela conta S-1-5-21-9-9-9-1001, não pelos Administradores nem por você.`);
        expect(r.out).not.toContain('APIatacante1234');
        expect(r.state.Calls.filter((c: string) => c.startsWith('icacls'))).toEqual([]);
        expect(fs.existsSync(path.join(planted, 'Wescc', 'secrets'))).toBe(false);
        expect(r.leftovers).toEqual([]);

        // -InstallDir C:\Wescc (ou acima, ou a raiz, ou a pasta do chat): antes, ACLs refeitas em tudo, segredos inclusive.
        const shared = fs.mkdtempSync(path.join(TMP, 'compartilhada-'));
        const wescc = path.join(shared, 'Wescc');
        for (const d of ['chat', 'secrets', 'app']) fs.mkdirSync(path.join(wescc, d), { recursive: true });
        fs.writeFileSync(path.join(wescc, 'secrets', 'database-url.txt'), 'postgres://chat:senha@127.0.0.1:5432/chat');
        fs.writeFileSync(path.join(wescc, 'chat', 'wescc-chat.xml'), '<service/>');
        const useDefault = 'Use uma pasta só para o servidor de chamadas, como C:\\Wescc\\livekit (o padrão).';
        for (const [installDir, message] of [
          [wescc, `ERRO: -InstallDir (${wescc}) não pode ser nem conter ${wescc}. ${useDefault}`],
          [shared, `ERRO: -InstallDir (${shared}) não pode ser nem conter ${wescc}. ${useDefault}`],
          ['/', `ERRO: -InstallDir não pode ser a raiz de um disco (/). ${useDefault}`],
          [path.join(wescc, 'secrets', 'livekit'), `ERRO: -InstallDir (${path.join(wescc, 'secrets', 'livekit')}) não pode ficar dentro de ${path.join(wescc, 'secrets')}. ${useDefault}`],
          [path.join(wescc, 'chat'), `ERRO: A pasta do serviço (${path.join(wescc, 'chat')}) tem o que não é do servidor de chamadas: wescc-chat.xml. Use uma pasta só para ele (o padrão é C:\\Wescc\\livekit).`],
        ]) {
          // '/' é a raiz de verdade deste computador: com -WhatIf, um instalador que não recusasse não gravaria nada lá.
          r = run(shared, 'ok', { ...base(), InstallDir: installDir, ...(installDir === '/' ? { WhatIf: true } : {}) });
          expect(r.status, `${installDir}\n${r.out}`).toBe(1);
          expect(r.out).toContain(message);
          expect(r.state.Calls.filter((c: string) => c.startsWith('icacls'))).toEqual([]);
        }

        // Dos Administradores, mas sem a proteção do instalador: segue (aqui só simulando), com uma chave nova.
        const loose = fs.mkdtempSync(path.join(TMP, 'solta-'));
        const looseDir = path.join(loose, 'Wescc', 'livekit');
        fs.mkdirSync(looseDir, { recursive: true });
        fs.writeFileSync(path.join(looseDir, 'livekit.yaml'), 'keys:\n  "APIadminFez12345": "AdminFezEsteSegredo_0123456789abcdefghijklm"\n');
        r = run(loose, 'ok', { ...base(), WhatIf: true });
        expect(r.status, r.out).toBe(0);
        expect(r.out).toContain(`AVISO  Não usei a chave e o segredo de ${path.join(looseDir, 'livekit.yaml')}: a pasta não estava protegida pelo instalador. Vale uma chave nova.`);
        expect(r.out).toContain('[simulação] Geraria uma chave nova');
        expect(r.out).not.toContain('APIadminFez12345');
        expect(r.out).toContain('Simulação concluída: nada foi alterado.');
      }, 240_000);

      it('-Proxy com usuário e senha é recusado com ou sem http:// na frente, antes de qualquer passo', () => {
        const root = fs.mkdtempSync(path.join(TMP, 'proxy-'));
        for (const proxy of ['http://usuario:SenhaDoProxy@proxy.local:8080', 'usuario:SenhaDoProxy@proxy.local:8080', '//usuario:SenhaDoProxy@proxy.local:8080']) {
          const r = run(root, 'ok', { ...base(), Proxy: proxy });
          expect(r.status, `${proxy}\n${r.out}`).toBe(1);
          expect(r.out).toContain('ERRO: Não ponha usuário e senha em -Proxy (ficariam no histórico do PowerShell)');
          expect(r.out).not.toContain('SenhaDoProxy');
          expect(r.out).not.toContain('[1/11]');
          expect(r.state.Calls).toEqual([]);
        }
      }, 120_000);
    });
  });

  if (!PWSH) it.skip(SKIP_PWSH, () => {});
});

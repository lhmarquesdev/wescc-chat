#Requires -Version 5.1

<#
.SYNOPSIS
  Instala ou atualiza o servidor de chamadas em grupo do Wescc Chat (LiveKit) como serviço do Windows ("wescc-livekit").

.DESCRIPTION
  Baixa o LiveKit e o WinSW nas versões fixadas em scripts\livekit\versions.json (conferidos pelo SHA-256), gera a
  configuração com scripts\livekit\render-config.mjs e roda o LiveKit como o serviço "Wescc LiveKit", pela conta
  virtual NT SERVICE\wescc-livekit, a partir de C:\Wescc\livekit.

  A API e a sinalização do LiveKit (porta 7880) ficam só neste computador: os navegadores chegam a ela pelo próprio
  chat, em /sfu. A mídia vem direto para cá, em UDP 7882 a 7885 (e TCP 7881 quando o UDP está bloqueado), só das redes
  de -LanCidr. Sem TURN, sem STUN e sem internet.

  Pode rodar de novo quantas vezes quiser: a chave e o segredo continuam os mesmos e o que já está certo fica como
  está. As escolhas ficam em C:\Wescc\livekit\install.json (sem segredos) e valem para a próxima vez; o que você
  passar na linha de comando substitui o que estava salvo.

.PARAMETER NodeIp
  IP fixo deste computador na rede local, o endereço que os PCs das filiais alcançam (por exemplo 10.10.0.5).
  Obrigatório na primeira instalação.

.PARAMETER LanCidr
  Redes que fazem chamadas: a rede local e as das filiais (VPN), por exemplo 10.10.0.0/16,10.20.0.0/16.
  Obrigatório na primeira instalação.

.PARAMETER InstallDir
  Pasta do serviço: livekit-server.exe, wescc-livekit.exe, livekit.yaml e logs. Padrão: C:\Wescc\livekit. Sempre
  um caminho completo, com a letra do disco, e uma pasta só do servidor de chamadas (nova ou de uma instalação
  anterior): nem a raiz de um disco, nem C:\Wescc, nem uma pasta com outros arquivos.

.PARAMETER WebhookUrl
  Para onde o LiveKit avisa entradas e saídas. Padrão: http://127.0.0.1:3080/sfu-webhook (o ouvinte interno do chat
  com HTTPS próprio) ou, com o chat ainda em HTTP, http://127.0.0.1:<porta do chat>/sfu-webhook (lido de
  C:\Wescc\chat\install.json).

.PARAMETER MaxMbps
  Limite de banda do LiveKit, em Mbps. Padrão: 480 (metade de uma placa de 1 Gbps).

.PARAMETER MaxTracks
  Limite de faixas de áudio e vídeo do LiveKit (num_tracks, entrando e saindo), de 100 a 100000. Padrão: 400 por
  processador lógico, até 8000, como o próprio LiveKit. Use 0 para voltar ao padrão.

.PARAMETER NodeExe
  Caminho do node.exe (Node.js 22), usado para gerar a configuração. Padrão: o do PATH.

.PARAMETER Offline
  Pasta com livekit_<versão>_windows_amd64.zip e WinSW-x64.exe já baixados, para computadores sem acesso ao GitHub.
  Os arquivos são copiados para uma pasta temporária só do Administrador e conferidos lá.

.PARAMETER Proxy
  Proxy para baixar os arquivos (por exemplo http://proxy.empresa.local:8080), sem usuário e senha: o instalador entra
  no proxy com a sua conta do Windows.

.PARAMETER Uninstall
  Remove o serviço, as regras do firewall do grupo "Wescc LiveKit", as reservas de porta feitas por este script, os
  programas, o livekit.yaml e C:\Wescc\livekit\chat-livekit.env. O segredo em C:\Wescc\secrets sai junto, a não ser
  que o serviço do chat ainda o use. Os logs e install.json ficam.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\livekit\install-windows.ps1 -NodeIp 10.10.0.5 -LanCidr 10.10.0.0/16,10.20.0.0/16

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\livekit\install-windows.ps1 -NodeIp 10.10.0.5 -LanCidr 10.10.0.0/16 -WhatIf

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\livekit\install-windows.ps1 -Offline D:\wescc-arquivos

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\livekit\install-windows.ps1 -Uninstall
#>
# Só por nome: "-LanCidr 10.10.0.0/16 10.20.0.0/16" (espaço em vez de vírgula) não pode virar -InstallDir.
[CmdletBinding(SupportsShouldProcess = $true, PositionalBinding = $false)]
param(
  [string]$NodeIp,
  [string[]]$LanCidr,
  [string]$InstallDir = 'C:\Wescc\livekit',
  [string]$WebhookUrl,
  [int]$MaxMbps,
  [int]$MaxTracks,
  [string]$NodeExe,
  [string]$Offline,
  [string]$Proxy,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'

$ServiceName = 'wescc-livekit'
$ServiceAccount = "NT SERVICE\$ServiceName"
$ChatServiceName = 'wescc-chat'
$WesccRoot = 'C:\Wescc'
$SecretsDir = 'C:\Wescc\secrets'
$SecretFile = Join-Path $SecretsDir 'livekit-api-secret.txt'
$ChatEnvFile = 'C:\Wescc\livekit\chat-livekit.env'
$ChatInstallJson = 'C:\Wescc\chat\install.json'
$LiveKitUrl = 'http://127.0.0.1:7880'
$FirewallGroup = 'Wescc LiveKit'
$ApiPort = 7880
$TcpPort = 7881
$UdpFirst = 7882
$UdpLast = 7885
$DefaultMaxMbps = 480
$Simulate = [bool]$WhatIfPreference
$Utf8 = New-Object System.Text.UTF8Encoding $false
$VersionsFile = Join-Path $PSScriptRoot 'versions.json'
$RenderScript = Join-Path $PSScriptRoot 'render-config.mjs'
$TemplateFile = Join-Path $PSScriptRoot 'livekit.yaml.tpl'
# SYSTEM, Administradores e TrustedInstaller.
$TrustedSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$UsersSid = 'S-1-5-32-545'
# Direitos que deixam renomear ou apagar uma pasta, ou mudar as permissões e o dono dela.
$RenameRights = 0x10000 -bor 0x40 -bor 0x40000 -bor 0x80000 -bor 0x10000000
# Mais os que deixam criar ou alterar arquivos (uma DLL ao lado do WinSW, por exemplo).
$WriteRights = $RenameRights -bor 0x2 -bor 0x4 -bor 0x40000000
# O que pode haver na pasta do serviço e na do chat-livekit.env: qualquer outra coisa faz o instalador parar.
$OwnNames = @('livekit-server.exe', "$ServiceName.exe", "$ServiceName.xml", 'livekit.yaml', 'install.json', 'chat-livekit.env', 'logs',
  'livekit-server.exe.novo', 'livekit-server.exe.anterior', "$ServiceName.exe.novo", "$ServiceName.exe.anterior", 'chat-livekit.env.novo',
  '.livekit.yaml.*.tmp')

# ---------- Saída e utilitários ----------

$script:section = 0
$script:sectionTitle = ''
$script:workDir = $null
$script:stoppedService = $false
$script:reservedNow = @()
function Section([string]$Title) {
  $script:section++
  $script:sectionTitle = $Title
  Write-Host ''
  Write-Host ("[{0}/11] {1}" -f $script:section, $Title) -ForegroundColor White
}
function Info([string]$Message) { Write-Host "    $Message" }
function Ok([string]$Message) { Write-Host "    OK  $Message" -ForegroundColor Green }
function Warn([string]$Message) { Write-Host "    AVISO  $Message" -ForegroundColor Yellow }
function Remove-WorkDir {
  if ($script:workDir -and [IO.Directory]::Exists($script:workDir)) {
    try { [IO.Directory]::Delete($script:workDir, $true) } catch { Write-Host "    (não consegui apagar a pasta temporária $($script:workDir))" }
  }
  $script:workDir = $null
}
function Fail([string]$Message) {
  Remove-WorkDir
  Write-Host ''
  Write-Host "ERRO: $Message" -ForegroundColor Red
  # O serviço parado no passo 8 volta com o que está instalado: as chamadas não ficam fora do ar por um erro aqui.
  if ($script:stoppedService) {
    $script:stoppedService = $false
    try {
      Start-Service -Name $ServiceName -ErrorAction Stop
      Write-Host "O serviço $ServiceName, parado no passo 8, foi iniciado de novo." -ForegroundColor Yellow
    } catch {
      Write-Host "O serviço $ServiceName ficou parado e as chamadas em grupo estão fora do ar: corrija o problema e rode o instalador de novo." -ForegroundColor Yellow
    }
  }
  exit 1
}

# Um erro que não veio de um Fail (disco cheio, antivírus, o Firewall do Windows desligado) também passa por ele: o
# serviço parado no passo 8 volta e a pasta temporária sai.
trap {
  $where = ''
  if ($script:section) { $where = " no passo $($script:section) ($($script:sectionTitle))" }
  Fail ("Erro inesperado{0}: {1}" -f $where, $_.Exception.Message)
  break
}

# Mudanças passam todas por aqui: com -WhatIf só aparecem na tela.
function Invoke-Step([string]$Description, [scriptblock]$Action) {
  if ($Simulate) {
    Write-Host "    [simulação] $Description" -ForegroundColor Cyan
    return
  }
  Write-Host "    -> $Description"
  & $Action
}

# Programa externo (netsh, icacls, sc.exe, node). Com $ErrorActionPreference = 'Stop', o PowerShell 5.1 trata
# qualquer linha no stderr como erro fatal; aqui vale só o código de saída.
function Invoke-Native([string]$Exe, [string[]]$Arguments, [string]$ErrorMessage) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = @(& $Exe @Arguments 2>&1 | ForEach-Object { "$_" })
  } finally {
    $ErrorActionPreference = $old
  }
  if ($LASTEXITCODE -ne 0 -and $ErrorMessage) { Fail ("{0}`n{1}" -f $ErrorMessage, ($out -join "`n")) }
  return $out
}

# O render-config.mjs escreve em UTF-8; o console do Windows em português lê em 850 e estragaria os acentos.
function Invoke-Render([string[]]$Arguments) {
  $oldEncoding = $null
  try { $oldEncoding = [Console]::OutputEncoding; [Console]::OutputEncoding = $Utf8 } catch { $oldEncoding = $null }
  try {
    $out = @(Invoke-Native $NodeExe (@($RenderScript) + $Arguments) '')
    $code = $LASTEXITCODE
  } finally {
    if ($oldEncoding) { try { [Console]::OutputEncoding = $oldEncoding } catch { } }
  }
  foreach ($line in $out) { if ($line.StartsWith('AVISO: ')) { Warn $line.Substring(7) } }
  if ($code -ne 0) {
    $errors = @($out | Where-Object { $_.StartsWith('ERRO: ') } | ForEach-Object { $_.Substring(6) })
    if (-not $errors.Count) { $errors = @("render-config.mjs saiu com o código $code.") }
    Fail ($errors -join "`n")
  }
}

# Com -File, "-LanCidr a,b" chega como um texto só: aceita vírgulas nos dois jeitos.
function Split-List($Values) {
  @($Values | ForEach-Object { "$_" -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Test-Ipv4([string]$Ip) {
  if ($Ip -notmatch '^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$') { return $false }
  return ([int]$Matches[1] -ne 0 -and [int]$Matches[1] -lt 224)
}

function Test-Cidr([string]$Cidr) {
  $parts = $Cidr.Split('/')
  if ($parts.Count -ne 2 -or $parts[1] -notmatch '^(3[0-2]|[12]?\d)$') { return $false }
  return ($parts[0] -match '^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$')
}

function ConvertTo-IpNumber([string]$Ip) {
  $n = [int64]0
  foreach ($o in $Ip.Split('.')) { $n = $n * 256 + [int64]$o }
  return $n
}

function Test-InCidr([string]$Ip, [string]$Cidr) {
  $parts = $Cidr.Split('/')
  $size = [int64][math]::Pow(2, 32 - [int]$parts[1])
  return ([math]::Floor((ConvertTo-IpNumber $Ip) / $size) -eq [math]::Floor((ConvertTo-IpNumber $parts[0]) / $size))
}

function Get-Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

# Com a letra do disco: um caminho relativo dependeria da pasta de onde o script foi chamado.
function Test-FullPath([string]$Path) { return ($Path -match '^[A-Za-z]:[\\/]') }
function Get-NormalPath([string]$Path) { [IO.Path]::GetFullPath($Path).TrimEnd('\', '/') }
function Test-SamePath([string]$A, [string]$B) { (Get-NormalPath $A) -ieq (Get-NormalPath $B) }
# $Path é $Root ou fica dentro dela.
function Test-Within([string]$Path, [string]$Root) {
  $p = Get-NormalPath $Path
  $r = Get-NormalPath $Root
  ($p -ieq $r) -or $p.StartsWith($r + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}
function Test-DriveRoot([string]$Path) { (Get-NormalPath $Path) -ieq (Get-NormalPath ([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Path)))) }
function Get-Ancestors([string]$Path) {
  $list = @()
  $p = [IO.Path]::GetDirectoryName((Get-NormalPath $Path))
  while ($p) { $list += $p; $p = [IO.Path]::GetDirectoryName($p) }
  return $list
}
function Test-ReparsePoint([string]$Path) { ([int](Get-Item -LiteralPath $Path -Force).Attributes -band 0x400) -ne 0 }

# Processadores lógicos, como o próprio LiveKit conta (400 faixas por CPU) e como o nproc do install-linux.sh.
function Get-LogicalProcessorCount {
  $n = 0
  try { $n = [int](Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).NumberOfLogicalProcessors } catch { $n = 0 }
  if ($n -lt 1) { $n = [Environment]::ProcessorCount }
  return [math]::Max(1, [math]::Min(64, $n))
}

# SID da conta virtual NT SERVICE\<nome>: S-1-5-80 e o SHA-1 do nome em maiúsculas (vale antes de o serviço existir).
function Get-ServiceSid([string]$Name) {
  $hash = [Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::Unicode.GetBytes($Name.ToUpperInvariant()))
  'S-1-5-80-' + ((0..4 | ForEach-Object { [BitConverter]::ToUInt32($hash, $_ * 4) }) -join '-')
}

function Get-ExplicitSids([string]$Path) {
  try {
    return @((Get-Acl -LiteralPath $Path).GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value } | Select-Object -Unique)
  } catch {
    return @()
  }
}

function Get-AccountName([string]$Sid) {
  try { return (New-Object Security.Principal.SecurityIdentifier $Sid).Translate([Security.Principal.NTAccount]).Value } catch { return $Sid }
}

# Quem, fora das contas de $Allowed, tem em $Path algum dos direitos de $Mask. O dono conta sempre: ele pode mudar
# as permissões quando quiser.
function Get-UnsafeAccess([string]$Path, [int]$Mask, [string[]]$Allowed) {
  $acl = Get-Acl -LiteralPath $Path
  $who = @()
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($Allowed -notcontains $owner) { $who += "$(Get-AccountName $owner) (dono)" }
  foreach ($r in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ("$($r.AccessControlType)" -ne 'Allow') { continue }
    if (([int]$r.PropagationFlags -band 2) -ne 0) { continue } # InheritOnly: só vale para o que for criado dentro
    $sid = $r.IdentityReference.Value
    if ($Allowed -contains $sid -or $sid -eq 'S-1-3-0') { continue }
    if (([int]$r.FileSystemRights -band $Mask) -ne 0) { $who += Get-AccountName $sid }
  }
  return @($who | Select-Object -Unique)
}

# Já trancada: sem herança, dona SYSTEM ou Administradores, e nas permissões só eles e as contas de $Keep.
function Test-Locked([string]$Path, [string[]]$Keep) {
  try {
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected) { return $false }
    if ($TrustedSids -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { return $false }
    foreach ($r in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($TrustedSids -notcontains $r.IdentityReference.Value -and $Keep -notcontains $r.IdentityReference.Value) { return $false }
    }
    return $true
  } catch {
    return $false
  }
}

# O que já existia numa pasta que o instalador usa, sem seguir links. Trancada (Test-Locked), só os Administradores
# puderam mexer dentro, e só os atalhos são conferidos. Sem essa proteção, outra conta pode ter posto ali um
# livekit.yaml com uma chave que ela conhece, um install.json com outro -NodeExe ou uma DLL ao lado do WinSW, e quem
# cria um arquivo pode mantê-lo aberto depois que as permissões mudam: a pasta e tudo dentro precisam ser dos
# Administradores (ou de quem roda o instalador), e só eles podem alterar. Com -Names, só esses nomes podem estar nela
# (uma pasta com outras coisas não é só do servidor de chamadas). -Strict confere tudo mesmo com a pasta trancada.
function Assert-OwnFolder([string]$Path, [string]$What, [string[]]$Keep, [string[]]$Names, [switch]$Strict) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  if (Test-ReparsePoint $Path) { Fail "A $What ($Path) é um atalho (link ou junção) para outra pasta. Indique a pasta de verdade." }
  $aside = "Confira com a TI quem criou isso, tire a pasta do caminho (Rename-Item -LiteralPath ""$Path"" -NewName ""$(Split-Path -Leaf $Path).antiga"") e rode o instalador de novo."
  $children = @(Get-ChildItem -LiteralPath $Path -Force)
  if ($Names) {
    $other = @($children | Where-Object { $n = $_.Name; -not @($Names | Where-Object { $n -like $_ }).Count } | ForEach-Object { $_.Name })
    if ($other.Count) {
      Fail ("A {0} ({1}) tem o que não é do servidor de chamadas: {2}. Use uma pasta só para ele (o padrão é C:\Wescc\livekit)." -f $What, $Path, (@($other | Select-Object -First 5) -join ', '))
    }
  }
  $check = $Strict -or -not (Test-Locked $Path $Keep)
  $allowed = @($TrustedSids + @($CurrentSid) + @($Keep) | Where-Object { $_ })
  if ($check) {
    $owner = $null
    try { $owner = (Get-Acl -LiteralPath $Path).GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { $owner = $null }
    if (-not $owner) { Fail "Não consegui ler o dono da $What ($Path). $aside" }
    if ($allowed -notcontains $owner) {
      Fail "A $What ($Path) foi criada pela conta $(Get-AccountName $owner), não pelos Administradores nem por você. Quem cria uma pasta pode mantê-la aberta e continuar mexendo nela depois que as permissões mudam. $aside"
    }
  }
  $pending = New-Object System.Collections.Queue
  foreach ($c in $children) { $pending.Enqueue($c) }
  while ($pending.Count) {
    $item = $pending.Dequeue()
    $full = $item.FullName
    if (([int]$item.Attributes -band 0x400) -ne 0) { Fail "Há um atalho (link ou junção) para outro lugar em $full, dentro da $What ($Path): o instalador e o serviço gravariam lá. $aside" }
    if ($check) {
      $who = @()
      try { $who = @(Get-UnsafeAccess $full $WriteRights $allowed) } catch { $who = @('?') }
      if ($who.Count) {
        Fail "A $What ($Path) não estava protegida pelo instalador, e $full pode ter sido gravado ou alterado por $($who -join ', '): o instalador não usa o que outra conta pôde mudar. $aside"
      }
    }
    if ($item.PSIsContainer) {
      $inside = @()
      try { $inside = @(Get-ChildItem -LiteralPath $full -Force -ErrorAction Stop) } catch { Fail "Não consegui ler o conteúdo de $full, dentro da $What ($Path). $aside" }
      foreach ($c in $inside) { $pending.Enqueue($c) }
    }
  }
}

# Nenhuma pasta acima de $Path pode ser renomeada por outra conta, que poria outra no lugar (com outro
# livekit-server.exe ou outra chave). O C:\Wescc o próprio instalador ajusta (Protect-Root), como o do chat.
function Assert-SafeLocation([string]$Path, [string]$What) {
  if ((Test-Path -LiteralPath $Path) -and (Test-ReparsePoint $Path)) { Fail "A $What ($Path) é um atalho (link ou junção) para outra pasta. Indique a pasta de verdade." }
  foreach ($a in (Get-Ancestors $Path)) {
    if (-not (Test-Path -LiteralPath $a) -or (Test-SamePath $a $WesccRoot)) { continue }
    if (Test-ReparsePoint $a) { Fail "A pasta $a, acima da $What ($Path), é um atalho (link ou junção) para outra pasta. Use uma pasta de verdade, como C:\Wescc\livekit." }
    $who = @(Get-UnsafeAccess $a $RenameRights $TrustedSids)
    if ($who.Count) {
      Fail ("A pasta {0}, acima da {1} ({2}), pode ser renomeada ou ter as permissões trocadas por {3}: outra pessoa poderia pôr no lugar o que o serviço roda. Use uma pasta dentro de {4} (o padrão é C:\Wescc\livekit) ou peça à TI para proteger {0}." -f $a, $What, $Path, ($who -join ', '), $WesccRoot)
    }
  }
}

# C:\Wescc: só os Administradores criam, renomeiam ou apagam pastas nela; os outros usuários só leem. O mesmo que o
# install-chat-service.ps1 faz.
function Protect-Root([string]$Path) {
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  $msg = "Não consegui ajustar as permissões de $Path."
  Invoke-Native 'icacls' @($Path, '/setowner', '*S-1-5-32-544', '/Q') $msg | Out-Null
  Invoke-Native 'icacls' @($Path, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', "*${UsersSid}:(OI)(CI)RX", '/Q') $msg | Out-Null
  foreach ($sid in @(Get-ExplicitSids $Path)) {
    if ($TrustedSids -notcontains $sid -and $sid -ne $UsersSid) { Invoke-Native 'icacls' @($Path, '/remove', "*$sid", '/Q') $msg | Out-Null }
  }
}

# Pasta só de SYSTEM e Administradores, donos dela; as contas de $Keep (o serviço) mantêm o acesso que já têm. Já
# trancada, fica como está. Uma pasta que existia sem a proteção passou pelo Assert-OwnFolder no passo 1: com o topo
# trancado, ninguém mais cria nada ali, e o que está dentro é conferido de novo (pode ter entrado algo desde então)
# antes de passar para os Administradores e herdar só da pasta.
function Protect-Folder([string]$Path, [string]$What, [string[]]$Keep, [string[]]$Names) {
  $existed = Test-Path -LiteralPath $Path
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  if ($existed -and (Test-Locked $Path $Keep)) { return }
  $msg = "Não consegui ajustar as permissões de $Path."
  Invoke-Native 'icacls' @($Path, '/setowner', '*S-1-5-32-544', '/Q') $msg | Out-Null
  Invoke-Native 'icacls' @($Path, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/Q') $msg | Out-Null
  foreach ($sid in @(Get-ExplicitSids $Path)) {
    if ($TrustedSids -notcontains $sid -and $Keep -notcontains $sid) { Invoke-Native 'icacls' @($Path, '/remove', "*$sid", '/Q') $msg | Out-Null }
  }
  if ($existed -and @(Get-ChildItem -LiteralPath $Path -Force | Select-Object -First 1).Count) {
    Assert-OwnFolder $Path $What $Keep $Names -Strict
    $inside = Join-Path $Path '*'
    Invoke-Native 'icacls' @($inside, '/setowner', '*S-1-5-32-544', '/T', '/C', '/L', '/Q') $msg | Out-Null
    Invoke-Native 'icacls' @($inside, '/reset', '/T', '/C', '/L', '/Q') $msg | Out-Null
  }
}

# Dono Administradores e só as permissões herdadas da pasta (um arquivo que já existia pode trazer outras).
function Reset-FileAcl([string]$Path) {
  Invoke-Native 'icacls' @($Path, '/setowner', '*S-1-5-32-544', '/Q') "Não consegui ajustar as permissões de $Path." | Out-Null
  Invoke-Native 'icacls' @($Path, '/reset', '/Q') "Não consegui ajustar as permissões de $Path." | Out-Null
}

# Sem BOM (o chat e o install-chat-service.ps1 aparam só o fim), com as permissões da pasta, num arquivo novo que só
# então toma o lugar do antigo: quem abriu o antigo antes de a pasta ser trancada não lê o conteúdo novo.
function Write-ProtectedFile([string]$Path, [string]$Text) {
  $new = "$Path.novo"
  if ([IO.File]::Exists($new)) { [IO.File]::Delete($new) }
  [IO.File]::WriteAllText($new, $Text, $Utf8)
  Reset-FileAcl $new
  if ([IO.File]::Exists($Path)) { [IO.File]::Delete($Path) }
  [IO.File]::Move($new, $Path)
}

function Remove-Leftover([string]$Path) {
  try { if ([IO.File]::Exists($Path)) { [IO.File]::Delete($Path) } } catch { }
}

# Copia ao lado do destino, confere o SHA-256 da cópia e só então troca, por dois renomes no mesmo disco (o anterior
# volta para o lugar se o segundo falhar): o que estava instalado nunca dá lugar a um arquivo que não confere, nem
# some no meio. O arquivo novo fica com as permissões da pasta.
function Install-VerifiedFile([string]$Source, [string]$Destination, [string]$Hash) {
  $leaf = Split-Path -Leaf $Destination
  $dir = Split-Path -Parent $Destination
  $new = "$Destination.novo"
  $old = "$Destination.anterior"
  try {
    foreach ($f in @($new, $old)) { if ([IO.File]::Exists($f)) { [IO.File]::Delete($f) } }
    [IO.File]::Copy($Source, $new)
  } catch {
    $why = $_.Exception.Message
    Remove-Leftover $new
    Fail "Não consegui gravar $leaf em $dir ($why). Veja se o disco está cheio ou se o antivírus bloqueou o arquivo; o que estava instalado continua como estava."
  }
  if ((Get-Sha256 $new) -ne $Hash) {
    Remove-Leftover $new
    Fail "A cópia de $leaf não confere com o hash esperado (antivírus ou erro no disco?) e foi apagada; o que estava instalado continua como estava."
  }
  $hadOld = [IO.File]::Exists($Destination)
  try {
    if ($hadOld) { [IO.File]::Move($Destination, $old) }
    [IO.File]::Move($new, $Destination)
  } catch {
    $why = $_.Exception.Message
    if ($hadOld -and -not [IO.File]::Exists($Destination)) { try { [IO.File]::Move($old, $Destination) } catch { } }
    Remove-Leftover $new
    if ([IO.File]::Exists($Destination) -or -not $hadOld) {
      Fail "Não consegui pôr $leaf no lugar, em $dir ($why). O que estava instalado continua como estava."
    }
    Fail "Não consegui pôr $leaf no lugar, em $dir ($why), nem trazer o anterior de volta: ele ficou como $old. Rode o instalador de novo."
  }
  if ($hadOld) { Remove-Leftover $old }
}

function Escape-Xml([string]$Text) { [Security.SecurityElement]::Escape($Text) }

function New-RandomBytes([int]$Count) {
  $bytes = New-Object byte[] $Count
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return ,$bytes
}

# API + 12 letras e números, sem viés: bytes de 248 a 255 são descartados (248 = 4 x 62).
function New-ApiKey {
  $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  $sb = New-Object Text.StringBuilder
  while ($sb.Length -lt 12) {
    foreach ($b in (New-RandomBytes 32)) {
      if ($b -lt 248 -and $sb.Length -lt 12) { [void]$sb.Append($alphabet[$b % 62]) }
    }
  }
  return 'API' + $sb.ToString()
}

# 32 bytes aleatórios em base64url, sem "=" (43 caracteres).
function New-ApiSecret {
  return [Convert]::ToBase64String((New-RandomBytes 32)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Test-ApiKey([string]$Key) { return ($Key -cmatch '^API[A-Za-z0-9]{12}$') }
function Test-ApiSecret([string]$Secret) { return ($Secret -cmatch '^[A-Za-z0-9_-]{43}$') }

function Read-TextFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return [IO.File]::ReadAllText($Path, $Utf8)
}

# A chave e o segredo da configuração que já está rodando.
function Read-ExistingKeys([string]$Yaml) {
  $text = Read-TextFile $Yaml
  if (-not $text) { return $null }
  $m = [regex]::Match($text, '(?m)^keys:\r?\n[ \t]+"(API[A-Za-z0-9]{12})":[ \t]*"([A-Za-z0-9_-]{43})"[ \t]*\r?$')
  if ($m.Success) { return @{ Key = $m.Groups[1].Value; Secret = $m.Groups[2].Value } }
  return $null
}

function Read-EnvFile([string]$Path) {
  $values = @{}
  $text = Read-TextFile $Path
  if (-not $text) { return $values }
  foreach ($line in ($text -split "`r?`n")) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#') -or $t.IndexOf('=') -lt 1) { continue }
    $values[$t.Substring(0, $t.IndexOf('=')).Trim()] = $t.Substring($t.IndexOf('=') + 1).Trim().Trim('"')
  }
  return $values
}

function Get-ServicePids {
  $pids = @()
  $w = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
  if ($w -and $w.ProcessId) {
    $pids += [int]$w.ProcessId
    $pids += @(Get-CimInstance Win32_Process -Filter ("ParentProcessId={0}" -f $w.ProcessId) -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.ProcessId })
  }
  return $pids
}

function Get-OwnerText([int]$OwnerPid) {
  if ($OwnerPid -eq 4) { return 'o próprio Windows (PID 4, em geral o HTTP.sys)' }
  $proc = Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue
  $name = '?'
  if ($proc) { $name = "$($proc.ProcessName).exe" }
  $svc = Get-CimInstance Win32_Service -Filter "ProcessId=$OwnerPid" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($svc) { return "$name (PID $OwnerPid, serviço $($svc.Name))" }
  return "$name (PID $OwnerPid)"
}

# A definição do serviço do chat (wescc-chat.xml, ao lado do wescc-chat.exe) ainda aponta para o segredo? Apagá-lo
# antes do install-chat-service.ps1 -Reconfigure deixaria o chat sem subir. Na dúvida, conta como sim.
function Test-ChatUsesSecret {
  $svc = Get-CimInstance Win32_Service -Filter "Name='$ChatServiceName'" -ErrorAction SilentlyContinue
  if (-not $svc) { return $false }
  $image = ([string]$svc.PathName).Trim()
  if ($image.StartsWith('"')) { $image = $image.Substring(1, [math]::Max(0, $image.IndexOf('"', 1) - 1)) }
  try {
    return ([IO.File]::ReadAllText([IO.Path]::ChangeExtension($image, '.xml')).IndexOf($SecretFile, [StringComparison]::OrdinalIgnoreCase) -ge 0)
  } catch {
    return $true
  }
}

function Show-LogTail {
  foreach ($name in @("$ServiceName.err.log", "$ServiceName.out.log", "$ServiceName.wrapper.log")) {
    $f = Join-Path $LogDir $name
    if (Test-Path -LiteralPath $f) {
      Write-Host ''
      Write-Host "    Últimas linhas de ${f}:"
      Get-Content -LiteralPath $f -Tail 15 -Encoding UTF8 | ForEach-Object { Write-Host "      $_" }
    }
  }
}

# Faixas que o Windows reservou (Hyper-V, WSL, Docker Desktop) e a faixa de portas dinâmicas.
function Get-ExcludedRanges([string]$Protocol) {
  $ranges = @()
  foreach ($line in (Invoke-Native 'netsh' @('int', 'ipv4', 'show', 'excludedportrange', "protocol=$Protocol") "Não consegui ler as portas reservadas (netsh int ipv4 show excludedportrange protocol=$Protocol).")) {
    if ($line -match '^\s*(\d+)\s+(\d+)\s*(\*)?\s*$') {
      $ranges += New-Object PSObject -Property @{ Start = [int]$Matches[1]; End = [int]$Matches[2]; Administered = [bool]$Matches[3] }
    }
  }
  return $ranges
}
function Get-DynamicRange([string]$Protocol) {
  $numbers = @()
  foreach ($line in (Invoke-Native 'netsh' @('int', 'ipv4', 'show', 'dynamicport', $Protocol) '')) {
    if ($line -match ':\s*(\d+)\s*$') { $numbers += [int]$Matches[1] }
  }
  if ($numbers.Count -ge 2) { return New-Object PSObject -Property @{ Start = $numbers[0]; End = $numbers[0] + $numbers[1] - 1 } }
  return $null
}

Write-Host 'Wescc Chat: servidor de chamadas (LiveKit) como serviço do Windows' -ForegroundColor White
if ($Simulate) { Write-Host 'Simulação (-WhatIf): nada será alterado.' -ForegroundColor Cyan }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  if ($Simulate) {
    Warn 'Sem privilégio de Administrador: a simulação segue, mas a instalação de verdade precisa dele.'
  } else {
    Fail 'Abra o PowerShell como Administrador (botão direito > Executar como administrador) e rode de novo.'
  }
}
$CurrentSid = $null
if ($identity) { $CurrentSid = $identity.User.Value }

# Usuário e senha ficariam no histórico do PowerShell; o Invoke-WebRequest entra no proxy com a conta do Windows. Com
# ou sem http:// na frente, um @ só aparece no endereço de um proxy para separar o usuário e a senha.
if ($Proxy -match '@') {
  Fail 'Não ponha usuário e senha em -Proxy (ficariam no histórico do PowerShell): o instalador entra no proxy com a sua conta do Windows. Use só o endereço, por exemplo -Proxy http://proxy.empresa.local:8080.'
}
if (-not (Test-FullPath $InstallDir)) { Fail "Use em -InstallDir um caminho completo, com a letra do disco (por exemplo C:\Wescc\livekit), e não $InstallDir." }
# Relativo à pasta atual do PowerShell (o .NET usaria outra, a do processo).
if ($Offline) { $Offline = $PSCmdlet.GetUnresolvedProviderPathFromPSPath($Offline) }

$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$InstallJson = Join-Path $InstallDir 'install.json'
$LogDir = Join-Path $InstallDir 'logs'
$LiveKitExe = Join-Path $InstallDir 'livekit-server.exe'
$ServiceExe = Join-Path $InstallDir "$ServiceName.exe"
$ServiceXml = Join-Path $InstallDir "$ServiceName.xml"
$YamlFile = Join-Path $InstallDir 'livekit.yaml'
$LiveKitSid = Get-ServiceSid $ServiceName
$ChatSid = Get-ServiceSid $ChatServiceName
$ChatEnvDir = Split-Path -Parent $ChatEnvFile
$separateEnvDir = -not (Test-SamePath $ChatEnvDir $InstallDir)

# As escolhas salvas só valem de uma pasta que o instalador já tinha trancado: em outra, outra conta pode ter gravado
# um install.json com outro -NodeExe, que o instalador rodaria como Administrador.
function Read-SavedChoices([bool]$Trusted) {
  $saved = @{}
  if (-not (Test-Path -LiteralPath $InstallJson)) { return $saved }
  if (-not $Trusted) {
    Warn "Não usei as escolhas de ${InstallJson}: $InstallDir não estava protegida pelo instalador, e outra conta pode ter gravado nele."
    return $saved
  }
  try {
    foreach ($p in ([IO.File]::ReadAllText($InstallJson, $Utf8) | ConvertFrom-Json).PSObject.Properties) { $saved[$p.Name] = $p.Value }
  } catch {
    if (-not $Uninstall) { Fail ("Não consegui ler {0}: {1}" -f $InstallJson, $_.Exception.Message) }
    Warn ("Não consegui ler {0}: {1}. Sigo sem as escolhas salvas." -f $InstallJson, $_.Exception.Message)
  }
  return $saved
}

# ---------- Remoção (-Uninstall) ----------

if ($Uninstall) {
  Write-Host ''
  Write-Host 'Remover o servidor de chamadas' -ForegroundColor White
  foreach ($d in @($InstallDir, $ChatEnvDir)) {
    if ((Test-Path -LiteralPath $d) -and (Test-ReparsePoint $d)) { Fail "$d é um atalho (link ou junção) para outra pasta: o -Uninstall apagaria arquivos de lá. Confira com a TI." }
  }
  $installTrusted = Test-Locked $InstallDir @($LiveKitSid)
  $S = Read-SavedChoices $installTrusted

  $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($service) {
    if ($service.Status -ne 'Stopped') { Invoke-Step 'Parar o serviço wescc-livekit (as chamadas em grupo em andamento caem)' { Stop-Service -Name $ServiceName -Force } }
    if (Test-Path -LiteralPath $ServiceExe) {
      Invoke-Step 'Remover o serviço wescc-livekit (WinSW uninstall)' { Invoke-Native $ServiceExe @('uninstall') 'O WinSW não conseguiu remover o serviço.' | Out-Null }
    } else {
      Invoke-Step 'Remover o serviço wescc-livekit (sc.exe delete)' { Invoke-Native 'sc.exe' @('delete', $ServiceName) 'Não consegui remover o serviço wescc-livekit.' | Out-Null }
    }
  } else {
    Ok 'O serviço wescc-livekit não está instalado.'
  }

  $rules = @(Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue)
  if ($rules.Count) {
    Invoke-Step "Apagar as regras do firewall do grupo ""$FirewallGroup"" ($($rules.Count))" { $rules | Remove-NetFirewallRule }
  } else {
    Ok "Nenhuma regra do firewall no grupo ""$FirewallGroup""."
  }

  # Só as reservas que este script fez; as de outros (um administrador, o Docker) ficam como estão.
  $reserved = @(Split-List $S['ReservedPorts'] | Where-Object { $_ -match '^(tcp|udp)/\d+$' })
  foreach ($r in $reserved) {
    $proto, $port = $r.Split('/')
    Invoke-Step "Desfazer a reserva da porta $($proto.ToUpper()) $port (netsh int ipv4 delete excludedportrange)" {
      $null = Invoke-Native 'netsh' @('int', 'ipv4', 'delete', 'excludedportrange', "protocol=$proto", "startport=$port", 'numberofports=1', 'store=persistent') ''
      if ($LASTEXITCODE -ne 0) { Warn "Não consegui desfazer a reserva da porta $($proto.ToUpper()) $port (talvez já tenha sido desfeita)." }
    }
  }
  if (-not $reserved.Count) { Ok 'Nenhuma reserva de porta feita por este script.' }
  foreach ($block in @(@{ Protocol = 'tcp'; Ports = @($ApiPort, $TcpPort) }, @{ Protocol = 'udp'; Ports = @($UdpFirst..$UdpLast) })) {
    foreach ($range in @(Get-ExcludedRanges $block.Protocol)) {
      if ($range.Administered -and $range.Start -eq $range.End -and $block.Ports -contains $range.Start -and $reserved -notcontains "$($block.Protocol)/$($range.Start)") {
        Info "A porta $($block.Protocol.ToUpper()) $($range.Start) continua reservada por um administrador. Se a reserva era do LiveKit: netsh int ipv4 delete excludedportrange protocol=$($block.Protocol) startport=$($range.Start) numberofports=1 store=persistent"
      }
    }
  }

  # O livekit.yaml traz o segredo e sai sempre; sem chat-livekit.env, o -Reconfigure tira o LiveKit do chat.
  $removed = 0
  foreach ($f in @($LiveKitExe, "$LiveKitExe.novo", "$LiveKitExe.anterior", $ServiceExe, "$ServiceExe.novo", "$ServiceExe.anterior", $ServiceXml, $YamlFile, $ChatEnvFile, "$ChatEnvFile.novo")) {
    if (Test-Path -LiteralPath $f) {
      $removed++
      Invoke-Step "Apagar $f" { Remove-Item -LiteralPath $f -Force }
    }
  }
  if (-not $removed) { Ok 'Nenhum arquivo do LiveKit para apagar.' }
  if (Test-Path -LiteralPath $SecretFile) {
    if (Test-ChatUsesSecret) {
      Info "O segredo $SecretFile fica: o serviço do chat ainda o usa (ou o wescc-chat.xml não pôde ser conferido), e apagá-lo agora deixaria o chat sem subir. Rode scripts\windows\install-chat-service.ps1 -Reconfigure e depois este -Uninstall de novo."
    } else {
      Invoke-Step "Apagar o segredo $SecretFile" { Remove-Item -LiteralPath $SecretFile -Force; Remove-Leftover "$SecretFile.novo" }
    }
  } else {
    Ok "Nenhum segredo do LiveKit em $SecretsDir."
  }
  if ($installTrusted -and (Test-Path -LiteralPath $InstallJson)) {
    Invoke-Step "Anotar a remoção em $InstallJson" {
      $S.Remove('ReservedPorts')
      $S['UninstalledAt'] = (Get-Date).ToString('s')
      [IO.File]::WriteAllText($InstallJson, ((New-Object PSObject -Property $S) | ConvertTo-Json), $Utf8)
    }
  }

  Write-Host ''
  Info 'Rode scripts\windows\install-chat-service.ps1 -Reconfigure: o chat deixa de oferecer chamadas em grupo (Administração › Chamadas mostra "Não configurado").'
  Info "Ficaram em $InstallDir os logs e install.json (para instalar de novo com as mesmas escolhas); apague a pasta quando não precisar mais deles."
  Write-Host ''
  if ($Simulate) {
    Write-Host 'Simulação concluída: nada foi alterado.' -ForegroundColor Cyan
  } else {
    Write-Host 'Servidor de chamadas removido.' -ForegroundColor Green
  }
  exit 0
}

# ---------- 1. Ambiente ----------

Section 'Ambiente'

if (-not [Environment]::Is64BitOperatingSystem) { Fail 'O servidor de chamadas precisa do Windows de 64 bits (x64).' }

# Pastas: conferidas antes de qualquer leitura ou mudança. Tudo dentro da pasta do serviço fica só com os
# Administradores e o serviço ganha leitura nela inteira, então ela é só do servidor de chamadas.
$useDefault = 'Use uma pasta só para o servidor de chamadas, como C:\Wescc\livekit (o padrão).'
if (Test-DriveRoot $InstallDir) { Fail "-InstallDir não pode ser a raiz de um disco ($InstallDir). $useDefault" }
foreach ($d in @($WesccRoot, $SecretsDir)) {
  if (Test-Within $d $InstallDir) { Fail "-InstallDir ($InstallDir) não pode ser nem conter $d. $useDefault" }
}
if (Test-Within $InstallDir $SecretsDir) { Fail "-InstallDir ($InstallDir) não pode ficar dentro de $SecretsDir. $useDefault" }
$folders = @(
  @{ Path = $InstallDir; What = 'pasta do serviço'; Keep = @($LiveKitSid); Names = $OwnNames },
  @{ Path = $SecretsDir; What = 'pasta dos segredos'; Keep = @($ChatSid); Names = $null }
)
if ($separateEnvDir) { $folders += @{ Path = $ChatEnvDir; What = 'pasta do chat-livekit.env'; Keep = @(); Names = $OwnNames } }
foreach ($f in $folders) { Assert-SafeLocation $f.Path $f.What }
$fixRoot = -not (Test-Path -LiteralPath $WesccRoot)
if (-not $fixRoot) {
  if (Test-ReparsePoint $WesccRoot) { Fail "$WesccRoot é um atalho (link ou junção) para outra pasta. Use uma pasta de verdade." }
  $rootWho = @(Get-UnsafeAccess $WesccRoot $RenameRights $TrustedSids)
  if ($rootWho.Count) {
    $fixRoot = $true
    Info "Hoje outras contas ($($rootWho -join ', ')) podem renomear pastas em $WesccRoot; o passo 5 deixa isso só para os Administradores."
  }
}
foreach ($f in $folders) { Assert-OwnFolder $f.Path $f.What $f.Keep $f.Names }
# Chave, segredo e escolhas salvas só valem de pastas que já estavam trancadas; uma pasta nova não tem nada disso.
$installLocked = Test-Locked $InstallDir @($LiveKitSid)
$envLocked = $installLocked
if ($separateEnvDir) { $envLocked = Test-Locked $ChatEnvDir @() }
$secretsLocked = Test-Locked $SecretsDir @($ChatSid)
Ok 'Pastas conferidas: ninguém além dos Administradores mexe no que o serviço roda e lê.'

$S = Read-SavedChoices $installLocked
if ($S.Count) { Info "Usando as escolhas salvas em $InstallJson (o que veio na linha de comando tem precedência)." }
$given = $PSBoundParameters
if (-not $given.ContainsKey('NodeIp') -and $S['NodeIp']) { $NodeIp = [string]$S['NodeIp'] }
if (-not $given.ContainsKey('LanCidr') -and $S['LanCidr']) { $LanCidr = @($S['LanCidr']) }
if (-not $given.ContainsKey('MaxMbps')) {
  if ($S['MaxMbps']) { $MaxMbps = [int]$S['MaxMbps'] } else { $MaxMbps = $DefaultMaxMbps }
}
if (-not $given.ContainsKey('MaxTracks')) {
  if ($S['MaxTracks']) { $MaxTracks = [int]$S['MaxTracks'] } else { $MaxTracks = 0 }
}
if (-not $given.ContainsKey('NodeExe') -and $S['NodeExe']) { $NodeExe = [string]$S['NodeExe'] }

$NodeIp = "$NodeIp".Trim()
if (-not $NodeIp) { Fail 'Informe -NodeIp com o IP fixo deste computador na rede local (por exemplo -NodeIp 10.10.0.5).' }
if (-not (Test-Ipv4 $NodeIp)) { Fail "IP do servidor inválido: $NodeIp" }
$LanCidr = @(Split-List $LanCidr)
if (-not $LanCidr.Count) { Fail 'Informe -LanCidr com a rede local e as redes das filiais que fazem chamadas (por exemplo -LanCidr 10.10.0.0/16,10.20.0.0/16).' }
foreach ($c in $LanCidr) { if (-not (Test-Cidr $c)) { Fail "Faixa de rede inválida: $c (use o formato 10.10.0.0/16)." } }
if ($MaxMbps -lt 10 -or $MaxMbps -gt 10000) { Fail "Limite de banda inválido: $MaxMbps. Use -MaxMbps de 10 a 10000." }
if ($MaxTracks -ne 0 -and ($MaxTracks -lt 100 -or $MaxTracks -gt 100000)) { Fail "Limite de faixas inválido: $MaxTracks. Use -MaxTracks de 100 a 100000 (ou 0 para o padrão, 400 por processador lógico)." }

# A mídia chega pelos endereços deste computador que estão em -LanCidr; os outros (Hyper-V, WSL, VPN) ficam de fora.
$localIps = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.IPAddress } | Where-Object { $_ -and -not $_.StartsWith('127.') -and -not $_.StartsWith('169.254.') })
$lanIps = @($localIps | Where-Object { $ip = $_; @($LanCidr | Where-Object { Test-InCidr $ip $_ }).Count -gt 0 })
if ($localIps -notcontains $NodeIp) {
  Warn ("O IP {0} não está em nenhuma placa de rede deste computador ({1}). Use o IP fixo do servidor na rede local; outro endereço só faz sentido se as filiais chegam aqui por NAT." -f $NodeIp, ($localIps -join ', '))
}
if (-not $lanIps.Count) {
  Fail ("Nenhum endereço deste computador ({0}) está nas faixas de -LanCidr ({1}): o LiveKit não teria por onde receber a mídia. Inclua a rede local do servidor." -f ($localIps -join ', '), ($LanCidr -join ', '))
}
Ok ("Servidor em {0}; mídia pelas placas {1}; chamadas de {2}." -f $NodeIp, ($lanIps -join ', '), ($LanCidr -join ', '))

# Para onde vão os webhooks: o ouvinte interno do chat (HTTPS próprio) ou a porta do chat em HTTP.
$webhookNote = ''
if ($given.ContainsKey('WebhookUrl')) {
  $webhookExplicit = $WebhookUrl
} elseif ($S['WebhookUrl']) {
  $WebhookUrl = [string]$S['WebhookUrl']
  $webhookExplicit = $WebhookUrl
} else {
  $webhookExplicit = $null
  $WebhookUrl = 'http://127.0.0.1:3080/sfu-webhook'
  $chatState = $null
  if (Test-Path -LiteralPath $ChatInstallJson) {
    try { $chatState = [IO.File]::ReadAllText($ChatInstallJson, $Utf8) | ConvertFrom-Json } catch { $chatState = $null }
  }
  if ($chatState -and [string]$chatState.TlsMode -eq 'none' -and $chatState.Port) {
    $WebhookUrl = "http://127.0.0.1:$([int]$chatState.Port)/sfu-webhook"
    $webhookNote = " (o chat ainda está em HTTP, na porta $([int]$chatState.Port): ao ligar o HTTPS, rode este instalador de novo)"
  } elseif (-not $chatState) {
    $webhookNote = " (não achei $ChatInstallJson; vale para o chat com HTTPS próprio)"
  }
}
if ($WebhookUrl -notmatch '^http://127\.0\.0\.1:([1-9]\d{0,4})/sfu-webhook$' -or [int]$Matches[1] -gt 65535) {
  Fail "Endereço do webhook inválido: $WebhookUrl. Use http://127.0.0.1:<porta>/sfu-webhook (o chat neste mesmo computador)."
}
Ok "Webhooks para $WebhookUrl$webhookNote."

# Node.js 22, só para gerar a configuração (o LiveKit não precisa dele).
if (-not $NodeExe) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { $NodeExe = $cmd.Source }
}
if (-not $NodeExe -or -not (Test-Path -LiteralPath $NodeExe)) {
  Fail 'Não achei o node.exe. Instale o Node.js 22 LTS para todos os usuários (https://nodejs.org) ou indique o caminho com -NodeExe.'
}
$NodeExe = (Resolve-Path -LiteralPath $NodeExe).ProviderPath
$nodeVersion = [string](@(Invoke-Native $NodeExe @('--version') 'Não consegui rodar o node.exe.')[0])
if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { Fail "O instalador precisa do Node.js 22 ou mais novo; este é o $nodeVersion ($NodeExe)." }
Ok "Node.js $nodeVersion ($NodeExe)"

foreach ($f in @($VersionsFile, $RenderScript, $TemplateFile)) {
  if (-not (Test-Path -LiteralPath $f)) { Fail "Não achei $f. Copie a pasta scripts inteira do repositório." }
}
try {
  $pins = [IO.File]::ReadAllText($VersionsFile, $Utf8) | ConvertFrom-Json
} catch {
  Fail ("Não consegui ler {0}: {1}" -f $VersionsFile, $_.Exception.Message)
}
$lkVersion = ([string]$pins.livekit.version).TrimStart('v')
$lkZipName = "livekit_${lkVersion}_windows_amd64.zip"
$lkZipHash = ([string]$pins.livekit.sha256.windows_amd64).ToLowerInvariant()
$lkExeHash = ([string]$pins.livekit.exe_sha256.windows_amd64).ToLowerInvariant()
$winswVersion = ([string]$pins.winsw.version).TrimStart('v')
$winswFile = 'WinSW-x64.exe'
if ($pins.winsw.file) { $winswFile = [string]$pins.winsw.file }
$winswHash = ([string]$pins.winsw.sha256).ToLowerInvariant()
foreach ($h in @($lkZipHash, $lkExeHash, $winswHash)) {
  if ($h -notmatch '^[0-9a-f]{64}$') { Fail "$VersionsFile não traz os SHA-256 do LiveKit e do WinSW para Windows." }
}
if (-not $lkVersion -or -not $winswVersion) { Fail "$VersionsFile não traz as versões do LiveKit e do WinSW." }
Ok "Versões fixadas: LiveKit $lkVersion e WinSW $winswVersion ($VersionsFile)."

$cores = Get-LogicalProcessorCount
$tracks = [math]::Min(400 * $cores, 8000)
$tracksNote = ' (400 por processador lógico)'
if ($MaxTracks) { $tracks = $MaxTracks; $tracksNote = ' (-MaxTracks)' }
Ok "Processador: $cores processadores lógicos. Limites do LiveKit: $tracks faixas$tracksNote e $MaxMbps Mbps."

$script:workDir = Join-Path ([IO.Path]::GetTempPath()) ('wescc-livekit-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($script:workDir)

# ---------- 2. Download ----------

Section 'Download'

# Arquivo fixado em versions.json, de -Offline ou do GitHub, sempre na pasta temporária (só do Administrador) e
# conferido lá pelo SHA-256: quem pode gravar na pasta de -Offline não troca o arquivo depois da conferência.
function Get-PinnedFile([string]$Name, [string]$Url, [string]$Hash, [string]$What) {
  $src = Join-Path $script:workDir $Name
  if ($Offline) {
    $from = Join-Path $Offline $Name
    if (-not (Test-Path -LiteralPath $from -PathType Leaf)) { Fail "Não achei $Name em $Offline." }
    [IO.File]::Copy($from, $src, $true)
  } elseif ($Simulate) {
    Info "[simulação] Baixaria $Url e conferiria o SHA-256."
    return $null
  } else {
    Info "Baixando $Url"
    $request = @{ Uri = $Url; OutFile = $src; UseBasicParsing = $true }
    if ($Proxy) { $request.Proxy = $Proxy; $request.ProxyUseDefaultCredentials = $true }
    try {
      Invoke-WebRequest @request
    } catch {
      Fail ("Não consegui baixar {0} de {1} ({2}). Use -Proxy <url>, ou baixe {3} em outro computador e rode com -Offline <pasta>." -f $What, $Url, $_.Exception.Message, $Name)
    }
  }
  if ((Get-Sha256 $src) -ne $Hash) { Fail 'O arquivo baixado não confere com o hash esperado. Nada foi instalado.' }
  Ok "$What conferido (SHA-256)."
  return $src
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$lkNew = $null
$lkNeedsInstall = -not ((Test-Path -LiteralPath $LiveKitExe) -and (Get-Sha256 $LiveKitExe) -eq $lkExeHash)
if (-not $lkNeedsInstall) {
  Ok "LiveKit $lkVersion já instalado e conferido."
} else {
  $lkZip = Get-PinnedFile $lkZipName "https://github.com/livekit/livekit/releases/download/v$lkVersion/$lkZipName" $lkZipHash "LiveKit $lkVersion"
  if ($lkZip) {
    # O executável de dentro do pacote também é conferido, já extraído na pasta temporária: é essa cópia que vai
    # para o lugar no passo 8.
    $lkNew = Join-Path $script:workDir 'livekit-server.exe'
    $found = $false
    $zip = [IO.Compression.ZipFile]::OpenRead($lkZip)
    try {
      $entry = $zip.Entries | Where-Object { $_.FullName -eq 'livekit-server.exe' } | Select-Object -First 1
      if ($entry) {
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $lkNew, $true)
        $found = $true
      }
    } finally {
      $zip.Dispose()
    }
    if (-not $found) { Fail "O pacote $lkZipName não traz o livekit-server.exe." }
    if ((Get-Sha256 $lkNew) -ne $lkExeHash) { Fail 'O arquivo baixado não confere com o hash esperado. Nada foi instalado.' }
    Ok 'livekit-server.exe do pacote conferido (SHA-256).'
  }
}
$winswSource = $null
$winswNeedsInstall = -not ((Test-Path -LiteralPath $ServiceExe) -and (Get-Sha256 $ServiceExe) -eq $winswHash)
if (-not $winswNeedsInstall) {
  Ok "WinSW $winswVersion já instalado e conferido."
} else {
  $winswSource = Get-PinnedFile $winswFile "https://github.com/winsw/winsw/releases/download/v$winswVersion/$winswFile" $winswHash "WinSW $winswVersion"
}

# ---------- 3. Portas ----------

Section 'Portas'

$ourPids = @(Get-ServicePids)
$toReserve = @()
foreach ($block in @(@{ Protocol = 'tcp'; Ports = @($ApiPort, $TcpPort) }, @{ Protocol = 'udp'; Ports = @($UdpFirst..$UdpLast) })) {
  $excluded = @(Get-ExcludedRanges $block.Protocol)
  $dynamic = Get-DynamicRange $block.Protocol
  foreach ($p in $block.Ports) {
    $range = $excluded | Where-Object { $p -ge $_.Start -and $p -le $_.End } | Select-Object -First 1
    $inDynamic = $dynamic -and $p -ge $dynamic.Start -and $p -le $dynamic.End
    if ($range -and -not $range.Administered) {
      Info ("A porta {0} {1} está numa faixa reservada pelo Windows ({2}-{3}, em geral pelo Hyper-V ou pelo WSL do Docker Desktop)." -f $block.Protocol.ToUpper(), $p, $range.Start, $range.End)
      $toReserve += New-Object PSObject -Property @{ Protocol = $block.Protocol; Port = $p }
    } elseif (-not $range -and $inDynamic) {
      Info ("A porta {0} {1} está na faixa de portas dinâmicas ({2}-{3}): o Windows pode entregá-la a outro programa." -f $block.Protocol.ToUpper(), $p, $dynamic.Start, $dynamic.End)
      $toReserve += New-Object PSObject -Property @{ Protocol = $block.Protocol; Port = $p }
    }
  }
}
if ($toReserve.Count) {
  $list = ($toReserve | ForEach-Object { "$($_.Protocol.ToUpper()) $($_.Port)" }) -join ', '
  Invoke-Step "Parar o winnat, reservar $list para o LiveKit (store=persistent) e iniciar o winnat de novo (o Docker Desktop pode perder a rede por alguns segundos)" {
    Stop-Service -Name winnat -Force -ErrorAction SilentlyContinue
    $failed = @()
    foreach ($r in $toReserve) {
      $null = Invoke-Native 'netsh' @('int', 'ipv4', 'add', 'excludedportrange', "protocol=$($r.Protocol)", "startport=$($r.Port)", 'numberofports=1', 'store=persistent') ''
      # Fica em install.json para o -Uninstall desfazer.
      if ($LASTEXITCODE -ne 0) { $failed += "$($r.Protocol.ToUpper()) $($r.Port)" } else { $script:reservedNow += "$($r.Protocol)/$($r.Port)" }
    }
    Start-Service -Name winnat -ErrorAction SilentlyContinue
    if ($failed.Count) { Fail "Não consegui reservar $($failed -join ', '). Reinicie o computador e rode de novo antes de abrir o Docker Desktop." }
  }
}

foreach ($p in @($ApiPort, $TcpPort)) {
  $listeners = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Where-Object { $ourPids -notcontains [int]$_.OwningProcess })
  if ($listeners.Count) { Fail ("A porta TCP {0} está em uso por {1}. O servidor de chamadas precisa dela: pare esse programa (por exemplo um livekit-server.exe aberto na mão) e rode de novo." -f $p, (Get-OwnerText ([int]$listeners[0].OwningProcess))) }
  Ok "Porta TCP $p disponível."
}
$udpBusy = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge $UdpFirst -and $_.LocalPort -le $UdpLast -and $ourPids -notcontains [int]$_.OwningProcess })
if ($udpBusy.Count) { Fail ("A porta UDP {0} está em uso por {1}. O servidor de chamadas precisa das portas UDP {2} a {3}: pare esse programa e rode de novo." -f $udpBusy[0].LocalPort, (Get-OwnerText ([int]$udpBusy[0].OwningProcess)), $UdpFirst, $UdpLast) }
Ok "Portas UDP $UdpFirst a $UdpLast disponíveis."

# ---------- 4. Chaves ----------

Section 'Chaves'

# Rodar de novo não troca a chave: o chat e as chamadas em andamento continuam valendo. Só de pastas que já estavam
# trancadas (passo 1): numa outra, a chave pode ser de quem a pôs lá.
$keys = $null
if ($installLocked) { $keys = Read-ExistingKeys $YamlFile }
$loose = @()
if (-not $installLocked -and (Test-Path -LiteralPath $YamlFile)) { $loose += $YamlFile }
if (-not $envLocked -and (Test-Path -LiteralPath $ChatEnvFile)) { $loose += $ChatEnvFile }
if (-not $secretsLocked -and (Test-Path -LiteralPath $SecretFile)) { $loose += $SecretFile }
if ($loose.Count) { Warn "Não usei a chave e o segredo de $($loose -join ' e '): a pasta não estava protegida pelo instalador. Vale uma chave nova." }
if ($keys) {
  Ok "Chave $($keys.Key) mantida (de $YamlFile)."
} else {
  if ($installLocked -and (Test-Path -LiteralPath $YamlFile)) { Warn "Não achei a chave em ${YamlFile}: vale a do arquivo do chat, ou uma nova." }
  $envKey = $null
  if ($envLocked) { $envKey = (Read-EnvFile $ChatEnvFile)['LIVEKIT_API_KEY'] }
  $oldSecret = $null
  if ($secretsLocked) { $oldSecret = Read-TextFile $SecretFile }
  if ($oldSecret) { $oldSecret = $oldSecret.TrimStart([char]0xFEFF).TrimEnd() }
  if ($envKey -and (Test-ApiKey $envKey) -and $oldSecret -and (Test-ApiSecret $oldSecret)) {
    $keys = @{ Key = $envKey; Secret = $oldSecret }
    Ok "Chave $envKey mantida (de $ChatEnvFile e $SecretFile)."
  } else {
    $keys = @{ Key = (New-ApiKey); Secret = (New-ApiSecret) }
    if ($Simulate) {
      Info '[simulação] Geraria uma chave nova (API seguido de 12 letras e números) e um segredo de 32 bytes aleatórios.'
    } else {
      Ok "Chave nova: $($keys.Key). O segredo só vai para arquivos protegidos, nunca para a tela."
    }
  }
}

# ---------- 5. Arquivo do segredo ----------

Section 'Arquivo do segredo'

$secretsVerb = 'Criar'
if (Test-Path -LiteralPath $SecretsDir) { $secretsVerb = 'Conferir as permissões de' }
# SIDs em vez de nomes: funcionam no Windows em português (SISTEMA, Administradores).
if ($fixRoot) {
  Invoke-Step "Deixar $WesccRoot com os Administradores como donos: só eles criam, renomeiam ou apagam pastas ali; os outros usuários só leem" { Protect-Root $WesccRoot }
}
Invoke-Step "$secretsVerb $SecretsDir (dona e acesso só para SYSTEM e Administradores; o serviço do chat lê)" { Protect-Folder $SecretsDir 'pasta dos segredos' @($ChatSid) }
if (Get-Service -Name $ChatServiceName -ErrorAction SilentlyContinue) {
  Invoke-Step "Leitura em $SecretsDir para NT SERVICE\$ChatServiceName (o chat lê o segredo de lá)" {
    Invoke-Native 'icacls' @($SecretsDir, '/grant', "NT SERVICE\${ChatServiceName}:(OI)(CI)R", '/Q') "Não consegui dar acesso a $SecretsDir." | Out-Null
  }
} else {
  Info "O serviço do chat ainda não existe: o instalador do chat dá a ele leitura em $SecretsDir."
}
$currentSecret = Read-TextFile $SecretFile
if ($currentSecret) { $currentSecret = $currentSecret.TrimStart([char]0xFEFF).TrimEnd() }
if ($currentSecret -ceq $keys.Secret) {
  Ok "Segredo já gravado em $SecretFile."
} else {
  Invoke-Step "Gravar o segredo em $SecretFile" { Write-ProtectedFile $SecretFile $keys.Secret }
}

# ---------- 6. Configuração ----------

Section 'Configuração'

$installVerb = 'Criar'
if (Test-Path -LiteralPath $InstallDir) { $installVerb = 'Conferir as permissões de' }
Invoke-Step "$installVerb $InstallDir e $LogDir (dona e acesso só para SYSTEM e Administradores; o serviço ganha leitura no passo 8)" {
  Protect-Folder $InstallDir 'pasta do serviço' @($LiveKitSid) $OwnNames
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

$renderArgs = @('--node-ip', $NodeIp, '--lan-cidr', ($LanCidr -join ','), '--api-key', $keys.Key, '--webhook-url', $WebhookUrl, '--cores', [string]$cores, '--max-mbps', [string]$MaxMbps)
if ($MaxTracks) { $renderArgs += @('--max-tracks', [string]$MaxTracks) }
$oldYaml = Read-TextFile $YamlFile
$configChanged = $true
if ($Simulate) {
  # Confere os parâmetros com o próprio render-config.mjs e um segredo descartável (o de verdade não sai do arquivo).
  $probe = Join-Path $script:workDir 'segredo-de-teste.txt'
  [IO.File]::WriteAllText($probe, (New-ApiSecret), $Utf8)
  Invoke-Render ($renderArgs + @('--secret-file', $probe, '--out', (Join-Path $script:workDir 'livekit.yaml')))
  Ok 'Configuração conferida pelo render-config.mjs.'
  Invoke-Step "Gravar $YamlFile e deixar só SYSTEM, Administradores e o serviço lerem" { }
} else {
  Write-Host "    -> Gerar $YamlFile (render-config.mjs; o segredo vem de $SecretFile)"
  Invoke-Render ($renderArgs + @('--secret-file', $SecretFile, '--out', $YamlFile))
  Invoke-Native 'icacls' @($YamlFile, '/inheritance:r', '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F', '/Q') "Não consegui ajustar as permissões de $YamlFile." | Out-Null
  $configChanged = (Read-TextFile $YamlFile) -cne $oldYaml
  if ($configChanged) { Ok "Configuração gravada em $YamlFile." } else { Ok "Configuração sem mudanças ($YamlFile)." }
}

# ---------- 7. Ligação com o chat ----------

Section 'Ligação com o chat'

$envText = (@(
    "# Gerado por scripts\livekit\install-windows.ps1. O segredo fica em $SecretFile, nunca aqui.",
    '# Rode scripts\windows\install-chat-service.ps1 -Reconfigure para o chat usar estes valores.',
    "LIVEKIT_URL=$LiveKitUrl",
    "LIVEKIT_API_KEY=$($keys.Key)",
    "LIVEKIT_API_SECRET_FILE=$SecretFile"
  ) -join "`r`n") + "`r`n"
# O install-chat-service.ps1 -Reconfigure confia neste arquivo: com -InstallDir em outro lugar, a pasta dele fica tão
# fechada quanto a do serviço.
if ($separateEnvDir) {
  $envVerb = 'Criar'
  if (Test-Path -LiteralPath $ChatEnvDir) { $envVerb = 'Conferir as permissões de' }
  Invoke-Step "$envVerb $ChatEnvDir (dona e acesso só para SYSTEM e Administradores)" { Protect-Folder $ChatEnvDir 'pasta do chat-livekit.env' @() $OwnNames }
}
$chatLinkChanged = (Read-TextFile $ChatEnvFile) -cne $envText
if ($chatLinkChanged) {
  Invoke-Step "Gravar $ChatEnvFile (endereço, chave e o caminho do segredo, sem o segredo)" { Write-ProtectedFile $ChatEnvFile $envText }
} else {
  Ok "$ChatEnvFile já está atualizado."
}

# ---------- 8. Serviço ----------

Section 'Serviço'

$xml = @"
<?xml version="1.0" encoding="utf-8"?>
<!--
  Serviço do Windows do servidor de chamadas do Wescc Chat (LiveKit, WinSW 2.x). Gerado por
  scripts\livekit\install-windows.ps1: não edite à mão, rode o instalador de novo.
  Nenhum segredo fica aqui: a chave e o segredo estão no livekit.yaml, que só o serviço e os Administradores leem.
-->
<service>
  <id>$ServiceName</id>
  <name>Wescc LiveKit</name>
  <description>Servidor de chamadas em grupo do Wescc Chat (LiveKit $(Escape-Xml $lkVersion)).</description>
  <executable>$(Escape-Xml $LiveKitExe)</executable>
  <arguments>--config "$(Escape-Xml $YamlFile)"</arguments>
  <workingdirectory>$(Escape-Xml $InstallDir)</workingdirectory>
  <startmode>Automatic</startmode>
  <!-- O WinSW manda Ctrl+C e espera o LiveKit fechar as salas antes de encerrar o processo. -->
  <stoptimeout>15 sec</stoptimeout>
  <onfailure action="restart" delay="5 sec"/>
  <resetfailure>1 hour</resetfailure>
  <logpath>$(Escape-Xml $LogDir)</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
</service>
"@
$xml = $xml.Replace("`r`n", "`n").Replace("`n", "`r`n") + "`r`n"
$xmlChanged = (Read-TextFile $ServiceXml) -cne $xml

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
$running = [bool]($service -and $service.Status -ne 'Stopped')
$accountOk = $false
if ($service) { $accountOk = [string](Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue).StartName -eq $ServiceAccount }
$changed = [bool]($lkNeedsInstall -or $winswNeedsInstall -or $configChanged -or $xmlChanged -or -not $accountOk)
if ($running -and $changed) {
  Invoke-Step 'Parar o serviço wescc-livekit (as chamadas em andamento reconectam sozinhas quando ele voltar)' {
    Stop-Service -Name $ServiceName -Force
    $script:stoppedService = $true
  }
}
# As cópias conferidas no passo 2, da pasta temporária; cada uma é conferida de novo já ao lado do destino.
if ($lkNeedsInstall) {
  Invoke-Step "Instalar o livekit-server.exe $lkVersion em $InstallDir" {
    Install-VerifiedFile $lkNew $LiveKitExe $lkExeHash
    Unblock-File -LiteralPath $LiveKitExe
  }
}
if ($winswNeedsInstall) {
  Invoke-Step "Copiar o WinSW $winswVersion como $ServiceExe" {
    Install-VerifiedFile $winswSource $ServiceExe $winswHash
    Unblock-File -LiteralPath $ServiceExe
  }
}
if ($xmlChanged) {
  Invoke-Step "Gravar $ServiceXml" { [IO.File]::WriteAllText($ServiceXml, $xml, $Utf8) }
} else {
  Ok "$ServiceXml sem mudanças."
}
if (-not $service) {
  Invoke-Step 'Registrar o serviço wescc-livekit (início automático)' { Invoke-Native $ServiceExe @('install') 'O WinSW não conseguiu registrar o serviço.' | Out-Null }
} else {
  Ok 'Serviço wescc-livekit já registrado.'
}
if ($accountOk) {
  Ok "O serviço já roda como $ServiceAccount."
} else {
  Invoke-Step "Rodar o serviço como $ServiceAccount (conta virtual, sem senha)" {
    Invoke-Native 'sc.exe' @('config', $ServiceName, 'obj=', $ServiceAccount) "Não consegui trocar a conta do serviço para $ServiceAccount." | Out-Null
  }
}
# A conta virtual só existe depois do registro do serviço: por isso as permissões dela vêm aqui, e não no passo 6.
Invoke-Step "Permissões de $ServiceAccount`: leitura e execução em $InstallDir, leitura do livekit.yaml e escrita nos logs" {
  $grants = @(
    @($InstallDir, "${ServiceAccount}:(OI)(CI)RX"),
    @($YamlFile, "${ServiceAccount}:R"),
    @($LogDir, "${ServiceAccount}:(OI)(CI)M")
  )
  foreach ($g in $grants) { Invoke-Native 'icacls' @($g[0], '/grant', $g[1], '/Q') "Não consegui dar acesso a $($g[0])." | Out-Null }
}
Invoke-Step "Gravar as escolhas (sem segredos) em $InstallJson" {
  $state = [ordered]@{ NodeIp = $NodeIp; LanCidr = @($LanCidr); MaxMbps = $MaxMbps }
  if ($MaxTracks) { $state['MaxTracks'] = $MaxTracks }
  if ($webhookExplicit) { $state['WebhookUrl'] = $webhookExplicit }
  if ($given.ContainsKey('NodeExe') -or $S['NodeExe']) { $state['NodeExe'] = $NodeExe }
  $reservedPorts = @(@(Split-List $S['ReservedPorts']) + @($script:reservedNow) | Where-Object { $_ } | Select-Object -Unique)
  if ($reservedPorts.Count) { $state['ReservedPorts'] = $reservedPorts }
  $state['LiveKit'] = $lkVersion
  $state['WinSW'] = $winswVersion
  $state['UpdatedAt'] = (Get-Date).ToString('s')
  [IO.File]::WriteAllText($InstallJson, ($state | ConvertTo-Json), $Utf8)
}

# ---------- 9. Firewall ----------

Section 'Firewall'

# Regras por porta (não por programa), só das redes de -LanCidr. A 7880 nunca é aberta. As novas entram antes de as
# antigas saírem: se o Firewall do Windows recusar, as que já valiam continuam.
Invoke-Step ("Liberar UDP {0}-{1} e TCP {2} para {3} (perfis Domínio e Privado; a {4} fica só neste computador)" -f $UdpFirst, $UdpLast, $TcpPort, ($LanCidr -join ', '), $ApiPort) {
  $oldRules = @(Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue)
  $newRules = @()
  try {
    $newRules += New-NetFirewallRule -DisplayName "Wescc LiveKit mídia UDP $UdpFirst-$UdpLast" -Group $FirewallGroup -Direction Inbound -Action Allow -Protocol UDP -LocalPort "$UdpFirst-$UdpLast" -RemoteAddress $LanCidr -Profile Domain, Private -ErrorAction Stop
    $newRules += New-NetFirewallRule -DisplayName "Wescc LiveKit mídia TCP $TcpPort" -Group $FirewallGroup -Direction Inbound -Action Allow -Protocol TCP -LocalPort $TcpPort -RemoteAddress $LanCidr -Profile Domain, Private -ErrorAction Stop
  } catch {
    $why = $_.Exception.Message
    foreach ($r in $newRules) { try { $r | Remove-NetFirewallRule -ErrorAction Stop } catch { } }
    Fail "O Firewall do Windows não aceitou as regras do LiveKit ($why). As regras que já existiam ficaram como estavam. Confira se o serviço Firewall do Windows (mpssvc) está ligado e rode o instalador de novo."
  }
  if ($oldRules.Count) { $oldRules | Remove-NetFirewallRule }
}
$lanIfs = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $lanIps -contains [string]$_.IPAddress } | ForEach-Object { [int]$_.InterfaceIndex })
$profiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { -not $lanIfs.Count -or $lanIfs -contains [int]$_.InterfaceIndex })
$public = @($profiles | Where-Object { "$($_.NetworkCategory)" -eq 'Public' })
if ($public.Count) {
  Warn 'A rede deste computador está como Pública: o firewall vai bloquear as chamadas. Mude para Domínio ou Privada.'
  foreach ($n in $public) { Info "Adaptador: $($n.InterfaceAlias) ($($n.Name))" }
} else {
  Ok 'Rede como Domínio ou Privada.'
}
# Quem abriu o livekit-server.exe na mão e clicou em "Cancelar" no aviso do Windows criou regras de bloqueio,
# e bloqueio vale mais que liberação.
$blocks = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { "$($_.Program)" -like '*\livekit-server.exe' } | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { "$($_.Action)" -eq 'Block' -and "$($_.Direction)" -eq 'Inbound' -and "$($_.Enabled)" -eq 'True' })
if ($blocks.Count) {
  Warn ("Há regras do firewall que bloqueiam o livekit-server.exe ({0}). Bloqueio vale mais que liberação: apague-as em Firewall do Windows com Segurança Avançada > Regras de Entrada." -f (($blocks | ForEach-Object { $_.DisplayName } | Select-Object -Unique) -join ', '))
}

# ---------- 10. Início e teste ----------

Section 'Início e teste'

if ($changed -or -not $running) {
  Invoke-Step 'Iniciar o serviço wescc-livekit' {
    $script:stoppedService = $false
    try {
      Start-Service -Name $ServiceName -ErrorAction Stop
    } catch {
      Show-LogTail
      Fail "O Windows não conseguiu iniciar o serviço wescc-livekit ($($_.Exception.Message)). Veja o log em $LogDir."
    }
  }
} else {
  Ok 'Nada mudou: o serviço continua rodando, sem interromper as chamadas.'
}
if (-not $Simulate) {
  # O processo morrer nos primeiros segundos costuma ser antivírus, AppLocker, WDAC ou a configuração.
  $died = $false
  $lkPid = $null
  $until = (Get-Date).AddSeconds(6)
  while ((Get-Date) -lt $until) {
    $w = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
    if ($w.State -ne 'Running' -and $w.State -ne 'Start Pending') { $died = $true; break }
    $child = Get-CimInstance Win32_Process -Filter ("ParentProcessId={0}" -f $w.ProcessId) -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'livekit-server.exe' } | Select-Object -First 1
    if ($child) {
      if ($lkPid -and $child.ProcessId -ne $lkPid) { $died = $true; break }
      $lkPid = $child.ProcessId
    } elseif ($lkPid) {
      $died = $true
      break
    }
    Start-Sleep -Milliseconds 500
  }
  if ($died) {
    Show-LogTail
    Fail "O serviço do LiveKit inicia e para logo em seguida. Veja o log em $LogDir. Se o antivírus, o AppLocker ou o WDAC bloqueou livekit-server.exe ou wescc-livekit.exe, peça à TI para liberar pelo hash (SHA-256 em scripts/livekit/versions.json)."
  }

  # Direto, sem o proxy do navegador.
  $healthy = $false
  $lastError = ''
  $oldProxy = [Net.WebRequest]::DefaultWebProxy
  [Net.WebRequest]::DefaultWebProxy = New-Object Net.WebProxy
  try {
    $until = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $until) {
      try {
        $res = Invoke-WebRequest -UseBasicParsing -Uri "$LiveKitUrl/" -TimeoutSec 3
        if ($res.StatusCode -eq 200 -and "$($res.Content)".Trim() -eq 'OK') { $healthy = $true; break }
        $lastError = "resposta inesperada ($($res.StatusCode))"
      } catch {
        $lastError = $_.Exception.Message
      }
      Start-Sleep -Seconds 1
    }
  } finally {
    [Net.WebRequest]::DefaultWebProxy = $oldProxy
  }
  if (-not $healthy) {
    Show-LogTail
    Fail "O LiveKit não respondeu em $LiveKitUrl em 30 s ($lastError). Veja o log em $LogDir."
  }
  Ok "O LiveKit respondeu OK em $LiveKitUrl."

  # Onde cada porta escuta: a API só em 127.0.0.1; a mídia nas placas da rede local.
  $lkPids = @(Get-ServicePids)
  $api = @(Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue | Where-Object { $lkPids -contains [int]$_.OwningProcess } | ForEach-Object { [string]$_.LocalAddress } | Select-Object -Unique)
  $open = @($api | Where-Object { $_ -ne '127.0.0.1' })
  if ($open.Count) {
    Warn "O LiveKit escuta a porta $ApiPort também em $($open -join ', '): esta versão não respeitou bind_addresses. O firewall continua bloqueando a $ApiPort, porque nenhuma regra a abre."
  } else {
    Ok "A API do LiveKit (TCP $ApiPort) escuta só em 127.0.0.1."
  }
  $tcp = @(Get-NetTCPConnection -LocalPort $TcpPort -State Listen -ErrorAction SilentlyContinue | Where-Object { $lkPids -contains [int]$_.OwningProcess } | ForEach-Object { [string]$_.LocalAddress } | Select-Object -Unique)
  if ($tcp.Count) { Ok "Mídia por TCP $TcpPort em $($tcp -join ', ')." } else { Warn "O LiveKit não está escutando a porta TCP $TcpPort (mídia quando o UDP está bloqueado). Veja o log em $LogDir." }
  $udp = @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge $UdpFirst -and $_.LocalPort -le $UdpLast -and $lkPids -contains [int]$_.OwningProcess } | ForEach-Object { [string]$_.LocalAddress } | Select-Object -Unique)
  if ($udp.Count) { Ok "Mídia por UDP $UdpFirst a $UdpLast em $($udp -join ', ')." } else { Warn "O LiveKit não está escutando as portas UDP $UdpFirst a $UdpLast. Confira -LanCidr e o log em $LogDir." }
}

# ---------- 11. Próximos passos ----------

Section 'Próximos passos'
Info 'Rode scripts\windows\install-chat-service.ps1 -Reconfigure para o chat usar o servidor de chamadas.'
Info 'Depois, em Admin › Chamadas, use Testar minha conexão em um PC de cada site.'
Info ("Na VPN e nos firewalls das filiais, libere UDP {0} a {1} e TCP {2} até {3}." -f $UdpFirst, $UdpLast, $TcpPort, $NodeIp)
Info 'Para a TI liberar no antivírus, AppLocker ou WDAC (SHA-256, também em scripts\livekit\versions.json):'
Info "  livekit-server.exe  $lkExeHash"
Info "  wescc-livekit.exe   $winswHash (WinSW $winswVersion)"
Info 'Arquivos baixados da internet ficam marcados pelo Windows (Mark-of-the-Web). Antes de rodar uma cópia nova da pasta scripts:'
Info '  Get-ChildItem -Recurse .\scripts | Unblock-File'
Info "Log do serviço: $LogDir. Parar e iniciar: Stop-Service wescc-livekit / Start-Service wescc-livekit."
Info 'Para remover: powershell -ExecutionPolicy Bypass -File .\scripts\livekit\install-windows.ps1 -Uninstall'
Remove-WorkDir
Write-Host ''
if ($Simulate) {
  Write-Host 'Simulação concluída: nada foi alterado.' -ForegroundColor Cyan
} else {
  Write-Host "Pronto: o servidor de chamadas está rodando como serviço (LiveKit $lkVersion)." -ForegroundColor Green
}

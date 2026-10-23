#Requires -Version 5.1
<#
.SYNOPSIS
  Instala ou atualiza o Wescc Chat como serviço do Windows ("wescc-chat"), com HTTPS próprio.

.DESCRIPTION
  Roda o chat já compilado (server\dist e web\dist) como o serviço "Wescc Chat", pela conta virtual
  NT SERVICE\wescc-chat, com o WinSW. Senhas e chaves ficam em arquivos em C:\Wescc\secrets (só SYSTEM,
  Administradores e o serviço leem); nada secreto vai para a definição do serviço nem para a tela.

  Pode rodar de novo quantas vezes quiser: o que já está certo fica como está. As escolhas ficam em
  C:\Wescc\chat\install.json (sem segredos) e valem para a próxima vez; o que você passar na linha de comando
  substitui o que estava salvo.

  Sem certificado (-PfxFile ou -CertFile/-KeyFile), o chat fica em HTTP (porta 3000), como hoje. Quando a TI
  entregar o certificado, rode de novo com -PfxFile e -SiteUrl https://...: as portas antigas passam a
  redirecionar para o endereço novo.

.PARAMETER AppDir
  Pasta do chat compilado (npm ci e npm run build), com server\dist, web\dist e node_modules.

.PARAMETER InstallDir
  Pasta do serviço: wescc-chat.exe, wescc-chat.xml, logs e install.json. Padrão: C:\Wescc\chat.

.PARAMETER SiteUrl
  Endereço do chat para as pessoas, por exemplo https://chat.empresa.local (o mesmo nome do certificado).

.PARAMETER Port
  Porta do chat. Padrão: 443 com HTTPS, 3000 sem.

.PARAMETER RedirectPorts
  Portas HTTP que redirecionam para o SiteUrl. Padrão: 80 (e a porta antiga, ao ligar o HTTPS).

.PARAMETER PfxFile
  Certificado PFX exportado do AD CS (com a chave). A senha é pedida na tela.

.PARAMETER CertFile
  Certificado em PEM (pode trazer a cadeia), junto com -KeyFile.

.PARAMETER KeyFile
  Chave privada em PEM, sem senha.

.PARAMETER LanCidr
  Redes que acessam o chat: a rede local e as das filiais (VPN), por exemplo 10.10.0.0/16,10.20.0.0/16.

.PARAMETER NodeExe
  Caminho do node.exe (Node.js 22). Padrão: o do PATH.

.PARAMETER UploadDir
  Pasta dos arquivos enviados. Padrão: C:\Wescc\chat\uploads (ou server\uploads do AppDir, se já houver arquivos lá).

.PARAMETER Offline
  Pasta com o WinSW-x64.exe já baixado, para computadores sem acesso ao GitHub.

.PARAMETER Proxy
  Proxy para baixar o WinSW (por exemplo http://proxy.empresa.local:8080).

.PARAMETER Reconfigure
  Reescreve a definição do serviço com as escolhas salvas (e C:\Wescc\livekit\chat-livekit.env, se existir)
  e reinicia o serviço, sem pedir senhas.

.PARAMETER Uninstall
  Remove o serviço, as regras do firewall do grupo "Wescc Chat", as reservas de porta feitas por este script e o
  acesso do serviço a C:\Wescc\secrets. Os logs, os arquivos enviados e install.json ficam em C:\Wescc\chat.

.PARAMETER RemoveSecrets
  Com -Uninstall, apaga também os segredos do chat em C:\Wescc\secrets (certificado, senha do PFX e endereço do
  banco). O segredo do LiveKit fica.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-chat-service.ps1 -AppDir C:\Wescc\app -SiteUrl https://chat.empresa.local -PfxFile C:\Temp\chat.pfx -LanCidr 10.10.0.0/16,10.20.0.0/16

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-chat-service.ps1 -Reconfigure

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-chat-service.ps1 -AppDir C:\Wescc\app -SiteUrl https://chat.empresa.local -PfxFile C:\Temp\chat.pfx -LanCidr 10.10.0.0/16 -WhatIf

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-chat-service.ps1 -Uninstall -RemoveSecrets
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$AppDir,
  [string]$InstallDir = 'C:\Wescc\chat',
  [string]$SiteUrl,
  [int]$Port,
  [string[]]$RedirectPorts,
  [string]$PfxFile,
  [string]$CertFile,
  [string]$KeyFile,
  [string[]]$LanCidr,
  [string]$NodeExe,
  [string]$UploadDir,
  [string]$Offline,
  [string]$Proxy,
  [switch]$Reconfigure,
  [switch]$Uninstall,
  [switch]$RemoveSecrets
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'

$ServiceName = 'wescc-chat'
$ServiceAccount = "NT SERVICE\$ServiceName"
$WesccRoot = 'C:\Wescc'
$SecretsDir = Join-Path $WesccRoot 'secrets'
$LiveKitEnvFile = Join-Path $WesccRoot 'livekit\chat-livekit.env'
$InternalPort = 3080
$FirewallGroup = 'Wescc Chat'
$Simulate = [bool]$WhatIfPreference
$Utf8 = New-Object System.Text.UTF8Encoding $false
$VersionsFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'livekit\versions.json'
$TemplateFile = Join-Path $PSScriptRoot 'chat-service.xml.tpl'

$PfxTarget = Join-Path $SecretsDir 'chat.pfx'
$CertTarget = Join-Path $SecretsDir 'chat.crt'
$KeyTarget = Join-Path $SecretsDir 'chat.key'
$PassFile = Join-Path $SecretsDir 'tls-pfx-passphrase.txt'
$DbFile = Join-Path $SecretsDir 'database-url.txt'
$LiveKitSecretFile = Join-Path $SecretsDir 'livekit-api-secret.txt'

# ---------- Saída e utilitários ----------

$script:section = 0
function Section([string]$Title) {
  $script:section++
  Write-Host ''
  Write-Host ("[{0}/8] {1}" -f $script:section, $Title) -ForegroundColor White
}
function Info([string]$Message) { Write-Host "    $Message" }
function Ok([string]$Message) { Write-Host "    OK  $Message" -ForegroundColor Green }
function Warn([string]$Message) { Write-Host "    AVISO  $Message" -ForegroundColor Yellow }
function Fail([string]$Message) {
  Write-Host ''
  Write-Host "ERRO: $Message" -ForegroundColor Red
  exit 1
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

# Programa externo (netsh, icacls, sc.exe). Com $ErrorActionPreference = 'Stop', o PowerShell 5.1 trata
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

# Com -File, "-LanCidr a,b" chega como um texto só: aceita vírgulas nos dois jeitos.
function Split-List($Values) {
  @($Values | ForEach-Object { "$_" -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Test-Cidr([string]$Cidr) {
  if ($Cidr -notmatch '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/(\d{1,2})$') { return $false }
  foreach ($i in 1..4) { if ([int]$Matches[$i] -gt 255) { return $false } }
  return ([int]$Matches[5] -le 32)
}

function ConvertFrom-SecureText([Security.SecureString]$Secure) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Get-Sha256([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

function Test-InUserProfile([string]$Path) { $Path -like "$env:SystemDrive\Users\*" }

function Escape-Xml([string]$Text) { [Security.SecurityElement]::Escape($Text) }

# ---------- Permissões ----------
# O serviço roda o wescc-chat.exe, o wescc-chat.xml, o node.exe e o server\dist\index.js como NT SERVICE\wescc-chat,
# que lê os segredos. Quem puder trocar um desses arquivos, ou renomear uma pasta acima deles e pôr outra no lugar,
# roda o que quiser como o serviço. Por isso as pastas do chat ficam só com SYSTEM e Administradores (donos de tudo),
# e o serviço ganha só o acesso de que precisa.

# SIDs em vez de nomes: funcionam no Windows em português (SISTEMA, Administradores).
$TrustedSids = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$UsersSid = 'S-1-5-32-545'
# Direitos que deixam renomear ou apagar uma pasta, ou mudar as permissões e o dono dela.
$RenameRights = 0x10000 -bor 0x40 -bor 0x40000 -bor 0x80000 -bor 0x10000000
# Mais os que deixam criar ou alterar arquivos (uma DLL ao lado do node.exe, por exemplo).
$WriteRights = $RenameRights -bor 0x2 -bor 0x4 -bor 0x40000000

# SID da conta virtual NT SERVICE\<nome>: S-1-5-80 e o SHA-1 do nome em maiúsculas (vale antes de o serviço existir).
function Get-ServiceSid([string]$Name) {
  $hash = [Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::Unicode.GetBytes($Name.ToUpperInvariant()))
  'S-1-5-80-' + ((0..4 | ForEach-Object { [BitConverter]::ToUInt32($hash, $_ * 4) }) -join '-')
}
$ServiceSid = Get-ServiceSid $ServiceName

function Get-AccountName([string]$Sid) {
  try { return (New-Object Security.Principal.SecurityIdentifier $Sid).Translate([Security.Principal.NTAccount]).Value } catch { return $Sid }
}

function Get-Ancestors([string]$Path) {
  $list = @()
  $p = [IO.Path]::GetDirectoryName($Path.TrimEnd('\', '/'))
  while ($p) { $list += $p; $p = [IO.Path]::GetDirectoryName($p) }
  return $list
}

function Get-NormalPath([string]$Path) { [IO.Path]::GetFullPath($Path).TrimEnd('\', '/') }
function Test-SamePath([string]$A, [string]$B) { (Get-NormalPath $A) -ieq (Get-NormalPath $B) }
function Test-Within([string]$Path, [string]$Root) {
  $p = Get-NormalPath $Path
  $r = Get-NormalPath $Root
  ($p -ieq $r) -or $p.StartsWith($r + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}
function Test-ReparsePoint([string]$Path) { ([int](Get-Item -LiteralPath $Path -Force).Attributes -band 0x400) -ne 0 }

# Quem, fora de SYSTEM, Administradores e TrustedInstaller, tem em $Path algum dos direitos de $Mask. O dono conta
# sempre: ele pode mudar as permissões quando quiser.
function Get-UnsafeAccess([string]$Path, [int]$Mask) {
  $acl = Get-Acl -LiteralPath $Path
  $who = @()
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($TrustedSids -notcontains $owner) { $who += "$(Get-AccountName $owner) (dono)" }
  foreach ($r in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ("$($r.AccessControlType)" -ne 'Allow') { continue }
    if (([int]$r.PropagationFlags -band 2) -ne 0) { continue } # InheritOnly: só vale para o que for criado dentro
    $sid = $r.IdentityReference.Value
    if ($TrustedSids -contains $sid -or $sid -eq 'S-1-3-0') { continue }
    if (([int]$r.FileSystemRights -band $Mask) -ne 0) { $who += Get-AccountName $sid }
  }
  return @($who | Select-Object -Unique)
}

# Já trancada: sem herança, dona SYSTEM ou Administradores, e só eles e o serviço nas permissões.
function Test-Locked([string]$Path) {
  try {
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected) { return $false }
    if ($TrustedSids -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { return $false }
    foreach ($r in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($TrustedSids -notcontains $r.IdentityReference.Value -and $r.IdentityReference.Value -ne $ServiceSid) { return $false }
    }
    return $true
  } catch {
    return $false
  }
}

function Get-ExplicitSids([string]$Path) {
  try {
    return @((Get-Acl -LiteralPath $Path).GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value } | Select-Object -Unique)
  } catch {
    return @()
  }
}

# Tira de $Path as permissões explícitas de quem não está em $Keep.
function Remove-OtherAccess([string]$Path, [string[]]$Keep) {
  foreach ($sid in @(Get-ExplicitSids $Path)) {
    if ($Keep -notcontains $sid) { Invoke-Native 'icacls' @($Path, '/remove', "*$sid", '/Q') "Não consegui ajustar as permissões de $Path." | Out-Null }
  }
}

# O que já existia numa pasta que o instalador vai trancar, sem seguir links. Um link ou junção levaria o que o
# serviço grava (logs, segredos, arquivos enviados) para outro lugar. Com -Mine, tudo precisa ter sido criado pelos
# Administradores, por quem roda o instalador ou pelo próprio serviço: quem criou um arquivo pode mantê-lo aberto e
# continuar lendo ou alterando depois que as permissões mudam, então o instalador não toma posse e para. As pastas
# de -Skip (o chat, com as junções do npm) ficam de fora.
function Assert-OwnFolder([string]$Path, [string]$What, [switch]$Mine, [string[]]$Skip) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $owners = $TrustedSids + @($CurrentSid, $ServiceSid)
  $aside = "Confira com a TI quem criou isso, tire a pasta do caminho (Rename-Item -LiteralPath ""$Path"" -NewName ""$(Split-Path -Leaf $Path).antiga"") e rode o instalador de novo."
  $pending = New-Object System.Collections.Queue
  $pending.Enqueue((Get-Item -LiteralPath $Path -Force))
  while ($pending.Count) {
    $item = $pending.Dequeue()
    $full = $item.FullName
    if (@($Skip | Where-Object { $_ -and (Test-SamePath $full $_) }).Count) { continue }
    if (([int]$item.Attributes -band 0x400) -ne 0) {
      Fail "Há um atalho (link ou junção) para outro lugar em $full, dentro da $What ($Path): o que fosse gravado ali iria parar nesse outro lugar. $aside"
    }
    if ($Mine) {
      $owner = $null
      try { $owner = (Get-Acl -LiteralPath $full).GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { $owner = $null }
      if (-not $owner) { Fail "Não consegui ler o dono de $full, dentro da $What ($Path). $aside" }
      if ($owners -notcontains $owner) {
        $by = "pela conta $(Get-AccountName $owner), não pelos Administradores nem por você"
        $who = if (Test-SamePath $full $Path) { "A $What ($Path) foi criada $by" } else { "A $What ($Path) já existia, e $full foi criado $by" }
        Fail "$who. Quem cria um arquivo pode mantê-lo aberto e continuar lendo ou alterando o que estiver nele depois que as permissões mudam. $aside"
      }
    }
    if ($item.PSIsContainer) {
      $children = @()
      try { $children = @(Get-ChildItem -LiteralPath $full -Force -ErrorAction Stop) } catch { Fail "Não consegui ler o conteúdo de $full, dentro da $What ($Path). $aside" }
      foreach ($c in $children) { $pending.Enqueue($c) }
    }
  }
}

# Pasta só de SYSTEM e Administradores, donos de tudo dentro dela. Da primeira vez percorre a pasta inteira (dono e
# permissões de cada arquivo); com ela já trancada, ninguém mais pôde mexer dentro, e só o topo é conferido (com
# -Again, percorre de novo). -Mine e -NoLinks: veja Assert-OwnFolder.
function Protect-Folder([string]$Path, [string]$What, [switch]$Mine, [switch]$NoLinks, [switch]$Again, [string[]]$Skip) {
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  if (-not $Again -and (Test-Locked $Path)) { return }
  if ($Mine) { Assert-OwnFolder $Path $What -Mine -Skip $Skip }
  $msg = "Não consegui ajustar as permissões de $Path."
  Invoke-Native 'icacls' @($Path, '/setowner', '*S-1-5-32-544', '/Q') $msg | Out-Null
  Invoke-Native 'icacls' @($Path, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/Q') $msg | Out-Null
  Remove-OtherAccess $Path $TrustedSids
  # Com o topo trancado, ninguém mais cria nada ali: confere de novo o que pode ter entrado desde a primeira
  # conferência, antes de passar a posse do que está dentro para os Administradores.
  if ($Mine -or $NoLinks) { Assert-OwnFolder $Path $What -Mine:$Mine -Skip $Skip }
  if (@(Get-ChildItem -LiteralPath $Path -Force | Select-Object -First 1).Count) {
    $inside = Join-Path $Path '*'
    Invoke-Native 'icacls' @($inside, '/setowner', '*S-1-5-32-544', '/T', '/C', '/L', '/Q') $msg | Out-Null
    Invoke-Native 'icacls' @($inside, '/reset', '/T', '/C', '/L', '/Q') $msg | Out-Null
  }
}

# C:\Wescc: só os Administradores criam, renomeiam ou apagam pastas nela; os outros usuários só leem.
function Protect-Root([string]$Path) {
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  $msg = "Não consegui ajustar as permissões de $Path."
  Invoke-Native 'icacls' @($Path, '/setowner', '*S-1-5-32-544', '/Q') $msg | Out-Null
  Invoke-Native 'icacls' @($Path, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', "*${UsersSid}:(OI)(CI)RX", '/Q') $msg | Out-Null
  Remove-OtherAccess $Path ($TrustedSids + $UsersSid)
}

# Dono Administradores e só as permissões herdadas da pasta (um arquivo que já existia pode trazer outras).
function Reset-FileAcl([string]$Path) {
  Invoke-Native 'icacls' @($Path, '/setowner', '*S-1-5-32-544', '/Q') "Não consegui ajustar as permissões de $Path." | Out-Null
  Invoke-Native 'icacls' @($Path, '/reset', '/Q') "Não consegui ajustar as permissões de $Path." | Out-Null
}

# Um arquivo novo no lugar, nunca o mesmo objeto: quem abriu o antigo antes (ou pôs um link com esse nome) não
# alcança o conteúdo novo.
function Remove-OldFile([string]$Path) {
  if ([IO.File]::Exists($Path)) { [IO.File]::Delete($Path) }
}

# Grava um segredo sem BOM (o chat apara só o fim) num arquivo novo, com as permissões da pasta dos segredos, e só
# então tira o antigo do lugar.
function Write-SecretFile([string]$Path, [string]$Value) {
  $new = "$Path.novo"
  Remove-OldFile $new
  [IO.File]::WriteAllText($new, $Value, $Utf8)
  Reset-FileAcl $new
  Remove-OldFile $Path
  [IO.File]::Move($new, $Path)
}

# O mesmo para o certificado copiado (a origem pode ser o próprio destino).
function Copy-SecretFile([string]$Source, [string]$Path) {
  $new = "$Path.novo"
  Remove-OldFile $new
  Copy-Item -LiteralPath $Source -Destination $new
  Reset-FileAcl $new
  Remove-OldFile $Path
  [IO.File]::Move($new, $Path)
}

# O que o serviço roda e serve. Com a pasta do chat já trancada, o passo 5 só confere o topo dela, mas uma versão nova
# movida para lá (Move-Item, ou arrastada no Explorer no mesmo disco) ou copiada com robocopy /SEC chega com as
# permissões da pasta de onde veio. Ela entra por uma destas pastas: o chat, server, server\dist, web, web\dist, shared
# e os node_modules (com os pacotes @escopo\*).
function Get-AppItems([string]$Root) {
  $list = New-Object System.Collections.Generic.List[object]
  foreach ($rel in @('', 'server', 'server\dist', 'web', 'web\dist', 'shared', 'node_modules', 'server\node_modules')) {
    $d = if ($rel) { Join-Path $Root $rel } else { $Root }
    if (-not (Test-Path -LiteralPath $d -PathType Container)) { continue }
    foreach ($c in @(Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue)) {
      $list.Add($c)
      if ($rel -like '*node_modules' -and $c.PSIsContainer -and $c.Name.StartsWith('@')) {
        foreach ($p in @(Get-ChildItem -LiteralPath $c.FullName -Force -ErrorAction SilentlyContinue)) { $list.Add($p) }
      }
    }
  }
  return $list
}

# Para cada pasta do serviço: nenhuma pasta acima dela pode ser renomeada por outro usuário (que poria outra no
# lugar). As que ficam dentro de pastas que o instalador tranca, e o próprio C:\Wescc, ele mesmo ajusta.
function Assert-SafeLocation([string]$Path, [string]$What, [string[]]$Locked) {
  if ($Path.StartsWith('\\')) { Fail "$What precisa estar num disco deste computador, não numa pasta de rede ($Path)." }
  if ((Test-Path -LiteralPath $Path) -and (Test-ReparsePoint $Path)) {
    Fail "$What ($Path) é um atalho (link ou junção) para outra pasta. Indique a pasta de verdade."
  }
  foreach ($a in (Get-Ancestors $Path)) {
    if (-not (Test-Path -LiteralPath $a)) { continue }
    if (@($Locked | Where-Object { Test-Within $a $_ }).Count -or (Test-SamePath $a $WesccRoot)) { continue }
    if (Test-ReparsePoint $a) { Fail "A pasta $a, acima de $Path, é um atalho (link ou junção) para outra pasta. Use uma pasta de verdade, como $WesccRoot." }
    $who = @(Get-UnsafeAccess $a $RenameRights)
    if ($who.Count) {
      Fail ("A pasta {0}, acima de {1}, pode ser renomeada ou ter as permissões trocadas por {2}: outra pessoa poderia pôr no lugar o que o serviço roda. Use uma pasta dentro de {3} (o padrão) ou peça à TI para proteger {0}." -f $a, $Path, ($who -join ', '), $WesccRoot)
    }
  }
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

function Show-LogTail {
  $err = Join-Path $LogDir "$ServiceName.err.log"
  if (Test-Path -LiteralPath $err) {
    Write-Host ''
    Write-Host "    Últimas linhas de ${err}:"
    Get-Content -LiteralPath $err -Tail 15 -Encoding UTF8 | ForEach-Object { Write-Host "      $_" }
  }
}

Write-Host 'Wescc Chat: serviço do Windows' -ForegroundColor White
if ($Simulate) { Write-Host 'Simulação (-WhatIf): nada será alterado.' -ForegroundColor Cyan }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal $identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
# Quem roda o instalador: o Windows pode deixá-lo como dono do que ele cria, mesmo como Administrador.
$CurrentSid = $identity.User.Value
if (-not $isAdmin) {
  if ($Simulate) {
    Warn 'Sem privilégio de Administrador: a simulação segue, mas a instalação de verdade precisa dele.'
  } else {
    Fail 'Abra o PowerShell como Administrador (botão direito > Executar como administrador) e rode de novo.'
  }
}
if ($RemoveSecrets -and -not $Uninstall) { Fail '-RemoveSecrets só vale junto com -Uninstall.' }

# ---------- Remoção (-Uninstall) ----------

if ($Uninstall) {
  $InstallDir = [IO.Path]::GetFullPath($InstallDir)
  $InstallJson = Join-Path $InstallDir 'install.json'
  $ServiceExe = Join-Path $InstallDir "$ServiceName.exe"
  $S = @{}
  if (Test-Path -LiteralPath $InstallJson) {
    try {
      foreach ($p in ([IO.File]::ReadAllText($InstallJson, $Utf8) | ConvertFrom-Json).PSObject.Properties) { $S[$p.Name] = $p.Value }
    } catch {
      Warn ("Não consegui ler {0}: {1}. Sigo sem as escolhas salvas." -f $InstallJson, $_.Exception.Message)
    }
  }
  Write-Host ''
  Write-Host 'Remover o serviço' -ForegroundColor White

  $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($service) {
    if ($service.Status -ne 'Stopped') { Invoke-Step 'Parar o serviço wescc-chat' { Stop-Service -Name $ServiceName -Force } }
    if (Test-Path -LiteralPath $ServiceExe) {
      Invoke-Step 'Remover o serviço wescc-chat (WinSW uninstall)' { Invoke-Native $ServiceExe @('uninstall') 'O WinSW não conseguiu remover o serviço.' | Out-Null }
    } else {
      Invoke-Step 'Remover o serviço wescc-chat (sc.exe delete)' { Invoke-Native 'sc.exe' @('delete', $ServiceName) 'Não consegui remover o serviço wescc-chat.' | Out-Null }
    }
  } else {
    Ok 'O serviço wescc-chat não está instalado.'
  }

  $rules = @(Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue)
  if ($rules.Count) {
    Invoke-Step "Apagar as regras do firewall do grupo ""$FirewallGroup"" ($($rules.Count))" { $rules | Remove-NetFirewallRule }
  } else {
    Ok "Nenhuma regra do firewall no grupo ""$FirewallGroup""."
  }

  # Só as reservas que este script fez; outras portas reservadas por um administrador ficam como estão.
  $reserved = @(Split-List $S['ReservedPorts'] | ForEach-Object { [int]$_ })
  $left = @()
  foreach ($p in $reserved) {
    Invoke-Step "Desfazer a reserva da porta TCP $p (netsh int ipv4 delete excludedportrange)" {
      $null = Invoke-Native 'netsh' @('int', 'ipv4', 'delete', 'excludedportrange', 'protocol=tcp', "startport=$p", 'numberofports=1', 'store=persistent') ''
      if ($LASTEXITCODE -ne 0) { Warn "Não consegui desfazer a reserva da porta $p (talvez já tenha sido desfeita)." }
    }
  }
  if (-not $reserved.Count) { Ok 'Nenhuma reserva de porta feita por este script.' }
  $ours = @(@($S['Port']) + @(Split-List $S['RedirectPorts']) + @($InternalPort) | Where-Object { $_ } | ForEach-Object { [int]$_ } | Where-Object { $reserved -notcontains $_ })
  foreach ($line in (Invoke-Native 'netsh' @('int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp') '')) {
    if ($line -match '^\s*(\d+)\s+(\d+)\s*\*\s*$' -and $Matches[1] -eq $Matches[2] -and $ours -contains [int]$Matches[1]) { $left += [int]$Matches[1] }
  }
  foreach ($p in $left) {
    Info "A porta TCP $p continua reservada por um administrador. Se a reserva era do chat: netsh int ipv4 delete excludedportrange protocol=tcp startport=$p numberofports=1 store=persistent"
  }

  if (Test-Path -LiteralPath $SecretsDir) {
    Invoke-Step "Tirar o acesso de $ServiceAccount a $SecretsDir" {
      Invoke-Native 'icacls' @($SecretsDir, '/remove', "*$ServiceSid", '/T', '/C', '/Q') "Não consegui ajustar as permissões de $SecretsDir." | Out-Null
    }
    $chatSecrets = @('chat.pfx', 'chat.crt', 'chat.key', 'tls-pfx-passphrase.txt', 'database-url.txt') | ForEach-Object { Join-Path $SecretsDir $_ } | Where-Object { Test-Path -LiteralPath $_ }
    if ($RemoveSecrets) {
      foreach ($f in $chatSecrets) { Invoke-Step "Apagar $f" { Remove-Item -LiteralPath $f -Force } }
      if (-not $chatSecrets.Count) { Ok "Nenhum segredo do chat em $SecretsDir." }
    } elseif ($chatSecrets.Count) {
      Info "Os segredos do chat continuam em $SecretsDir ($((@($chatSecrets) | ForEach-Object { Split-Path -Leaf $_ }) -join ', ')). Para apagá-los, rode de novo com -Uninstall -RemoveSecrets."
    }
  }

  if (Test-Path -LiteralPath $InstallJson) {
    Invoke-Step "Anotar a remoção em $InstallJson" {
      $S.Remove('ReservedPorts')
      $S['UninstalledAt'] = (Get-Date).ToString('s')
      [IO.File]::WriteAllText($InstallJson, ((New-Object PSObject -Property $S) | ConvertTo-Json), $Utf8)
    }
  }
  Write-Host ''
  Info "Ficaram em $InstallDir os logs, os arquivos enviados e install.json (para instalar de novo com as mesmas escolhas). Apague a pasta quando não precisar mais dos arquivos enviados."
  if ($S['AppDir']) { Info "As permissões de $($S['AppDir']) continuam só para SYSTEM e Administradores." }
  if ($Simulate) {
    Write-Host 'Simulação concluída: nada foi alterado.' -ForegroundColor Cyan
  } else {
    Write-Host 'Pronto: o serviço wescc-chat foi removido.' -ForegroundColor Green
  }
  exit 0
}

# ---------- 1. Ambiente ----------

Section 'Ambiente'

$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$InstallJson = Join-Path $InstallDir 'install.json'
$LogDir = Join-Path $InstallDir 'logs'
$S = @{}
if (Test-Path -LiteralPath $InstallJson) {
  try {
    $saved = [IO.File]::ReadAllText($InstallJson, $Utf8) | ConvertFrom-Json
  } catch {
    Fail ("Não consegui ler {0}: {1}" -f $InstallJson, $_.Exception.Message)
  }
  foreach ($p in $saved.PSObject.Properties) { $S[$p.Name] = $p.Value }
  Info "Usando as escolhas salvas em $InstallJson (o que veio na linha de comando tem precedência)."
} elseif ($Reconfigure) {
  Fail "Não achei $InstallJson. Faça a instalação completa primeiro (sem -Reconfigure)."
}
$given = $PSBoundParameters
if (-not $given.ContainsKey('AppDir') -and $S['AppDir']) { $AppDir = [string]$S['AppDir'] }
if (-not $given.ContainsKey('SiteUrl') -and $S['SiteUrl']) { $SiteUrl = [string]$S['SiteUrl'] }
if (-not $given.ContainsKey('NodeExe') -and $S['NodeExe']) { $NodeExe = [string]$S['NodeExe'] }
if (-not $given.ContainsKey('UploadDir') -and $S['UploadDir']) { $UploadDir = [string]$S['UploadDir'] }
if (-not $given.ContainsKey('LanCidr') -and $S['LanCidr']) { $LanCidr = @($S['LanCidr']) }

# Certificado: PFX (recomendado) ou PEM; sem nenhum, HTTP como hoje.
$certGiven = [bool]($PfxFile -or $CertFile -or $KeyFile)
if ($PfxFile -and ($CertFile -or $KeyFile)) { Fail 'Use -PfxFile ou -CertFile com -KeyFile, não os dois.' }
if (($CertFile -and -not $KeyFile) -or ($KeyFile -and -not $CertFile)) { Fail 'Informe -CertFile e -KeyFile juntos (ou use -PfxFile).' }
$savedMode = [string]$S['TlsMode']
if ($certGiven) {
  if ($PfxFile) { $Mode = 'pfx' } else { $Mode = 'pem' }
} elseif ($savedMode) {
  $Mode = $savedMode
} else {
  $Mode = 'none'
}
$modeChanged = $savedMode -and ($savedMode -ne $Mode)
$https = $Mode -ne 'none'

if (-not $given.ContainsKey('Port')) {
  if ($S['Port'] -and -not $modeChanged) {
    $Port = [int]$S['Port']
  } elseif ($https) {
    $Port = 443
  } else {
    $Port = 3000
  }
}
if ($given.ContainsKey('RedirectPorts')) {
  $redirect = @(Split-List $RedirectPorts)
} elseif ($S.ContainsKey('RedirectPorts') -and -not $modeChanged) {
  $redirect = @(Split-List $S['RedirectPorts'])
} elseif (-not $https) {
  $redirect = @()
} elseif ($savedMode -eq 'none' -and $S['Port']) {
  # Ao ligar o HTTPS, os links antigos (http://pc:3000) continuam valendo.
  $redirect = @('80', [string]$S['Port'])
} else {
  $redirect = @('80')
}

$redirectList = @()
foreach ($r in $redirect) {
  if ($r -notmatch '^\d{1,5}$' -or [int]$r -lt 1 -or [int]$r -gt 65535) { Fail "Porta de redirecionamento inválida: $r" }
  if ([int]$r -eq $Port -or ($https -and [int]$r -eq $InternalPort)) { Fail "A porta $r não pode redirecionar: ela é do próprio chat." }
  if ($redirectList -notcontains [int]$r) { $redirectList += [int]$r }
}
if ($redirectList.Count -and -not $https) { Fail '-RedirectPorts só vale com HTTPS (-PfxFile, ou -CertFile e -KeyFile).' }
if ($Port -lt 1 -or $Port -gt 65535) { Fail "Porta inválida: $Port" }
if ($https -and $Port -eq $InternalPort) { Fail "A porta $Port é a dos webhooks do servidor de chamadas (só em 127.0.0.1); escolha outra com -Port." }

$LanCidr = @(Split-List $LanCidr)
if (-not $LanCidr.Count) { Fail 'Informe -LanCidr com a rede local e as redes das filiais que acessam o chat (por exemplo -LanCidr 10.10.0.0/16,10.20.0.0/16).' }
foreach ($c in $LanCidr) { if (-not (Test-Cidr $c)) { Fail "Faixa de rede inválida: $c (use o formato 10.10.0.0/16)." } }

if (-not $SiteUrl) {
  if ($https) { Fail 'Informe -SiteUrl com o endereço do chat, o mesmo nome do certificado (por exemplo https://chat.empresa.local).' }
  Fail 'Informe -SiteUrl com o endereço do chat (por exemplo http://servidor-chat:3000).'
}
$uri = $null
if (-not [Uri]::TryCreate($SiteUrl, [UriKind]::Absolute, [ref]$uri) -or ($uri.AbsolutePath -ne '/') -or $uri.Query -or $uri.UserInfo) {
  Fail "Endereço inválido em -SiteUrl: $SiteUrl (use só o esquema, o nome e a porta, por exemplo https://chat.empresa.local)."
}
if ($https -and $uri.Scheme -ne 'https') {
  if ($modeChanged -and -not $given.ContainsKey('SiteUrl')) { Fail "Ao ligar o HTTPS, informe o endereço novo com -SiteUrl (hoje: $SiteUrl), por exemplo https://chat.empresa.local." }
  Fail "Com certificado, -SiteUrl precisa começar com https:// (veio $SiteUrl)."
}
if (-not $https -and $uri.Scheme -ne 'http') { Fail "Sem certificado o chat fica em HTTP: -SiteUrl precisa começar com http:// (veio $SiteUrl). Para HTTPS, informe -PfxFile." }
if ($uri.Port -ne $Port) { Fail ("O endereço {0} usa a porta {1}, mas o chat vai escutar na {2}. Ajuste -SiteUrl ou -Port." -f $SiteUrl, $uri.Port, $Port) }
$SiteUrl = $uri.GetLeftPart([UriPartial]::Authority)
Ok "Endereço: $SiteUrl"

# Node.js 22, fora das pastas de usuário (a conta do serviço não entra nelas).
if (-not $NodeExe) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { $NodeExe = $cmd.Source }
}
if (-not $NodeExe -or -not (Test-Path -LiteralPath $NodeExe)) {
  Fail 'Não achei o node.exe. Instale o Node.js 22 LTS para todos os usuários (https://nodejs.org) ou indique o caminho com -NodeExe.'
}
$NodeExe = (Resolve-Path -LiteralPath $NodeExe).ProviderPath
$nodeDir = Get-Item -LiteralPath (Split-Path -Parent $NodeExe) -Force
$nodeTarget = $null
if ($nodeDir.LinkType) { $nodeTarget = [string](@($nodeDir.Target)[0]) }
if ((Test-InUserProfile $NodeExe) -or ($nodeTarget -and (Test-InUserProfile $nodeTarget))) {
  Fail "O node.exe está numa pasta de usuário ($NodeExe$(if ($nodeTarget) { " -> $nodeTarget" })) e o serviço não tem acesso a ela. Instale o Node.js 22 para todos os usuários (C:\Program Files\nodejs) ou indique outro com -NodeExe."
}
$nodeVersion = [string](@(Invoke-Native $NodeExe @('--version') 'Não consegui rodar o node.exe.')[0])
if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { Fail "O chat precisa do Node.js 22 ou mais novo; este é o $nodeVersion ($NodeExe)." }
Ok "Node.js $nodeVersion ($NodeExe)"

# O chat compilado.
if (-not $AppDir) { Fail 'Informe -AppDir: a pasta do chat compilado (com server\dist, web\dist e node_modules).' }
if (-not (Test-Path -LiteralPath $AppDir)) { Fail "A pasta $AppDir não existe." }
$AppDir = (Resolve-Path -LiteralPath $AppDir).ProviderPath
$Entry = Join-Path $AppDir 'server\dist\index.js'
$WebDist = Join-Path $AppDir 'web\dist'
if (-not (Test-Path -LiteralPath $Entry)) { Fail "Não achei $Entry. Rode npm ci e npm run build na pasta do chat e indique a pasta com -AppDir." }
if (-not (Test-Path -LiteralPath (Join-Path $WebDist 'index.html'))) { Fail "Não achei $WebDist\index.html. Rode npm run build na pasta do chat." }
if (-not ((Test-Path -LiteralPath (Join-Path $AppDir 'node_modules\fastify\package.json')) -or (Test-Path -LiteralPath (Join-Path $AppDir 'server\node_modules\fastify\package.json')))) {
  Fail "Faltam as dependências do servidor em $AppDir\node_modules. Rode npm ci na pasta do chat."
}
Ok "Chat compilado em $AppDir"
if (Test-InUserProfile $AppDir) {
  Fail "O chat está numa pasta de usuário ($AppDir): os programas dessa pessoa poderiam trocar o que o serviço roda. Copie o chat para uma pasta fixa, como C:\Wescc\app, e indique com -AppDir."
}

if (-not $UploadDir) {
  $legacyUploads = Join-Path $AppDir 'server\uploads'
  $defaultUploads = Join-Path $InstallDir 'uploads'
  if ((Test-Path -LiteralPath $legacyUploads) -and @(Get-ChildItem -LiteralPath $legacyUploads -Force | Select-Object -First 1).Count -and -not (Test-Path -LiteralPath $defaultUploads)) {
    $UploadDir = $legacyUploads
    Info "Os arquivos enviados continuam em $UploadDir, onde já estão (para mudar, use -UploadDir)."
  } else {
    $UploadDir = $defaultUploads
  }
}
$UploadDir = [IO.Path]::GetFullPath($UploadDir)

# Ninguém além dos Administradores pode trocar o que o serviço roda (passo 5), nem renomear as pastas acima.
$LockedDirs = @($InstallDir, $AppDir, $UploadDir, $SecretsDir)
Assert-SafeLocation $InstallDir 'A pasta do serviço (-InstallDir)' $LockedDirs
Assert-SafeLocation $AppDir 'A pasta do chat (-AppDir)' $LockedDirs
Assert-SafeLocation $UploadDir 'A pasta dos arquivos enviados (-UploadDir)' $LockedDirs
Assert-SafeLocation $SecretsDir 'A pasta dos segredos' $LockedDirs
# O que já existia nelas: confere já, antes de qualquer mudança; os passos 4 e 5 conferem de novo depois de trancar.
$appWasLocked = Test-Locked $AppDir
if (-not (Test-Locked $InstallDir)) { Assert-OwnFolder $InstallDir 'pasta do serviço' -Mine -Skip $AppDir }
if (Test-Locked $SecretsDir) { Assert-OwnFolder $SecretsDir 'pasta dos segredos' } else { Assert-OwnFolder $SecretsDir 'pasta dos segredos' -Mine }
$uploadsRoot = $UploadDir
foreach ($r in @($InstallDir, $AppDir)) { if ((Test-Within $UploadDir $r) -and $uploadsRoot -eq $UploadDir) { $uploadsRoot = $r } }
$uploadsFresh = -not (Test-Locked $uploadsRoot)
if ($uploadsFresh) { Assert-OwnFolder $UploadDir 'pasta dos arquivos enviados' }
Assert-SafeLocation $LogDir 'A pasta dos logs' $LockedDirs
$fixRoot = -not (Test-Path -LiteralPath $WesccRoot)
if (-not $fixRoot) {
  if (Test-ReparsePoint $WesccRoot) { Fail "$WesccRoot é um atalho (link ou junção) para outra pasta. Use uma pasta de verdade." }
  $rootWho = @(Get-UnsafeAccess $WesccRoot $RenameRights)
  if ($rootWho.Count) {
    $fixRoot = $true
    Info "Hoje outros usuários ($($rootWho -join ', ')) podem renomear pastas em $WesccRoot; o passo 4 deixa isso só para os Administradores."
  }
}
$appRelock = $false
if ($appWasLocked) {
  $loose = @()
  foreach ($item in (Get-AppItems $AppDir)) {
    try { $who = @(Get-UnsafeAccess $item.FullName $WriteRights) } catch { $who = @('?') }
    if ($who.Count) { $loose += "$($item.FullName) ($($who -join ', '))" }
  }
  if ($loose.Count) {
    $appRelock = $true
    $more = ''
    if ($loose.Count -gt 1) { $more = " e mais $($loose.Count - 1)" }
    Warn ("Há arquivos em {0} que outras contas podem alterar: {1}{2}. Uma versão nova movida para lá (Move-Item, ou arrastada no Explorer no mesmo disco) ou copiada com robocopy /SEC mantém as permissões da pasta de onde veio. O passo 5 refaz as permissões da pasta inteira. Se essa versão passou por uma pasta em que outros usuários escreviam, compile de novo dentro de {0}, num PowerShell como Administrador." -f $AppDir, $loose[0], $more)
  }
}
if (-not $appRelock) { Ok 'Pastas do serviço conferidas (ninguém além dos Administradores troca o que o serviço roda).' }

# O node.exe e a pasta dele: quem cria arquivos ali (uma DLL, por exemplo) roda código como o serviço.
$nodeWho = @(Get-UnsafeAccess $NodeExe $WriteRights) + @(Get-UnsafeAccess (Split-Path -Parent $NodeExe) $WriteRights)
foreach ($a in (Get-Ancestors (Split-Path -Parent $NodeExe))) { $nodeWho += @(Get-UnsafeAccess $a $RenameRights) }
$nodeWho = @($nodeWho | Select-Object -Unique)
if ($nodeWho.Count) {
  Fail "O node.exe ($NodeExe) pode ser trocado, ou ganhar arquivos ao lado, por $($nodeWho -join ', '): o serviço rodaria o programa dessa pessoa. Instale o Node.js 22 para todos os usuários (C:\Program Files\nodejs) ou indique outro com -NodeExe."
}

# WinSW fixado em scripts\livekit\versions.json, conferido pelo SHA-256 antes de qualquer mudança.
if (-not (Test-Path -LiteralPath $VersionsFile)) { Fail "Não achei $VersionsFile (versões e hashes fixados). Copie a pasta scripts inteira do repositório." }
$winswPin = ([IO.File]::ReadAllText($VersionsFile, $Utf8) | ConvertFrom-Json).winsw
if (-not $winswPin -or -not $winswPin.version -or -not $winswPin.sha256) { Fail "$VersionsFile não traz a versão e o SHA-256 do WinSW." }
$winswFile = 'WinSW-x64.exe'
if ($winswPin.file) { $winswFile = [string]$winswPin.file }
$winswHash = ([string]$winswPin.sha256).ToLowerInvariant()
$winswTag = [string]$winswPin.version
if (-not $winswTag.StartsWith('v')) { $winswTag = "v$winswTag" }
$ServiceExe = Join-Path $InstallDir "$ServiceName.exe"
$ServiceXml = Join-Path $InstallDir "$ServiceName.xml"
$winswSource = $null
if ((Test-Path -LiteralPath $ServiceExe) -and (Get-Sha256 $ServiceExe) -eq $winswHash) {
  Ok "WinSW $winswTag já instalado e conferido."
} else {
  if ($Offline) {
    $offlineFile = Join-Path $Offline $winswFile
    if (-not (Test-Path -LiteralPath $offlineFile)) { Fail "Não achei $winswFile em $Offline." }
    # Copiado para a pasta temporária do administrador e conferido lá: quem escreve na pasta de origem (um
    # compartilhamento, um pendrive) não troca o arquivo entre a conferência e a instalação.
    $winswSource = $offlineFile
    if (-not $Simulate) {
      $winswSource = Join-Path $env:TEMP "wescc-$winswFile"
      Remove-OldFile $winswSource
      Copy-Item -LiteralPath $offlineFile -Destination $winswSource -Force
    }
  } else {
    $url = "https://github.com/winsw/winsw/releases/download/$winswTag/$winswFile"
    $winswSource = Join-Path $env:TEMP "wescc-$winswFile"
    if ($Simulate) {
      Info "[simulação] Baixaria $url e conferiria o SHA-256."
      $winswSource = $null
    } else {
      Info "Baixando $url"
      $request = @{ Uri = $url; OutFile = $winswSource; UseBasicParsing = $true }
      if ($Proxy) { $request.Proxy = $Proxy; $request.ProxyUseDefaultCredentials = $true }
      try {
        Invoke-WebRequest @request
      } catch {
        Fail ("Não consegui baixar o WinSW de {0} ({1}). Use -Proxy <url>, ou baixe o arquivo em outro computador e rode com -Offline <pasta>." -f $url, $_.Exception.Message)
      }
    }
  }
  if ($winswSource) {
    if ((Get-Sha256 $winswSource) -ne $winswHash) { Fail 'O arquivo baixado não confere com o hash esperado. Nada foi instalado.' }
    Ok "WinSW $winswTag conferido (SHA-256)."
  }
}

if (-not $https) {
  Warn "Sem certificado: o chat fica em HTTP na porta $Port. Câmera e microfone (chamadas) só funcionam com HTTPS. Quando a TI entregar o certificado, rode de novo com -PfxFile e -SiteUrl https://..."
}

# ---------- 2. Portas ----------

Section 'Portas'

$tcpPorts = @($Port) + $redirectList
if ($https) { $tcpPorts += $InternalPort }
# O próprio serviço, se já estiver rodando, não conta como "porta ocupada".
$ourPids = @(Get-ServicePids)

$reservedNow = @()
$excluded = @()
foreach ($line in (Invoke-Native 'netsh' @('int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp') 'Não consegui ler as portas reservadas (netsh int ipv4 show excludedportrange).')) {
  if ($line -match '^\s*(\d+)\s+(\d+)\s*(\*)?\s*$') {
    $excluded += New-Object PSObject -Property @{ Start = [int]$Matches[1]; End = [int]$Matches[2]; Administered = [bool]$Matches[3] }
  }
}
$dynamic = $null
$dynNumbers = @()
foreach ($line in (Invoke-Native 'netsh' @('int', 'ipv4', 'show', 'dynamicport', 'tcp') '')) {
  if ($line -match ':\s*(\d+)\s*$') { $dynNumbers += [int]$Matches[1] }
}
if ($dynNumbers.Count -ge 2) { $dynamic = New-Object PSObject -Property @{ Start = $dynNumbers[0]; End = $dynNumbers[0] + $dynNumbers[1] - 1 } }

$serviceState = @(Invoke-Native 'netsh' @('http', 'show', 'servicestate') '')
$urlAcl = @(Invoke-Native 'netsh' @('http', 'show', 'urlacl') '')

foreach ($p in $tcpPorts) {
  $range = $excluded | Where-Object { $p -ge $_.Start -and $p -le $_.End } | Select-Object -First 1
  $inDynamic = $dynamic -and $p -ge $dynamic.Start -and $p -le $dynamic.End
  if ($range -and -not $range.Administered) {
    Info ("A porta {0} está numa faixa reservada pelo Windows ({1}-{2}, em geral pelo Hyper-V ou pelo WSL do Docker Desktop)." -f $p, $range.Start, $range.End)
  } elseif (-not $range -and $inDynamic) {
    Info ("A porta {0} está na faixa de portas dinâmicas ({1}-{2}): o Windows pode entregá-la a outro programa." -f $p, $dynamic.Start, $dynamic.End)
  }
  if (($range -and -not $range.Administered) -or (-not $range -and $inDynamic)) {
    Invoke-Step "Parar o winnat, reservar a porta TCP $p para o chat (store=persistent) e iniciar o winnat de novo (o Docker Desktop pode perder a rede por alguns segundos)" {
      Stop-Service -Name winnat -Force -ErrorAction SilentlyContinue
      $null = Invoke-Native 'netsh' @('int', 'ipv4', 'add', 'excludedportrange', 'protocol=tcp', "startport=$p", 'numberofports=1', 'store=persistent') ''
      $reserved = $LASTEXITCODE -eq 0
      Start-Service -Name winnat -ErrorAction SilentlyContinue
      if (-not $reserved) { Fail "Não consegui reservar a porta $p. Reinicie o computador e rode de novo antes de abrir o Docker Desktop, ou escolha outra porta." }
      # Fica em install.json para o -Uninstall desfazer.
      $script:reservedNow += $p
    }
  }

  $listeners = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Where-Object { $ourPids -notcontains [int]$_.OwningProcess })
  if ($listeners.Count) {
    $owner = [int]$listeners[0].OwningProcess
    if ($owner -eq 4) {
      $urls = @($serviceState | Where-Object { $_ -match "(?i)https?://[^\s/]+:$p/" } | ForEach-Object { $_.Trim() } | Select-Object -Unique)
      $detail = ''
      if ($urls.Count) { $detail = " Endereços registrados: $($urls -join ', ')." }
      Fail "A porta $p está em uso pelo HTTP.sys do Windows (IIS, WinRM, SSTP ou o Gateway de Área de Trabalho Remota).$detail Veja ""netsh http show servicestate"" e desligue o serviço dono, ou escolha outra porta."
    }
    $proc = Get-Process -Id $owner -ErrorAction SilentlyContinue
    $procName = '?'
    if ($proc) { $procName = "$($proc.ProcessName).exe" }
    $svcOwner = Get-CimInstance Win32_Service -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue | Select-Object -First 1
    $svcText = ''
    if ($svcOwner) { $svcText = ", serviço $($svcOwner.Name)" }
    Fail "A porta $p está em uso por $procName (PID $owner$svcText). Pare esse programa (por exemplo um chat rodando fora do serviço) ou escolha outra porta com -Port ou -RedirectPorts."
  }
  $acl = @($urlAcl | Where-Object { $_ -match "(?i)https?://[^\s/]+:$p/" -and $_ -notmatch '(?i)Temporary_Listen_Addresses' } | ForEach-Object { ($_ -replace '^[^:]*:\s*', '').Trim() } | Select-Object -Unique)
  if ($acl.Count) { Warn "Há reservas do HTTP.sys na porta $p ($($acl -join ', ')). Se o serviço dono delas (IIS, WinRM, SSTP) iniciar, ele disputa a porta com o chat." }
  Ok "Porta TCP $p disponível."
}

# ---------- 3. Rede ----------

Section 'Rede'
$public = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { "$($_.NetworkCategory)" -eq 'Public' })
if ($public.Count) {
  Warn 'A rede deste computador está como Pública: o firewall vai bloquear as chamadas. Mude para Domínio ou Privada.'
  foreach ($n in $public) { Info "Adaptador: $($n.InterfaceAlias) ($($n.Name))" }
} else {
  Ok 'Rede como Domínio ou Privada.'
}

# ---------- 4. Segredos e certificado ----------

Section 'Segredos e certificado'

if ($fixRoot) {
  Invoke-Step "Deixar $WesccRoot com os Administradores como donos: só eles criam, renomeiam ou apagam pastas ali; os outros usuários só leem" { Protect-Root $WesccRoot }
}
$serviceExists = [bool](Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)
$secretsVerb = if (Test-Path -LiteralPath $SecretsDir) { 'Conferir as permissões de' } else { 'Criar' }
Invoke-Step "$secretsVerb $SecretsDir (dona e acesso só para SYSTEM e Administradores; o serviço ganha leitura)" {
  Protect-Folder $SecretsDir 'pasta dos segredos' -Mine
  # Com o serviço já instalado, a leitura volta na hora (ele não fica sem os segredos se o script parar no meio).
  if ($serviceExists) { Invoke-Native 'icacls' @($SecretsDir, '/grant', "${ServiceAccount}:(OI)(CI)R", '/Q') "Não consegui dar acesso a $SecretsDir." | Out-Null }
}

# Confere o certificado com o próprio chat (node dist\index.js --check-tls), com as mesmas mensagens do serviço.
# A senha vai pelo ambiente deste processo, nunca pela linha de comando.
function Test-Certificate([string]$Pfx, [string]$Passphrase, [string]$Cert, [string]$Key) {
  $vars = [ordered]@{
    TLS_PFX_FILE = $Pfx; TLS_PFX_PASSPHRASE = $Passphrase; TLS_PFX_PASSPHRASE_FILE = $null
    TLS_CERT_FILE = $Cert; TLS_KEY_FILE = $Key; TLS_CA_FILE = $null
    DATABASE_URL_FILE = $null; LIVEKIT_API_SECRET_FILE = $null; TRUST_PROXY = $null; SITE_URL = $SiteUrl
  }
  $old = @{}
  foreach ($k in $vars.Keys) {
    $old[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
    [Environment]::SetEnvironmentVariable($k, $vars[$k], 'Process')
  }
  try {
    $out = @(Invoke-Native $NodeExe @($Entry, '--check-tls') '')
  } finally {
    foreach ($k in $old.Keys) { [Environment]::SetEnvironmentVariable($k, $old[$k], 'Process') }
  }
  $json = $out | Where-Object { $_.StartsWith('{') } | Select-Object -Last 1
  if (-not $json) { Fail ("Não consegui conferir o certificado com {0}:`n{1}" -f $Entry, ($out -join "`n")) }
  $r = $json | ConvertFrom-Json
  if ($r.error) { Fail $r.error }
  $until = ([datetime]$r.validTo).ToString('dd/MM/yyyy')
  Ok "Certificado de $($r.subject), válido até $until ($($r.daysLeft) dias), vale para $($uri.Host)."
  if ([int]$r.daysLeft -lt 30) { Warn "O certificado vence em $($r.daysLeft) dias. Peça um novo à TI." }
}

if ($Mode -eq 'pfx') {
  if ($certGiven) {
    $pfxSource = (Resolve-Path -LiteralPath $PfxFile -ErrorAction SilentlyContinue).ProviderPath
  } else {
    $pfxSource = $PfxTarget
  }
  if (-not $pfxSource -or -not (Test-Path -LiteralPath $pfxSource)) { Fail "Não achei o certificado $(if ($certGiven) { $PfxFile } else { $PfxTarget }). Informe -PfxFile." }
  $hasPass = Test-Path -LiteralPath $PassFile
  $newPass = $null
  if ($certGiven -or -not $hasPass) {
    if ($Reconfigure -and -not $certGiven) { Fail "Falta $PassFile. Rode sem -Reconfigure para informar a senha do PFX." }
    $prompt = 'Senha do PFX'
    if ($hasPass) { $prompt = 'Senha do PFX (Enter mantém a atual)' }
    $newPass = ConvertFrom-SecureText (Read-Host -AsSecureString $prompt)
    if (-not $newPass -and $hasPass) { $newPass = $null }
  }
  if ($null -ne $newPass) {
    $checkPass = $newPass
  } elseif ($hasPass) {
    $checkPass = [IO.File]::ReadAllText($PassFile, $Utf8).TrimEnd()
  } else {
    $checkPass = ''
  }
  Test-Certificate -Pfx $pfxSource -Passphrase $checkPass
  if ($pfxSource -ne $PfxTarget) { Invoke-Step "Copiar o PFX para $PfxTarget" { Copy-SecretFile $pfxSource $PfxTarget } }
  if ($null -ne $newPass) { Invoke-Step "Gravar a senha do PFX em $PassFile" { Write-SecretFile $PassFile $newPass } }
} elseif ($Mode -eq 'pem') {
  if ($certGiven) {
    $certSource = (Resolve-Path -LiteralPath $CertFile -ErrorAction SilentlyContinue).ProviderPath
    $keySource = (Resolve-Path -LiteralPath $KeyFile -ErrorAction SilentlyContinue).ProviderPath
  } else {
    $certSource = $CertTarget
    $keySource = $KeyTarget
  }
  foreach ($f in @($certSource, $keySource)) { if (-not $f -or -not (Test-Path -LiteralPath $f)) { Fail 'Não achei o certificado ou a chave. Informe -CertFile e -KeyFile.' } }
  Test-Certificate -Cert $certSource -Key $keySource
  if ($certSource -ne $CertTarget) { Invoke-Step "Copiar o certificado para $CertTarget" { Copy-SecretFile $certSource $CertTarget } }
  if ($keySource -ne $KeyTarget) { Invoke-Step "Copiar a chave para $KeyTarget" { Copy-SecretFile $keySource $KeyTarget } }
}

$hasDb = Test-Path -LiteralPath $DbFile
if ($Reconfigure) {
  if (-not $hasDb) { Fail "Falta $DbFile. Rode sem -Reconfigure para informar o endereço do banco." }
  Ok "Endereço do banco em $DbFile."
} else {
  $prompt = 'Endereço do banco, DATABASE_URL (por exemplo postgres://chat:<senha>@127.0.0.1:5432/chat)'
  if ($hasDb) { $prompt = 'Endereço do banco, DATABASE_URL (Enter mantém o atual)' }
  $db = ConvertFrom-SecureText (Read-Host -AsSecureString $prompt)
  if (-not $db) {
    if ($hasDb) {
      Ok "Endereço do banco mantido ($DbFile)."
    } elseif ($Simulate) {
      Info 'Endereço do banco não informado (na instalação de verdade ele é obrigatório).'
    } else {
      Fail 'O endereço do banco é obrigatório.'
    }
  } elseif ($db -notmatch '^postgres(ql)?://') {
    Fail 'O endereço do banco precisa começar com postgres:// (por exemplo postgres://chat:<senha>@127.0.0.1:5432/chat).'
  } else {
    Invoke-Step "Gravar o endereço do banco em $DbFile" { Write-SecretFile $DbFile $db }
  }
}

# Servidor de chamadas: o instalador do LiveKit grava a URL e a chave (nunca o segredo) neste arquivo.
$liveKit = [ordered]@{}
if (Test-Path -LiteralPath $LiveKitEnvFile) {
  foreach ($line in [IO.File]::ReadAllLines($LiveKitEnvFile, $Utf8)) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#') -or $t.IndexOf('=') -lt 1) { continue }
    $k = $t.Substring(0, $t.IndexOf('=')).Trim()
    $v = $t.Substring($t.IndexOf('=') + 1).Trim().Trim('"')
    if (@('LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET_FILE') -contains $k) {
      $liveKit[$k] = $v
    } elseif ($k -eq 'LIVEKIT_API_SECRET') {
      Warn "$LiveKitEnvFile traz o segredo do LiveKit em texto e ele foi ignorado. Rode o instalador do LiveKit de novo: ele grava o segredo em $LiveKitSecretFile."
    }
  }
  if ($liveKit.Count -eq 3) {
    Ok "Servidor de chamadas: $($liveKit['LIVEKIT_URL']) (de $LiveKitEnvFile)."
    if (-not (Test-Path -LiteralPath $liveKit['LIVEKIT_API_SECRET_FILE'])) { Warn "Não achei $($liveKit['LIVEKIT_API_SECRET_FILE']): rode o instalador do LiveKit de novo." }
  } else {
    Warn "$LiveKitEnvFile está incompleto (precisa de LIVEKIT_URL, LIVEKIT_API_KEY e LIVEKIT_API_SECRET_FILE): o servidor de chamadas ficou de fora."
    $liveKit = [ordered]@{}
  }
} else {
  Info "Servidor de chamadas ainda não instalado (sem $LiveKitEnvFile)."
}

# ---------- 5. Serviço ----------

Section 'Serviço'

$envVars = [ordered]@{ NODE_ENV = 'production'; PORT = [string]$Port; SITE_URL = $SiteUrl }
if ($redirectList.Count) { $envVars['HTTP_REDIRECT_PORT'] = $redirectList -join ',' }
$envVars['WEB_DIST'] = $WebDist
$envVars['UPLOAD_DIR'] = $UploadDir
$envVars['DATABASE_URL_FILE'] = $DbFile
if ($Mode -eq 'pfx') {
  $envVars['TLS_PFX_FILE'] = $PfxTarget
  $envVars['TLS_PFX_PASSPHRASE_FILE'] = $PassFile
} elseif ($Mode -eq 'pem') {
  $envVars['TLS_CERT_FILE'] = $CertTarget
  $envVars['TLS_KEY_FILE'] = $KeyTarget
}
foreach ($k in $liveKit.Keys) { $envVars[$k] = $liveKit[$k] }
Info 'Variáveis do serviço (nenhuma traz segredo; os segredos estão nos arquivos *_FILE):'
foreach ($k in $envVars.Keys) { Info "  $k=$($envVars[$k])" }

if (-not (Test-Path -LiteralPath $TemplateFile)) { Fail "Não achei $TemplateFile." }
$envXml = ($envVars.Keys | ForEach-Object { '  <env name="{0}" value="{1}"/>' -f $_, (Escape-Xml $envVars[$_]) }) -join "`r`n"
$xml = [IO.File]::ReadAllText($TemplateFile, $Utf8).Replace("`r`n", "`n").Replace("`n", "`r`n")
$xml = $xml.Replace('{{NODE_EXE}}', (Escape-Xml $NodeExe)).Replace('{{ENTRY}}', (Escape-Xml $Entry))
$xml = $xml.Replace('{{WORK_DIR}}', (Escape-Xml $InstallDir)).Replace('{{LOG_DIR}}', (Escape-Xml $LogDir)).Replace('{{ENV}}', $envXml)

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service -and $service.Status -ne 'Stopped') {
  Invoke-Step 'Parar o serviço wescc-chat (as pessoas reconectam sozinhas quando ele voltar)' { Stop-Service -Name $ServiceName -Force }
}
# Trancadas antes de gravar o WinSW e o XML: ninguém troca um arquivo entre a gravação e a permissão. Uma pasta dentro
# de outra (os arquivos enviados no padrão, dentro da pasta do serviço) vai junto com a de fora.
$protect = @(
  [pscustomobject]@{ Path = $InstallDir; What = 'pasta do serviço'; Mine = $true; NoLinks = $true; Again = $false }
  [pscustomobject]@{ Path = $AppDir; What = 'pasta do chat'; Mine = $false; NoLinks = $false; Again = $appRelock }
  [pscustomobject]@{ Path = $UploadDir; What = 'pasta dos arquivos enviados'; Mine = $false; NoLinks = $true; Again = $false }
)
foreach ($d in $protect) {
  if (@($protect | Where-Object { -not (Test-SamePath $_.Path $d.Path) -and (Test-Within $d.Path $_.Path) }).Count) { continue }
  $skip = @($AppDir | Where-Object { -not (Test-SamePath $_ $d.Path) -and (Test-Within $_ $d.Path) })
  $note = ''
  if (-not (Test-Locked $d.Path)) { $note = ' (da primeira vez o Windows confere arquivo por arquivo: pode levar alguns minutos)' }
  if ($d.Again) { $note = ' (arquivo por arquivo, por causa dos arquivos com outras permissões: pode levar alguns minutos)' }
  Invoke-Step "Deixar $($d.Path) com SYSTEM e Administradores como donos e únicos com escrita$note" {
    Protect-Folder $d.Path $d.What -Mine:$d.Mine -NoLinks:$d.NoLinks -Again:$d.Again -Skip $skip
  }
}
# Os arquivos enviados dentro da pasta do chat (onde já estavam) não passam pela conferência de links acima.
if ($uploadsFresh -and (Test-Within $UploadDir $AppDir)) { Invoke-Step "Conferir $UploadDir (sem links para fora)" { Assert-OwnFolder $UploadDir 'pasta dos arquivos enviados' } }
Invoke-Step "Criar as pastas $LogDir e $UploadDir" { New-Item -ItemType Directory -Force -Path $LogDir, $UploadDir | Out-Null }
if ($winswSource) {
  Invoke-Step "Copiar o WinSW $winswTag como $ServiceExe" {
    Remove-OldFile $ServiceExe; Copy-Item -LiteralPath $winswSource -Destination $ServiceExe -Force
    if ((Get-Sha256 $ServiceExe) -ne $winswHash) {
      Remove-OldFile $ServiceExe
      Fail "A cópia do WinSW em $ServiceExe não confere com o hash esperado (disco cheio ou antivírus?) e foi apagada. O serviço do chat fica parado até o instalador rodar de novo."
    }
  }
}
Invoke-Step "Gravar $ServiceXml" { Remove-OldFile $ServiceXml; [IO.File]::WriteAllText($ServiceXml, $xml, $Utf8) }
if (-not $service) {
  Invoke-Step 'Registrar o serviço wescc-chat (início automático atrasado)' { Invoke-Native $ServiceExe @('install') 'O WinSW não conseguiu registrar o serviço.' | Out-Null }
} else {
  Ok 'Serviço wescc-chat já registrado.'
}
Invoke-Step "Rodar o serviço como $ServiceAccount (conta virtual, sem senha)" {
  Invoke-Native 'sc.exe' @('config', $ServiceName, 'obj=', $ServiceAccount) "Não consegui trocar a conta do serviço para $ServiceAccount." | Out-Null
}
Invoke-Step "Permissões de $ServiceAccount`: leitura no chat e na pasta do serviço, escrita só nos logs e nos arquivos enviados, leitura nos segredos (pode levar um minuto)" {
  $grants = @(
    @($AppDir, "${ServiceAccount}:(OI)(CI)RX"),
    @($InstallDir, "${ServiceAccount}:(OI)(CI)RX"),
    @($LogDir, "${ServiceAccount}:(OI)(CI)M"),
    @($UploadDir, "${ServiceAccount}:(OI)(CI)M"),
    @($SecretsDir, "${ServiceAccount}:(OI)(CI)R")
  )
  foreach ($g in $grants) { Invoke-Native 'icacls' @($g[0], '/grant', $g[1], '/Q') "Não consegui dar acesso a $($g[0])." | Out-Null }
}
Invoke-Step "Gravar as escolhas (sem segredos) em $InstallJson" {
  $allReserved = @(@(Split-List $S['ReservedPorts'] | ForEach-Object { [int]$_ }) + $reservedNow | Select-Object -Unique)
  $state = [ordered]@{
    AppDir = $AppDir; SiteUrl = $SiteUrl; Port = $Port; RedirectPorts = @($redirectList); TlsMode = $Mode
    LanCidr = @($LanCidr); NodeExe = $NodeExe; UploadDir = $UploadDir; ReservedPorts = @($allReserved); UpdatedAt = (Get-Date).ToString('s')
  }
  [IO.File]::WriteAllText($InstallJson, ($state | ConvertTo-Json), $Utf8)
}

# ---------- 6. Firewall ----------

Section 'Firewall'
$firewallPorts = @($Port) + $redirectList
Invoke-Step ("Liberar TCP {0} para {1} (perfis Domínio e Privado; a porta {2} fica só neste computador)" -f ($firewallPorts -join ', '), ($LanCidr -join ', '), $InternalPort) {
  Get-NetFirewallRule -Group $FirewallGroup -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  foreach ($p in $firewallPorts) {
    New-NetFirewallRule -DisplayName "Wescc Chat TCP $p" -Group $FirewallGroup -Direction Inbound -Action Allow -Protocol TCP -LocalPort $p -RemoteAddress $LanCidr -Profile Domain, Private | Out-Null
  }
}

# ---------- 7. Início e teste ----------

Section 'Início e teste'
Invoke-Step 'Iniciar o serviço wescc-chat' { Start-Service -Name $ServiceName }
if (-not $Simulate) {
  # O processo morrer nos primeiros segundos costuma ser antivírus, AppLocker ou um arquivo de segredo errado.
  $died = $false
  $nodePid = $null
  $until = (Get-Date).AddSeconds(6)
  while ((Get-Date) -lt $until) {
    $w = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
    if ($w.State -ne 'Running' -and $w.State -ne 'Start Pending') { $died = $true; break }
    $child = Get-CimInstance Win32_Process -Filter ("ParentProcessId={0}" -f $w.ProcessId) -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'node.exe' } | Select-Object -First 1
    if ($child) {
      if ($nodePid -and $child.ProcessId -ne $nodePid) { $died = $true; break }
      $nodePid = $child.ProcessId
    } elseif ($nodePid) {
      $died = $true
      break
    }
    Start-Sleep -Milliseconds 500
  }
  if ($died) {
    Show-LogTail
    Fail "O serviço inicia e para logo em seguida. Veja o log em $LogDir. Se o antivírus ou o AppLocker bloqueou o node.exe ou o wescc-chat.exe, peça à TI para liberar pelo hash (SHA-256 em scripts/livekit/versions.json)."
  }

  # O chat está na rede interna: o teste não passa pelo proxy do navegador.
  $healthUrl = "$SiteUrl/health"
  $healthy = $false
  $lastError = ''
  $oldProxy = [Net.WebRequest]::DefaultWebProxy
  [Net.WebRequest]::DefaultWebProxy = New-Object Net.WebProxy
  try {
    $until = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $until) {
      try {
        $res = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 5
        if ($res.StatusCode -eq 200) { $healthy = $true; break }
      } catch {
        $lastError = $_.Exception.Message
      }
      Start-Sleep -Seconds 2
    }
  } finally {
    [Net.WebRequest]::DefaultWebProxy = $oldProxy
  }
  if ($healthy) {
    Ok "O chat respondeu em $healthUrl."
  } else {
    $open = $false
    $tcp = New-Object Net.Sockets.TcpClient
    try { $open = $tcp.ConnectAsync('127.0.0.1', $Port).Wait(2000) -and $tcp.Connected } catch { $open = $false } finally { $tcp.Close() }
    Show-LogTail
    if ($open) {
      Fail "O chat está no ar neste computador (porta $Port), mas $healthUrl não respondeu daqui ($lastError). Confira se o nome $($uri.Host) aponta para este computador no DNS e se este computador confia no certificado (a raiz do AD CS)."
    }
    Fail "O chat não respondeu em 60 s. Veja o log em $LogDir."
  }
}

# ---------- 8. Próximas vezes ----------

Section 'Próximas vezes'
Info 'Arquivos baixados da internet ficam marcados pelo Windows (Mark-of-the-Web) e o PowerShell recusa os scripts.'
Info 'Antes de rodar de novo uma cópia nova da pasta scripts:'
Info '  Get-ChildItem -Recurse .\scripts | Unblock-File'
Info '  powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-chat-service.ps1 -Reconfigure'
if (-not $liveKit.Count) { Info 'Chamadas em grupo: instale o servidor de chamadas (scripts\livekit\install-windows.ps1) e rode este script com -Reconfigure.' }
Info "Log do serviço: $LogDir. Parar e iniciar: Stop-Service wescc-chat / Start-Service wescc-chat."
Info "Para atualizar o chat em $AppDir (git pull, npm ci, npm run build), use um PowerShell como Administrador: a pasta só aceita escrita deles."
Info 'Depois de atualizar, rode este script com -Reconfigure: ele confere as permissões do que entrou e reinicia o serviço com a versão nova.'
Info 'Para remover: powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-chat-service.ps1 -Uninstall'
Write-Host ''
if ($Simulate) {
  Write-Host 'Simulação concluída: nada foi alterado.' -ForegroundColor Cyan
} else {
  Write-Host "Pronto: o Wescc Chat está rodando como serviço em $SiteUrl." -ForegroundColor Green
}

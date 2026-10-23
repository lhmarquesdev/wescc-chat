#!/usr/bin/env bash
# Instala ou atualiza o servidor de chamadas em grupo do Wescc Chat (LiveKit) como o serviço systemd
# "wescc-livekit", num servidor Linux x86_64. O roteiro é o mesmo do install-windows.ps1:
#
#   sudo scripts/livekit/install-linux.sh --node-ip 10.10.0.5 --lan-cidr 10.10.0.0/16,10.20.0.0/16
#   sudo scripts/livekit/install-linux.sh --dry-run    (mostra cada passo sem mudar nada)
#   sudo scripts/livekit/install-linux.sh --uninstall  (remove o serviço, os programas e o segredo)
#
# Baixa o LiveKit na versão fixada em scripts/livekit/versions.json (conferido pelo SHA-256), gera
# /etc/wescc/livekit.yaml com render-config.mjs e roda /opt/wescc/livekit/livekit-server pelo usuário de sistema
# wescc-livekit. Pode rodar de novo quantas vezes quiser: a chave e o segredo continuam os mesmos e o que já está
# certo fica como está. O segredo nunca vai para a linha de comando nem para a tela.
set -euo pipefail
umask 022

ETC_DIR=/etc/wescc
YAML_FILE=$ETC_DIR/livekit.yaml
SECRET_FILE=$ETC_DIR/livekit-api-secret
CHAT_ENV_FILE=$ETC_DIR/chat-livekit.env
STATE_FILE=$ETC_DIR/livekit-install.conf
INSTALL_DIR=/opt/wescc/livekit
UNIT_FILE=/etc/systemd/system/wescc-livekit.service
SYSCTL_FILE=/etc/sysctl.d/60-wescc-livekit.conf

SERVICE=wescc-livekit
SVC_USER=wescc-livekit
LIVEKIT_URL=http://127.0.0.1:7880
API_PORT=7880
TCP_PORT=7881
UDP_FIRST=7882
UDP_LAST=7885
DEFAULT_WEBHOOK_URL=http://127.0.0.1:3080/sfu-webhook
DEFAULT_MAX_MBPS=480
DEFAULT_CHAT_USER=wescc-chat
UDP_BUFFER=16777216

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
VERSIONS_FILE=$SCRIPT_DIR/versions.json
RENDER_SCRIPT=$SCRIPT_DIR/render-config.mjs
TEMPLATE_FILE=$SCRIPT_DIR/livekit.yaml.tpl
BIN=$INSTALL_DIR/livekit-server

usage() {
  cat <<'EOF'
Uso: sudo scripts/livekit/install-linux.sh --node-ip <IP do servidor> --lan-cidr <faixa>[,<faixa>...] [opções]

  --node-ip <IP>         IP fixo deste servidor na rede local, o que os PCs das filiais alcançam
                         (obrigatório na primeira instalação)
  --lan-cidr <faixas>    a rede local e as das filiais (VPN) que fazem chamadas, por exemplo
                         10.10.0.0/16,10.20.0.0/16 (obrigatório na primeira instalação; pode repetir a opção)
  --webhook-url <url>    para onde o LiveKit avisa entradas e saídas. Padrão: http://127.0.0.1:3080/sfu-webhook
                         (chat com HTTPS próprio); com o chat em HTTP atrás do nginx,
                         http://127.0.0.1:<porta do chat>/sfu-webhook
  --max-mbps <n>         limite de banda do LiveKit, em Mbps. Padrão: 480 (metade de uma placa de 1 Gbps)
  --max-tracks <n>       limite de faixas de áudio e vídeo (num_tracks, entrando e saindo), de 100 a 100000.
                         Padrão: 400 por processador lógico, até 8000, como o próprio LiveKit; 0 volta ao padrão
  --chat-user <usuário>  usuário do serviço do chat, que ganha leitura do segredo. Padrão: wescc-chat
  --node <caminho>       node do Node.js 22, usado para gerar a configuração. Padrão: o do PATH
  --offline <pasta>      pasta com livekit_<versão>_linux_amd64.tar.gz já baixado
  --proxy <url>          proxy para baixar o LiveKit (por exemplo http://proxy.empresa.local:8080), sem usuário e
                         senha: com eles, passe o proxy pela variável https_proxy (veja o README)
  --uninstall            remove o serviço, o usuário wescc-livekit, o programa, a configuração e o segredo; as
                         escolhas em /etc/wescc/livekit-install.conf ficam
  --dry-run              mostra cada passo sem mudar nada
  -h, --help             esta ajuda

As escolhas ficam em /etc/wescc/livekit-install.conf (sem segredos) e valem para a próxima vez; o que vier na
linha de comando substitui o que estava salvo.
EOF
}

# ---------- Saída e utilitários ----------

if [[ -t 1 ]]; then
  C_HEAD=$'\e[1m' C_OK=$'\e[32m' C_WARN=$'\e[33m' C_ERR=$'\e[31m' C_SIM=$'\e[36m' C_END=$'\e[0m'
else
  C_HEAD='' C_OK='' C_WARN='' C_ERR='' C_SIM='' C_END=''
fi
SECTION=0
WORK=''
DRY_RUN=0

section() {
  SECTION=$((SECTION + 1))
  printf '\n%s[%d/11] %s%s\n' "$C_HEAD" "$SECTION" "$1" "$C_END"
}
info() { printf '    %s\n' "$*"; }
ok() { printf '    %sOK  %s%s\n' "$C_OK" "$*" "$C_END"; }
warn() { printf '    %sAVISO  %s%s\n' "$C_WARN" "$*" "$C_END"; }
cleanup() {
  if [[ -n $WORK && -d $WORK ]]; then rm -rf -- "$WORK"; fi
  WORK=''
}
fail() {
  cleanup
  printf '\n%sERRO: %s%s\n' "$C_ERR" "$*" "$C_END" >&2
  exit 1
}
trap cleanup EXIT

# Mudanças passam todas por aqui: com --dry-run só aparecem na tela.
step() {
  local description=$1
  shift
  if ((DRY_RUN)); then
    printf '    %s[simulação] %s%s\n' "$C_SIM" "$description" "$C_END"
    return 0
  fi
  printf '    -> %s\n' "$description"
  "$@"
}

has() { command -v "$1" >/dev/null 2>&1; }
systemd_running() { [[ -d /run/systemd/system ]]; }

OCTET='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
IPV4_RE="^$OCTET\\.$OCTET\\.$OCTET\\.$OCTET\$"
CIDR_RE='^([^/]+)/(3[0-2]|[12]?[0-9])$'
KEYS_RE='^[[:space:]]+"(API[A-Za-z0-9]{12})":[[:space:]]*"([A-Za-z0-9_-]{43})"[[:space:]]*$'

# IPv4 em decimal, sem zeros à esquerda; 0.x, multicast e broadcast não são o endereço de um computador.
is_host_ip() {
  [[ $1 =~ $IPV4_RE ]] || return 1
  ((BASH_REMATCH[1] != 0 && BASH_REMATCH[1] < 224))
}
is_cidr() {
  [[ $1 =~ $CIDR_RE ]] || return 1
  [[ ${BASH_REMATCH[1]} =~ $IPV4_RE ]]
}
ip_number() {
  local a b c d
  IFS=. read -r a b c d <<<"$1"
  echo $(((a << 24) + (b << 16) + (c << 8) + d))
}
in_cidr() {
  local bits=${2#*/} mask=0 ip net
  if ((bits > 0)); then mask=$(((0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF)); fi
  ip=$(ip_number "$1")
  net=$(ip_number "${2%/*}")
  (((ip & mask) == (net & mask)))
}

# Pela entrada padrão: o sha256sum escapa nomes de arquivo estranhos na saída.
sha256_of() {
  local h
  h=$(sha256sum <"$1") || return 1
  printf '%s' "${h%% *}"
}

# Conteúdo de um arquivo de segredo sem BOM e sem espaços no fim (o mesmo tratamento do chat).
read_secret_file() {
  local s=''
  if [[ -r $1 ]]; then s=$(<"$1"); fi
  s=${s#$'\xEF\xBB\xBF'}
  s=${s%"${s##*[![:space:]]}"}
  printf '%s' "$s"
}

# Valor de NOME=valor num arquivo .env (o arquivo nunca é executado).
env_value() {
  local line
  if [[ ! -r $1 ]]; then return 0; fi
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    if [[ $line == "$2="* ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  done <"$1"
  return 0
}

# A chave e o segredo da configuração que já está rodando.
read_existing_keys() {
  local prev='' line
  if [[ ! -r $1 ]]; then return 0; fi
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    if [[ $prev == 'keys:' && $line =~ $KEYS_RE ]]; then
      KEY=${BASH_REMATCH[1]}
      SECRET=${BASH_REMATCH[2]}
      return 0
    fi
    prev=$line
  done <"$1"
  return 0
}

# Grava ao lado e troca de uma vez, já com dono e permissões: ninguém lê o arquivo pela metade nem aberto demais.
install_file() { # origem destino dono grupo modo
  local tmp dir
  dir=$(dirname -- "$2")
  if [[ ! -d $dir ]]; then install -d -o root -g root -m 0755 "$dir"; fi
  tmp=$(mktemp "$dir/.$(basename -- "$2").XXXXXX") || fail "Não consegui gravar $2."
  if ! { cat -- "$1" >"$tmp" && chown "$3:$4" "$tmp" && chmod "$5" "$tmp" && mv -f -- "$tmp" "$2"; }; then
    rm -f -- "$tmp"
    fail "Não consegui gravar $2."
  fi
}
install_text() { # texto destino dono grupo modo
  local src
  src=$(mktemp "$WORK/texto.XXXXXX")
  printf '%s' "$1" >"$src"
  install_file "$src" "$2" "$3" "$4" "$5"
}

# O printf é interno do bash: o segredo não passa pela linha de comando de nenhum processo.
write_secret() {
  local src
  src=$(mktemp "$WORK/segredo.XXXXXX")
  printf '%s' "$SECRET" >"$src"
  install_file "$src" "$SECRET_FILE" root "$SVC_USER" 0640
}

random_key() {
  "$NODE" -e '
    const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let s = "";
    // Sem viés: bytes de 248 a 255 são descartados (248 = 4 x 62).
    while (s.length < 12) for (const b of require("node:crypto").randomBytes(32)) if (b < 248 && s.length < 12) s += a[b % 62];
    process.stdout.write("API" + s);'
}
random_secret() {
  "$NODE" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'
}

# O render-config.mjs valida tudo de novo; os avisos dele aparecem aqui, os erros param o instalador.
render() {
  local out rc=0 line
  local errors=()
  out=$("$NODE" "$RENDER_SCRIPT" "$@" 2>&1) || rc=$?
  while IFS= read -r line; do
    case $line in
      'AVISO: '*) warn "${line#AVISO: }" ;;
      'ERRO: '*) errors+=("${line#ERRO: }") ;;
      *) ;;
    esac
  done <<<"$out"
  if ((rc != 0)); then
    if ((${#errors[@]} == 0)); then errors=("render-config.mjs saiu com o código $rc."); fi
    fail "$(printf '%s\n' "${errors[@]}")"
  fi
}

download() { # url destino
  # O --proxy vai só para o ambiente do curl (atribuição do bash, nunca argumento de outro programa). Sem ele, vale o
  # https_proxy que já estiver no ambiente.
  if has curl; then
    if [[ -n $PROXY ]]; then
      https_proxy=$PROXY HTTPS_PROXY=$PROXY curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 2 -o "$2" "$1"
    else
      curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 2 -o "$2" "$1"
    fi
  elif has wget; then
    if [[ -n $PROXY ]]; then
      https_proxy=$PROXY HTTPS_PROXY=$PROXY wget -q --https-only -O "$2" "$1"
    else
      wget -q --https-only -O "$2" "$1"
    fi
  else
    fail 'Não achei o curl nem o wget para baixar o LiveKit. Instale um deles ou use --offline <pasta>.'
  fi
}

service_pid() {
  local p
  p=$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || true)
  if [[ $p =~ ^[1-9][0-9]*$ ]]; then printf '%s' "$p"; fi
}

# "endereço porta pid programa" de cada socket escutando (t = TCP, u = UDP).
listeners() {
  local _state _rq _sq local_addr _peer rest addr port pid name
  ss -H -ln"$1"p 2>/dev/null | while read -r _state _rq _sq local_addr _peer rest; do
    port=${local_addr##*:}
    addr=${local_addr%:*}
    addr=${addr%%\%*}
    pid='-'
    name='-'
    if [[ $rest =~ \(\(\"([^\"]+)\",pid=([0-9]+) ]]; then
      name=${BASH_REMATCH[1]}
      pid=${BASH_REMATCH[2]}
    fi
    printf '%s %s %s %s\n' "$addr" "$port" "$pid" "$name"
  done
}

owner_text() { # pid programa
  local unit=''
  if [[ $1 =~ ^[0-9]+$ && -r /proc/$1/cgroup ]]; then unit=$(grep -o '[^/]*\.service' "/proc/$1/cgroup" | tail -n 1 || true); fi
  if [[ $1 == '-' ]]; then
    printf 'um programa de outro usuário (rode com sudo para ver qual)'
  elif [[ -n $unit ]]; then
    printf '%s (PID %s, serviço %s)' "$2" "$1" "${unit%.service}"
  else
    printf '%s (PID %s)' "$2" "$1"
  fi
}

declare -A SAVED=()
read_state() {
  local line
  if [[ ! -f $STATE_FILE ]]; then return 1; fi
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line =~ ^([A-Z_]+)=(.*)$ ]]; then SAVED[${BASH_REMATCH[1]}]=${BASH_REMATCH[2]}; fi
  done <"$STATE_FILE"
}

show_log() {
  if has journalctl; then
    printf '\n    Últimas linhas do log (journalctl -u %s):\n' "$SERVICE"
    journalctl -u "$SERVICE" -n 15 --no-pager 2>/dev/null | sed 's/^/      /' || true
  fi
}

# ---------- Opções ----------

NODE_IP=''
LAN_ARGS=()
WEBHOOK_URL=''
MAX_MBPS=''
MAX_TRACKS=''
CHAT_USER=''
NODE=''
OFFLINE=''
PROXY=''
UNINSTALL=0
declare -A GIVEN=()
while (($#)); do
  if [[ $1 == --*=* ]]; then set -- "${1%%=*}" "${1#*=}" "${@:2}"; fi
  case $1 in
    -h | --help)
      usage
      exit 0
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    --secret | --api-secret)
      fail "O segredo não vai na linha de comando (outros usuários a veem): o instalador gera o segredo e o grava em $SECRET_FILE."
      ;;
    --node-ip | --lan-cidr | --webhook-url | --max-mbps | --max-tracks | --chat-user | --node | --offline | --proxy)
      if [[ $# -lt 2 || $2 == --* ]]; then fail "Falta o valor de $1."; fi
      case $1 in
        --node-ip) NODE_IP=$2 ;;
        --lan-cidr) LAN_ARGS+=("$2") ;;
        --webhook-url) WEBHOOK_URL=$2 ;;
        --max-mbps) MAX_MBPS=$2 ;;
        --max-tracks) MAX_TRACKS=$2 ;;
        --chat-user) CHAT_USER=$2 ;;
        --node) NODE=$2 ;;
        --offline) OFFLINE=$2 ;;
        --proxy) PROXY=$2 ;;
      esac
      GIVEN[${1#--}]=1
      shift 2
      ;;
    *) fail "Opção desconhecida: $1 (veja --help)." ;;
  esac
done
# A linha de comando do instalador fica visível para os outros usuários enquanto ele roda (ps, /proc). Com ou sem
# http:// na frente (o curl aceita usuario:senha@proxy:8080), um @ no endereço de um proxy só separa o usuário e a senha.
if [[ $PROXY == *@* ]]; then
  fail 'Usuário e senha do proxy não vão na linha de comando (outros usuários a veem): rode sem --proxy, com a variável https_proxy no ambiente (veja o README, seção Chamadas em grupo).'
fi

printf '%sWescc Chat: servidor de chamadas (LiveKit) como serviço do Linux%s\n' "$C_HEAD" "$C_END"
if ((DRY_RUN)); then printf '%sSimulação (--dry-run): nada será alterado.%s\n' "$C_SIM" "$C_END"; fi

if ((EUID != 0)); then
  if ((DRY_RUN)); then
    warn 'Sem root: a simulação segue, mas a instalação de verdade precisa de sudo.'
  else
    fail 'Rode como root: sudo scripts/livekit/install-linux.sh ...'
  fi
fi

# ---------- Remoção (--uninstall) ----------

CHAT_SERVICE=wescc-chat
CHAT_UNIT_FILE=${UNIT_FILE%/*}/$CHAT_SERVICE.service

# O serviço do chat ainda aponta para o segredo, no próprio serviço (Environment=) ou num arquivo de EnvironmentFile=
# dele? Sem o segredo, ele não subiria. O chat-livekit.env não conta: ele sai junto. Sem o systemctl (ou com o
# systemd parado), lê os arquivos do serviço em /etc/systemd/system.
mentions_secret() { # texto
  local line
  while IFS= read -r line; do
    line=${line#"${line%%[![:space:]]*}"}
    case $line in '' | '#'* | ';'*) continue ;; esac
    if [[ $line == *"$SECRET_FILE"* ]]; then return 0; fi
  done <<<"$1"
  return 1
}
chat_uses_secret() {
  local unit line file
  unit=$(systemctl cat "$CHAT_SERVICE" 2>/dev/null) || unit=''
  if [[ -z $unit ]]; then unit=$(cat -- "$CHAT_UNIT_FILE" "$CHAT_UNIT_FILE.d"/*.conf 2>/dev/null) || true; fi
  if mentions_secret "$unit"; then return 0; fi
  while IFS= read -r line; do
    line=${line#"${line%%[![:space:]]*}"}
    if [[ $line =~ ^EnvironmentFile[[:space:]]*=[[:space:]]*-?(.*)$ ]]; then
      file=${BASH_REMATCH[1]%"${BASH_REMATCH[1]##*[![:space:]]}"}
      if [[ -n $file && $file != "$CHAT_ENV_FILE" && -f $file && -r $file ]] && mentions_secret "$(cat -- "$file")"; then return 0; fi
    fi
  done <<<"$unit"
  return 1
}
if ((UNINSTALL)); then
  printf '\n%sRemover o servidor de chamadas%s\n' "$C_HEAD" "$C_END"
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/wescc-livekit.XXXXXX")
  SYSTEMD=0
  if has systemctl && systemd_running; then SYSTEMD=1; fi
  stop_service() {
    if ! systemctl stop "$SERVICE"; then fail "Não consegui parar o serviço $SERVICE. Veja o log com journalctl -u $SERVICE -n 50."; fi
  }
  remove_unit() {
    rm -f -- "$UNIT_FILE"
    if ((SYSTEMD)); then
      systemctl daemon-reload
      systemctl reset-failed "$SERVICE" 2>/dev/null || true
    fi
  }
  remove_dir() {
    if ! rmdir -- "$1" 2>/dev/null; then warn "A pasta $1 ficou: tem arquivos que não são do instalador."; fi
  }
  remove_group() {
    if getent group "$SVC_USER" >/dev/null 2>&1 && ! groupdel "$SVC_USER"; then
      warn "O grupo $SVC_USER ficou (é o grupo principal de outro usuário?). Apague com: sudo groupdel $SVC_USER"
    fi
  }
  remove_user() {
    if ! userdel "$SVC_USER"; then
      warn "Não consegui apagar o usuário $SVC_USER (algum processo dele ainda roda?). Tente de novo com: sudo userdel $SVC_USER"
      return 0
    fi
    remove_group
  }

  if ((SYSTEMD)); then
    if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
      step "Parar o serviço $SERVICE (as chamadas em andamento terminam)" stop_service
    fi
    if systemctl is-enabled --quiet "$SERVICE" 2>/dev/null; then
      step "Desativar o início automático do serviço $SERVICE" systemctl disable --quiet "$SERVICE"
    fi
  elif [[ -f $UNIT_FILE ]]; then
    warn "O systemd não está rodando aqui: o serviço $SERVICE não foi parado, só os arquivos saem."
  fi
  if [[ -f $UNIT_FILE ]]; then step "Apagar $UNIT_FILE e recarregar o systemd" remove_unit; fi
  had_sysctl=0
  if [[ -f $SYSCTL_FILE ]]; then had_sysctl=1; fi
  for f in "$BIN" "$BIN.novo" "$YAML_FILE" "$SYSCTL_FILE"; do
    if [[ -e $f || -L $f ]]; then step "Apagar $f" rm -f -- "$f"; fi
  done
  if [[ -d $INSTALL_DIR ]]; then step "Apagar a pasta $INSTALL_DIR" remove_dir "$INSTALL_DIR"; fi

  if [[ -e $SECRET_FILE || -L $SECRET_FILE ]]; then
    if chat_uses_secret; then
      warn "O segredo $SECRET_FILE fica: o serviço $CHAT_SERVICE ainda aponta para ele (no próprio serviço ou num arquivo de EnvironmentFile=) e não subiria sem ele. Tire LIVEKIT_API_SECRET_FILE de lá e rode --uninstall de novo."
    else
      step "Apagar o segredo $SECRET_FILE" rm -f -- "$SECRET_FILE"
    fi
  fi
  # O serviço do chat do README usa EnvironmentFile= sem "-": sem o arquivo ele não sobe. Só com o comentário, o
  # chat sobe sem as chamadas em grupo.
  env_off="# Gerado por scripts/livekit/install-linux.sh --uninstall: o servidor de chamadas foi removido e o chat sobe
# sem as chamadas em grupo. Pode tirar EnvironmentFile=$CHAT_ENV_FILE do serviço do chat e apagar este arquivo.
"
  if [[ -f $CHAT_ENV_FILE && "$(cat -- "$CHAT_ENV_FILE")"$'\n' != "$env_off" ]]; then
    step "Tirar o endereço, a chave e o caminho do segredo de $CHAT_ENV_FILE (fica só um comentário, para o chat continuar subindo)" \
      install_text "$env_off" "$CHAT_ENV_FILE" root root 0644
  fi
  if getent passwd "$SVC_USER" >/dev/null 2>&1; then
    step "Apagar o usuário de sistema $SVC_USER (e o grupo dele)" remove_user
  elif getent group "$SVC_USER" >/dev/null 2>&1; then
    step "Apagar o grupo $SVC_USER" remove_group
  fi

  printf '\n%sPróximos passos%s\n' "$C_HEAD" "$C_END"
  info "Reinicie o chat para ele deixar de oferecer as chamadas em grupo: sudo systemctl restart $CHAT_SERVICE"
  # O instalador não muda o firewall; as regras sugeridas por ele saem com os comandos abaixo.
  if read_state && [[ -n ${SAVED[LAN_CIDR]:-} ]]; then
    IFS=, read -r -a saved_cidrs <<<"${SAVED[LAN_CIDR]}"
    info 'Se liberou a mídia no ufw ou no firewalld, tire as regras com:'
    for c in "${saved_cidrs[@]}"; do
      info "  sudo ufw delete allow proto udp from $c to any port $UDP_FIRST:$UDP_LAST"
      info "  sudo ufw delete allow proto tcp from $c to any port $TCP_PORT"
      info "  sudo firewall-cmd --permanent --remove-rich-rule='rule family=\"ipv4\" source address=\"$c\" port port=\"$UDP_FIRST-$UDP_LAST\" protocol=\"udp\" accept'"
      info "  sudo firewall-cmd --permanent --remove-rich-rule='rule family=\"ipv4\" source address=\"$c\" port port=\"$TCP_PORT\" protocol=\"tcp\" accept'"
    done
    info '  sudo firewall-cmd --reload'
  else
    info "Se liberou UDP $UDP_FIRST-$UDP_LAST e TCP $TCP_PORT no firewall para o LiveKit, tire essas regras."
  fi
  if ((had_sysctl)); then info "Os buffers de UDP de $SYSCTL_FILE valem até o próximo boot; depois, voltam ao padrão do sistema."; fi
  if [[ -f $STATE_FILE ]]; then info "As escolhas ficam em $STATE_FILE (sem segredos) para uma nova instalação; apague o arquivo se não for reinstalar."; fi
  cleanup
  echo
  if ((DRY_RUN)); then
    printf '%sSimulação concluída: nada foi alterado.%s\n' "$C_SIM" "$C_END"
  else
    printf '%sPronto: o servidor de chamadas foi removido.%s\n' "$C_OK" "$C_END"
  fi
  exit 0
fi

# ---------- 1. Ambiente ----------

section 'Ambiente'

if [[ $(uname -m) != x86_64 ]]; then fail "O servidor de chamadas precisa de Linux x86_64 (amd64); este é $(uname -m)."; fi
if ! systemd_running; then
  if ((DRY_RUN)); then warn 'O systemd não está rodando aqui: a instalação de verdade precisa dele.'; else fail 'Este instalador usa o systemd, que não está rodando aqui.'; fi
fi

if read_state; then
  info "Usando as escolhas salvas em $STATE_FILE (o que veio na linha de comando tem precedência)."
fi
if [[ -z ${GIVEN[node-ip]:-} && -n ${SAVED[NODE_IP]:-} ]]; then NODE_IP=${SAVED[NODE_IP]}; fi
if [[ -z ${GIVEN[lan-cidr]:-} && -n ${SAVED[LAN_CIDR]:-} ]]; then LAN_ARGS=("${SAVED[LAN_CIDR]}"); fi
if [[ -z ${GIVEN[max-mbps]:-} ]]; then MAX_MBPS=${SAVED[MAX_MBPS]:-$DEFAULT_MAX_MBPS}; fi
if [[ -z ${GIVEN[max-tracks]:-} ]]; then MAX_TRACKS=${SAVED[MAX_TRACKS]:-0}; fi
if [[ -z ${GIVEN[chat-user]:-} ]]; then CHAT_USER=${SAVED[CHAT_USER]:-$DEFAULT_CHAT_USER}; fi
if [[ -z ${GIVEN[node]:-} && -n ${SAVED[NODE]:-} ]]; then NODE=${SAVED[NODE]}; fi

NODE_IP=${NODE_IP//[[:space:]]/}
if [[ -z $NODE_IP ]]; then fail 'Informe --node-ip com o IP fixo deste servidor na rede local (por exemplo --node-ip 10.10.0.5).'; fi
if ! is_host_ip "$NODE_IP"; then fail "IP do servidor inválido: $NODE_IP"; fi
LAN_CIDRS=()
for arg in "${LAN_ARGS[@]}"; do
  IFS=, read -r -a parts <<<"$arg"
  for c in "${parts[@]}"; do
    c=${c//[[:space:]]/}
    if [[ -z $c ]]; then continue; fi
    if ! is_cidr "$c"; then fail "Faixa de rede inválida: $c (use o formato 10.10.0.0/16)."; fi
    if [[ " ${LAN_CIDRS[*]} " != *" $c "* ]]; then LAN_CIDRS+=("$c"); fi
  done
done
if ((${#LAN_CIDRS[@]} == 0)); then fail 'Informe --lan-cidr com a rede local e as redes das filiais que fazem chamadas (por exemplo --lan-cidr 10.10.0.0/16,10.20.0.0/16).'; fi
LAN_LIST=$(IFS=,; printf '%s' "${LAN_CIDRS[*]}")
LAN_TEXT=${LAN_LIST//,/, }
if ! [[ $MAX_MBPS =~ ^[0-9]{1,5}$ ]] || ((10#$MAX_MBPS < 10 || 10#$MAX_MBPS > 10000)); then fail "Limite de banda inválido: $MAX_MBPS. Use --max-mbps de 10 a 10000."; fi
MAX_MBPS=$((10#$MAX_MBPS))
if ! [[ $MAX_TRACKS =~ ^[0-9]{1,6}$ ]] || { ((10#$MAX_TRACKS != 0)) && ((10#$MAX_TRACKS < 100 || 10#$MAX_TRACKS > 100000)); }; then
  fail "Limite de faixas inválido: $MAX_TRACKS. Use --max-tracks de 100 a 100000 (ou 0 para o padrão, 400 por processador lógico)."
fi
MAX_TRACKS=$((10#$MAX_TRACKS))
if ! [[ $CHAT_USER =~ ^[a-z_][a-z0-9_.-]{0,31}$ ]]; then fail "Usuário do chat inválido: $CHAT_USER"; fi

# A mídia chega pelos endereços deste servidor que estão em --lan-cidr; os outros (Docker, VPN) ficam de fora.
LOCAL_IPS=()
if has ip; then
  mapfile -t LOCAL_IPS < <(ip -4 -o addr show 2>/dev/null | awk '{ split($4, a, "/"); print a[1] }' | grep -Ev '^(127\.|169\.254\.)' || true)
elif has hostname; then
  mapfile -t LOCAL_IPS < <(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' | grep -Ev '^(127\.|169\.254\.)' || true)
fi
LAN_IPS=()
for ip in "${LOCAL_IPS[@]}"; do
  for c in "${LAN_CIDRS[@]}"; do
    if in_cidr "$ip" "$c"; then
      LAN_IPS+=("$ip")
      break
    fi
  done
done
if ((${#LOCAL_IPS[@]} == 0)); then
  warn 'Não consegui listar os endereços deste servidor (falta o comando ip, do pacote iproute2): não conferi --node-ip e --lan-cidr.'
else
  if [[ " ${LOCAL_IPS[*]} " != *" $NODE_IP "* ]]; then
    warn "O IP $NODE_IP não está em nenhuma placa de rede deste servidor (${LOCAL_IPS[*]}). Use o IP fixo do servidor na rede local; outro endereço só faz sentido se as filiais chegam aqui por NAT."
  fi
  if ((${#LAN_IPS[@]} == 0)); then
    fail "Nenhum endereço deste servidor (${LOCAL_IPS[*]}) está nas faixas de --lan-cidr ($LAN_TEXT): o LiveKit não teria por onde receber a mídia. Inclua a rede local do servidor."
  fi
  ok "Servidor em $NODE_IP; mídia pelas placas ${LAN_IPS[*]}; chamadas de $LAN_TEXT."
fi

# Para onde vão os webhooks: o ouvinte interno do chat (HTTPS próprio) ou a porta do chat em HTTP.
WEBHOOK_EXPLICIT=''
webhook_note=''
if [[ -n ${GIVEN[webhook-url]:-} ]]; then
  WEBHOOK_EXPLICIT=$WEBHOOK_URL
elif [[ -n ${SAVED[WEBHOOK_URL]:-} ]]; then
  WEBHOOK_URL=${SAVED[WEBHOOK_URL]}
  WEBHOOK_EXPLICIT=$WEBHOOK_URL
else
  WEBHOOK_URL=$DEFAULT_WEBHOOK_URL
  webhook_note=' (vale para o chat com HTTPS próprio; com o chat em HTTP atrás do nginx, use --webhook-url http://127.0.0.1:<porta do chat>/sfu-webhook)'
fi
if ! [[ $WEBHOOK_URL =~ ^http://127\.0\.0\.1:([1-9][0-9]{0,4})/sfu-webhook$ ]] || ((BASH_REMATCH[1] > 65535)); then
  fail "Endereço do webhook inválido: $WEBHOOK_URL. Use http://127.0.0.1:<porta>/sfu-webhook (o chat neste mesmo servidor)."
fi
ok "Webhooks para $WEBHOOK_URL$webhook_note."

# Node.js 22, só para gerar a configuração (o LiveKit não precisa dele).
if [[ -z $NODE ]]; then NODE=$(command -v node || true); fi
if [[ -z $NODE || ! -x $NODE ]]; then fail 'Não achei o node. Instale o Node.js 22 LTS (https://nodejs.org ou o pacote da distribuição) ou indique o caminho com --node.'; fi
NODE=$(readlink -f -- "$NODE")
node_version=$("$NODE" --version 2>/dev/null || true)
if ! [[ $node_version =~ ^v([0-9]+)\. ]] || ((BASH_REMATCH[1] < 22)); then fail "O instalador precisa do Node.js 22 ou mais novo; este é o ${node_version:-desconhecido} ($NODE)."; fi
ok "Node.js $node_version ($NODE)"

for f in "$VERSIONS_FILE" "$RENDER_SCRIPT" "$TEMPLATE_FILE"; do
  if [[ ! -f $f ]]; then fail "Não achei $f. Copie a pasta scripts inteira do repositório."; fi
done
pins=$("$NODE" -e '
  const p = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const v = (x) => String(x ?? "-").toLowerCase();
  process.stdout.write([v(p.livekit?.version).replace(/^v/, ""), v(p.livekit?.sha256?.linux_amd64), v(p.livekit?.exe_sha256?.linux_amd64)].join(" "));
' "$VERSIONS_FILE" 2>&1) || fail "Não consegui ler $VERSIONS_FILE: $pins"
read -r LK_VERSION LK_TGZ_HASH LK_EXE_HASH <<<"$pins"
if ! [[ $LK_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then fail "$VERSIONS_FILE não traz a versão do LiveKit."; fi
for h in "$LK_TGZ_HASH" "$LK_EXE_HASH"; do
  if ! [[ $h =~ ^[0-9a-f]{64}$ ]]; then fail "$VERSIONS_FILE não traz os SHA-256 do LiveKit para Linux."; fi
done
ok "Versão fixada: LiveKit $LK_VERSION ($VERSIONS_FILE)."

# Processadores lógicos, como o próprio LiveKit conta (400 faixas por CPU).
CORES=$(nproc 2>/dev/null || echo 1)
if ! [[ $CORES =~ ^[0-9]+$ ]] || ((CORES < 1)); then CORES=1; fi
if ((CORES > 64)); then CORES=64; fi
if ((MAX_TRACKS)); then
  tracks_text="$MAX_TRACKS faixas (--max-tracks)"
else
  tracks_text="$((400 * CORES > 8000 ? 8000 : 400 * CORES)) faixas (400 por processador lógico)"
fi
ok "Processador: $CORES processadores lógicos. Limites do LiveKit: $tracks_text e $MAX_MBPS Mbps."

WORK=$(mktemp -d "${TMPDIR:-/tmp}/wescc-livekit.XXXXXX")

# ---------- 2. Download ----------

section 'Download'

TGZ_NAME=livekit_${LK_VERSION}_linux_amd64.tar.gz
NEW_BIN=''
BIN_NEEDS_INSTALL=1
if [[ -f $BIN && $(sha256_of "$BIN") == "$LK_EXE_HASH" ]]; then
  BIN_NEEDS_INSTALL=0
  ok "LiveKit $LK_VERSION já instalado e conferido."
else
  url=https://github.com/livekit/livekit/releases/download/v$LK_VERSION/$TGZ_NAME
  src=''
  if [[ -n $OFFLINE ]]; then
    src=$OFFLINE/$TGZ_NAME
    if [[ ! -f $src ]]; then fail "Não achei $TGZ_NAME em $OFFLINE."; fi
  elif ((DRY_RUN)); then
    info "[simulação] Baixaria $url e conferiria o SHA-256."
  else
    src=$WORK/$TGZ_NAME
    info "Baixando $url"
    download "$url" "$src" || fail "Não consegui baixar o LiveKit $LK_VERSION de $url. Use --proxy <url>, ou baixe $TGZ_NAME em outro computador e rode com --offline <pasta>."
  fi
  if [[ -n $src ]]; then
    if [[ $(sha256_of "$src") != "$LK_TGZ_HASH" ]]; then fail 'O arquivo baixado não confere com o hash esperado. Nada foi instalado.'; fi
    ok "LiveKit $LK_VERSION conferido (SHA-256)."
    # O executável de dentro do pacote também é conferido, antes de ir para o lugar.
    mkdir -- "$WORK/pacote"
    tar -xzf "$src" -C "$WORK/pacote" --no-same-owner --no-same-permissions livekit-server 2>/dev/null || fail "O pacote $TGZ_NAME não traz o livekit-server."
    NEW_BIN=$WORK/pacote/livekit-server
    if [[ $(sha256_of "$NEW_BIN") != "$LK_EXE_HASH" ]]; then fail 'O arquivo baixado não confere com o hash esperado. Nada foi instalado.'; fi
    ok 'livekit-server do pacote conferido (SHA-256).'
  fi
fi

# ---------- 3. Portas ----------

section 'Portas'

OUR_PID=$(service_pid)
if [[ -r /proc/sys/net/ipv4/ip_local_port_range ]]; then
  read -r dyn_first dyn_last </proc/sys/net/ipv4/ip_local_port_range || true
  if [[ ${dyn_first:-} =~ ^[0-9]+$ && ${dyn_last:-} =~ ^[0-9]+$ ]] && ((UDP_LAST >= dyn_first && API_PORT <= dyn_last)); then
    warn "As portas $API_PORT a $UDP_LAST estão na faixa de portas dinâmicas ($dyn_first-$dyn_last): o sistema pode entregá-las a outro programa. Reserve-as com net.ipv4.ip_local_reserved_ports=$API_PORT-$UDP_LAST."
  fi
fi
if has ss; then
  mapfile -t tcp_listeners < <(listeners t)
  for p in "$API_PORT" "$TCP_PORT"; do
    for l in "${tcp_listeners[@]}"; do
      read -r _addr lport lpid lname <<<"$l"
      if [[ $lport == "$p" && $lpid != "${OUR_PID:-x}" ]]; then
        fail "A porta TCP $p está em uso por $(owner_text "$lpid" "$lname"). O servidor de chamadas precisa dela: pare esse programa (por exemplo um livekit-server aberto na mão) e rode de novo."
      fi
    done
    ok "Porta TCP $p disponível."
  done
  mapfile -t udp_listeners < <(listeners u)
  for l in "${udp_listeners[@]}"; do
    read -r _addr lport lpid lname <<<"$l"
    if [[ $lport =~ ^[0-9]+$ ]] && ((lport >= UDP_FIRST && lport <= UDP_LAST)) && [[ $lpid != "${OUR_PID:-x}" ]]; then
      fail "A porta UDP $lport está em uso por $(owner_text "$lpid" "$lname"). O servidor de chamadas precisa das portas UDP $UDP_FIRST a $UDP_LAST: pare esse programa e rode de novo."
    fi
  done
  ok "Portas UDP $UDP_FIRST a $UDP_LAST disponíveis."
else
  warn "Não achei o comando ss (pacote iproute2): não conferi se as portas $API_PORT a $UDP_LAST estão livres."
fi

# ---------- 4. Chaves ----------

section 'Chaves'

# Rodar de novo não troca a chave: o chat e as chamadas em andamento continuam valendo.
KEY=''
SECRET=''
read_existing_keys "$YAML_FILE"
if [[ -n $KEY ]]; then
  ok "Chave $KEY mantida (de $YAML_FILE)."
else
  if [[ -f $YAML_FILE && ! -r $YAML_FILE ]]; then
    warn "Sem permissão para ler $YAML_FILE (rode com sudo): a simulação não sabe se a chave continua a mesma."
  elif [[ -f $YAML_FILE ]]; then
    warn "Não achei a chave em $YAML_FILE: vale a do arquivo do chat, ou uma nova."
  fi
  env_key=$(env_value "$CHAT_ENV_FILE" LIVEKIT_API_KEY)
  old_secret=$(read_secret_file "$SECRET_FILE")
  if [[ $env_key =~ ^API[A-Za-z0-9]{12}$ && $old_secret =~ ^[A-Za-z0-9_-]{43}$ ]]; then
    KEY=$env_key
    SECRET=$old_secret
    ok "Chave $KEY mantida (de $CHAT_ENV_FILE e $SECRET_FILE)."
  else
    KEY=$(random_key)
    SECRET=$(random_secret)
    if ! [[ $KEY =~ ^API[A-Za-z0-9]{12}$ && $SECRET =~ ^[A-Za-z0-9_-]{43}$ ]]; then fail 'Não consegui gerar a chave e o segredo com o node.'; fi
    if ((DRY_RUN)); then
      info '[simulação] Geraria uma chave nova (API seguido de 12 letras e números) e um segredo de 32 bytes aleatórios.'
    else
      ok "Chave nova: $KEY. O segredo só vai para arquivos protegidos, nunca para a tela."
    fi
  fi
fi

# ---------- 5. Usuário e segredo ----------

section 'Usuário e segredo'

if getent passwd "$SVC_USER" >/dev/null 2>&1; then
  ok "Usuário de sistema $SVC_USER já existe."
else
  nologin=$(command -v nologin || true)
  if [[ -z $nologin ]]; then nologin=/usr/sbin/nologin; fi
  step "Criar o usuário de sistema $SVC_USER (sem login e sem pasta pessoal)" \
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell "$nologin" "$SVC_USER"
fi
if [[ ! -d $ETC_DIR ]]; then
  step "Criar $ETC_DIR (root, 0755)" install -d -o root -g root -m 0755 "$ETC_DIR"
fi
if [[ $(read_secret_file "$SECRET_FILE") == "$SECRET" ]]; then
  if ((!DRY_RUN)); then
    chown "root:$SVC_USER" "$SECRET_FILE"
    chmod 0640 "$SECRET_FILE"
  fi
  ok "Segredo já gravado em $SECRET_FILE (root:$SVC_USER, 0640)."
else
  step "Gravar o segredo em $SECRET_FILE (root:$SVC_USER, 0640)" write_secret
fi
# O chat lê o mesmo segredo para assinar os tokens e conferir os webhooks.
if [[ $CHAT_USER == root ]]; then
  ok 'O chat roda como root: já lê o segredo.'
elif getent passwd "$CHAT_USER" >/dev/null 2>&1; then
  if has setfacl; then
    step "Leitura de $SECRET_FILE para o usuário $CHAT_USER (ACL; o chat lê o segredo de lá)" setfacl -m "u:$CHAT_USER:r" "$SECRET_FILE"
  elif id -nG "$CHAT_USER" 2>/dev/null | tr ' ' '\n' | grep -qx "$SVC_USER"; then
    ok "O usuário $CHAT_USER já está no grupo $SVC_USER e lê o segredo."
  else
    step "Pôr o usuário $CHAT_USER no grupo $SVC_USER para ler o segredo (sem o setfacl, do pacote acl; reinicie o chat depois)" \
      usermod -a -G "$SVC_USER" "$CHAT_USER"
  fi
else
  info "O usuário $CHAT_USER ainda não existe: depois de criar o serviço do chat, rode este instalador de novo (ou use --chat-user <usuário>)."
fi

# ---------- 6. Configuração ----------

section 'Configuração'

render_args=(--node-ip "$NODE_IP" --lan-cidr "$LAN_LIST" --api-key "$KEY" --webhook-url "$WEBHOOK_URL" --cores "$CORES" --max-mbps "$MAX_MBPS")
if ((MAX_TRACKS)); then render_args+=(--max-tracks "$MAX_TRACKS"); fi
CONFIG_CHANGED=1
if ((DRY_RUN)); then
  # Confere os parâmetros com o próprio render-config.mjs e um segredo descartável (o de verdade não sai do arquivo).
  probe=$(mktemp "$WORK/segredo-de-teste.XXXXXX")
  random_secret >"$probe"
  render "${render_args[@]}" --secret-file "$probe" --out "$WORK/livekit.yaml"
  ok 'Configuração conferida pelo render-config.mjs.'
  step "Gravar $YAML_FILE (root:$SVC_USER, 0640: só o root e o serviço leem)" true
else
  info "-> Gerar $YAML_FILE (render-config.mjs; o segredo vem de $SECRET_FILE)"
  render "${render_args[@]}" --secret-file "$SECRET_FILE" --out "$WORK/livekit.yaml"
  if [[ -f $YAML_FILE ]] && cmp -s -- "$WORK/livekit.yaml" "$YAML_FILE"; then
    CONFIG_CHANGED=0
    chown "root:$SVC_USER" "$YAML_FILE"
    chmod 0640 "$YAML_FILE"
    ok "Configuração sem mudanças ($YAML_FILE)."
  else
    install_file "$WORK/livekit.yaml" "$YAML_FILE" root "$SVC_USER" 0640
    ok "Configuração gravada em $YAML_FILE (root:$SVC_USER, 0640)."
  fi
fi

# ---------- 7. Ligação com o chat ----------

section 'Ligação com o chat'

env_text="# Gerado por scripts/livekit/install-linux.sh. O segredo fica em $SECRET_FILE, nunca aqui.
# No serviço do chat: EnvironmentFile=$CHAT_ENV_FILE (veja o README, seção Chamadas em grupo).
LIVEKIT_URL=$LIVEKIT_URL
LIVEKIT_API_KEY=$KEY
LIVEKIT_API_SECRET_FILE=$SECRET_FILE
"
if [[ -f $CHAT_ENV_FILE && "$(cat -- "$CHAT_ENV_FILE")"$'\n' == "$env_text" ]]; then
  ok "$CHAT_ENV_FILE já está atualizado."
else
  step "Gravar $CHAT_ENV_FILE (endereço, chave e o caminho do segredo, sem o segredo)" install_text "$env_text" "$CHAT_ENV_FILE" root root 0644
fi

# ---------- 8. Serviço ----------

section 'Serviço'

unit_text="# Gerado por scripts/livekit/install-linux.sh: não edite à mão, rode o instalador de novo.
# Nenhum segredo fica aqui: a chave e o segredo estão em $YAML_FILE, que só o root e o serviço leem.
[Unit]
Description=Wescc LiveKit (servidor de chamadas em grupo do Wescc Chat, LiveKit $LK_VERSION)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
ExecStart=$BIN --config $YAML_FILE
Restart=always
RestartSec=5
# Depois de 15 s o systemd encerra o processo à força, como o WinSW no Windows.
TimeoutStopSec=15
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
# Cada participante usa vários descritores (WebSocket, UDP e TCP).
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
"
install_binary() {
  install -d -o root -g root -m 0755 "$INSTALL_DIR"
  install -o root -g root -m 0755 "$NEW_BIN" "$BIN.novo"
  if [[ $(sha256_of "$BIN.novo") != "$LK_EXE_HASH" ]]; then
    rm -f -- "$BIN.novo"
    fail 'O arquivo baixado não confere com o hash esperado. Nada foi instalado.'
  fi
  # Trocar o arquivo de uma vez funciona mesmo com o serviço rodando; ele reinicia no passo 10.
  mv -f -- "$BIN.novo" "$BIN"
}
write_unit() {
  install_text "$unit_text" "$UNIT_FILE" root root 0644
  systemctl daemon-reload
}
if ((BIN_NEEDS_INSTALL)); then
  step "Instalar o livekit-server $LK_VERSION em $INSTALL_DIR" install_binary
fi
UNIT_CHANGED=0
if [[ -f $UNIT_FILE && "$(cat -- "$UNIT_FILE")"$'\n' == "$unit_text" ]]; then
  ok "$UNIT_FILE sem mudanças."
else
  UNIT_CHANGED=1
  step "Gravar $UNIT_FILE (usuário $SVC_USER, reinício automático) e recarregar o systemd" write_unit
fi
if systemctl is-enabled --quiet "$SERVICE" 2>/dev/null; then
  ok "O serviço $SERVICE já inicia com o sistema."
else
  step "Ativar o início automático do serviço $SERVICE" systemctl enable --quiet "$SERVICE"
fi
state_text="# Escolhas do install-linux.sh (sem segredos). O que vier na linha de comando substitui estes valores.
NODE_IP=$NODE_IP
LAN_CIDR=$LAN_LIST
MAX_MBPS=$MAX_MBPS
"
if ((MAX_TRACKS)); then state_text+="MAX_TRACKS=$MAX_TRACKS"$'\n'; fi
if [[ -n $WEBHOOK_EXPLICIT ]]; then state_text+="WEBHOOK_URL=$WEBHOOK_EXPLICIT"$'\n'; fi
if [[ -n ${GIVEN[chat-user]:-} || -n ${SAVED[CHAT_USER]:-} ]]; then state_text+="CHAT_USER=$CHAT_USER"$'\n'; fi
if [[ -n ${GIVEN[node]:-} || -n ${SAVED[NODE]:-} ]]; then state_text+="NODE=$NODE"$'\n'; fi
state_text+="LIVEKIT=$LK_VERSION"$'\n'
if [[ -f $STATE_FILE && "$(cat -- "$STATE_FILE")"$'\n' == "$state_text" ]]; then
  ok "Escolhas já salvas em $STATE_FILE."
else
  step "Gravar as escolhas (sem segredos) em $STATE_FILE" install_text "$state_text" "$STATE_FILE" root root 0644
fi

# ---------- 9. Rede e firewall ----------

section 'Rede e firewall'

# Buffers de UDP: abaixo de 5 MB o LiveKit avisa "UDP receive buffer is too small for a production set-up" e
# perde pacotes com muita gente. Um valor maior já configurado fica como está.
sysctl_value() {
  local v
  v=$(sysctl -n "$1" 2>/dev/null || true)
  if [[ $v =~ ^[0-9]+$ ]]; then printf '%s' "$v"; else printf '0'; fi
}
rmem=$(sysctl_value net.core.rmem_max)
wmem=$(sysctl_value net.core.wmem_max)
want_rmem=$((rmem > UDP_BUFFER ? rmem : UDP_BUFFER))
want_wmem=$((wmem > UDP_BUFFER ? wmem : UDP_BUFFER))
sysctl_text="# Gerado por scripts/livekit/install-linux.sh. Buffers de UDP do LiveKit: abaixo de 5 MB ele avisa
# \"UDP receive buffer is too small for a production set-up\" e perde pacotes com muita gente.
net.core.rmem_max = $want_rmem
net.core.wmem_max = $want_wmem
"
apply_sysctl() {
  if ! sysctl -q -p "$SYSCTL_FILE" >/dev/null 2>&1; then
    warn "Não consegui aplicar $SYSCTL_FILE agora (contêiner?); vale a partir do próximo boot."
  fi
}
write_sysctl() {
  install_text "$sysctl_text" "$SYSCTL_FILE" root root 0644
  apply_sysctl
}
if [[ -f $SYSCTL_FILE && "$(cat -- "$SYSCTL_FILE")"$'\n' == "$sysctl_text" ]]; then
  if ((rmem < want_rmem || wmem < want_wmem)); then
    step "Aplicar $SYSCTL_FILE (buffers de UDP de $want_rmem bytes)" apply_sysctl
  else
    ok "Buffers de UDP: net.core.rmem_max=$rmem e net.core.wmem_max=$wmem."
  fi
else
  step "Gravar $SYSCTL_FILE e aplicar (buffers de UDP de $want_rmem bytes)" write_sysctl
fi

# Regras por porta, só das redes de --lan-cidr. A 7880 nunca é aberta: fica só em 127.0.0.1.
firewall=''
if has ufw && ufw status 2>/dev/null | grep -q '^Status: active'; then
  firewall=ufw
elif has firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
  firewall=firewalld
fi
if [[ -z $firewall ]]; then
  info "Não achei o ufw nem o firewalld ativos. Se houver outro firewall (nftables, iptables ou o da rede), libere UDP $UDP_FIRST-$UDP_LAST e TCP $TCP_PORT só de $LAN_TEXT; nunca a $API_PORT."
fi
if [[ -z $firewall || $firewall == ufw ]]; then
  info 'Com o ufw, libere a mídia com:'
  for c in "${LAN_CIDRS[@]}"; do
    info "  sudo ufw allow proto udp from $c to any port $UDP_FIRST:$UDP_LAST comment 'Wescc LiveKit mídia UDP'"
    info "  sudo ufw allow proto tcp from $c to any port $TCP_PORT comment 'Wescc LiveKit mídia TCP'"
  done
fi
if [[ -z $firewall || $firewall == firewalld ]]; then
  info 'Com o firewalld, libere a mídia com:'
  for c in "${LAN_CIDRS[@]}"; do
    info "  sudo firewall-cmd --permanent --add-rich-rule='rule family=\"ipv4\" source address=\"$c\" port port=\"$UDP_FIRST-$UDP_LAST\" protocol=\"udp\" accept'"
    info "  sudo firewall-cmd --permanent --add-rich-rule='rule family=\"ipv4\" source address=\"$c\" port port=\"$TCP_PORT\" protocol=\"tcp\" accept'"
  done
  info '  sudo firewall-cmd --reload'
fi

# ---------- 10. Início e teste ----------

section 'Início e teste'

RUNNING=0
if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then RUNNING=1; fi
if ((BIN_NEEDS_INSTALL || CONFIG_CHANGED || UNIT_CHANGED)); then CHANGED=1; else CHANGED=0; fi
run_service() { # start | restart
  if ! systemctl "$1" "$SERVICE"; then
    show_log
    fail "O systemd não conseguiu iniciar o serviço $SERVICE. Veja o log com journalctl -u $SERVICE -n 50."
  fi
}
if ((RUNNING && CHANGED)); then
  step "Reiniciar o serviço $SERVICE (as chamadas em andamento reconectam sozinhas)" run_service restart
elif ((!RUNNING)); then
  step "Iniciar o serviço $SERVICE" run_service start
else
  ok 'Nada mudou: o serviço continua rodando, sem interromper as chamadas.'
fi
if ((!DRY_RUN)); then
  # O processo morrer nos primeiros segundos costuma ser a configuração, o SELinux, o AppArmor ou o antivírus.
  died=0
  first_pid=''
  deadline=$((SECONDS + 6))
  while ((SECONDS < deadline)); do
    active=$(systemctl show -p ActiveState --value "$SERVICE" 2>/dev/null || true)
    sub=$(systemctl show -p SubState --value "$SERVICE" 2>/dev/null || true)
    pid=$(service_pid)
    if [[ $active != active && $active != activating ]] || [[ $sub == auto-restart || $sub == failed ]]; then
      died=1
      break
    fi
    if [[ -n $pid ]]; then
      if [[ -n $first_pid && $pid != "$first_pid" ]]; then
        died=1
        break
      fi
      first_pid=$pid
    fi
    sleep 0.5
  done
  if ((died)); then
    show_log
    fail "O serviço do LiveKit inicia e para logo em seguida. Veja o log com journalctl -u $SERVICE -n 50. Se o SELinux, o AppArmor ou o antivírus bloqueou $BIN, peça à TI para liberar pelo hash (SHA-256 em scripts/livekit/versions.json)."
  fi

  # Direto, sem proxy.
  health() {
    if has curl; then
      curl --noproxy '*' -fsS -m 3 "$LIVEKIT_URL/" 2>&1
    else
      wget --no-proxy -q -T 3 -O - "$LIVEKIT_URL/" 2>&1
    fi
  }
  healthy=0
  last_error=''
  deadline=$((SECONDS + 30))
  while ((SECONDS < deadline)); do
    if answer=$(health) && [[ ${answer//[[:space:]]/} == OK ]]; then
      healthy=1
      break
    fi
    last_error=${answer:-sem resposta}
    sleep 1
  done
  if ((!healthy)); then
    show_log
    fail "O LiveKit não respondeu em $LIVEKIT_URL em 30 s (${last_error//$'\n'/ }). Veja o log com journalctl -u $SERVICE -n 50."
  fi
  ok "O LiveKit respondeu OK em $LIVEKIT_URL."

  # Onde cada porta escuta: a API só em 127.0.0.1; a mídia nas placas da rede local.
  if has ss; then
    lk_pid=$(service_pid)
    api_addrs=() tcp_addrs=() udp_addrs=()
    mapfile -t tcp_listeners < <(listeners t)
    for l in "${tcp_listeners[@]}"; do
      read -r laddr lport lpid _lname <<<"$l"
      if [[ $lpid != "${lk_pid:-x}" ]]; then continue; fi
      if [[ $lport == "$API_PORT" && " ${api_addrs[*]} " != *" $laddr "* ]]; then api_addrs+=("$laddr"); fi
      if [[ $lport == "$TCP_PORT" && " ${tcp_addrs[*]} " != *" $laddr "* ]]; then tcp_addrs+=("$laddr"); fi
    done
    mapfile -t udp_listeners < <(listeners u)
    for l in "${udp_listeners[@]}"; do
      read -r laddr lport lpid _lname <<<"$l"
      if [[ $lpid == "${lk_pid:-x}" && $lport =~ ^[0-9]+$ ]] && ((lport >= UDP_FIRST && lport <= UDP_LAST)) && [[ " ${udp_addrs[*]} " != *" $laddr "* ]]; then udp_addrs+=("$laddr"); fi
    done
    open=()
    for a in "${api_addrs[@]}"; do
      if [[ $a != 127.0.0.1 ]]; then open+=("$a"); fi
    done
    if ((${#open[@]})); then
      warn "O LiveKit escuta a porta $API_PORT também em ${open[*]}: esta versão não respeitou bind_addresses. Não abra a $API_PORT no firewall."
    else
      ok "A API do LiveKit (TCP $API_PORT) escuta só em 127.0.0.1."
    fi
    if ((${#tcp_addrs[@]})); then ok "Mídia por TCP $TCP_PORT em ${tcp_addrs[*]}."; else warn "O LiveKit não está escutando a porta TCP $TCP_PORT (mídia quando o UDP está bloqueado). Veja o log com journalctl -u $SERVICE."; fi
    if ((${#udp_addrs[@]})); then ok "Mídia por UDP $UDP_FIRST a $UDP_LAST em ${udp_addrs[*]}."; else warn "O LiveKit não está escutando as portas UDP $UDP_FIRST a $UDP_LAST. Confira --lan-cidr e o log com journalctl -u $SERVICE."; fi
  fi
fi

# ---------- 11. Próximos passos ----------

section 'Próximos passos'
info "No serviço do chat, use EnvironmentFile=$CHAT_ENV_FILE e reinicie o chat (exemplo no README, seção Chamadas em grupo)."
info 'Depois, em Admin › Chamadas, use Testar minha conexão em um PC de cada site.'
info "Na VPN e nos firewalls das filiais, libere UDP $UDP_FIRST a $UDP_LAST e TCP $TCP_PORT até $NODE_IP."
info "SHA-256 do livekit-server, para a TI liberar (também em scripts/livekit/versions.json): $LK_EXE_HASH"
info "Log do serviço: journalctl -u $SERVICE -f. Parar e iniciar: systemctl stop $SERVICE / systemctl start $SERVICE."
info 'Para remover: sudo scripts/livekit/install-linux.sh --uninstall'
cleanup
echo
if ((DRY_RUN)); then
  printf '%sSimulação concluída: nada foi alterado.%s\n' "$C_SIM" "$C_END"
else
  printf '%sPronto: o servidor de chamadas está rodando como serviço (LiveKit %s).%s\n' "$C_OK" "$LK_VERSION" "$C_END"
fi

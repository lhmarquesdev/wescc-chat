#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

target_sha=${1:?Informe o SHA da main}
source_dir=$(realpath "${2:?Informe o checkout usado para compilar}")
root=/opt/wescchat-hml
config=/opt/wescchat-hml-config
domain=homolog-wescchat.wescctech.com.br
new_image="wescchat-hml:$target_sha"
override=''
backup_dir=''
old_image=''
swapping=false

fail() { echo "ERRO: $*" >&2; exit 1; }
[[ "$(hostname -s)" == srvtimedevhml ]] || fail 'Servidor inesperado.'
[[ "$target_sha" =~ ^[a-f0-9]{40}$ ]] || fail 'SHA inválido.'
[[ -f "$config/compose.yml" && -r "$config/wescchat.env" ]] || fail 'Configuração local ausente.'
[[ -d "$root/.git" && -d "$source_dir/.git" ]] || fail 'Checkout ausente.'
[[ "$(git -C "$source_dir" rev-parse HEAD)" == "$target_sha" ]] || fail 'Checkout diferente da revisão solicitada.'
[[ -z "$(git -C "$source_dir" status --porcelain)" ]] || fail 'Checkout de compilação possui alterações.'
[[ "$(git -C "$root" branch --show-current)" == main ]] || fail 'Checkout instalado fora da main.'
[[ -z "$(git -C "$root" status --porcelain)" ]] || fail 'Checkout instalado possui alterações.'
[[ "$(git -C "$root" remote get-url origin)" == https://github.com/lhmarquesdev/wescc-chat.git ]] || fail 'Origem inesperada.'

exec 9>"$config/deploy.lock"
flock -n 9 || fail 'Outro deploy do Wescchat está em execução.'

compose() { docker compose -f "$config/compose.yml" -f "$override" "$@"; }
set_override() { printf 'services:\n  app:\n    image: %s\n' "$1" > "$override"; }
verify_image() {
  local expected_id actual_id
  expected_id=$(docker image inspect --format '{{.Id}}' "$1") || return 1
  actual_id=$(docker inspect --format '{{.Image}}' wescchat-hml) || return 1
  [[ "$actual_id" == "$expected_id" ]] || return 1
  [[ "$(docker inspect --format '{{.State.Health.Status}}' wescchat-hml)" == healthy ]] || return 1
  curl --fail --silent --show-error --max-time 15 \
    --resolve "$domain:443:127.0.0.1" "https://$domain/health" |
    python3 -c 'import json,sys; assert json.load(sys.stdin)["ok"] is True'
}
cleanup() { [[ -z "$override" ]] || rm -f -- "$override"; }
rollback() {
  local code=${1:-1}
  trap - ERR INT TERM
  set +e
  if [[ "$swapping" == true ]]; then
    echo "Falha na publicação; restaurando $old_image." >&2
    set_override "$old_image"
    if compose up -d --no-deps --no-build --pull never --wait --wait-timeout 180 app && verify_image "$old_image"; then
      echo 'Imagem anterior restaurada. Confira as migrações antes de tentar novamente.' >&2
    else
      echo "ATENÇÃO: recuperação automática falhou. Backup do banco em $backup_dir." >&2
    fi
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'rollback $?' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM

git -C "$root" fetch --no-tags origin main
[[ "$(git -C "$root" rev-parse origin/main)" == "$target_sha" ]] || fail 'A main avançou; execute o workflow novamente para publicar a revisão atual.'
git -C "$root" merge-base --is-ancestor HEAD "$target_sha" || fail 'Atualização não é fast-forward.'

old_image=$(docker inspect --format '{{.Config.Image}}' wescchat-hml)
[[ "$old_image" =~ ^wescchat-hml:[a-f0-9]{40}$ ]] || fail 'Imagem atual inesperada.'
verify_image "$old_image" || fail 'Instância atual não está saudável.'
livekit_id=$(docker inspect --format '{{.Id}}' wescchat-hml-livekit)
[[ "$(docker inspect --format '{{.State.Health.Status}}' wescchat-hml-livekit)" == healthy ]] || fail 'LiveKit não está saudável.'
if [[ "$old_image" == "$new_image" ]]; then
  echo "A revisão $target_sha já está publicada e saudável."
  exit 0
fi

echo "Compilando $new_image; a instância atual continua atendendo."
docker build --file "$source_dir/Dockerfile.homologacao" \
  --build-arg "BUILD_VERSION=$target_sha" --tag "$new_image" "$source_dir"
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$new_image")" == "$target_sha" ]] || fail 'Imagem compilada sem a revisão esperada.'
expected_build=$(docker run --rm --network none --entrypoint node "$new_image" \
  -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync("/app/web/dist/build.json", "utf8")).id)')
[[ "$expected_build" =~ ^[a-zA-Z0-9]+$ ]] || fail 'Identificador do frontend inválido.'

backup_dir="$config/backups/$(date -u +%Y%m%dT%H%M%SZ)-${target_sha:0:12}-${GITHUB_RUN_ID:-local}-$$"
bash "$source_dir/deploy/backup-homologacao.sh" "$backup_dir"
printf '%s\n' "$old_image" > "$backup_dir/imagem-anterior.txt"
cp "$config/compose.yml" "$backup_dir/compose-anterior.yml"
git -C "$root" merge --ff-only "$target_sha"

override=$(mktemp "$config/.deploy-image.XXXXXX.yml")
set_override "$new_image"
swapping=true
compose up -d --no-deps --no-build --pull never --wait --wait-timeout 180 app
verify_image "$new_image"
actual_build=$(curl --fail --silent --show-error --max-time 15 \
  --resolve "$domain:443:127.0.0.1" "https://$domain/build.json" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
[[ "$actual_build" == "$expected_build" ]]
[[ "$(docker inspect --format '{{.Id}}' wescchat-hml-livekit)" == "$livekit_id" ]]

# Persiste só a imagem selecionada, mantendo configurações, segredos, volumes e LiveKit locais.
python3 - "$config/compose.yml" "$new_image" <<'PY'
import os, pathlib, re, sys, tempfile
path = pathlib.Path(sys.argv[1])
content, count = re.subn(r'^    image: wescchat-hml:[a-f0-9]{40}$', f'    image: {sys.argv[2]}', path.read_text(), flags=re.M)
if count != 1:
    raise SystemExit('Não foi possível persistir a imagem no Compose.')
fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.compose.')
try:
    with os.fdopen(fd, 'w') as output:
        output.write(content)
    os.chmod(temporary, path.stat().st_mode & 0o777)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
swapping=false
printf '%s\n' "$target_sha" > "$config/deployed-sha"
echo "Deploy concluído: $target_sha"
echo "Backup: $backup_dir"
echo "URL: https://$domain"

#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

backup_dir=${1:?Informe o diretório de backup}
config=/opt/wescchat-hml-config
[[ "$backup_dir" == "$config"/backups/* && ! -e "$backup_dir" ]] || {
  echo 'Diretório de backup inválido ou já existente.' >&2
  exit 1
}
mkdir -p "$backup_dir"
pg_env=$(mktemp "$config/.pg-backup.XXXXXX")
trap 'rm -f -- "$pg_env"' EXIT

# O pg_dump recebe as credenciais pelo ambiente, nunca pela linha de comando ou pelo log.
python3 - "$config/wescchat.env" "$pg_env" <<'PY'
import os, sys
from urllib.parse import urlparse, unquote
values = {}
for line in open(sys.argv[1]):
    key, sep, value = line.rstrip('\n').partition('=')
    if sep:
        values[key] = value
url = urlparse(values['DATABASE_URL'])
if unquote(url.path.lstrip('/')) != 'wescchat_hml' or unquote(url.username or '') != 'wescchat_hml':
    raise SystemExit('O backup deve acessar somente o banco da homologação do Wescchat.')
env = {
    'PGHOST': url.hostname or '', 'PGPORT': str(url.port or 5432),
    'PGUSER': unquote(url.username or ''), 'PGPASSWORD': unquote(url.password or ''),
    'PGDATABASE': 'wescchat_hml',
}
if any('\n' in value or '\r' in value for value in env.values()):
    raise SystemExit('Credencial PostgreSQL inválida.')
with open(sys.argv[2], 'w') as output:
    output.writelines(f'{key}={value}\n' for key, value in env.items())
os.chmod(sys.argv[2], 0o600)
PY

docker run --rm --network wescchat-hml-network \
  --add-host host.docker.internal:host-gateway \
  --user "$(id -u):$(id -g)" --env-file "$pg_env" \
  --mount "type=bind,source=$backup_dir,target=/backups" \
  postgres:16-alpine pg_dump --format=custom --file=/backups/wescchat.dump
test -s "$backup_dir/wescchat.dump"
docker run --rm --network none --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$backup_dir,target=/backups,readonly" \
  postgres:16-alpine pg_restore --list /backups/wescchat.dump > "$backup_dir/conteudo.txt"
sha256sum "$backup_dir/wescchat.dump" > "$backup_dir/SHA256SUMS"
echo "Backup do banco verificado: $backup_dir/wescchat.dump"

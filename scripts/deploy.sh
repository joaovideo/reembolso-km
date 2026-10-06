#!/usr/bin/env bash
# Atualização do Reembolso KM no servidor. Uso: scripts/deploy.sh [host]
# Antes de trocar os arquivos guarda a versão atual inteira em /opt/reembolso-km.prev
# (código + banco). Rollback: scripts/rollback.sh
set -euo pipefail
HOST="${1:-${REEMBOLSO_HOST:-}}"
[ -n "$HOST" ] || { echo "informe o servidor: scripts/$(basename "$0") usuario@servidor  (ou exporte REEMBOLSO_HOST)"; exit 1; }
DIR=/opt/reembolso-km
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain)" ]; then echo "árvore suja: commit antes de fazer deploy"; exit 1; fi
REV=$(git rev-parse --short HEAD)
echo "== deploy $REV → $HOST:$DIR"
git archive --format=tar HEAD | ssh "$HOST" "set -e; cd $DIR
rm -rf $DIR.prev; cp -a $DIR $DIR.prev
tar -xf - ; npm ci --omit=dev --no-audit --no-fund >/dev/null; echo $REV > VERSION; chown -R www-data:www-data $DIR
systemctl restart reembolso-km; sleep 2; systemctl is-active reembolso-km
curl -s -o /dev/null -w 'status HTTP %{http_code} (401 = no ar, pedindo senha)\n' http://127.0.0.1:3080/api/status"
echo "== ok. se algo deu errado: scripts/rollback.sh (volta código E banco de antes do deploy)"

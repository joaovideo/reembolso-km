#!/usr/bin/env bash
# ROLLBACK da instalação: remove serviço, pasta e (se foi instalado por nós) o Node.
# Guarda uma cópia do banco e do .env em /root/reembolso-km.backup-<data>/ antes de apagar.
set -euo pipefail
HOST="${1:-${REEMBOLSO_HOST:-}}"
[ -n "$HOST" ] || { echo "informe o servidor: scripts/$(basename "$0") usuario@servidor  (ou exporte REEMBOLSO_HOST)"; exit 1; }
DIR=/opt/reembolso-km
ssh "$HOST" "set -e
B=/root/reembolso-km.backup-\$(date +%Y%m%d-%H%M); mkdir -p \$B
[ -d $DIR/data ] && cp -a $DIR/data \$B/ || true
[ -f $DIR/.env ] && cp -a $DIR/.env \$B/ || true
systemctl disable --now reembolso-km 2>/dev/null || true
rm -f /etc/systemd/system/reembolso-km.service; systemctl daemon-reload
rm -rf $DIR
if [ -f /var/tmp/reembolso-km.node-instalado-por-nos ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get remove -y nodejs >/dev/null 2>&1 || true
  rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/keyrings/nodesource.gpg /var/tmp/reembolso-km.node-instalado-por-nos
  apt-get update >/dev/null 2>&1 || true
  echo 'Node removido (tinha sido instalado por nós)'
fi
echo \"desinstalado. cópia do banco e .env em \$B\""

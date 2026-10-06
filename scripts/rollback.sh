#!/usr/bin/env bash
# Volta o servidor para a versão anterior ao último deploy (código + banco), guardada em /opt/reembolso-km.prev
set -euo pipefail
HOST="${1:-${REEMBOLSO_HOST:-}}"
[ -n "$HOST" ] || { echo "informe o servidor: scripts/$(basename "$0") usuario@servidor  (ou exporte REEMBOLSO_HOST)"; exit 1; }
DIR=/opt/reembolso-km
ssh "$HOST" "set -e; [ -d $DIR.prev ] || { echo 'não há versão anterior guardada'; exit 1; }
rm -rf $DIR.falhou; mv $DIR $DIR.falhou; mv $DIR.prev $DIR
systemctl restart reembolso-km; sleep 2; systemctl is-active reembolso-km
echo \"voltou para \$(cat $DIR/VERSION). a versão com problema ficou em $DIR.falhou\""

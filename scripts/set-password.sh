#!/usr/bin/env bash
# Troca a senha de acesso (APP_PASS) no servidor. Pede a senha no terminal, sem eco.
# Uso: scripts/set-password.sh usuario@servidor   (ou exporte REEMBOLSO_HOST)
set -euo pipefail
HOST="${1:-${REEMBOLSO_HOST:-}}"
[ -n "$HOST" ] || { echo "informe o servidor: scripts/$(basename "$0") usuario@servidor  (ou exporte REEMBOLSO_HOST)"; exit 1; }
ENV=/opt/reembolso-km/.env
read -r -s -p "Nova senha (mín. 8 caracteres): " P; echo
read -r -s -p "Repita: " P2; echo
[ "$P" = "$P2" ] || { echo "as senhas não conferem"; exit 1; }
[ ${#P} -ge 8 ] || { echo "muito curta"; exit 1; }
printf '%s' "$P" | ssh "$HOST" "set -e; umask 077; P=\$(cat); { grep -v '^APP_PASS=' $ENV; printf 'APP_PASS=%s\n' \"\$P\"; } > $ENV.novo && cat $ENV.novo > $ENV && rm -f $ENV.novo && systemctl restart reembolso-km && sleep 2 && systemctl is-active reembolso-km >/dev/null && echo 'senha trocada, serviço reiniciado'"

#!/usr/bin/env bash
# Instalação inicial do Reembolso KM no servidor interno (rodar NO MAC, uma vez).
# Uso: scripts/install-server.sh usuario@servidor   (ou exporte REEMBOLSO_HOST)
# Faz: Node 22 (NodeSource) se faltar, /opt/reembolso-km, copia o .env local e acrescenta
# usuário/senha gerados, npm ci, serviço systemd na porta 3080, verificação.
# Desfazer tudo: scripts/uninstall-server.sh
set -euo pipefail
HOST="${1:-${REEMBOLSO_HOST:-}}"
[ -n "$HOST" ] || { echo "informe o servidor: scripts/$(basename "$0") usuario@servidor  (ou exporte REEMBOLSO_HOST)"; exit 1; }
DIR=/opt/reembolso-km
APP_USER="${REEMBOLSO_USER:-equipe}"
PROXY="${REEMBOLSO_PROXY:-}"   # IP do proxy reverso (HAProxy/nginx) para registrar o IP real; vazio se não houver
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "faltou o .env local com a chave do Google"; exit 1; }
if [ -n "$(git status --porcelain)" ]; then echo "árvore suja: commit antes"; exit 1; fi
REV=$(git rev-parse --short HEAD)

echo "== 1/4 Node no servidor"
ssh "$HOST" 'set -e; if ! command -v node >/dev/null || [ "$(node -p "process.versions.node.split(\".\")[0]")" -lt 22 ]; then
  export DEBIAN_FRONTEND=noninteractive
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh >/tmp/nodesource.log 2>&1
  apt-get install -y nodejs >/tmp/node-install.log 2>&1
  touch /var/tmp/reembolso-km.node-instalado-por-nos
fi; echo "node $(node --version)"'

echo "== 2/4 arquivos ($REV) e dependências"
git archive --format=tar HEAD | ssh "$HOST" "set -e; mkdir -p $DIR/data; cd $DIR; tar -xf -; echo $REV > VERSION; npm ci --omit=dev --no-audit --no-fund >/dev/null; echo deps ok"

echo "== 3/4 .env (só cria se não existir; nunca sobrescreve)"
if ssh "$HOST" "test -f $DIR/.env"; then
  echo ".env já existe no servidor, mantido"
else
  scp -q .env "$HOST:$DIR/.env"
  ssh "$HOST" "set -e; cd $DIR; sed -i '/^PORT=/d;/^APP_USER=/d;/^APP_PASS=/d;/^TRUSTED_PROXIES=/d' .env
printf 'PORT=3080\nAPP_USER=%s\nAPP_PASS=%s\nTRUSTED_PROXIES=%s\n' \"$APP_USER\" \"\$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)\" \"$PROXY\" >> .env
chmod 600 .env; echo '.env criado com usuário '$APP_USER' e senha gerada'"
fi
ssh "$HOST" "chown -R www-data:www-data $DIR"

echo "== 4/4 serviço systemd"
ssh "$HOST" "set -e; cat > /etc/systemd/system/reembolso-km.service <<UNIT
[Unit]
Description=Reembolso KM (quilometragem)
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=$DIR
EnvironmentFile=$DIR/.env
ExecStart=/usr/bin/node $DIR/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload; systemctl enable reembolso-km >/dev/null 2>&1; systemctl restart reembolso-km; sleep 2
systemctl is-active reembolso-km
echo -n 'sem senha: HTTP '; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/api/status
echo -n 'com senha: HTTP '; curl -s -o /dev/null -w '%{http_code}\n' -u \"$APP_USER:\$(grep ^APP_PASS= $DIR/.env | cut -d= -f2-)\" http://127.0.0.1:3080/api/status
journalctl -u reembolso-km -n 3 --no-pager -o cat"

echo
echo "== pronto. Acesso: http://<servidor>:3080   usuário: $APP_USER"
echo "== senha: ssh $HOST grep ^APP_PASS= $DIR/.env"
echo "== desfazer tudo: scripts/uninstall-server.sh"

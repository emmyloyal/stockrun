#!/usr/bin/env bash
# Sets up (or updates) the StockRun server on a fresh Ubuntu 24.04 Lightsail instance. Safe to run again.
# Usage on the server:  sudo bash setup-server.sh <public-hostname>     e.g. 3-90-1-2.sslip.io
# Expects the settings file at /opt/stockrun/.env (copied over SSH, never committed).
set -euo pipefail
HOST="${1:?usage: setup-server.sh <public-hostname>}"
NODE_VERSION=26.13.0
REPO=https://github.com/emmyloyal/stockrun.git
APP_DIR=/opt/stockrun
DATA_DIR=/var/lib/stockrun          # the database lives here, outside the repo, so updates never touch it

# 1 GB of RAM is tight for the app build; a swap file keeps it from running out of memory.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git caddy curl xz-utils libatomic1 >/dev/null   # Node's official build needs libatomic

if [ "$(node -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1
fi

id stockrun >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin stockrun
mkdir -p "$DATA_DIR" && chown stockrun:stockrun "$DATA_DIR" && chmod 700 "$DATA_DIR"

if [ -d "$APP_DIR/.git" ]; then
  # Run git as the app user, who owns the files (git refuses repos owned by someone else).
  sudo -u stockrun -H git -C "$APP_DIR" fetch -q origin main
  sudo -u stockrun -H git -C "$APP_DIR" reset -q --hard origin/main
else
  mkdir -p "$APP_DIR"
  tmp=$(mktemp -d) && git clone -q --branch main "$REPO" "$tmp" && cp -a "$tmp/." "$APP_DIR/"
fi
[ -f "$APP_DIR/.env" ] || { echo "Missing $APP_DIR/.env - copy the settings first."; exit 1; }
chown -R stockrun:stockrun "$APP_DIR" && chmod 600 "$APP_DIR/.env"

sudo -u stockrun -H bash -c "cd $APP_DIR/app && npm ci --no-audit --no-fund --loglevel=error && npm run build >/dev/null"
sudo -u stockrun -H bash -c "cd $APP_DIR/agent && npm ci --omit=dev --no-audit --no-fund --loglevel=error"

cat > /etc/systemd/system/stockrun.service <<EOF
[Unit]
Description=StockRun server (X Layer mainnet)
After=network-online.target
Wants=network-online.target

[Service]
User=stockrun
WorkingDirectory=$APP_DIR/agent
Environment=PORT=8080
ExecStart=/usr/local/bin/node src/server/main.ts --network=xlayer
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Caddy gets a free HTTPS certificate for the sslip.io name and forwards to the app.
cat > /etc/caddy/Caddyfile <<EOF
$HOST {
  encode gzip
  reverse_proxy 127.0.0.1:8080
}
EOF

systemctl daemon-reload
systemctl enable -q stockrun caddy
systemctl restart stockrun caddy
echo "StockRun is starting at https://$HOST"

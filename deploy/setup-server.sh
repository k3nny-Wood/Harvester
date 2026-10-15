#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu server for Harvester. Run it as root (sudo) once, after copying this folder to the server:
#   sudo bash setup-server.sh
# It installs what the program needs, creates the "harvester" user and /opt/harvester, installs the service, and installs Tailscale.
# It does not start the service: copy harvester-server, ui/dist and .env to /opt/harvester first (see deploy/README.md).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run this with sudo" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# fonts and the font library: the Telegram pictures are drawn on the server; ca-certificates: HTTPS to Binance and Telegram
apt-get install -y -qq ca-certificates curl libfontconfig1 libfreetype6 fonts-dejavu-core unattended-upgrades

id harvester >/dev/null 2>&1 || useradd --system --home-dir /opt/harvester --shell /usr/sbin/nologin harvester
mkdir -p /opt/harvester/ui /opt/harvester/Harvester
chown -R harvester:harvester /opt/harvester

install -m 0644 "$(dirname "$0")/harvester.service" /etc/systemd/system/harvester.service
systemctl daemon-reload
systemctl enable harvester.service

# Tailscale: a private network between this server and your own devices, with HTTPS addresses
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

# a little swap so a memory spike cannot kill the program on a small server
if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "setup done. Next: copy the program, the page and .env to /opt/harvester, then: sudo systemctl start harvester"

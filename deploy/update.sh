#!/usr/bin/env bash
# Build the web page and the Linux server program on this computer and install them on the AWS server, then restart it.
# Run from the repository root in Git Bash:   bash deploy/update.sh
# Needs: Docker Desktop (running), pnpm, and the SSH key of the server.
#
# Settings (environment variables, with the values of the current server as defaults):
#   HARVESTER_HOST   the server's address          (default 63.189.64.43)
#   HARVESTER_KEY    the SSH private key           (default ~/.ssh/harvester-aws.pem)
#   HARVESTER_USER   the login user on the server  (default ubuntu)
# The .env file on the server (keys, tokens) is NOT touched.
set -euo pipefail

HOST="${HARVESTER_HOST:-63.189.64.43}"
KEY="${HARVESTER_KEY:-$HOME/.ssh/harvester-aws.pem}"
USER_NAME="${HARVESTER_USER:-ubuntu}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/deploy/out"
SSH=(ssh -i "$KEY" -o BatchMode=yes "$USER_NAME@$HOST")

mkdir -p "$OUT"

echo "== 1/4 building the web page"
pnpm --dir "$ROOT/ui" build >/dev/null

echo "== 2/4 building the Linux program (Debian 11 container, so it runs on any current Ubuntu)"
if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop and run this again." >&2
  exit 1
fi
# The source is mounted read-only and the program is only BUILT here, never run: it would read the .env file next to it and start for real.
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$(cygpath -w "$ROOT"):/src:ro" -v "$(cygpath -w "$OUT"):/out" \
  -v harvester-target:/cache/target -v harvester-cargo:/usr/local/cargo/registry \
  -w /src -e CARGO_TARGET_DIR=/cache/target rust:1-bullseye \
  bash -c "apt-get update -qq && apt-get install -y -qq pkg-config libfontconfig1-dev libfreetype6-dev >/dev/null && cargo build --release --locked -p harvester-server 2>&1 | tail -3 && cp /cache/target/release/harvester-server /out/harvester-server"

echo "== 3/4 copying to $HOST"
"${SSH[@]}" "rm -rf /tmp/update && mkdir -p /tmp/update/ui"
scp -i "$KEY" -q "$OUT/harvester-server" "$USER_NAME@$HOST:/tmp/update/harvester-server"
tar czf - -C "$ROOT/ui" dist | "${SSH[@]}" "tar xzf - -C /tmp/update/ui"

echo "== 4/4 installing and restarting"
"${SSH[@]}" "set -e
sudo systemctl stop harvester
sudo install -o harvester -g harvester -m 755 /tmp/update/harvester-server /opt/harvester/harvester-server
sudo rm -rf /opt/harvester/ui/dist && sudo cp -r /tmp/update/ui/dist /opt/harvester/ui/dist && sudo chown -R harvester:harvester /opt/harvester/ui
sudo systemctl start harvester
rm -rf /tmp/update
sleep 5
systemctl is-active harvester
sudo journalctl -u harvester -n 4 --no-pager | cut -c1-150"
echo "done."

#!/usr/bin/env bash
# Local Notes team server: one-command installer for Linux.
#
#   curl -fsSL https://harshid-lgtm.github.io/local-notes/install.sh | bash
#
# Run it again any time to update; your data is kept. Options:
#   --port N        port to listen on (default 3000, or the next free one)
#   --dir PATH      where to install (default ~/local-notes-team, or /opt/local-notes-team as root)
#   --no-service    don't set up a background service (start it yourself with manage.sh start)
#   --uninstall     remove the server (asks before deleting your data)
set -euo pipefail

REPO="harshid-lgtm/local-notes"
SERVICE="${LN_SERVICE_NAME:-local-notes-team}"
PORT=""
DIR=""
SERVICE_MODE=auto
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --dir=*) DIR="${1#*=}"; shift ;;
    --no-service) SERVICE_MODE=manual; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,12p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ------------------------------------------------------------------ output helpers
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'; else B=; G=; Y=; R=; D=; N=; fi
step() { printf '%s\n' "${B}==>${N} $*"; }
ok() { printf '%s\n' "    ${G}✓${N} $*"; }
warn() { printf '%s\n' "    ${Y}!${N} $*"; }
die() { printf '\n%s\n\n' "${R}✗ $*${N}" >&2; exit 1; }
ask() { # ask "question" default -> answer (reads the keyboard even when piped from curl)
  local a=""; if (exec < /dev/tty) 2>/dev/null; then printf '%s' "$1 " > /dev/tty; read -r a < /dev/tty || true; fi; printf '%s' "${a:-$2}"
}

[ "$(uname -s)" = "Linux" ] || die "This installer is for Linux. On Windows or Mac, use the Local Notes desktop app: vault menu → Host a team server on this computer."

IS_ROOT=0; [ "$(id -u)" = 0 ] && IS_ROOT=1
if [ -z "$DIR" ]; then
  if [ $IS_ROOT = 1 ]; then DIR=/opt/local-notes-team; else DIR="$HOME/local-notes-team"; fi
fi
case "$DIR" in /*) ;; *) DIR="$(pwd)/$DIR" ;; esac

HAS_SYSTEMD=0
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then HAS_SYSTEMD=1; fi
if [ "$SERVICE_MODE" = auto ]; then
  if [ $HAS_SYSTEMD = 1 ]; then
    if [ $IS_ROOT = 1 ]; then SERVICE_MODE=system; else SERVICE_MODE=user; fi
  else
    SERVICE_MODE=manual
  fi
fi

sctl() { if [ "$SERVICE_MODE" = system ]; then systemctl "$@"; else systemctl --user "$@"; fi; }
unit_path() { if [ "$SERVICE_MODE" = system ]; then echo "/etc/systemd/system/$SERVICE.service"; else echo "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE.service"; fi; }

# ------------------------------------------------------------------ uninstall
if [ $UNINSTALL = 1 ]; then
  step "Removing the Local Notes team server from $DIR"
  if [ "$SERVICE_MODE" != manual ] && [ -f "$(unit_path)" ]; then
    sctl disable --now "$SERVICE" >/dev/null 2>&1 || true
    rm -f "$(unit_path)"; sctl daemon-reload || true
    ok "Background service removed"
  elif [ -x "$DIR/manage.sh" ]; then "$DIR/manage.sh" stop >/dev/null 2>&1 || true; fi
  DATA_DIR=$(sed -n 's/^DATA_DIR=//p' "$DIR/config.env" 2>/dev/null | tr -d '"' | head -1); DATA_DIR="${DATA_DIR:-$DIR/data}"
  rm -rf "$DIR/app" "$DIR/app.new" "$DIR/app.old" "$DIR/node" "$DIR/manage.sh" "$DIR/config.env" "$DIR/server.log" "$DIR/server.pid"
  ok "Program files removed"
  if [ -d "$DATA_DIR" ]; then
    a=$(ask "Also permanently delete all team notes in $DATA_DIR? Type DELETE to confirm, or press Enter to keep them:" "")
    if [ "$a" = "DELETE" ]; then rm -rf "$DATA_DIR"; ok "Data deleted"; else ok "Your notes are kept in $DATA_DIR"; fi
  fi
  rmdir "$DIR" 2>/dev/null || true
  echo; exit 0
fi

# ------------------------------------------------------------------ prerequisites
for t in tar sha256sum; do command -v "$t" >/dev/null 2>&1 || die "Missing '$t'. Install it with your package manager and run this again."; done
if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }; fetch_text() { curl -fsSL --retry 3 "$1"; }
elif command -v wget >/dev/null 2>&1; then fetch() { wget -q -O "$2" "$1"; }; fetch_text() { wget -q -O - "$1"; }
else die "Missing 'curl' or 'wget'. Install one with your package manager and run this again."; fi

printf '\n%s\n%s\n\n' "${B}Local Notes team server${N}" "${D}Installing to $DIR${N}"
mkdir -p "$DIR"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# Existing install? keep its port, data folder and settings.
DATA_DIR="$DIR/data"
EXTRA_ENV=""
if [ -f "$DIR/config.env" ]; then
  OLD_PORT=$(sed -n 's/^PORT=//p' "$DIR/config.env" | tr -d '"' | head -1)
  [ -z "$PORT" ] && PORT="$OLD_PORT"
  OLD_DATA=$(sed -n 's/^DATA_DIR=//p' "$DIR/config.env" | tr -d '"' | head -1)
  [ -n "$OLD_DATA" ] && DATA_DIR="$OLD_DATA"
elif [ "$SERVICE_MODE" != manual ] && [ -f "$(unit_path)" ]; then
  # an older hand-made service with the same name: carry its settings over
  envs=$(sed -n 's/^Environment=//p' "$(unit_path)" | sed "s|%h|$HOME|g" | tr -d '"')
  OLD_PORT=$(printf '%s\n' "$envs" | sed -n 's/^PORT=//p' | head -1)
  [ -z "$PORT" ] && PORT="$OLD_PORT"
  OLD_DATA=$(printf '%s\n' "$envs" | sed -n 's/^DATA_DIR=//p' | head -1)
  [ -n "$OLD_DATA" ] && [ -f "$OLD_DATA/team.db" ] && DATA_DIR="$OLD_DATA"
  EXTRA_ENV=$(printf '%s\n' "$envs" | grep -vE '^(PORT|HOST|DATA_DIR|PUBLIC_DIR)=' | sed -E 's/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/\1="\2"/' || true)
  ok "Found an existing team server; its data and settings are kept"
fi
mkdir -p "$DATA_DIR"

# ------------------------------------------------------------------ Node.js (24, private copy if needed)
NODE_BIN=""
if command -v node >/dev/null 2>&1 && node -e "require('node:sqlite')" >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
  ok "Using Node.js $(node --version) already on this machine"
elif [ -x "$DIR/node/bin/node" ] && "$DIR/node/bin/node" -e "require('node:sqlite')" >/dev/null 2>&1; then
  NODE_BIN="$DIR/node/bin/node"
  ok "Using Node.js $("$NODE_BIN" --version) in $DIR/node"
else
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; armv7l) ARCH=armv7l ;;
    *) die "Unsupported processor: $(uname -m)" ;;
  esac
  step "Downloading Node.js 24 (only for Local Notes; nothing else on the system changes)"
  SUMS=$(fetch_text "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt") || die "Couldn't reach nodejs.org. Check the internet connection."
  FILE=$(printf '%s\n' "$SUMS" | awk '{print $2}' | grep -E "^node-v24\.[0-9.]+-linux-$ARCH\.tar\.gz$" | head -1)
  [ -n "$FILE" ] || die "No Node.js 24 download for linux-$ARCH."
  fetch "https://nodejs.org/dist/latest-v24.x/$FILE" "$TMP/$FILE" || die "Download failed."
  (cd "$TMP" && printf '%s\n' "$SUMS" | grep " $FILE\$" | sha256sum -c - >/dev/null) || die "Node.js download didn't match its checksum. Try again."
  rm -rf "$DIR/node"; mkdir -p "$DIR/node"
  tar -xzf "$TMP/$FILE" -C "$DIR/node" --strip-components=1
  NODE_BIN="$DIR/node/bin/node"
  ok "Node.js $("$NODE_BIN" --version) installed in $DIR/node (checksum verified)"
fi

# ------------------------------------------------------------------ the server
step "Downloading the Local Notes team server"
if [ -n "${LN_TARBALL:-}" ]; then
  cp "$LN_TARBALL" "$TMP/server.tar.gz"; cp "$LN_TARBALL.sha256" "$TMP/server.tar.gz.sha256"
else
  BASE="https://github.com/$REPO/releases/${LN_RELEASE:+download/$LN_RELEASE}"; [ -z "${LN_RELEASE:-}" ] && BASE="https://github.com/$REPO/releases/latest/download"
  fetch "$BASE/local-notes-team-server.tar.gz" "$TMP/server.tar.gz" || die "Couldn't download the server from GitHub. Check the internet connection."
  fetch "$BASE/local-notes-team-server.tar.gz.sha256" "$TMP/server.tar.gz.sha256" || die "Couldn't download the checksum file."
fi
WANT=$(awk '{print $1}' "$TMP/server.tar.gz.sha256"); GOT=$(sha256sum "$TMP/server.tar.gz" | awk '{print $1}')
[ "$WANT" = "$GOT" ] || die "The download didn't match its checksum. Try again."
tar -xzf "$TMP/server.tar.gz" -C "$TMP"
VERSION=$(cat "$TMP/local-notes-team-server/VERSION")
OLD_VERSION=$(cat "$DIR/app/VERSION" 2>/dev/null || true)
rm -rf "$DIR/app.new"; mv "$TMP/local-notes-team-server" "$DIR/app.new"
ok "Version $VERSION (checksum verified)"

# ------------------------------------------------------------------ port
port_free() { ! "$NODE_BIN" -e "const s=require('net').createServer();s.once('error',()=>process.exit(0));s.listen($1,'0.0.0.0',()=>s.close(()=>process.exit(1)))"; }
# Is the port taken by this same team server (an update)? Then it's fine.
RUNNING_HERE=0
if [ -n "$PORT" ] && [ "$PORT" = "${OLD_PORT:-}" ] && "$NODE_BIN" -e "fetch('http://127.0.0.1:$PORT/api/team/info').then(r=>r.json()).then(j=>process.exit(j&&'hasUsers' in j?0:1),()=>process.exit(1))" 2>/dev/null; then RUNNING_HERE=1; fi
if [ -z "$PORT" ]; then
  PORT=3000
  while ! port_free "$PORT"; do PORT=$((PORT + 1)); [ $PORT -gt 3020 ] && die "Ports 3000–3020 are all in use. Run again with --port N."; done
elif [ $RUNNING_HERE = 0 ] && ! port_free "$PORT"; then
  die "Port $PORT is already in use by another program. Run again with --port N (for example --port 3001)."
fi

# ------------------------------------------------------------------ install files
if [ "$SERVICE_MODE" != manual ] && [ -f "$(unit_path)" ]; then sctl stop "$SERVICE" >/dev/null 2>&1 || true; fi
[ -x "$DIR/manage.sh" ] && [ "$SERVICE_MODE" = manual ] && "$DIR/manage.sh" stop >/dev/null 2>&1 || true
rm -rf "$DIR/app.old"; [ -d "$DIR/app" ] && mv "$DIR/app" "$DIR/app.old"; mv "$DIR/app.new" "$DIR/app"; rm -rf "$DIR/app.old"

set_env() { # set_env KEY VALUE: update the line in config.env, or add it
  if grep -q "^$1=" "$DIR/config.env"; then
    local tmp; tmp=$(mktemp); awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k{print k"=\""v"\""; next} {print}' "$DIR/config.env" > "$tmp" && cat "$tmp" > "$DIR/config.env" && rm -f "$tmp"
  else echo "$1=\"$2\"" >> "$DIR/config.env"; fi
}
if [ ! -f "$DIR/config.env" ]; then
  {
    echo "# Local Notes team server settings. After changing, run: $DIR/manage.sh restart"
    echo "# PUBLIC_URL=https://notes.example.com   (if people reach it through a domain name)"
    [ -n "$EXTRA_ENV" ] && printf '%s\n' "$EXTRA_ENV"
  } > "$DIR/config.env"
fi
set_env PORT "$PORT"
grep -q '^HOST=' "$DIR/config.env" || set_env HOST 0.0.0.0
set_env DATA_DIR "$DATA_DIR"
set_env PUBLIC_DIR "$DIR/app/public"
set_env NODE_BIN "$NODE_BIN"
set_env SERVICE_MODE "$SERVICE_MODE"
set_env SERVICE_NAME "$SERVICE"

cat > "$DIR/manage.sh" <<'MANAGE'
#!/usr/bin/env bash
# Manage the Local Notes team server. Run without arguments for help.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a; . "$DIR/config.env"; set +a
SERVICE="${SERVICE_NAME:-local-notes-team}"
sctl() { if [ "$SERVICE_MODE" = system ]; then systemctl "$@"; else systemctl --user "$@"; fi; }
logs() { if [ "$SERVICE_MODE" = system ]; then journalctl -u "$SERVICE" "$@"; else journalctl --user -u "$SERVICE" "$@"; fi; }
addresses() { (hostname -I 2>/dev/null || true) | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -vE '^(127\.|172\.(1[7-9]|2[0-9]|3[01])\.|169\.254\.)' | sed "s|.*|http://&:$PORT|"; }
running() { "$NODE_BIN" -e "fetch('http://127.0.0.1:$PORT/api/team/info').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; }
case "${1:-help}" in
  status)
    if running; then echo "Running (port $PORT)."; addresses | sed 's/^/  Address: /'; else echo "Not running. Start it with: $0 start"; fi ;;
  start)
    if [ "$SERVICE_MODE" = manual ]; then
      running && { echo "Already running."; exit 0; }
      nohup "$NODE_BIN" "$DIR/app/server.mjs" >> "$DIR/server.log" 2>&1 & echo $! > "$DIR/server.pid"; sleep 2
      running && echo "Started." || { echo "Didn't start. See $DIR/server.log"; exit 1; }
    else sctl start "$SERVICE" && echo "Started."; fi ;;
  stop)
    if [ "$SERVICE_MODE" = manual ]; then [ -f "$DIR/server.pid" ] && kill "$(cat "$DIR/server.pid")" 2>/dev/null; rm -f "$DIR/server.pid"; echo "Stopped."
    else sctl stop "$SERVICE" && echo "Stopped."; fi ;;
  restart) "$0" stop >/dev/null || true; "$0" start ;;
  logs) if [ "$SERVICE_MODE" = manual ]; then tail -n 80 "$DIR/server.log"; else logs -n 80 --no-pager; fi ;;
  address) addresses ;;
  reset-password)
    [ -n "${2:-}" ] || { echo "Usage: $0 reset-password you@example.com"; exit 1; }
    "$NODE_BIN" "$DIR/app/reset-password.mjs" "$2" ;;
  backup)
    f="$DIR/backup-$(date +%Y-%m-%d-%H%M).db"
    "$NODE_BIN" -e "new (require('node:sqlite').DatabaseSync)(process.argv[1]).exec(\"VACUUM INTO '\" + process.argv[2].replace(/'/g, \"''\") + \"'\")" "$DATA_DIR/team.db" "$f"
    echo "Saved $f"; echo "Copy it, and the folder $DATA_DIR/vault, somewhere safe (another disk, a NAS or cloud storage)." ;;
  update) curl -fsSL https://harshid-lgtm.github.io/local-notes/install.sh | bash -s -- --dir "$DIR" ;;
  uninstall) curl -fsSL https://harshid-lgtm.github.io/local-notes/install.sh | bash -s -- --dir "$DIR" --uninstall ;;
  *) cat <<HELP
Local Notes team server ($DIR)
  $0 status                  Is it running, and at which address
  $0 start | stop | restart
  $0 logs                    Recent log lines
  $0 reset-password EMAIL    Choose a new password for someone
  $0 backup                  Save a copy of the database
  $0 update                  Install the latest version (keeps your data)
  $0 uninstall               Remove it (asks before deleting data)
Settings: $DIR/config.env
HELP
  ;;
esac
MANAGE
chmod +x "$DIR/manage.sh"

if [ $IS_ROOT = 1 ] && [ "$SERVICE_MODE" = system ]; then
  id localnotes >/dev/null 2>&1 || useradd --system --home-dir "$DIR" --shell /usr/sbin/nologin localnotes 2>/dev/null || true
  chown -R localnotes: "$DATA_DIR" 2>/dev/null || true
fi

# ------------------------------------------------------------------ background service
if [ "$SERVICE_MODE" != manual ]; then
  step "Setting it up to run in the background and start with the computer"
  mkdir -p "$(dirname "$(unit_path)")"
  {
    echo "[Unit]"
    echo "Description=Local Notes team server"
    echo "After=network-online.target"
    echo "Wants=network-online.target"
    echo
    echo "[Service]"
    echo "EnvironmentFile=$DIR/config.env"
    echo "ExecStart=$NODE_BIN $DIR/app/server.mjs"
    echo "Restart=on-failure"
    echo "RestartSec=3"
    [ "$SERVICE_MODE" = system ] && id localnotes >/dev/null 2>&1 && echo "User=localnotes"
    echo
    echo "[Install]"
    if [ "$SERVICE_MODE" = system ]; then echo "WantedBy=multi-user.target"; else echo "WantedBy=default.target"; fi
  } > "$(unit_path)"
  sctl daemon-reload
  sctl enable "$SERVICE" >/dev/null 2>&1
  sctl restart "$SERVICE"
  ok "Service '$SERVICE' enabled"
  if [ "$SERVICE_MODE" = user ] && [ -z "${LN_SERVICE_NAME:-}" ]; then  # (LN_SERVICE_NAME is only set by tests)
    if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = yes ]; then ok "Keeps running after you log out"
    elif loginctl enable-linger "$USER" >/dev/null 2>&1 || sudo -n loginctl enable-linger "$USER" >/dev/null 2>&1; then ok "Keeps running after you log out"
    else warn "To keep it running after you log out, run once: ${B}sudo loginctl enable-linger $USER${N}"; fi
  fi
else
  step "Starting the server"
  "$DIR/manage.sh" start >/dev/null || true
  [ $HAS_SYSTEMD = 0 ] && warn "No systemd here, so it won't start automatically after a reboot. Start it with: $DIR/manage.sh start"
fi

# ------------------------------------------------------------------ check it's up
up=0
for _ in $(seq 1 40); do
  if INFO=$("$NODE_BIN" -e "fetch('http://127.0.0.1:$PORT/api/team/info').then(r=>r.json()).then(j=>{console.log(JSON.stringify(j))},()=>process.exit(1))" 2>/dev/null); then up=1; break; fi
  sleep 0.5
done
[ $up = 1 ] || die "The server didn't start. See the log with: $DIR/manage.sh logs"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  if ufw allow "$PORT/tcp" >/dev/null 2>&1 || sudo -n ufw allow "$PORT/tcp" >/dev/null 2>&1; then ok "Firewall opened for port $PORT"
  else warn "The firewall is on. Let teammates in with: ${B}sudo ufw allow $PORT/tcp${N}"; fi
fi

ADDRS=$("$DIR/manage.sh" address || true)
FIRST=$(printf '%s\n' "$ADDRS" | head -1); [ -z "$FIRST" ] && FIRST="http://$(hostname):$PORT"
echo
if printf '%s' "$INFO" | grep -q '"needsSetup":true'; then
  printf '%s\n\n' "${G}${B}✓ Your Local Notes team server is running.${N}"
  printf '%s\n\n' "  Next: open ${B}$FIRST${N} in a web browser and follow the 3 setup steps."
else
  if [ -n "$OLD_VERSION" ] && [ "$OLD_VERSION" != "$VERSION" ]; then printf '%s\n\n' "${G}${B}✓ Updated from $OLD_VERSION to $VERSION.${N} Your notes and accounts are unchanged."
  else printf '%s\n\n' "${G}${B}✓ Local Notes team server $VERSION is running.${N}"; fi
  printf '%s\n\n' "  Address: ${B}$FIRST${N}"
fi
printf '%s\n' "  Teammates open that address in a browser, or in the Local Notes app choose"
printf '%s\n\n' "  ${B}Connect to a team server${N} and paste it."
printf '%s\n' "  ${D}Manage it:  $DIR/manage.sh   (status, logs, backup, update, reset-password)${N}"
printf '%s\n\n' "  ${D}Your data:  $DATA_DIR${N}"

#!/usr/bin/env bash
# Patchbay Gateway native installer (no containers).
#
#   curl -fsSL https://raw.githubusercontent.com/EvilBob01/patchbay-gateway/main/scripts/install.sh | sudo bash
#   curl -fsSL .../install.sh | sudo bash -s -- --version v1.1.0 --port 3663
#   sudo bash install.sh --uninstall
#
# What it does, in order (it prints this plan and asks before changing anything):
#   1. Installs git, curl, build tools and Node.js (the version package.json's
#      "engines" asks for) from the distro; when the distro's Node is too old,
#      from the NodeSource apt repository (Debian/Ubuntu) or a newer nodejs
#      module stream (RHEL family). Needs systemd as the running init.
#   2. Creates the system user "patchbay" (home /var/lib/patchbay).
#   3. Clones the GitHub repository at a release tag (default: the newest stable
#      vX.Y.Z tag) into a staging directory, runs `npm ci` (which also builds),
#      then swaps it into /opt/patchbay-gateway. The previous version is kept as
#      /opt/patchbay-gateway.previous, with its systemd unit as
#      /opt/patchbay-gateway.previous.service.
#   4. On first install only: writes /etc/patchbay-gateway.env from
#      deploy/patchbay-gateway.env.example with a generated admin password,
#      session secret and client token, and an empty backend list.
#   5. Installs deploy/patchbay-gateway.service, (re)starts it and prints the
#      admin URL. Generated credentials are printed once, at the end.
#
# Re-running upgrades in place (to the latest release, or --version) and keeps
# the env file and everything in /var/lib/patchbay. Read docs/install.md for
# how to check this script before running it.
set -euo pipefail

REPO_URL="https://github.com/EvilBob01/patchbay-gateway.git"
VERSION=""              # release tag; empty = newest stable vX.Y.Z tag
PREFIX="/opt/patchbay-gateway"
SERVICE_USER="patchbay"
DATA_DIR="/var/lib/patchbay"
ENV_FILE="/etc/patchbay-gateway.env"
UNIT_FILE="/etc/systemd/system/patchbay-gateway.service"
SERVICE="patchbay-gateway"
PORT=""                 # first install only; default 3663
NODE_FALLBACK_MAJOR=22  # NodeSource line used when the distro's Node is too old
ASSUME_YES=0
NO_START=0
ACTION="install"
PURGE=0
SOURCE_TARBALL=""       # developer option: install from a local source tarball
# How long to wait for the gateway after a restart. It starts listening only
# after it has connected its backends one by one, so a large configuration takes
# a while (23 backends: about 40 s). Override with PATCHBAY_READY_TIMEOUT.
READY_TIMEOUT="${PATCHBAY_READY_TIMEOUT:-180}"
MARKER=".patchbay-installer"

usage() {
  cat <<EOF
Usage: install.sh [options]

  --version <tag>      Release tag to install (default: the newest stable vX.Y.Z
                       tag; prereleases such as v1.1.0-rc1 need an explicit --version).
  --port <n>           Port for a first install (default 3663). Ignored on upgrade;
                       edit PORT in $ENV_FILE instead.
  --repo <git url>     Repository to clone (default $REPO_URL).
  --prefix <dir>       Install directory (default $PREFIX).
  --yes, -y            Do not ask for confirmation.
  --no-start           Install everything but do not start the service.
  --uninstall          Stop and remove the service and $PREFIX. Keeps
                       $ENV_FILE, $DATA_DIR, the audit log and the
                       "$SERVICE_USER" user.
  --purge              With --uninstall, also remove those (all config, users and
                       tokens, the audit log).
  --from-tarball <f>   Install from a local source tarball instead of cloning
                       (for testing unreleased code).
  -h, --help           Show this help.
EOF
}

# ---- output helpers -------------------------------------------------------
if [ -t 1 ]; then BOLD=$'\e[1m'; DIM=$'\e[2m'; RED=$'\e[31m'; GREEN=$'\e[32m'; RESET=$'\e[0m'
else BOLD=""; DIM=""; RED=""; GREEN=""; RESET=""; fi
say()  { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
# Print a command, then run it.
run()  { printf '    %s$ %s%s\n' "$DIM" "$*" "$RESET"; "$@"; }

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  # Under `curl | bash` stdin is the script itself, so ask on the terminal.
  if ! (: </dev/tty) 2>/dev/null; then
    die "no terminal to ask for confirmation; re-run with --yes to proceed"
  fi
  printf '%s [y/N] ' "$1" >/dev/tty
  local answer; read -r answer </dev/tty || answer=""
  case "$answer" in y|Y|yes|YES) return 0 ;; *) die "aborted, nothing changed" ;; esac
}

# ---- arguments ------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a tag}"; shift 2 ;;
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --repo) REPO_URL="${2:?--repo needs a URL}"; shift 2 ;;
    --prefix) PREFIX="${2:?--prefix needs a directory}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    --purge) PURGE=1; shift ;;
    --from-tarball) SOURCE_TARBALL="${2:?--from-tarball needs a file}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[ -n "$PORT" ] && { [[ "$PORT" =~ ^[0-9]{1,5}$ ]] || die "--port must be a number"; }
# Print $1 as decimal seconds (1-9999), or fail. Zero padding is decimal: bash
# arithmetic would read "08" as a bad octal number, and "010" as 8.
ready_timeout_seconds() {
  [[ "$1" =~ ^[0-9]{1,4}$ ]] || return 1
  local n=$((10#$1))
  [ "$n" -ge 1 ] || return 1
  echo "$n"
}
READY_TIMEOUT="$(ready_timeout_seconds "$READY_TIMEOUT")" || die "PATCHBAY_READY_TIMEOUT must be a number of seconds (1-9999)"
[ "$PURGE" = 1 ] && [ "$ACTION" != uninstall ] && die "--purge only goes with --uninstall"
[ "$(id -u)" = 0 ] || die "run as root (e.g. curl ... | sudo bash)"
# systemd must be the running init, not just installed. Checked before anything
# changes, so a system without it is refused with nothing left behind.
if ! command -v systemctl >/dev/null || [ ! -d /run/systemd/system ]; then
  die "systemd is not running here (PID 1 is '$(cat /proc/1/comm 2>/dev/null || echo unknown)'). This installer sets Patchbay up as a systemd service, so it stopped without changing anything. Without systemd, install by hand (docs/install.md, Manual install) and start build/sse.js from your init system, or try it with npx."
fi
[ -n "$SOURCE_TARBALL" ] && SOURCE_TARBALL="$(readlink -f "$SOURCE_TARBALL")"
PREFIX="${PREFIX%/}"

# ---- uninstall ------------------------------------------------------------
if [ "$ACTION" = uninstall ]; then
  say "Patchbay Gateway uninstall. This will:"
  info "stop and disable $SERVICE, remove $UNIT_FILE"
  info "remove $PREFIX, $PREFIX.previous and $PREFIX.previous.service"
  if [ "$PURGE" = 1 ]; then
    info "PURGE: remove $ENV_FILE, $DATA_DIR (config, users, tokens), /var/log/patchbay-gateway and the user $SERVICE_USER"
  else
    info "keep $ENV_FILE, $DATA_DIR, /var/log/patchbay-gateway and the user $SERVICE_USER (add --purge to remove them)"
  fi
  info "leave Node.js and other packages installed"
  if [ -d "$PREFIX" ] && [ ! -f "$PREFIX/$MARKER" ]; then
    die "$PREFIX was not installed by this script; remove it by hand"
  fi
  confirm "Continue?"
  if systemctl list-unit-files "$SERVICE.service" >/dev/null 2>&1; then
    run systemctl disable --now "$SERVICE" || true
  fi
  [ -f "$UNIT_FILE" ] && run rm -f "$UNIT_FILE"
  run systemctl daemon-reload
  run rm -rf "$PREFIX" "$PREFIX.previous" "$PREFIX.previous.service"
  if [ "$PURGE" = 1 ]; then
    run rm -f "$ENV_FILE"
    run rm -rf "$DATA_DIR" /var/log/patchbay-gateway
    if id "$SERVICE_USER" >/dev/null 2>&1; then run userdel "$SERVICE_USER"; fi
  fi
  say "${GREEN}Uninstalled.${RESET}"
  exit 0
fi

# ---- install / upgrade: work out the plan ---------------------------------
[ -r /etc/os-release ] || die "cannot read /etc/os-release"
# Read in a subshell: os-release defines VERSION, which would clobber ours.
# shellcheck source=/dev/null
OS_ID="$(. /etc/os-release && echo "${ID:-}")"
# shellcheck source=/dev/null
OS_LIKE="$(. /etc/os-release && echo "${ID_LIKE:-}")"
case " $OS_ID $OS_LIKE " in
  *" debian "*|*" ubuntu "*) PKG=apt ;;
  *" fedora "*|*" rhel "*|*" centos "*) PKG=dnf ;;
  *) die "unsupported distribution '${OS_ID:-unknown}': this script knows Debian/Ubuntu and the RHEL family (AlmaLinux 9 tested; Fedora and other RHEL-likes best-effort). See docs/install.md for a manual install." ;;
esac

UPGRADE=0
if [ -d "$PREFIX" ]; then
  [ -f "$PREFIX/$MARKER" ] || die "$PREFIX exists but was not installed by this script; refusing to touch it (see docs/install.md, Upgrading)"
  UPGRADE=1
fi

if [ -n "$SOURCE_TARBALL" ]; then
  [ -f "$SOURCE_TARBALL" ] || die "no such file: $SOURCE_TARBALL"
  SOURCE_DESC="local tarball $SOURCE_TARBALL"
else
  SOURCE_DESC="$REPO_URL at ${VERSION:-the newest release tag}"
fi

say "Patchbay Gateway installer. This will:"
info "install packages with $PKG: git, curl, ca-certificates, build tools, python3, and Node.js if needed"
info "create the system user '$SERVICE_USER' (home $DATA_DIR) if it does not exist"
info "fetch $SOURCE_DESC, run 'npm ci' (builds too) and put it in $PREFIX"
if [ "$UPGRADE" = 1 ]; then
  info "UPGRADE: the current $PREFIX becomes $PREFIX.previous (its systemd unit is saved as $PREFIX.previous.service); $ENV_FILE and $DATA_DIR are kept"
  [ -n "$PORT" ] && info "(--port is ignored on upgrade; change PORT in $ENV_FILE instead)"
else
  info "write $ENV_FILE with a generated admin password, session secret and client token"
  info "create $DATA_DIR/config/mcp_server.json with no backends"
fi
info "install $UNIT_FILE and $([ "$NO_START" = 1 ] && echo "enable" || echo "start") the '$SERVICE' service"
confirm "Continue?"

# ---- 1. packages and Node.js ----------------------------------------------
say "Installing packages"
if [ "$PKG" = apt ]; then
  export DEBIAN_FRONTEND=noninteractive
  run apt-get update -q
  run apt-get install -y -q git curl ca-certificates gnupg build-essential python3
else
  # No curl here: minimal images ship curl-minimal, which conflicts with curl.
  run dnf install -y -q git tar ca-certificates gcc-c++ make python3
fi

WORK="$(mktemp -d /tmp/patchbay-install.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/src"

say "Fetching the source"
if [ -n "$SOURCE_TARBALL" ]; then
  mkdir -p "$STAGE"
  run tar -xzf "$SOURCE_TARBALL" -C "$STAGE" --strip-components=1 --no-same-owner --no-same-permissions
  VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/v\1/p' "$STAGE/package.json" | head -n1)-local"
else
  if [ -z "$VERSION" ]; then
    # Stable tags only (vX.Y.Z): a prerelease such as v1.1.0-rc1 is never picked
    # by default; ask for it with --version.
    VERSION="$(git ls-remote --tags --refs "$REPO_URL" 'v*' | sed 's#.*refs/tags/##'       | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n1 || true)"
    [ -n "$VERSION" ] || die "no stable release tag (vX.Y.Z) found in $REPO_URL; pass --version"
    info "newest stable release: $VERSION"
  fi
  run git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$VERSION" "$REPO_URL" "$STAGE"
fi

# This installer needs PATCHBAY_CONFIG_DIR support (config outside the code).
grep -q PATCHBAY_CONFIG_DIR "$STAGE/src/paths.ts" 2>/dev/null \
  || die "$VERSION predates this installer (no PATCHBAY_CONFIG_DIR support); pick a newer --version"

NODE_MAJOR_REQUIRED="$(sed -n 's/^ *"node": *">= *\([0-9]*\).*/\1/p' "$STAGE/package.json" | head -n1)"
NODE_MAJOR_REQUIRED="${NODE_MAJOR_REQUIRED:-20}"

node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

say "Checking Node.js (need $NODE_MAJOR_REQUIRED or newer)"
if [ "$(node_major)" -ge "$NODE_MAJOR_REQUIRED" ]; then
  info "found node $(node --version) at $(command -v node)"
elif [ "$PKG" = apt ]; then
  CANDIDATE="$(apt-cache policy nodejs 2>/dev/null | sed -n 's/^ *Candidate: *\([0-9]*:\)\{0,1\}\([0-9]*\).*/\2/p')"
  if [ -n "$CANDIDATE" ] && [ "$CANDIDATE" -ge "$NODE_MAJOR_REQUIRED" ] 2>/dev/null; then
    info "the distro's nodejs ($CANDIDATE) is new enough"
    run apt-get install -y -q --no-install-recommends nodejs npm
  else
    MAJOR=$(( NODE_MAJOR_REQUIRED > NODE_FALLBACK_MAJOR ? NODE_MAJOR_REQUIRED : NODE_FALLBACK_MAJOR ))
    info "the distro's nodejs (${CANDIDATE:-none}) is too old; adding the NodeSource repository for Node $MAJOR"
    run install -d -m 0755 /etc/apt/keyrings
    run sh -c "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg"
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$MAJOR.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    info "wrote /etc/apt/sources.list.d/nodesource.list"
    run apt-get update -q
    run apt-get install -y -q nodejs
  fi
else
  # The default nodejs can be too old (EL9 AppStream: 16); EL8/9 offer newer
  # majors as module streams. Prefer the NodeSource fallback major, else the
  # lowest stream that is new enough.
  CANDIDATE="$(dnf -q repoquery --latest-limit 1 --qf '%{version}\n' nodejs 2>/dev/null | head -n1 | cut -d. -f1)"
  if [ -n "$CANDIDATE" ] && [ "$CANDIDATE" -ge "$NODE_MAJOR_REQUIRED" ] 2>/dev/null; then
    info "the distro's nodejs ($CANDIDATE) is new enough"
  else
    MAJOR=$(( NODE_MAJOR_REQUIRED > NODE_FALLBACK_MAJOR ? NODE_MAJOR_REQUIRED : NODE_FALLBACK_MAJOR ))
    STREAMS="$(dnf -q module list nodejs 2>/dev/null | awk '$1 == "nodejs" && $2 ~ /^[0-9]+$/ { print $2 }' | sort -n -u)"
    if echo "$STREAMS" | grep -qx "$MAJOR"; then STREAM="$MAJOR"
    else STREAM="$(echo "$STREAMS" | awk -v r="$NODE_MAJOR_REQUIRED" '$1 >= r' | head -n1)"; fi
    [ -n "$STREAM" ] || die "the distro's nodejs (${CANDIDATE:-none}) is too old and there is no nodejs module stream $NODE_MAJOR_REQUIRED+; install Node.js $NODE_MAJOR_REQUIRED+ yourself and re-run"
    info "the distro's default nodejs (${CANDIDATE:-none}) is too old; enabling the nodejs:$STREAM module stream"
    run dnf module reset -y -q nodejs
    run dnf module enable -y -q "nodejs:$STREAM"
  fi
  run dnf install -y -q nodejs npm
fi
[ "$(node_major)" -ge "$NODE_MAJOR_REQUIRED" ] || die "Node.js $NODE_MAJOR_REQUIRED+ is still not available (found $(node --version 2>/dev/null || echo none)); install it and re-run"
NODE_BIN="$(command -v node)"

# ---- 2. service user --------------------------------------------------------
say "Service user"
if id "$SERVICE_USER" >/dev/null 2>&1; then
  info "user $SERVICE_USER exists"
else
  run useradd --system --create-home --home-dir "$DATA_DIR" --shell /bin/bash "$SERVICE_USER"
fi
run install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR" "$DATA_DIR/config" "$DATA_DIR/tools"

# ---- 3. build and swap into place -------------------------------------------
say "Building $VERSION (npm ci, as $SERVICE_USER)"
# The build runs as the unprivileged service user, so no dependency install
# script runs as root. npm runs the TypeScript build via "prepare". Once built,
# the code is handed to root: the service only reads it.
run chmod 0755 "$WORK"
run chown -R "$SERVICE_USER:$SERVICE_USER" "$STAGE"
as_service() { run runuser -u "$SERVICE_USER" -- env HOME="$DATA_DIR" "$@"; }
( cd "$STAGE" && as_service npm ci --no-audit --no-fund )
[ -f "$STAGE/build/sse.js" ] || die "build failed: $STAGE/build/sse.js is missing"
( cd "$STAGE" && runuser -u "$SERVICE_USER" -- git rev-parse --short HEAD 2>/dev/null || true ) > "$STAGE/$MARKER.commit"
echo "$VERSION" > "$STAGE/$MARKER"

if [ "$UPGRADE" = 1 ]; then
  say "Replacing $PREFIX (previous version kept as $PREFIX.previous)"
  run rm -rf "$PREFIX.previous" "$PREFIX.previous.service"
  run mv "$PREFIX" "$PREFIX.previous"
  # Keep the unit that matches the previous tree, so a rollback restores both.
  if [ -f "$UNIT_FILE" ]; then run cp -p "$UNIT_FILE" "$PREFIX.previous.service"; fi
fi
run mkdir -p "$(dirname "$PREFIX")"
run mv "$STAGE" "$PREFIX"
run chown -R root:root "$PREFIX"
run chmod -R go-w "$PREFIX"

# ---- 4. env file and config (first install only) ----------------------------
GENERATED=0
if [ -f "$ENV_FILE" ]; then
  say "Keeping $ENV_FILE"
else
  say "Writing $ENV_FILE"
  secret() { head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
  ADMIN_PASSWORD="$(secret 24)"
  SESSION_SECRET="$(secret 48)"
  CLIENT_TOKEN="$(secret 40)"
  # Assemble in a root-only temp file and move it into place only once it is
  # complete, so a failed run never leaves a half-written env file behind.
  ENV_TMP="$WORK/patchbay-gateway.env"
  ( umask 077
    sed -e 's/\r$//' -e "s|^PORT=.*|PORT=${PORT:-3663}|" \
        -e "s|^ADMIN_PASSWORD=REPLACE_ME|ADMIN_PASSWORD=$ADMIN_PASSWORD|" \
        -e "s|^SESSION_SECRET=REPLACE_ME|SESSION_SECRET=$SESSION_SECRET|" \
        -e "s|^ALLOWED_TOKENS=REPLACE_ME|ALLOWED_TOKENS=$CLIENT_TOKEN|" \
        -e "s|^ALLOWED_KEYS=REPLACE_ME|ALLOWED_KEYS=$CLIENT_TOKEN|" \
        "$PREFIX/deploy/patchbay-gateway.env.example"
    cat <<EOT

# Added by scripts/install.sh: runtime state lives outside the code directory,
# so upgrades can replace $PREFIX wholesale.
PATCHBAY_CONFIG_DIR=$DATA_DIR/config
TOOLS_FOLDER=$DATA_DIR/tools
INSTALLER_BASE_DIR=$DATA_DIR/installer-base
MAIL_ACCOUNTS_PLAINTEXT_PATH=$DATA_DIR/mail-accounts.json
EOT
  ) > "$ENV_TMP"
  if grep -q "^[A-Z_]*=REPLACE_ME" "$ENV_TMP"; then die "the env example still has a REPLACE_ME this script does not fill; please report this"; fi
  run install -m 600 -o root -g root "$ENV_TMP" "$ENV_FILE"
  GENERATED=1
fi
if [ ! -f "$DATA_DIR/config/mcp_server.json" ]; then
  echo '{ "mcpServers": {} }' > "$DATA_DIR/config/mcp_server.json"
  chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR/config/mcp_server.json"
  chmod 600 "$DATA_DIR/config/mcp_server.json"
  info "created $DATA_DIR/config/mcp_server.json (no backends yet)"
fi

# ---- 5. systemd -------------------------------------------------------------
say "Installing $UNIT_FILE"
sed -e "s|/opt/patchbay-gateway|$PREFIX|g" \
    -e "s|/var/lib/patchbay|$DATA_DIR|g" \
    -e "s|^User=.*|User=$SERVICE_USER|" -e "s|^Group=.*|Group=$SERVICE_USER|" \
    -e "s|^ExecStart=/usr/bin/node |ExecStart=$NODE_BIN |" \
    "$PREFIX/deploy/patchbay-gateway.service" > "$UNIT_FILE"
# SELinux: the code was moved here from /tmp and keeps its tmp label; relabel
# everything this script wrote to the policy defaults.
if command -v selinuxenabled >/dev/null && selinuxenabled && command -v restorecon >/dev/null; then
  run restorecon -R "$PREFIX" "$ENV_FILE" "$UNIT_FILE" "$DATA_DIR"
fi
run systemctl daemon-reload

env_value() { sed -n "s/^$1=\(.*\)$/\1/p" "$ENV_FILE" | tail -n1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" -e 's/[[:space:]]*$//'; }
PORT_NOW="$(env_value PORT | grep -E '^[0-9]+$' || true)"; PORT_NOW="${PORT_NOW:-3663}"
# Probe the address the gateway actually listens on: BIND_HOST when it names one
# address, loopback when it is unset or a wildcard.
BIND_NOW="$(env_value BIND_HOST)"
case "$BIND_NOW" in
  ""|"0.0.0.0"|"::"|"[::]"|"*") PROBE_HOST="127.0.0.1" ;;
  *:*) BIND_NOW="${BIND_NOW#[}"; BIND_NOW="${BIND_NOW%]}"; PROBE_HOST="[$BIND_NOW]" ;;
  *) PROBE_HOST="$BIND_NOW" ;;
esac
PROBE_URL="http://$PROBE_HOST:$PORT_NOW/healthz"

# Wait until $1 answers, at most $2 seconds in all: a deadline on elapsed time,
# and every curl is bounded by what is left of it, so a slow or hung /healthz
# cannot stretch the wait. Returns 0 once it answers, 1 when time is up.
wait_ready() {
  local url="$1" deadline=$((SECONDS + $2)) left
  while :; do
    left=$((deadline - SECONDS))
    [ "$left" -ge 1 ] || return 1
    curl -fs -o /dev/null --connect-timeout "$left" --max-time "$left" "$url" && return 0
    [ $((deadline - SECONDS)) -ge 1 ] || return 1
    sleep 1
  done
}
if [ "$NO_START" = 1 ]; then
  run systemctl enable "$SERVICE"
else
  run systemctl enable "$SERVICE"
  run systemctl restart "$SERVICE"
  say "Waiting up to ${READY_TIMEOUT}s for the gateway at $PROBE_URL (it listens once its backends have connected)"
  ok=0
  if wait_ready "$PROBE_URL" "$READY_TIMEOUT"; then ok=1; fi
  if [ "$ok" != 1 ]; then
    if [ "$UPGRADE" = 1 ]; then
      info "the new version did not answer; to roll back (restores the previous code and systemd unit):"
      if [ -f "$PREFIX.previous.service" ]; then
        info "  systemctl stop $SERVICE && rm -rf $PREFIX && mv $PREFIX.previous $PREFIX && cp -p $PREFIX.previous.service $UNIT_FILE && systemctl daemon-reload && systemctl start $SERVICE"
      else
        info "  systemctl stop $SERVICE && rm -rf $PREFIX && mv $PREFIX.previous $PREFIX && systemctl daemon-reload && systemctl start $SERVICE"
      fi
    fi
    die "the gateway did not answer at $PROBE_URL within ${READY_TIMEOUT}s; see: journalctl -u $SERVICE -n 50 (a configuration with many backends can need longer: re-run with PATCHBAY_READY_TIMEOUT=<seconds>)"
  fi
fi

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
say "${GREEN}Patchbay Gateway $VERSION is $([ "$UPGRADE" = 1 ] && echo upgraded || echo installed).${RESET}"
info "Admin UI:   http://${HOST_IP:-<this-host>}:$PORT_NOW/admin"
info "MCP:        http://${HOST_IP:-<this-host>}:$PORT_NOW/mcp"
info "Config:     $ENV_FILE, $DATA_DIR/config/"
info "Logs:       journalctl -u $SERVICE -f"
if [ "$GENERATED" = 1 ]; then
  echo
  say "${BOLD}Generated credentials, shown only this once${RESET} (also in $ENV_FILE, root only):"
  info "Admin login:   admin / $ADMIN_PASSWORD"
  info "Client token:  $CLIENT_TOKEN"
  info "               send as 'Authorization: Bearer <token>' or 'X-Api-Key: <token>'"
fi
echo
info "The gateway listens on all interfaces over plain HTTP. Firewall port $PORT_NOW"
info "to your private network: docs/install.md, section Firewall."
if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  info "firewalld is running: it blocks port $PORT_NOW until you open it to that network."
fi

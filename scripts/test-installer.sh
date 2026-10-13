#!/usr/bin/env bash
# End-to-end test of scripts/install.sh. Run as root on a THROWAWAY machine or
# container with systemd as PID 1 (Debian, Ubuntu or AlmaLinux): it installs
# packages, creates the "patchbay" user, writes /opt/patchbay-gateway and
# /etc/patchbay-gateway.env, and finishes by uninstalling with --purge.
#
#   sudo bash scripts/test-installer.sh path/to/source.tgz
#
# The tarball is a source archive of the checkout under test, with one top-level
# directory, e.g.:  git archive --prefix=patchbay-gateway/ -o source.tgz HEAD
# The installer script used is the one inside that tarball.
#
# Scenarios (each prints PASS or FAIL lines; the exit status is non-zero if any fail):
#   1. fresh install: service up, /healthz answers, no generated secret in the journal
#   2. upgrade with ENABLE_ADMIN_UI=false: reported as success (the B6 case)
#   3. upgrade with BIND_HOST set to the machine's own address: success, and the
#      gateway really is not listening on loopback
#   3b. upgrade of a gateway that takes 40 s to start (a slow backend): the
#      installer must wait for it instead of reporting failure after 30 s
#   4. forced-failure upgrade: the installer fails and prints a rollback command;
#      running it restores the old code AND the old systemd unit, service running
#   5. default release tag skips a prerelease (local bare repo: v1.0.0, v1.1.0-rc1)
#   6. uninstall --purge leaves nothing behind
# Installer output goes to files under $LOG_DIR with credential lines removed;
# secrets are never printed.
set -uo pipefail

TARBALL="${1:?usage: test-installer.sh <source.tgz>}"
TARBALL="$(readlink -f "$TARBALL")"
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }
[ -d /run/systemd/system ] || { echo "systemd is not the running init here" >&2; exit 2; }

LOG_DIR="$(mktemp -d /tmp/pb-installer-test.XXXXXX)"
INSTALL_DIR="$LOG_DIR/installer"
mkdir -p "$INSTALL_DIR"
tar -xzf "$TARBALL" -C "$INSTALL_DIR" --strip-components=1 --no-same-owner
INSTALLER="$INSTALL_DIR/scripts/install.sh"
[ -f "$INSTALLER" ] || { echo "no scripts/install.sh in $TARBALL" >&2; exit 2; }

PREFIX=/opt/patchbay-gateway
ENV_FILE=/etc/patchbay-gateway.env
UNIT=/etc/systemd/system/patchbay-gateway.service
FAILS=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { local what="$1"; shift; if "$@"; then pass "$what"; else fail "$what"; fi; }
scrub() { grep -viE 'Admin login|Client token|ALLOWED_|ADMIN_PASSWORD|SESSION_SECRET|Authorization: Bearer' || true; }
# Run the installer; output is kept in $LOG_DIR/<name>.log with credentials removed.
run_installer() {
  local name="$1"; shift
  bash "$INSTALLER" --yes "$@" >"$LOG_DIR/$name.raw" 2>&1; local rc=$?
  scrub <"$LOG_DIR/$name.raw" >"$LOG_DIR/$name.log"; cat "$LOG_DIR/$name.raw" | grep -E 'Admin login:|Client token:' | sed 's/.*: *//' >"$LOG_DIR/$name.secrets" || true
  rm -f "$LOG_DIR/$name.raw"
  return $rc
}
set_env() { # set_env KEY VALUE  (VALUE empty removes the key)
  sed -i "/^$1=/d" "$ENV_FILE"; [ -n "${2:-}" ] && echo "$1=$2" >>"$ENV_FILE"; return 0
}
port() { sed -n 's/^PORT=\([0-9]*\).*/\1/p' "$ENV_FILE" | tail -n1; }
wait_http() { local url="$1" i; for i in $(seq 1 40); do curl -fs -o /dev/null "$url" && return 0; sleep 1; done; return 1; }
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || true; }
SELF_IP="$(hostname -I | awk '{print $1}')"

echo "== 1. fresh install"
run_installer fresh --from-tarball "$TARBALL"; rc=$?
check "installer exits 0" test "$rc" = 0
check "service is active" systemctl is-active --quiet patchbay-gateway
check "/healthz answers {status:ok}" bash -c "curl -fs http://127.0.0.1:$(port)/healthz | grep -q '\"status\":\"ok\"'"
check "installer waited on /healthz" grep -q '/healthz' "$LOG_DIR/fresh.log"
secrets_leaked=0
while read -r secret; do
  [ -n "$secret" ] && journalctl -u patchbay-gateway --no-pager 2>/dev/null | grep -qF -- "$secret" && secrets_leaked=1
done <"$LOG_DIR/fresh.secrets"
check "no generated credential in the journal" test "$secrets_leaked" = 0
rm -f "$LOG_DIR"/*.secrets

echo "== 2. upgrade with ENABLE_ADMIN_UI=false"
set_env ENABLE_ADMIN_UI false
run_installer upgrade-noadmin --from-tarball "$TARBALL"; rc=$?
check "installer exits 0" test "$rc" = 0
check "service is active" systemctl is-active --quiet patchbay-gateway
check "/admin/info is absent (admin really is off)" test "$(http_code "http://127.0.0.1:$(port)/admin/info")" = 404
check "/healthz answers" wait_http "http://127.0.0.1:$(port)/healthz"
check "previous code and unit were kept" bash -c "[ -d $PREFIX.previous ] && [ -f $PREFIX.previous.service ]"
set_env ENABLE_ADMIN_UI ""

echo "== 3. upgrade with BIND_HOST=$SELF_IP"
set_env BIND_HOST "$SELF_IP"
run_installer upgrade-bind --from-tarball "$TARBALL"; rc=$?
check "installer exits 0" test "$rc" = 0
check "installer probed the bind address" grep -q "http://$SELF_IP:$(port)/healthz" "$LOG_DIR/upgrade-bind.log"
check "/healthz answers on $SELF_IP" wait_http "http://$SELF_IP:$(port)/healthz"
check "loopback is not listening" test "$(http_code "http://127.0.0.1:$(port)/healthz")" = 000
set_env BIND_HOST ""
systemctl restart patchbay-gateway; wait_http "http://127.0.0.1:$(port)/healthz" || true

echo "== 3b. upgrade of a slow-starting gateway"
CONF=/var/lib/patchbay/config/mcp_server.json
cp -p "$CONF" "$LOG_DIR/mcp_server.json.orig"
cat >"$CONF" <<EOT
{ "mcpServers": { "slow": { "type": "stdio", "command": "/bin/sh",
  "args": ["-c", "sleep 40; exec $(command -v node) $PREFIX/test/fixtures/fake-backend.mjs --name=slow"] } } }
EOT
chown patchbay:patchbay "$CONF"
run_installer upgrade-slow --from-tarball "$TARBALL"; rc=$?
check "installer exits 0" test "$rc" = 0
check "/healthz answers" wait_http "http://127.0.0.1:$(port)/healthz"
check "the gateway listened only after the 40 s backend connected" bash -c "journalctl -u patchbay-gateway --no-pager -n 300 | grep -E 'Connected to server: slow|Patchbay Gateway is running' | tail -2 | head -1 | grep -q slow"
cp -p "$LOG_DIR/mcp_server.json.orig" "$CONF"; chown patchbay:patchbay "$CONF"
systemctl restart patchbay-gateway; wait_http "http://127.0.0.1:$(port)/healthz" || true

echo "== 4. forced-failure upgrade, then the printed rollback"
BROKEN="$LOG_DIR/broken"; mkdir -p "$BROKEN/patchbay-gateway"
tar -xzf "$TARBALL" -C "$BROKEN/patchbay-gateway" --strip-components=1 --no-same-owner
sed -i '1i if (Date.now() > 0) { process.exit(1); } // forced failure for the installer test' "$BROKEN/patchbay-gateway/src/sse.ts"
tar -czf "$LOG_DIR/broken.tgz" -C "$BROKEN" patchbay-gateway
echo "# pre-upgrade marker" >>"$UNIT"; systemctl daemon-reload
OLD_MARKER="$(cat "$PREFIX/.patchbay-installer")"
PATCHBAY_READY_TIMEOUT=20 run_installer upgrade-broken --from-tarball "$LOG_DIR/broken.tgz"; rc=$?
check "installer reports failure" test "$rc" != 0
ROLLBACK="$(sed -n 's/^ *\(systemctl stop patchbay-gateway.*\)$/\1/p' "$LOG_DIR/upgrade-broken.log" | tail -n1)"
check "a rollback command was printed" test -n "$ROLLBACK"
check "the rollback restores the unit" bash -c "printf %s '$ROLLBACK' | grep -q 'previous.service'"
check "the failed upgrade overwrote the unit marker" bash -c "! grep -q 'pre-upgrade marker' $UNIT"
if [ -n "$ROLLBACK" ]; then sh -c "$ROLLBACK" >"$LOG_DIR/rollback.log" 2>&1; fi
check "service is active after rollback" bash -c 'for i in 1 2 3 4 5 6 7 8 9 10; do systemctl is-active --quiet patchbay-gateway && exit 0; sleep 1; done; exit 1'
check "/healthz answers after rollback" wait_http "http://127.0.0.1:$(port)/healthz"
check "the unit is restored (marker is back)" grep -q 'pre-upgrade marker' "$UNIT"
check "the code is the previous tree" test "$(cat "$PREFIX/.patchbay-installer")" = "$OLD_MARKER"

echo "== 5. default tag skips a prerelease"
run_installer uninstall-for-tag --uninstall --purge || true
SRC="$LOG_DIR/gitsrc"; mkdir -p "$SRC"
tar -xzf "$TARBALL" -C "$SRC" --strip-components=1 --no-same-owner
( cd "$SRC" && git init -q && git config user.email t@example.invalid && git config user.name t \
  && git add -A && git commit -q -m "test" && git tag v1.0.0 && git tag v1.1.0-rc1 && git tag v0.9.9 )
git clone -q --bare "$SRC" "$LOG_DIR/repo.git"
run_installer default-tag --repo "file://$LOG_DIR/repo.git" --no-start; rc=$?
check "installer exits 0" test "$rc" = 0
check "default tag is v1.0.0, not the prerelease" grep -q 'newest stable release: v1.0.0' "$LOG_DIR/default-tag.log"
check "installed marker names v1.0.0" test "$(cat "$PREFIX/.patchbay-installer" 2>/dev/null)" = v1.0.0
rm -rf "$LOG_DIR/repo.git"
git clone -q --bare "$SRC" "$LOG_DIR/pre-only.git" && git -C "$LOG_DIR/pre-only.git" tag -d v1.0.0 v0.9.9 >/dev/null
run_installer pre-only --uninstall --purge || true
run_installer pre-only --repo "file://$LOG_DIR/pre-only.git" --no-start; rc=$?
check "only a prerelease exists: installer refuses and names --version" bash -c "[ $rc != 0 ] && grep -q 'no stable release tag' $LOG_DIR/pre-only.log"
run_installer explicit --repo "file://$LOG_DIR/pre-only.git" --version v1.1.0-rc1 --no-start; rc=$?
check "explicit --version accepts the prerelease" test "$rc" = 0

echo "== 6. uninstall --purge"
run_installer uninstall --uninstall --purge; rc=$?
check "uninstall exits 0" test "$rc" = 0
check "code, previous copies, unit and env are gone" bash -c "[ ! -e $PREFIX ] && [ ! -e $PREFIX.previous ] && [ ! -e $PREFIX.previous.service ] && [ ! -e $UNIT ] && [ ! -e $ENV_FILE ]"

echo
if [ "$FAILS" = 0 ]; then echo "ALL PASSED ($(. /etc/os-release; echo "$PRETTY_NAME"))"; else echo "$FAILS FAILED ($(. /etc/os-release; echo "$PRETTY_NAME")); logs in $LOG_DIR"; fi
[ "$FAILS" = 0 ] && rm -rf "$LOG_DIR"
exit "$FAILS"

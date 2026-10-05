#!/bin/bash
# Builds/refreshes the installer base directory that the gateway's
# GET /admin/users/:username/installer endpoint serves.
#
# Run this on a gateway container after cloning/updating the repo:
#   bash installer-base/build-base.sh
#
# It populates $INSTALLER_BASE_DIR (default /opt/patchbay-installer-base, or the
# pre-rename /opt/mcp-proxy-installer-base if only that exists) with:
#   node/node.exe            portable Windows node (downloaded)
#   mcp-remote/node_modules  mcp-remote, pre-installed (npm)
#   install.ps1 Install.bat README.txt   copied from this repo (version-controlled)
#
# The big binaries are NOT committed to git (see .gitignore) -- this script
# reproduces them. The scripts ARE committed and are the source of truth.
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-v22.23.1}"
if [ -n "${INSTALLER_BASE_DIR:-}" ]; then
  DEST="$INSTALLER_BASE_DIR"
elif [ ! -d /opt/patchbay-installer-base ] && [ -d /opt/mcp-proxy-installer-base ]; then
  DEST=/opt/mcp-proxy-installer-base
  echo "INSTALLER_BASE_DIR unset; using legacy $DEST (deprecated: export INSTALLER_BASE_DIR to keep it)."
else
  DEST=/opt/patchbay-installer-base
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Building installer base at: $DEST (node $NODE_VERSION)"
mkdir -p "$DEST/node" "$DEST/mcp-remote"

# 1. Windows node.exe
if [ ! -f "$DEST/node/node.exe" ]; then
  echo "Downloading node.exe ($NODE_VERSION win-x64)..."
  curl -s -o /tmp/node-win.zip "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip"
  python3 - "$DEST" <<'PY'
import sys, zipfile
dest = sys.argv[1]
z = zipfile.ZipFile("/tmp/node-win.zip")
name = [n for n in z.namelist() if n.endswith("node.exe")][0]
open(f"{dest}/node/node.exe", "wb").write(z.read(name))
print("node.exe written")
PY
  rm -f /tmp/node-win.zip
else
  echo "node.exe already present, skipping download."
fi

# 2. mcp-remote (pure JS, no native modules)
echo "Installing mcp-remote..."
cd "$DEST/mcp-remote"
[ -f package.json ] || npm init -y >/dev/null 2>&1
npm install mcp-remote >/dev/null 2>&1
echo "mcp-remote installed."

# 3. Version-controlled scripts
cp "$SCRIPT_DIR/install.ps1"  "$DEST/install.ps1"
cp "$SCRIPT_DIR/Install.bat"  "$DEST/Install.bat"
cp "$SCRIPT_DIR/README.txt"   "$DEST/README.txt"
echo "Scripts copied."

echo "Done. INSTALLER_BASE_DIR=$DEST is ready."

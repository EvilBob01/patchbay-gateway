# Installing Patchbay Gateway

Patchbay Gateway installs natively: Node.js from your distribution (or NodeSource),
a systemd service and a dedicated service user. It needs no containers.

- [Quick start: the installer](#quick-start-the-installer)
- [Checking the script before you run it](#checking-the-script-before-you-run-it)
- [Installer options, upgrades and uninstalling](#installer-options-upgrades-and-uninstalling)
- [Trying it locally with npx](#trying-it-locally-with-npx)
- [Manual install](#manual-install)

## Quick start: the installer

On Debian, Ubuntu or AlmaLinux 9 with systemd (other Fedora/RHEL-family systems on a
best-effort basis; see [Tested platforms](#tested-platforms)), as a user with `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/EvilBob01/patchbay-gateway/main/scripts/install.sh | sudo bash
```

The script prints its plan and asks before it changes anything. It then:

1. installs `git`, `curl`, `build-essential` and `python3`, and Node.js at the version
   `package.json` asks for (`engines`, currently 20+): from the distribution when its
   `nodejs` is new enough (Debian 13, Ubuntu 26.04), otherwise from the
   [NodeSource](https://github.com/nodesource/distributions) apt repository (Node 22),
   which it adds with its signing key (Debian 12, Ubuntu 24.04). On the RHEL family
   it uses `dnf`, and when the default `nodejs` is too old (AlmaLinux 9: 16) it
   enables the `nodejs:22` module stream instead;
2. creates the system user `patchbay` with home `/var/lib/patchbay`;
3. clones the GitHub repository at the newest stable release tag (`vX.Y.Z`), runs `npm ci` (which also
   builds) **as `patchbay`**, and moves the result to `/opt/patchbay-gateway`, owned
   by root;
4. on a first install, writes `/etc/patchbay-gateway.env` (mode 600) from
   [`deploy/patchbay-gateway.env.example`](../deploy/patchbay-gateway.env.example) with a
   generated admin password, session secret and client token, and an empty
   `/var/lib/patchbay/config/mcp_server.json`;
5. installs [`deploy/patchbay-gateway.service`](../deploy/patchbay-gateway.service),
   starts it, waits until it answers, and prints the admin URL.

The generated admin password and client token are printed **once**, at the end. They
stay in `/etc/patchbay-gateway.env` (root only) if you need them again.

Runtime state lives outside the code: `/etc/patchbay-gateway.env` and
`/var/lib/patchbay/config/` (servers, users, policy, layout), via
`PATCHBAY_CONFIG_DIR`. That is what lets an upgrade replace `/opt/patchbay-gateway`
wholesale.

Next: firewall the port ([§5](#5-firewall); the installer does not touch your
firewall), log in, and add backends, for example with **Import from client config**
on the Servers tab ([configuration.md](configuration.md#importing-from-a-client-config)).

Without a terminal (cloud-init, `pct exec`, CI), the script can't ask, so pass `--yes`:

```bash
curl -fsSL https://raw.githubusercontent.com/EvilBob01/patchbay-gateway/main/scripts/install.sh | sudo bash -s -- --yes --port 3663
```

## Checking the script before you run it

Piping a download into `sudo bash` runs whatever the server sends. The script is plain,
commented bash with no obfuscation, and it prints every command before running it.
Read it first:

1. Pick a release from the repository's Releases page and download the script from
   that **tag** rather than `main`, so you know exactly which version you are reading:

   ```bash
   TAG=v1.1.0   # the release you picked
   curl -fsSLO "https://raw.githubusercontent.com/EvilBob01/patchbay-gateway/$TAG/scripts/install.sh"
   ```

2. Read it: `less install.sh`. The header lists every step; the only things it fetches
   are distribution packages, the NodeSource key and repository (only when needed), and
   the git repository.
3. Optionally compare it with the copy in a clone of the repository at the same tag,
   or with the release's `scripts/install.sh` on GitHub:

   ```bash
   git clone --depth 1 --branch "$TAG" https://github.com/EvilBob01/patchbay-gateway.git /tmp/pb
   diff install.sh /tmp/pb/scripts/install.sh && echo identical
   ```

4. Run the file you read, pinning the same tag:

   ```bash
   sudo bash install.sh --version "$TAG"
   ```

## Installer options, upgrades and uninstalling

| Option | Meaning |
|---|---|
| `--version <tag>` | Release tag to install. Default: the newest stable `vX.Y.Z` tag; prereleases such as `v1.1.0-rc1` are never picked by default, pass them here. |
| `--port <n>` | Port for a first install (default 3663). On upgrade, edit `PORT` in the env file instead. |
| `--repo <url>` | Repository to clone (default the GitHub repository). |
| `--prefix <dir>` | Install directory (default `/opt/patchbay-gateway`). |
| `--yes`, `-y` | Don't ask. Required without a terminal. |
| `--no-start` | Install and enable, but don't start. |
| `--uninstall` | Stop and remove the service, the code and `/opt/patchbay-gateway.previous`. Keeps the env file, `/var/lib/patchbay`, the audit log in `/var/log/patchbay-gateway` and the `patchbay` user. |
| `--purge` | With `--uninstall`, also remove those. |
| `--from-tarball <file>` | Install from a local source tarball (for testing unreleased code). |

**Upgrading:** run the installer again, optionally with `--version`. It builds the new
version next to the old one, keeps the old one as `/opt/patchbay-gateway.previous`,
keeps `/etc/patchbay-gateway.env` and `/var/lib/patchbay`, restarts the service and
waits for it to answer. Credentials are not printed again.

*Readiness.* The installer waits up to 180 s in all for `GET /healthz` (each probe is
cut off when that time runs out, so a hung gateway cannot stall it), which answers
`{"status":"ok"}` with no credentials and exists whether or not the admin UI is
enabled. It probes `BIND_HOST` from `/etc/patchbay-gateway.env` when that names one
address, otherwise `127.0.0.1`. It checks that the gateway is listening, not that
every backend is healthy; the admin UI shows backend state.

*Rollback.* An upgrade keeps the old code as `/opt/patchbay-gateway.previous` and the
old systemd unit as `/opt/patchbay-gateway.previous.service`. If the new version
doesn't answer, the installer prints a one-line rollback that restores both, then runs
`systemctl daemon-reload` and starts the service. The env file and `/var/lib/patchbay`
are not changed by an upgrade, so they need no restoring. Only one previous version is
kept: the next upgrade replaces it.

The installer only manages a directory it created (it leaves a `.patchbay-installer`
marker). It refuses to touch an existing `/opt/patchbay-gateway` from a manual install;
upgrade that one as in [§7](#7-upgrading).

`--uninstall` never removes Node.js or other packages. If the installer added the
NodeSource repository, `/etc/apt/sources.list.d/nodesource.list` and
`/etc/apt/keyrings/nodesource.gpg` stay too; delete them by hand if you no longer want
Node.js updates from NodeSource.

### Tested platforms

Each row is a fresh unprivileged Proxmox LXC container from the stock template, with
only `curl` and `ca-certificates` added first. The installer ran piped into `bash`
from a source tarball (`--from-tarball`), then: the service user, file ownership and
env file mode; no generated secret in the journal or `/var/log`; admin login; a stdio
backend added through the admin API and called over `/mcp`; a re-run as an in-place
upgrade; `--uninstall`, then `--purge`.

| Distribution | Node.js source | Node.js version | Tested |
|---|---|---|---|
| Debian 12 (bookworm) | NodeSource (distro has 18) | 22.23.3 | 2026-10-08 |
| Debian 13 (trixie) | distribution | 20.19.2 | 2026-10-08 |
| Ubuntu 24.04 LTS (noble) | NodeSource (distro has 18) | 22.23.3 | 2026-10-08 |
| Ubuntu 26.04 LTS (resolute) | distribution | 22.22.1 | 2026-10-08 |
| AlmaLinux 9.4 | AppStream module `nodejs:22` (default stream is 16) | 22.23.2 | 2026-10-08 |

**Installer test harness.** `scripts/test-installer.sh <source.tgz>` re-runs the installer
end to end on any throwaway systemd machine (root; it installs packages and ends with
`--uninstall --purge`). It covers: a fresh install; an upgrade with `ENABLE_ADMIN_UI=false`;
an upgrade with `BIND_HOST` set to the machine's address (loopback must not listen); a forced
failure whose printed rollback restores the old code and systemd unit with the service
running; the default tag skipping a prerelease; and the purge. Build the tarball from the
checkout with `git archive --prefix=patchbay-gateway/ -o source.tgz HEAD`.

| Commit | Distribution | Result | Date |
|---|---|---|---|
| `fc362a5` | Debian 12 (bookworm) | all scenarios passed | 2026-10-11 |
| `fc362a5` | Debian 13 (trixie) | all scenarios passed | 2026-10-11 |
| `fc362a5` | Ubuntu 24.04 LTS (noble) | all scenarios passed | 2026-10-11 |
| `fc362a5` | AlmaLinux 9.4 | all scenarios passed | 2026-10-11 |
| `8678af0` | Debian 12 (bookworm) | all scenarios passed, including the slow-start upgrade | 2026-10-12 |

| Distribution | Status | Why |
|---|---|---|
| AlmaLinux 9 | **Supported**, with two gaps in the test | Containers can't run SELinux, so enforcing mode was not exercised; the installer relabels what it writes with `restorecon` when SELinux is on. firewalld was not in the image; where it runs, it blocks the port until you open it ([§5](#5-firewall)). |
| AlmaLinux 10 | **Not tested** | The image needs an x86-64-v3 CPU (AVX2) and the test host doesn't have one. AppStream ships Node 22 as the default, so the installer should take the distribution path. |
| Devuan 5 | **Not supported** | No systemd. The installer refuses before changing anything and says so. Use the [manual install](#manual-install) with your own init script, or `npx`. |
| Fedora, other RHEL-likes | Best-effort | Untested. |

## Trying it locally with npx

On any machine with Node.js 20+ (Linux, macOS or Windows):

```bash
npx patchbay-gateway
```

On first run this creates `~/.patchbay-gateway/` (config, audit log, `gateway.env` with
a generated admin password, session secret and client token), prints the credentials
once, and starts the gateway with the admin UI on `http://127.0.0.1:3663/admin`. It
binds to `127.0.0.1` so a trial is not reachable from the network.

| Option | Meaning |
|---|---|
| `--port <n>` | Port (default 3663, or `PORT`). |
| `--host <addr>` | Bind address (default `127.0.0.1`, or `BIND_HOST`). `0.0.0.0` accepts remote connections. |
| `--data-dir <dir>` | Data directory (default `~/.patchbay-gateway`, or `PATCHBAY_HOME`). |
| `stdio` | Run as a single stdio MCP server instead (for a client to spawn). |

Variables already set in your environment win over `gateway.env`. The admin terminal is
off unless you set `PATCHBAY_ENABLE_TERMINAL=true` in `gateway.env`; it also
needs the optional native module `node-pty`. If your machine can't build it, everything
else still works and the terminal says it is unavailable.

> The `patchbay-gateway` npm package is not published yet. Until it is, clone the
> repository and run `npm install && node build/cli.js` for the same behaviour.

## Manual install

This installs the gateway by hand on a Linux host (a VM, an LXC container or bare
metal) as a systemd service. The commands are for Debian/Ubuntu; other distributions
need only different package names.

1. [Requirements](#1-requirements)
2. [Get the code and build it](#2-get-the-code-and-build-it)
3. [Environment file](#3-environment-file)
4. [systemd unit](#4-systemd-unit)
5. [Firewall](#5-firewall)
6. [First login](#6-first-login)
7. [Upgrading](#7-upgrading)
8. [Troubleshooting](#8-troubleshooting)

### 1. Requirements

| | |
|---|---|
| **Node.js** | 20 or newer (22 LTS recommended), with `npm` and `npx`. Debian 13 ships Node 20 (`apt install nodejs npm`). On older releases, use the NodeSource apt repository or a tarball from nodejs.org. |
| **Build tools** | `build-essential` and `python3`. The admin terminal's `node-pty` module is compiled during `npm install`. |
| **git** | To clone and upgrade. |
| **Backends** | Whatever your MCP servers need. Many stdio servers start with `npx` or `uvx`, so give the service user a writable home for their caches. |

```bash
sudo apt update
sudo apt install -y nodejs npm git build-essential python3
node --version   # must print v20 or newer
```

### 2. Get the code and build it

Create a system user to run the gateway, clone, and build:

```bash
sudo useradd --system --create-home --home-dir /var/lib/patchbay --shell /bin/bash patchbay
sudo git clone https://github.com/<you>/patchbay-gateway.git /opt/patchbay-gateway
sudo chown -R patchbay:patchbay /opt/patchbay-gateway
cd /opt/patchbay-gateway
sudo -u patchbay npm install
sudo -u patchbay npm run build
```

`npm run build` compiles TypeScript into `build/`. The HTTP gateway's entry point is
`build/sse.js`. `build/index.js` runs the same aggregation as a single stdio MCP
server, without the HTTP endpoints, identities or admin UI.

Create the backend list from the example and lock down the config directory. The
gateway writes users, the policy and other state into it:

```bash
sudo -u patchbay cp config/mcp_server.json.example config/mcp_server.json
sudo -u patchbay "${EDITOR:-nano}" config/mcp_server.json
sudo chmod 700 /opt/patchbay-gateway/config
```

See [configuration.md](configuration.md#configmcp_serverjson-backend-servers) for the
format. You can also start with an empty `{"mcpServers": {}}` and add servers from the
admin UI, or import them from a client config.

To keep this state outside the code directory (as the installer does), set
`PATCHBAY_CONFIG_DIR` in the env file to a directory the service user owns, for
example `/var/lib/patchbay/config`, and put `mcp_server.json` there instead.

> **Why a dedicated user?** The admin UI's **Terminal** and **Install** features (both
> opt-in) run as the service user, so with them on, whoever logs into the UI gets that
> user's shell. A dedicated
> account limits that to the gateway's own files and the backend credentials it already
> holds. If you run as root instead, an admin login is a root shell.

### 3. Environment file

Create `/etc/patchbay-gateway.env`, readable by root only (systemd reads it before
dropping privileges):

```bash
sudo install -m 600 -o root -g root /dev/null /etc/patchbay-gateway.env
sudo "${EDITOR:-nano}" /etc/patchbay-gateway.env
```

The repository ships a minimal [`deploy/patchbay-gateway.env.example`](../deploy/patchbay-gateway.env.example).
This fuller version suits the dedicated-user layout above:

```ini
# --- HTTP server -----------------------------------------------------------
PORT=3663

# Do NOT set NODE_ENV=production while the admin UI is served over plain HTTP.
# It marks the session cookie Secure; browsers won't send it back over HTTP,
# so login "succeeds" and every following page returns 401. Only set it when a
# TLS-terminating reverse proxy is in front of the gateway.
#NODE_ENV=production

# --- Admin UI --------------------------------------------------------------
ENABLE_ADMIN_UI=true
ADMIN_USERNAME=admin
# Generate with: openssl rand -base64 24
ADMIN_PASSWORD=REPLACE_ME
# Generate with: openssl rand -hex 32
SESSION_SECRET=REPLACE_ME

# Name used in generated client configs and the admin UI title.
GATEWAY_CLIENT_NAME=patchbay
# Accent colour. Quote it: an unquoted # starts a comment in this file.
GATEWAY_UI_COLOR="#1e7e34"

# --- MCP client auth -------------------------------------------------------
# Prefer per-user tokens from the admin UI's Users tab (named identities,
# per-user policy, revocable without a restart). A static token is useful for
# scripts and as a bootstrap credential; it is audited as user "static".
#   ALLOWED_TOKENS: accepted as "Authorization: Bearer <token>"
#   ALLOWED_KEYS:   accepted as "X-Api-Key: <key>" or "?key=<key>"
#ALLOWED_TOKENS=
#ALLOWED_KEYS=

# --- Audit log -------------------------------------------------------------
# Default /var/log/patchbay-gateway/audit; the unit below creates and chowns
# /var/log/patchbay-gateway (LogsDirectory=), so the default just works.
MCP_AUDIT_RETENTION_DAYS=30

# --- Paths whose defaults the service user can't write ---------------------
# (The Deploy Key public key already defaults to ~patchbay/.ssh/id_ed25519.pub.)
MAIL_ACCOUNTS_PLAINTEXT_PATH=/var/lib/patchbay/mail-accounts.json
INSTALLER_BASE_DIR=/var/lib/patchbay/installer-base
TOOLS_FOLDER=/var/lib/patchbay/tools
```

Every variable, including rate limits and the text-merge toggle, is described in
[configuration.md](configuration.md#environment-variables).

> **If you forget `ADMIN_PASSWORD`,** or leave it `REPLACE_ME`, the admin UI stays
> off and the log says `Admin UI NOT enabled`. The MCP endpoints still run. There is
> no built-in password.
>
> **The terminal, install runner and key push are off** until you add
> `PATCHBAY_ENABLE_TERMINAL=true`, `PATCHBAY_ENABLE_INSTALL_RUNNER=true` or
> `PATCHBAY_ENABLE_DEPLOY_KEYS=true`. Turn on only the ones you use; see
> [configuration.md](configuration.md#opt-in-admin-features).

### 4. systemd unit

`/etc/systemd/system/patchbay-gateway.service`. This is
[`deploy/patchbay-gateway.service`](../deploy/patchbay-gateway.service) as shipped: a
service user, a log directory and light hardening:

```ini
[Unit]
Description=Patchbay Gateway (MCP aggregation gateway)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=patchbay
Group=patchbay
EnvironmentFile=/etc/patchbay-gateway.env
Environment=HOME=/var/lib/patchbay
WorkingDirectory=/opt/patchbay-gateway
ExecStart=/usr/bin/node /opt/patchbay-gateway/build/sse.js
Restart=on-failure
RestartSec=5
LogsDirectory=patchbay-gateway
LogsDirectoryMode=0750
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now patchbay-gateway
journalctl -u patchbay-gateway -f
```

A healthy start logs the authentication mode, the audit, rate-limit and text-merge
settings, one `Connected to server: <name>` line per backend, and the endpoint URLs.

Using a different install path? `ExecStart` needs `node` and the absolute path to
`build/sse.js`, and `WorkingDirectory` must be the install directory.

### 5. Firewall

The gateway serves **plain HTTP on every interface** unless `BIND_HOST` names one
address, and it has no TLS. Treat it like a database port:

- **Put it on a private network**: a management VLAN, WireGuard, or a tailnet. Only
  the machines running MCP clients and the admins' browsers need to reach `PORT`.
- **Firewall the port to that network** on the gateway host itself. With nftables,
  allowing a private subnet (example `192.0.2.0/24`) and a VPN interface:

  ```bash
  sudo nft add table inet patchbay
  sudo nft add chain inet patchbay input '{ type filter hook input priority 0 ; policy accept ; }'
  sudo nft add rule inet patchbay input iif lo tcp dport 3663 accept
  sudo nft add rule inet patchbay input iifname "wg0" tcp dport 3663 accept
  sudo nft add rule inet patchbay input ip saddr 192.0.2.0/24 tcp dport 3663 accept
  sudo nft add rule inet patchbay input tcp dport 3663 drop
  ```

  Persist the rules in `/etc/nftables.conf`, or use `ufw`:
  `sudo ufw allow from 192.0.2.0/24 to any port 3663 proto tcp`, then
  `sudo ufw deny 3663/tcp`. Cover IPv6 as well, or disable it on that interface.
  On Fedora/RHEL, firewalld already blocks the port; open it to one network only:

  ```bash
  sudo firewall-cmd --permanent --new-zone=patchbay
  sudo firewall-cmd --permanent --zone=patchbay --add-source=192.0.2.0/24 --add-port=3663/tcp
  sudo firewall-cmd --reload
  ```
- **Never expose it to the internet as-is.** If clients must reach it across an
  untrusted network, put a TLS-terminating reverse proxy (nginx, Caddy, HAProxy) in
  front. Consider leaving `/admin` off the public listener and setting `NODE_ENV=production`
  only on that proxied path.
- **Tokens travel in the URL** when clients use `?key=` (needed on Windows; see
  [client-setup.md](client-setup.md)). That is acceptable on a private network and
  another reason not to cross an untrusted one without TLS.
- **Optional:** run the gateway without the admin UI (`ENABLE_ADMIN_UI` unset) and
  enable it only when you need it.

### 6. First login

1. Browse to `http://<gateway>:3663/admin` and log in with `ADMIN_USERNAME` /
   `ADMIN_PASSWORD`.
2. **Servers:** check every backend shows as connected. **Reload** after edits.
3. **Users:** create a user. The token is live at once.
4. **Users → Tool policy:** decide who may call what. With no policy, every user gets
   every enabled tool. A sensible start is `"default": {"allow": []}` plus a
   `users.<name>` entry per person.
5. Connect a client: [client-setup.md](client-setup.md).

### 7. Upgrading

```bash
cd /opt/patchbay-gateway
sudo -u patchbay git fetch
sudo -u patchbay git merge --ff-only
sudo -u patchbay npm install
sudo -u patchbay npm run build
sudo systemctl restart patchbay-gateway
```

Run it as one `&&` chain if you prefer, so a failed step stops the restart.
`--ff-only` refuses to merge if the checkout has local commits. In that case,
investigate instead of forcing it. Your configuration and state in `config/` (servers,
users, policy, layout, mailboxes) are ignored by git and survive upgrades. Read
[CHANGELOG.md](../CHANGELOG.md) first for anything that changes behaviour.

A restart drops open MCP sessions (clients reconnect) and logs admins out (the session
store is in memory). Backend-only changes never need a restart: use **Reload**.

### 8. Troubleshooting

| Symptom | Cause |
|---|---|
| Admin login succeeds, then every page shows 401 / "Could not load server configuration" | `NODE_ENV=production` over plain HTTP. Remove it and restart. |
| `GATEWAY_UI_COLOR` has no effect | Unquoted `#` in the env file. Write `GATEWAY_UI_COLOR="#1e7e34"`. |
| All tool calls fail with "tool policy is invalid" | A hand edit broke `config/tool_policy.json`. The log says which key. Fix it, or save it through the admin editor, which validates. |
| A backend never logs `Connected to server` | Its `command`/`url` is wrong, or it can't run as the service user (missing `npx`/`uvx` cache, missing SSH key, network). Run its command by hand with `sudo -u patchbay`. |
| `Audit log disabled: cannot create …` | `MCP_AUDIT_DIR` (default `/var/log/patchbay-gateway/audit`) isn't writable by the service user. Keep `LogsDirectory=patchbay-gateway` in the unit. |
| `npm install` fails building `node-pty` | Install `build-essential` and `python3`. |
| Clients get `-32011` | Rate limited. See [configuration.md](configuration.md#rate-limits) to tune. |
| A client sees fewer tools than expected | Tool policy or a disabled tool. The journal logs `N hidden by tool policy for user:<name>` on each `tools/list`. |

# Installing Patchbay Gateway

This guide installs the gateway natively on a Linux host (a VM, an LXC container or
bare metal) as a systemd service. It needs no containers. The commands are for
Debian/Ubuntu; other distributions need only different package names.

1. [Requirements](#1-requirements)
2. [Get the code and build it](#2-get-the-code-and-build-it)
3. [Environment file](#3-environment-file)
4. [systemd unit](#4-systemd-unit)
5. [Firewall](#5-firewall)
6. [First login](#6-first-login)
7. [Upgrading](#7-upgrading)
8. [Troubleshooting](#8-troubleshooting)

## 1. Requirements

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

## 2. Get the code and build it

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
admin UI.

> **Why a dedicated user?** The admin UI's **Terminal** and **Install** features run as
> the service user, so whoever logs into the UI gets that user's shell. A dedicated
> account limits that to the gateway's own files and the backend credentials it already
> holds. If you run as root instead, an admin login is a root shell.

## 3. Environment file

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

> **If you forget `ADMIN_PASSWORD`,** the UI accepts `admin` / `password`. The
> gateway logs a warning at startup, but it does not refuse to start.

## 4. systemd unit

`/etc/systemd/system/patchbay-gateway.service`. This is
[`deploy/patchbay-gateway.service`](../deploy/patchbay-gateway.service) plus a service
user, a log directory and light hardening:

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
# Must be the install directory: mcp_server.json is read from ./config.
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

## 5. Firewall

The gateway serves **plain HTTP on every interface**. It has no bind-address setting
and no TLS. Treat it like a database port:

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
- **Never expose it to the internet as-is.** If clients must reach it across an
  untrusted network, put a TLS-terminating reverse proxy (nginx, Caddy, HAProxy) in
  front. Consider leaving `/admin` off the public listener and setting `NODE_ENV=production`
  only on that proxied path.
- **Tokens travel in the URL** when clients use `?key=` (needed on Windows; see
  [client-setup.md](client-setup.md)). That is acceptable on a private network and
  another reason not to cross an untrusted one without TLS.
- **Optional:** run the gateway without the admin UI (`ENABLE_ADMIN_UI` unset) and
  enable it only when you need it.

## 6. First login

1. Browse to `http://<gateway>:3663/admin` and log in with `ADMIN_USERNAME` /
   `ADMIN_PASSWORD`.
2. **Servers:** check every backend shows as connected. **Reload** after edits.
3. **Users:** create a user. The token is live at once.
4. **Users → Tool policy:** decide who may call what. With no policy, every user gets
   every enabled tool. A sensible start is `"default": {"allow": []}` plus a
   `users.<name>` entry per person.
5. Connect a client: [client-setup.md](client-setup.md).

## 7. Upgrading

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

## 8. Troubleshooting

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

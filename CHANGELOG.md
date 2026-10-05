# Changelog

## 1.0.0 (2026-10-05): first release as Patchbay Gateway

First release as **Patchbay Gateway**, forked from
[ptbsare/mcp-proxy-server](https://github.com/ptbsare/mcp-proxy-server) **v0.4.1**
(2025-07-27). Upstream's history is kept as is. Everything below is what this fork adds
or changes on top of it.

### Security and policy

- **Caller identity.** Every request on `/mcp`, `/sse` and `/message` resolves to a
  named identity: a per-user token, the shared `static` credential from
  `ALLOWED_TOKENS`/`ALLOWED_KEYS`, or `anonymous` when authentication is off.
  Identities are bound per MCP session and re-resolved per request.
- **Per-user tokens.** The admin **Users** tab and `/admin/users` API create and
  revoke users (`config/users.json`) without a restart. Tokens work as Bearer, `X-Api-Key`
  or `?key=`.
- **Per-tool authorization** (`config/tool_policy.json`). Allow and deny globs over
  `backend/tool` for each user, role, the static credential and the default. Deny wins.
  Enforced on both `tools/list` (tools are hidden) and `tools/call` (refused with
  `-32003`). Re-read on change; a malformed file fails closed. The Users tab has an
  editor that validates before saving.
- **Lethal-trifecta blocking.** Tools are classified as private-data,
  untrusted-content and/or external-comm. Each session accumulates the axes it has
  touched, and the call that would complete all three is refused with `-32010` before
  it reaches a backend. Built-in profiles cover ssh-mcp, an IMAP mail connector,
  Context7 and the bundled catalog server; unknown tools default to untrusted +
  external. `enforce`, `monitor` and `off` modes; per-tool `classify` overrides;
  audited `allow` exceptions with a required reason. See [TRIFECTA.md](TRIFECTA.md).
- **`tools/call` audit log.** Append-only JSON Lines, one file per UTC day, with the
  identity, session, tool, backend, authorization decision and rule, duration, errors
  and trifecta detail. Arguments are opt-in (`MCP_AUDIT_LOG_ARGUMENTS`). Size cap,
  retention, and writes that never fail a tool call.
- **Per-identity rate limits.** Token buckets for `tools/call` (burst 60, 120/min) and
  for every authenticated HTTP request (burst 120, 300/min), all configurable.
  Throttled requests get `-32011` / HTTP 429 and are audited as coalesced `rate-limit`
  events.
- **Admin hardening.** These fix findings from the security audit published on the
  willscottuk fork (`d12590dc`), which upstream never addressed:
  - `SameSite=Strict` session cookie;
  - session ID regenerated on login;
  - per-IP login throttle (`ADMIN_LOGIN_MAX_ATTEMPTS`, `ADMIN_LOGIN_WINDOW_MINUTES`);
  - constant-time credential comparison;
  - security headers (`nosniff`, `X-Frame-Options: DENY`, `no-referrer`, COOP);
  - secrets stripped from the web terminal's environment;
  - the install runner no longer uses a shell, and allows only package managers and
    build tools;
  - server keys validated before they are used in paths.

### Correctness

- **Per-session server instances.** Each client session gets its own MCP `Server`
  instance. Upstream connected every session to one shared instance, so on a
  multi-user gateway a response could be delivered to whichever client connected most
  recently. Idle sessions are reaped (`MCP_SESSION_IDLE_MINUTES`). This approach was
  first taken by the matuszeg fork (`40d702cd`).
- **Reload reconnects changed backends.** Reloading after editing a server's command,
  args, env or URL now reconnects that backend. Previously the edit had no effect until
  a restart. Unchanged backends are left alone. The diffing idea comes from the
  willscottuk fork (`75d535b`).
- **MCP SDK 1.12.0 → 1.30.0** (last of the 1.x line). The protocol negotiation ceiling
  rises to `2025-11-25`. Lockfile refreshed to clear npm advisories.
- **Deterministic `tools/list` order**, following the admin Tools layout and then
  alphabetical order, which keeps client prompt caches stable.

### Client compatibility

- **Merge adjacent text blocks** in tool results, for clients that read only the first
  block (the OpenAI Responses API remote MCP tool). Off by default;
  `MCP_MERGE_TEXT_CONTENT=true` turns it on gateway-wide, and a per-user
  `mergeTextContent` overrides it. Ported from the willscottuk fork (`190093a1`),
  where it was unconditional.

### Admin UI

- Redesigned UI: design tokens, dark mode, self-hosted Inter font, per-gateway name and
  accent colour (`GATEWAY_CLIENT_NAME`, `GATEWAY_UI_COLOR`) in the title, header and
  favicon.
- **Users** tab: create and revoke users, **Copy Desktop Config**, and a
  **Download Installer** Windows bundle (portable Node.js + `mcp-remote` + the user's
  token).
- **Catalog**: curated plus MCP-registry/npm browse with one-click add. A bundled
  `catalog-server` MCP backend lets end users request connectors, which admins review
  in the **Requests** tab.
- **Mailboxes** tab: IMAP/SMTP accounts for a mail connector, encrypted at rest
  (AES-256-GCM), with an optional per-account certificate-verification exception.
- **Deploy Key** tab: push the gateway's SSH public key to a new host with a one-time
  password.
- Servers and Tools: live search, collapsible groups, drag-and-drop ordering,
  per-entry move menu.
- Guided **Add Server** wizard, inline help and a **Help** tab.
- stdio arguments are edited one per line.
- Admin sessions last 30 days by default with a rolling refresh
  (`ADMIN_SESSION_HOURS`).

### Tooling

- `scripts/patch-ssh-mcp-legacy.mjs` relaxes `ssh-mcp`'s algorithm list so the gateway
  can reach very old OpenSSH servers. It patches a dependency, so re-run it after
  upgrading `ssh-mcp`.
- Offline tests under `test/` for identity, tool policy, trifecta, rate limiting,
  text merging, session isolation and path defaults.

- **Leak guard** (`scripts/guard.mjs`): gitleaks plus checks for private and CGNAT
  IPv4 addresses and a private denylist kept outside the repo. Runs in `npm test`
  and as an optional pre-commit hook. See [docs/guard.md](docs/guard.md).
- `npm test` builds and runs every offline test, then the guard.

### Renamed

- Package, binary, admin UI title, startup log line and MCP server/client info names
  are now `patchbay-gateway`. The Windows installer installs into
  `%LOCALAPPDATA%\patchbay-gateway`.
- `GATEWAY_CLIENT_NAME` defaults to `patchbay`.
- On-disk defaults moved: the audit log to `/var/log/patchbay-gateway/audit` and the
  installer payload to `/opt/patchbay-installer-base`. If the variable is unset and only
  the old path (`/var/log/mcp-gateway-audit`, `/opt/mcp-proxy-installer-base`)
  exists, the old path is still used, with a deprecation warning. No environment
  variables were renamed.
- The Deploy Key public key defaults to the service user's
  `~/.ssh/id_ed25519.pub` instead of `/root/...`.

### Removed or changed from upstream

- Documentation rewritten for native installation with systemd. The upstream
  Docker-based instructions are not maintained in this fork.
- Removed upstream's Docker and Home Assistant add-on packaging (`Dockerfile`,
  `nginx.conf`, `rootfs/`, `build.yaml`, `config.yaml`), its Docker-publish and
  auto-release workflows, `FUNDING.yml`, and the superseded `DOCS.md` /
  `README_ZH.md`.

# Changelog

## 1.1.0 (2026-10-13)

### Fixes

- **A retry never runs a tool that changed while the call waited.** Authorization
  and tool resolution happened once, before the retry loop; a backend that changed
  a tool's definition and sent `tools/list_changed` during the retry delay had the
  tool put on hold, yet the retry still ran it. Now every dispatch, retries
  included, on direct, collapsed and lazy (`call_read`/`call_write`) calls, is
  checked again right before it is sent: the tool must still be served with the
  definition it was approved with, the caller still authorized, the backend up,
  and `call_read`'s tool still classed read. Otherwise the call is not sent and the
  client gets `-32012` (held, or `definition-changed`), `-32601`, `-32003`,
  `-32013` or `-32010`.
- **Only read tools are retried automatically.** A timeout or a lost connection
  does not prove a write did not run, and replaying it could repeat its side
  effects (upstream behaviour since 1.0). A tool not classed read (`toolClass`,
  then `readOnlyHint`; unknown counts as write) now fails once and the client gets
  the error with `data.notRetried`. The `*_TOOL_CALL_*` retry settings apply to
  read tools only. Transport recovery (reconnecting a dead backend) is unchanged.
  Audit lines gain `attempts` and, when a retry was not sent, `retryRefused`.
- **Concurrent reconnects no longer leak a backend process.** Two admin reconnects
  of one backend at once, or a reconnect racing a reload or the SSE refresh, could
  each start a backend process and keep only one. Every connection operation now
  holds a per-backend lock; a reload holds all of them. Two admin reconnects at
  once share one attempt, and a reload waits for (and is waited for by)
  reconnects in progress. See
  [configuration.md](docs/configuration.md#backend-tool-call-retries).
- **A backend removed during an admin reconnect stays removed.** If a reload
  removed a backend while its admin reconnect was still waiting (for an attempt in
  flight, or for a free reconnect slot), the reconnect recreated the backend's
  health record and, when it failed, kept retrying a backend that no longer
  existed. It now stops there and the admin gets `404`. The same applies when an
  HTTP backend's post-failure ping ends after a reload removed or replaced it.
- **Installer readiness no longer needs the admin UI.** `scripts/install.sh` polled
  `/admin/info`, so a healthy MCP-only gateway (`ENABLE_ADMIN_UI=false`, or admin disabled by
  a missing password) was reported as failed after an upgrade. It now polls the new
  unauthenticated `GET /healthz` (`{"status":"ok"}`, always mounted) at `BIND_HOST` when that
  names one address, else loopback.
- **The installer waits long enough for large installs.** The gateway listens only after its
  backends have connected one by one (about 40 s for 23), but the installer gave up after
  30 s and reported a healthy upgrade as failed. It now waits up to 180 s
  (`PATCHBAY_READY_TIMEOUT=<seconds>` to change it).
- **The readiness timeout is a real deadline.** The wait counted loop rounds, and each
  `curl` had no time limit, so a slow or hung `/healthz` could stretch it far past
  `PATCHBAY_READY_TIMEOUT`, or forever, before the failure and rollback advice was shown.
  It now ends after that many seconds of elapsed time, and each probe is bounded by
  the time left.
  `PATCHBAY_READY_TIMEOUT` is read as decimal seconds (1-9999), zero padding
  included: `08` was accepted, then failed in bash arithmetic as octal, and `010`
  meant 8 s. Anything else is refused before the installer changes anything.
- **Installer rollback restores the systemd unit too.** Upgrades save the old unit as
  `/opt/patchbay-gateway.previous.service`; the printed rollback restores the code and the unit,
  runs `daemon-reload` and restarts.
- **Installer picks stable tags only.** The default is the newest `vX.Y.Z`; prereleases such as
  `v1.1.0-rc1` need an explicit `--version`.
- **One version source.** The MCP server info and both client identities (initial connect and
  reconnect, which advertised a stale `1.0.1`) now read the version from `package.json`.

- **One `MCP error` prefix.** Gateway errors (`-32003`, `-32010`, `-32012`, `-32013`,
  `-32601`, `-32602`, rate limits) and errors forwarded from backends reached clients as
  `MCP error -32013: MCP error -32013: ...`. The prefix now appears once; codes, text and
  `data` are unchanged.
- **Admin UI: config values render as text** (stored HTML injection). An imported
  display name was put into the Servers tab as HTML, so a crafted name in a pasted
  client config ran script in the admin's session when the tab was shown. The Servers,
  Tools, Users and Mailboxes tabs now build their entries with `textContent` / `.value`;
  names, keys, descriptions, commands, args, env, URLs, install directories and
  commands, tool names and backend-supplied tool descriptions all appear literally.
- **Masking: a secret-sounding name wins over a path-looking value.**
  `PASSWORD=/x…`, `--password=/x…` and `--password /x…` were treated as file paths and
  shown in full by `GET /admin/config` and the import preview. Paths stay visible only
  under path-field names (`*_PATH`, `*_FILE`, `--key`, `--identity-file`, …). The import
  preview and the Servers tab now use one masking module (`configSecrets.ts`), so the
  preview shows harmless env values such as `LOG_LEVEL` like the Servers tab does.
  The patterns are listed in [configuration.md](docs/configuration.md#importing-from-a-client-config).
- **Empty credential arguments stay empty.** `--password ""` and `--token=` were shown
  as `(empty)`, which a save did not recognise as masked, so saving the Servers tab
  unchanged wrote the literal `(empty)` into the config. Empty values are now shown
  and saved as they are.
- **Saving the Servers tab keeps argv exactly.** Saving trimmed every argument and
  dropped empty ones, so `['--label', '  two spaces  ', '', '--mode']` became
  `['--label', 'two spaces', '--mode']`. An untouched arguments field now saves the
  original array; lists that one-per-line can't show (empty arguments, leading or
  trailing spaces, line breaks) open as a JSON array, and an **Edit as JSON / Edit as
  lines** button switches between the two.

### Onboarding

- **Import from a client config.** The Servers tab imports backends from a pasted or
  uploaded `claude_desktop_config.json`, Claude Code `.mcp.json`, Cursor, Windsurf,
  Cline or VS Code `mcp.json`. The preview flags entries the gateway can't run
  (Windows or relative paths, PowerShell), unwraps `cmd /c`, proposes free names on
  clashes and masks recognised credential fields; the full entries never go back to the browser. New
  admin API: `POST /admin/import/preview` and `/admin/import/apply`. See
  [configuration.md](docs/configuration.md#importing-from-a-client-config).
- **One-line native installer** (`scripts/install.sh`) for Debian/Ubuntu: Node.js from
  the distribution or NodeSource, a `patchbay` service user, a release tag built as
  that user, generated credentials shown once, systemd. Re-running upgrades in place
  and keeps a rollback copy; `--uninstall` / `--purge`. No containers.
- **`npx patchbay-gateway`** (package prepared, not yet published): a local trial with
  its own data directory, generated credentials and a `127.0.0.1` bind. The `bin` now
  points at `build/cli.js`; `patchbay-gateway stdio` keeps the old stdio behaviour.

### Configuration

- `PATCHBAY_CONFIG_DIR` moves the whole config directory, including
  `mcp_server.json` and `tool_config.json`. Unset, nothing changes: those two are
  still read from `./config` in the working directory, the rest from the install
  directory.
- `BIND_HOST` sets the listen address (default: all interfaces, as before).
- `node-pty` is an optional dependency: without it only the admin terminal is
  unavailable. `package.json` now declares `engines.node >= 20`.
- The sample systemd unit runs as a `patchbay` user with `LogsDirectory`,
  `NoNewPrivileges` and `PrivateTmp`, matching docs/install.md.

### Security and admin UI

- **Breaking: risky admin features are off by default.** The browser terminal, the
  install runner and the SSH key push each need their own switch now, on top of
  `ENABLE_ADMIN_UI`: `PATCHBAY_ENABLE_TERMINAL`, `PATCHBAY_ENABLE_INSTALL_RUNNER`
  and `PATCHBAY_ENABLE_DEPLOY_KEYS` (`true`, `1` or `yes`). When one is off, its
  routes are not mounted (404) and the admin UI hides its tab or button with a note
  naming the variable. The gateway's public key stays visible on the Deploy Key tab.
  The startup log shows the effective state (`Admin features: terminal=off, ...`).
  **Upgrading:** to keep a feature you use, add its line to the env file before
  restarting, e.g. `PATCHBAY_ENABLE_DEPLOY_KEYS=true`.
- **Breaking: no default admin password.** The `admin` / `password` fallback is
  gone. With `ENABLE_ADMIN_UI` on and `ADMIN_PASSWORD` unset, empty or a placeholder
  (`REPLACE_ME`, `password`, `change-me`, `changeme`, `admin`), the gateway logs
  `Admin UI NOT enabled`, keeps the admin UI off and still serves MCP.
  **Upgrading:** check that the env file sets a real `ADMIN_PASSWORD`.
- The install runner no longer copies install command output into the journal; the
  output still streams to the admin UI. The journal records the command, exit code
  and line counts.
- **Rug-pull protection.** Backend tool definitions are pinned by hash; a changed
  or new tool is withheld until approved on the new Review tab (`MCP_PIN_TOOLS`,
  default on; `MCP_PIN_NEW_BACKENDS=tofu|review`).
- **Servers tab no longer shows backend secrets.** `GET /admin/config` masks
  `bearerToken`, `apiKey`, secret-looking env values and args, and URL credentials
  as dots plus the last 4 characters (same format as the import preview). An env
  value counts as secret when its name sounds like one (`*_PASS`, `*_TOKEN`,
  `*_PW`, ...) or the value looks like a token; harmless ones such as
  `LOG_LEVEL=debug` are shown as they are. On save, a value
  left masked keeps the stored secret, including across a backend or env-var
  rename; a replaced value is written as typed. A masked value that was partly
  edited, or that doesn't match anything stored for that backend, is refused with
  a 400 instead of being written to disk.
- Saving on the Servers tab no longer deletes the top-level `proxy` (retry)
  settings and `serverToolnameSeparator` from `mcp_server.json`. The tab sent
  only `mcpServers`, and the save replaces the whole file.
- **ssh-mcp host groups in the admin UI.** The Servers tab shows each ssh-mcp
  backend's effective policy tier (`--group`, or `prod` by default with a warning)
  and approval state, filters the list by group, and edits `--group` /
  `--disableApproval` in place. TOML-configured backends show their profiles' groups
  read-only. The Add Server wizard now asks for a group instead of leaving new hosts
  on `prod` silently. See
  [configuration.md](docs/configuration.md#ssh-mcp-host-groups).

### Dependability

- **Backend crash recovery.** Before this, a stdio backend whose process died stayed
  dead until a restart: calls failed with a generic "after 2 retries" error, and a
  reload made its tools vanish (`-32601`). Now:
  - the gateway notices a dead backend (process exit, closed transport, an HTTP
    backend that stops answering) and reconnects it with exponential backoff and
    jitter;
  - flap protection marks a crash-looping backend **failed** (5 crashes in 10
    minutes by default; `MCP_BACKEND_FLAP_MAX`, `MCP_BACKEND_FLAP_WINDOW_MIN`);
  - while a backend is down its tools stay listed and calls get error `-32013`:
    "Backend "x" is down since …" or "… failed after repeated crashes; an admin
    must reconnect it";
  - a reload reconnects dead and failed backends, not just changed ones;
  - new admin API `GET /admin/server/status` and
    `POST /admin/server/reconnect/<name>`, with a state dot and a **Reconnect**
    button on the Servers tab;
  - reconnected tools go through the tool pins again, and collapse, lazy and
    search follow;
  - each transition is logged and audited as `event: "backend"`.

  See [configuration.md](docs/configuration.md#backend-crash-recovery).

### Tool list size

- **Tool collapsing** (opt-in, `MCP_COLLAPSE_TOOLS=true`, per-user `collapseTools`).
  Tools that several backends of the same kind expose identically are listed once,
  with a `host` argument whose enum is filtered by the caller's tool policy, instead
  of once per backend. For a fleet of ssh-mcp hosts this removes about 90% of the
  `tools/list` payload. Calls are rewritten to the real backend tool before
  authorization, trifecta, audit and rate limiting, so those behave exactly as
  before. Per-host names stay callable. See
  [configuration.md](docs/configuration.md#tool-collapsing).
- **Lazy backends** (opt-in per backend, `"lazy": true` in `mcp_server.json`). The
  backend is listed as one `<backend>__activate` tool instead of its real tools.
  Four gateway tools serve every lazy backend:
  - `patchbay__search_tools`: BM25 over every tool the caller may use, returning the
    top hits with class and how to use each.
  - `patchbay__describe_tool`: one tool's schema.
  - `patchbay__call_read` and `patchbay__call_write`: run a tool by `backend/tool`.

  `activate` adds the real tools to that session only and sends
  `notifications/tools/list_changed`, which the gateway now declares. `call_read` runs
  only tools classed read (the new `toolClass` section of `tool_policy.json`, or the
  backend's `readOnlyHint`; unknown is write), so clients can auto-approve it. Only
  tools the caller's policy allows are listed, counted, searched, described or
  activated. Calls are authorized, classified, rate-limited and audited as the real
  tool, with `via`. Lazy backends never collapse. The Servers tab has a **Lazy**
  checkbox and a **Description** field. See
  [configuration.md](docs/configuration.md#lazy-backends).
- **Fix:** backend progress notifications now reach the client. The gateway passed the
  client's `progressToken` to the backend but never routed the backend's progress
  back, so the SDK dropped every update as "unknown token". The gateway now gives the
  backend its own token and relays updates under the client's token, on every call
  path. Its own routing also avoids an SDK race that lost the last update when it
  arrived together with the result. The client's other `_meta` keys are now passed to
  the backend too; before, only `progressToken` was.
- `tools/list` now passes a backend tool's `title`, `annotations` and `outputSchema`
  through unchanged. Previously only the name, description and input schema reached
  clients, so read-only and destructive hints were lost.
- **Fix:** collapsed tools now carry `title`, `annotations` and `outputSchema` too.
  `ssh__read-command` had lost ssh-mcp's `readOnlyHint`. These fields are now part of
  what must match for tools to collapse, so a host whose hints differ keeps its own
  per-host tool and hints. A `toolClass` write rule still beats `readOnlyHint`.

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

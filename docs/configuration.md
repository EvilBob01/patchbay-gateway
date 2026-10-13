# Configuration reference

Patchbay Gateway is configured with environment variables plus a few JSON files in
its config directory: `config/` in the install directory, or `PATCHBAY_CONFIG_DIR`
when set (the installer uses `/var/lib/patchbay/config`; `npx patchbay-gateway` uses
`~/.patchbay-gateway/config`). With the systemd unit from [install.md](install.md),
the environment comes from `/etc/patchbay-gateway.env`. This page writes the files as
`config/<name>` either way.

- [Environment variables](#environment-variables)
- [`config/mcp_server.json`: backend servers](#configmcp_serverjson-backend-servers)
- [Importing from a client config](#importing-from-a-client-config)
- [`config/tool_config.json`: tool overrides](#configtool_configjson-tool-overrides)
- [Tool collapsing](#tool-collapsing)
- [Lazy backends](#lazy-backends)
- [Backend crash recovery](#backend-crash-recovery)
- [`config/users.json`: per-user tokens](#configusersjson-per-user-tokens)
- [`config/tool_policy.json`: authorization and trifecta](#configtool_policyjson-authorization-and-trifecta)
- [Rate limits](#rate-limits)
- [Audit log](#audit-log)
- [Other files in `config/`](#other-files-in-config)

> **Config directory.** With `PATCHBAY_CONFIG_DIR` set, every file in this page is
> read from that directory. Without it, `mcp_server.json` and `tool_config.json` are
> read from `./config/` in the process's working directory and every other file from
> `config/` in the install directory; set `WorkingDirectory=` to the install
> directory, as the sample unit does, and they are the same place. `MCP_USERS_PATH`
> and `MCP_TOOL_POLICY_PATH` still override single files.

## Environment variables

Booleans are `true` exactly unless noted. Anything else, including `1` or `yes`, counts
as false.

### HTTP server and admin UI

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3663` | TCP port for `/mcp`, `/sse`, `/message` and `/admin`. |
| `BIND_HOST` | *(all interfaces)* | Address to listen on, e.g. `127.0.0.1` or one LAN address. Unset listens on every interface; restrict access with a firewall either way ([install.md §5](install.md#5-firewall)). `npx patchbay-gateway` defaults it to `127.0.0.1`. |
| `PATCHBAY_CONFIG_DIR` | `<install dir>/config` | Directory holding `mcp_server.json`, `users.json`, `tool_policy.json` and the other runtime files. The installer sets `/var/lib/patchbay/config` so upgrades can replace the code directory. |
| `ENABLE_ADMIN_UI` | off | `true`, `1` or `yes` (case-insensitive) serves the admin UI at `/admin`. Leave it unset on a gateway nobody administers through the browser. The terminal, install runner and key push need their own switches on top of this ([Opt-in admin features](#opt-in-admin-features)). |
| `ADMIN_USERNAME` | `admin` | Admin UI login name. |
| `ADMIN_PASSWORD` | *(none, required)* | Admin UI password. **There is no default.** If `ENABLE_ADMIN_UI` is on but this is unset, empty, or a placeholder (`REPLACE_ME`, `password`, `change-me`, `changeme`, `admin`), the gateway logs `Admin UI NOT enabled` and serves the MCP endpoints without the admin UI. |
| `SESSION_SECRET` | *(generated)* | Signs admin session cookies. If unset, a random secret is generated once and stored in `config/.session_secret` (mode 0600). |
| `ADMIN_SESSION_HOURS` | `720` | Admin login lifetime, refreshed on every request (rolling). Sessions are in memory, so a restart logs everyone out. |
| `ADMIN_LOGIN_MAX_ATTEMPTS` | `10` | Failed logins allowed per client IP per window before `/admin/login` answers 429. |
| `ADMIN_LOGIN_WINDOW_MINUTES` | `15` | Length of that window. |
| `NODE_ENV` | *(unset)* | **Leave unset when serving the admin UI over plain HTTP.** `production` marks the session cookie `Secure`, and browsers won't send a Secure cookie back over HTTP. Login then appears to succeed and every following page fails with 401. Set it only when a TLS-terminating proxy is in front. |
| `GATEWAY_CLIENT_NAME` | `patchbay` | The MCP server name generated client configs and installers use (the client sees tools as `<name>` → `server__tool`). Also shown in the admin UI title and favicon. |
| `GATEWAY_UI_COLOR` | *(none)* | Accent colour for the admin header and favicon, as any CSS colour. **Quote hex values** in a systemd env file (`GATEWAY_UI_COLOR="#1e7e34"`): an unquoted `#` starts a comment there. |
| `LOGGING` | `info` | Console log level: `debug`, `info`, `warn` or `error`. |

### MCP client authentication

| Variable | Default | Meaning |
|---|---|---|
| `ALLOWED_TOKENS` | *(none)* | Comma-separated static tokens accepted as `Authorization: Bearer <token>`. |
| `ALLOWED_KEYS` | *(none)* | Comma-separated static keys accepted as `X-Api-Key: <key>` or `?key=<key>`. |

If neither is set **and** `config/users.json` has no users, authentication is off and
every caller is `anonymous`. Static credentials resolve to the identity `static`, which
is shared and can't be attributed to a person. Prefer per-user tokens
([users.json](#configusersjson-per-user-tokens)), which are accepted in all three
forms.

### Sessions and naming

| Variable | Default | Meaning |
|---|---|---|
| `MCP_SESSION_IDLE_MINUTES` | `30` | A client session with no traffic for this long is closed. Its trifecta state goes with it. |
| `SERVER_TOOLNAME_SEPERATOR` | `__` | Separator between server and tool in exposed names (`web01__read-command`). At least 2 characters from `A–Z a–z 0–9 _ -`. Note the upstream spelling, *SEPERATOR*. |

### Security features

| Variable | Default | Meaning |
|---|---|---|
| `MCP_USERS_PATH` | `config/users.json` | Location of the per-user token file. |
| `MCP_TOOL_POLICY_PATH` | `config/tool_policy.json` | Location of the authorization and trifecta policy. |
| `MCP_AUDIT_DIR` | `/var/log/patchbay-gateway/audit` | Directory for the audit log. Created if missing. (If unset, and only the pre-rename `/var/log/mcp-gateway-audit` exists, that is used, with a deprecation warning.) If it can't be created, the gateway logs an error and keeps serving without an audit trail. |
| `MCP_AUDIT_DISABLE` | off | `true` turns the audit log off. |
| `MCP_AUDIT_LOG_ARGUMENTS` | off | `true` also records tool **arguments**. They can contain command lines, file paths, mail contents and secrets, so think before you enable it. Tokens are never recorded. |
| `MCP_AUDIT_MAX_FILE_MB` | `64` | A day's file is rolled to `<file>.<epoch>` once it reaches this size. |
| `MCP_AUDIT_RETENTION_DAYS` | `14` | Audit files older than this are deleted (checked hourly). |
| `MCP_RATE_LIMIT_DISABLE` | off | `true` turns both rate limiters off. |
| `MCP_RATE_LIMIT_TOOL_CALL_BURST` | `60` | `tools/call` bucket size per identity. |
| `MCP_RATE_LIMIT_TOOL_CALL_PER_MINUTE` | `120` | `tools/call` refill rate per identity. |
| `MCP_RATE_LIMIT_HTTP_BURST` | `120` | Bucket size for every authenticated request on `/mcp`, `/sse` and `/message`. |
| `MCP_RATE_LIMIT_HTTP_PER_MINUTE` | `300` | Refill rate for that bucket. |
| `MCP_MERGE_TEXT_CONTENT` | off | `true` joins adjacent plain-text blocks in tool results, for clients that read only the first block (for example the OpenAI Responses API remote MCP tool). A per-user `mergeTextContent` overrides it. |
| `MCP_COLLAPSE_TOOLS` | off | `true` publishes a tool that several backends expose identically once, with a `host` argument, instead of once per backend. See [Tool collapsing](#tool-collapsing). A per-user `collapseTools` overrides it. |
| `MCP_PIN_TOOLS` | on | Rug-pull protection. Only the exact value `false` turns it off. See [Rug-pull protection](#rug-pull-protection). |
| `MCP_PIN_NEW_BACKENDS` | `tofu` | `review` holds every tool of a newly added backend until approved; `tofu` trusts a new backend's first definitions. |
| `MCP_TOOL_PINS_PATH` | `config/tool_pins.json` | Where approved definitions are stored. |

### Backend tool-call retries

A `tools/call` that fails with a timeout (`-32001`) or a lost connection is retried
with exponential backoff and jitter **only when the tool is classed read**: the
delay is `base × 2^(attempt−1)` plus up to 50% of the base. The class is the one
`call_read` uses: a `toolClass.write` pattern, then a `toolClass.read` pattern, then
the backend's own `readOnlyHint: true`; anything else counts as write (see the
[`toolClass` section](#toolclass-section)).

A write or unclassified tool is **not** retried. A timeout or a lost connection
does not prove the call did not run, and a replay could repeat its side effects.
The client gets the error at once, with its original code, a message saying it was
not retried, and `error.data.notRetried = {"reason": "not-read"}`. The client
decides whether to call again.

Recovering the transport is separate and happens whatever the tool's class: a
stdio backend whose process exited, or an HTTP backend that then fails a `ping`,
is marked down and reconnected ([Backend crash recovery](#backend-crash-recovery)),
and an SSE backend is reconnected before its next call.

Every attempt, retries included, is checked again right before it is sent. If the
tool was put on hold by the tool pins meanwhile, removed, given a different
definition, denied to the caller by a policy change, its backend went down, or (on
a retry) the session's lethal-trifecta state now blocks it, the call is not sent
and the client gets that error (`-32012`, `-32601`, `-32003`, `-32013`, `-32010`).
A definition that changed but is served (approved meanwhile, or pins off) is
refused with `-32012` and `error.data.pendingReview.reason = "definition-changed"`:
list the tools and call again. The audit line of such a call has `retryRefused`
(`not-read`, `held`, `removed`, `definition-changed`, `denied`, `backend-down`,
`trifecta`), and every dispatched call has `attempts`.

| Variable | Default |
|---|---|
| `RETRY_STDIO_TOOL_CALL` / `STDIO_TOOL_CALL_MAX_RETRIES` / `STDIO_TOOL_CALL_RETRY_DELAY_BASE_MS` | `true` / `2` / `300` |
| `RETRY_SSE_TOOL_CALL` / `SSE_TOOL_CALL_MAX_RETRIES` / `SSE_TOOL_CALL_RETRY_DELAY_BASE_MS` | `true` / `2` / `300` |
| `RETRY_HTTP_TOOL_CALL` / `HTTP_TOOL_CALL_MAX_RETRIES` / `HTTP_TOOL_CALL_RETRY_DELAY_BASE_MS` | `true` / `2` / `300` |

These environment variables always win. A `proxy` section in `mcp_server.json` is
ignored. They apply to read tools only.

A call to a backend that is down is not retried: it fails at once with error
`-32013` (see [Backend crash recovery](#backend-crash-recovery)).

### Backend crash recovery

| Variable | Default | Meaning |
|---|---|---|
| `MCP_BACKEND_RECONNECT_BASE_MS` | `1000` | First reconnect delay. Each further attempt doubles it. |
| `MCP_BACKEND_RECONNECT_MAX_MS` | `60000` | Longest delay between attempts. |
| `MCP_BACKEND_FLAP_MAX` | `5` | A backend that goes down this many times… |
| `MCP_BACKEND_FLAP_WINDOW_MIN` | `10` | …within this many minutes is marked **failed** and no longer reconnected automatically. |
| `MCP_BACKEND_RECONNECT_CONCURRENCY` | `3` | Most reconnect attempts in flight at once, across all backends. |

### Admin UI features

| Variable | Default | Meaning |
|---|---|---|
| `TOOLS_FOLDER` | *(none)* | Parent directory for a stdio server's install commands when the server has no `installDirectory`. Each server installs into `<TOOLS_FOLDER>/<server-key>`. |
| `INSTALLER_BASE_DIR` | `/opt/patchbay-installer-base` | Prebuilt payload for the Windows client installer ([client-setup.md](client-setup.md#windows-installer-bundle)). |
| `SSH_PUBLIC_KEY_PATH` | `~/.ssh/id_ed25519.pub` of the service user | Public key the **Deploy Key** tab appends to a host's `authorized_keys`. The matching private key (same path without `.pub`) is the default `--key` the Add Server wizard offers for SSH backends. |
| `MAIL_ACCOUNTS_PLAINTEXT_PATH` | `/etc/imap-mcp-accounts.json` | File the **Mailboxes** tab writes for the mail connector (see [Mailboxes](#mailboxes-mail_accountsjson)). |
| `EXTERNAL_REGISTRY_QUERY` | `mcp server` | npm search query for the browse-only part of the **Catalog**. |
| `EXTERNAL_REGISTRY_SIZE` | `50` | Number of npm results to show. |
| `MCP_REGISTRY_URL` | `https://registry.modelcontextprotocol.io/v0/servers` | MCP registry the Catalog reads. |
| `MCP_REGISTRY_MAX_PAGES` | `6` | Registry pages fetched (about 100 entries each). Results are cached for an hour. |

### Opt-in admin features

Three admin UI features act on the gateway host or log in to other hosts. Each one has
its own switch, **off by default**, and needs `ENABLE_ADMIN_UI` as well. Like
`ENABLE_ADMIN_UI`, each accepts `true`, `1` or `yes` (case-insensitive).

| Variable | Default | Turns on | Risk |
|---|---|---|---|
| `PATCHBAY_ENABLE_TERMINAL` | off | The **Terminal** tab (`/admin/terminal/*`): an interactive shell in the browser, running as the service user. | Anyone with the admin password gets a shell on the gateway host. Where the service runs as root, that is a root shell. |
| `PATCHBAY_ENABLE_INSTALL_RUNNER` | off | The **Check/Run Install** button on a stdio backend (`POST /admin/server/install/<key>`). It runs that backend's `installCommands` on the gateway host. | Runs commands taken from admin-editable config. No shell is used and the program must be on a short allowlist (package managers, `git`, `python`, `make`, ...), but those can fetch and run arbitrary code. |
| `PATCHBAY_ENABLE_DEPLOY_KEYS` | off | The **Deploy Key** form and the Add Server wizard's *Install it now* option (`POST /admin/deploy-key`). Each logs in to a host once with a password and appends the gateway's public key to `authorized_keys`. | A target host's password passes through the gateway (it isn't stored or logged), and the gateway gains lasting access to that host. |

When a switch is off, its routes are **not mounted**: a request gets 404, whoever sends
it. The admin UI hides the matching tab or button and says *Disabled by the
administrator (set … to enable)*. The Deploy Key tab still shows the gateway's public
key (`GET /admin/deploy-key/public-key`), so you can add it to a host by hand, e.g.
with `ssh-copy-id`.

At startup the gateway logs the effective state, e.g.
`Admin features: terminal=off, install-runner=off, deploy-keys=on`.

The **Terminal** tab's shell inherits the gateway's environment minus anything named
`ADMIN_*`, `ALLOWED_*` or `SESSION_*`, or ending in `_SECRET`, `_PASSWORD`, `_PASS`,
`_TOKEN`, `_KEY`, `_KEYS` or `_CREDENTIALS`.

The install runner streams each command's output to the admin's browser only. The
journal gets the command, its exit code and how many lines it printed, because
install output can contain registry tokens or other credentials.

---

## `config/mcp_server.json`: backend servers

The servers the gateway connects to. The **Servers** tab edits this file; **Reload**
applies the change in-process. Only servers whose entry changed are reconnected.

```json
{
  "mcpServers": {
    "web01": {
      "type": "stdio",
      "name": "web01 (ssh)",
      "command": "npx",
      "args": ["-y", "ssh-mcp", "--", "--host=192.0.2.10", "--user=ops", "--key=/home/patchbay/.ssh/id_ed25519", "--group=prod"],
      "env": {}
    },
    "files": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv/shared"]
    },
    "db01": {
      "type": "sse",
      "url": "http://192.0.2.20:8080/sse",
      "bearerToken": "…"
    },
    "docs": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "apiKey": "…",
      "active": false
    }
  }
}
```

The key (`web01`) is the server's identity everywhere else. Tools are exposed as
`web01__<tool>`, and the tool policy, trifecta rules and audit log use `web01` as the
backend name. Keys used with the install runner must match `^[a-zA-Z0-9_-]{1,64}$`.

| Field | Types | Meaning |
|---|---|---|
| `type` | all | **Required.** `stdio`, `sse` or `http` (streamable HTTP). |
| `name` | all | Display name in the admin UI. |
| `active` | all | `false` (or `"false"`) keeps the entry but doesn't connect it. Default `true`. |
| `lazy` | all | `true` lists only three meta-tools for this backend until a session activates it. See [Lazy backends](#lazy-backends). Default `false`. |
| `description` | all | One line about the backend, shown in its lazy meta-tools' descriptions. |
| `command` | stdio | Executable to start. |
| `args` | stdio | Argument array. |
| `env` | stdio | Extra environment for the child, layered on the gateway's own environment. |
| `installDirectory` | stdio | Where the admin UI's **Install** runs `installCommands`. |
| `installCommands` | stdio | Commands run in order by **Install**. They are split into arguments without a shell, so `&&`, `|`, `>` and `$` have no special meaning. The first word must be one of `npm npx pnpm yarn bun bunx pip pip3 python python3 uv uvx poetry git go cargo make`. |
| `url` | sse, http | Backend endpoint. |
| `bearerToken` | sse, http | Sent as `Authorization: Bearer …`. |
| `apiKey` | sse, http | Sent as `X-Api-Key: …` when no `bearerToken` is set. |

### ssh-mcp host groups

[ssh-mcp](https://www.npmjs.com/package/ssh-mcp) checks every command against a
role × host-group matrix (its README, "Policy Engine"). A quick-start backend
(`--host`/`--user`) runs as `admin`, which may run every command class on `dev` and
`staging` but gets no `privileged` (sudo, `privileged-command`) on `prod`. The group
comes from `--group=prod|staging|dev`; **without `--group` ssh-mcp uses `prod`** on
purpose, and any other value stops it from starting. `--disableApproval` runs
destructive and sudo commands without the confirmation prompt (quick-start profile only).

The **Servers** tab shows each ssh-mcp backend's effective group and approval state as
badges, warns when the group is `prod` only because `--group` is missing, and filters
the list by group. Each ssh-mcp server has an **ssh-mcp policy** section: the group
dropdown and approval toggle rewrite only the `--group=` and `--disableApproval` args,
leaving every other argument and its position alone, and **Save & Reload** reconnects
that backend. The **Add Server** wizard asks for a group and always writes `--group=`.

A backend started with `--config=<file>.toml` keeps a group per `[[profiles]]` entry.
The gateway reads that file read-only and returns only each profile's `name` and
`group` to the admin UI (`GET /admin/ssh-policy`); hosts, users, keys, passwords and
every other line stay on the server. A profile without `group` gets one from its name
(`prod`, `staging`, `dev`/`local`/`test`/`sandbox`), and otherwise `prod`. Change TOML
groups in the file itself. Reload only reconnects servers whose entry in this file
changed, so afterwards deactivate and reactivate the server (or restart the gateway).
Custom groups need matching `[policy.roleBindings]` in the same file.

## Importing from a client config

The **Servers** tab's **Import from client config** button turns an MCP client's config
file into gateway backends. Paste the file or upload it; the gateway shows a preview of
every entry, and imports the ones you tick, then reloads (no restart).

Supported formats (JSON; comments and trailing commas are accepted):

| Client | File | Shape |
|---|---|---|
| Claude Desktop | `claude_desktop_config.json` | `{"mcpServers": {...}}` |
| Claude Code | `.mcp.json`, top level of `~/.claude.json` | `{"mcpServers": {...}}`, with `type` `stdio`/`http`/`sse` |
| Cursor | `~/.cursor/mcp.json`, `.cursor/mcp.json` | `{"mcpServers": {...}}` |
| Windsurf | `mcp_config.json` | `{"mcpServers": {...}}` (`serverUrl` accepted for `url`) |
| Cline | `cline_mcp_settings.json` | `{"mcpServers": {...}}` (`disabled` honoured) |
| VS Code | `.vscode/mcp.json`, or `settings.json` | `{"servers": {...}}` or `{"mcp": {"servers": {...}}}` |

How entries are converted:

- **stdio** entries (`command`, `args`, `env`) become `type: "stdio"` backends. The
  Windows launcher `cmd /c <cmd> …` is unwrapped, and shims like `npx.cmd` become
  `npx`. On a Linux gateway, entries whose command or arguments are Windows paths
  (`C:…`), relative paths (`./server.js`), or that run through PowerShell are shown
  but **can't be imported**. Absolute paths that don't exist on the gateway host, a
  command missing from its `PATH`, `~` (not expanded), `envFile` and `cwd` (not
  supported) produce warnings.
- **Remote** entries (`url`) become `sse` when `type` says so or the path ends in
  `/sse`, otherwise `http` (streamable HTTP). `Authorization: Bearer …` maps to
  `bearerToken` and `X-Api-Key` to `apiKey`; other headers and OAuth settings are
  dropped with a warning.
- **Placeholders** such as VS Code's `${input:…}` or `${env:…}` are imported as
  literal text with a warning; edit them on the Servers tab afterwards.
- `disabled: true` imports the entry as inactive.
- Imported backends are new backends to [rug-pull protection](#rug-pull-protection):
  with the default `MCP_PIN_NEW_BACKENDS=tofu` their tools go live at once; with
  `review` they wait in the **Review** tab until approved.
- **Names** are cleaned to `[a-zA-Z0-9_-]`. If a backend with that name exists, the
  preview proposes `name-2` (editable), or you can tick **Replace** to overwrite it.

**Secrets.** The preview and the Servers tab mask the same *recognised credential
fields*, shown as dots, at most the last 4 characters and the length:

- `bearerToken` and `apiKey`;
- env values and arguments under a secret-sounding name, whatever the value looks like
  (`PASSWORD=/x…`, `--password=…`, `--password …`, `--api-key …`). The name contains
  `key`, `token`, `secret`, `pass`/`password`/`passwd`, `pwd`, `auth`, `credential`,
  `private`, `session`, `cookie`, `dsn` or `conn[ection]_str`, or has `pw`, `pin`,
  `sig`, `salt` or `cert` as a whole `-`/`_` part;
- values that look like tokens under any name: known prefixes (`sk-`, `ghp_`,
  `github_pat_`, `glpat-`, `xox?-`, `AKIA`, `eyJ`, …) and, for env, 20+ letters and
  digits with no spaces;
- passwords in URLs (`scheme://user:…@host`) and query parameters named like
  `key`, `token`, `secret`, `pass`, `auth` or `sig`.

File paths are shown under path-field names, because they say where a secret lives
rather than what it is: a name ending in `path`, `file`, `dir`, `filename`, `keyfile`,
`keypath`, `cert`, `cacert` or `ca` (`SSH_KEY_PATH`, `PASSWORD_FILE`, `--key-file`), or
the flags `--key`, `--identity` and `--identity-file` (ssh-mcp's `--key=/root/.ssh/…`),
and only while the value starts with `/`, `./`, `~/` or a drive letter. A credential under
a name that says nothing (`-p <value>`, a bare positional password) is **not**
recognised and is shown as it is; put such values in a named env var or flag. The full
entries stay on the gateway, tied to your admin session for 15 minutes, and are never
sent back to the browser; the import step refers to them by id. Imported values are
stored exactly like any other backend's: in `config/mcp_server.json`, in plain text, so
keep that file `0600` and owned by the service user.

The same flow is available as an API, behind the admin login like every other
`/admin` route and accepting `application/json` only:

| Request | Body | Response |
|---|---|---|
| `POST /admin/import/preview` | `{"text": "<file contents>"}` | `{"previewId", "format", "entries": [{id, sourceName, key, clash, importable, issues, …masked fields}]}` |
| `POST /admin/import/apply` | `{"previewId", "selections": [{"id", "key", "replace"}]}` | `{"success", "imported": [keys], "reloaded"}` |

## `config/tool_config.json`: tool overrides

Written by the **Tools** tab. Keys are the qualified tool names (`server__tool`):

```json
{
  "tools": {
    "web01__privileged-command": { "enabled": false },
    "files__read_text_file": { "enabled": true, "exposedName": "read_shared_file", "exposedDescription": "Read a file from the shared drive." }
  }
}
```

A disabled tool is not offered to anyone and can't be called. Renames and new
descriptions are cosmetic: authorization, trifecta rules and the audit `backend` field
always use the original names. Missing file means every tool is enabled.

A backend tool's `title`, `annotations` (such as `readOnlyHint` and `destructiveHint`)
and `outputSchema` are passed through to clients unchanged and can't be overridden.
Collapsed tools carry them too (see [Tool collapsing](#tool-collapsing)).

## Tool collapsing

Several backends often expose the same tool definitions. Every ssh-mcp backend,
for example, offers the same 14 tools, so each extra ssh host adds about 2,000
tokens to every session's tool list. With `MCP_COLLAPSE_TOOLS=true`, such tools are
listed once:

| Off (default) | On |
|---|---|
| `web01__run-command`, `db01__run-command`, `app01__run-command` | `ssh__run-command` with a required `host` argument: `"enum": ["app01", "db01", "web01"]` |

**What collapses.** Grouping is automatic:

- Only backends of the same recognised kind are candidates. That is the kind the
  trifecta check detects from the command line (`ssh-mcp`, `imap-mcp`, `catalog`,
  `context7`), or the one pinned in `trifecta.backendKinds`. Backends of unknown kind
  never collapse.
- For each tool name, the published definition (description, `inputSchema`,
  `title`, `annotations` and `outputSchema`) must match exactly. Key order doesn't
  matter. If some backends differ,
  the largest group of identical ones collapses and the others keep their own names.
  A backend with a missing tool, an extra tool or an older schema version therefore
  stays separate for just those tools.
- A tool is never collapsed if it's renamed or re-described in `tool_config.json`,
  if its schema already has a `host` property, or if the collapsed name would clash
  with an existing tool name. Startup and reload log why a tool was left separate.
- The collapsed name is the kind without `-mcp`, the separator and the tool name
  (`ssh__run-command`). The description is the original plus one line saying the tool
  runs on several hosts. `title`, `annotations` (such as `readOnlyHint`) and
  `outputSchema` are the members' own, unchanged. Hints are compared, never merged:
  a host whose `readOnlyHint` or `destructiveHint` differs stays separate and keeps
  its own.

**Per caller.** The `host` enum lists only the hosts whose real `backend/tool` the
caller's tool policy allows. A caller who may use none of them doesn't see the tool.

**Calls.** `ssh__run-command {"host": "db01", ...}` is rewritten to `db01__run-command`
with `host` removed, before anything else happens. Authorization, trifecta
classification and session state, rate limits, text merging and the audit
`toolKey` and `backend` fields all use the real backend tool, exactly as without
collapsing. So does read/write classification for `call_read`: the real tool's
`readOnlyHint` counts, and a `toolClass` write pattern still beats it. The audit
`tool` field records the name the client used. A missing or
unknown `host` is refused with `-32602`, naming the hosts the caller may use. A host
the policy denies is refused with `-32003`, as usual.

**Old names.** The per-host names (`db01__run-command`) are no longer listed but
can still be called, so existing prompts and skills keep working.

**Reloads.** Groups and enums are recomputed whenever backends or `tool_config.json`
change, and a client sees the result on its next `tools/list`. The gateway doesn't
send `notifications/tools/list_changed`.

**Per user.** `"collapseTools": true|false` on a user in `users.json` overrides the
gateway-wide setting in either direction.

## Lazy backends

Some clients, such as Claude Desktop, ChatGPT and Cursor, put every tool definition in
front of the model in every conversation, including those of backends the conversation
never uses. Mark such a backend `"lazy": true` in `mcp_server.json` (or tick **Lazy**
in the Servers tab), optionally with a one-line `"description"`:

```json
"hv": { "type": "stdio", "command": "…", "lazy": true, "description": "Hypervisor: VMs, containers, storage" }
```

`tools/list` then shows one small tool for it instead of its real ones, plus four
gateway tools that serve every lazy backend at once:

| Meta-tool | What it does |
|---|---|
| `hv__activate` | Adds the backend's real tools to **this session's** tool list and sends `notifications/tools/list_changed`. A client that honours it re-fetches the list, and the tools become ordinary tools: their own names, schemas, annotations and per-tool approval in the client. |
| `patchbay__search_tools` | `{"query": "…", "backend"?: "…", "limit"?: n}`. Ranks every tool the caller may use, lazy or not, by name, description and parameter names (BM25, in-process). Returns the top 5 by default (at most 15). Ties at the cutoff are all returned, up to 25. Each hit carries the `backend/tool` name, "backend: first sentence of the description", a score, its `read`/`write` class and how to use it from here. With `backend` and no query, it lists that backend's tools. Schemas are never inline. |
| `patchbay__describe_tool` | `{"tool": "hv/list_vms"}` returns one tool's full description, input schema, annotations and class. |
| `patchbay__call_read` | `{"tool": "hv/list_vms", "arguments": {…}}` runs a **read** tool. It refuses a write tool, pointing to `call_write`. |
| `patchbay__call_write` | The same for any tool, including those that change things. |

`call_read` and `call_write` are the fallback for clients that ignore `list_changed`.
They are split because clients approve per tool name. You can auto-approve
`patchbay__call_read` and still be asked before every `patchbay__call_write`. Which tools
count as read is set by the [`toolClass` section](#toolclass-section) of the tool
policy and the backend's own `readOnlyHint`. **Anything unclassified is write.** Tools
reached by name, including activated ones, are not affected.

The cost is fixed: one tool per lazy backend plus four, however many tools those
backends have. The gateway tools are listed only to a caller who can reach at least
one lazy tool, so a gateway without lazy backends lists exactly what it did before.

**`activate` or `call_*`?** Activating changes the session's tool list. Many clients
cache the prompt prefix that holds the tool definitions, and a changed list
invalidates that cache, so the next turn re-sends the definitions at full cost.
`search_tools` with `call_read`/`call_write` leaves the list unchanged. Use them for
one-off use, and `activate` when a session will use a backend a lot (the tools then
get their own names and per-tool approval). The meta-tools' descriptions say this to
the model.

**Activation** lasts for the MCP session and affects no other session. After it, that
session's list carries the real tools instead of `hv__activate`. The notification is
sent on the `activate` call's own response stream, so a streamable-HTTP client needs
no separate GET stream to receive it.

**Policy.** What a caller may not use is never listed, counted, searched, described or
activated. Search ranks only over the caller's own tools, so scores say nothing about
the rest. A caller who may use nothing on a backend doesn't see its `activate` tool.
One who can reach no lazy tool at all doesn't see the gateway tools, and calling them
answers like an unknown tool. In `describe_tool`, a denied tool reads the same as one
that doesn't exist. `call_read` and `call_write` are rewritten to the real `hv/<tool>`
before anything else happens. Authorization, trifecta classification and session
state, rate limits (one token per call), text merging and the audit log therefore all
see the real tool, exactly as for a direct call. A denied or unknown tool is refused
with the same error as a direct call; `call_read` reveals a tool's class only to a
caller who may use it.

**Progress and `_meta`.** On every call path (direct, collapsed and `call_*`), the
client's `_meta` is passed to the backend. If the client sent a `progressToken`, the
backend's progress notifications are relayed back under that token, on the calling
request's stream.

**Direct calls.** A lazy backend's real tool names stay callable without activation,
subject to the tool policy as always. Hiding tools is not a security boundary; the
policy is.

**With tool collapsing.** Lazy backends never collapse: behind one meta-tool there is
nothing left to save, and once activated their tools keep their own names. Search
returns a collapsed tool once, naming the hosts the caller may use.

**Name clash.** If a real tool's name equals a meta-tool name (`hv__activate`, or a
backend called `patchbay` with a tool called `search_tools`), the meta-tool wins and
startup logs a warning. The real tool is still reachable with `call_read` or
`call_write`.

**Client support** for `notifications/tools/list_changed` varies. VS Code and Zed
re-fetch the tool list. OpenAI's Codex CLI only logs it. ChatGPT needs a manual
**Refresh** in its connector settings. For those clients, use search and
`call_read`/`call_write`. Check your client's documentation.

## Backend crash recovery

The gateway watches every backend connection. A backend is **down** when its stdio
process exits, its transport closes, or an HTTP backend fails a call at the
transport level and then does not answer an MCP `ping`. A timeout alone never marks
a backend down.

- **Automatic reconnect.** A down backend is reconnected with exponential backoff:
  1 s, 2 s, 4 s … up to 60 s, each delay scaled by a random factor between 0.5 and
  1, so backends that died together don't retry together. At most 3 attempts run
  at once. A backend that could not be connected at startup or on a reload is
  retried the same way.
- **Flap protection.** A backend that goes down 5 times within 10 minutes is
  marked **failed**. Automatic reconnects stop and the gateway logs an error. It
  stays failed until an admin reconnects it, the config is reloaded, or its config
  changes. Failed connect attempts are not counted, only real crashes.
- **Explicit errors.** While a backend is down, its tools **stay listed**, so
  client tool lists, collapsed `host` enums and lazy search don't change under
  the client. A call to one of them returns error `-32013` at once:
  - `Backend "x" is down since <time> (reconnecting, attempt n; next try at <time>)`
  - `Backend "x" failed after repeated crashes (5 in 10 min) …; an admin must
    reconnect it`

  The error comes after authorization, so a caller who may not use the tool still
  gets the denial. It comes before the trifecta check, so a call that never reached
  a backend doesn't count against the session. The internal reason (exit, error
  text) is shown only to admins.
- **Consistent after a reconnect.** The backend's tools are re-listed through the
  tool pins, so a definition that changed while it was down is withheld for review
  ([Rug-pull protection](#rug-pull-protection)). Collapse groups, lazy indexes and
  search are rebuilt from the new definitions. Clients get
  `notifications/tools/list_changed` only if the backend's tools actually changed.
- **Reload** (`POST /admin/server/reload`) reconnects every backend whose config
  changed **and every backend that is down or failed**. A backend that still
  can't connect keeps its last-known tools listed and keeps being retried.
- **One connection operation per backend at a time.** Automatic reconnects, the
  admin reconnect, the SSE per-call reconnect, the mailbox editor's reconnect and
  a reload are serialized per backend, so two of them never leave two backend
  processes behind. A reload runs alone and waits for reconnects in progress. Two
  admin reconnects of the same backend at once make one reconnect. A reconnect
  waiting for a reload that removes its backend does not start it again.
- **Admin.**
  - `GET /admin/server/status` lists each active backend with `state` (`up`,
    `reconnecting`, `failed`), `since`, `attempt`, `nextRetryAt`, `lastError`,
    `recentCrashes`, `transport` and `tools`, plus the settings above.
  - `POST /admin/server/reconnect/<name>` reconnects one backend now, in any state,
    and clears its crash history. It returns 200 if the backend came up, 502 if
    not (it then keeps retrying), and 404 for an unknown backend (or one a
    concurrent reload removed).
  - The **Servers** tab shows a state dot per backend (hover for details) and a
    **Reconnect** button.
- **Logged and audited.** Each transition goes to the gateway log and the audit
  log as `event: "backend"`: `down`, `connect-failed`, `reconnected`, `failed` and
  `admin-reconnect`.

## Rug-pull protection

A backend can change a tool after you reviewed it: a new package version, a
compromised dependency, or a remote server that changes under you. The tool's
description goes straight into the model's context, so a silent change is a
prompt-injection channel.

The gateway pins every backend tool: it stores a SHA-256 hash of the backend's
definition (name, title, description, input and output schema, annotations) and
the definition itself in `config/tool_pins.json`. When a backend's tools/list
differs from the pin:

- the changed tool is **withheld**: it disappears from `tools/list`, search and
  lazy loading, and a call returns error `-32012` "pending admin review";
- a **new tool** on a known backend is withheld the same way;
- a **removed tool** just disappears (recorded; if it comes back unchanged it is
  served again);
- every other tool keeps working; each event goes to the gateway log and the
  audit log (`event: "tool-pin"`), and connected clients get
  `notifications/tools/list_changed`.

Review on the admin UI's **Review** tab: each pending tool shows an old-vs-new
diff with Approve and Reject, plus "Approve all for this backend". Approval takes
effect at once. Reject keeps it withheld; a further change shows up again.

Pins are checked on startup, live reload, backend reconnect (including an automatic
reconnect after a crash), when a backend sends
`tools/list_changed`, and on **Re-check now**.

**First start / upgrade:** with no pin file, every current tool is pinned
silently. **New backends:** by default (`MCP_PIN_NEW_BACKENDS=tofu`) a backend
you add is trusted on first use; set `review` to approve its tools first.
**Unreadable pin file:** the gateway fails closed (every tool withheld) and never
overwrites it; delete the file and press Re-check now to re-pin.

Overrides in `tool_config.json` (`exposedDescription`, `exposedName`) are yours
and are not pinned; a backend change is still caught underneath them.

## `config/users.json`: per-user tokens

Managed by the **Users** tab. Creating or revoking a user takes effect at once.

```json
[
  { "username": "alice", "token": "3f9c…(48 hex chars)", "createdAt": "2026-10-01T09:00:00.000Z" },
  { "username": "bob",   "token": "a71e…",                "createdAt": "2026-10-01T09:05:00.000Z", "mergeTextContent": true }
]
```

- A user's token is accepted as `Authorization: Bearer <token>`, `X-Api-Key: <token>`
  or `?key=<token>`.
- `mergeTextContent` (optional, hand-edited; the Users tab keeps it) overrides
  `MCP_MERGE_TEXT_CONTENT` for that user, in either direction.
- `collapseTools` (optional, hand-edited; the Users tab keeps it) overrides
  `MCP_COLLAPSE_TOOLS` for that user, in either direction.
- The file holds live secrets. Keep it mode 0600 and out of version control.

> **Use the Users tab, not a text editor.** The gateway loads the token list into
> memory at startup and on every change made through the admin UI. A token added by
> hand is rejected until the next restart. A token *removed* by hand keeps
> authenticating until the next restart, and meanwhile resolves to the shared `static`
> identity and its policy. The Users tab's **Revoke** takes effect immediately.

## `config/tool_policy.json`: authorization and trifecta

One file holds both checks. The gateway re-reads it whenever it changes, so edits apply
to the next request, including on open sessions. The Users tab has an editor for it,
which validates before saving. A hand edit that breaks the file **denies every tool
call** until it is fixed, and the gateway logs why.

### Authorization

```json
{
  "default": { "allow": [] },
  "static":  { "allow": ["*"] },
  "roles": {
    "readonly": { "allow": ["*/read-command", "*/list_*", "*/sftp-list", "files/read_*"] }
  },
  "users": {
    "alice": { "allow": ["*"], "deny": ["*/privileged-command"] },
    "bob":   { "role": "readonly", "deny": ["db01/*"] }
  }
}
```

| Key | Applies to |
|---|---|
| `users.<name>` | The user with that username in `users.json`. May name a `role` to inherit; its own `allow`/`deny` are added. |
| `roles.<name>` | Reusable rule sets referenced by `users.*.role`. |
| `static` | The `ALLOWED_TOKENS` / `ALLOWED_KEYS` credential. Falls back to `default`. |
| `default` | Everyone without their own entry, and every caller when authentication is off. **Absent means allow all.** |

Patterns are `"*"` or `"<backend-glob>/<tool-glob>"`, where `*` matches any run of
characters. A pattern without a `/` is rejected, so write `"web01/*"` for a whole
backend. Matching uses the **original** server key and tool name, not overrides.

Decision order: a matching **deny** refuses; otherwise a matching **allow** permits;
otherwise the call is refused (`not in allow list`). A rule with no `allow` allows
nothing.

Effect: refused tools are left out of the caller's `tools/list`, and a `tools/call` to
one returns JSON-RPC error `-32003` and is audited with `decision: "deny"` and the rule
that decided (for example `users.bob`). With no policy file, everyone may use every
enabled tool.

The policy covers **tools only**. Backend resources and prompts are aggregated but not
yet filtered.

### `trifecta` section

```json
{
  "trifecta": {
    "mode": "enforce",
    "unknown":      { "untrustedContent": true, "externalComm": true },
    "backendKinds": { "web01": "ssh-mcp", "mail": "imap-mcp" },
    "classify": {
      "files/*":           { "privateData": true, "untrustedContent": false, "externalComm": false },
      "search/*":          { "untrustedContent": true, "externalComm": true },
      "mail/*":            { "privateData": true },
      "mail/send_email":   { "privateData": false }
    },
    "allow": [
      { "identity": "report-bot", "tool": "mail/send_email",
        "reason": "nightly status mail; only reads host health" }
    ]
  }
}
```

| Key | Meaning |
|---|---|
| `mode` | `enforce` (default) refuses the completing call with `-32010`. `monitor` lets it through but logs and audits it, which is useful when rolling out. `off` disables the check. |
| `unknown` | Axes for tools of unrecognised backends. Default `untrustedContent` + `externalComm`. |
| `backendKinds` | Pin a backend to a built-in profile when command-line detection can't recognise it: `ssh-mcp`, `imap-mcp`, `catalog`, `context7` or `unknown`. |
| `classify` | Pattern → axes (`privateData`, `untrustedContent`, `externalComm`: `true`/`false`). Applied in file order on top of the backend's default, so put broad patterns first. Only the axes named change. **Watch out:** an unrecognised backend already starts as untrusted + external, so `{"privateData": true}` alone gives it all three, and a tool with all three is refused in every session (startup and reload log a warning for each one in `enforce` mode). Clear the other two axes explicitly, as `files/*` does above. |
| `allow` | The only way to let a completing call through. Each rule needs a `reason` and an `identity` (username or `static`), a `tool` pattern, or both. Every use is logged at WARN and audited with the reason. |

Built-in profiles, the reasoning behind them and the known limits are in
[TRIFECTA.md](../TRIFECTA.md). Without a `trifecta` section the defaults apply in
`enforce` mode. A file with *only* a `trifecta` section leaves authorization at
allow-all.

### `toolClass` section

Sorts tools into **read** and **write** for the [lazy backends'](#lazy-backends)
`patchbay__call_read` and `patchbay__call_write`, and for the class shown by
`search_tools` and `describe_tool`:

```json
"toolClass": {
  "read":  ["hv/list_*", "hv/get_*", "files/read_*"],
  "write": ["hv/get_console_ticket"]
}
```

| Order | Rule |
|---|---|
| 1 | A `write` pattern matches: **write**, even if the backend marks the tool `readOnlyHint: true`. A backend can't promote its own tools to read past this list. |
| 2 | A `read` pattern matches: **read**. |
| 3 | The backend declares `readOnlyHint: true`: **read**. |
| 4 | Anything else: **write**. |

Patterns are `backend/tool` globs, as in authorization. Many backends declare no
annotations at all, so without a `read` list nearly everything is write and
`call_read` refuses it. It lives here, not in `mcp_server.json`, because it's a
security decision reviewed with the rest of the policy, and the Servers tab rewrites
`mcp_server.json`. A malformed section makes the whole file invalid, like any other
policy error, and with an invalid file every tool counts as write.

## Rate limits

Two token buckets per caller, kept in memory:

| Bucket | Charged for | Default | On rejection |
|---|---|---|---|
| `tools/call` | Each tool call, before authorization and before any backend sees it | burst 60, refill 120/min | JSON-RPC error `-32011`; `error.data` has `retryAfterSeconds` |
| `http` | Each authenticated request on `/mcp`, `/sse`, `/message` | burst 120, refill 300/min | HTTP 429 with `Retry-After` and a JSON-RPC `-32011` body |

A bucket starts full, spends one token per request and refills continuously. Users and
the static credential get one bucket each, whatever their address or number of
sessions. Anonymous callers are bucketed by client IP (`http`) or session (`tools/call`).
The defaults allow a 60-call burst and hold a runaway loop to 2 calls per second.

Rejections are audited as `event: "rate-limit"` lines. Each burst writes one line
straight away, then at most one every 10 seconds with a `suppressed` count. Pending
counts are flushed on shutdown.

## Audit log

`$MCP_AUDIT_DIR/tools-call-YYYY-MM-DD.jsonl` (UTC), mode 0600, one JSON object per
line:

```json
{"ts":"2026-10-05T14:02:11.482Z","event":"tools/call","user":"bob","identityKind":"user","identitySource":"users.json","sessionId":"5b0e…","tool":"db01__query","toolKey":"db01__query","backend":"db01","ok":false,"decision":"deny","authzRule":"users.bob","authzReason":"matched deny","durationMs":1,"errorCode":-32003,"errorMessage":"…"}
```

| Field | Meaning |
|---|---|
| `user`, `identityKind`, `identitySource` | Who called: a username plus `user`/`static`/`anonymous`/`unknown`, and where the credential came from. |
| `sessionId` | MCP session the call arrived on. |
| `tool` / `toolKey` / `backend` | Name the client used, the internal qualified name, and the backend it routed to. For a call through `patchbay__call_read` or `patchbay__call_write`, `tool` is the real tool's name. |
| `via` | `call_read` or `call_write` when the call came through that gateway meta-tool. |
| `meta` | A gateway meta-call with no backend tool behind it: `activate` (with `backend`), `search_tools` or `describe_tool`. The search query is recorded only as part of `arguments`. |
| `ok` | `false` for refusals, errors and results flagged `isError`. |
| `decision`, `authzRule`, `authzReason` | Authorization outcome, when the tool resolved. |
| `durationMs`, `errorCode`, `errorMessage` | Timing and failure detail. |
| `trifecta` | Present when the call would have completed the trifecta: `sessionAxes`, `toolAxes`, `completing`, `sources`, `blocked`, plus the override `reason` if an allow rule let it through. |
| `arguments` | Only with `MCP_AUDIT_LOG_ARGUMENTS=true`. |

Rug-pull protection adds `"event":"tool-pin"` lines with `action` (`baseline`,
`tofu`, `held`, `approved`, `rejected`, `removed`, `returned`, `reverted`),
`backend`, `tool`, `oldHash` / `newHash`, `reason` for a hold, and `admin` for an
approval or rejection. See [Rug-pull protection](#rug-pull-protection).

Backend crash recovery adds `"event":"backend"` lines with `action` (`down`,
`connect-failed`, `reconnected`, `failed`, `admin-reconnect`), `backend`, and the
detail for that action: `reason`, `recentCrashes`, `attempts`, `downMs`, `admin`,
`ok`, `error`. See [Backend crash recovery](#backend-crash-recovery).

Audit writes never fail a tool call. If the disk is unwritable the gateway logs the
error and carries on.

## Other files in `config/`

All of these are runtime state, created by the gateway or the admin UI, and ignored by
git.

| File | Purpose |
|---|---|
| `.session_secret` | Generated admin session secret when `SESSION_SECRET` is unset. |
| `ui_layout.json` | Admin UI ordering and grouping of servers and tools. It also orders `tools/list`. |
| `catalog.json` | Curated catalog entries that override the built-in starter list. |
| `requests.json` | Connector requests filed by end users through `catalog-server`. |
| `icon-cache/` | Cached catalog icons. |
| `mail_accounts.json`, `.mail_accounts_key` | Mailboxes store (encrypted) and its key. |

### Mailboxes (`mail_accounts.json`)

The **Mailboxes** tab manages IMAP/SMTP accounts for a mail MCP connector that you
configure as the backend named **`mail`** in `mcp_server.json`. The tab stores
passwords encrypted with AES-256-GCM in `config/mail_accounts.json`, with the key in
`config/.mail_accounts_key`, and never returns them to the browser. On every save it
writes the plaintext file your connector reads, `MAIL_ACCOUNTS_PLAINTEXT_PATH`
(mode 0600), shaped `{"accounts": {"<name>": {imapHost, imapPort, imapSecure, user,
password, smtpHost, …}}}`, and reconnects only the `mail` backend. The gateway's
built-in trifecta profile `imap-mcp` expects tools named `list_emails`,
`search_emails`, `read_email`, `send_email` and so on; pin your connector to it with
`backendKinds` if its command line doesn't contain `imap-mcp`.

### Connector catalog and requests (`catalog-server`)

`catalog-server/index.js` is a small stdio MCP server you can add as a backend. It lets
end users browse available connectors and *request* new ones from their client.
Requests appear in the admin **Requests** tab; users can't install anything themselves.
It reads `CATALOG_FILE` and `REQUESTS_FILE` (point them at `config/catalog.json` and
`config/requests.json`) plus `EXTERNAL_REGISTRY_QUERY` / `EXTERNAL_REGISTRY_SIZE` from
its `env`.

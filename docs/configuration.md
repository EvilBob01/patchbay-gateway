# Configuration reference

Patchbay Gateway is configured with environment variables plus a few JSON files in
the `config/` directory of the install. With the systemd unit from
[install.md](install.md), the environment comes from `/etc/patchbay-gateway.env`.

- [Environment variables](#environment-variables)
- [`config/mcp_server.json`: backend servers](#configmcp_serverjson-backend-servers)
- [`config/tool_config.json`: tool overrides](#configtool_configjson-tool-overrides)
- [`config/users.json`: per-user tokens](#configusersjson-per-user-tokens)
- [`config/tool_policy.json`: authorization and trifecta](#configtool_policyjson-authorization-and-trifecta)
- [Rate limits](#rate-limits)
- [Audit log](#audit-log)
- [Other files in `config/`](#other-files-in-config)

> **Run from the install directory.** `mcp_server.json` and `tool_config.json` are
> read relative to the process's working directory (`./config/`). Every other file
> is read relative to the install directory. Set `WorkingDirectory=` to the install
> directory, as the sample unit does, and they are the same place.

## Environment variables

Booleans are `true` exactly unless noted. Anything else, including `1` or `yes`, counts
as false.

### HTTP server and admin UI

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3663` | TCP port for `/mcp`, `/sse`, `/message` and `/admin`. The gateway listens on **all interfaces**; there is no bind-address setting, so restrict access with a firewall ([install.md §5](install.md#5-firewall)). |
| `ENABLE_ADMIN_UI` | off | `true`, `1` or `yes` (case-insensitive) serves the admin UI at `/admin`. Leave it unset on a gateway nobody administers through the browser. |
| `ADMIN_USERNAME` | `admin` | Admin UI login name. |
| `ADMIN_PASSWORD` | `password` | Admin UI password. The gateway logs a warning while it is the default. **Always set it.** |
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

### Backend tool-call retries

A failed `tools/call` to a backend is retried with exponential backoff and jitter:
the delay is `base × 2^(attempt−1)` plus up to 50% of the base. SSE backends are also
reconnected before a retry when the error looks like a lost connection.

| Variable | Default |
|---|---|
| `RETRY_STDIO_TOOL_CALL` / `STDIO_TOOL_CALL_MAX_RETRIES` / `STDIO_TOOL_CALL_RETRY_DELAY_BASE_MS` | `true` / `2` / `300` |
| `RETRY_SSE_TOOL_CALL` / `SSE_TOOL_CALL_MAX_RETRIES` / `SSE_TOOL_CALL_RETRY_DELAY_BASE_MS` | `true` / `2` / `300` |
| `RETRY_HTTP_TOOL_CALL` / `HTTP_TOOL_CALL_MAX_RETRIES` / `HTTP_TOOL_CALL_RETRY_DELAY_BASE_MS` | `true` / `2` / `300` |

These environment variables always win. A `proxy` section in `mcp_server.json` is
ignored.

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

The **Terminal** tab's shell inherits the gateway's environment minus anything named
`ADMIN_*`, `ALLOWED_*` or `SESSION_*`, or ending in `_SECRET`, `_PASSWORD`, `_PASS`,
`_TOKEN`, `_KEY`, `_KEYS` or `_CREDENTIALS`.

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
      "args": ["-y", "ssh-mcp", "--", "--host=192.0.2.10", "--user=ops", "--key=/home/patchbay/.ssh/id_ed25519"],
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
| `command` | stdio | Executable to start. |
| `args` | stdio | Argument array. |
| `env` | stdio | Extra environment for the child, layered on the gateway's own environment. |
| `installDirectory` | stdio | Where the admin UI's **Install** runs `installCommands`. |
| `installCommands` | stdio | Commands run in order by **Install**. They are split into arguments without a shell, so `&&`, `|`, `>` and `$` have no special meaning. The first word must be one of `npm npx pnpm yarn bun bunx pip pip3 python python3 uv uvx poetry git go cargo make`. |
| `url` | sse, http | Backend endpoint. |
| `bearerToken` | sse, http | Sent as `Authorization: Bearer …`. |
| `apiKey` | sse, http | Sent as `X-Api-Key: …` when no `bearerToken` is set. |

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
| `tool` / `toolKey` / `backend` | Name the client used, the internal qualified name, and the backend it routed to. |
| `ok` | `false` for refusals, errors and results flagged `isError`. |
| `decision`, `authzRule`, `authzReason` | Authorization outcome, when the tool resolved. |
| `durationMs`, `errorCode`, `errorMessage` | Timing and failure detail. |
| `trifecta` | Present when the call would have completed the trifecta: `sessionAxes`, `toolAxes`, `completing`, `sources`, `blocked`, plus the override `reason` if an allow rule let it through. |
| `arguments` | Only with `MCP_AUDIT_LOG_ARGUMENTS=true`. |

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

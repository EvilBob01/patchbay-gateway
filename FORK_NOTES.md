# Patchbay Gateway: changes on top of upstream

Patchbay Gateway is a fork of https://github.com/ptbsare/mcp-proxy-server. It adds
per-user access control, auditing and safety checks for running one shared MCP
gateway in front of many backends and many users. Credits for upstream and the
forks we borrowed from are in NOTICE.

## Changes on top of upstream
- User/token management: web UI + API for creating/listing/revoking per-user
  tokens, backed by config/users.json, no restart required.
- Deploy-key-to-host: one-shot password-authenticated SSH action from the admin
  UI that appends this gateway's own SSH public key to a target host's
  authorized_keys. Note it always pushes `id_ed25519.pub` unless
  `SSH_PUBLIC_KEY_PATH` is set, which is useless on pre-6.5 OpenSSH hosts.
- Mailboxes tab: admin UI + `/admin/mail-accounts*` API for the IMAP accounts
  the `mail` backend (imap-mcp) exposes. Credentials are AES-256-GCM encrypted
  at rest in `config/mail_accounts.json` (key in `config/.mail_accounts_key`,
  same pattern as the session secret) and never sent back to the browser;
  saving regenerates the connector's own plaintext accounts file and refreshes
  only the `mail` backend rather than restarting the gateway. The connector
  itself lives outside this repo — see its ARCHITECTURE.md for the full
  picture of how the two fit together.
- Legacy SSH host support: `scripts/patch-ssh-mcp-legacy.mjs` relaxes the
  hardcoded algorithm list inside the third-party `ssh-mcp` package so gateways
  can reach OpenSSH 5.3 / CentOS 6 era hosts. This one patches a *dependency*,
  not this repo, so it must be re-run after any `ssh-mcp` version bump or npx
  cache rebuild -- see LEGACY_SSH_HOSTS.md.
- Per-tool authorization (`src/policy.ts`): `config/tool_policy.json` says which
  identity may see and call which tools, as `"<backend>/<tool>"` globs keyed by
  `users.<name>`, `static`, `default` and named `roles`; deny beats allow.
  Enforced on `tools/list` (hidden) *and* `tools/call` (rejected with -32003 and
  audited as `decision: "deny"`). No file means everyone keeps every enabled
  tool; an invalid file fails closed. Re-read on change, so edits -- by hand or
  via the Users tab editor / `/admin/tool-policy` -- apply to the next request,
  including on already-open sessions. Model ported from a sibling
  fork's capability scoping. Covers tools only: backend resources and prompts
  are not yet scoped. Verify on a box with `test/tool-policy.live.mjs`.
- Lethal-trifecta blocking (`src/trifecta.ts`): every tool is classified as
  private-data / untrusted-content / external-comm, each MCP session accumulates
  the axes it has touched, and the call that would give one session all three is
  refused with -32010 before it is forwarded, and audited. Runs after per-tool
  authorization; configured by the `trifecta` section of
  `config/tool_policy.json`. Defaults and reasoning in TRIFECTA.md.
- Merge adjacent text blocks (`src/tool-result.ts`, ported from
  willscottuk/mcp-proxy-server `190093a1`): for clients that read only the first
  content block of a tool result (OpenAI Responses API remote MCP, i.e.
  ChatGPT), joins each run of adjacent plain text blocks with a blank line.
  **Off by default**; `MCP_MERGE_TEXT_CONTENT=true` turns it on gateway-wide,
  and `"mergeTextContent": true|false` on a `config/users.json` entry overrides
  that for one user (hand edit; the Users tab keeps the field). Applied after
  the audit record, last thing before the result leaves the gateway.

## Pulling upstream updates
```
git fetch upstream
git merge upstream/main
# resolve any conflicts, then:
git push origin main
```
`upstream`'s push URL is intentionally disabled (`DISABLED`) to prevent accidental
pushes to the real project.

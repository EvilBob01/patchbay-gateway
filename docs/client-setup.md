# Connecting clients

One gateway entry replaces a client config entry per MCP server. Each person gets
their own token, so the gateway knows who is calling, applies their tool policy and
records their calls in the audit log.

Throughout this page the gateway is at `http://gateway.example.com:3663` and the
user's token is `<token>`.

- [Get a token](#get-a-token)
- [Endpoints and credentials](#endpoints-and-credentials)
- [Claude Desktop](#claude-desktop)
- [Windows installer bundle](#windows-installer-bundle)
- [Claude Code](#claude-code)
- [Other clients](#other-clients)
- [Checking it works](#checking-it-works)

## Get a token

An admin creates the user in the admin UI's **Users** tab. The token is live
immediately. From the same row the admin can:

- **Copy Desktop Config**: a ready-to-paste Claude Desktop entry for that user, built
  from the address the admin is browsing the UI at. So open the admin UI at the
  same host name your users will use.
- **Download Installer**: a Windows zip that sets Claude Desktop up with no other
  prerequisites (see [below](#windows-installer-bundle)).

The **Server name** box above the list sets the name the client shows for the gateway.
It defaults to `GATEWAY_CLIENT_NAME`.

Treat a token like a password. Each person should have their own. Revoking one in the
Users tab cuts that person off at once without affecting anyone else.

## Endpoints and credentials

| Endpoint | Transport |
|---|---|
| `/mcp` | Streamable HTTP (current MCP spec). Use this. |
| `/sse` + `/message` | Legacy HTTP+SSE, for older clients. |

A token can be presented three ways. They are equivalent for per-user tokens:

| Form | Example |
|---|---|
| Bearer header | `Authorization: Bearer <token>` |
| API-key header | `X-Api-Key: <token>` |
| Query parameter | `http://gateway.example.com:3663/mcp?key=<token>` |

The query-parameter form is the one to use where the client launches a helper through
a Windows shell (see below). It puts the token in the URL, so only use it on a private
network or behind TLS.

## Claude Desktop

Claude Desktop reaches remote MCP servers through
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote), a small stdio↔HTTP bridge run
with `npx`. It needs Node.js on the client machine. Add this to
`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "patchbay": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://gateway.example.com:3663/mcp?key=<token>",
        "--allow-http"
      ]
    }
  }
}
```

- `--allow-http` is required while the gateway is plain HTTP; `mcp-remote` refuses
  non-HTTPS URLs otherwise. Drop it if a TLS proxy fronts the gateway and use the
  `https://` URL.
- **Windows: use `?key=`, not a header argument.** Claude Desktop on Windows starts
  `npx` through `cmd.exe`, which splits any argument containing a space. A
  `--header "Authorization: Bearer <token>"` argument breaks into pieces and
  authentication silently fails. The `?key=` form has no spaces.
- To keep the token out of the URL, send it as an `X-Api-Key` header instead. The
  value has no spaces, so this form works on Windows too:

  ```json
  "args": ["-y", "mcp-remote", "http://gateway.example.com:3663/mcp",
           "--allow-http", "--header", "X-Api-Key:<token>"]
  ```

Fully quit Claude Desktop (tray icon → Quit) and reopen it. The gateway's tools appear
as `<server>__<tool>`, for example `web01__read-command`.

## Windows installer bundle

For people who should not have to install Node.js or edit JSON, the Users tab's
**Download Installer** button produces a zip containing:

| File | Purpose |
|---|---|
| `node/node.exe` | Portable Node.js runtime |
| `mcp-remote/` | `mcp-remote`, pre-installed |
| `params.json` | This user's gateway URL (with `?key=<token>`) and server name |
| `Install.bat`, `install.ps1` | The installer |
| `README.txt` | Instructions for the user |

The user unzips it and double-clicks `Install.bat`. The script copies the runtime into
a folder under `%LOCALAPPDATA%`, backs up any existing `claude_desktop_config.json` to
`.bak`, merges one server entry into it (other entries are left alone) and asks them
to restart Claude Desktop. Nothing is downloaded on the client. Windows SmartScreen may
warn because the script is unsigned (**More info → Run anyway**).

The gateway URL inside the bundle comes from the host name the admin used to open the
admin UI, so download it from the address users will connect to. The bundle contains
the user's token: send it to that person only.

**Gateway side, one-time:** the bundle is assembled from a prebuilt payload in
`INSTALLER_BASE_DIR`. Build it on the gateway (needs `curl`, `python3` and `npm`):

```bash
cd /opt/patchbay-gateway
sudo -u patchbay env INSTALLER_BASE_DIR=/var/lib/patchbay/installer-base bash installer-base/build-base.sh
```

This downloads a Windows Node.js build (`NODE_VERSION`, default `v22.23.1`), installs
`mcp-remote`, and copies the scripts. Re-run it to pick up new versions. Until it has
run, **Download Installer** answers `503`.

## Claude Code

Claude Code speaks streamable HTTP natively, so it needs no `mcp-remote`:

```bash
claude mcp add --transport http patchbay http://gateway.example.com:3663/mcp --header "Authorization: Bearer <token>"
```

Add `--scope user` to make it available in every project. To share a project-level
config without committing the token, use an environment variable in `.mcp.json`:

```json
{
  "mcpServers": {
    "patchbay": {
      "type": "http",
      "url": "http://gateway.example.com:3663/mcp",
      "headers": { "Authorization": "Bearer ${PATCHBAY_TOKEN}" }
    }
  }
}
```

The same `mcp-remote` entry as Claude Desktop also works if you prefer it.

## Other clients

Any MCP client that supports streamable HTTP can use `/mcp` with one of the
credential forms above. Clients that only speak stdio can use `mcp-remote` as shown for
Claude Desktop.

Some clients read only the **first** content block of a tool result; the OpenAI
Responses API's remote MCP tool is one. If tool output looks truncated in such a
client, ask the admin to set `"mergeTextContent": true` on your user (or
`MCP_MERGE_TEXT_CONTENT=true` gateway-wide). See
[configuration.md](configuration.md#configusersjson-per-user-tokens).

## Checking it works

- The client lists tools named `<server>__<tool>`. If some are missing, the tool
  policy hides them from you, or an admin disabled them.
- A refused call explains itself:

  | Error code | Meaning |
  |---|---|
  | `-32003` | The tool policy doesn't allow you this tool. |
  | `-32010` | Lethal-trifecta block: this session has already touched private data and untrusted content, and this tool would add an outbound channel (or a similar combination). Start a fresh session for this task. |
  | `-32011` | Rate limited. Wait the number of seconds in the message. |
  | HTTP `401` | Token missing, mistyped or revoked. |

- Admins can see every call in the audit log
  (`$MCP_AUDIT_DIR/tools-call-YYYY-MM-DD.jsonl`), and connection attempts in
  `journalctl -u patchbay-gateway`.

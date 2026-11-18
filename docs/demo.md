# Try Patchbay with simulated servers

This demo starts the real gateway and three local MCP fixture processes:
`demo-web`, `demo-db` and `demo-cache`. They simulate status and a restart counter.
They never run shell commands, connect SSH, or change a real service.

Use a checkout of v1.2.0 or later (`scripts/demo.mjs` is not in v1.1.0).
You need Git and Node.js 20+, but no API keys, administrator privileges or servers.

```sh
npm ci --ignore-scripts
npm run build
node scripts/demo.mjs
```

On Windows PowerShell, use `npm.cmd` if needed. The launcher prints a loopback admin
URL, a temporary login and a demo client token. Open that URL. It first checks that
all three backends are ready, two users see six and two tools respectively, a
collapsed call reaches the intended backend, and a request without a token fails.
It binds only to `127.0.0.1`, ignores inherited gateway settings, and leaves the
terminal, install runner and deploy-key push disabled.

All config, generated credentials and audit data live in a unique OS temporary
directory. Ctrl+C requests a graceful shutdown and removes that directory. A fresh
run creates fresh state. An abrupt power loss or forced process termination may
leave that temporary directory behind; the launcher prints its location.

For a noninteractive smoke check that exits and cleans up:

```sh
node scripts/demo.mjs --check
```

Connect a client using the printed endpoint and `Authorization: Bearer <printed
token>`. That token belongs to `demo-collapsed`. Its tool list contains
`ssh__read-command` and `ssh__run-command`, with a `host` enum selecting the fake
backend. Call `ssh__read-command` with `{"host":"demo-web","command":"uptime"}`.
The response begins `SIMULATED demo-web: healthy`. The only simulated write accepts
`restart-demo` and increments an in-memory counter. All other commands are refused.

The demo explicitly assigns the fixtures the `ssh-mcp` kind so their identical
tools can collapse. It is a presentation/routing demonstration, not an SSH server
or a proof of every security property. No real email, private data, external
content or outbound channels are included.

## A 90-second recording

Use only this demo. Hide the launcher's generated login/token while recording.
Do not import your actual client configuration or show personal infrastructure.

| Time | Show | Explain |
|---|---|---|
| 0–15 s | Servers tab with the three connected demo backends | “Several MCP servers, one endpoint for my clients.” |
| 15–35 s | Users tab: demo-flat and demo-collapsed; hide tokens | “Each user gets a token. Presentation can differ per user.” |
| 35–55 s | Client tool list and the simulated uptime call | “Six repeated definitions become two tools with a host selector.” |
| 55–75 s | Reconnect one demo backend; wait for its connected state | “The gateway tracks MCP connection state and offers reconnect.” |
| 75–90 s | Audit entry for the simulated call, then feedback links | “Tell me what failed or what you need. Reports can be incomplete.” |

For an import recording, start a second empty local trial and import only a copy
of the generated demo `mcp_server.json`. Preview it before applying. Do not import
it into the running demo, where those server names already exist.

Keep tool-definition-change hold/approval for a separate, verified walkthrough;
these fixed fixtures do not simulate a rug pull. A recording should show only
behavior actually exercised.

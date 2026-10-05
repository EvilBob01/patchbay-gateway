// Regression test for cross-session response bleed.
//
// Protocol.connect() assigns `this._transport`, and _onrequest() replies through
// `this._transport`. So a Server instance shared across sessions sends every
// client's responses to whichever transport connected most recently. On
// @modelcontextprotocol/sdk 1.12.0 there was no guard against connecting a Server
// twice, so the failure was silent. From SDK 1.29 on, Protocol.connect() throws
// "Already connected to a transport" instead, which turns the bleed into a loud
// failure. This test pins that guard: if it is ever removed, the shared case fails.
//
// SHARED  = what src/sse.ts did before: one server, N transports.
// PER-SESSION = what it does now: one server per session.
//
// Run from the fork root:  node test/session-isolation.test.mjs

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

class MockTransport {
  constructor(name) {
    this.name = name;
    this.sessionId = `session-${name}`;
    this.sent = [];
  }
  async start() {}
  async send(msg) { this.sent.push(msg); }
  async close() { this.onclose?.(); }
  deliver(msg) { return this.onmessage?.(msg, {}); }
}

// Handlers close over shared backend state in the real code; that part is fine to
// share. Only the Server/Protocol instance must be per-session.
function buildServerInstance() {
  const server = new Server(
    { name: 'repro', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'a-tool', description: 'x', inputSchema: { type: 'object' } }],
  }));
  return server;
}

async function runTopology(label, { perSession }) {
  const alice = new MockTransport('ALICE');
  const bob = new MockTransport('BOB');

  if (perSession) {
    await buildServerInstance().connect(alice);
    await buildServerInstance().connect(bob);
  } else {
    const shared = buildServerInstance();
    await shared.connect(alice);
    try {
      await shared.connect(bob); // on SDK 1.12 this silently stole Alice's transport
    } catch (err) {
      console.log(`${label}
  second connect() threw: ${err.message}`);
      return { threw: true, message: err.message };
    }
  }

  // Alice asks. Alice should be the one who hears back.
  await alice.deliver({ jsonrpc: '2.0', id: 42, method: 'tools/list', params: {} });
  await new Promise(r => setTimeout(r, 50));

  const aliceGot = alice.sent.some(m => m.id === 42);
  const bobGot = bob.sent.some(m => m.id === 42);
  console.log(`${label}\n  alice.sent=${alice.sent.length} bob.sent=${bob.sent.length} -> aliceGot=${aliceGot} bobGot=${bobGot}`);
  return { aliceGot, bobGot };
}

const shared = await runTopology('SHARED server (the old behaviour):', { perSession: false });
const fixed = await runTopology('PER-SESSION servers (current behaviour):', { perSession: true });

console.log('\n--- RESULT ---');
let ok = true;

if (shared.threw && /Already connected to a transport/.test(shared.message)) {
  console.log('ok   shared topology is rejected by the SDK guard (no silent bleed possible)');
} else if (shared.bobGot && !shared.aliceGot) {
  console.log("FAIL shared topology bled silently (Alice's reply went to Bob) -- the SDK connect() guard is gone");
  ok = false;
} else {
  console.log(`FAIL shared topology neither threw nor bled: ${JSON.stringify(shared)}`);
  ok = false;
}

if (fixed.aliceGot && !fixed.bobGot) {
  console.log('ok   per-session topology routes the reply to the caller');
} else {
  console.log(`FAIL per-session topology misrouted: aliceGot=${fixed.aliceGot} bobGot=${fixed.bobGot}`);
  ok = false;
}

console.log(ok ? '\nPASS' : '\nFAILED');
process.exit(ok ? 0 : 1);

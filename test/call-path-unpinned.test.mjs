// The pre-dispatch check with rug-pull protection off (MCP_PIN_TOOLS=false):
// nothing holds a changed definition, so it is served at once. A retry still
// never carries the old approval over to it: it is refused with -32012 and
// reason "definition-changed", and the backend sees no second call.
// (call-path.test.mjs covers the pinned case; one gateway per file.)
//
// Run from the fork root after a build:  node --test test/call-path-unpinned.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGateway, who } from './fixtures/gateway.mjs';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'call-path-backend.mjs');
const work = mkdtempSync(path.join(tmpdir(), 'call-path-unpinned-'));
const callsFile = path.join(work, 'u.calls');

const gw = await startGateway({
  prefix: 'call-path-unpinned-',
  servers: { u: { type: 'stdio', command: process.execPath, args: [FIXTURE, '--name=u', `--calls=${callsFile}`] } },
  policy: { default: { allow: ['*'] } },
  env: { MCP_PIN_TOOLS: 'false', STDIO_TOOL_CALL_RETRY_DELAY_BASE_MS: '800', STDIO_TOOL_CALL_MAX_RETRIES: '2' },
});
test.after(async () => { await gw.stop(); rmSync(work, { recursive: true, force: true }); });

const calls = (tool) => existsSync(callsFile) ? readFileSync(callsFile, 'utf-8').split('\n').filter(l => l === tool).length : 0;

test('a definition that changed during the retry delay is not retried, even when it is served', async () => {
  const s = await gw.session(who('caller'));
  const res = await s.call('u__probe', {});
  assert.equal(res.error?.code, -32012, JSON.stringify(res));
  assert.equal(res.error.data?.pendingReview?.reason, 'definition-changed');
  assert.equal(calls('probe'), 1, 'the backend saw no second call');
  const tools = await s.list();
  assert.match(tools.find(t => t.name === 'u__probe').description, /Changed definition/, 'the new definition is served (pins are off)');
  const line = (await gw.auditFor(s.sessionId)).filter(l => l.event === 'tools/call').at(-1);
  assert.equal(line.retryRefused, 'definition-changed');
  // Called again, against the definition the caller can now see: it runs.
  const again = await s.call('u__probe', {});
  assert.match(again.result?.content[0].text ?? JSON.stringify(again), /probe executed/);
});

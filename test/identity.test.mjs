// Offline tests for caller identity resolution (src/identity.ts).
//
// Regression: sse.ts used to resolve identity against allowedTokens only, while
// the /mcp and /sse auth checks also accept allowedKeys. A static credential set
// only in ALLOWED_KEYS authenticated fine but resolved to 'unknown', so the
// audit log said user=unknown and the tool policy denied it.
//
// Run from the fork root after a build:  node test/identity.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'identity-'));
const USERS = path.join(dir, 'users.json');
process.env.MCP_USERS_PATH = USERS; // must be set before the import
writeFileSync(USERS, JSON.stringify([
  { username: 'alice', token: 'alice-token', createdAt: '2026-01-01T00:00:00.000Z' },
]));
const { resolveIdentity, STATIC_IDENTITY, UNKNOWN_IDENTITY } = await import('../build/identity.js');

// Mirror sse.ts: per-user tokens are add()ed into both Sets.
const allowedTokens = new Set(['env-token', 'alice-token']);
const allowedKeys = new Set(['env-key', 'alice-token']);
const both = [allowedTokens, allowedKeys];

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

try {
  await test('ALLOWED_KEYS-only static credential resolves to static', async () => {
    assert.deepEqual(await resolveIdentity('env-key', both), STATIC_IDENTITY);
  });

  await test('ALLOWED_TOKENS-only static credential resolves to static', async () => {
    assert.deepEqual(await resolveIdentity('env-token', both), STATIC_IDENTITY);
  });

  await test('a gateway configured with ALLOWED_KEYS only', async () => {
    assert.deepEqual(await resolveIdentity('env-key', [new Set(), new Set(['env-key'])]), STATIC_IDENTITY);
  });

  await test('per-user token resolves to the user, not static', async () => {
    const id = await resolveIdentity('alice-token', both);
    assert.equal(id.kind, 'user');
    assert.equal(id.username, 'alice');
    assert.equal(id.source, 'users.json');
  });

  await test('credential in neither Set is unknown', async () => {
    assert.deepEqual(await resolveIdentity('nope', both), UNKNOWN_IDENTITY);
  });

  await test('missing credential is unknown', async () => {
    assert.deepEqual(await resolveIdentity(undefined, both), UNKNOWN_IDENTITY);
    assert.deepEqual(await resolveIdentity('', both), UNKNOWN_IDENTITY);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed`);

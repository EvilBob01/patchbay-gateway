// Offline tests for the per-tool authorization policy (src/policy.ts).
//
// Run from the fork root after a build:  node test/tool-policy.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'tool-policy-'));
const POLICY = path.join(dir, 'tool_policy.json');
process.env.MCP_TOOL_POLICY_PATH = POLICY; // must be set before the import
const { compilePolicy, currentPolicy, NO_POLICY } = await import('../build/policy.js');

const user = (username) => ({ kind: 'user', username, source: 'users.json' });
const STATIC = { kind: 'static', username: 'static', source: 'env' };
const UNKNOWN = { kind: 'unknown', username: 'unknown', source: 'none' };
const ANON = { kind: 'anonymous', username: 'anonymous', source: 'none' };
const ok = (p, identity, backend, tool) => p.decide({ identity, backend, tool }).allowed;

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

await test('no policy: everyone, including unknown, keeps everything', () => {
  for (const id of [user('a'), STATIC, UNKNOWN, ANON]) assert.equal(ok(NO_POLICY, id, 'x', 'y'), true);
});

await test('empty policy object preserves current behaviour for known identities', () => {
  const p = compilePolicy({});
  assert.equal(ok(p, user('a'), 'srv', 't'), true);
  assert.equal(ok(p, STATIC, 'srv', 't'), true);
  assert.equal(ok(p, ANON, 'srv', 't'), true);
});

await test('unknown identity fails closed once a policy is in force', () => {
  assert.equal(ok(compilePolicy({}), UNKNOWN, 'srv', 't'), false);
});

await test('per-server restriction', () => {
  const p = compilePolicy({ users: { alice: { allow: ['forgejo/*'] } } });
  assert.equal(ok(p, user('alice'), 'forgejo', 'run-command'), true);
  assert.equal(ok(p, user('alice'), 'haproxy', 'run-command'), false);
  assert.equal(ok(p, user('bob'), 'haproxy', 'run-command'), true, 'unlisted user falls to implicit default');
  assert.equal(ok(p, STATIC, 'haproxy', 'run-command'), true);
});

await test('backend glob is anchored: "web/*" does not match backend "webhooks"', () => {
  const p = compilePolicy({ users: { a: { allow: ['web/*'] } } });
  assert.equal(ok(p, user('a'), 'web', 't'), true);
  assert.equal(ok(p, user('a'), 'webhooks', 't'), false);
});

await test('per-tool wildcards, and deny beats allow', () => {
  const p = compilePolicy({ users: { a: { allow: ['*/read-*', 'mail/*'], deny: ['mail/delete_email'] } } });
  assert.equal(ok(p, user('a'), 'any', 'read-command'), true);
  assert.equal(ok(p, user('a'), 'any', 'run-command'), false);
  assert.equal(ok(p, user('a'), 'mail', 'list_emails'), true);
  assert.equal(ok(p, user('a'), 'mail', 'delete_email'), false);
});

await test('regex metacharacters in names are literal', () => {
  const p = compilePolicy({ users: { a: { allow: ['a.b/x+y'] } } });
  assert.equal(ok(p, user('a'), 'a.b', 'x+y'), true);
  assert.equal(ok(p, user('a'), 'aXb', 'xxy'), false);
});

await test('roles are inherited and extended', () => {
  const p = compilePolicy({
    roles: { ro: { allow: ['*/list-*'] } },
    users: { a: { role: 'ro', allow: ['x/run'], deny: ['secret/*'] } },
  });
  assert.equal(ok(p, user('a'), 'srv', 'list-sessions'), true);
  assert.equal(ok(p, user('a'), 'x', 'run'), true);
  assert.equal(ok(p, user('a'), 'secret', 'list-sessions'), false);
  assert.equal(ok(p, user('a'), 'srv', 'run'), false);
});

await test('explicit default flips to allowlist mode; static has its own entry', () => {
  const p = compilePolicy({ default: { allow: [] }, static: { allow: ['*'] }, users: { a: { allow: ['s/*'] } } });
  assert.equal(ok(p, user('nobody'), 's', 't'), false);
  assert.equal(ok(p, user('a'), 's', 't'), true);
  assert.equal(ok(p, STATIC, 'z', 't'), true);
  assert.equal(p.decide({ identity: user('nobody'), backend: 's', tool: 't' }).rule, 'default');
});

await test('a rule with no allow key allows nothing', () => {
  assert.equal(ok(compilePolicy({ users: { a: { deny: [] } } }), user('a'), 's', 't'), false);
});

await test('malformed policies are rejected', () => {
  const bads = [
    [], null, 'x',
    { users: { a: { allow: ['forgejo'] } } },   // bare name is ambiguous
    { users: { a: { allow: ['/t'] } } },
    { users: { a: { allow: ['s/'] } } },
    { users: { a: { allow: 'x/*' } } },          // not an array
    { users: { a: { alow: ['x/*'] } } },         // typo'd key
    { users: { a: { role: 'missing' } } },
    { default: { role: 'x' } },                  // role only valid under users
    { users: [] },
  ];
  for (const bad of bads) assert.throws(() => compilePolicy(bad), Error, JSON.stringify(bad));
});

await test('unknown top-level keys are tolerated (room for later features)', () => {
  assert.doesNotThrow(() => compilePolicy({ someFutureFeature: { anything: true } }));
  // "trifecta" was the placeholder here; it is now a real, validated section (see trifecta.test.mjs).
  assert.throws(() => compilePolicy({ trifecta: { anything: true } }), /trifecta/);
});

await test('live file: absent -> allow, edit -> applies, invalid -> fail closed, removed -> allow', async () => {
  rmSync(POLICY, { force: true });
  assert.equal((await currentPolicy()).configured, false);

  writeFileSync(POLICY, JSON.stringify({ users: { a: { allow: ['one/*'] } } }));
  let p = await currentPolicy();
  assert.equal(ok(p, user('a'), 'two', 't'), false);

  writeFileSync(POLICY, JSON.stringify({ users: { a: { allow: ['one/*', 'two/*'] } } }));
  const later = new Date(Date.now() + 5000);
  utimesSync(POLICY, later, later); // guarantee a visible mtime change
  p = await currentPolicy();
  assert.equal(ok(p, user('a'), 'two', 't'), true, 'edit picked up without restart');

  writeFileSync(POLICY, '{ not json');
  p = await currentPolicy();
  assert.equal(ok(p, user('a'), 'one', 't'), false, 'invalid file fails closed');
  assert.equal(ok(p, STATIC, 'one', 't'), false);

  rmSync(POLICY);
  assert.equal((await currentPolicy()).configured, false);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed`);

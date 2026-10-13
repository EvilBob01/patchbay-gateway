// Offline tests for the ssh-mcp policy view: the admin UI's arg parsing and
// rewriting (public/ssh-policy.js, loaded without a DOM) and the gateway's
// read-only TOML group reader (src/sshPolicy.ts, what GET /admin/ssh-policy returns).
//
// Run from the fork root after a build:  node --test test/ssh-policy.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { window: {} };
vm.runInNewContext(readFileSync(path.join(root, 'public', 'ssh-policy.js'), 'utf-8'), ctx);
const P = ctx.window.SshPolicy;
const S = await import('../build/sshPolicy.js');

// Plain copies: vm-context arrays have another Array.prototype, which deepEqual rejects.
const plain = (v) => JSON.parse(JSON.stringify(v));

const quick = (...extra) => ['ssh-mcp', '-y', '--', '--host=web01.example.com', '--port=22', '--user=deploy',
  '--key=/root/.ssh/id_ed25519', '--maxChars=none', '--timeout=600000', ...extra];

test('detects ssh-mcp backends by package segment, not substring', () => {
  assert.equal(P.isSshMcp({ command: 'npx', args: quick() }), true);
  assert.equal(P.isSshMcp({ command: 'npx', args: ['-y', 'ssh-mcp@2.18.0', '--host=a', '--user=b'] }), true);
  assert.equal(P.isSshMcp({ command: 'node', args: ['/opt/ssh-mcp/build/index.js'] }), true);
  assert.equal(P.isSshMcp({ command: 'npx', args: ['-y', 'my-ssh-mcp-thing'] }), false);
  assert.equal(P.isSshMcp({ url: 'https://mcp.example.com/sse' }), false);
  for (const conf of [{ command: 'npx', args: quick() }, { command: 'npx', args: ['my-ssh-mcp-thing'] }]) {
    assert.equal(S.isSshMcpBackend(conf), P.isSshMcp(conf), 'server and client agree');
  }
});

test('missing --group is prod by default; explicit, bare and invalid values', () => {
  assert.deepEqual(plain(P.describe(quick())), { mode: 'cli', group: 'prod', groupSource: 'default', disableApproval: false });
  assert.deepEqual(plain(P.describe(quick('--group=dev', '--disableApproval'))), { mode: 'cli', group: 'dev', groupSource: 'explicit', disableApproval: true });
  assert.equal(P.describe(quick('--group')).groupSource, 'default', 'bare --group is prod in ssh-mcp');
  assert.deepEqual(plain(P.describe(quick('--group=tier-1'))), { mode: 'cli', group: 'tier-1', groupSource: 'invalid', disableApproval: false });
  assert.equal(P.describe(quick('--group=prod', '--group=staging')).group, 'staging', 'last flag wins, as in ssh-mcp');
});

test('--disableApproval follows ssh-mcp flagEnabled', () => {
  for (const [arg, want] of [['--disableApproval', true], ['--disableApproval=1', true], ['--disableApproval=false', false],
    ['--disableApproval=0', false], ['--disableApproval=OFF', false], ['--disableApproval=no', false]]) {
    assert.equal(P.describe(quick(arg)).disableApproval, want, arg);
  }
});

test('--config wins over --host; no host/user/config is the default config file', () => {
  assert.deepEqual(plain(P.describe(['ssh-mcp', '-y', '--', '--config=/etc/ssh-mcp/web.toml', '--host=x', '--user=y'])),
    { mode: 'toml', configPath: '/etc/ssh-mcp/web.toml', disableApproval: false });
  assert.equal(P.describe(['ssh-mcp', '-y']).mode, 'default-config');
});

test('setGroup adds at the end and keeps every other arg exactly', () => {
  const before = quick('--disableApproval');
  const after = P.setGroup(before, 'staging');
  assert.deepEqual(plain(after), [...before, '--group=staging']);
  assert.deepEqual(plain(before), quick('--disableApproval'), 'input not mutated');
});

test('setGroup changes in place, collapses duplicates, and removes', () => {
  const args = ['ssh-mcp', '-y', '--', '--host=h', '--group=prod', '--user=u', '--group=dev', '--timeout=5'];
  assert.deepEqual(plain(P.setGroup(args, 'staging')), ['ssh-mcp', '-y', '--', '--host=h', '--group=staging', '--user=u', '--timeout=5']);
  assert.deepEqual(plain(P.setGroup(args, null)), ['ssh-mcp', '-y', '--', '--host=h', '--user=u', '--timeout=5']);
  assert.deepEqual(plain(P.setGroup(args, '')), ['ssh-mcp', '-y', '--', '--host=h', '--user=u', '--timeout=5']);
  assert.deepEqual(plain(P.setGroup(['--host=h', '--group', '--user=u'], 'dev')), ['--host=h', '--group=dev', '--user=u'], 'bare --group replaced');
  assert.deepEqual(plain(P.setGroup(['--host=h', '--groups=x'], 'dev')), ['--host=h', '--groups=x', '--group=dev'], 'similar flag untouched');
  assert.throws(() => P.setGroup(args, 'tier-1'), /prod, staging, dev/);
});

test('setDisableApproval adds, normalises and removes every spelling', () => {
  const base = quick('--group=dev');
  assert.deepEqual(plain(P.setDisableApproval(base, true)), [...base, '--disableApproval']);
  assert.deepEqual(plain(P.setDisableApproval([...base, '--disableApproval=false'], true)), [...base, '--disableApproval']);
  assert.deepEqual(plain(P.setDisableApproval(['-y', '--disableApproval', '--', '--host=h', '--disableApproval=1'], false)), ['-y', '--', '--host=h']);
  assert.deepEqual(plain(P.setDisableApproval(base, false)), base);
  // Round trip leaves the config byte-identical.
  assert.deepEqual(plain(P.setGroup(P.setGroup(quick(), 'dev'), null)), quick());
});

test('filter tokens bucket backends for the bulk view', () => {
  assert.deepEqual(plain(P.filterTokens({ command: 'npx', args: quick() })), ['prod', 'default']);
  assert.deepEqual(plain(P.filterTokens({ command: 'npx', args: quick('--group=dev') })), ['dev']);
  assert.deepEqual(plain(P.filterTokens({ command: 'npx', args: quick('--group=x') })), ['invalid']);
  assert.deepEqual(plain(P.filterTokens({ command: 'npx', args: ['ssh-mcp', '--config=/c.toml'] },
    { profiles: [{ name: 'web-01', group: 'prod', source: 'inferred' }, { name: 'b', group: 'tier-1', source: 'explicit' }] })),
    ['toml', 'prod', 'default', 'tier-1', 'custom']);
  assert.deepEqual(plain(P.filterTokens({ command: 'npx', args: ['-y', '@acme/other-mcp'] })), ['none']);
});

// ---------- gateway side: TOML is read for name + group only ----------

const SECRET_TOML = `# Example profile file with fake secrets
[defaults]
approvalMode = "ask-destructive"
password = "FAKE-DEFAULTS-PASSWORD-1"

[[profiles]]
name = "prod-web-1"
host = "203.0.113.10"
user = "deploy"
auth = "password"
password = "FAKE-PROFILE-PASSWORD-2"
keyRef = "/root/.ssh/FAKE-KEY-NAME"
group = "prod"

[[profiles]]
name = 'build-box-dev'      # inferred: dev
host = "198.51.100.7"
keychainEntry = "FAKE-KEYCHAIN-3"

[[profiles]]
name = "web-01"             # no group, unrecognised name: prod
host = "web01.example.com"

[[profiles]]
name = "edge"
group = "tier-1"            # custom tier
host = "192.0.2.1"

[policy]
denylist = ["FAKE-DENY-4"]

[policy.roleBindings.admin]
"tier-1" = ["read-only", "safe", "destructive"]
group = "not-a-profile-field"
`;

test('profile groups from TOML: explicit, inferred and unrecognised names', () => {
  assert.deepEqual(S.profileGroupsFromToml(SECRET_TOML), [
    { name: 'prod-web-1', group: 'prod', source: 'explicit' },
    { name: 'build-box-dev', group: 'dev', source: 'inferred' },
    { name: 'web-01', group: 'prod', source: 'inferred' },
    { name: 'edge', group: 'tier-1', source: 'explicit' },
  ]);
  assert.equal(S.inferGroupFromName('db-staging'), 'staging');
  assert.equal(S.inferGroupFromName('local'), 'dev');
  assert.equal(S.inferGroupFromName('devonshire'), 'prod', 'word match, as ssh-mcp');
});

test('odd values are dropped, never echoed', () => {
  const t = '[[profiles]]\nname = "x\\"; rm -rf /"\ngroup = "<script>alert(1)</script>"\n';
  assert.deepEqual(S.profileGroupsFromToml(t), [{ name: 'profile 1', group: '(unreadable)', source: 'explicit' }]);
});

test('the /admin/ssh-policy payload never carries TOML secrets', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ssh-policy-'));
  try {
    const file = path.join(dir, 'fleet.toml');
    writeFileSync(file, SECRET_TOML);
    const servers = {
      fleet: { type: 'stdio', command: 'npx', args: ['ssh-mcp', '-y', '--', `--config=${file}`] },
      quick: { type: 'stdio', command: 'npx', args: quick('--group=dev') },
      missing: { type: 'stdio', command: 'npx', args: ['ssh-mcp', '-y', '--', `--config=${path.join(dir, 'nope.toml')}`] },
      other: { type: 'stdio', command: 'npx', args: ['-y', '@acme/other-mcp', `--config=${file}`] },
    };
    const out = await S.describeTomlPolicies(servers);
    assert.deepEqual(Object.keys(out).sort(), ['fleet', 'missing'], 'only ssh-mcp --config backends');
    assert.equal(out.fleet.profiles.length, 4);
    assert.equal(out.missing.error, 'ENOENT');
    assert.deepEqual(out.missing.profiles, []);
    const json = JSON.stringify(out);
    for (const secret of ['FAKE-', '203.0.113.10', '198.51.100.7', 'web01.example.com', 'deploy', 'password', 'keyRef', 'denylist', 'not-a-profile-field']) {
      assert.ok(!json.includes(secret), `payload leaks ${secret}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('oversized or non-file --config is refused without reading', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ssh-policy-'));
  try {
    const big = path.join(dir, 'big.toml');
    writeFileSync(big, '[[profiles]]\nname = "a"\n' + '#'.repeat(S.TOML_MAX_BYTES));
    assert.equal((await S.readTomlPolicy(big)).error, 'too large');
    assert.equal((await S.readTomlPolicy(dir)).error, 'not a file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

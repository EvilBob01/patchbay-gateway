// Offline tests for importing backends from client configs (src/importConfig.ts).
// All servers below are fake; nothing is started.
//
// Run from the repo root after a build:  node test/import-config.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseClientConfig, maskCandidate, maskSecret, stripJsonc, applySelections,
  storePreview, takePreview,
} from '../build/importConfig.js';

const ctx = (existingKeys = [], extra = {}) => ({
  existingKeys,
  platform: 'linux',
  commandExists: (c) => ['npx', 'uvx', 'node', '/usr/local/bin/fake-mcp'].includes(c),
  pathExists: (p) => p.startsWith('/srv/'),
  ...extra,
});

const FAKE_TOKEN = 'fake-token-0000000000000000000000abcd';

const claudeDesktop = JSON.stringify({
  mcpServers: {
    'notes-demo': { command: 'npx', args: ['-y', '@example/notes-mcp', '/srv/notes'], env: { NOTES_API_KEY: FAKE_TOKEN } },
    'win-wrapped': { command: 'cmd', args: ['/c', 'npx', '-y', '@example/weather-mcp'] },
    'win-shim': { command: 'npx.cmd', args: ['-y', '@example/clock-mcp'] },
    'win-path': { command: 'C:\\Tools\\demo\\server.exe', args: [] },
    'win-arg': { command: 'node', args: ['C:\\Users\\demo\\server.js'] },
    'relative': { command: 'node', args: ['./build/index.js'] },
    'missing-cmd': { command: 'fake-binary-that-is-not-installed' },
    'client-path': { command: 'node', args: ['/Users/demo/mcp/server.js'] },
  },
});

test('parses a Claude Desktop config and classifies every entry', () => {
  const { format, candidates } = parseClientConfig(claudeDesktop, ctx());
  assert.equal(format, 'mcpServers');
  const by = Object.fromEntries(candidates.map(c => [c.sourceName, c]));

  assert.equal(by['notes-demo'].importable, true);
  assert.deepEqual(by['notes-demo'].config, {
    type: 'stdio', name: 'notes-demo', command: 'npx', args: ['-y', '@example/notes-mcp', '/srv/notes'],
    active: true, env: { NOTES_API_KEY: FAKE_TOKEN },
  });

  assert.equal(by['win-wrapped'].importable, true);
  assert.equal(by['win-wrapped'].config.command, 'npx');
  assert.deepEqual(by['win-wrapped'].config.args, ['-y', '@example/weather-mcp']);

  assert.equal(by['win-shim'].config.command, 'npx');
  assert.equal(by['win-path'].importable, false);
  assert.equal(by['win-arg'].importable, false);
  assert.equal(by['relative'].importable, false);

  assert.equal(by['missing-cmd'].importable, true);
  assert.ok(by['missing-cmd'].issues.some(i => i.level === 'warn' && /not found/.test(i.message)));
  assert.ok(by['client-path'].issues.some(i => i.level === 'warn' && /does not exist on the gateway host/.test(i.message)));
});

test('preview never contains a secret in full', () => {
  const { candidates } = parseClientConfig(claudeDesktop, ctx());
  const masked = JSON.stringify(candidates.map(maskCandidate));
  assert.ok(!masked.includes(FAKE_TOKEN));
  assert.ok(masked.includes('abcd'), 'last 4 characters are shown as a hint');
});

test('secrets in args, URLs and headers are masked', () => {
  const text = JSON.stringify({
    mcpServers: {
      db: { command: 'npx', args: ['-y', '@example/db-mcp', 'postgresql://demo:hunter2hunter2@db.example.test/app', '--api-key', 'sk-fake000000000000000000', '--token=plainfaketoken123456'] },
      remote: { type: 'http', url: 'https://mcp.example.test/mcp?api_key=fakequerysecret', headers: { Authorization: `Bearer ${FAKE_TOKEN}` } },
    },
  });
  const { candidates } = parseClientConfig(text, ctx());
  const masked = JSON.stringify(candidates.map(maskCandidate));
  for (const secret of ['hunter2hunter2', 'sk-fake000000000000000000', 'plainfaketoken123456', 'fakequerysecret', FAKE_TOKEN]) {
    assert.ok(!masked.includes(secret), `${secret} leaked into the preview`);
  }
  const remote = candidates.find(c => c.sourceName === 'remote');
  assert.equal(remote.config.bearerToken, FAKE_TOKEN, 'the stored entry keeps the real token');
});

test('maskSecret hides short values entirely', () => {
  assert.equal(maskSecret('abc'), '•••••• (3 chars)');
  assert.equal(maskSecret(''), '(empty)');
});

test('remote entries: type inference and header mapping', () => {
  const text = JSON.stringify({
    mcpServers: {
      a: { url: 'https://a.example.test/sse' },
      b: { url: 'https://b.example.test/mcp' },
      c: { type: 'sse', url: 'https://c.example.test/events', headers: { 'X-API-Key': 'fake-key', 'X-Other': 'x' } },
      d: { url: 'ftp://d.example.test/' },
    },
  });
  const by = Object.fromEntries(parseClientConfig(text, ctx()).candidates.map(c => [c.sourceName, c]));
  assert.equal(by.a.config.type, 'sse');
  assert.equal(by.b.config.type, 'http');
  assert.equal(by.c.config.type, 'sse');
  assert.equal(by.c.config.apiKey, 'fake-key');
  assert.ok(by.c.issues.some(i => /X-Other/.test(i.message)));
  assert.equal(by.d.importable, false);
});

test('VS Code mcp.json with comments, trailing commas and input placeholders', () => {
  const text = `{
    // VS Code workspace config
    "inputs": [{ "id": "demo-key", "type": "promptString", "password": true }],
    "servers": {
      "fetch-demo": { "type": "stdio", "command": "uvx", "args": ["fake-fetch-mcp"], "env": { "KEY": "\${input:demo-key}" }, },
      /* remote */
      "remote-demo": { "type": "http", "url": "https://vs.example.test/mcp" },
    },
  }`;
  const { format, candidates } = parseClientConfig(text, ctx());
  assert.equal(format, 'vscode');
  assert.equal(candidates.length, 2);
  const fetch = candidates.find(c => c.sourceName === 'fetch-demo');
  assert.ok(fetch.issues.some(i => /placeholder/.test(i.message)));
  assert.equal(fetch.importable, true);
});

test('VS Code settings.json "mcp.servers" is accepted', () => {
  const { format, candidates } = parseClientConfig(JSON.stringify({ mcp: { servers: { x: { command: 'npx', args: ['-y', 'fake'] } } } }), ctx());
  assert.equal(format, 'vscode');
  assert.equal(candidates[0].key, 'x');
});

test('Claude Code .mcp.json: disabled flag and http type', () => {
  const text = JSON.stringify({ mcpServers: {
    off: { type: 'stdio', command: 'npx', args: ['-y', 'fake'], disabled: true },
    web: { type: 'http', url: 'https://cc.example.test/mcp', headers: { Authorization: 'Bearer fake' } },
  } });
  const by = Object.fromEntries(parseClientConfig(text, ctx()).candidates.map(c => [c.sourceName, c]));
  assert.equal(by.off.config.active, false);
  assert.equal(by.web.config.bearerToken, 'fake');
});

test('name clashes get a free key; keys are sanitised', () => {
  const text = JSON.stringify({ mcpServers: { files: { command: 'npx' }, 'my server.v2': { command: 'npx' } } });
  const { candidates } = parseClientConfig(text, ctx(['files', 'files-2']));
  const files = candidates.find(c => c.sourceName === 'files');
  assert.equal(files.clash, true);
  assert.equal(files.key, 'files-3');
  assert.equal(candidates.find(c => c.sourceName === 'my server.v2').key, 'my-server-v2');
});

test('rejects non-JSON and configs without servers', () => {
  assert.throws(() => parseClientConfig('not json', ctx()), /Not valid JSON/);
  assert.throws(() => parseClientConfig('{"foo": {}}', ctx()), /No "mcpServers"/);
  assert.throws(() => parseClientConfig('', ctx()), /empty/);
});

test('stripJsonc leaves strings alone', () => {
  assert.equal(JSON.parse(stripJsonc('{"a": "http://x//y", /* c */ "b": [1,2,],}')).a, 'http://x//y');
});

test('applySelections: rename, replace, refusals', () => {
  const { candidates } = parseClientConfig(claudeDesktop, ctx(['notes-demo']));
  const notes = candidates.find(c => c.sourceName === 'notes-demo');
  const winPath = candidates.find(c => c.sourceName === 'win-path');

  const servers = { 'notes-demo': { type: 'stdio', command: 'old' } };
  assert.throws(() => applySelections(servers, candidates, [{ id: notes.id, key: 'notes-demo' }]), /already exists/);
  assert.throws(() => applySelections(servers, candidates, [{ id: winPath.id, key: 'win-path' }]), /cannot run/);
  assert.throws(() => applySelections(servers, candidates, [{ id: notes.id, key: 'bad key!' }]), /not a valid/);
  assert.throws(() => applySelections(servers, candidates, []), /Select at least one/);
  assert.equal(servers['notes-demo'].command, 'old', 'a failed apply changes nothing');

  assert.deepEqual(applySelections(servers, candidates, [{ id: notes.id, key: 'notes-demo-2' }]), ['notes-demo-2']);
  assert.equal(servers['notes-demo-2'].env.NOTES_API_KEY, FAKE_TOKEN);
  applySelections(servers, candidates, [{ id: notes.id, key: 'notes-demo', replace: true }]);
  assert.equal(servers['notes-demo'].command, 'npx');
});

test('previews are bound to the session that made them', () => {
  const id = storePreview('session-a', []);
  assert.deepEqual(takePreview(id, 'session-a'), []);
  assert.equal(takePreview(id, 'session-b'), null);
  assert.equal(takePreview('nope', 'session-a'), null);
});

test('the preview masks with the same module and rules as the Servers tab', async () => {
  const shared = await import('../build/configSecrets.js');
  assert.equal(maskSecret, shared.maskSecret, 'one maskSecret');
  const text = JSON.stringify({
    mcpServers: {
      box: {
        command: 'npx',
        args: ['-y', 'ssh-mcp', '--password', '/fake-password-value-0101', '--password=/fake-password-value-0102', '--key=/srv/id'],
        env: { LOG_LEVEL: 'debug', PASSWORD: '/fake-password-value-0103', SSH_KEY_PATH: '/srv/id' },
      },
    },
  });
  const [c] = parseClientConfig(text, ctx()).candidates;
  const m = maskCandidate(c);
  const json = JSON.stringify(m);
  for (const n of ['0101', '0102', '0103']) assert.ok(!json.includes(`value-${n}`), `leaked ${n} (args, env or issue messages)`);
  const env = Object.fromEntries(m.env.map(e => [e.name, e.value]));
  assert.equal(env.LOG_LEVEL, 'debug', 'harmless env values are shown, as on the Servers tab');
  assert.equal(env.SSH_KEY_PATH, '/srv/id');
  assert.equal(env.PASSWORD, shared.maskEnvValue('PASSWORD', '/fake-password-value-0103'));
  assert.equal(m.args[5], '--key=/srv/id');
});

test('entries that cannot run still show what they were, masked', () => {
  const text = JSON.stringify({ mcpServers: { win: { command: 'C:\demo\srv.exe', args: ['--x'], env: { DEMO_TOKEN: FAKE_TOKEN } } } });
  const [c] = parseClientConfig(text, ctx()).candidates;
  assert.equal(c.importable, false);
  const m = maskCandidate(c);
  assert.equal(m.command, 'C:\demo\srv.exe');
  assert.ok(!JSON.stringify(m).includes(FAKE_TOKEN));
});

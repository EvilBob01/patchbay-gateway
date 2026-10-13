// Offline tests for masking backend secrets in the admin Servers tab
// (src/configSecrets.ts): GET /admin/config masks, POST /admin/config merges
// unchanged masked values back from the stored file.
//
// Run from the fork root after a build:  node --test test/config-secrets.test.mjs
// All secrets below are fake; addresses are RFC 5737 documentation ranges.
import assert from 'node:assert/strict';
import test from 'node:test';

const { maskConfigSecrets, mergeConfigSecrets, maskSecret, isMasked, MaskedSecretError, MASKED_MARKER } =
  await import('../build/configSecrets.js');

const FAKE_TOKEN = 'fake-bearer-token-0000000000001111';
const FAKE_KEY = 'fake-api-key-22223333';
const FAKE_PASS = 'not-a-real-password-4444';
const FAKE_GH = 'ghp_FAKEFAKEFAKEFAKEFAKE5555';

const stored = () => ({
  mcpServers: {
    web: { type: 'http', url: 'https://bot:fake-url-pass@192.0.2.10/mcp?token=fake-q-tok&x=1', bearerToken: FAKE_TOKEN, apiKey: FAKE_KEY, active: true },
    mail: {
      type: 'stdio', command: 'node',
      args: ['index.js', '--host', '198.51.100.7', '--api-key', FAKE_GH, '--password=' + FAKE_PASS, 'postgres://u:fake-db-pass@203.0.113.5/db'],
      env: { IMAP_PASS: FAKE_PASS, LOG_LEVEL: 'debug', EMPTY: '' },
    },
  },
  proxy: { retryHttpToolCall: true },
});

const allSecrets = [FAKE_TOKEN, FAKE_KEY, FAKE_PASS, FAKE_GH, 'fake-url-pass', 'fake-q-tok', 'fake-db-pass'];

test('masked config contains no secret in full and carries the marker', () => {
  const masked = maskConfigSecrets(stored());
  const text = JSON.stringify(masked);
  for (const s of allSecrets) assert.ok(!text.includes(s), `leaked ${s}`);
  assert.equal(masked[MASKED_MARKER], true);
  assert.equal(masked.mcpServers.web.bearerToken, maskSecret(FAKE_TOKEN));
  assert.match(masked.mcpServers.web.bearerToken, /^••••••1111 \(34 chars\)$/);
  assert.equal(masked.mcpServers.web.url, 'https://bot:••••••@192.0.2.10/mcp?token=••••••&x=1');
  assert.equal(masked.mcpServers.mail.env.LOG_LEVEL, 'debug', 'harmless env values are shown');
  assert.equal(masked.mcpServers.mail.env.EMPTY, '', 'empty values stay empty');
  assert.deepEqual(masked.mcpServers.mail.args.slice(0, 3), ['index.js', '--host', '198.51.100.7'], 'harmless args untouched');
  assert.ok(isMasked(masked.mcpServers.mail.args[4]));
  assert.match(masked.mcpServers.mail.args[5], /^--password=••••••/);
  assert.deepEqual(masked.proxy, { retryHttpToolCall: true });
});

test('env values are masked only when they look secret', () => {
  const env = {
    LOG_LEVEL: 'debug', HOST: '198.51.100.7', PORT: 993, DATA_DIR: '/var/lib/fake-dir-1234567890abc',
    WIN_DIR: 'C:\fake\dir\with\digits0123456789',
    IMAP_PW: 'fake-pw', SMTP_PIN: '0000', CLIENT_SECRET: 'fake-secret',
    SOMETHING: 'Zm9vYmFyZmFrZTEyMzQ1Njc4OTA', GH: FAKE_GH,
    DATABASE_URL: 'postgres://u:fake-db-pass@203.0.113.5/db', PLAIN_URL: 'https://192.0.2.10/api',
  };
  const out = maskConfigSecrets({ mcpServers: { s: { type: 'stdio', command: 'x', env } } }).mcpServers.s.env;
  for (const n of ['LOG_LEVEL', 'HOST', 'PORT', 'DATA_DIR', 'WIN_DIR', 'PLAIN_URL']) assert.equal(out[n], env[n], `${n} shown`);
  for (const n of ['IMAP_PW', 'SMTP_PIN', 'CLIENT_SECRET', 'SOMETHING', 'GH']) assert.equal(out[n], maskSecret(env[n]), `${n} masked`);
  assert.equal(out.DATABASE_URL, 'postgres://u:••••••@203.0.113.5/db');
  // ...and every one of them survives a save round trip.
  const st = { mcpServers: { s: { type: 'stdio', command: 'x', env } } };
  assert.deepEqual(mergeConfigSecrets(maskConfigSecrets(st), st), st);
});

test('file paths stay visible under secret-sounding names', () => {
  const args = ['ssh-mcp', '-y', '--', '--host=192.0.2.40', '--user=root', '--key=/root/.ssh/id_ed25519', '--group=dev', '--identity-file', 'C:\keys\fake', '--password=fake-ssh-pass'];
  const env = { SSH_KEY_PATH: '~/.ssh/id_fake', TOKEN_FILE: './fake-token.txt' };
  const st = { mcpServers: { box: { type: 'stdio', command: 'npx', args, env } } };
  const out = maskConfigSecrets(st).mcpServers.box;
  assert.deepEqual(out.args.slice(0, 9), args.slice(0, 9));
  assert.equal(out.args[9], '--password=' + maskSecret('fake-ssh-pass'));
  assert.deepEqual(out.env, env);
  assert.deepEqual(mergeConfigSecrets(maskConfigSecrets(st), st), st);
});

test('a secret-sounding name wins over a path-looking value', () => {
  const env = {
    PASSWORD: '/fake-password-value-0001', API_TOKEN: './fake-token-value-0002', DB_PASS: '~/fake-pass-value-0003',
    KEY_FILE: 'sk-fakefakefakefake0004',
    SSH_KEY_PATH: '/root/.ssh/id', LOG_DIR: '/var/log/x', PASSWORD_FILE: '/run/secrets/pw', TLS_CERT_FILE: '/etc/fake.pem',
  };
  const args = [
    'ssh-mcp', '--password=/fake-password-value-0005', '--password', '/fake-password-value-0006',
    '--token', 'C:/fake-token-value-0007', '--key=abc123fakesecret0008',
    '--key=/root/.ssh/id', '--key', '/root/.ssh/id2', '--identity-file', '/root/.ssh/id3', '--key-file=/etc/fake.key',
    '--config=/etc/ssh-mcp.toml', '/srv/data',
  ];
  const st = { mcpServers: { box: { type: 'stdio', command: 'npx', args, env } } };
  const out = maskConfigSecrets(st).mcpServers.box;
  const text = JSON.stringify(out);
  for (const n of ['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008']) {
    assert.ok(!text.includes(`value-${n}`) && !text.includes(`fake${n}`) && !text.includes(`secret${n}`), `leaked ${n}`);
  }
  for (const n of ['PASSWORD', 'API_TOKEN', 'DB_PASS', 'KEY_FILE']) assert.equal(out.env[n], maskSecret(env[n]), `${n} masked`);
  for (const n of ['SSH_KEY_PATH', 'LOG_DIR', 'PASSWORD_FILE', 'TLS_CERT_FILE']) assert.equal(out.env[n], env[n], `${n} shown`);
  assert.equal(out.args[1], '--password=' + maskSecret('/fake-password-value-0005'));
  assert.equal(out.args[3], maskSecret('/fake-password-value-0006'));
  assert.equal(out.args[5], maskSecret('C:/fake-token-value-0007'));
  assert.equal(out.args[6], '--key=' + maskSecret('abc123fakesecret0008'));
  assert.deepEqual(out.args.slice(7), args.slice(7), 'named path fields and plain paths are shown');
  // The masked-save round trip still holds under the new rules...
  assert.deepEqual(mergeConfigSecrets(maskConfigSecrets(st), st), st);
  // ...and a half-edited masked path-looking password is still refused.
  const half = maskConfigSecrets(st);
  half.mcpServers.box.env.PASSWORD = half.mcpServers.box.env.PASSWORD.replace('0001', '0009');
  assert.throws(() => mergeConfigSecrets(half, st), MaskedSecretError);
  const halfArg = maskConfigSecrets(st);
  halfArg.mcpServers.box.args[3] = halfArg.mcpServers.box.args[3].replace('chars', 'chars ');
  assert.throws(() => mergeConfigSecrets(halfArg, st), MaskedSecretError);
});

test('masking does not mutate its input', () => {
  const s = stored();
  maskConfigSecrets(s);
  assert.deepEqual(s, stored());
});

test('posting the masked config back unchanged restores every stored value', () => {
  const merged = mergeConfigSecrets(maskConfigSecrets(stored()), stored());
  assert.deepEqual(merged, stored());
  assert.ok(!(MASKED_MARKER in merged));
});

test('an edited value replaces the stored one; untouched ones are kept', () => {
  const posted = maskConfigSecrets(stored());
  posted.mcpServers.web.bearerToken = 'fake-new-token-9999';
  posted.mcpServers.mail.env.LOG_LEVEL = 'info';
  posted.mcpServers.mail.env.IMAP_PASS = 'fake-replaced-pass';
  posted.mcpServers.mail.env.NEW_VAR = 'fake-new-value';
  delete posted.mcpServers.web.apiKey;
  const merged = mergeConfigSecrets(posted, stored());
  assert.equal(merged.mcpServers.web.bearerToken, 'fake-new-token-9999');
  assert.ok(!('apiKey' in merged.mcpServers.web), 'a removed secret stays removed');
  assert.equal(merged.mcpServers.mail.env.LOG_LEVEL, 'info');
  assert.equal(merged.mcpServers.mail.env.NEW_VAR, 'fake-new-value');
  assert.equal(merged.mcpServers.mail.env.IMAP_PASS, 'fake-replaced-pass');
  assert.deepEqual(merged.mcpServers.mail.args, stored().mcpServers.mail.args);
  assert.equal(merged.mcpServers.web.url, stored().mcpServers.web.url);
});

test('a renamed backend keeps its secrets via _originalKey, which is not written', () => {
  const posted = maskConfigSecrets(stored());
  posted.mcpServers.website = { ...posted.mcpServers.web, _originalKey: 'web' };
  delete posted.mcpServers.web;
  const merged = mergeConfigSecrets(posted, stored());
  assert.equal(merged.mcpServers.website.bearerToken, FAKE_TOKEN);
  assert.equal(merged.mcpServers.website.apiKey, FAKE_KEY);
  assert.ok(!('_originalKey' in merged.mcpServers.website));
});

test('a renamed env var, or args reordered, still resolve to the same secret', () => {
  const posted = maskConfigSecrets(stored());
  const env = posted.mcpServers.mail.env;
  env.IMAP_PASSWORD = env.IMAP_PASS;
  delete env.IMAP_PASS;
  const args = posted.mcpServers.mail.args;
  posted.mcpServers.mail.args = [args[5], ...args.slice(0, 5), args[6]];
  const merged = mergeConfigSecrets(posted, stored());
  assert.equal(merged.mcpServers.mail.env.IMAP_PASSWORD, FAKE_PASS);
  assert.equal(merged.mcpServers.mail.args[0], '--password=' + FAKE_PASS);
  assert.equal(merged.mcpServers.mail.args[5], FAKE_GH);
});

test('a half-edited or orphaned masked value is refused, without echoing secrets', () => {
  const cases = [
    p => { p.mcpServers.web.bearerToken += 'x'; },                                // typed into the mask
    p => { p.mcpServers.other = { type: 'http', url: 'https://192.0.2.20/', bearerToken: p.mcpServers.web.bearerToken.replace('1111', '0000') }; },
    p => { p.mcpServers.web.url = 'https://bot:••••••@192.0.2.99/mcp'; },        // host changed, password masked
    p => { p.mcpServers.mail.args[4] = '•••••• (3 chars)'; },
  ];
  for (const edit of cases) {
    const posted = maskConfigSecrets(stored());
    edit(posted);
    assert.throws(() => mergeConfigSecrets(posted, stored()), err => {
      assert.ok(err instanceof MaskedSecretError);
      for (const s of allSecrets) assert.ok(!err.message.includes(s));
      return true;
    });
  }
});

test('ambiguous masks (same length, no direct match) are refused', () => {
  const st = { mcpServers: { s: { type: 'stdio', command: 'x', env: { A_TOKEN: 'fake-aa', B_TOKEN: 'fake-bb' } } } };
  const posted = maskConfigSecrets(st);
  posted.mcpServers.s.env = { C_TOKEN: posted.mcpServers.s.env.A_TOKEN };
  assert.throws(() => mergeConfigSecrets(posted, st), MaskedSecretError);
  // Same masks but still under their own names: resolves directly.
  assert.deepEqual(mergeConfigSecrets(maskConfigSecrets(st), st), st);
});

test('a masked value cannot pull a secret from a different backend', () => {
  const posted = maskConfigSecrets(stored());
  posted.mcpServers.copy = { type: 'http', url: 'https://192.0.2.30/', bearerToken: posted.mcpServers.web.bearerToken };
  assert.throws(() => mergeConfigSecrets(posted, stored()), MaskedSecretError);
});

test('first save with no stored file: plain values pass through', () => {
  const posted = { mcpServers: { a: { type: 'http', url: 'https://192.0.2.1/', bearerToken: 'fake-first' } } };
  assert.deepEqual(mergeConfigSecrets(posted, {}), posted);
});

test('R1: empty credential args stay empty through mask and an unchanged save', () => {
  const st = { mcpServers: { x: { type: 'stdio', command: 'node', args: ['--password', '', '--token=', '--api-key', 'fake-key-value-1234'] } } };
  const shown = maskConfigSecrets(st);
  assert.deepEqual(shown.mcpServers.x.args.slice(0, 3), ['--password', '', '--token=']);
  assert.ok(isMasked(shown.mcpServers.x.args[4]), 'non-empty values are still masked');
  assert.deepEqual(mergeConfigSecrets(shown, st), st);
  assert.ok(!JSON.stringify(mergeConfigSecrets(shown, st)).includes('(empty)'));
});

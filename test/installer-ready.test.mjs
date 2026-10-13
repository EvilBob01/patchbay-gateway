// The installer's readiness wait (scripts/install.sh, wait_ready): it must end
// within PATCHBAY_READY_TIMEOUT even when /healthz is slow or never answers (R3).
// Only the wait_ready function is taken out of install.sh and run under bash
// against a local HTTP server on 127.0.0.1; the installer itself is not run.
//
// Needs bash and curl. On Windows that is Git Bash (a bare `bash` there can be
// WSL's); without one the tests are skipped.
//
// Run from the repo root:  node --test test/installer-ready.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function findBash() {
  if (process.platform === 'win32') {
    const git = 'C:\\Program Files\\Git\\bin\\bash.exe';
    return existsSync(git) ? git : undefined;
  }
  return spawnSync('bash', ['-c', 'command -v curl'], { stdio: 'ignore' }).status === 0 ? 'bash' : undefined;
}
const BASH = findBash();
const skip = BASH ? false : 'needs bash and curl (Git Bash on Windows)';

/** The wait_ready function, exactly as install.sh has it. */
function waitReadySource() {
  const text = readFileSync(path.join(ROOT, 'scripts', 'install.sh'), 'utf8').replaceAll('\r\n', '\n');
  const begin = text.indexOf('\nwait_ready() {\n');
  assert.ok(begin >= 0, 'install.sh defines wait_ready');
  const end = text.indexOf('\n}\n', begin);
  assert.ok(end > begin);
  return text.slice(begin + 1, end + 2);
}

/**
 * Run wait_ready against url with a timeout; resolves { rc, ms }. ms is timed
 * inside bash, around wait_ready alone: starting bash itself can take a second
 * or more on a busy Windows machine, and that is not the wait's doing.
 */
function runWait(url, timeout) {
  const script = `${waitReadySource()}\nt0=$(date +%s%N); wait_ready '${url}' ${timeout}; rc=$?\n`
    + `echo $(( ($(date +%s%N) - t0) / 1000000 )); exit $rc\n`;
  const child = spawn(BASH, ['--noprofile', '--norc', '-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; });
  child.stderr.on('data', b => { stderr += b; });
  // A hung wait would otherwise hang the suite; this kills only our own child.
  const guard = setTimeout(() => child.kill(), (timeout + 10) * 1000);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (rc) => { clearTimeout(guard); resolve({ rc, ms: Number(stdout.trim()), stderr }); });
  });
}

/** A /healthz server on 127.0.0.1 that answers after delayMs (Infinity: never). */
async function healthz(delayMs) {
  const server = http.createServer((_req, res) => {
    if (delayMs === Infinity) return;
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); }, delayMs);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/healthz`,
    close: () => { server.closeAllConnections(); return new Promise(r => server.close(r)); },
  };
}

test('R3: a /healthz slower than the timeout fails within about the timeout', { skip }, async () => {
  const s = await healthz(6000);
  try {
    const { rc, ms, stderr } = await runWait(s.url, 2);
    assert.equal(rc, 1, stderr);
    assert.ok(ms < 3500, `took ${ms} ms for a 2 s timeout`);
  } finally { await s.close(); }
});

test('R3: a /healthz that never answers fails within about the timeout', { skip }, async () => {
  const s = await healthz(Infinity);
  try {
    const { rc, ms, stderr } = await runWait(s.url, 2);
    assert.equal(rc, 1, stderr);
    assert.ok(ms < 3500, `took ${ms} ms for a 2 s timeout`);
  } finally { await s.close(); }
});

test('R3: a /healthz that answers at once, or slowly within the budget, succeeds', { skip }, async () => {
  const fast = await healthz(0);
  try {
    const { rc, ms, stderr } = await runWait(fast.url, 5);
    assert.equal(rc, 0, stderr);
    assert.ok(ms < 3000, `took ${ms} ms`);
  } finally { await fast.close(); }
  const slow = await healthz(1500);
  try {
    const { rc, stderr } = await runWait(slow.url, 5);
    assert.equal(rc, 0, stderr);
  } finally { await slow.close(); }
});

/** The ready_timeout_seconds function, exactly as install.sh has it. */
function readyTimeoutSource() {
  const text = readFileSync(path.join(ROOT, 'scripts', 'install.sh'), 'utf8').replaceAll('\r\n', '\n');
  const begin = text.indexOf('\nready_timeout_seconds() {\n');
  assert.ok(begin >= 0, 'install.sh defines ready_timeout_seconds');
  const end = text.indexOf('\n}\n', begin);
  return text.slice(begin + 1, end + 2);
}

// rc3 re-check RC3-1: "08" passed validation, then bash arithmetic read it as
// octal and wait_ready failed without a single request. Zero-padded values are
// decimal; anything that is not 1-9999 seconds is refused up front.
test('RC3-1: PATCHBAY_READY_TIMEOUT is read as decimal, zero padding included', { skip }, () => {
  const cases = { '08': '8', '09': '9', '010': '10', '180': '180', '0180': '180', '9999': '9999',
    '0': null, '0000': null, '': null, 'abc': null, '-5': null, '12345': null, '1.5': null };
  for (const [input, want] of Object.entries(cases)) {
    const r = spawnSync(BASH, ['--noprofile', '--norc', '-c', `set -euo pipefail\n${readyTimeoutSource()}\nready_timeout_seconds '${input}'`], { encoding: 'utf8' });
    if (want === null) assert.notEqual(r.status, 0, `"${input}" must be refused (got "${r.stdout.trim()}")`);
    else { assert.equal(r.status, 0, `"${input}": ${r.stderr}`); assert.equal(r.stdout.trim(), want, `"${input}"`); }
  }
});

test('RC3-1: a zero-padded timeout still waits for and reaches /healthz', { skip }, async () => {
  const s = await healthz(0);
  try {
    const t = spawnSync(BASH, ['--noprofile', '--norc', '-c', `${readyTimeoutSource()}\nready_timeout_seconds 08`], { encoding: 'utf8' }).stdout.trim();
    const { rc, stderr } = await runWait(s.url, t);
    assert.equal(rc, 0, stderr);
  } finally { await s.close(); }
});

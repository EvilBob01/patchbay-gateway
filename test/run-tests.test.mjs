// scripts/run-tests.mjs: the files that assert wall-clock bounds run on their
// own, after the rest, so a loaded concurrent run can't stretch their timers.
// Runs the runner on a temp folder of stub test files that record overlap.
//
// Run from the repo root:  node --test test/run-tests.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Each stub appends "start <name> <running>" and "end <name>" to a shared log,
// where <running> lists the stubs that had started and not yet ended.
const stub = (log, name) => `
import { appendFileSync, readFileSync } from 'node:fs';
import test from 'node:test';
const log = ${JSON.stringify(log)};
const running = () => { const open = new Set(); for (const l of readFileSync(log, 'utf8').split('\\n')) { const [k, n] = l.split(' '); if (k === 'start') open.add(n); if (k === 'end') open.delete(n); } return [...open]; };
test(${JSON.stringify(name)}, async () => {
  appendFileSync(log, 'start ${name} ' + running().join(',') + '\\n');
  await new Promise(r => setTimeout(r, 400));
  appendFileSync(log, 'end ${name}\\n');
});
`;

test('timing-sensitive files run alone, after the others', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pb-runner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'order.log');
  writeFileSync(log, '');
  const names = ['a-other', 'installer-ready', 'readyz', 'admin-features', 'z-other'];
  for (const n of names) writeFileSync(path.join(dir, `${n}.test.mjs`), stub(log, n));

  // NODE_TEST_CONTEXT would make the nested runs report to this one instead.
  const env = { ...process.env, PATCHBAY_TEST_DIR: dir };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-tests.mjs')], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const starts = readFileSync(log, 'utf8').split('\n').filter(l => l.startsWith('start ')).map(l => l.split(' '));
  assert.equal(starts.length, names.length, readFileSync(log, 'utf8'));
  const timing = ['installer-ready', 'readyz', 'admin-features'];
  for (const [, name, others = ''] of starts) {
    if (timing.includes(name)) assert.equal(others, '', `${name} ran alongside ${others}`);
  }
  const order = starts.map(s => s[1]);
  const lastOther = Math.max(order.indexOf('a-other'), order.indexOf('z-other'));
  for (const name of timing) assert.ok(order.indexOf(name) > lastOther, `${name} ran before the other files: ${order}`);
});

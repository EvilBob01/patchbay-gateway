#!/usr/bin/env node
// Runs the offline suite: test/*.test.mjs only. The test/*.live.mjs scripts
// need a running gateway and are run by hand on a box after a deploy. Node 20's
// bare `node --test` would pick those up too, and it has no glob support.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// PATCHBAY_TEST_DIR points it at another folder (test/run-tests.test.mjs).
const testDir = process.env.PATCHBAY_TEST_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test');

// Files that assert wall-clock bounds run after the rest, one at a time: in the
// concurrent run a loaded box stretches their timers, and they fail on load,
// not on a bug. Their bounds stay as they are.
const TIMING = ['installer-ready.test.mjs', 'readyz.test.mjs', 'admin-features.test.mjs'];
const all = readdirSync(testDir).filter(f => f.endsWith('.test.mjs')).sort();
const rest = all.filter(f => !TIMING.includes(f)).map(f => path.join(testDir, f));
const timing = TIMING.filter(f => all.includes(f)).map(f => path.join(testDir, f));

let failed = false;
for (const batch of [rest, ...timing.map(f => [f])]) {
  const r = spawnSync(process.execPath, ['--test', ...batch], { stdio: 'inherit' });
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);

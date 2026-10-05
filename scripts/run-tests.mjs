#!/usr/bin/env node
// Runs the offline suite: test/*.test.mjs only. The test/*.live.mjs scripts
// need a running gateway and are run by hand on a box after a deploy. Node 20's
// bare `node --test` would pick those up too, and it has no glob support.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test');
const files = readdirSync(testDir).filter(f => f.endsWith('.test.mjs')).sort().map(f => path.join(testDir, f));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);

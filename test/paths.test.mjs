// Offline tests for the legacy on-disk path fallback (src/paths.ts).
//
// Run from the repo root after a build:  node test/paths.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathDefault } from '../build/paths.js';

const dir = mkdtempSync(path.join(tmpdir(), 'paths-'));
const current = path.join(dir, 'patchbay-gateway');
const legacy = path.join(dir, 'mcp-gateway-audit');
const ENV = 'PATCHBAY_TEST_PATH';

test.after(() => rmSync(dir, { recursive: true, force: true }));
test.beforeEach(() => { delete process.env[ENV]; });

test('env var wins over both defaults', () => {
  mkdirSync(legacy, { recursive: true });
  process.env[ENV] = '/somewhere/else';
  assert.equal(pathDefault(ENV, current, legacy), '/somewhere/else');
  rmSync(legacy, { recursive: true });
});

test('blank env var counts as unset', () => {
  process.env[ENV] = '  ';
  assert.equal(pathDefault(ENV, current, legacy), current);
});

test('new default when neither path exists', () => {
  assert.equal(pathDefault(ENV, current, legacy), current);
});

test('legacy path when only it exists', () => {
  mkdirSync(legacy, { recursive: true });
  assert.equal(pathDefault(ENV, current, legacy), legacy);
  rmSync(legacy, { recursive: true });
});

test('new default when both exist', () => {
  mkdirSync(legacy, { recursive: true });
  mkdirSync(current, { recursive: true });
  assert.equal(pathDefault(ENV, current, legacy), current);
});

// scripts/install.sh keeps the code root-owned and points PATCHBAY_CONFIG_DIR at
// a writable directory. Anything the gateway writes must follow it: tool_pins.json
// once went to <install>/config and the service crashed at startup (EACCES).
const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('tool_pins.json follows PATCHBAY_CONFIG_DIR', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    "const m = await import('./build/toolPins.js'); console.log(m.TOOL_PINS_PATH);"],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, PATCHBAY_CONFIG_DIR: '/srv/pb-config', MCP_TOOL_PINS_PATH: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), path.join('/srv/pb-config', 'tool_pins.json'));
});

test('only src/paths.ts builds a path to the config directory', () => {
  const srcDir = path.join(repo, 'src');
  const offenders = readdirSync(srcDir).filter(f => f.endsWith('.ts') && f !== 'paths.ts')
    .filter(f => /(__dirname|import\.meta\.url|process\.cwd\(\))[^;]*['"]config['"]/.test(readFileSync(path.join(srcDir, f), 'utf8')));
  assert.deepEqual(offenders, [], 'use configPath()/workingConfigPath() from src/paths.ts instead');
});

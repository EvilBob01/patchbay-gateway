// Offline tests for the legacy on-disk path fallback (src/paths.ts).
//
// Run from the repo root after a build:  node test/paths.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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

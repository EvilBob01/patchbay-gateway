// The gateway and client versions come from package.json (src/version.ts),
// never from literals scattered through the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'));

test('VERSION equals package.json', async () => {
  const { VERSION } = await import(pathToFileURL(path.join(root, 'build', 'version.js')).href);
  assert.equal(VERSION, pkg.version);
});

test('no hard-coded version literal in client.ts or mcp-proxy.ts', () => {
  for (const f of ['client.ts', 'mcp-proxy.ts']) {
    const src = readFileSync(path.join(root, 'src', f), 'utf-8');
    assert.ok(!/version:\s*['"]\d+\.\d+\.\d+/.test(src), `${f} has a literal version`);
    assert.ok(src.includes("from './version.js'"), `${f} should import VERSION`);
  }
});

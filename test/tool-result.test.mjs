// Offline tests for merging adjacent text blocks in tool results
// (src/tool-result.ts) and the MCP_MERGE_TEXT_CONTENT / per-user toggle.
//
// The first six tests are ported from willscottuk/mcp-proxy-server 190093a1.
//
// Run from the fork root after a build:  node test/tool-result.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// identity.ts -> users.ts reads MCP_USERS_PATH at import time.
const dir = mkdtempSync(path.join(tmpdir(), 'tool-result-'));
const USERS = path.join(dir, 'users.json');
process.env.MCP_USERS_PATH = USERS;
writeFileSync(USERS, JSON.stringify([
  { username: 'claude-user', token: 't-plain', createdAt: '2026-01-01T00:00:00.000Z' },
  { username: 'chatgpt-user', token: 't-on', createdAt: '2026-01-01T00:00:00.000Z', mergeTextContent: true },
  { username: 'opted-out', token: 't-off', createdAt: '2026-01-01T00:00:00.000Z', mergeTextContent: false },
  { username: 'bad-value', token: 't-bad', createdAt: '2026-01-01T00:00:00.000Z', mergeTextContent: 'yes' },
]));
test.after(() => rmSync(dir, { recursive: true, force: true }));

delete process.env.MCP_MERGE_TEXT_CONTENT;
const T = await import('../build/tool-result.js');
const { mergeAdjacentTextContent, shapeToolResult, shouldMergeTextContent } = T;
const { resolveIdentity, STATIC_IDENTITY } = await import('../build/identity.js');

const twoBlocks = () => ({ content: [{ type: 'text', text: 'meta' }, { type: 'text', text: 'body' }] });
const joined = { content: [{ type: 'text', text: 'meta\n\nbody' }] };
const user = (extra = {}) => ({ kind: 'user', username: 'u', source: 'users.json', ...extra });

// --- mergeAdjacentTextContent (upstream) -----------------------------------

test('joins a metadata block and a body block into one text block', () => {
  const result = {
    content: [
      { type: 'text', text: '{"document":{"title":"Styleguide"}}' },
      { type: 'text', text: '# Styleguide\n\nBody.' },
    ],
  };

  assert.deepEqual(mergeAdjacentTextContent(result), {
    content: [{ type: 'text', text: '{"document":{"title":"Styleguide"}}\n\n# Styleguide\n\nBody.' }],
  });
});

test('joins one block per row from list tools', () => {
  const result = { content: ['{"id":1}', '{"id":2}', '{"id":3}'].map((text) => ({ type: 'text', text })) };

  assert.deepEqual(mergeAdjacentTextContent(result).content, [{ type: 'text', text: '{"id":1}\n\n{"id":2}\n\n{"id":3}' }]);
});

test('keeps non-text blocks in place and only joins adjacent text', () => {
  const image = { type: 'image', data: 'abc', mimeType: 'image/png' };
  const result = {
    content: [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      image,
      { type: 'text', text: 'c' },
    ],
  };

  assert.deepEqual(mergeAdjacentTextContent(result).content, [{ type: 'text', text: 'a\n\nb' }, image, { type: 'text', text: 'c' }]);
});

test('preserves the other result fields', () => {
  const result = {
    content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    structuredContent: { ok: true },
    isError: false,
  };

  const merged = mergeAdjacentTextContent(result);

  assert.deepEqual(merged.structuredContent, { ok: true });
  assert.equal(merged.isError, false);
});

test('does not join text blocks that carry annotations or metadata', () => {
  const result = {
    content: [
      { type: 'text', text: 'a', annotations: { audience: ['user'] } },
      { type: 'text', text: 'b' },
    ],
  };

  assert.equal(mergeAdjacentTextContent(result), result);
});

test('returns results with nothing to join unchanged', () => {
  const single = { content: [{ type: 'text', text: 'only' }] };
  const noContent = { toolResult: 'legacy' };

  assert.equal(mergeAdjacentTextContent(single), single);
  assert.equal(mergeAdjacentTextContent(noContent), noContent);
  assert.equal(mergeAdjacentTextContent(undefined), undefined);
});

// --- toggle ----------------------------------------------------------------

test('gateway default is off when MCP_MERGE_TEXT_CONTENT is unset', () => {
  assert.equal(T.MERGE_TEXT_CONTENT_DEFAULT, false);
  const result = twoBlocks();
  assert.equal(shapeToolResult(result, user()), result, 'same object, untouched');
  assert.equal(shapeToolResult(result, STATIC_IDENTITY), result);
  assert.equal(shapeToolResult(result, undefined), result);
});

test('MCP_MERGE_TEXT_CONTENT=true turns merging on gateway-wide', async () => {
  process.env.MCP_MERGE_TEXT_CONTENT = 'true';
  const On = await import('../build/tool-result.js?env=on'); // fresh module instance
  delete process.env.MCP_MERGE_TEXT_CONTENT;

  assert.equal(On.MERGE_TEXT_CONTENT_DEFAULT, true);
  assert.deepEqual(On.shapeToolResult(twoBlocks(), user()), joined);
  assert.deepEqual(On.shapeToolResult(twoBlocks(), STATIC_IDENTITY), joined);
  assert.match(On.mergeTextContentConfigSummary(), /ON/);
});

test('only the exact string "true" enables it', async () => {
  for (const value of ['1', 'TRUE', 'yes', '']) {
    process.env.MCP_MERGE_TEXT_CONTENT = value;
    const M = await import(`../build/tool-result.js?env=${encodeURIComponent(value) || 'empty'}`);
    assert.equal(M.MERGE_TEXT_CONTENT_DEFAULT, false, `value ${JSON.stringify(value)}`);
  }
  delete process.env.MCP_MERGE_TEXT_CONTENT;
});

test('per-user mergeTextContent overrides the gateway default both ways', () => {
  assert.equal(shouldMergeTextContent(user(), false), false);
  assert.equal(shouldMergeTextContent(user(), true), true);
  assert.equal(shouldMergeTextContent(user({ mergeTextContent: true }), false), true);
  assert.equal(shouldMergeTextContent(user({ mergeTextContent: false }), true), false);

  assert.deepEqual(shapeToolResult(twoBlocks(), user({ mergeTextContent: true }), false), joined);
  const result = twoBlocks();
  assert.equal(shapeToolResult(result, user({ mergeTextContent: false }), true), result);
});

test('resolveIdentity carries a boolean mergeTextContent from users.json, and only a boolean', async () => {
  const sets = [new Set(['t-plain', 't-on', 't-off', 't-bad', 'env'])];
  assert.equal((await resolveIdentity('t-plain', sets)).mergeTextContent, undefined);
  assert.equal((await resolveIdentity('t-on', sets)).mergeTextContent, true);
  assert.equal((await resolveIdentity('t-off', sets)).mergeTextContent, false);
  assert.equal('mergeTextContent' in (await resolveIdentity('t-bad', sets)), false);
  assert.equal((await resolveIdentity('env', sets)).mergeTextContent, undefined);
});

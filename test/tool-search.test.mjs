// search_tools ranking (src/tool-search.ts) and the read/write tool class
// (policy.ts toolClass). The discovery set (fixtures/discovery.json) is
// "query -> expected tool" over generic sample backends: each expected tool
// must be in the top 5. It exists to catch descriptions that are too alike to
// tell apart, and ranking regressions.
//
// Run from the fork root after a build:  node --test test/tool-search.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const build = (m) => import(pathToFileURL(path.join(here, '..', 'build', m)).href);
const { tokenize, toolTokens, rankBM25, firstSentence } = await build('tool-search.js');
const { compilePolicy, NO_POLICY } = await build('policy.js');

const fixture = JSON.parse(readFileSync(path.join(here, 'fixtures', 'discovery.json'), 'utf-8'));
const docs = Object.entries(fixture.backends).flatMap(([backend, { description, tools }]) =>
  Object.entries(tools).map(([name, desc]) => ({
    item: `${backend}/${name}`,
    tokens: toolTokens(backend, description, { name, description: desc, inputSchema: { type: 'object', properties: {} } }),
  })));

test('discovery set: every expected tool is in the top 5', () => {
  const misses = [];
  for (const [query, expected] of fixture.cases) {
    const hits = rankBM25(query, docs, 5, 25).map(h => h.item);
    if (!hits.includes(expected)) misses.push(`"${query}" -> ${expected}; got ${hits.join(', ') || '(nothing)'}`);
  }
  assert.deepEqual(misses, []);
});

test('discovery set: most expected tools rank first', () => {
  const first = fixture.cases.filter(([q, e]) => rankBM25(q, docs, 1, 25)[0]?.item === e).length;
  console.log(`discovery: ${first}/${fixture.cases.length} ranked first`);
  assert.ok(first / fixture.cases.length >= 0.8, `${first}/${fixture.cases.length} ranked first`);
});

test('discovery set: a specific word beats a common one ("list", "get", "delete", "search")', () => {
  const wrong = [];
  for (const [query, expected] of fixture.mustRankFirst) {
    const hits = rankBM25(query, docs, 1, 25).map(h => h.item);
    if (hits[0] !== expected || hits.length !== 1) wrong.push(`"${query}" -> ${expected}; got ${hits.join(', ') || '(nothing)'}`);
  }
  assert.deepEqual(wrong, []);
});

test('indexing: parameter names count, parameter descriptions and boilerplate do not', () => {
  const t = toolTokens('hv', '', { name: 'stop_vm', description: 'Stop a VM. Long explanation here.', inputSchema: { type: 'object', properties: { vmid: { type: 'number', description: 'The unique numeric identifier' } } } });
  assert.ok(t.includes('vmid'));
  assert.ok(!t.includes('identifier'));
  assert.equal(t.filter(x => x === 'stop').length, 3 + 2, 'name x3 + first sentence x2');
  assert.equal(t.filter(x => x === 'explanation').length, 1);
});

test('tokenize splits names and drops stop words', () => {
  assert.deepEqual(tokenize('list_vms'), ['list', 'vm']);
  assert.deepEqual(tokenize('getNodeStatus'), ['get', 'node', 'status']);
  assert.deepEqual(tokenize('read-command'), ['read', 'command']);
  assert.deepEqual(tokenize('Read the contents of a file.'), ['read', 'content', 'file']);
  assert.deepEqual(tokenize('find_user'), ['search', 'user'], 'verb synonyms fold');
});

test('ties at the cutoff are all returned, up to the ceiling; no match returns nothing', () => {
  const same = (id) => ({ item: id, tokens: ['run', 'command'] });
  const pool = ['a', 'b', 'c', 'd'].map(same);
  assert.equal(rankBM25('run', pool, 1, 25).length, 4);
  assert.equal(rankBM25('run', pool, 1, 3).length, 3);
  assert.deepEqual(rankBM25('nothing here', pool, 5, 25), []);
  assert.deepEqual(rankBM25('', pool, 5, 25), []);
});

test('firstSentence takes the first sentence of the first line, capped', () => {
  assert.equal(firstSentence('Run a command. Then more.'), 'Run a command.');
  assert.equal(firstSentence('\n  First line\nsecond'), 'First line');
  assert.equal(firstSentence('x'.repeat(300)).length, 160);
  assert.equal(firstSentence(undefined), '');
});

test('toolClass: write rule beats read rule beats readOnlyHint; unknown is write', () => {
  const p = compilePolicy({ toolClass: { read: ['hv/list_*', 'hv/get_*'], write: ['hv/get_secret'] } });
  assert.equal(p.classifyTool('hv', 'list_vms').toolClass, 'read');
  assert.equal(p.classifyTool('hv', 'get_secret', { readOnlyHint: true }).toolClass, 'write', 'write beats a hint too');
  assert.equal(p.classifyTool('hv', 'stop_vm').toolClass, 'write');
  assert.equal(p.classifyTool('hv', 'stop_vm', { readOnlyHint: true }).source, 'readOnlyHint');
  assert.equal(p.classifyTool('hv', 'stop_vm', { readOnlyHint: 'yes' }).toolClass, 'write', 'only a real true counts');
  assert.equal(NO_POLICY.classifyTool('a', 'b', { readOnlyHint: true }).toolClass, 'read');
  assert.equal(NO_POLICY.classifyTool('a', 'b').toolClass, 'write');
});

test('toolClass: malformed sections are rejected like any policy error', () => {
  assert.throws(() => compilePolicy({ toolClass: [] }), /toolClass: must be an object/);
  assert.throws(() => compilePolicy({ toolClass: { reads: [] } }), /unknown key "reads"/);
  assert.throws(() => compilePolicy({ toolClass: { read: ['hv'] } }), /must be "\*" or "<backend>\/<tool>"/);
});

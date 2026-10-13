// Offline tests for tool collapsing's planning and routing (src/collapse.ts).
// The end-to-end path through the gateway's handlers is in
// collapse-gateway.test.mjs.
//
// Run from the fork root after a build:  node --test test/collapse.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

delete process.env.MCP_COLLAPSE_TOOLS;
const C = await import('../build/collapse.js');
const { buildCollapsePlan, renderCollapsedTool, resolveCollapsedCall, shouldCollapseTools, kindPrefix, COLLAPSE_TOOLS_DEFAULT } = C;

const schema = () => ({ type: 'object', properties: { command: { type: 'string' } }, required: ['command'] });
const def = (name, extra = {}) => ({ name, description: `${name} does things`, inputSchema: schema(), ...extra });
const cand = (backend, tool, { kind = 'ssh-mcp', exposedName, overridden = false } = {}) => {
  const key = `${backend}__${tool.name}`;
  return { key, backend, tool, kind, exposedName: exposedName ?? key, overridden };
};
const fleet = (hosts, tools = ['run-command', 'read-command']) =>
  hosts.flatMap(h => tools.map(t => cand(h, def(t))));

test('off by default; per-user collapseTools wins in both directions', () => {
  assert.equal(COLLAPSE_TOOLS_DEFAULT, false);
  assert.equal(shouldCollapseTools({ kind: 'user', username: 'a', source: 'users.json' }), false);
  assert.equal(shouldCollapseTools({ kind: 'user', username: 'a', source: 'users.json' }, true), true);
  assert.equal(shouldCollapseTools({ kind: 'user', username: 'a', source: 'users.json', collapseTools: true }, false), true);
  assert.equal(shouldCollapseTools({ kind: 'user', username: 'a', source: 'users.json', collapseTools: false }, true), false);
  assert.equal(shouldCollapseTools(undefined, true), true);
});

test('identical tools on several backends of one kind collapse, one per tool name', () => {
  const plan = buildCollapsePlan(fleet(['web01', 'db01', 'app01']), '__');
  assert.deepEqual([...plan.tools.keys()], ['ssh__read-command', 'ssh__run-command']);
  const rc = plan.tools.get('ssh__run-command');
  assert.equal(rc.toolName, 'run-command');
  assert.deepEqual([...rc.members], [['app01', 'app01__run-command'], ['db01', 'db01__run-command'], ['web01', 'web01__run-command']]);
  assert.equal(plan.memberOf.get('db01__read-command'), 'ssh__read-command');
  assert.equal(plan.memberOf.size, 6);
  assert.deepEqual(plan.warnings, []);
});

test('the configured separator is used, and kind prefixes drop -mcp', () => {
  assert.equal(kindPrefix('ssh-mcp'), 'ssh');
  assert.equal(kindPrefix('context7'), 'context7');
  const plan = buildCollapsePlan(fleet(['web01', 'db01']).map(c => ({ ...c, key: c.key.replace('__', '--'), exposedName: c.key.replace('__', '--') })), '--');
  assert.ok(plan.tools.has('ssh--run-command'));
});

test('a single backend never collapses', () => {
  assert.equal(buildCollapsePlan(fleet(['web01']), '__').tools.size, 0);
});

test('unknown-kind backends never collapse, even when identical', () => {
  const plan = buildCollapsePlan(fleet(['a', 'b']).map(c => ({ ...c, kind: 'unknown' })), '__');
  assert.equal(plan.tools.size, 0);
});

test('backends of different kinds are not merged with each other', () => {
  const cands = [...fleet(['web01']), ...fleet(['mailx']).map(c => ({ ...c, kind: 'imap-mcp' }))];
  assert.equal(buildCollapsePlan(cands, '__').tools.size, 0);
});

test('a drifted schema stays separate; the majority still collapses', () => {
  const cands = fleet(['web01', 'db01', 'app01']);
  const drifted = cands.find(c => c.key === 'app01__read-command');
  drifted.tool = def('read-command', { description: 'older wording' });
  const plan = buildCollapsePlan(cands, '__');
  assert.deepEqual([...plan.tools.get('ssh__read-command').members.keys()], ['db01', 'web01']);
  assert.equal(plan.memberOf.has('app01__read-command'), false, 'drifted tool keeps its own name');
  assert.equal(plan.memberOf.get('app01__run-command'), 'ssh__run-command', 'its other tools still collapse');
  assert.match(plan.warnings.join('\n'), /ssh__read-command: app01 differs/);
});

test('a schema difference (not just description) also counts as drift', () => {
  const cands = fleet(['web01', 'db01', 'app01']);
  const s = schema(); s.properties.command.maxLength = 10;
  cands.find(c => c.key === 'web01__run-command').tool = def('run-command', { inputSchema: s });
  assert.deepEqual([...buildCollapsePlan(cands, '__').tools.get('ssh__run-command').members.keys()], ['app01', 'db01']);
});

test('key order inside a schema does not count as a difference', () => {
  const cands = fleet(['web01', 'db01']);
  const t = cands.find(c => c.key === 'db01__run-command').tool;
  t.inputSchema = { required: ['command'], properties: { command: { type: 'string' } }, type: 'object' };
  assert.equal(buildCollapsePlan(cands, '__').tools.get('ssh__run-command').members.size, 2);
});

test('a 1-1 split collapses nothing', () => {
  const cands = fleet(['web01', 'db01'], ['run-command']);
  cands[1].tool = def('run-command', { description: 'other' });
  assert.equal(buildCollapsePlan(cands, '__').tools.size, 0);
});

test('a tie between two equal splits goes to the alphabetically first backend, deterministically', () => {
  const cands = fleet(['d', 'c', 'b', 'a'], ['run-command']);
  for (const c of cands) if (c.backend === 'a' || c.backend === 'c') c.tool = def('run-command', { description: 'variant' });
  const members = [...buildCollapsePlan(cands, '__').tools.get('ssh__run-command').members.keys()];
  assert.deepEqual(members, ['a', 'c']);
  assert.deepEqual([...buildCollapsePlan([...cands].reverse(), '__').tools.get('ssh__run-command').members.keys()], members);
});

test('extra and missing tools stay per-host', () => {
  const cands = [...fleet(['web01', 'db01']), cand('db01', def('tail-log'))].filter(c => c.key !== 'web01__read-command');
  const plan = buildCollapsePlan(cands, '__');
  assert.deepEqual([...plan.tools.keys()], ['ssh__run-command']);
  assert.equal(plan.memberOf.has('db01__tail-log'), false);
  assert.equal(plan.memberOf.has('db01__read-command'), false);
});

test('a tool renamed or re-described in tool_config.json is never collapsed', () => {
  const cands = fleet(['web01', 'db01', 'app01'], ['run-command']);
  cands[0].overridden = true;
  const plan = buildCollapsePlan(cands, '__');
  assert.equal(plan.memberOf.has(cands[0].key), false);
  assert.equal(plan.tools.get('ssh__run-command').members.size, 2);
});

test('a schema that already has a host property is left alone', () => {
  const s = schema(); s.properties.host = { type: 'string' };
  const cands = fleet(['web01', 'db01'], ['run-command']).map(c => ({ ...c, tool: def('run-command', { inputSchema: s }) }));
  const plan = buildCollapsePlan(cands, '__');
  assert.equal(plan.tools.size, 0);
  assert.match(plan.warnings[0], /already has a "host" property/);
});

test('a collapsed name that clashes with a real or exposed tool name is not used', () => {
  const real = [...fleet(['web01', 'db01'], ['run-command']), cand('ssh', def('run-command'), { kind: 'unknown' })];
  assert.equal(buildCollapsePlan(real, '__').tools.size, 0);
  const renamed = [...fleet(['web01', 'db01'], ['run-command']), cand('misc', def('x'), { kind: 'unknown', exposedName: 'ssh__run-command', overridden: true })];
  const plan = buildCollapsePlan(renamed, '__');
  assert.equal(plan.tools.size, 0);
  assert.match(plan.warnings[0], /already exists/);
});

test('rendered tool: host first, required, enum as given; original schema untouched', () => {
  const plan = buildCollapsePlan(fleet(['web01', 'db01']), '__');
  const ct = plan.tools.get('ssh__run-command');
  const t = renderCollapsedTool(ct, ['db01']);
  assert.equal(t.name, 'ssh__run-command');
  assert.match(t.description, /^run-command does things\n\nAvailable on several hosts: choose one with "host"\.$/);
  assert.equal(t.inputSchema.type, 'object');
  assert.deepEqual(Object.keys(t.inputSchema.properties), ['host', 'command']);
  assert.deepEqual(t.inputSchema.properties.host.enum, ['db01']);
  assert.equal(t.inputSchema.properties.host.type, 'string');
  assert.deepEqual(t.inputSchema.required, ['host', 'command']);
  assert.deepEqual(ct.template.inputSchema, schema(), 'template not mutated');
  JSON.parse(JSON.stringify(t)); // plain JSON, as the wire needs
});

test('rendered tool: a template without properties or required still yields a valid object schema', () => {
  const ct = { name: 'x__t', toolName: 't', template: { name: 't', inputSchema: { type: 'object' } }, members: new Map([['a', 'a__t']]) };
  const t = renderCollapsedTool(ct, ['a']);
  assert.deepEqual(t.inputSchema, { type: 'object', properties: { host: { type: 'string', enum: ['a'], description: t.inputSchema.properties.host.description } }, required: ['host'] });
  assert.equal(t.description, 'Available on several hosts: choose one with "host".');
});

const RO = { readOnlyHint: true, openWorldHint: false };
const annotatedFleet = (hosts) => hosts.map(h => cand(h, def('read-command', {
  title: 'Read-only command', annotations: { ...RO },
  outputSchema: { type: 'object', properties: { out: { type: 'string' } } },
})));

test('rendered tool: carries the shared title, annotations and outputSchema', () => {
  const plan = buildCollapsePlan(annotatedFleet(['web01', 'db01']), '__');
  const ct = plan.tools.get('ssh__read-command');
  const t = renderCollapsedTool(ct, ['web01', 'db01']);
  assert.equal(t.title, 'Read-only command');
  assert.deepEqual(t.annotations, RO);
  assert.deepEqual(t.outputSchema, { type: 'object', properties: { out: { type: 'string' } } });
  t.annotations.readOnlyHint = false;
  assert.equal(ct.template.annotations.readOnlyHint, true, 'template not mutated');
});

test('rendered tool: a template without them gets none of them', () => {
  const t = renderCollapsedTool(buildCollapsePlan(fleet(['web01', 'db01']), '__').tools.get('ssh__run-command'), ['web01']);
  assert.deepEqual(Object.keys(t).sort(), ['description', 'inputSchema', 'name']);
});

test('differing annotations count as drift: the odd host stays separate with its own hints', () => {
  const cands = annotatedFleet(['a', 'b', 'c']);
  cands[2].tool.annotations = { readOnlyHint: false, destructiveHint: true };
  const plan = buildCollapsePlan(cands, '__');
  assert.deepEqual([...plan.tools.get('ssh__read-command').members.keys()], ['a', 'b']);
  assert.equal(plan.memberOf.has('c__read-command'), false);
  assert.match(plan.warnings[0], /^ssh__read-command: c differs/);
});

test('annotations present on some hosts and absent on others also count as drift', () => {
  const cands = [...annotatedFleet(['a', 'b']), cand('c', def('read-command', { title: 'Read-only command' }))];
  const plan = buildCollapsePlan(cands, '__');
  assert.deepEqual([...plan.tools.get('ssh__read-command').members.keys()], ['a', 'b']);
});

test('title or outputSchema differences count as drift too; key order inside annotations does not', () => {
  for (const patch of [{ title: 'other' }, { outputSchema: { type: 'object' } }]) {
    const cands = annotatedFleet(['a', 'b', 'c']);
    Object.assign(cands[0].tool, patch);
    assert.deepEqual([...buildCollapsePlan(cands, '__').tools.get('ssh__read-command').members.keys()], ['b', 'c']);
  }
  const cands = annotatedFleet(['a', 'b']);
  cands[1].tool.annotations = { openWorldHint: false, readOnlyHint: true };
  assert.equal(buildCollapsePlan(cands, '__').tools.get('ssh__read-command').members.size, 2);
});

test('resolve: routes to the real key and strips host; leaves other names alone', () => {
  const plan = buildCollapsePlan(fleet(['web01', 'db01']), '__');
  assert.deepEqual(resolveCollapsedCall(plan, 'ssh__run-command', { host: 'db01', command: 'uptime' }),
    { kind: 'route', key: 'db01__run-command', backend: 'db01', args: { command: 'uptime' } });
  assert.deepEqual(resolveCollapsedCall(plan, 'web01__run-command', { command: 'x' }), { kind: 'none' });
  assert.deepEqual(resolveCollapsedCall(plan, 'nope', undefined), { kind: 'none' });
});

test('resolve: missing, non-string or non-member host is bad-host', () => {
  const plan = buildCollapsePlan(fleet(['web01', 'db01']), '__');
  for (const args of [undefined, {}, { host: 7 }, { host: 'app01' }, { host: '__proto__' }, { host: 'toString' }]) {
    assert.equal(resolveCollapsedCall(plan, 'ssh__run-command', args).kind, 'bad-host', JSON.stringify(args));
  }
});

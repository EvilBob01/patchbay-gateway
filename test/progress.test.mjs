// Progress notifications and the client's _meta, end to end through the
// gateway on every call path: direct, collapsed (ssh__* with host) and lazy
// (patchbay__call_read / call_write). The fake backend's long-task reports two
// progress steps when it gets a progressToken and echoes the _meta it received.
//
// Run from the fork root after a build:  node --test test/progress.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { startGateway, fakeBackend, who } from './fixtures/gateway.mjs';

const gw = await startGateway({
  prefix: 'progress-',
  servers: {
    web01: fakeBackend('web01', 'ssh-mcp', '--progress'),
    db01: fakeBackend('db01', 'ssh-mcp', '--progress'),
    pve: { ...fakeBackend('pve', '--progress'), lazy: true },
  },
  policy: { default: { allow: ['*'] }, toolClass: { read: ['pve/long-task'] } },
});
test.after(() => gw.stop());

const PLAIN = who('plain');
const COLLAPSER = who('collapser', { collapseTools: true });

/** Call with a client progressToken (and an extra _meta key); collect what comes back. */
async function callWithProgress(identity, name, args, token) {
  const s = await gw.session(identity);
  const res = await s.rpc('tools/call', { name, arguments: args, _meta: { progressToken: token, traceId: 'trace-1' } });
  await new Promise(r => setTimeout(r, 50));
  const progress = s.transport.notifications.filter(n => n.msg.method === 'notifications/progress');
  return { res, progress, body: res.result ? JSON.parse(res.result.content[0].text) : undefined };
}

const paths = [
  ['direct', PLAIN, 'web01__long-task', {}, 'web01'],
  ['collapsed', COLLAPSER, 'ssh__long-task', { host: 'db01' }, 'db01'],
  ['lazy call_read', PLAIN, 'patchbay__call_read', { tool: 'pve/long-task' }, 'pve'],
  ['lazy call_write', PLAIN, 'patchbay__call_write', { tool: 'pve/long-task' }, 'pve'],
];

for (const [label, identity, name, args, backend] of paths) {
  test(`${label}: backend progress reaches the client under the client's own token`, async () => {
    const token = `tok-${label}`;
    const { res, progress, body } = await callWithProgress(identity, name, args, token);
    assert.ok(res.result, JSON.stringify(res.error));
    assert.equal(body.backend, backend);
    assert.equal(body.hadToken, true, 'the backend was asked for progress');
    assert.deepEqual(progress.map(p => p.msg.params), [
      { progressToken: token, progress: 1, total: 2, message: `${backend} step 1` },
      { progressToken: token, progress: 2, total: 2, message: `${backend} step 2` },
    ]);
    assert.ok(progress.every(p => p.relatedRequestId === res.id), 'sent on the calling request\'s stream');
  });

  test(`${label}: the client's other _meta keys reach the backend`, async () => {
    const { body } = await callWithProgress(identity, name, args, `tok2-${label}`);
    assert.deepEqual(body.meta, { traceId: 'trace-1' });
  });
}

test('without a progressToken nothing is requested from the backend and nothing is relayed', async () => {
  const s = await gw.session(PLAIN);
  const res = await s.rpc('tools/call', { name: 'web01__long-task', arguments: {} });
  assert.equal(JSON.parse(res.result.content[0].text).hadToken, false);
  assert.equal(s.transport.notifications.filter(n => n.msg.method === 'notifications/progress').length, 0);
});

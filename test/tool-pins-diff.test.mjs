// The review tab's line diff (public/tool-pins.js), loaded in a bare vm context.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = { window: {}, document: undefined };
ctx.globalThis = ctx;
vm.runInNewContext(readFileSync(new URL('../public/tool-pins.js', import.meta.url), 'utf-8'), ctx);
// Copied out of the vm realm: its arrays have another Array.prototype, which deepStrictEqual rejects.
const lineDiff = (a, b) => JSON.parse(JSON.stringify(ctx.lineDiff(a, b)));

test('lineDiff marks removed and added lines and keeps common ones', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nX\nc').map(d => d.op + d.text), [' a', '-b', '+X', ' c']);
  assert.deepEqual(lineDiff('', 'new'), [{ op: '+', text: 'new' }]);
  assert.deepEqual(lineDiff('same', 'same'), [{ op: ' ', text: 'same' }]);
});

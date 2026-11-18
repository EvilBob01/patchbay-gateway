// Offline DOM test for the Add Server wizard (public/wizard.js), run in jsdom on
// the real admin page: the SSH host entry it builds must start a pinned ssh-mcp
// with --disableApproval. A bare "ssh-mcp" started npm's latest, which asks the
// client to approve destructive commands and uploads; the gateway doesn't pass
// that on, so those calls always failed with APPROVAL_UNAVAILABLE.
//
// Run from the repo root:  node --test test/wizard-dom.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** The admin page with only the wizard script loaded; returns the Review step's JSON. */
async function reviewFor(fields) {
  const html = readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://127.0.0.1/admin/' });
  const w = dom.window;
  w.HTMLElement.prototype.focus = () => {};
  w.eval(readFileSync(path.join(PUBLIC, 'wizard.js'), 'utf8'));
  // wizard.js wires its buttons on DOMContentLoaded.
  if (w.document.readyState === 'loading') await new Promise(r => w.document.addEventListener('DOMContentLoaded', r));
  const $ = (id) => w.document.getElementById(id);
  w.openWizard();
  $('wz-name').value = 'web01';
  $('wz-next').click();
  for (const [id, v] of Object.entries(fields)) $(id).value = v;
  $('wz-next').click();
  $('wz-next').click();
  assert.equal($('wizard-error').textContent, '', 'no validation error');
  return JSON.parse($('wz-review').value).web01;
}

test('wizard: an SSH host runs a pinned ssh-mcp with --disableApproval', async () => {
  const conf = await reviewFor({ 'wz-host': '192.0.2.10', 'wz-user': 'ops', 'wz-key': '/var/lib/patchbay/.ssh/id_ed25519', 'wz-group': 'dev' });
  assert.equal(conf.command, 'npx');
  assert.equal(conf.args[0], '-y');
  assert.match(conf.args[1], /^ssh-mcp@\d+\.\d+\.\d+$/, `pinned spec, got ${conf.args[1]}`);
  assert.ok(conf.args.includes('--disableApproval'), 'approval prompts off');
  assert.ok(conf.args.includes('--group=dev'));
  assert.ok(conf.args.includes('--host=192.0.2.10'));
});

test('the Servers tab blank SSH template pins the same ssh-mcp version', async () => {
  const conf = await reviewFor({ 'wz-host': 'h', 'wz-user': 'u', 'wz-key': '/k', 'wz-group': 'prod' });
  const script = readFileSync(path.join(PUBLIC, 'script.js'), 'utf8');
  assert.ok(script.includes(`"${conf.args[1]}"`), `script.js template uses ${conf.args[1]}`);
  assert.equal(script.match(/"ssh-mcp"/g), null, 'no unpinned ssh-mcp in script.js');
});

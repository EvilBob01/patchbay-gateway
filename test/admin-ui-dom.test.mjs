// Offline DOM tests for the admin UI's Servers and Tools tabs (public/*.js),
// run in jsdom: config values must render as text, never as markup (B2), and
// saving the Servers tab must keep every backend's argv exactly (B5).
//
// Run from the repo root after a build:  node --test test/admin-ui-dom.test.mjs
// Nothing here is real: payloads are inert markup, servers are fake.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { parseClientConfig, applySelections } from '../build/importConfig.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SCRIPTS = ['html.js', 'ssh-policy.js', 'servers.js', 'tools.js', 'users.js', 'mail-accounts.js'];

const PAGE = `<!doctype html><body>
  <div id="save-status"></div><button id="save-config-button">Save</button><div id="server-list"></div>
  <div id="tool-list"></div><div id="user-list"></div><div id="mail-account-list"></div>
</body>`;

/** A page with the admin scripts loaded; fetch answers from `routes` and records POSTs. */
function page(routes = {}) {
  const dom = new JSDOM(PAGE, { runScripts: 'outside-only', url: 'http://127.0.0.1/admin/' });
  const w = dom.window;
  const posts = [];
  w.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    if (opts.method === 'POST') posts.push({ url, body });
    const r = routes[url];
    const data = typeof r === 'function' ? r(body) : r;
    return { ok: data !== undefined, status: data !== undefined ? 200 : 404, statusText: '', headers: { get: (n) => (n.toLowerCase() === 'x-config-revision' ? 'test-rev' : null) }, json: async () => data ?? {} };
  };
  w.triggerReload = async () => {};
  w.console.log = () => {};
  for (const f of SCRIPTS) {
    const file = path.join(PUBLIC, f);
    if (existsSync(file)) w.eval(readFileSync(file, 'utf8'));
  }
  return { w, doc: w.document, posts };
}

const PAYLOADS = [
  '<img src=x onerror="window.__pwned=1">',
  '" autofocus onfocus="window.__pwned=2" x="',
  "' onmouseover='window.__pwned=3' x='",
  '</textarea><img src=x onerror="window.__pwned=4">',
  '<script>window.__pwned=5</script>',
];

/** Fails when markup from a payload became an element or attribute. */
function assertNoInjection(root) {
  for (const el of root.querySelectorAll('*')) {
    assert.ok(!['IMG', 'SCRIPT'].includes(el.tagName), `payload created <${el.tagName.toLowerCase()}>`);
    for (const a of el.attributes) {
      assert.ok(!(/^on/i.test(a.name) && a.value.includes('__pwned')), `payload created attribute ${a.name} on <${el.tagName.toLowerCase()}>`);
      assert.ok(!['autofocus', 'x'].includes(a.name), `payload created attribute ${a.name}`);
    }
  }
}

const flush = () => new Promise(r => setTimeout(r, 0));

async function save(p) {
  // These tests render the entries themselves, standing in for a completed
  // load; Save is refused on a page with no loaded revision (tested below).
  if (!p.w.serverConfigRevision) p.w.serverConfigRevision = 'test-rev';
  p.w.initializeServerSaveListener();
  p.doc.getElementById('save-config-button').click();
  await flush(); await flush();
  const post = p.posts.find(x => x.url === '/admin/config');
  return post?.body;
}

const echoSave = { '/admin/config': (body) => ({ success: true, config: body }) };

test('B2: a crafted imported name renders as text on the saved Servers tab', () => {
  for (const payload of PAYLOADS) {
    const { candidates } = parseClientConfig(JSON.stringify({ mcpServers: { [payload]: { command: 'npx', args: ['-y', '@example/fake-mcp'] } } }), {
      existingKeys: [], platform: 'linux', commandExists: () => true, pathExists: () => true,
    });
    const servers = {};
    const [key] = applySelections(servers, candidates, [{ id: candidates[0].id, key: candidates[0].key, }]);
    servers[key].active = false; // an inactive entry is enough
    const p = page();
    p.w.renderServerConfig({ mcpServers: servers });
    const list = p.doc.getElementById('server-list');
    assertNoInjection(list);
    const entry = list.querySelector('.server-entry');
    assert.ok(entry.querySelector('.server-header h3').textContent.includes(payload), 'name shown literally');
    assert.equal(entry.querySelector('.server-name-input').value, payload);
    assert.equal(p.w.__pwned, undefined);
  }
});

test('B2: every config field on the Servers tab is shown as text', () => {
  for (const payload of PAYLOADS) {
    const p = page();
    p.w.renderServerConfig({
      mcpServers: {
        s: {
          type: 'stdio', name: payload, description: payload, command: payload, args: [payload],
          env: { [payload]: payload }, installDirectory: payload, installCommands: [payload],
        },
        h: { type: 'http', name: payload, url: 'https://192.0.2.1/' + payload, apiKey: payload, bearerToken: payload },
        u: { type: payload, name: payload },
      },
    });
    const list = p.doc.getElementById('server-list');
    assertNoInjection(list);
    const s = list.querySelector('.server-entry[data-server-key="s"]');
    for (const cls of ['server-name-input', 'server-description-input', 'server-command-input', 'server-install-dir-input', 'env-key-input', 'env-value-input']) {
      assert.equal(s.querySelector('.' + cls).value, payload, cls);
    }
    assert.equal(s.querySelector('.server-install-cmds-input').value, payload);
    const h = list.querySelector('.server-entry[data-server-key="h"]');
    assert.equal(h.querySelector('.server-apikey-input').value, payload);
    assert.equal(h.querySelector('.server-bearertoken-input').value, payload);
    const u = list.querySelector('.server-entry[data-server-key="u"]');
    assert.ok(u.textContent.includes(payload), 'unknown type shown literally');
  }
});

test('B2: tool names and backend-supplied descriptions render as text on the Tools tab', () => {
  for (const payload of PAYLOADS) {
    const p = page();
    p.w.renderToolEntry('fake__' + payload, { description: payload }, { exposedName: payload, exposedDescription: payload });
    const list = p.doc.getElementById('tool-list');
    assertNoInjection(list);
    assert.ok(list.querySelector('.tool-header h3').textContent.includes(payload));
    assert.ok(list.querySelector('.tool-original-description').textContent.includes(payload));
    assert.equal(list.querySelector('.tool-exposedname-input').value, payload);
    assert.equal(list.querySelector('.tool-exposeddescription-input').value, payload);
  }
});

test('B2: the shared escaper covers text and attribute contexts', () => {
  const p = page();
  assert.equal(p.w.escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(p.w.escapeHtml(null), '');
});

test('B2: usernames and mailbox fields render safely', async () => {
  for (const payload of PAYLOADS) {
    const p = page({
      '/admin/users': { users: [{ username: payload, token: 'fake-token', createdAt: '2026-01-01T00:00:00Z' }] },
      '/admin/mail-accounts': { accounts: [{ name: 'box', user: payload, imapHost: payload, imapPort: 993, smtpHost: payload, smtpPort: 587, updatedAt: '2026-01-01T00:00:00Z' }] },
    });
    await p.w.fetchUserList();
    await p.w.loadMailAccountList();
    assertNoInjection(p.doc.body);
    const btn = p.doc.querySelector('#user-list .delete-button');
    if (btn) assert.equal(btn.getAttribute('data-username'), payload);
  }
});

const ODD_ARGS = ['--label', '  two spaces  ', '', '--mode'];

test('B5: an unchanged import followed by save keeps argv byte-identical', async () => {
  const { candidates } = parseClientConfig(JSON.stringify({ mcpServers: { odd: { command: 'npx', args: ODD_ARGS } } }), {
    existingKeys: [], platform: 'linux', commandExists: () => true, pathExists: () => true,
  });
  const servers = {};
  applySelections(servers, candidates, [{ id: candidates[0].id, key: 'odd' }]);
  assert.deepEqual(servers.odd.args, ODD_ARGS, 'import keeps argv');
  const p = page(echoSave);
  p.w.currentServerConfig = { mcpServers: servers };
  p.w.renderServerConfig(p.w.currentServerConfig);
  const body = await save(p);
  assert.ok(body, 'saved');
  assert.deepEqual(body.mcpServers.odd.args, ODD_ARGS);
  assert.equal(JSON.stringify(body.mcpServers.odd.args), JSON.stringify(ODD_ARGS));
});

test('B5: args that lines cannot show open as JSON and round-trip edits exactly', async () => {
  const p = page(echoSave);
  p.w.currentServerConfig = { mcpServers: { odd: { type: 'stdio', command: 'npx', args: ODD_ARGS }, plain: { type: 'stdio', command: 'npx', args: ['-y', 'pkg'] } } };
  p.w.renderServerConfig(p.w.currentServerConfig);
  const odd = p.doc.querySelector('.server-entry[data-server-key="odd"] .server-args-input');
  const plain = p.doc.querySelector('.server-entry[data-server-key="plain"] .server-args-input');
  assert.equal(odd.dataset.argsMode, 'json');
  assert.deepEqual(JSON.parse(odd.value), ODD_ARGS);
  assert.equal(plain.dataset.argsMode, 'lines');
  assert.equal(plain.value, '-y\npkg');

  odd.value = JSON.stringify(['multi\nline', '', '  pad  ']);
  odd.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  plain.value = '-y\npkg\n--extra\n';
  plain.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  const body = await save(p);
  assert.deepEqual(body.mcpServers.odd.args, ['multi\nline', '', '  pad  ']);
  assert.deepEqual(body.mcpServers.plain.args, ['-y', 'pkg', '--extra']);
});

test('B5: switching modes never loses data; bad JSON is refused on save', async () => {
  const p = page(echoSave);
  p.w.currentServerConfig = { mcpServers: { odd: { type: 'stdio', command: 'npx', args: ODD_ARGS } } };
  p.w.renderServerConfig(p.w.currentServerConfig);
  const entry = p.doc.querySelector('.server-entry[data-server-key="odd"]');
  const ta = entry.querySelector('.server-args-input');
  const toggle = entry.querySelector('.server-args-mode-button');
  toggle.click();
  assert.equal(ta.dataset.argsMode, 'json', 'refuses to switch to lines when that would lose data');
  assert.deepEqual(JSON.parse(ta.value), ODD_ARGS);

  ta.value = '["a", 1]';
  ta.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  assert.equal(await save(p), undefined, 'not saved');
  assert.match(p.doc.getElementById('save-status').textContent, /JSON array of strings/);
});

test('B5: ssh-mcp policy controls rewrite args through the editor without losing odd args', async () => {
  const p = page(echoSave);
  const args = ['-y', 'ssh-mcp', '--', '--host=192.0.2.40', '--user=root', '  keep me  '];
  p.w.currentServerConfig = { mcpServers: { box: { type: 'stdio', command: 'npx', args } } };
  p.w.renderServerConfig(p.w.currentServerConfig);
  const entry = p.doc.querySelector('.server-entry[data-server-key="box"]');
  const select = entry.querySelector('.ssh-group-select');
  assert.ok(select, 'ssh-mcp policy section rendered');
  select.value = 'dev';
  select.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  const body = await save(p);
  assert.deepEqual(body.mcpServers.box.args, [...args, '--group=dev']);
});

test('R1: empty credential args survive GET (masked) and an unchanged save', async () => {
  const { maskConfigSecrets, mergeConfigSecrets } = await import('../build/configSecrets.js');
  const stored = { mcpServers: { x: { type: 'stdio', command: 'node', args: ['--password', '', '--token='] } } };
  const p = page(echoSave);
  p.w.currentServerConfig = maskConfigSecrets(stored);
  p.w.renderServerConfig(p.w.currentServerConfig);
  const body = await save(p);
  assert.ok(body, 'saved');
  assert.deepEqual(mergeConfigSecrets(body, stored).mcpServers.x.args, stored.mcpServers.x.args);
});

// Review finding 1 (v1.2.0-rc1): the save rebuilt each backend from the form's
// fields only, so required, probe and any other key the form doesn't edit were
// dropped. Each case runs the whole round trip: stored file -> GET (masked) ->
// render -> save -> mergeConfigSecrets, the way POST /admin/config does it.
const ROUND_TRIP_STORED = () => ({
  mcpServers: {
    stdio_opt: { name: 'Optional stdio', active: true, type: 'stdio', command: 'node', args: ['server.js'], env: { API_TOKEN: 'stdio-secret-value-123' }, installDirectory: 'tools/stdio_opt', installCommands: [], required: false, probe: false },
    http_lazy: { name: 'Lazy http', active: true, type: 'http', url: 'https://mcp.example.test/mcp', bearerToken: 'http-secret-value-456', lazy: true, required: true, description: 'lazy but required' },
    sse_extra: { active: false, type: 'sse', url: 'https://sse.example.test/sse', apiKey: 'sse-secret-value-789', probe: true, x_future: { nested: [1, 'two'] } },
  },
});

async function roundTrip(edit = () => {}) {
  const { maskConfigSecrets, mergeConfigSecrets } = await import('../build/configSecrets.js');
  const stored = ROUND_TRIP_STORED();
  const p = page(echoSave);
  p.w.currentServerConfig = maskConfigSecrets(stored);
  p.w.renderServerConfig(p.w.currentServerConfig);
  edit(p);
  const body = await save(p);
  assert.ok(body, 'saved');
  return { stored, saved: mergeConfigSecrets(body, stored).mcpServers };
}

const entryOf = (p, key) => p.doc.querySelector(`.server-entry[data-server-key="${key}"]`);

test('R4: an unchanged save keeps required, probe and unknown keys on stdio, http and sse entries', async () => {
  const { stored, saved } = await roundTrip();
  assert.deepEqual(saved, stored.mcpServers);
  assert.equal(saved.stdio_opt.required, false);
  assert.equal(saved.stdio_opt.probe, false);
  assert.equal(saved.http_lazy.lazy, true);
  assert.equal(saved.http_lazy.required, true, 'lazy + required stays required');
  assert.deepEqual(saved.sse_extra.x_future, { nested: [1, 'two'] });
});

test('R4: a renamed entry keeps its unmanaged keys and its secrets', async () => {
  const { stored, saved } = await roundTrip((p) => { entryOf(p, 'stdio_opt').querySelector('.server-key-input').value = 'stdio_renamed'; });
  assert.ok(!('stdio_opt' in saved));
  assert.deepEqual(saved.stdio_renamed, stored.mcpServers.stdio_opt);
  assert.ok(!('_originalKey' in saved.stdio_renamed));
});

test('R4: a managed field the admin cleared stays cleared', async () => {
  const { saved } = await roundTrip((p) => {
    const e = entryOf(p, 'http_lazy');
    e.querySelector('.server-lazy-input').checked = false;
    e.querySelector('.server-description-input').value = '';
    e.querySelector('.server-bearertoken-input').value = '';
    e.querySelector('.server-name-input').value = '';
    const s = entryOf(p, 'sse_extra');
    s.querySelector('.server-apikey-input').value = '';
  });
  for (const f of ['lazy', 'description', 'bearerToken', 'name']) assert.ok(!(f in saved.http_lazy), `${f} was resurrected`);
  assert.equal(saved.http_lazy.required, true, 'the unmanaged key is still carried over');
  assert.ok(!('apiKey' in saved.sse_extra), 'apiKey was resurrected');
  assert.deepEqual(saved.sse_extra.x_future, { nested: [1, 'two'] });
});

// A save that adds a field changes the entry's config, and a reload then
// reconnects a backend nobody touched. Hand-written and imported entries often
// lack the fields the form shows with a default.
test('R5: an unchanged save adds no default fields to entries that lack them', async () => {
  const { maskConfigSecrets, mergeConfigSecrets } = await import('../build/configSecrets.js');
  const stored = { mcpServers: {
    bare_stdio: { command: 'node', args: ['server.js'] },
    bare_typed: { type: 'stdio', command: 'npx', args: ['-y', 'some-mcp'], required: false },
    bare_http: { type: 'http', url: 'https://mcp.example.test/mcp' },
    // rc2 review: an explicit empty command list still gained a default directory.
    empty_cmds: { type: 'stdio', command: 'node', args: ['fake.mjs'], installCommands: [] },
  } };
  const p = page(echoSave);
  p.w.currentServerConfig = maskConfigSecrets(JSON.parse(JSON.stringify(stored)));
  p.w.renderServerConfig(p.w.currentServerConfig);
  const body = await save(p);
  assert.ok(body, 'saved');
  assert.deepEqual(mergeConfigSecrets(body, stored).mcpServers, stored.mcpServers);
});

test('R5: an edited bare entry gains only what the admin set', async () => {
  const { maskConfigSecrets, mergeConfigSecrets } = await import('../build/configSecrets.js');
  const stored = { mcpServers: { bare_stdio: { command: 'node', args: ['server.js'] } } };
  const p = page(echoSave);
  p.w.currentServerConfig = maskConfigSecrets(JSON.parse(JSON.stringify(stored)));
  p.w.renderServerConfig(p.w.currentServerConfig);
  const e = entryOf(p, 'bare_stdio');
  e.querySelector('.server-active-input').checked = false;
  const dir = e.querySelector('.server-install-dir-input');
  dir.value = 'tools/custom';
  dir.dispatchEvent(new p.w.Event('input', { bubbles: true })); // as typing does
  const saved = mergeConfigSecrets(await save(p), stored).mcpServers.bare_stdio;
  assert.equal(saved.active, false, 'a deliberate change is saved');
  assert.equal(saved.installDirectory, 'tools/custom');
  assert.ok(!('env' in saved), 'no empty env added');
});

test('R5: a directory the admin typed is kept even when it equals the default; an untouched one after a rename is not added', async () => {
  const { maskConfigSecrets, mergeConfigSecrets } = await import('../build/configSecrets.js');
  const stored = { mcpServers: {
    typed: { type: 'stdio', command: 'node', args: ['a.js'] },
    renamed: { type: 'stdio', command: 'node', args: ['b.js'], required: false },
  } };
  const p = page(echoSave);
  p.w.currentServerConfig = maskConfigSecrets(JSON.parse(JSON.stringify(stored)));
  p.w.renderServerConfig(p.w.currentServerConfig);
  const t = entryOf(p, 'typed').querySelector('.server-install-dir-input');
  const shownDefault = t.value;
  t.value = shownDefault; // the admin re-types the default: deliberate
  t.dispatchEvent(new p.w.Event('input', { bubbles: true }));
  const k = entryOf(p, 'renamed').querySelector('.server-key-input');
  k.value = 'renamed2';
  k.dispatchEvent(new p.w.Event('input', { bubbles: true })); // moves the untouched directory default along
  const saved = mergeConfigSecrets(await save(p), stored).mcpServers;
  assert.equal(saved.typed.installDirectory, shownDefault, 'an edited directory is saved');
  assert.deepEqual(saved.renamed2, stored.mcpServers.renamed, 'a rename alone adds nothing');
});

test('R4: a removed env var stays removed; a new entry gets no stray keys', async () => {
  const { saved } = await roundTrip((p) => {
    for (const row of entryOf(p, 'stdio_opt').querySelectorAll('.env-var-row')) row.remove();
    p.w.HTMLElement.prototype.scrollIntoView = () => {};
    p.w.addNewServerEntry('stdio');
    const added = p.doc.querySelector('.server-entry[data-server-key="new_stdio_server_1"]');
    added.querySelector('.server-command-input').value = 'node';
  });
  assert.deepEqual(saved.stdio_opt.env, {});
  assert.equal(saved.stdio_opt.required, false);
  assert.deepEqual(Object.keys(saved.new_stdio_server_1).sort(), ['active', 'args', 'command', 'env', 'installCommands', 'installDirectory', 'name', 'type']);
});

// A bare "mcp-remote" makes npx update its shared cache folder whenever npm has a
// newer release; two servers starting together then broke that folder on a Windows
// client. The generated config pins an exact version, and the docs and the
// installer build pin the same one.
test('Copy Desktop Config pins an exact mcp-remote version, the same as the docs and installer build', () => {
  const p = page();
  const args = JSON.parse(p.w.generateDesktopConfig('tok')).mcpServers.patchbay.args;
  assert.match(args[1], /^mcp-remote@\d+\.\d+\.\d+$/, `pinned spec, got ${args[1]}`);
  assert.equal(args[2], 'http://127.0.0.1/mcp?key=tok');
  const version = args[1].split('@')[1];
  const root = path.join(PUBLIC, '..');
  const docs = readFileSync(path.join(root, 'docs', 'client-setup.md'), 'utf8');
  assert.equal(docs.match(/"mcp-remote"/g), null, 'no unpinned mcp-remote in docs/client-setup.md');
  assert.deepEqual([...new Set(docs.match(/mcp-remote@\d+\.\d+\.\d+/g))], [args[1]]);
  const html = readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.deepEqual([...new Set(html.match(/mcp-remote@\d+\.\d+\.\d+/g))], [args[1]], 'the Users tab names the same version');
  const build = readFileSync(path.join(root, 'installer-base', 'build-base.sh'), 'utf8');
  assert.ok(build.includes(`MCP_REMOTE_VERSION="\${MCP_REMOTE_VERSION:-${version}}"`), 'build-base.sh defaults to the same version');
});

// The Servers, Tools and Users tabs send back the revision they loaded, so the
// gateway can refuse a save from an outdated page (src/fileRevision.ts), and a
// refused save says so, stays on screen and does not reload the backends.
function revisionPage(routes, revision, saveStatus = 200) {
  const p = page(routes);
  const seen = [];
  const inner = p.w.fetch;
  p.w.fetch = async (url, opts = {}) => {
    seen.push({ url, method: opts.method || 'GET', rev: opts.headers?.['X-Config-Revision'] });
    const r = await inner(url, opts);
    const status = opts.method === 'POST' ? saveStatus : r.status;
    const body = status === 409 ? { error: 'This file changed on the gateway after this page loaded it. Reload the page.', code: 'STALE_REVISION' } : await r.json();
    return { ...r, ok: status < 400, status, headers: { get: (n) => (n.toLowerCase() === 'x-config-revision' ? (opts.method === 'POST' ? 'rev-after-save' : revision) : null) }, json: async () => body };
  };
  return { ...p, seen };
}

test('Servers tab: Save sends the loaded revision, then the one the save returned', async () => {
  const cfg = { mcpServers: { box: { type: 'stdio', command: 'node', args: ['a.js'] } } };
  const p = revisionPage({ '/admin/config': (b) => b ? { success: true, config: b } : cfg }, 'rev-loaded');
  await p.w.loadServerConfig();
  p.w.initializeServerSaveListener();
  p.doc.getElementById('save-config-button').click();
  await flush(); await flush();
  p.doc.getElementById('save-config-button').click();
  await flush(); await flush();
  const posts = p.seen.filter(x => x.method === 'POST' && x.url === '/admin/config');
  assert.deepEqual(posts.map(x => x.rev), ['rev-loaded', 'rev-after-save']);
});

test('Servers tab: a refused (409) save says "Not saved", keeps the message, and does not reload', async () => {
  const cfg = { mcpServers: { box: { type: 'stdio', command: 'node', args: ['a.js'] } } };
  const p = revisionPage({ '/admin/config': (b) => b ? { success: true, config: b } : cfg }, 'rev-loaded', 409);
  let reloads = 0;
  p.w.triggerReload = async () => { reloads++; };
  await p.w.loadServerConfig();
  p.w.initializeServerSaveListener();
  p.doc.getElementById('save-config-button').click();
  await flush(); await flush();
  const status = p.doc.getElementById('save-status');
  assert.match(status.textContent, /^Not saved: .*Reload the page/);
  assert.equal(reloads, 0);
  assert.ok(p.doc.querySelector('.server-entry[data-server-key="box"]'), 'the edits stay on screen');
});

// --- Save after a failed or unfinished load ---
// Save replaces a whole file with what the page shows. A failed load leaves an
// error placeholder (or an older copy) on the page, and before this fix Save
// still ran, without a revision, and replaced tool_config.json with {"tools":{}}.
// Now each tab saves only after a complete load with its revision.
const UI_PAGE = `<!doctype html><body>
  <div id="save-status"></div><button id="save-config-button">Save</button><div id="server-list"></div>
  <div id="save-tool-status"></div><button id="save-tool-config-button">Save</button><div id="tool-list"></div>
  <textarea id="tool-policy-editor"></textarea><div id="tool-policy-status"></div><button id="save-tool-policy-button">Save</button>
  <div id="user-list"></div><div id="mail-account-list"></div>
</body>`;

/** `respond(url, opts)` returns { status, body, revision } or a promise of one. Timers are queued, run with runTimers(). */
function uiPage(respond) {
  const dom = new JSDOM(UI_PAGE, { runScripts: 'outside-only', url: 'http://127.0.0.1/admin/' });
  const w = dom.window;
  const posts = [];
  const timers = [];
  let reloads = 0;
  w.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') posts.push({ url, rev: opts.headers?.['X-Config-Revision'], body: JSON.parse(opts.body) });
    const r = await respond(url, opts);
    return {
      ok: r.status < 400, status: r.status, statusText: '',
      headers: { get: (n) => (n.toLowerCase() === 'x-config-revision' ? (r.revision ?? null) : null) },
      json: async () => r.body ?? {},
    };
  };
  w.triggerReload = async () => { reloads++; };
  w.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  for (const k of ['log', 'warn', 'error']) w.console[k] = () => {};
  w.eval('var saveToolStatus = document.getElementById("save-tool-status");');
  for (const f of SCRIPTS) {
    const file = path.join(PUBLIC, f);
    if (existsSync(file)) w.eval(readFileSync(file, 'utf8'));
  }
  w.initializeServerSaveListener();
  w.initializeToolSaveListener();
  const $ = (id) => w.document.getElementById(id);
  return { w, $, posts, reloads: () => reloads, runTimers: () => timers.splice(0).forEach(fn => fn()) };
}

const SERVERS = { mcpServers: { box: { type: 'stdio', command: 'node', args: ['a.js'] } } };
const TOOL_CONFIG = { tools: { box__run: { enabled: false, exposedName: 'run_box' } } };
const ok = (body, revision) => ({ status: 200, body, revision });
const fail = { status: 500, body: { error: 'temporarily unavailable' } };

/** Clicks Save even when the button is disabled: the handler must refuse on its own. */
async function forceSave(p, id) {
  p.$(id).disabled = false;
  p.$(id).click();
  await flush(); await flush();
}

test('Servers tab: no save after a failed first load, a failed reload, a pending load, or a load without a revision', async () => {
  const cases = [
    ['failed first load', async (p, state) => { state.get = () => fail; await p.w.loadServerConfig(); }],
    ['load without a revision', async (p, state) => { state.get = () => ok(SERVERS, null); await p.w.loadServerConfig(); }],
    ['failed reload after a good load', async (p, state) => {
      state.get = () => ok(SERVERS, 'r1'); await p.w.loadServerConfig();
      assert.equal(p.$('save-config-button').disabled, false, 'enabled after a good load');
      state.get = () => fail; await p.w.loadServerConfig();
    }],
    ['load still pending', async (p, state) => { state.get = () => new Promise(() => {}); p.w.loadServerConfig(); await flush(); }],
  ];
  for (const [label, setup] of cases) {
    const state = {};
    const p = uiPage((url, opts) => (opts.method === 'POST' ? ok({ success: true }, 'r2') : state.get()));
    await setup(p, state);
    assert.equal(p.$('save-config-button').disabled, true, `${label}: Save is disabled`);
    await forceSave(p, 'save-config-button');
    assert.deepEqual(p.posts, [], `${label}: nothing is posted`);
    assert.equal(p.reloads(), 0, `${label}: no reload`);
    assert.match(p.$('save-status').textContent, /^Not saved: The server configuration has not loaded/, label);
  }
});

test('Add Server wizard: Finish refuses while the server list has not loaded', async () => {
  const p = uiPage(() => fail);
  await p.w.loadServerConfig();
  assert.match(p.w.serverSaveBlockedReason(), /has not loaded/);
  // wizard.js asks the same question before it renders the entry and clicks Save.
  assert.match(readFileSync(path.join(PUBLIC, 'wizard.js'), 'utf8'), /serverSaveBlockedReason\(\)/);
});

test('Tools tab: a failed load (one GET failing) never saves {"tools":{}}', async () => {
  const failing = [['tools list', '/admin/tools/list'], ['tool config', '/admin/tools/config'], ['environment', '/admin/environment']];
  for (const [label, failingUrl] of failing) {
    const p = uiPage((url, opts) => {
      if (opts.method === 'POST') return ok({ success: true }, 'r2');
      if (url === failingUrl) return fail;
      if (url === '/admin/tools/list') return ok({ tools: [{ name: 'box__run', serverName: 'box', description: 'd' }] });
      if (url === '/admin/tools/config') return ok(TOOL_CONFIG, 'r1');
      return ok({ serverToolnameSeparator: '__' });
    });
    await p.w.loadToolData();
    assert.equal(p.$('save-tool-config-button').disabled, true, `${label}: Save is disabled`);
    await forceSave(p, 'save-tool-config-button');
    assert.deepEqual(p.posts, [], `${label}: nothing is posted`);
    assert.equal(p.reloads(), 0, `${label}: no reload`);
    assert.match(p.$('save-tool-status').textContent, /^Not saved: The tool configuration has not loaded/, label);
  }
});

test('Tools tab: a pending load, or a failed reload after a good one, refuses Save; a missing file ("none") saves', async () => {
  const state = {};
  const p = uiPage((url, opts) => {
    if (opts.method === 'POST') return ok({ success: true }, 'r2');
    if (url === '/admin/tools/config') return state.config();
    if (url === '/admin/tools/list') return ok({ tools: [] });
    return ok({ serverToolnameSeparator: '__' });
  });
  state.config = () => ok({ tools: {} }, 'none');
  await p.w.loadToolData();
  assert.equal(p.$('save-tool-config-button').disabled, false);
  p.$('save-tool-config-button').click();
  await flush(); await flush();
  assert.deepEqual(p.posts.map(x => x.rev), ['none'], 'a missing file loads as revision "none" and saves with it');

  state.config = () => new Promise(() => {});
  p.w.loadToolData(); await flush();
  await forceSave(p, 'save-tool-config-button');
  assert.equal(p.posts.length, 1, 'no save while loading');

  state.config = () => fail;
  await p.w.loadToolData();
  await forceSave(p, 'save-tool-config-button');
  assert.equal(p.posts.length, 1, 'no save after a failed reload');
});

test('Tool policy: no save after a failed load or while loading; a missing policy ("none") saves', async () => {
  const state = {};
  const p = uiPage((url, opts) => (opts.method === 'POST' ? ok({ success: true }, 'r2') : state.get()));
  state.get = () => ok({ exists: false, policy: null }, 'none');
  await p.w.loadToolPolicy();
  assert.equal(p.$('save-tool-policy-button').disabled, false);
  await p.w.saveToolPolicy();
  assert.deepEqual(p.posts.map(x => x.rev), ['none']);

  state.get = () => fail;
  await p.w.loadToolPolicy();
  assert.equal(p.$('save-tool-policy-button').disabled, true);
  await p.w.saveToolPolicy();
  assert.equal(p.posts.length, 1, 'no save after a failed reload, though the editor still holds the old text');
  assert.match(p.$('tool-policy-status').textContent, /^Not saved: The tool policy has not loaded/);

  state.get = () => new Promise(() => {});
  p.w.loadToolPolicy(); await flush();
  await p.w.saveToolPolicy();
  assert.equal(p.posts.length, 1, 'no save while loading');
});

test('a refused save keeps its "Not saved" message when the load\'s earlier status timer fires', async () => {
  const tabs = [
    ['Servers', 'loadServerConfig', 'save-config-button', 'save-status', '/admin/config', SERVERS],
    ['Tools', 'loadToolData', 'save-tool-config-button', 'save-tool-status', '/admin/tools/config', TOOL_CONFIG],
  ];
  for (const [tab, load, button, status, url, body] of tabs) {
    const p = uiPage((u, opts) => {
      if (opts.method === 'POST') return { status: 409, body: { error: 'Changed elsewhere', code: 'STALE_REVISION' } };
      if (u === url) return ok(body, 'r1');
      if (u === '/admin/tools/list') return ok({ tools: [] });
      return ok({ serverToolnameSeparator: '__' });
    });
    await p.w[load]();          // schedules "clear the 'loaded' message"
    p.$(button).click();
    await flush(); await flush();
    assert.equal(p.$(status).textContent, 'Not saved: Changed elsewhere', tab);
    p.runTimers();              // the load's timer fires late
    assert.equal(p.$(status).textContent, 'Not saved: Changed elsewhere', `${tab}: the message stays`);
    assert.equal(p.reloads(), 0, tab);
  }
});

test('clearStatusLater clears only the message it was scheduled for', () => {
  const p = uiPage(() => ok({}));
  const el = p.$('save-status');
  el.textContent = 'loaded';
  p.w.clearStatusLater(el, 3000, 'green');
  p.runTimers();
  assert.equal(el.textContent, '');
  assert.equal(el.style.color, 'green');
  el.textContent = 'loaded';
  p.w.clearStatusLater(el, 3000);
  el.textContent = 'Not saved: …';
  p.runTimers();
  assert.equal(el.textContent, 'Not saved: …');
});

// --- Overlapping loads ---
// Loads can overlap (a tab click while one is running). Before this fix they
// shared the page's state: load A succeeding after load B started enabled Save
// with A's revision, then B failing replaced the rows with an error, and Save
// posted {"tools":{}} with a current revision, which the gateway accepted. Now
// only the newest load may render, enable Save or report a failure.

/** A response the test settles later: d.ok(body, rev) / d.fail(). */
function deferred() {
  let settle;
  const promise = new Promise(r => { settle = r; });
  return { promise, ok: (body, revision) => settle(ok(body, revision)), fail: () => settle(fail) };
}

const TOOLS_LIST = { tools: [{ name: 'run', serverName: 'box', description: 'd' }] }; // key box__run
const POLICY = { exists: true, policy: { users: { alice: { allow: ['box/*'] } } } };

// One case per tab: how to start a load, which GET to hold, and what the page
// shows when it holds the loaded snapshot.
const TABS = [
  {
    tab: 'Servers', load: 'loadServerConfig', held: '/admin/config', body: SERVERS, button: 'save-config-button',
    save: async (p) => { p.$('save-config-button').click(); await flush(); await flush(); },
    shows: (p) => p.$('server-list').querySelectorAll('.server-entry').length === 1,
  },
  {
    tab: 'Tools', load: 'loadToolData', held: '/admin/tools/list', body: TOOLS_LIST, button: 'save-tool-config-button',
    save: async (p) => { p.$('save-tool-config-button').click(); await flush(); await flush(); },
    shows: (p) => p.$('tool-list').querySelectorAll('.tool-entry').length === 1,
  },
  {
    tab: 'Tool policy', load: 'loadToolPolicy', held: '/admin/tool-policy', body: POLICY, button: 'save-tool-policy-button',
    save: async (p) => { await p.w.saveToolPolicy(); },
    shows: (p) => p.$('tool-policy-editor').value.includes('alice'),
  },
];

function overlapPage(held) {
  const pending = [];
  const p = uiPage((url, opts) => {
    if (opts.method === 'POST') return ok({ success: true }, 'r9');
    if (url === held) { const d = deferred(); pending.push(d); return d.promise; }
    if (url === '/admin/tools/config') return ok(TOOL_CONFIG, 'r1');
    if (url === '/admin/tools/list') return ok(TOOLS_LIST);
    return ok({ serverToolnameSeparator: '__' });
  });
  return { p, pending };
}

for (const t of TABS) {
  test(`${t.tab}: two overlapping loads, the older succeeding after the newer fails or before it fails: no save`, async () => {
    for (const order of ['older ok, then newer fails', 'newer fails, then older ok']) {
      const { p, pending } = overlapPage(t.held);
      const a = p.w[t.load]();   // older load
      await flush();
      const b = p.w[t.load]();   // newer load, e.g. a second tab click
      await flush();
      assert.equal(pending.length, 2, `${t.tab}: both loads are waiting`);
      const revision = t.tab === 'Tools' ? undefined : 'r1';
      if (order.startsWith('older')) { pending[0].ok(t.body, revision); await a; pending[1].fail(); await b; }
      else { pending[1].fail(); await b; pending[0].ok(t.body, revision); await a; }
      assert.equal(p.$(t.button).disabled, true, `${t.tab}, ${order}: Save is disabled`);
      assert.ok(!t.shows(p), `${t.tab}, ${order}: the older load did not render over the newer failure`);
      await t.save(p);
      assert.deepEqual(p.posts, [], `${t.tab}, ${order}: nothing is posted`);
      assert.equal(p.reloads(), 0, `${t.tab}, ${order}: no reload`);
    }
  });

  test(`${t.tab}: two overlapping loads, the newer succeeding: the older's late result changes nothing`, async () => {
    for (const order of ['newer ok, then older fails', 'newer ok, then older ok']) {
      const { p, pending } = overlapPage(t.held);
      const a = p.w[t.load]();
      await flush();
      const b = p.w[t.load]();
      await flush();
      const revision = t.tab === 'Tools' ? undefined : 'r-new';
      pending[1].ok(t.body, revision); await b;
      assert.equal(p.$(t.button).disabled, false, `${t.tab}: the newer load enabled Save`);
      if (order.endsWith('fails')) pending[0].fail(); else pending[0].ok(t.body, t.tab === 'Tools' ? undefined : 'r-old');
      await a;
      assert.equal(p.$(t.button).disabled, false, `${t.tab}, ${order}: Save stays enabled`);
      assert.ok(t.shows(p), `${t.tab}, ${order}: the newer load's view stays`);
      await t.save(p);
      assert.equal(p.posts.length, 1, `${t.tab}, ${order}: the save goes through`);
      assert.equal(p.posts[0].rev, t.tab === 'Tools' ? 'r1' : 'r-new', `${t.tab}, ${order}: with the newer load's revision`);
    }
  });
}

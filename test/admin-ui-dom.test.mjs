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
    return { ok: data !== undefined, status: data !== undefined ? 200 : 404, statusText: '', json: async () => data ?? {} };
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');

test('feedback drafts include only the release version, not gateway identity or config', async () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://127.0.0.1/admin/' });
  try {
    const requests = [];
    dom.window.fetch = async url => {
      requests.push(url);
      return { ok: url === '/admin/version', json: async () => ({
        version: '1.2.3+test & preview', name: 'private-demo-name', color: '#123456',
        config: { token: 'fake-token-do-not-share' },
      }) };
    };
    dom.window.eval(script);
    await dom.window.applyFeedbackVersion();
    for (const [id, template] of [['report-problem-link', 'bug_report.yml'], ['suggest-feature-link', 'feature_request.yml']]) {
      const link = dom.window.document.getElementById(id);
      const url = new URL(link.href);
      assert.equal(url.origin, 'https://github.com');
      assert.equal(url.pathname, '/EvilBob01/patchbay-gateway/issues/new');
      assert.deepEqual([...url.searchParams.keys()].sort(), ['template', 'version']);
      assert.equal(url.searchParams.get('template'), template);
      assert.equal(url.searchParams.get('version'), '1.2.3+test & preview');
      assert.equal(link.rel, 'noopener noreferrer');
    }
    assert.ok(requests.every(url => url.startsWith('/admin/')), 'no automatic external requests');
  } finally { dom.window.close(); }
});

test('feedback links still open their forms when gateway info is unavailable', async () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://127.0.0.1/admin/' });
  try {
    dom.window.fetch = async () => { throw new Error('offline'); };
    dom.window.eval(script);
    await dom.window.applyFeedbackVersion();
    for (const id of ['report-problem-link', 'suggest-feature-link']) {
      const url = new URL(dom.window.document.getElementById(id).href);
      assert.ok(url.searchParams.has('template'));
      assert.equal(url.searchParams.has('version'), false);
    }
  } finally { dom.window.close(); }
});

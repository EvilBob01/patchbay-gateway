// Offline tests for the lethal-trifecta policy (src/trifecta.ts).
//
// Exercises the compiled modules directly: classification defaults, per-session
// accumulation, the block itself, session isolation, overrides, monitor mode and
// how the "trifecta" section of tool_policy.json is validated. No gateway,
// backends or network needed.
//
// Run from the fork root after a build:  node test/trifecta.test.mjs
const T = await import('../build/trifecta.js');
const { compilePolicy, NO_POLICY } = await import('../build/policy.js');

const backends = {
  hostA:   { type: 'stdio', command: 'npx', args: ['ssh-mcp', '-y', '--', '--host=h'] },
  hostB:   { type: 'stdio', command: 'npx', args: ['ssh-mcp@2.16.0', '--', '--host=h'] },
  mail:    { type: 'stdio', command: 'node', args: ['/opt/imap-mcp/index.js'] },
  catalog: { type: 'stdio', command: 'node', args: ['/opt/x/catalog-server/index.js'] },
  docs:    { type: 'http', url: 'https://example.invalid/mcp' },
  c7:      { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  notssh:  { type: 'stdio', command: 'node', args: ['/opt/not-ssh-mcp-thing/index.js'] },
};
const user = { kind: 'user', username: 'alice', source: 'users.json' };
const other = { kind: 'user', username: 'bob', source: 'users.json' };
const unknown = { kind: 'unknown', username: 'unknown', source: 'none' };

let failed = 0, passed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`ok   ${label}`); }
  else { failed++; console.log(`FAIL ${label}`); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// The active config, as mcp-proxy.ts would get it: compiled from the policy file.
let cfg;
const configure = (section) => { cfg = compilePolicy(section === undefined ? {} : { trifecta: section }).trifecta; };
T.configureTrifecta(backends, '__');
let n = 0;
const fresh = () => `s${++n}`;
const call = (sid, backend, tool, who = user) => T.checkTrifecta(sid, who, backend, tool, cfg);
const axes = (b, t) => T.axesOf(T.classifyTool(b, t, cfg));
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

// --- classification defaults ---------------------------------------------
configure(undefined);
ok(cfg.mode === 'enforce' && NO_POLICY.trifecta.mode === 'enforce', 'no section / no policy file -> enforce');
ok(eq(axes('hostA', 'read-command'), ['privateData']), 'ssh read-command = private');
ok(eq(axes('hostB', 'run-command'), ['privateData', 'externalComm']), 'ssh run-command (versioned spec) = private+external');
ok(eq(axes('hostA', 'sftp-upload'), ['privateData', 'externalComm']), 'ssh sftp-upload = private+external');
ok(eq(axes('hostA', 'some-new-tool'), ['privateData', 'externalComm']), 'unlisted ssh tool = private+external');
ok(eq(axes('mail', 'read_email'), ['untrustedContent']), 'mail read_email = untrusted');
ok(eq(axes('mail', 'list_emails'), ['untrustedContent']), 'mail list_emails = untrusted');
ok(eq(axes('mail', 'send_email'), ['externalComm']), 'mail send_email = external');
ok(eq(axes('mail', 'move_email'), []), 'mail move_email = none');
ok(eq(axes('catalog', 'request_connector'), []), 'catalog = none');
ok(eq(axes('c7', 'query-docs'), ['externalComm']) && eq(axes('c7', 'resolve-library-id'), ['externalComm']), 'context7 = external only');
{
  const s = fresh();
  ok(call(s, 'hostA', 'read-command').allowed && call(s, 'c7', 'query-docs').allowed && call(s, 'hostA', 'run-command').allowed && call(s, 'c7', 'resolve-library-id').allowed, 'context7 works alongside every kind of ssh call');
  ok(!call(s, 'mail', 'read_email').allowed, 'context7 + ssh, then reading mail -> BLOCKED');
}
ok(eq(axes('docs', 'query'), ['untrustedContent', 'externalComm']), 'unknown backend = untrusted+external');
ok(eq(axes('notssh', 'x'), ['untrustedContent', 'externalComm']), 'substring "ssh-mcp" in another name is not ssh-mcp');

// --- the scenario: mail read, ssh read, send ------------------------------
{
  const s = fresh();
  ok(call(s, 'mail', 'read_email').allowed, 'scenario: read_email allowed');
  ok(call(s, 'hostA', 'read-command').allowed, 'scenario: ssh read-command allowed (2 of 3)');
  const d = call(s, 'mail', 'send_email');
  ok(!d.allowed, 'scenario: send_email BLOCKED');
  ok(d.detail?.blocked === true && eq(d.detail.completing, ['externalComm']), 'scenario: detail names the completing axis');
  ok(d.detail?.sources.untrustedContent === 'mail__read_email' && d.detail?.sources.privateData === 'hostA__read-command', 'scenario: detail names source tools');
  ok(/lethal-trifecta/.test(d.message) && /Nothing was sent/.test(d.message), 'scenario: message explains');
  ok(eq(T.sessionAxes(s), ['privateData', 'untrustedContent']), 'scenario: block did not record externalComm');
  ok(call(s, 'hostA', 'read-command').allowed, 'scenario: session still usable for non-completing calls');
  ok(call(s, 'mail', 'list_emails').allowed, 'scenario: more mail reads still fine');
  ok(!call(s, 'hostA', 'run-command').allowed, 'scenario: ssh run-command also blocked (curl is exfil)');
  ok(!call(s, 'docs', 'query').allowed, 'scenario: unknown external tool also blocked');
}
// Order does not matter.
{
  const s = fresh();
  ok(call(s, 'hostA', 'run-command').allowed && call(s, 'mail', 'send_email').allowed, 'reverse: private+external first allowed');
  ok(!call(s, 'mail', 'read_email').allowed, 'reverse: then reading mail is the completing call -> BLOCKED');
}

// --- any two of three is allowed ------------------------------------------
{
  const a = fresh(); // untrusted + external
  ok(call(a, 'mail', 'read_email').allowed && call(a, 'mail', 'send_email').allowed && call(a, 'mail', 'read_email').allowed, 'two-of-three: untrusted+external (read & reply)');
  const b = fresh(); // private + external
  ok(call(b, 'hostA', 'read-command').allowed && call(b, 'hostA', 'run-command').allowed && call(b, 'mail', 'send_email').allowed, 'two-of-three: private+external (ssh + send)');
  const c = fresh(); // private + untrusted
  ok(call(c, 'hostA', 'read-command').allowed && call(c, 'mail', 'read_email').allowed && call(c, 'hostB', 'sftp-download').allowed, 'two-of-three: private+untrusted (ssh read + mail read)');
}

// --- sessions do not bleed ------------------------------------------------
{
  const m = fresh(), h = fresh();
  ok(call(m, 'mail', 'read_email').allowed, 'isolation: mail-only session reads mail');
  ok(call(h, 'hostA', 'run-command').allowed, 'isolation: ssh-only session runs a command');
  ok(call(m, 'mail', 'send_email').allowed, 'isolation: mail session can send (it never touched ssh)');
  ok(call(h, 'hostA', 'privileged-command').allowed, 'isolation: ssh session unaffected by the mail session');
  ok(eq(T.sessionAxes(m), ['untrustedContent', 'externalComm']) && eq(T.sessionAxes(h), ['privateData', 'externalComm']), 'isolation: per-session axes are separate');
  T.clearSessionTrifecta(m);
  ok(eq(T.sessionAxes(m), []), 'isolation: clearSessionTrifecta drops state');
}
// Missing session id shares one strict bucket.
ok(call(undefined, 'mail', 'read_email').allowed && call(undefined, 'hostA', 'read-command').allowed && !call(undefined, 'mail', 'send_email').allowed, 'no-session bucket is enforced too');

// --- configuration --------------------------------------------------------
configure({ classify: { 'mail/*': { privateData: true } } });
{
  const s = fresh();
  ok(call(s, 'mail', 'read_email').allowed && !call(s, 'mail', 'send_email').allowed, 'config: mail marked private -> read then send blocked');
}
// A tool classified on all three axes completes the set alone: refused even in a
// fresh session, with a message that does not cite earlier calls that never happened.
configure({ classify: { 'docs/*': { privateData: true } } });
{
  const s = fresh();
  ok(eq(axes('docs', 'q'), ['privateData', 'untrustedContent', 'externalComm']), 'self-completing: unknown kind + privateData is all three');
  const d = call(s, 'docs', 'q');
  ok(!d.allowed && /this one tool alone combines all three/.test(d.message) && /tool_policy\.json/.test(d.message), 'self-completing: blocked in a fresh session, message says the tool alone combines all three');
  ok(!/already used tools that/.test(d.message) && !/that \./.test(d.message), 'self-completing: no dangling "already used tools that ." clause');
  call(s, 'mail', 'read_email');
  ok(/this one tool alone/.test(call(s, 'docs', 'q').message), 'self-completing: same message after other calls');
  ok(eq(T.selfCompletingTools([{ backend: 'docs', tool: 'q' }, { backend: 'mail', tool: 'read_email' }], cfg), ['docs/q']), 'self-completing: listed for the startup warning');
}
configure({ mode: 'monitor', classify: { 'docs/*': { privateData: true } } });
ok(eq(T.selfCompletingTools([{ backend: 'docs', tool: 'q' }], cfg), []), 'self-completing: no warning outside enforce mode');
configure({ classify: { 'hostA/read-*': { untrustedContent: true } } });
ok(eq(axes('hostA', 'read-command'), ['privateData', 'untrustedContent']), 'config: tool glob override applies');
ok(eq(axes('hostB', 'read-command'), ['privateData']), 'config: glob does not leak to other backends');
configure({ unknown: { untrustedContent: false } });
ok(eq(axes('docs', 'q'), ['externalComm']), 'config: unknown default adjustable');
configure({ backendKinds: { docs: 'ssh-mcp' } });
ok(eq(axes('docs', 'read-command'), ['privateData']), 'config: backendKinds pins a kind');

configure({ classify: { '*': { untrustedContent: false }, 'mail/read_email': { untrustedContent: true } } });
ok(eq(axes('mail', 'read_email'), ['untrustedContent']) && eq(axes('mail', 'list_emails'), []), 'config: classify applies in file order (specific last wins)');

// A bad section makes the whole policy invalid -> currentPolicy() fails closed
// (denies every call) instead of silently switching the check off.
ok(throws(() => compilePolicy({ trifecta: { mode: 'disabled' } }), /trifecta\.mode/), 'invalid: bad mode rejected');
ok(throws(() => compilePolicy({ trifecta: { classify: { 'mail__send_email': { externalComm: true } } } }), /<backend>\/<tool>/), 'invalid: non backend/tool pattern rejected');
ok(throws(() => compilePolicy({ trifecta: { classify: { 'mail/*': { exfil: true } } } }), /unknown axis/), 'invalid: unknown axis rejected');
ok(throws(() => compilePolicy({ trifecta: { classify: { 'mail/*': { privateData: 'yes' } } } }), /true or false/), 'invalid: non-boolean axis rejected');
ok(throws(() => compilePolicy({ trifecta: { allow: [{ tool: 'mail/send_email' }] } }), /reason/), 'invalid: allow rule without reason rejected');
ok(throws(() => compilePolicy({ trifecta: { allow: [{ reason: 'x' }] } }), /identity/), 'invalid: allow rule matching everything rejected');
ok(throws(() => compilePolicy({ trifecta: { mod: 'off' } }), /unknown key/), 'invalid: typo in a key rejected');
ok(compilePolicy({ trifecta: { mode: 'monitor' } }).decide({ identity: user, backend: 'x', tool: 'y' }).allowed, 'trifecta-only policy file leaves authz allow-all');

configure({ mode: 'monitor' });
{
  const s = fresh();
  call(s, 'mail', 'read_email'); call(s, 'hostA', 'read-command');
  const d = call(s, 'mail', 'send_email');
  ok(d.allowed && d.detail?.blocked === false && d.detail?.mode === 'monitor', 'monitor: allowed but detail recorded for audit');
}
configure({ mode: 'off' });
{
  const s = fresh();
  call(s, 'mail', 'read_email'); call(s, 'hostA', 'read-command');
  const d = call(s, 'mail', 'send_email');
  ok(d.allowed && !d.detail, 'off: allowed, nothing recorded');
}

// --- overrides ------------------------------------------------------------
configure({ allow: [
  { identity: 'alice', tool: 'mail/send_email', reason: 'ops digest' },
] });
{
  const s = fresh();
  call(s, 'mail', 'read_email'); call(s, 'hostA', 'read-command');
  const d = call(s, 'mail', 'send_email', user);
  ok(d.allowed && d.detail?.override?.reason === 'ops digest' && d.detail?.blocked === false, 'override: matching identity+tool allowed, reason in detail');
  ok(call(s, 'mail', 'move_email', user).allowed && call(s, 'mail', 'list_folders', user).allowed, 'override: zero-axis tools still allowed once a session holds all three');
  const after = call(s, 'hostA', 'run-command', user);
  ok(!after.allowed && /already holds all three/.test(after.message), 'override: other axis-bearing calls blocked, with a sensible message');
  const s2 = fresh();
  call(s2, 'mail', 'read_email', other); call(s2, 'hostA', 'read-command', other);
  ok(!call(s2, 'mail', 'send_email', other).allowed, 'override: other identity still blocked');
  const s3 = fresh();
  call(s3, 'mail', 'read_email', user); call(s3, 'hostA', 'read-command', user);
  ok(!call(s3, 'hostA', 'run-command', user).allowed, 'override: same identity, other tool still blocked');
}
configure({ allow: [{ identity: 'unknown', reason: 'should never match' }] });
{
  const s = fresh();
  call(s, 'mail', 'read_email', unknown); call(s, 'hostA', 'read-command', unknown);
  ok(!call(s, 'mail', 'send_email', unknown).allowed, 'override: identity rules never exempt an unresolved caller');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

// The installer's admin-terminal sudo step (scripts/install.sh, section 6) and
// the shipped unit's sandbox. Only section 6 is taken out of install.sh and run
// under bash, with visudo/systemctl stubs and temp paths; the installer itself
// is not run.
//
// Needs bash. On Windows that is Git Bash; without one the tests are skipped.
//
// Run from the repo root:  node --test test/installer-terminal-sudo.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fwd = (p) => p.replace(/\\/g, '/');

function findBash() {
  if (process.platform === 'win32') {
    const git = 'C:\\Program Files\\Git\\bin\\bash.exe';
    return existsSync(git) ? git : undefined;
  }
  return spawnSync('bash', ['-c', 'true'], { stdio: 'ignore' }).status === 0 ? 'bash' : undefined;
}
const BASH = findBash();
const skip = BASH ? false : 'needs bash (Git Bash on Windows)';

/** env_value plus section 6, exactly as install.sh has them. */
function sectionSource() {
  const text = readFileSync(path.join(ROOT, 'scripts', 'install.sh'), 'utf8').replaceAll('\r\n', '\n');
  const ev = text.split('\n').find(l => l.startsWith('env_value() {'));
  assert.ok(ev, 'install.sh defines env_value');
  const begin = text.indexOf('# ---- 6. admin terminal sudo');
  const end = text.indexOf('# SELinux:', begin);
  assert.ok(begin > 0 && end > begin, 'install.sh has section 6');
  return ev + '\n' + text.slice(begin, end);
}

const OLD_FULL_SUDOERS = 'Defaults:patchbay rootpw\npatchbay ALL=(ALL:ALL) ALL\n';
const OLD_SCOPED_SUDOERS = 'patchbay ALL=(root) NOPASSWD: /usr/bin/systemctl restart patchbay-gateway\n';
const OLD_FULL_DROPIN = '[Service]\nNoNewPrivileges=false\nProtectSystem=no\nReadWritePaths=\n';
const OLD_SCOPED_DROPIN = '[Service]\nNoNewPrivileges=false\nReadWritePaths=-/run/sudo\n';

/** `pre` seeds what an earlier install left: { sudoers, dropin } file contents. */
function run(t, { mode, terminal, visudo = 'ok', pre = {} }) {
  const dir = fwd(mkdtempSync(path.join(tmpdir(), 'pb-sudo-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = `${dir}/bin`;
  mkdirSync(bin);
  writeFileSync(`${bin}/systemctl`, '#!/bin/sh\nexit 0\n'); chmodSync(`${bin}/systemctl`, 0o755);
  writeFileSync(`${bin}/journalctl`, '#!/bin/sh\nexit 0\n'); chmodSync(`${bin}/journalctl`, 0o755);
  if (visudo) { writeFileSync(`${bin}/visudo`, `#!/bin/sh\n${visudo === 'ok' ? 'exit 0' : 'exit 1'}\n`); chmodSync(`${bin}/visudo`, 0o755); }
  if (pre.sudoers) { mkdirSync(`${dir}/sudoers.d`); writeFileSync(`${dir}/sudoers.d/patchbay-gateway`, pre.sudoers); }
  if (pre.dropin) { mkdirSync(`${dir}/unit.d`); writeFileSync(`${dir}/unit.d/10-terminal-sudo.conf`, pre.dropin); }
  writeFileSync(`${dir}/env`, `PORT=3663\nADMIN_PASSWORD=x\n${terminal ? 'PATCHBAY_ENABLE_TERMINAL=true\n' : ''}`);
  const prelude = [
    'set -euo pipefail',
    // A drive letter's colon would split PATH: use Git Bash's /c/... form.
    `export PATH="${bin.replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase())}:/usr/bin:/bin"`,
    `ENV_FILE="${dir}/env"; WORK="${dir}"; SERVICE_USER=patchbay; SERVICE=patchbay-gateway`,
    `SUDOERS_FILE="${dir}/sudoers.d/patchbay-gateway"; DROPIN_DIR="${dir}/unit.d"; SUDO_DROPIN="${dir}/unit.d/10-terminal-sudo.conf"`,
    `TERMINAL_SUDO=${mode}`,
    'info() { echo "INFO $*"; }; die() { echo "DIE $*"; exit 1; }',
    // install -o root needs root; the test only checks what would be written.
    'run() { if [ "$1" = install ]; then mkdir -p "$(dirname "${@: -1}")"; cp "${@: -2:1}" "${@: -1}"; else "$@"; fi; }',
  ].join('\n');
  const r = spawnSync(BASH, ['--noprofile', '--norc', '-c', prelude + '\n' + sectionSource()], { encoding: 'utf8', timeout: 60000 });
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
  return { rc: r.status, out: r.stdout + r.stderr, sudoers: read(`${dir}/sudoers.d/patchbay-gateway`), dropin: read(`${dir}/unit.d/10-terminal-sudo.conf`) };
}

test('scoped (default): a fixed allowlist, no pager; no drop-in while the terminal is off', { skip }, (t) => {
  const r = run(t, { mode: 'scoped', terminal: false });
  assert.equal(r.rc, 0, r.out);
  assert.match(r.sudoers, /^patchbay ALL=\(root\) NOPASSWD: \S*systemctl restart patchbay-gateway, \S*systemctl --no-pager status patchbay-gateway, \S*journalctl --no-pager -u patchbay-gateway -n 200$/m);
  assert.doesNotMatch(r.sudoers, /\*/, 'no wildcards');
  assert.equal(r.dropin, null);
});

test('scoped with the terminal on: the drop-in relaxes NoNewPrivileges only', { skip }, (t) => {
  const r = run(t, { mode: 'scoped', terminal: true });
  assert.equal(r.rc, 0, r.out);
  assert.match(r.dropin, /^NoNewPrivileges=false$/m);
  assert.match(r.dropin, /^ReadWritePaths=-\/run\/sudo$/m);
  assert.doesNotMatch(r.dropin, /ProtectSystem/);
});

test('full with the terminal on: root password, and the sandbox is lifted', { skip }, (t) => {
  const r = run(t, { mode: 'full', terminal: true });
  assert.equal(r.rc, 0, r.out);
  assert.match(r.sudoers, /^Defaults:patchbay rootpw$/m);
  assert.match(r.sudoers, /^patchbay ALL=\(ALL:ALL\) ALL$/m);
  assert.match(r.dropin, /^NoNewPrivileges=false$/m);
  assert.match(r.dropin, /^ProtectSystem=no$/m);
  assert.match(r.out, /passwd root/);
});

test('none: no sudoers file and no drop-in', { skip }, (t) => {
  const r = run(t, { mode: 'none', terminal: true });
  assert.equal(r.rc, 0, r.out);
  assert.equal(r.sudoers, null);
  assert.equal(r.dropin, null);
});

test('without sudo installed, scoped carries on', { skip }, (t) => {
  const r = run(t, { mode: 'scoped', terminal: true, visudo: null });
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /sudo is not installed/);
  assert.equal(r.sudoers, null);
});

test('without sudo installed, full is refused before step 1 changes anything', { skip }, () => {
  // Refusing in section 6 would leave an upgrade half-applied (new code and
  // unit in place, old process running), so the check lives in the plan.
  const text = readFileSync(path.join(ROOT, 'scripts', 'install.sh'), 'utf8').replaceAll('\r\n', '\n');
  const begin = text.indexOf('if [ "$TERMINAL_SUDO" = full ] && ! command -v visudo');
  const end = text.indexOf('\nfi\n', begin);
  assert.ok(begin > 0 && end > begin, 'install.sh has the full-needs-sudo check');
  assert.ok(begin < text.indexOf('# ---- 1. packages'), 'the check runs before step 1');
  const check = text.slice(begin, end + 4);
  const sh = (mode) => spawnSync(BASH, ['--noprofile', '--norc', '-c',
    `export PATH=/nonexistent; TERMINAL_SUDO=${mode}; die() { echo "DIE $*"; exit 1; }\n${check}\necho PLAN-OK`], { encoding: 'utf8', timeout: 60000 });
  let r = sh('full');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /DIE --terminal-sudo full needs sudo installed/);
  r = sh('scoped');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PLAN-OK/);
});

// A re-run reconciles: whatever an earlier install left, the managed files end
// up matching the options and the box as they are now.
for (const [from, pre] of [['full', { sudoers: OLD_FULL_SUDOERS, dropin: OLD_FULL_DROPIN }], ['scoped', { sudoers: OLD_SCOPED_SUDOERS, dropin: OLD_SCOPED_DROPIN }]]) {
  for (const terminal of [true, false]) {
    test(`re-run ${from} -> scoped after sudo was removed (terminal ${terminal ? 'on' : 'off'}): no sudoers file, no drop-in`, { skip }, (t) => {
      const r = run(t, { mode: 'scoped', terminal, visudo: null, pre });
      assert.equal(r.rc, 0, r.out);
      assert.match(r.out, /sudo is not installed/);
      assert.equal(r.sudoers, null, 'the old sudoers rule is removed');
      assert.equal(r.dropin, null, 'the old drop-in is removed: NoNewPrivileges stays on');
    });
    test(`re-run ${from} -> none (terminal ${terminal ? 'on' : 'off'}): no sudoers file, no drop-in`, { skip }, (t) => {
      const r = run(t, { mode: 'none', terminal, pre });
      assert.equal(r.rc, 0, r.out);
      assert.equal(r.sudoers, null);
      assert.equal(r.dropin, null);
    });
  }
  test(`re-run ${from} -> none without sudo installed: no sudoers file, no drop-in`, { skip }, (t) => {
    const r = run(t, { mode: 'none', terminal: true, visudo: null, pre });
    assert.equal(r.rc, 0, r.out);
    assert.equal(r.sudoers, null);
    assert.equal(r.dropin, null);
  });
}

test('re-run full -> scoped with the terminal on: scoped rule and scoped drop-in replace the full ones', { skip }, (t) => {
  const r = run(t, { mode: 'scoped', terminal: true, pre: { sudoers: OLD_FULL_SUDOERS, dropin: OLD_FULL_DROPIN } });
  assert.equal(r.rc, 0, r.out);
  assert.doesNotMatch(r.sudoers, /rootpw|ALL:ALL/);
  assert.match(r.sudoers, /NOPASSWD: \S*systemctl restart patchbay-gateway/);
  assert.doesNotMatch(r.dropin, /ProtectSystem/);
  assert.match(r.dropin, /^ReadWritePaths=-\/run\/sudo$/m);
});

test('re-run full -> scoped with the terminal off: scoped rule, the full drop-in is removed', { skip }, (t) => {
  const r = run(t, { mode: 'scoped', terminal: false, pre: { sudoers: OLD_FULL_SUDOERS, dropin: OLD_FULL_DROPIN } });
  assert.equal(r.rc, 0, r.out);
  assert.doesNotMatch(r.sudoers, /rootpw|ALL:ALL/);
  assert.equal(r.dropin, null);
});

test('re-run scoped -> full with the terminal on: full rule and full drop-in', { skip }, (t) => {
  const r = run(t, { mode: 'full', terminal: true, pre: { sudoers: OLD_SCOPED_SUDOERS, dropin: OLD_SCOPED_DROPIN } });
  assert.equal(r.rc, 0, r.out);
  assert.match(r.sudoers, /^patchbay ALL=\(ALL:ALL\) ALL$/m);
  assert.match(r.dropin, /^ProtectSystem=no$/m);
});

for (const mode of ['scoped', 'full']) {
  test(`re-run ${mode}, terminal on -> off: the rule stays, the drop-in goes`, { skip }, (t) => {
    const pre = mode === 'full' ? { sudoers: OLD_FULL_SUDOERS, dropin: OLD_FULL_DROPIN } : { sudoers: OLD_SCOPED_SUDOERS, dropin: OLD_SCOPED_DROPIN };
    const r = run(t, { mode, terminal: false, pre });
    assert.equal(r.rc, 0, r.out);
    assert.ok(r.sudoers, 'the sudoers rule is (re)written');
    assert.equal(r.dropin, null);
  });
}

test('a rule that fails visudo is never installed', { skip }, (t) => {
  const r = run(t, { mode: 'scoped', terminal: true, visudo: 'fail' });
  assert.equal(r.rc, 1, r.out);
  assert.match(r.out, /fails visudo -c/);
  assert.equal(r.sudoers, null);
  assert.equal(r.dropin, null);
});

test('the shipped unit keeps the sandbox, and docs/install.md shows the same unit', () => {
  const unit = readFileSync(path.join(ROOT, 'deploy', 'patchbay-gateway.service'), 'utf8').replaceAll('\r\n', '\n');
  const keys = (s) => s.split('\n').filter(l => /^[A-Za-z]+=/.test(l));
  for (const want of ['User=patchbay', 'NoNewPrivileges=true', 'PrivateTmp=true', 'ProtectSystem=strict', 'ReadWritePaths=/var/lib/patchbay', 'RestrictSUIDSGID=true']) {
    assert.ok(keys(unit).includes(want), want);
  }
  const doc = readFileSync(path.join(ROOT, 'docs', 'install.md'), 'utf8').replaceAll('\r\n', '\n');
  const block = doc.split('```ini\n').map(b => b.split('```')[0]).find(b => b.includes('ExecStart=/usr/bin/node /opt/patchbay-gateway/build/sse.js'));
  assert.ok(block, 'install.md shows the unit');
  assert.deepEqual(keys(block), keys(unit));
});

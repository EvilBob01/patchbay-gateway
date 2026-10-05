#!/usr/bin/env node
// Leak guard: fails if the files about to be committed contain a secret or a
// deployment-internal identifier. Two checks:
//
//   1. gitleaks (secrets). Must be installed natively; see docs/guard.md.
//   2. Identifier scan. Built in: private (RFC 1918) and CGNAT IPv4 addresses.
//      RFC 5737 documentation addresses (192.0.2.x, 198.51.100.x, 203.0.113.x)
//      are not in those ranges and always pass. Plus a PRIVATE denylist of
//      hostnames, IP prefixes and names, loaded from outside this repository,
//      so the list of what we are hiding is never published alongside the code.
//
// Usage:
//   node scripts/guard.mjs            scan the working tree (tracked + untracked,
//                                     not ignored); run by `npm test`
//   node scripts/guard.mjs --staged   scan the index; run by the pre-commit hook
//
// A line containing `guard:allow` is skipped by the identifier scan (use it for
// a deliberate test fixture, never for a real address). Configuration, all
// per-clone and none of it committed:
//
//   denylist   $PATCHBAY_DENYLIST, else `git config patchbay.denylist`, else
//              ./.patchbay-denylist (gitignored)
//   required   $PATCHBAY_REQUIRE_DENYLIST=1 or `git config patchbay.requireDenylist
//              true`: a missing denylist fails instead of warning
//   gitleaks   $GITLEAKS, else `git config patchbay.gitleaks`, else on PATH
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STAGED = process.argv.includes('--staged');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const gitConfig = (key) => { try { return git('config', '--get', key).trim(); } catch { return ''; } };
const ROOT = git('rev-parse', '--show-toplevel').trim();

// Generated or binary: nothing a person typed an address into.
const SKIP = /(^|\/)package-lock\.json$|\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|zip|gz|exe)$/i;

const problems = [];
const warnings = [];

// --- which files, and their contents -----------------------------------------
function listFiles() {
  const z = (s) => s.split('\0').filter(Boolean);
  if (STAGED) return z(git('diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'));
  return [...new Set([...z(git('ls-files', '-z')), ...z(git('ls-files', '-z', '--others', '--exclude-standard'))])]
    .filter(f => existsSync(path.join(ROOT, f)));
}
function readContent(file) {
  if (STAGED) return execFileSync('git', ['show', `:${file}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return readFileSync(path.join(ROOT, file));
}
const files = listFiles().filter(f => !SKIP.test(f));
const contents = new Map(files.map(f => [f, readContent(f)]));

// --- 1. gitleaks -------------------------------------------------------------
function findGitleaks() {
  const candidates = [process.env.GITLEAKS, gitConfig('patchbay.gitleaks'), 'gitleaks'].filter(Boolean);
  for (const c of candidates) {
    if (spawnSync(c, ['version'], { stdio: 'ignore' }).status === 0) return c;
  }
  return null;
}
const gitleaks = findGitleaks();
if (!gitleaks) {
  problems.push('gitleaks not found. Install it natively (see docs/guard.md) or point $GITLEAKS / `git config patchbay.gitleaks` at it.');
} else {
  // Scan an exact copy of the files that would be committed, nothing else: the
  // working tree also holds gitignored live secrets (config/users.json and
  // friends) that are never committed and must not fail the check.
  const dir = mkdtempSync(path.join(tmpdir(), 'patchbay-guard-'));
  try {
    for (const [f, buf] of contents) {
      const dest = path.join(dir, f);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, buf);
    }
    const r = spawnSync(gitleaks, ['dir', dir, '--no-banner', '--no-color', '--verbose', '--redact', '--log-level', 'warn'], { encoding: 'utf8' });
    if (r.status !== 0) {
      // Report repo-relative paths, whichever slash style gitleaks printed.
      let out = r.stdout + r.stderr;
      for (const prefix of [dir + path.sep, dir.replaceAll('\\', '/') + '/']) out = out.split(prefix).join('');
      problems.push(`gitleaks reported findings (values redacted):\n${out.trim()}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- 2. identifiers ----------------------------------------------------------
const OCTET = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
const RULES = [
  ['private IPv4 10/8', new RegExp(`(?<![\\d.])10\\.${OCTET}\\.${OCTET}\\.${OCTET}(?![\\d.]*\\d)`, 'g')],
  ['private IPv4 172.16/12', new RegExp(`(?<![\\d.])172\\.(?:1[6-9]|2\\d|3[01])\\.${OCTET}\\.${OCTET}(?![\\d.]*\\d)`, 'g')],
  ['private IPv4 192.168/16', new RegExp(`(?<![\\d.])192\\.168\\.${OCTET}\\.${OCTET}(?![\\d.]*\\d)`, 'g')],
  ['CGNAT IPv4 100.64/10', new RegExp(`(?<![\\d.])100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.${OCTET}\\.${OCTET}(?![\\d.]*\\d)`, 'g')],
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function denylistRule(entry) {
  if (entry.startsWith('re:')) return new RegExp(entry.slice(3), 'gi');
  // An IP prefix such as "203.0.113." matches anything starting with it.
  if (/^[\d.]+$/.test(entry)) return new RegExp(`(?<![\\d.])${escape(entry)}`, 'g');
  // A name matches as a whole token, case-insensitively: "web01" hits "WEB01"
  // and "web01-prod" but not "web012".
  return new RegExp(`(?<![A-Za-z0-9])${escape(entry)}(?![A-Za-z0-9])`, 'gi');
}

const denylistPath = process.env.PATCHBAY_DENYLIST || gitConfig('patchbay.denylist') || path.join(ROOT, '.patchbay-denylist');
const requireDenylist = process.env.PATCHBAY_REQUIRE_DENYLIST === '1' || gitConfig('patchbay.requireDenylist') === 'true';
if (existsSync(denylistPath)) {
  // Rules are labelled by position, not by value, so CI logs and terminal
  // scrollback never repeat the private list itself.
  readFileSync(denylistPath, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .forEach((entry, i) => RULES.push([`denylist entry #${i + 1}`, denylistRule(entry)]));
} else if (requireDenylist) {
  problems.push(`Private denylist not found at ${denylistPath} (required by this clone's settings).`);
} else {
  warnings.push(`No private denylist (${denylistPath}); only the built-in IP checks ran. See docs/guard.md.`);
}

for (const [file, buf] of contents) {
  if (buf.includes(0)) continue; // binary
  const lines = buf.toString('utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes('guard:allow')) return;
    for (const [label, re] of RULES) {
      re.lastIndex = 0;
      if (re.test(line)) problems.push(`${file}:${i + 1}: ${label}`);
    }
  });
}

// --- report ------------------------------------------------------------------
for (const w of warnings) console.warn(`guard: warning: ${w}`);
if (problems.length) {
  console.error(`guard: FAILED (${STAGED ? 'staged changes' : 'working tree'}, ${files.length} files)`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('Use an RFC 5737 address (192.0.2.x) and a generic name (web01) in examples. See docs/guard.md.');
  process.exit(1);
}
console.log(`guard: ok (${STAGED ? 'staged changes' : 'working tree'}, ${files.length} files, ${RULES.length} identifier rules, gitleaks clean)`);

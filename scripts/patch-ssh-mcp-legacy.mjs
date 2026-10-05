#!/usr/bin/env node
/**
 * Patch ssh-mcp's FROZEN_ALGORITHMS so this gateway can reach pre-2010 OpenSSH
 * hosts (OpenSSH 5.3 / CentOS 6 era). See LEGACY_SSH_HOSTS.md for the full
 * diagnosis.
 *
 * ssh-mcp ships a hardened, hardcoded algorithm list with no CLI flag or env var
 * to override it. It shares nothing with OpenSSH 5.3, so those hosts fail with
 * "Handshake failed: no matching key exchange algorithm". This script appends
 * the legacy algorithms and reorders the CTR ciphers.
 *
 * Design notes:
 * - Idempotent. Safe to run on every service start (ExecStartPre).
 * - Dependency-free, and never exits non-zero on "nothing to do", so it cannot
 *   block the service from starting.
 * - Discovers ssh-mcp rather than hardcoding a path: the npx cache directory
 *   name is a content hash that differs per deployment.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync } from 'fs';
import { join } from 'path';

const REL = join('node_modules', 'ssh-mcp', 'build', 'ssh', 'algorithms.js');
const HOME = process.env.HOME || '/root';

function findTargets() {
  const roots = [];
  const npxBase = join(HOME, '.npm', '_npx');
  if (existsSync(npxBase)) {
    for (const entry of readdirSync(npxBase)) roots.push(join(npxBase, entry));
  }
  roots.push('/usr/lib', '/usr/local/lib', process.cwd());
  return roots.map((r) => join(r, REL)).filter((p) => existsSync(p));
}

/**
 * Each edit carries its own "already applied" probe, so a partially patched file
 * (e.g. from an older version of this script) converges rather than aborting.
 */
const EDITS = [
  {
    name: 'kex: allow group-exchange-sha256 and group14-sha1',
    applied: (s) => s.includes("'diffie-hellman-group14-sha1'"),
    anchor: "        'diffie-hellman-group14-sha256',\n    ],",
    replace:
      "        'diffie-hellman-group14-sha256',\n" +
      "        // legacy: OpenSSH 5.3 offers only these\n" +
      "        'diffie-hellman-group-exchange-sha256',\n" +
      "        'diffie-hellman-group14-sha1',\n    ],",
  },
  {
    name: 'serverHostKey: allow ssh-rsa',
    applied: (s) => /'ssh-rsa'/.test(s),
    anchor: "        'rsa-sha2-256',\n    ],",
    replace: "        'rsa-sha2-256',\n        // legacy: OpenSSH 5.3 has no rsa-sha2-*\n        'ssh-rsa',\n    ],",
  },
  {
    name: 'hmac: allow hmac-sha1',
    applied: (s) => /'hmac-sha1'/.test(s),
    anchor: "        'hmac-sha2-512',\n    ],",
    replace: "        'hmac-sha2-512',\n        // legacy: OpenSSH 5.3 predates hmac-sha2-*\n        'hmac-sha1',\n    ],",
  },
  {
    // RFC 4419 group exchange sizes the DH modulus to the negotiated cipher's
    // key length. aes256-ctr makes ssh2 request a group larger than a 2009
    // /etc/ssh/moduli can serve, and the handshake stalls until timeout --
    // *after* every algorithm list has already been agreed, which makes it look
    // like a network fault rather than a crypto one. Putting aes128-ctr first
    // keeps the request small. Modern peers negotiate chacha20-poly1305 or
    // AES-GCM, both of which sit above this block, so nothing changes for them.
    name: 'cipher: prefer aes128-ctr over larger CTR keys',
    applied: (s) => s.includes("'aes128-ctr',\n        'aes192-ctr',\n        'aes256-ctr',"),
    anchor: "        'aes256-ctr',\n        'aes192-ctr',\n        'aes128-ctr',\n    ],",
    replace:
      "        // aes128 first: group exchange sizes the DH modulus to the cipher\n" +
      "        // key length, and a 2009 moduli file cannot serve what aes256 asks\n" +
      "        // for. Modern peers pick chacha20/GCM above this block anyway.\n" +
      "        'aes128-ctr',\n        'aes192-ctr',\n        'aes256-ctr',\n    ],",
  },
];

const targets = findTargets();

if (targets.length === 0) {
  // Expected on a first boot: npx installs ssh-mcp lazily when the first stdio
  // backend spawns, which happens after ExecStartPre. The next restart patches
  // it. Never fail here -- that would keep the whole gateway down.
  console.log('[patch-ssh-mcp-legacy] no ssh-mcp install found yet; nothing to do');
  process.exit(0);
}

let patchedAny = false;

for (const file of targets) {
  let src = readFileSync(file, 'utf8');
  const before = src;
  const done = [];
  const skipped = [];
  const failed = [];

  for (const edit of EDITS) {
    if (edit.applied(src)) { skipped.push(edit.name); continue; }
    const hits = src.split(edit.anchor).length - 1;
    if (hits !== 1) { failed.push(edit.name + ' (anchor matched ' + hits + 'x)'); continue; }
    src = src.replace(edit.anchor, edit.replace);
    done.push(edit.name);
  }

  if (src !== before) {
    const backup = file + '.bak-prelegacy';
    if (!existsSync(backup)) copyFileSync(file, backup);
    writeFileSync(file, src);
    patchedAny = true;
  }

  console.log('[patch-ssh-mcp-legacy] ' + file);
  if (done.length) console.log('  applied: ' + done.join('; '));
  if (skipped.length) console.log('  already present: ' + skipped.length + ' edit(s)');
  for (const f of failed) {
    // Warn loudly but do not fail: an upstream refactor should not prevent the
    // gateway from starting, it should just mean legacy hosts stay unreachable.
    console.log('  WARN could not apply: ' + f + ' -- upstream may have changed; see LEGACY_SSH_HOSTS.md');
  }
}

console.log('[patch-ssh-mcp-legacy] ' + (patchedAny ? 'changes written; restart required for running backends' : 'no changes needed'));
process.exit(0);

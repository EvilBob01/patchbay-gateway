# Reaching legacy SSH hosts (OpenSSH 5.3 / CentOS 6 era)

`ssh-mcp` backends cannot connect to pre-2010 SSH servers out of the box. Three
separate things break, in sequence, and each one masks the next — so fixing only
the first or second leaves you with a different error and the impression that
nothing changed.

Diagnosed 2026-08-24 against two `SSH-2.0-OpenSSH_5.3` hosts on CentOS 6.8.
(This repository is publicly readable, so the specific hosts are recorded in the
private deployment notes rather than here.)

## 1. ed25519 keys can never work

OpenSSH gained ed25519 in **6.5**. On 5.3 the key is offered and rejected, so you
get `Permission denied (publickey)` no matter what options you pass.

Use an RSA key for these hosts. Generate one on the gateway and install it with
the legacy algorithms enabled (the flags are for the *modern client*, which
otherwise refuses to talk to the old server at all):

```
ssh-keygen -t rsa -b 4096 -N '' -C 'patchbay gateway legacy RSA' -f ~/.ssh/id_rsa_legacy
ssh-copy-id -i ~/.ssh/id_rsa_legacy.pub \
  -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa <user>@<host>
```

Then point the backend at it in `config/mcp_server.json`, with an absolute path
(`~` is not expanded):

```
"--key=/home/<service-user>/.ssh/id_rsa_legacy"
```

> The admin UI's **deploy-key-to-host** action always pushes
> `~/.ssh/id_ed25519.pub` of the service user (override with `SSH_PUBLIC_KEY_PATH`). On a legacy
> host it will appear to succeed and still leave you unable to authenticate.

## 2. FROZEN_ALGORITHMS shares nothing with OpenSSH 5.3

`ssh-mcp` pins a hardened algorithm list in `build/ssh/algorithms.js` and applies
it to every connection. There is no CLI flag and no environment variable to
change it. Against a 5.3 host there is no overlap at all:

| | ssh-mcp requires | OpenSSH 5.3 offers |
|---|---|---|
| KEX | `group14-sha256` or better | `group-exchange-sha256`, `group-exchange-sha1`, `group14-sha1`, `group1-sha1` |
| Host key | `rsa-sha2-*`, ed25519, ecdsa | `ssh-rsa`, `ssh-dss` |
| HMAC | `hmac-sha2-*` | `hmac-md5`, `hmac-sha1`, `hmac-ripemd160`, … |

Symptom: `Handshake failed: no matching key exchange algorithm`.

Fixed by `scripts/patch-ssh-mcp-legacy.mjs`, which **appends** the legacy
algorithms rather than replacing the list, so modern peers keep negotiating
exactly what they did before.

## 3. AES-256 + group exchange stalls the handshake

This is the one that wastes an afternoon. With the algorithms patched, every list
negotiates successfully — KEX `diffie-hellman-group-exchange-sha256`, host key
`ssh-rsa`, cipher `aes256-ctr`, compression agreed — and then the handshake
**times out**. It looks like a network fault. It is not.

RFC 4419 group exchange asks the server for a DH modulus sized to the strength of
the negotiated cipher. `aes256-ctr` makes `ssh2` request a group larger than a
2009 `/etc/ssh/moduli` can serve, and the exchange never completes.

Isolated with identical KEX lists, changing only the cipher:

```
cipher=aes128-ctr only  => READY
cipher=aes256-ctr only  => client-timeout :: Timed out while waiting for handshake
```

The patch therefore also moves `aes128-ctr` ahead of `aes192-ctr`/`aes256-ctr`.
This is a reordering, not a weakening: `chacha20-poly1305` and AES-GCM sit above
the entire CTR block, so any peer from the last decade never reaches it.

The alternative — putting `group14-sha1` ahead of group exchange — also works,
but puts SHA-1 in the key exchange hash. AES-128 on two legacy boxes is the
smaller concession.

## Applying the patch

```
npm run patch:legacy-ssh
systemctl restart patchbay-gateway
```

A restart is required: each backend is a separate `ssh-mcp` process that reads
the algorithm list at spawn time.

The script is idempotent and dependency-free, so it is safe as an
`ExecStartPre` in the systemd unit:

```
[Service]
ExecStartPre=/usr/bin/node /opt/patchbay-gateway/scripts/patch-ssh-mcp-legacy.mjs
```

## Keeping it applied

**The patch is not in this repository's code path.** It edits `ssh-mcp`, a
third-party package that `npx` installs into a content-hashed cache directory
(`~/.npm/_npx/<hash>/`). A version bump or a cache clear reverts it silently, and
the legacy backends start failing again with the section 2 error.

Two mitigations, worth doing together:

1. **Pin the version** in `config/mcp_server.json` so the cache stops
   re-resolving: use `ssh-mcp@2.2.5` instead of `ssh-mcp` in the backend `args`.
   (`config/mcp_server.json` is gitignored — this is a per-deployment edit.)
2. **Run the patch on every start** via the `ExecStartPre` line above, so it
   reasserts itself after any cache rebuild.

On a genuinely fresh deployment the script finds nothing on first boot, because
`npx` installs `ssh-mcp` lazily when the first stdio backend spawns — after
`ExecStartPre` has run. It exits 0 with a note; the following restart patches it.
To avoid that one-restart lag, pre-warm the cache during provisioning:

```
npx -y ssh-mcp@2.2.5 --help >/dev/null 2>&1 || true
node scripts/patch-ssh-mcp-legacy.mjs
```

## Verifying

`list-connections` is **not** sufficient — it reports a profile whether or not
SSH works. Run a real command, or probe the negotiation directly:

```
node -e "const {Client}=require('<npx-cache>/node_modules/ssh2');const c=new Client();
c.on('ready',()=>{console.log('READY');c.end()});c.on('error',e=>console.log(e.level,e.message));
c.connect({host:'<host>',username:'<user>',privateKey:require('fs').readFileSync('<path to id_rsa_legacy>'),readyTimeout:12000})"
```

Reading the failure mode:

- `no matching key exchange algorithm` → section 2, patch not applied (or reverted).
- `Timed out while waiting for handshake` → section 3, cipher order not applied.
- `All configured authentication methods failed` → section 1, key not installed
  or wrong key type. Crypto is fine.

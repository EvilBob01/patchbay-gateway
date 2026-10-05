# Leak guard

`scripts/guard.mjs` stops secrets and deployment-internal identifiers from being
committed. It runs as part of `npm test` (whole working tree) and from the
pre-commit hook (staged changes only), and fails on:

- **secrets**, found by [gitleaks](https://github.com/gitleaks/gitleaks);
- **private and CGNAT IPv4 addresses**: `10/8`, `172.16/12`, `192.168/16`, `100.64/10`;
- **entries in a private denylist**: your hostnames, public address blocks,
  organisation names. Not shipped with the code (see below).

Examples and placeholders should use RFC 5737 documentation addresses
(`192.0.2.x`, `198.51.100.x`, `203.0.113.x`) and generic names (`web01`).
A line containing `guard:allow` is skipped by the identifier scan. Use it
for a deliberate test fixture, never for a real address.

## Install gitleaks (native, no containers)

| OS | Command |
|---|---|
| Debian/Ubuntu | `apt install gitleaks`, or the release binary from GitHub (verify its SHA-256) |
| macOS | `brew install gitleaks` |
| Windows | `winget install Gitleaks.Gitleaks` |

If it is not on `PATH`, point the guard at it with either
`GITLEAKS=/path/to/gitleaks` or `git config patchbay.gitleaks /path/to/gitleaks`.

## The private denylist

The guard never ships the list of identifiers it protects: publishing that list
would leak exactly what it is meant to hide. It reads the list from outside the
repository, looking in this order:

1. `$PATCHBAY_DENYLIST`
2. `git config patchbay.denylist` (per clone, never committed)
3. `./.patchbay-denylist` (gitignored)

Keep the real file in a private repository and point each clone at it:

```bash
git config patchbay.denylist /path/to/private-config/patchbay-denylist.txt
git config patchbay.requireDenylist true   # missing file = failure, not a warning
```

Format: one entry per line, `#` for comments.

| Entry | Matches |
|---|---|
| `web01` | the whole token, case-insensitive: `WEB01`, `web01-prod`, not `web012` |
| `203.0.113.` | any address starting with that prefix |
| `re:<regex>` | a raw case-insensitive regular expression |

Failures are reported by entry number (`denylist entry #7`), never by value,
so CI logs and terminal scrollback do not repeat the list.

Without a denylist the guard still runs gitleaks and the IP checks, and warns.

## Enable the pre-commit hook

```bash
npm run hooks:install    # sets core.hooksPath to scripts/git-hooks
```

To bypass it once, run `git commit --no-verify`, and only for a commit you have
already checked by hand.

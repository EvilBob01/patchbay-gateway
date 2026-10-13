// Keeps backend secrets out of the admin UI's Servers tab and the import preview.
//
// GET /admin/config sends mcp_server.json through maskConfigSecrets():
// bearerToken, apiKey and recognised credential fields in env and args become
// "dots + last 4 + length", and URL credentials are masked the same way.
// Harmless env values (LOG_LEVEL=debug) are shown as they are. POST /admin/config
// runs the edited config through mergeConfigSecrets() against the file on disk:
// a value that comes back still masked means "unchanged" and gets the stored
// value back; anything else is a new value and is written as sent. A masked
// value that can't be matched to a stored one (half-edited, or its source
// entry is gone) is refused rather than written to disk as dots.
//
// The "Import from client config" preview (importConfig.ts) uses these same
// functions, so both screens show secrets alike.
//
// What counts as a credential field (env name, or --flag=value / --flag value):
//   1. A path field holding a path is shown: the name's last part is path,
//      file, dir, filename, keyfile, keypath, cert, cacert or ca (SSH_KEY_PATH,
//      PASSWORD_FILE, --key-file), or the flag is --key, --identity or
//      --identity-file (ssh-mcp's --key=/root/.ssh/id_ed25519). Only when the
//      value looks like a path; KEY_FILE=sk-... is still masked.
//   2. Otherwise a secret-sounding name is masked whatever the value looks
//      like, path-looking values included (PASSWORD=/x..., --password /x...).
//   3. Otherwise the value decides: known token prefixes (and, for env,
//      long token-shaped values) are masked; URLs have their credentials masked.
// A credential under an innocent name (-p <value>, a positional password) is
// not recognised; nothing can recognise those everywhere.

const MASK = '••••••';

/** Top-level marker on a masked GET; stripped again on POST. */
export const MASKED_MARKER = '_secretsMasked';
/** Per-entry hint the UI adds when a backend's key was renamed; never written to disk. */
export const ORIGINAL_KEY_FIELD = '_originalKey';

const SECRET_NAME_RE = /(key|token|secret|pass(word|wd)?|pwd|auth|credential|private|session|cookie|dsn|conn(ection)?[-_]?str)/i;
// Short spellings that are too common inside other words for SECRET_NAME_RE.
const SECRET_NAME_PART_RE = /(^|[-_])(pw|pin|sig|salt|cert)([-_]|$)/i;
const TOKEN_PREFIX_RE = /^(sk-|sk_|pk_|rk_|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abpors]-|AKIA|ya29\.|eyJ)/;

/** Show a secret as dots plus at most its last 4 characters, and its length. */
export function maskSecret(value: string): string {
  if (value.length === 0) return '(empty)';
  if (value.length < 12) return `${MASK} (${value.length} chars)`;
  return `${MASK}${value.slice(-4)} (${value.length} chars)`;
}

export function maskUrl(url: string): string {
  let out = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@:\s]*):([^/@\s]*)@/i, (_m, scheme, user) => `${scheme}${user}:${MASK}@`);
  out = out.replace(/([?&][^=&#]*(?:key|token|secret|pass|auth|sig)[^=&#]*=)([^&#]*)/gi, (_m, k) => `${k}${MASK}`);
  return out;
}

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const PATH_RE = /^([.~]?\/|[A-Za-z]:[\\/])/;
// Rule 1 above: names that hold where a secret lives rather than the secret.
const PATH_FIELD_RE = /(^|[-_])(path|file|dir|filename|keyfile|keypath|cert|cacert|ca)$/i;
const PATH_FLAGS = new Set(['key', 'identity', 'identity-file', 'identity_file']);
const FLAG_RE = /^--?[A-Za-z0-9_-]+$/;
const FLAG_VALUE_RE = /^(--?[A-Za-z0-9_-]+)=(.*)$/s;

/**
 * What a field's name says about its value: 'show' (a path field holding a
 * path), 'mask' (a secret-sounding name), or undefined (the name says nothing).
 */
function nameVerdict(name: string, value: string, isFlag: boolean): 'show' | 'mask' | undefined {
  const bare = isFlag ? name.replace(/^-+/, '') : name;
  if (PATH_RE.test(value) && (PATH_FIELD_RE.test(bare) || (isFlag && PATH_FLAGS.has(bare.toLowerCase())))) return 'show';
  if (SECRET_NAME_RE.test(bare) || SECRET_NAME_PART_RE.test(bare)) return 'mask';
  return undefined;
}

export function maskArg(arg: string, previous?: string): string {
  const flag = FLAG_VALUE_RE.exec(arg);
  if (flag) {
    const verdict = nameVerdict(flag[1], flag[2], true);
    // An empty value (--token=) carries no secret and stays as it is: masked
    // to "(empty)" it would not be recognised as masked and would be saved so.
    if (verdict === 'show' || flag[2] === '') return arg;
    if (verdict === 'mask') return `${flag[1]}=${maskSecret(flag[2])}`;
  } else if (previous !== undefined && FLAG_RE.test(previous)) {
    const verdict = nameVerdict(previous, arg, true);
    if (verdict === 'show' || arg === '') return arg;
    if (verdict === 'mask') return maskSecret(arg);
  }
  if (TOKEN_PREFIX_RE.test(arg)) return maskSecret(arg);
  if (URL_RE.test(arg)) return maskUrl(arg);
  return arg;
}

/**
 * True when a value looks like a credential whatever its name: a known token
 * prefix, or 20+ characters of letters and digits with no spaces that isn't a
 * URL or a file path.
 */
function looksLikeToken(value: string): boolean {
  if (TOKEN_PREFIX_RE.test(value)) return true;
  return value.length >= 20 && !/\s/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value)
    && !URL_RE.test(value) && !PATH_RE.test(value);
}

/**
 * Mask an env value only when it is likely a secret: a secret-sounding name
 * (rule 2), a token-shaped value, or a URL carrying credentials. Paths under
 * path-field names or harmless names are shown.
 */
export function maskEnvValue(name: string, value: unknown): unknown {
  if (value === undefined || value === null || value === '') return value;
  const v = String(value);
  const verdict = nameVerdict(name, v, false);
  if (verdict === 'show') return value;
  if (verdict === 'mask') return maskSecret(v);
  if (PATH_RE.test(v)) return value;
  if (looksLikeToken(v)) return maskSecret(v);
  if (URL_RE.test(v)) return maskUrl(v);
  return value;
}

export function isMasked(value: unknown): value is string {
  return typeof value === 'string' && value.includes(MASK);
}

// Empty values carry no secret, so they stay empty rather than "(empty)".
const maskValue = (v: unknown) => (v === undefined || v === null || v === '' ? v : maskSecret(String(v)));
export const maskArgs = (args: unknown[]) => args.map((a, i) => (typeof a === 'string' ? maskArg(a, typeof args[i - 1] === 'string' ? args[i - 1] as string : undefined) : a));

/** A copy of an mcp_server.json object with every backend secret masked. */
export function maskConfigSecrets(config: any): any {
  const out = structuredClone(config);
  if (!out || typeof out !== 'object' || !out.mcpServers || typeof out.mcpServers !== 'object') return out;
  for (const entry of Object.values<any>(out.mcpServers)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.env && typeof entry.env === 'object') {
      for (const name of Object.keys(entry.env)) entry.env[name] = maskEnvValue(name, entry.env[name]);
    }
    if (Array.isArray(entry.args)) entry.args = maskArgs(entry.args);
    if (typeof entry.url === 'string') entry.url = maskUrl(entry.url);
    for (const f of ['bearerToken', 'apiKey']) if (f in entry) entry[f] = maskValue(entry[f]);
  }
  out[MASKED_MARKER] = true;
  return out;
}

export class MaskedSecretError extends Error {}

/**
 * Turn an edited config from the admin UI back into one fit for disk: masked
 * values are swapped for the stored values they stand for. Throws
 * MaskedSecretError (message names the backend and field, never a value) when a
 * masked value can't be resolved.
 */
export function mergeConfigSecrets(posted: any, stored: any): any {
  const out = structuredClone(posted);
  delete out[MASKED_MARKER];
  if (!out.mcpServers || typeof out.mcpServers !== 'object') return out;
  const storedServers = stored && typeof stored.mcpServers === 'object' && stored.mcpServers ? stored.mcpServers : {};

  for (const [key, entry] of Object.entries<any>(out.mcpServers)) {
    if (!entry || typeof entry !== 'object') continue;
    const hint = entry[ORIGINAL_KEY_FIELD];
    delete entry[ORIGINAL_KEY_FIELD];
    const fromKey = typeof hint === 'string' && Object.hasOwn(storedServers, hint) ? hint : key;
    const src: any = Object.hasOwn(storedServers, fromKey) ? storedServers[fromKey] : undefined;
    const fail = (field: string): never => {
      throw new MaskedSecretError(`Backend "${key}": ${field} is still masked but doesn't match a stored value. Re-enter it in full.`);
    };

    // Every stored scalar secret of the source entry, for values that moved
    // (an env var renamed, a token switched between bearerToken and apiKey).
    // Each entry: the stored value and every masked form it could have been shown as.
    const pool: { value: string; forms: unknown[] }[] = [];
    if (src && typeof src === 'object') {
      for (const [n, v] of Object.entries(src.env && typeof src.env === 'object' ? src.env : {})) {
        if (v !== undefined && v !== null && v !== '') pool.push({ value: String(v), forms: [maskSecret(String(v)), maskEnvValue(n, v)] });
      }
      for (const f of ['bearerToken', 'apiKey']) if (typeof src[f] === 'string' && src[f] !== '') pool.push({ value: src[f], forms: [maskSecret(src[f])] });
    }
    const resolve = (value: string, direct: unknown, directMasked: unknown, field: string): string => {
      if (direct !== undefined && direct !== null && direct !== '' && directMasked === value) return String(direct);
      const hits = [...new Set(pool.filter(p => p.forms.includes(value)).map(p => p.value))];
      return hits.length === 1 ? hits[0] : fail(field);
    };

    if (entry.env && typeof entry.env === 'object') {
      for (const [name, v] of Object.entries(entry.env)) {
        const direct = src?.env?.[name];
        if (isMasked(v)) entry.env[name] = resolve(v, direct, maskEnvValue(name, direct), `env ${name}`);
      }
    }
    for (const f of ['bearerToken', 'apiKey']) {
      if (isMasked(entry[f])) entry[f] = resolve(entry[f], src?.[f], maskValue(src?.[f]), f);
    }
    if (isMasked(entry.url)) {
      if (typeof src?.url === 'string' && maskUrl(src.url) === entry.url) entry.url = src.url;
      else fail('url');
    }
    if (Array.isArray(entry.args) && entry.args.some(isMasked)) {
      const srcArgs: unknown[] = Array.isArray(src?.args) ? src.args : [];
      const masked = maskArgs(srcArgs);
      entry.args = entry.args.map((a: unknown, i: number) => {
        if (!isMasked(a)) return a;
        if (masked[i] === a) return srcArgs[i];
        const hits = [...new Set(srcArgs.filter((_s, j) => masked[j] === a))];
        return hits.length === 1 ? hits[0] : fail(`argument ${i + 1}`);
      });
    }
  }
  return out;
}

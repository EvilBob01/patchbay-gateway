// Caller identity resolution.
//
// Authentication on the MCP endpoints used to be a bare set-membership test:
// every per-user token from config/users.json was add()ed into the same
// allowedTokens/allowedKeys Sets as the static ALLOWED_TOKENS/ALLOWED_KEYS env
// values, and the check was `allowedTokens.has(token)`. That makes a per-user
// token a revocable identifier but not an identity -- once past the check,
// nothing downstream could say who the caller was. The only `username` in the
// request path belonged to the admin *web* session, not to the MCP caller.
//
// This module turns a presented credential into a CallerIdentity. Rejection
// stays a Set lookup (unchanged, same Sets, same speed); resolution is a second,
// separate step that only runs once the credential is already known-good.
import { loadUsers } from './users.js';

/**
 * Who made a request.
 *
 * Deliberately an object rather than a bare username string: per-tool capability
 * scoping and lethal-trifecta classification both need to hang more state off
 * the caller, and both should be able to add fields here without touching every
 * call site. `kind` is the field to switch on; `username` is only ever for
 * display and audit.
 */
export interface CallerIdentity {
  /** How the credential was recognised. Switch on this, not on `username`. */
  kind: 'user' | 'static' | 'anonymous' | 'unknown';
  /** Display/audit name. Never undefined -- see STATIC_IDENTITY etc. below. */
  username: string;
  /** Where the credential came from. */
  source: 'users.json' | 'env' | 'none';
  /** users.json createdAt, when the caller is a per-user token. */
  createdAt?: string;
  /**
   * Tier name, if the credential carries one. Not used for authorization:
   * per-tool policy (policy.ts) keys off `kind` and `username` and lives in its
   * own file, so it is never stored next to tokens. Kept for audit display.
   */
  tier?: string;
  /**
   * Per-user override for merging adjacent text blocks in tool results
   * (tool-result.ts), from users.json `mergeTextContent`. Absent = follow the
   * gateway-wide MCP_MERGE_TEXT_CONTENT default.
   */
  mergeTextContent?: boolean;
}

// Static env tokens (ALLOWED_TOKENS / ALLOWED_KEYS) have no user behind them --
// they are the bootstrap/admin credential, shared and not attributable to a
// person. They get an explicit synthetic identity rather than `undefined`, so
// that audit and authorisation never have to special-case a null caller.
export const STATIC_IDENTITY: Readonly<CallerIdentity> = Object.freeze({
  kind: 'static', username: 'static', source: 'env',
});

// Auth is switched off entirely (no ALLOWED_* and no users): every caller is
// anonymous, and says so.
export const ANONYMOUS_IDENTITY: Readonly<CallerIdentity> = Object.freeze({
  kind: 'anonymous', username: 'anonymous', source: 'none',
});

// Authenticated by some path we cannot attribute, or a request whose session we
// cannot resolve. Fails *closed for attribution*: the audit trail records
// 'unknown' rather than silently inventing a caller or logging undefined.
export const UNKNOWN_IDENTITY: Readonly<CallerIdentity> = Object.freeze({
  kind: 'unknown', username: 'unknown', source: 'none',
});

/**
 * Resolve an already-authenticated credential to a CallerIdentity.
 *
 * Order matters. Per-user tokens are ALSO present in the merged env Set (sse.ts
 * add()s them in so that creating or revoking a user takes effect without a
 * restart), so users.json has to be consulted first -- otherwise every per-user
 * token would resolve to the shared static identity.
 *
 * The static credentials live in two Sets (ALLOWED_TOKENS and ALLOWED_KEYS),
 * and the auth checks accept a credential found in either one. Pass both:
 * checking only one would let a credential that is in ALLOWED_KEYS alone pass
 * authentication yet resolve to UNKNOWN_IDENTITY here -- which mislabels it in
 * the audit log and makes the tool policy deny it.
 *
 * @param token    the presented bearer token or API key
 * @param envSets  every Set the auth checks accept (allowedTokens, allowedKeys)
 */
export async function resolveIdentity(
  token: string | undefined,
  envSets: ReadonlyArray<ReadonlySet<string>>,
): Promise<CallerIdentity> {
  if (!token) return UNKNOWN_IDENTITY;

  const users = await loadUsers();
  const user = users.find(u => u.token === token) as
    (typeof users[number] & { tier?: string; mergeTextContent?: unknown }) | undefined;
  if (user) {
    return {
      kind: 'user',
      username: user.username,
      source: 'users.json',
      createdAt: user.createdAt,
      ...(user.tier ? { tier: user.tier } : {}),
      ...(typeof user.mergeTextContent === 'boolean' ? { mergeTextContent: user.mergeTextContent } : {}),
    };
  }

  // Not a known user, but it did pass the membership check -> static env token.
  if (envSets.some(set => set.has(token))) return STATIC_IDENTITY;

  return UNKNOWN_IDENTITY;
}

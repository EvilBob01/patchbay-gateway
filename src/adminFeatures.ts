// Which admin features this gateway serves.
//
// The admin UI itself is opt-in (ENABLE_ADMIN_UI), and the three features in
// it that act on the gateway host or on other hosts are opt-in on top of that,
// each with its own switch, all off by default:
//
//   PATCHBAY_ENABLE_TERMINAL        a root shell in the browser (/admin/terminal)
//   PATCHBAY_ENABLE_INSTALL_RUNNER  runs a backend's installCommands
//   PATCHBAY_ENABLE_DEPLOY_KEYS     pushes this gateway's SSH key to a host
//
// A feature that is off has no routes at all (404), not just a hidden button.
// The admin UI also refuses to start without a real ADMIN_PASSWORD: there is
// no built-in fallback password.

export interface AdminFeatures {
  terminal: boolean;
  installRunner: boolean;
  deployKeys: boolean;
}

export const FEATURE_ENV: Record<keyof AdminFeatures, string> = {
  terminal: 'PATCHBAY_ENABLE_TERMINAL',
  installRunner: 'PATCHBAY_ENABLE_INSTALL_RUNNER',
  deployKeys: 'PATCHBAY_ENABLE_DEPLOY_KEYS',
};

const FEATURE_LABEL: Record<keyof AdminFeatures, string> = {
  terminal: 'terminal',
  installRunner: 'install-runner',
  deployKeys: 'deploy-keys',
};

/** 'true', '1' or 'yes' (case-insensitive) is on; anything else, or unset, is off. */
export function envFlag(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

export function readAdminFeatures(env: NodeJS.ProcessEnv = process.env): AdminFeatures {
  return {
    terminal: envFlag(env[FEATURE_ENV.terminal]),
    installRunner: envFlag(env[FEATURE_ENV.installRunner]),
    deployKeys: envFlag(env[FEATURE_ENV.deployKeys]),
  };
}

/** One startup log line, e.g. "terminal=off, install-runner=off, deploy-keys=on". */
export function describeAdminFeatures(f: AdminFeatures): string {
  return (Object.keys(FEATURE_LABEL) as (keyof AdminFeatures)[])
    .map(k => `${FEATURE_LABEL[k]}=${f[k] ? 'on' : 'off'}`)
    .join(', ');
}

// Values that mean "nobody set a password": the old built-in default, the env
// example's placeholder and the README's example. Compared case-insensitively.
const PLACEHOLDER_PASSWORDS = new Set(['password', 'replace_me', 'change-me', 'changeme', 'admin']);

/**
 * Why ADMIN_PASSWORD is unusable, or null if it is usable. Never echoes the
 * value back.
 */
export function adminPasswordProblem(raw: string | undefined): string | null {
  if (raw === undefined) return 'ADMIN_PASSWORD is not set';
  if (raw.trim() === '') return 'ADMIN_PASSWORD is empty';
  if (PLACEHOLDER_PASSWORDS.has(raw.trim().toLowerCase())) return 'ADMIN_PASSWORD is still a placeholder or the old default';
  return null;
}

/** The message shown in place of a feature that is switched off. */
export function disabledMessage(feature: keyof AdminFeatures): string {
  return `Disabled by the administrator (set ${FEATURE_ENV[feature]}=true to enable).`;
}

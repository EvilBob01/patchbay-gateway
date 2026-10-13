// On-disk path defaults.
//
// Before the Patchbay rename the defaults were mcp-proxy-server / mcp-gateway
// paths. A deployment whose env file never set the variable is relying on the
// old default, so when the variable is unset, the new path does not exist and
// the legacy one does, keep using the legacy path and say so once. An untouched
// env file must never silently move the audit log or the installer payload.
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

export function pathDefault(envName: string, current: string, legacy: string): string {
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(current) && existsSync(legacy)) {
    logger.warn(`${envName} is unset and ${current} does not exist; using legacy path ${legacy}. ` +
      `This fallback is deprecated: set ${envName}=${legacy} in the env file to keep it.`);
    return legacy;
  }
  return current;
}

// Directory holding mcp_server.json, users.json and the rest of the runtime
// config. Defaults to config/ in the install directory. PATCHBAY_CONFIG_DIR moves
// it; the npx launcher (src/cli.ts) points it at a per-user directory, because
// an npx package directory is a disposable cache.
export const CONFIG_DIR = process.env.PATCHBAY_CONFIG_DIR?.trim()
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config');

export function configPath(name: string): string {
  return path.join(CONFIG_DIR, name);
}

// mcp_server.json and tool_config.json have always been read from ./config in
// the working directory (the other files from the install directory; the
// sample unit makes those the same place). Keep that unless
// PATCHBAY_CONFIG_DIR is set, so nothing moves for an existing setup.
export function workingConfigPath(name: string): string {
  return process.env.PATCHBAY_CONFIG_DIR?.trim()
    ? configPath(name)
    : path.resolve(process.cwd(), 'config', name);
}

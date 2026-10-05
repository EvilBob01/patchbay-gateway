// On-disk path defaults.
//
// Before the Patchbay rename the defaults were mcp-proxy-server / mcp-gateway
// paths. A deployment whose env file never set the variable is relying on the
// old default, so when the variable is unset, the new path does not exist and
// the legacy one does, keep using the legacy path and say so once. An untouched
// env file must never silently move the audit log or the installer payload.
import { existsSync } from 'fs';
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

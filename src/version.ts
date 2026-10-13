import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Single source of truth for the version the gateway reports (MCP serverInfo and
// the client info sent to backends): package.json, read once at startup.
function readVersion(): string {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const v = JSON.parse(readFileSync(file, 'utf-8')).version;
    return typeof v === 'string' && v ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION: string = readVersion();

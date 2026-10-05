import { readFile, writeFile, access } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const USERS_PATH = process.env.MCP_USERS_PATH
  || path.resolve(__dirname, '..', 'config', 'users.json');

export interface UserRecord {
  username: string;
  token: string;
  createdAt: string;
}

export async function loadUsers(): Promise<UserRecord[]> {
  try {
    await access(USERS_PATH);
    const raw = await readFile(USERS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      logger.error('Error reading users.json, treating as empty:', error);
    }
    return [];
  }
}

export async function saveUsers(users: UserRecord[]): Promise<void> {
  await writeFile(USERS_PATH, JSON.stringify(users, null, 2), 'utf-8');
}

export function generateToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

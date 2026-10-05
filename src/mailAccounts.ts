import { readFile, writeFile, access, mkdir } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STORE_PATH = path.resolve(__dirname, '..', 'config', 'mail_accounts.json');
const KEY_PATH = path.resolve(__dirname, '..', 'config', '.mail_accounts_key');
const PLAINTEXT_ACCOUNTS_PATH = process.env.MAIL_ACCOUNTS_PLAINTEXT_PATH || '/etc/imap-mcp-accounts.json';

export interface MailAccountInput {
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  user?: string;
  password?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPassword?: string;
  mailFrom?: string;
  imapAllowInsecureTLS?: boolean;
  smtpAllowInsecureTLS?: boolean;
}

interface StoredAccount {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  user: string;
  passwordEnc: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPasswordEnc?: string;
  mailFrom?: string;
  imapAllowInsecureTLS?: boolean;
  smtpAllowInsecureTLS?: boolean;
  updatedAt: string;
}

interface Store {
  accounts: Record<string, StoredAccount>;
}

export interface MailAccountSafeView {
  name: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  user: string;
  hasPassword: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  hasSmtpPassword: boolean;
  mailFrom?: string;
  imapAllowInsecureTLS: boolean;
  smtpAllowInsecureTLS: boolean;
  updatedAt: string;
}

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

let cachedKey: Buffer | null = null;

async function getKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  try {
    await access(KEY_PATH);
    const hex = (await readFile(KEY_PATH, 'utf-8')).trim();
    if (hex.length === 64) {
      cachedKey = Buffer.from(hex, 'hex');
      return cachedKey;
    }
    logger.warn(`Mail accounts key at ${KEY_PATH} is malformed; generating a new one.`);
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      logger.error(`Error reading mail accounts key, generating a new one: ${error.message}`);
    }
  }
  const key = crypto.randomBytes(32);
  await mkdir(path.dirname(KEY_PATH), { recursive: true });
  await writeFile(KEY_PATH, key.toString('hex'), { encoding: 'utf-8', mode: 0o600 });
  logger.log(`Generated new mail accounts encryption key at ${KEY_PATH}.`);
  cachedKey = key;
  return key;
}

async function encrypt(plaintext: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

async function decrypt(blob: string): Promise<string> {
  const key = await getKey();
  const [ivHex, tagHex, cipherHex] = blob.split(':');
  if (!ivHex || !tagHex || !cipherHex) throw new Error('Malformed encrypted field.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(cipherHex, 'hex')), decipher.final()]);
  return plaintext.toString('utf-8');
}

async function loadStore(): Promise<Store> {
  try {
    await access(STORE_PATH);
    const raw = await readFile(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.accounts === 'object') return parsed;
    return { accounts: {} };
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      logger.error('Error reading mail_accounts.json, treating as empty:', error);
    }
    return { accounts: {} };
  }
}

async function saveStore(store: Store): Promise<void> {
  await mkdir(path.dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

function toSafeView(name: string, a: StoredAccount): MailAccountSafeView {
  return {
    name,
    imapHost: a.imapHost,
    imapPort: a.imapPort,
    imapSecure: a.imapSecure,
    user: a.user,
    hasPassword: !!a.passwordEnc,
    smtpHost: a.smtpHost || undefined,
    smtpPort: a.smtpPort || undefined,
    smtpSecure: a.smtpSecure || undefined,
    smtpUser: a.smtpUser || undefined,
    hasSmtpPassword: !!a.smtpPasswordEnc,
    mailFrom: a.mailFrom || undefined,
    imapAllowInsecureTLS: !!a.imapAllowInsecureTLS,
    smtpAllowInsecureTLS: !!a.smtpAllowInsecureTLS,
    updatedAt: a.updatedAt,
  };
}

export async function listMailAccountsSafe(): Promise<MailAccountSafeView[]> {
  const store = await loadStore();
  return Object.entries(store.accounts)
    .map(([name, a]) => toSafeView(name, a))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function writePlaintextAccountsFile(store: Store): Promise<void> {
  const out: Record<string, any> = {};
  for (const [name, a] of Object.entries(store.accounts)) {
    out[name] = {
      imapHost: a.imapHost,
      imapPort: a.imapPort,
      imapSecure: a.imapSecure,
      user: a.user,
      password: await decrypt(a.passwordEnc),
      imapAllowInsecureTLS: !!a.imapAllowInsecureTLS,
      ...(a.smtpHost ? {
        smtpHost: a.smtpHost,
        smtpPort: a.smtpPort,
        smtpSecure: a.smtpSecure,
        smtpUser: a.smtpUser || a.user,
        smtpPassword: a.smtpPasswordEnc ? await decrypt(a.smtpPasswordEnc) : await decrypt(a.passwordEnc),
        smtpAllowInsecureTLS: !!a.smtpAllowInsecureTLS,
      } : {}),
      ...(a.mailFrom ? { mailFrom: a.mailFrom } : {}),
    };
  }
  await mkdir(path.dirname(PLAINTEXT_ACCOUNTS_PATH), { recursive: true }).catch(() => {});
  await writeFile(PLAINTEXT_ACCOUNTS_PATH, JSON.stringify({ accounts: out }, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

export function validateAccountName(name: string): string | null {
  if (!name || !NAME_RE.test(name)) {
    return 'Name must be 1-64 characters: letters, digits, "-", "_" only.';
  }
  return null;
}

export async function upsertMailAccount(name: string, input: MailAccountInput): Promise<MailAccountSafeView> {
  const nameError = validateAccountName(name);
  if (nameError) throw new Error(nameError);

  const store = await loadStore();
  const existing = store.accounts[name];

  if (!input.imapHost?.trim()) throw new Error('imapHost is required.');
  if (!input.user?.trim()) throw new Error('user is required.');

  let passwordEnc = existing?.passwordEnc;
  if (input.password && input.password.trim()) {
    passwordEnc = await encrypt(input.password);
  }
  if (!passwordEnc) throw new Error('password is required for a new account.');

  let smtpPasswordEnc = existing?.smtpPasswordEnc;
  if (input.smtpPassword && input.smtpPassword.trim()) {
    smtpPasswordEnc = await encrypt(input.smtpPassword);
  }

  const record: StoredAccount = {
    imapHost: input.imapHost.trim(),
    imapPort: input.imapPort || 993,
    imapSecure: input.imapSecure !== false,
    user: input.user.trim(),
    passwordEnc,
    smtpHost: input.smtpHost?.trim() || undefined,
    smtpPort: input.smtpHost?.trim() ? (input.smtpPort || 587) : undefined,
    smtpSecure: input.smtpHost?.trim() ? !!input.smtpSecure : undefined,
    smtpUser: input.smtpUser?.trim() || undefined,
    smtpPasswordEnc: input.smtpHost?.trim() ? smtpPasswordEnc : undefined,
    mailFrom: input.mailFrom?.trim() || undefined,
    imapAllowInsecureTLS: input.imapAllowInsecureTLS === true,
    smtpAllowInsecureTLS: input.smtpHost?.trim()
      ? (input.smtpAllowInsecureTLS !== undefined ? input.smtpAllowInsecureTLS === true : input.imapAllowInsecureTLS === true)
      : false,
    updatedAt: new Date().toISOString(),
  };

  store.accounts[name] = record;
  await saveStore(store);
  await writePlaintextAccountsFile(store);
  return toSafeView(name, record);
}

export async function deleteMailAccount(name: string): Promise<boolean> {
  const store = await loadStore();
  if (!store.accounts[name]) return false;
  delete store.accounts[name];
  await saveStore(store);
  await writePlaintextAccountsFile(store);
  return true;
}

export interface TestConnectionResult {
  ok: boolean;
  error?: string;
}

export async function testMailAccountConnection(input: MailAccountInput): Promise<TestConnectionResult> {
  if (!input.imapHost?.trim() || !input.user?.trim() || !input.password?.trim()) {
    return { ok: false, error: 'imapHost, user and password are all required to test.' };
  }
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: input.imapHost.trim(),
    port: input.imapPort || 993,
    secure: input.imapSecure !== false,
    auth: { user: input.user.trim(), pass: input.password },
    logger: false,
    ...(input.imapAllowInsecureTLS ? { tls: { rejectUnauthorized: false } } : {}),
  });
  const TIMEOUT_MS = 10000;
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timed out after 10s.')), TIMEOUT_MS)),
    ]);
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error.responseText || error.message || String(error) };
  } finally {
    await client.logout().catch(() => {});
  }
}

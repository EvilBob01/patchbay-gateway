import { Client } from 'ssh2';
import { readFile } from 'fs/promises';
import os from 'os';
import path from 'path';

export const PUBLIC_KEY_PATH = process.env.SSH_PUBLIC_KEY_PATH || path.join(os.homedir(), '.ssh', 'id_ed25519.pub');
// Matching private key, offered as the default --key for new SSH backends.
export const PRIVATE_KEY_PATH = PUBLIC_KEY_PATH.replace(/\.pub$/, '');

export interface DeployKeyParams {
  host: string;
  port: number;
  username: string;
  password: string;
}

export async function getGatewayPublicKey(): Promise<string> {
  const raw = await readFile(PUBLIC_KEY_PATH, 'utf-8');
  return raw.trim();
}

// One-shot password-authenticated SSH connection that appends this gateway's own
// public key to the target user's authorized_keys. The password is used only for
// the duration of this single connection and is never persisted or logged.
export async function deployKeyToHost(params: DeployKeyParams): Promise<{ message: string }> {
  const pubKey = await getGatewayPublicKey();

  // Single-quoted heredoc-free append, using grep -F to avoid duplicate entries.
  // The public key itself is a trusted local file's content (not user input), so
  // safe to embed directly; wrapped in single quotes to avoid shell interpretation.
  const remoteCommand = [
    'mkdir -p ~/.ssh',
    'chmod 700 ~/.ssh',
    'touch ~/.ssh/authorized_keys',
    `(grep -qF '${pubKey}' ~/.ssh/authorized_keys || echo '${pubKey}' >> ~/.ssh/authorized_keys)`,
    'chmod 600 ~/.ssh/authorized_keys',
  ].join(' && ');

  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timeoutHandle = setTimeout(() => {
      conn.end();
      reject(new Error('Connection timed out after 15 seconds.'));
    }, 15000);

    conn
      .on('ready', () => {
        conn.exec(remoteCommand, (err, stream) => {
          if (err) {
            clearTimeout(timeoutHandle);
            conn.end();
            reject(err);
            return;
          }
          let stderr = '';
          stream
            .on('close', (code: number) => {
              clearTimeout(timeoutHandle);
              conn.end();
              if (code === 0) {
                resolve({ message: `Public key deployed to ${params.username}@${params.host}.` });
              } else {
                reject(new Error(`Remote command exited with code ${code}. ${stderr}`.trim()));
              }
            })
            .on('data', () => {
              // stdout from the remote command; nothing to do with it.
            })
            .stderr.on('data', (data: Buffer) => {
              stderr += data.toString();
            });
        });
      })
      .on('error', (err) => {
        clearTimeout(timeoutHandle);
        reject(err);
      })
      .connect({
        host: params.host,
        port: params.port || 22,
        username: params.username,
        password: params.password,
        readyTimeout: 10000,
        // No host key verification pinning: this mirrors the existing ssh-mcp
        // backends' behavior (no host key pinning) and is used for one-shot,
        // admin-initiated actions against internal-only hosts.
      });
  });
}

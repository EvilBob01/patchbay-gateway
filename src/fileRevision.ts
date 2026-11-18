// Stale-save protection for the admin API's whole-file saves (mcp_server.json,
// tool_config.json, tool_policy.json).
//
// The admin UI loads a file, the admin edits it in the page, and Save sends the
// page's whole copy back. Without a check, a page loaded before someone else's
// change (another admin, a hand edit on the gateway) silently undoes that change
// when it saves. So every GET answers with the file's revision in the
// X-Config-Revision header, the UI sends it back on save, and a save made from
// an older revision is refused with 409 instead of overwriting.
//
// A save without the header is not checked (scripts that POST a file they built
// themselves); the admin UI always sends it.
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import type { Request } from 'express';

export const REVISION_HEADER = 'X-Config-Revision';
/** Revision of a file that does not exist yet. */
export const NO_FILE_REVISION = 'none';

/** Revision of a file's exact text (null: the file does not exist). */
export function revisionOf(text: string | null): string {
  return text === null ? NO_FILE_REVISION : createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

/** Reads `path` and returns its text (null when absent) and revision. */
export async function readWithRevision(path: string): Promise<{ text: string | null; revision: string }> {
  let text: string | null;
  try {
    text = await readFile(path, 'utf-8');
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
    text = null;
  }
  return { text, revision: revisionOf(text) };
}

/** The revision the client says its copy was loaded at; undefined when not sent. */
export function expectedRevision(req: Request): string | undefined {
  const v = req.get(REVISION_HEADER);
  return v && v.trim() ? v.trim() : undefined;
}

export class StaleRevisionError extends Error {
  readonly status = 409;
  constructor(readonly current: string) {
    super('This file changed on the gateway after this page loaded it (another admin saved, or it was edited on the gateway). '
      + 'Saving would undo that change, so nothing was saved. Reload the page to get the current version, then make your change again.');
  }
}

/** Throws StaleRevisionError when the client sent a revision that is not the current one. */
export function assertFresh(expected: string | undefined, current: string): void {
  if (expected !== undefined && expected !== current) throw new StaleRevisionError(current);
}

// Saves to one file run one at a time, so the revision check and the write of
// one save can't interleave with another save's.
const queues = new Map<string, Promise<unknown>>();
export function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(path) ?? Promise.resolve()).then(fn, fn);
  queues.set(path, run.catch(() => undefined));
  return run;
}

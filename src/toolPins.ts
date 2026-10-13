// Rug-pull protection: pin every backend tool definition by hash, and withhold
// a tool whose definition changes until an admin approves it.
//
// Why: a backend (or a compromised or updated package behind it) can change a
// tool's description, schema or annotations after it was reviewed.
// Descriptions go straight into the model's context, so a silent change is a
// prompt-injection channel. A new tool on a known backend is the same risk.
//
// This module only decides. mcp-proxy.ts calls admit() for every backend
// tools/list it receives, and only `served` tools ever reach toolToClientMap,
// so tools/list, tools/call, authorization, trifecta, collapsing and lazy
// search/describe/call all see approved definitions only.
//
// Per tool:
//   pin hash matches          served (a pin marked removed is un-removed: "returned")
//   hash differs              held, reason "changed"
//   no pin, backend known     held, reason "new-tool" (both modes)
//   no pin, backend unknown   tofu: pinned ("tofu"); review: held ("new-backend")
//   pinned, not listed        pin marked removedAt ("removed")
// Missing file: every tool seen before endBaseline() is pinned silently
// ("baseline") -- the upgrade path. Unreadable file: fail closed, every tool
// held, the file is never overwritten; delete it and re-check to re-seed.
//
// MCP_PIN_TOOLS=false turns all of this off (nothing is read or written).
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { configPath } from './paths.js';

export type NewBackendMode = 'tofu' | 'review';

/** On unless MCP_PIN_TOOLS=false. */
export const PIN_TOOLS_ENABLED = process.env.MCP_PIN_TOOLS !== 'false';
export const PIN_NEW_BACKENDS: NewBackendMode = process.env.MCP_PIN_NEW_BACKENDS === 'review' ? 'review' : 'tofu';
// In the config directory (PATCHBAY_CONFIG_DIR), not the code directory: a
// native install keeps the code root-owned and read-only to the service.
export const TOOL_PINS_PATH = process.env.MCP_TOOL_PINS_PATH
  || configPath('tool_pins.json');

/** JSON-RPC error code for a call to a tool that is pending review. */
export const TOOL_PENDING_REVIEW_CODE = -32012;

export interface PinnedDefinition {
  name: string;
  title: unknown;
  description: unknown;
  inputSchema: unknown;
  outputSchema: unknown;
  annotations: unknown;
}

export interface PinEntry {
  hash: string;
  definition: PinnedDefinition;
  pinnedAt: string;
  /** `baseline`, `tofu` or the approving admin's username. */
  approvedBy: string;
  removedAt?: string;
}

export type HoldReason = 'changed' | 'new-tool' | 'new-backend' | 'pin-file-unreadable';

export interface PendingEntry {
  hash: string;
  definition: PinnedDefinition;
  reason: HoldReason;
  firstSeenAt: string;
  /** The pin it would replace, if any. */
  previous?: PinEntry;
  rejectedAt?: string;
  rejectedBy?: string;
}

export type PinEventKind = 'baseline' | 'tofu' | 'held' | 'approved' | 'rejected' | 'removed' | 'returned' | 'reverted';

export interface PinEvent {
  event: PinEventKind;
  backend: string;
  tool: string;
  oldHash?: string;
  newHash?: string;
  reason?: HoldReason;
  admin?: string;
}

export interface AdmitResult { served: Tool[]; events: PinEvent[] }

export interface PinSnapshot {
  enabled: boolean;
  mode: NewBackendMode;
  error?: string;
  pending: Array<{
    backend: string; tool: string; hash: string; reason: HoldReason; firstSeenAt: string;
    rejectedAt?: string; rejectedBy?: string;
    old?: PinnedDefinition; oldHash?: string; oldApprovedBy?: string;
    new: PinnedDefinition;
  }>;
  /** backend -> number of live (not removed) pins. */
  pinned: Record<string, number>;
}

interface PinFile {
  version: 1;
  pins: Record<string, Record<string, PinEntry>>;
  pending: Record<string, Record<string, PendingEntry>>;
}

/** An admin operation that cannot be done; `status` is the HTTP status to answer with. */
export class PinError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 | 503) { super(message); }
}

/** JSON with object keys sorted at every level; array order kept. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, (v as Record<string, unknown>)[k]]))
      : v);

/** The parts of a backend definition that are pinned; `_meta` is not. */
export function normalizeDefinition(tool: Tool): PinnedDefinition {
  const t = tool as any;
  return {
    name: tool.name,
    title: t.title ?? null,
    description: t.description ?? null,
    inputSchema: t.inputSchema ?? null,
    outputSchema: t.outputSchema ?? null,
    annotations: t.annotations ?? null,
  };
}

export function hashDefinition(tool: Tool): string {
  return createHash('sha256').update(canonical(normalizeDefinition(tool))).digest('hex');
}

export function pinsConfigSummary(): string {
  return PIN_TOOLS_ENABLED
    ? `Tool pinning (rug-pull protection): ON, new backends: ${PIN_NEW_BACKENDS} (MCP_PIN_TOOLS, MCP_PIN_NEW_BACKENDS) -> ${TOOL_PINS_PATH}`
    : 'Tool pinning (rug-pull protection): OFF (MCP_PIN_TOOLS=false)';
}

export class ToolPinStore {
  private file: PinFile = { version: 1, pins: {}, pending: {} };
  private baseline = false;
  private error: string | undefined;
  private listeners: Array<() => void> = [];
  private readonly now: () => Date;

  constructor(private readonly opts: { path: string; mode: NewBackendMode; now?: () => Date }) {
    this.now = opts.now ?? (() => new Date());
  }

  get mode(): NewBackendMode { return this.opts.mode; }
  /** Set when the pin file exists but cannot be read; every tool is held. */
  get failClosedError(): string | undefined { return this.error; }

  load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.opts.path, 'utf-8');
    } catch (e: any) {
      if (e?.code === 'ENOENT') { this.baseline = true; this.file = { version: 1, pins: {}, pending: {} }; this.error = undefined; return; }
      this.error = `cannot read ${this.opts.path}: ${e?.message || e}`;
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.version !== 1 || typeof parsed.pins !== 'object' || parsed.pins === null) throw new Error('not a version 1 pin file');
      this.file = { version: 1, pins: parsed.pins, pending: parsed.pending ?? {} };
      this.baseline = false;
      this.error = undefined;
    } catch (e: any) {
      this.error = `${this.opts.path} is unreadable (${e?.message || e}); every tool is held. Delete the file and re-check to re-pin the current tools.`;
    }
  }

  /** The startup pass is over: from now on new backends follow the mode. */
  endBaseline(): void {
    if (this.baseline) { this.baseline = false; this.save(); }
  }

  admit(backend: string, tools: Tool[]): AdmitResult {
    const at = this.now().toISOString();
    const served: Tool[] = [];
    const events: PinEvent[] = [];

    if (this.error) {
      const pend = (this.file.pending[backend] ??= {});
      for (const tool of tools) {
        const hash = hashDefinition(tool);
        if (pend[tool.name]?.hash !== hash) {
          pend[tool.name] = { hash, definition: normalizeDefinition(tool), reason: 'pin-file-unreadable', firstSeenAt: at };
          events.push({ event: 'held', backend, tool: tool.name, newHash: hash, reason: 'pin-file-unreadable' });
        }
      }
      if (events.length) this.changed(false);
      return { served, events };
    }

    const knownBackend = Object.prototype.hasOwnProperty.call(this.file.pins, backend);
    const pins = (this.file.pins[backend] ??= {});
    const pend = (this.file.pending[backend] ??= {});
    const listed = new Set<string>();

    for (const tool of tools) {
      listed.add(tool.name);
      const hash = hashDefinition(tool);
      const pin = pins[tool.name];
      if (pin && pin.hash === hash) {
        served.push(tool);
        if (pin.removedAt) { delete pin.removedAt; events.push({ event: 'returned', backend, tool: tool.name, newHash: hash }); }
        if (pend[tool.name]) { delete pend[tool.name]; events.push({ event: 'reverted', backend, tool: tool.name, newHash: hash }); }
        continue;
      }
      if (!pin && (this.baseline || (!knownBackend && this.opts.mode === 'tofu'))) {
        const by = this.baseline ? 'baseline' : 'tofu';
        pins[tool.name] = { hash, definition: normalizeDefinition(tool), pinnedAt: at, approvedBy: by };
        served.push(tool);
        events.push({ event: by, backend, tool: tool.name, newHash: hash });
        continue;
      }
      if (pend[tool.name]?.hash === hash) continue; // already held for exactly this definition
      const reason: HoldReason = pin ? 'changed' : knownBackend ? 'new-tool' : 'new-backend';
      pend[tool.name] = { hash, definition: normalizeDefinition(tool), reason, firstSeenAt: at, ...(pin ? { previous: pin } : {}) };
      events.push({ event: 'held', backend, tool: tool.name, oldHash: pin?.hash, newHash: hash, reason });
    }

    for (const [name, pin] of Object.entries(pins)) {
      if (!listed.has(name) && !pin.removedAt) {
        pin.removedAt = at;
        events.push({ event: 'removed', backend, tool: name, oldHash: pin.hash });
      }
    }
    for (const name of Object.keys(pend)) {
      if (!listed.has(name)) delete pend[name];
    }

    if (events.length || !knownBackend) this.changed(events.length > 0);
    return { served, events };
  }

  pendingFor(backend: string, tool: string): PendingEntry | undefined {
    return this.file.pending[backend]?.[tool];
  }

  approve(backend: string, tool: string, hash: string, admin: string): PinEvent {
    const p = this.checkPending(backend, tool, hash);
    this.pinPending(backend, tool, p, admin);
    this.changed(true);
    return { event: 'approved', backend, tool, oldHash: p.previous?.hash, newHash: p.hash, admin };
  }

  reject(backend: string, tool: string, hash: string, admin: string): PinEvent {
    const p = this.checkPending(backend, tool, hash);
    p.rejectedAt = this.now().toISOString();
    p.rejectedBy = admin;
    this.changed(true);
    return { event: 'rejected', backend, tool, oldHash: p.previous?.hash, newHash: p.hash, admin };
  }

  /** Approve several of a backend's pending tools; refused as a whole if any hash is stale. */
  approveBackend(backend: string, hashes: Record<string, string>, admin: string): PinEvent[] {
    const names = Object.keys(hashes);
    if (!names.length) throw new PinError('Nothing to approve.', 400);
    const checked = names.map(name => [name, this.checkPending(backend, name, hashes[name])] as const);
    for (const [name, p] of checked) this.pinPending(backend, name, p, admin);
    this.changed(true);
    return checked.map(([name, p]) => ({ event: 'approved' as const, backend, tool: name, oldHash: p.previous?.hash, newHash: p.hash, admin }));
  }

  snapshot(): PinSnapshot {
    const pending: PinSnapshot['pending'] = [];
    for (const backend of Object.keys(this.file.pending).sort()) {
      for (const name of Object.keys(this.file.pending[backend]).sort()) {
        const p = this.file.pending[backend][name];
        pending.push({
          backend, tool: name, hash: p.hash, reason: p.reason, firstSeenAt: p.firstSeenAt,
          ...(p.rejectedAt ? { rejectedAt: p.rejectedAt, rejectedBy: p.rejectedBy } : {}),
          ...(p.previous ? { old: p.previous.definition, oldHash: p.previous.hash, oldApprovedBy: p.previous.approvedBy } : {}),
          new: p.definition,
        });
      }
    }
    const pinned: Record<string, number> = {};
    for (const [backend, pins] of Object.entries(this.file.pins)) {
      pinned[backend] = Object.values(pins).filter(p => !p.removedAt).length;
    }
    return { enabled: true, mode: this.opts.mode, ...(this.error ? { error: this.error } : {}), pending, pinned };
  }

  onChange(fn: () => void): void { this.listeners.push(fn); }

  private checkPending(backend: string, tool: string, hash: string): PendingEntry {
    if (this.error) throw new PinError(`Tool pins are unavailable: ${this.error}`, 503);
    const p = this.file.pending[backend]?.[tool];
    if (!p) throw new PinError(`${backend}/${tool} is not pending review.`, 404);
    if (p.hash !== hash) throw new PinError(`${backend}/${tool} changed again since you looked; reload the review page.`, 409);
    return p;
  }

  private pinPending(backend: string, tool: string, p: PendingEntry, admin: string): void {
    (this.file.pins[backend] ??= {})[tool] = { hash: p.hash, definition: p.definition, pinnedAt: this.now().toISOString(), approvedBy: admin };
    delete this.file.pending[backend][tool];
  }

  private changed(notify: boolean): void {
    this.save();
    if (notify) for (const fn of this.listeners) { try { fn(); } catch { /* a listener must not break admission */ } }
  }

  private save(): void {
    if (this.error || this.baseline) return; // never overwrite an unreadable file; baseline is saved by endBaseline()
    mkdirSync(path.dirname(this.opts.path), { recursive: true });
    const tmp = `${this.opts.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.file, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, this.opts.path);
  }
}

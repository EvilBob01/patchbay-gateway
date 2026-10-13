// Ranking for the gateway's search_tools meta-tool (lazy.ts): plain BM25 over
// tool names, descriptions and parameter names, in-process and dependency-free.
//
// The corpus is always just the tools the caller may use (the caller filters
// before ranking), so scores carry no information about tools they can't see.
// A few hundred short documents: ranking per query costs well under a
// millisecond, so only the tokenization is cached.
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const STOP = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'its',
  'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with', 'all', 'any', 'can', 'will', 'you', 'your']);

/** Lowercased word tokens; splits camelCase, snake_case, kebab-case and dots. */
export function tokenize(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !STOP.has(t))
    .map(stem)
    .map(t => VERBS.get(t) ?? t);
}

// Verbs that tool names and requests use interchangeably, folded to one word.
// Deliberately tiny: only the verbs that name tool families (search_*, get_*,
// delete_*), so "find tickets" meets search_tickets.
const VERBS = new Map([
  ['find', 'search'], ['lookup', 'search'], ['query', 'search'],
  ['fetch', 'get'], ['retrieve', 'get'],
  ['remove', 'delete'], ['erase', 'delete'],
]);

// Just enough stemming that "lists"/"listing"/"list" meet; no dictionary.
function stem(t: string): string {
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith('es') && /(ss|x|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 2 && t.endsWith('s') && !/(ss|us|is)$/.test(t)) return t.slice(0, -1);
  return t;
}

const NAME_WEIGHT = 3;
const SUMMARY_WEIGHT = 2;

/**
 * The searchable text of one tool, normalised: its name (×3), its first
 * sentence (×2) and the rest of its description, the backend name and
 * one-liner, the title, and parameter NAMES. Parameter descriptions are left
 * out: they are mostly boilerplate ("the node name", "optional filter") that
 * makes unrelated tools look alike. BM25's IDF then keeps words that occur on
 * many tools ("list", "get") from outranking the specific ones.
 */
export function toolTokens(backend: string, backendDescription: string, tool: Tool): string[] {
  const name = tokenize(tool.name);
  const summary = firstSentence(tool.description, Number.MAX_SAFE_INTEGER);
  const rest = (tool.description ?? '').trim().slice(summary.length);
  const params = Object.keys(((tool.inputSchema as any)?.properties ?? {}) as Record<string, unknown>).flatMap(k => tokenize(k));
  return [
    ...Array.from({ length: NAME_WEIGHT }, () => name).flat(),
    ...Array.from({ length: SUMMARY_WEIGHT }, () => tokenize(summary)).flat(),
    ...tokenize(rest),
    ...tokenize(backend), ...tokenize(backendDescription),
    ...tokenize(tool.title),
    ...params,
  ];
}

export interface Ranked<T> { item: T; score: number }

/**
 * BM25 (k1 1.2, b 0.75) of `query` over `docs`, best first; zero scores
 * dropped. Returns the top `k`, extended to include every hit tied with the
 * k-th, up to `ceiling`: a tie is never broken silently.
 */
export function rankBM25<T>(query: string, docs: { item: T; tokens: string[] }[], k: number, ceiling: number): Ranked<T>[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !docs.length) return [];
  const N = docs.length;
  const avgdl = docs.reduce((a, d) => a + d.tokens.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d.tokens)) if (q.includes(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.2, b = 0.75;
  const scored: Ranked<T>[] = [];
  for (const d of docs) {
    const tf = new Map<string, number>();
    for (const t of d.tokens) if (q.includes(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const [t, f] of tf) {
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.tokens.length / avgdl));
    }
    if (score > 0) scored.push({ item: d.item, score: Math.round(score * 1000) / 1000 });
  }
  scored.sort((x, y) => y.score - x.score);
  if (scored.length <= k) return scored;
  const cutoff = scored[k - 1].score;
  let end = k;
  while (end < scored.length && end < ceiling && scored[end].score === cutoff) end++;
  return scored.slice(0, end);
}

/** First sentence (or line) of a description, capped. */
export function firstSentence(text: string | undefined, max = 160): string {
  const line = (text ?? '').split(/\r?\n/).map(l => l.trim()).find(l => l) ?? '';
  const m = line.match(/^(.+?[.!?])(\s|$)/);
  const s = m ? m[1] : line;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

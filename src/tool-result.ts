// Client-compatibility shaping of tools/call results.
//
// Ported from willscottuk/mcp-proxy-server 190093a1 (MIT), with a toggle added:
// the upstream fork merges unconditionally, this one only when asked to.
import type { CallerIdentity } from './identity.js';

/**
 * Gateway-wide default for merging adjacent text blocks. Off unless
 * MCP_MERGE_TEXT_CONTENT=true, because clients that read every block (Claude)
 * gain nothing from it and should see results exactly as the backend sent them.
 */
export const MERGE_TEXT_CONTENT_DEFAULT = process.env.MCP_MERGE_TEXT_CONTENT === 'true';

/**
 * Whether this caller's tool results get their text blocks merged. A per-user
 * `mergeTextContent` in users.json (carried on the identity) wins over the
 * gateway-wide default, in both directions. A per-endpoint override would slot
 * in here too.
 */
export function shouldMergeTextContent(
  identity: CallerIdentity | undefined,
  gatewayDefault: boolean = MERGE_TEXT_CONTENT_DEFAULT,
): boolean {
  return identity?.mergeTextContent ?? gatewayDefault;
}

/**
 * The last step before a tools/call result leaves the gateway. Runs after the
 * audit record is written; nothing upstream of it (rate limit, authorization,
 * trifecta, audit) reads content blocks.
 */
export function shapeToolResult<T>(
  result: T,
  identity: CallerIdentity | undefined,
  gatewayDefault: boolean = MERGE_TEXT_CONTENT_DEFAULT,
): T {
  return shouldMergeTextContent(identity, gatewayDefault) ? mergeAdjacentTextContent(result) : result;
}

export function mergeTextContentConfigSummary(): string {
  return `Merge adjacent text blocks in tool results: ${MERGE_TEXT_CONTENT_DEFAULT ? 'ON' : 'off'} by default` +
    ' (MCP_MERGE_TEXT_CONTENT; per-user mergeTextContent in users.json overrides)';
}

/**
 * Joins each run of adjacent text content blocks in a tool result into one
 * block.
 *
 * Some MCP clients only read the first content block of a tool result. The
 * OpenAI Responses API's remote MCP tool is one: a backend that answers in
 * several text blocks (metadata first and the body second, or one block per
 * row) has everything after the first block silently dropped. Joining the text
 * keeps the whole answer visible to those clients. Non-text blocks are left
 * where they are, so text and images stay in their original order.
 */
export function mergeAdjacentTextContent<T>(result: T): T {
  const content = (result as any)?.content;
  if (!Array.isArray(content) || content.length < 2) {
    return result;
  }

  const merged: any[] = [];
  for (const block of content) {
    const previous = merged[merged.length - 1];
    if (isPlainText(block) && isPlainText(previous)) {
      merged[merged.length - 1] = { ...previous, text: `${previous.text}\n\n${block.text}` };
    } else {
      merged.push(block);
    }
  }

  if (merged.length === content.length) {
    return result;
  }

  return { ...(result as any), content: merged };
}

/** A text block with nothing besides its text that joining would lose. */
function isPlainText(block: any): boolean {
  return block?.type === 'text'
    && typeof block.text === 'string'
    && Object.keys(block).every((key) => key === 'type' || key === 'text');
}

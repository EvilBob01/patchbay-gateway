import { McpError } from '@modelcontextprotocol/sdk/types.js';

// The SDK's McpError constructor puts "MCP error <code>: " in front of the
// message it is given, and the server side sends that .message to the client as
// the JSON-RPC error message -- where the client SDK prefixes it a second time.
// Errors the gateway raises (or forwards from a backend) are therefore built with
// a bare .message, so the client's one prefix is the only one.

const PREFIX = /^MCP error -?\d+: /;

/** Drop one leading "MCP error <code>: " (only the one for `code`, when given). */
export function stripMcpPrefix(message: string, code?: number): string {
  const m = PREFIX.exec(message);
  if (!m) return message;
  if (code !== undefined && m[0] !== `MCP error ${code}: `) return message;
  return message.slice(m[0].length);
}

/** An McpError whose .message is the bare text; code and data are unchanged. */
export function gatewayError(code: number, message: string, data?: unknown): McpError {
  const e = new McpError(code, stripMcpPrefix(message, code), data);
  e.message = stripMcpPrefix(message, code);
  return e;
}

/** A caught McpError (e.g. from a backend) re-issued with a bare message; anything else is returned as is. */
export function bareError<T>(err: T): T | McpError {
  if (!(err instanceof McpError)) return err;
  if (!PREFIX.test(err.message)) return err;
  return gatewayError(err.code, err.message, err.data);
}

// Simulated MCP backend: no shell, SSH, credentials or external connections.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const name = process.argv[2] || 'demo';
let restarts = 0;
const server = new Server({ name: `simulated-${name}`, version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'read-command', description: 'SIMULATED host status. Only accepts uptime; never runs a command.',
    inputSchema: { type: 'object', properties: { command: { type: 'string', enum: ['uptime'] } }, required: ['command'], additionalProperties: false },
    annotations: { readOnlyHint: true } },
  { name: 'run-command', description: 'SIMULATED restart counter. Only accepts restart-demo; changes memory only.',
    inputSchema: { type: 'object', properties: { command: { type: 'string', enum: ['restart-demo'] } }, required: ['command'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false } },
] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const command = params.arguments?.command;
  if (params.name === 'read-command' && command === 'uptime') {
    return { content: [{ type: 'text', text: `SIMULATED ${name}: healthy; demo restarts=${restarts}` }] };
  }
  if (params.name === 'run-command' && command === 'restart-demo') {
    restarts++;
    return { content: [{ type: 'text', text: `SIMULATED ${name}: restart counter=${restarts}; no real service changed` }] };
  }
  return { isError: true, content: [{ type: 'text', text: 'Unsupported simulation request. No command was executed.' }] };
});
await server.connect(new StdioServerTransport());
process.stdin.on('end', () => process.exit(0));

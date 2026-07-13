import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { parseConfig, type Config } from './config.js';
import { FusionClient } from './fusion-client.js';

const NAME = 'fusion-mcp';
const VERSION = '0.1.0';

/**
 * Append-only audit line to stderr for every tool invocation. Governance
 * requirement: each tool call is logged with a timestamp, the tool name, and a
 * short, secret-free argument summary. FM tasks reuse this for their tools.
 */
export function auditLog(tool: string, argsSummary: Record<string, unknown> = {}): void {
  const summary = Object.entries(argsSummary)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');
  process.stderr.write(`[${new Date().toISOString()}] tool=${tool}${summary ? ` ${summary}` : ''}\n`);
}

/**
 * Build a fully-wired MCP server. The scaffold registers ONLY `get_board_health`
 * as a proof-of-life tool; the remaining tools (task read/write, settings) are
 * implemented by the FM-00x tasks on top of the same {@link FusionClient}.
 *
 * A fresh server is built per stdio process and per stateless HTTP request, so
 * this must stay side-effect free apart from tool registration.
 */
export function buildServer(client: FusionClient, config: Config): McpServer {
  const server = new McpServer({ name: NAME, version: VERSION });

  server.registerTool(
    'get_board_health',
    {
      title: 'Get board health',
      description:
        'Liveness and diagnostics for the Fusion board. Reads GET /api/health ' +
        '(auth-exempt) and, when a token is configured, GET /api/system/info. Read-only.',
      inputSchema: {},
    },
    async () => {
      auditLog('get_board_health');
      const health = (await client.getHealth()).data;

      let system: unknown;
      if (config.token) {
        // Best-effort: never let a diagnostics failure mask a healthy liveness probe.
        try {
          system = (await client.getSystemInfo()).data;
        } catch (err) {
          system = { error: err instanceof Error ? err.message : String(err) };
        }
      }

      const payload = { tokenConfigured: Boolean(config.token), health, system };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    },
  );

  return server;
}

async function runStdio(client: FusionClient, config: Config): Promise<void> {
  const server = buildServer(client, config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[${NAME}] listening on stdio\n`);
}

/**
 * Minimal stateless Streamable HTTP transport: a fresh server + transport per
 * request, JSON responses, bound to loopback. FM-003 replaces this with proper
 * per-session handling and graceful shutdown.
 */
async function runHttp(client: FusionClient, config: Config): Promise<void> {
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleHttpRequest(req, res, client, config);
  });
  httpServer.listen(config.port, '127.0.0.1', () => {
    process.stderr.write(`[${NAME}] listening on http://127.0.0.1:${config.port}/mcp\n`);
  });
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  client: FusionClient,
  config: Config,
): Promise<void> {
  if (req.url?.split('?')[0] !== '/mcp') {
    res.writeHead(404).end('Not found');
    return;
  }

  const server = buildServer(client, config);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, await readJsonBody(req));
  } catch (err) {
    process.stderr.write(`[${NAME}] request error: ${err instanceof Error ? err.message : String(err)}\n`);
    if (!res.headersSent) {
      res.writeHead(500).end('Internal error');
    }
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
  });
}

async function main(): Promise<void> {
  const useHttp = process.argv.includes('--http');
  const config = parseConfig();
  const client = new FusionClient(config);
  if (useHttp) {
    await runHttp(client, config);
  } else {
    await runStdio(client, config);
  }
}

// Only run when executed as the entry point, not when imported by tests.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(err => {
    process.stderr.write(`[${NAME}] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import { createServer } from "node:http";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import {
  McpServer,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

import { parseConfig, type Config } from "./config.js";
import { FusionClient, type FetchLike } from "./fusion-client.js";
import {
  formatValidationError,
  withToolErrorEnvelope,
} from "./tool-error.js";

const emptyInputShape = {} satisfies z.ZodRawShape;

const readProjectSettingsInputShape = {
  projectId: z.string().min(1).optional(),
} satisfies z.ZodRawShape;

export interface BuildServerOptions {
  client?: FusionClient;
  fetch?: FetchLike;
}

export type RunMode = "stdio" | "http";

type RuntimeMcpServer = Pick<McpServer, "connect" | "close">;
type HttpTransport = Transport &
  Pick<StreamableHTTPServerTransport, "handleRequest">;

export interface HttpServerLike {
  listen(port: number, hostname: string, callback: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export interface RuntimeDependencies {
  config?: Config;
  serverFactory?: (config: Config) => RuntimeMcpServer;
  stdioTransportFactory?: () => Transport;
  httpTransportFactory?: (
    options: StreamableHTTPServerTransportOptions,
  ) => HttpTransport;
  httpServerFactory?: (listener: RequestListener) => HttpServerLike;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

class CliArgumentError extends Error {}

export function auditLog(tool: string, argsSummary = ""): void {
  const summary = argsSummary.replace(/\s+/g, " ").trim();
  process.stderr.write(
    `[${new Date().toISOString()}] tool=${tool}${summary === "" ? "" : ` ${summary}`}\n`,
  );
}

type GovernedInputSchemas = Map<string, z.ZodType>;

type ProtocolRequestHandler = (
  request: unknown,
  extra: unknown,
) => unknown | Promise<unknown>;

interface ProtocolRequestHandlerStore {
  _requestHandlers: Map<string, ProtocolRequestHandler>;
}

function isToolCall(request: unknown): request is {
  method: "tools/call";
  params: { name: string; arguments?: unknown };
} {
  if (typeof request !== "object" || request === null) {
    return false;
  }
  const { method, params } = request as { method?: unknown; params?: unknown };
  if (method !== "tools/call" || typeof params !== "object" || params === null) {
    return false;
  }
  return typeof (params as { name?: unknown }).name === "string";
}

function normalizeInvalidToolCalls(
  server: McpServer,
  inputSchemas: GovernedInputSchemas,
): void {
  const setRequestHandler = server.server.setRequestHandler.bind(server.server);
  let installed = false;

  server.server.setRequestHandler = (schema, handler) => {
    setRequestHandler(schema, handler);

    if (installed) {
      return;
    }

    // The SDK's registered tools/call handler first parses the strict protocol
    // request schema. Replace only the stored outer function so governed calls
    // with null/array arguments can be normalized before that parse; all valid
    // calls continue through the original SDK validation and result checks.
    const requestHandlers = (
      server.server as unknown as ProtocolRequestHandlerStore
    )._requestHandlers;
    const strictToolCallHandler = requestHandlers.get("tools/call");
    if (strictToolCallHandler === undefined) {
      return;
    }

    requestHandlers.set("tools/call", async (request, extra) => {
      if (isToolCall(request)) {
        const inputSchema = inputSchemas.get(request.params.name);
        const rawArguments =
          request.params.arguments === undefined
            ? {}
            : request.params.arguments;
        const parsed = inputSchema?.safeParse(rawArguments);
        if (parsed !== undefined && !parsed.success) {
          auditLog(request.params.name, "validation=failed");
          return formatValidationError(parsed.error.issues);
        }
      }
      return await strictToolCallHandler(request, extra);
    });
    installed = true;
  };
}

function registerGovernedTool<InputShape extends z.ZodRawShape>(
  server: McpServer,
  inputSchemas: GovernedInputSchemas,
  name: string,
  config: { description: string; inputSchema: InputShape },
  handler: ToolCallback<InputShape>,
): void {
  inputSchemas.set(name, z.object(config.inputSchema));
  server.registerTool(
    name,
    config,
    withToolErrorEnvelope(handler) as ToolCallback<InputShape>,
  );
}

export function buildServer(
  config: Config,
  options: BuildServerOptions = {},
): McpServer {
  const client =
    options.client ?? new FusionClient(config, options.fetch ?? globalThis.fetch);
  const server = new McpServer({ name: "fusion-mcp", version: "0.1.0" });
  const governedInputSchemas: GovernedInputSchemas = new Map();
  normalizeInvalidToolCalls(server, governedInputSchemas);

  registerGovernedTool(
    server,
    governedInputSchemas,
    "get_board_health",
    {
      description: "Check Fusion board health and available system information",
      inputSchema: emptyInputShape,
    },
    async () => {
      auditLog("get_board_health");
      const health = await client.getHealth();
      const result: { health: unknown; systemInfo?: unknown } = {
        health: health.data,
      };

      if (config.token !== undefined) {
        try {
          const systemInfo = await client.getSystemInfo();
          result.systemInfo = systemInfo.data;
        } catch {
          result.systemInfo = { available: false };
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  registerGovernedTool(
    server,
    governedInputSchemas,
    "list_projects",
    {
      description: "List configured projects",
      inputSchema: emptyInputShape,
    },
    async () => {
      auditLog("list_projects");
      const projects = await client.listProjects();
      return {
        content: [
          { type: "text", text: JSON.stringify({ projects: projects.data }) },
        ],
      };
    },
  );

  registerGovernedTool(
    server,
    governedInputSchemas,
    "read_project_settings",
    {
      description: "Read project or instance settings",
      inputSchema: readProjectSettingsInputShape,
    },
    async ({ projectId }) => {
      const effectiveProjectId = projectId ?? config.defaultProjectId;
      auditLog(
        "read_project_settings",
        effectiveProjectId === undefined ? "" : `projectId=${effectiveProjectId}`,
      );
      const settings = await client.getSettings(effectiveProjectId);
      return {
        content: [
          { type: "text", text: JSON.stringify({ settings: settings.data }) },
        ],
      };
    },
  );

  return server;
}

export function selectMode(args: readonly string[]): RunMode {
  if (args.length === 0) {
    return "stdio";
  }
  if (args.length === 1 && args[0] === "--stdio") {
    return "stdio";
  }
  if (args.length === 1 && args[0] === "--http") {
    return "http";
  }
  if (args.includes("--stdio") && args.includes("--http")) {
    throw new CliArgumentError("--stdio and --http cannot be used together");
  }
  const offendingArgument =
    args.find((argument) => argument !== "--stdio" && argument !== "--http") ??
    args[1] ??
    args[0] ??
    "";
  throw new CliArgumentError(`unknown argument: ${offendingArgument}`);
}

function defaultServerFactory(config: Config): RuntimeMcpServer {
  return buildServer(config);
}

async function dispatchHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: Config,
  dependencies: RuntimeDependencies,
): Promise<void> {
  const path = request.url?.split("?", 1)[0];
  if (path !== "/mcp") {
    response.statusCode = 404;
    response.end();
    return;
  }

  const serverFactory = dependencies.serverFactory ?? defaultServerFactory;
  const transportFactory =
    dependencies.httpTransportFactory ??
    ((options) => new StreamableHTTPServerTransport(options));
  const server = serverFactory(config);
  const transport = transportFactory({
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: [`127.0.0.1:${config.port}`],
  });

  try {
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(request, response);
  } catch {
    if (!response.headersSent) {
      response.statusCode = 500;
      response.end("MCP request failed");
    }
    (dependencies.stderr ?? process.stderr).write(
      "fusion-mcp: HTTP request failed\n",
    );
  } finally {
    await server.close().catch(() => undefined);
  }
}

export async function startHttpServer(
  config: Config,
  dependencies: RuntimeDependencies = {},
): Promise<HttpServerLike> {
  const factory =
    dependencies.httpServerFactory ??
    ((listener: RequestListener) => createServer(listener));

  return await new Promise<HttpServerLike>((resolve, reject) => {
    const httpServer = factory((request, response) => {
      void dispatchHttpRequest(
        request,
        response,
        config,
        dependencies,
      );
    });
    httpServer.once("error", reject);
    httpServer.listen(config.port, "127.0.0.1", () => {
      resolve(httpServer);
    });
  });
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  dependencies: RuntimeDependencies = {},
): Promise<void> {
  const mode = selectMode(args);
  const config = dependencies.config ?? parseConfig();
  const serverFactory = dependencies.serverFactory ?? defaultServerFactory;

  if (mode === "stdio") {
    const server = serverFactory(config);
    const transport =
      dependencies.stdioTransportFactory?.() ?? new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  await startHttpServer(config, dependencies);
}

function safeCliError(error: unknown): string {
  if (error instanceof CliArgumentError) {
    return error.message;
  }
  if (
    error instanceof Error &&
    /^(FUSION_BASE_URL|FUSION_REQUEST_TIMEOUT_MS|PORT) must/.test(error.message)
  ) {
    return error.message;
  }
  return "failed to start";
}

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  dependencies: RuntimeDependencies = {},
): Promise<number> {
  try {
    await main(args, dependencies);
    return 0;
  } catch (error) {
    (dependencies.stderr ?? process.stderr).write(
      `fusion-mcp: ${safeCliError(error)}\n`,
    );
    return 1;
  }
}

export function isDirectExecution(
  moduleUrl: string,
  argv: readonly string[] = process.argv,
): boolean {
  return argv[1] !== undefined && moduleUrl === pathToFileURL(argv[1]).href;
}

if (isDirectExecution(import.meta.url)) {
  void runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

#!/usr/bin/env node

import { createServer } from "node:http";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

import { parseConfig, type Config, type Environment } from "./config.js";
import {
  FusionClient,
  FusionError,
  type FetchLike,
} from "./fusion-client.js";

const listTasksInputShape = {
  projectId: z.string().optional(),
  limit: z.number().int().positive().max(200).default(50),
  offset: z.number().int().nonnegative().default(0),
  q: z.string().optional(),
  column: z.string().optional(),
  includeArchived: z.boolean().optional(),
} satisfies z.ZodRawShape;

const listTasksInputSchema = z.object(listTasksInputShape);

const listedTaskSchema = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    column: z.string().optional(),
    priority: z.string().optional(),
    status: z.string().optional(),
    projectId: z.string().optional(),
    workflowId: z.string().nullable().optional(),
  })
  .strip();

function shapeListedTasks(data: unknown): z.infer<typeof listedTaskSchema>[] {
  const result = listedTaskSchema.array().safeParse(data);
  if (!result.success) {
    throw new FusionError("Fusion returned an invalid task list: GET /api/tasks", {
      method: "GET",
      path: "/api/tasks",
    });
  }
  return result.data;
}

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
  env?: Environment;
  serverFactory?: (config: Config) => RuntimeMcpServer;
  stdioTransportFactory?: () => Transport;
  httpTransportFactory?: (
    options: StreamableHTTPServerTransportOptions,
  ) => HttpTransport;
  httpServerFactory?: (listener: RequestListener) => HttpServerLike;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

class CliArgumentError extends Error {}

function parseTotalCount(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }
  const total = Number(value);
  return Number.isSafeInteger(total) ? total : null;
}

function parseConfiguredHttpHosts(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }

  return value.split(",").map((entry) => {
    const candidate = entry.trim();
    try {
      const parsed = new URL(`http://${candidate}`);
      if (
        candidate === "" ||
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.pathname !== "/" ||
        parsed.search !== "" ||
        parsed.hash !== "" ||
        parsed.hostname === ""
      ) {
        throw new Error("invalid host");
      }
      return candidate.toLowerCase();
    } catch {
      throw new Error(
        "FUSION_MCP_ALLOWED_HOSTS must be a comma-separated list of exact Host values",
      );
    }
  });
}

function trustedHttpHosts(config: Config, env: Environment): string[] {
  return [
    ...new Set([
      `127.0.0.1:${config.port}`,
      ...parseConfiguredHttpHosts(env.FUSION_MCP_ALLOWED_HOSTS),
    ]),
  ];
}

export function auditLog(tool: string, argsSummary = ""): void {
  const summary = argsSummary.replace(/\s+/g, " ").trim();
  process.stderr.write(
    `[${new Date().toISOString()}] tool=${tool}${summary === "" ? "" : ` ${summary}`}\n`,
  );
}

function isListTasksCall(request: unknown): request is {
  method: "tools/call";
  params: { name: "list_tasks"; arguments?: unknown };
} {
  if (typeof request !== "object" || request === null) {
    return false;
  }
  const { method, params } = request as { method?: unknown; params?: unknown };
  if (method !== "tools/call" || typeof params !== "object" || params === null) {
    return false;
  }
  return (params as { name?: unknown }).name === "list_tasks";
}

function auditInvalidListTasksCalls(server: McpServer): void {
  const setRequestHandler = server.server.setRequestHandler.bind(server.server);

  server.server.setRequestHandler = (schema, handler) => {
    setRequestHandler(schema, async (request, extra) => {
      if (
        isListTasksCall(request) &&
        !listTasksInputSchema.safeParse(request.params.arguments ?? {}).success
      ) {
        auditLog("list_tasks", "validation=failed");
      }
      return await handler(request, extra);
    });
  };
}

export function buildServer(
  config: Config,
  options: BuildServerOptions = {},
): McpServer {
  const client =
    options.client ?? new FusionClient(config, options.fetch ?? globalThis.fetch);
  const server = new McpServer({ name: "fusion-mcp", version: "0.1.0" });
  auditInvalidListTasksCalls(server);

  server.registerTool(
    "get_board_health",
    {
      description: "Check Fusion board health and available system information",
      inputSchema: {},
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

  server.registerTool(
    "list_tasks",
    {
      description: "List board tasks with optional project and task filters",
      inputSchema: listTasksInputShape,
    },
    async ({ projectId, limit, offset, q, column, includeArchived }) => {
      const resolvedProjectId = projectId ?? config.defaultProjectId;
      auditLog(
        "list_tasks",
        `column=${column ?? "all"} limit=${limit} offset=${offset} projectIdApplied=${resolvedProjectId !== undefined} includeArchived=${includeArchived ?? false}`,
      );
      const response = await client.request<unknown>("GET", "/api/tasks", {
        query: {
          projectId: resolvedProjectId,
          limit,
          offset,
          q,
          column,
          includeArchived,
        },
      });
      const tasks = shapeListedTasks(response.data);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              tasks,
              pagination: { limit, offset },
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_task",
    {
      description: "Get a single board task",
      inputSchema: {
        id: z.string().min(1, "id is required"),
        projectId: z.string().optional(),
      },
    },
    async ({ id, projectId }) => {
      const resolvedProjectId = projectId ?? config.defaultProjectId;
      auditLog(
        "get_task",
        `id=${id} projectIdApplied=${resolvedProjectId !== undefined}`,
      );
      const task = await client.request<unknown>(
        "GET",
        `/api/tasks/${encodeURIComponent(id)}`,
        { query: { projectId: resolvedProjectId } },
      );

      return {
        content: [
          { type: "text", text: JSON.stringify({ task: task.data }) },
        ],
      };
    },
  );

  server.registerTool(
    "get_task_logs",
    {
      description: "Get a paginated page of task logs",
      inputSchema: {
        id: z.string().min(1, "id is required"),
        limit: z.number().int().positive().max(200).default(50),
        offset: z.number().int().nonnegative().default(0),
      },
    },
    async ({ id, limit, offset }) => {
      auditLog("get_task_logs", `id=${id} limit=${limit} offset=${offset}`);
      const logs = await client.request<unknown>(
        "GET",
        `/api/tasks/${encodeURIComponent(id)}/logs`,
        { query: { limit, offset } },
      );
      const total = parseTotalCount(logs.headers.get("x-total-count"));
      const hasMore = logs.headers.get("x-has-more")?.toLowerCase() === "true";

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              logs: logs.data,
              pagination: { total, hasMore, limit, offset },
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_task_workflow_results",
    {
      description: "Get workflow-step results for a task",
      inputSchema: { id: z.string().min(1, "id is required") },
    },
    async ({ id }) => {
      auditLog("get_task_workflow_results", `id=${id}`);
      const workflowResults = await client.request<unknown>(
        "GET",
        `/api/tasks/${encodeURIComponent(id)}/workflow-results`,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ workflowResults: workflowResults.data }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "list_projects",
    {
      description: "List configured projects",
      inputSchema: {},
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

  server.registerTool(
    "read_project_settings",
    {
      description: "Read project or instance settings",
      inputSchema: { projectId: z.string().min(1).optional() },
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
  allowedHosts: readonly string[],
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
    allowedHosts: [...allowedHosts],
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
  const allowedHosts = trustedHttpHosts(
    config,
    dependencies.env ?? process.env,
  );

  return await new Promise<HttpServerLike>((resolve, reject) => {
    const httpServer = factory((request, response) => {
      void dispatchHttpRequest(
        request,
        response,
        config,
        allowedHosts,
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
    /^(FUSION_BASE_URL|FUSION_REQUEST_TIMEOUT_MS|FUSION_MCP_ALLOWED_HOSTS|PORT) must/.test(
      error.message,
    )
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

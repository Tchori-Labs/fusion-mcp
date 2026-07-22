#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";
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
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { parseConfig, type Config, type Environment } from "./config.js";
import { FusionClient, FusionError, type FetchLike } from "./fusion-client.js";
import { redactSettings } from "./redact-settings.js";
import { formatValidationError, withToolErrorEnvelope } from "./tool-error.js";

const emptyInputShape = {} satisfies z.ZodRawShape;

const listTasksInputShape = {
  projectId: z.string().optional(),
  limit: z.number().int().positive().max(200).default(50),
  offset: z.number().int().nonnegative().default(0),
  q: z.string().optional(),
  column: z.string().optional(),
  includeArchived: z.boolean().optional(),
} satisfies z.ZodRawShape;

const getTaskInputShape = {
  id: z.string().min(1, "id is required"),
  projectId: z.string().optional(),
} satisfies z.ZodRawShape;

const listApprovalsInputShape = {
  projectId: z.string().optional(),
} satisfies z.ZodRawShape;

const getApprovalInputShape = {
  id: z.string().min(1, "id is required"),
  projectId: z.string().optional(),
} satisfies z.ZodRawShape;

const listMissionsInputShape = {
  projectId: z.string().optional(),
  includeDrafts: z.boolean().optional(),
} satisfies z.ZodRawShape;

const getMissionInputShape = {
  id: z.string().min(1, "id is required"),
  projectId: z.string().optional(),
} satisfies z.ZodRawShape;

const getTaskLogsInputShape = {
  id: z.string().min(1, "id is required"),
  projectId: z.string().optional(),
  limit: z.number().int().positive().max(200).default(50),
  offset: z.number().int().nonnegative().default(0),
} satisfies z.ZodRawShape;

const getTaskWorkflowResultsInputShape = {
  id: z.string().min(1, "id is required"),
  projectId: z.string().optional(),
} satisfies z.ZodRawShape;

const readProjectSettingsInputShape = {
  projectId: z.string().min(1).optional(),
} satisfies z.ZodRawShape;

export const updateProjectSettingsSchema = z
  .strictObject({
    mergeStrategy: z.string().min(1).max(500).optional(),
    mergeConflictStrategy: z.string().min(1).max(500).optional(),
    directMergeCommitStrategy: z.string().min(1).max(500).optional(),
    integrationBranch: z.string().min(1).max(500).optional(),
    githubTrackingDefaultRepo: z.string().min(1).max(500).optional(),
    autoMerge: z.boolean().optional(),
    pushAfterMerge: z.boolean().optional(),
    autoArchiveDuplicateTasksEnabled: z.boolean().optional(),
    planApprovalMode: z.literal("require-all").optional(),
  })
  .refine((settings) => Object.keys(settings).length > 0);

const updateProjectSettingsInputShape = {
  settings: updateProjectSettingsSchema,
  projectId: z.string().min(1).optional(),
} satisfies z.ZodRawShape;

const updateTaskInputSchema = z
  .object({
    id: z.string().min(1, "id is required"),
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    priority: z.string().min(1).optional(),
    dependencies: z.array(z.string().min(1)).optional(),
    projectId: z.string().min(1).optional(),
  })
  .refine(
    ({ title, description, priority, dependencies }) =>
      title !== undefined ||
      description !== undefined ||
      priority !== undefined ||
      dependencies !== undefined,
  );

const createTaskInputShape = {
  description: z.string().min(1, "description is required"),
  title: z.string().optional(),
  column: z.string().optional(),
  priority: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  workflowId: z.string().optional(),
  baseBranch: z.string().optional(),
  projectId: z.string().optional(),
} satisfies z.ZodRawShape;

const commentTaskInputShape = {
  id: z.string().min(1, "id is required"),
  text: z.string().min(1, "text is required"),
  author: z.string().optional(),
  projectId: z.string().optional(),
} satisfies z.ZodRawShape;

const steerTaskInputShape = {
  id: z.string().min(1, "id is required"),
  text: z.string().min(1).max(2000),
  projectId: z.string().optional(),
} satisfies z.ZodRawShape;

const taskLifecycleInputShape = {
  id: z.string().min(1, "id is required"),
  projectId: z.string().optional(),
} satisfies z.ZodRawShape;

const archiveTaskInputShape = {
  id: z.string().min(1, "id is required"),
  projectId: z.string().min(1).optional(),
} satisfies z.ZodRawShape;

const moveTaskInputShape = {
  id: z.string().min(1, "id is required"),
  column: z.string().min(1, "column is required"),
  projectId: z.string().optional(),
} satisfies z.ZodRawShape;

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
    throw new FusionError(
      "Fusion returned an invalid task list: GET /api/tasks",
      {
        method: "GET",
        path: "/api/tasks",
        kind: "invalid_payload",
      },
    );
  }
  return result.data;
}

export interface BuildServerOptions {
  client?: FusionClient;
  fetch?: FetchLike;
}

export type RunMode = "stdio" | "http";

type RuntimeMcpServer = Pick<McpServer, "connect" | "close">;
type HttpTransport = Pick<Transport, "close"> &
  Pick<StreamableHTTPServerTransport, "handleRequest">;

export interface HttpServerLike {
  listen(port: number, hostname: string, callback: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  close(callback: (error?: Error) => void): this;
}

export interface HttpServerHandle extends HttpServerLike {
  shutdown(): Promise<void>;
}

export interface SignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
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
  httpRequestBodyParser?: (request: IncomingMessage) => Promise<unknown>;
  signalSource?: SignalSource;
  setExitCode?: (exitCode: number) => void;
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

interface GovernedInputSchema {
  schema: z.ZodType;
  allowedPathSegments: ReadonlySet<string>;
}

type GovernedInputSchemas = Map<string, GovernedInputSchema>;

type StoredRequestHandler = (
  request: unknown,
  extra: unknown,
) => unknown | Promise<unknown>;

interface RequestHandlerStore {
  _requestHandlers: Map<string, StoredRequestHandler>;
}

function isToolCall(request: unknown): request is {
  method: "tools/call";
  params: { name: string; arguments?: unknown };
} {
  if (typeof request !== "object" || request === null) {
    return false;
  }
  const { method, params } = request as { method?: unknown; params?: unknown };
  if (
    method !== "tools/call" ||
    typeof params !== "object" ||
    params === null
  ) {
    return false;
  }
  return typeof (params as { name?: unknown }).name === "string";
}

function normalizeInvalidToolCalls(
  server: McpServer,
  inputSchemas: GovernedInputSchemas,
): void {
  const protocol = server.server as unknown as RequestHandlerStore;
  const setRequestHandler = server.server.setRequestHandler.bind(server.server);

  server.server.setRequestHandler = (schema, handler) => {
    setRequestHandler(schema, handler);

    // Both Server.setRequestHandler and Protocol.setRequestHandler parse the
    // strict tools/call schema before invoking their public callbacks. Wrap the
    // installed protocol handler so malformed argument containers can still
    // receive the governed tool envelope before either SDK parser rejects them.
    const installedHandler = protocol._requestHandlers.get("tools/call");
    if (installedHandler === undefined) {
      return;
    }

    protocol._requestHandlers.set("tools/call", async (request, extra) => {
      if (isToolCall(request)) {
        const input = inputSchemas.get(request.params.name);
        const rawArguments =
          request.params.arguments === undefined
            ? {}
            : request.params.arguments;
        const parsed = input?.schema.safeParse(rawArguments);
        if (input !== undefined && parsed !== undefined && !parsed.success) {
          auditLog(request.params.name, "validation=failed");
          return formatValidationError(
            parsed.error.issues,
            input.allowedPathSegments,
          );
        }
      }
      return await installedHandler(request, extra);
    });
  };
}

function registerGovernedTool<InputSchema extends z.ZodRawShape | z.ZodType>(
  server: McpServer,
  inputSchemas: GovernedInputSchemas,
  name: string,
  config: { description: string; inputSchema: InputSchema },
  handler: ToolCallback<InputSchema>,
): void {
  const schema =
    config.inputSchema instanceof z.ZodType
      ? config.inputSchema
      : z.object(config.inputSchema);
  const allowedPathSegments =
    schema instanceof z.ZodObject
      ? new Set(Object.keys(schema.shape))
      : new Set<string>();
  inputSchemas.set(name, { schema, allowedPathSegments });
  server.registerTool(
    name,
    config,
    withToolErrorEnvelope(handler) as ToolCallback<InputSchema>,
  );
}

export function buildServer(
  config: Config,
  options: BuildServerOptions = {},
): McpServer {
  const client =
    options.client ??
    new FusionClient(config, options.fetch ?? globalThis.fetch);
  const server = new McpServer({ name: "fusion-mcp", version: "0.2.0" });
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

  registerGovernedTool(
    server,
    governedInputSchemas,
    "get_task",
    {
      description: "Get a single board task",
      inputSchema: getTaskInputShape,
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
        content: [{ type: "text", text: JSON.stringify({ task: task.data }) }],
      };
    },
  );

  registerGovernedTool(
    server,
    governedInputSchemas,
    "get_task_logs",
    {
      description: "Get a paginated page of task logs",
      inputSchema: getTaskLogsInputShape,
    },
    async ({ id, projectId, limit, offset }) => {
      const resolvedProjectId = projectId ?? config.defaultProjectId;
      auditLog(
        "get_task_logs",
        `id=${id} limit=${limit} offset=${offset} projectIdApplied=${resolvedProjectId !== undefined}`,
      );
      const logs = await client.request<unknown>(
        "GET",
        `/api/tasks/${encodeURIComponent(id)}/logs`,
        { query: { projectId: resolvedProjectId, limit, offset } },
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

  registerGovernedTool(
    server,
    governedInputSchemas,
    "get_task_workflow_results",
    {
      description: "Get workflow-step results for a task",
      inputSchema: getTaskWorkflowResultsInputShape,
    },
    async ({ id, projectId }) => {
      const resolvedProjectId = projectId ?? config.defaultProjectId;
      auditLog(
        "get_task_workflow_results",
        `id=${id} projectIdApplied=${resolvedProjectId !== undefined}`,
      );
      const workflowResults = await client.request<unknown>(
        "GET",
        `/api/tasks/${encodeURIComponent(id)}/workflow-results`,
        { query: { projectId: resolvedProjectId } },
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
        effectiveProjectId === undefined
          ? ""
          : `projectId=${effectiveProjectId}`,
      );
      const settings = await client.getSettings(effectiveProjectId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ settings: redactSettings(settings.data) }),
          },
        ],
      };
    },
  );

  registerGovernedTool(
    server,
    governedInputSchemas,
    "create_task",
    {
      description: "Create a board task using the governed safe field subset",
      inputSchema: createTaskInputShape,
    },
    async ({
      description,
      title,
      column,
      priority,
      dependencies,
      workflowId,
      baseBranch,
      projectId,
    }) => {
      const resolvedProjectId = projectId ?? config.defaultProjectId;
      const body = {
        description,
        ...(title === undefined ? {} : { title }),
        ...(column === undefined ? {} : { column }),
        ...(priority === undefined ? {} : { priority }),
        ...(dependencies === undefined ? {} : { dependencies }),
        ...(workflowId === undefined ? {} : { workflowId }),
        ...(baseBranch === undefined ? {} : { baseBranch }),
        ...(resolvedProjectId === undefined
          ? {}
          : { projectId: resolvedProjectId }),
      };

      auditLog(
        "create_task",
        `title=${title ?? "(none)"} column=${column ?? "(default)"}`,
      );
      const response = await client.request<unknown>("POST", "/api/tasks", {
        body,
      });

      return {
        content: [
          { type: "text", text: JSON.stringify({ task: response.data }) },
        ],
      };
    },
  );

  registerGovernedTool(
    server,
    governedInputSchemas,
    "comment_task",
    {
      description: "Post a comment to a task",
      inputSchema: commentTaskInputShape,
    },
    async ({ id, text, author, projectId }) => {
      const resolvedProjectId = projectId ?? config.defaultProjectId;
      auditLog(
        "comment_task",
        `id=${id} projectIdApplied=${resolvedProjectId !== undefined}`,
      );
      const comment = await client.request<unknown>(
        "POST",
        `/api/tasks/${encodeURIComponent(id)}/comments`,
        {
          body: {
            text,
            ...(author === undefined ? {} : { author }),
            ...(resolvedProjectId === undefined
              ? {}
              : { projectId: resolvedProjectId }),
          },
        },
      );

      return {
        content: [
          { type: "text", text: JSON.stringify({ comment: comment.data }) },
        ],
      };
    },
  );

  registerGovernedTool(
    server,
    governedInputSchemas,
    "steer_task",
    {
      description: "Send a steering message to a running task",
      inputSchema: steerTaskInputShape,
    },
    async ({ id, text, projectId }) => {
      const resolvedProjectId = projectId ?? config.defaultProjectId;
      auditLog(
        "steer_task",
        `id=${id} projectIdApplied=${resolvedProjectId !== undefined}`,
      );
      const steered = await client.request<unknown>(
        "POST",
        `/api/tasks/${encodeURIComponent(id)}/steer`,
        {
          body: {
            text,
            ...(resolvedProjectId === undefined
              ? {}
              : { projectId: resolvedProjectId }),
          },
        },
      );

      return {
        content: [
          { type: "text", text: JSON.stringify({ steered: steered.data }) },
        ],
      };
    },
  );

  for (const { name, action, description } of [
    { name: "pause_task", action: "pause", description: "Pause a board task" },
    {
      name: "unpause_task",
      action: "unpause",
      description: "Resume a paused board task",
    },
  ] as const) {
    registerGovernedTool(
      server,
      governedInputSchemas,
      name,
      {
        description,
        inputSchema: taskLifecycleInputShape,
      },
      async ({ id, projectId }) => {
        const resolvedProjectId = projectId ?? config.defaultProjectId;
        auditLog(
          name,
          `id=${id} projectIdApplied=${resolvedProjectId !== undefined}`,
        );
        const response = await client.request<unknown>(
          "POST",
          `/api/tasks/${encodeURIComponent(id)}/${action}`,
          resolvedProjectId === undefined
            ? undefined
            : { body: { projectId: resolvedProjectId } },
        );

        return {
          content: [
            { type: "text", text: JSON.stringify({ task: response.data }) },
          ],
        };
      },
    );
  }

  registerGovernedTool(
    server,
    governedInputSchemas,
    "list_approvals",
    {
      description: "List board approvals",
      inputSchema: listApprovalsInputShape,
    },
    async ({ projectId }) => {
      const resolvedProjectId = projectId ?? config.defaultProjectId;
      auditLog(
        "list_approvals",
        `projectIdApplied=${resolvedProjectId !== undefined}`,
      );
      const response = await client.request<unknown>("GET", "/api/approvals", {
        query: { projectId: resolvedProjectId },
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ approvals: response.data }),
          },
        ],
      };
    },
  );

  registerGovernedTool(
    server,
    governedInputSchemas,
    "get_approval",
    {
      description: "Get a single board approval",
      inputSchema: getApprovalInputShape,
    },
    async ({ id, projectId }) => {
      const resolvedProjectId = projectId ?? config.defaultProjectId;
      auditLog(
        "get_approval",
        `id=${id} projectIdApplied=${resolvedProjectId !== undefined}`,
      );
      const response = await client.request<unknown>(
        "GET",
        `/api/approvals/${encodeURIComponent(id)}`,
        { query: { projectId: resolvedProjectId } },
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ approval: response.data }),
          },
        ],
      };
    },
  );

  registerGovernedTool(
    server,
    governedInputSchemas,
    "list_missions",
    {
      description: "List board missions",
      inputSchema: listMissionsInputShape,
    },
    async ({ projectId, includeDrafts }) => {
      const resolvedProjectId = projectId ?? config.defaultProjectId;
      auditLog(
        "list_missions",
        `includeDrafts=${includeDrafts ?? false} projectIdApplied=${resolvedProjectId !== undefined}`,
      );
      const response = await client.request<unknown>("GET", "/api/missions", {
        query: { projectId: resolvedProjectId, includeDrafts },
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ missions: response.data }),
          },
        ],
      };
    },
  );

  registerGovernedTool(
    server,
    governedInputSchemas,
    "get_mission",
    {
      description: "Get a board mission with status and health",
      inputSchema: getMissionInputShape,
    },
    async ({ id, projectId }) => {
      const resolvedProjectId = projectId ?? config.defaultProjectId;
      auditLog(
        "get_mission",
        `id=${id} projectIdApplied=${resolvedProjectId !== undefined}`,
      );
      const encodedId = encodeURIComponent(id);
      const query = { projectId: resolvedProjectId };
      const mission = await client.request<unknown>(
        "GET",
        `/api/missions/${encodedId}`,
        { query },
      );

      let status: unknown = { available: false };
      try {
        status = (
          await client.request<unknown>(
            "GET",
            `/api/missions/${encodedId}/status`,
            { query },
          )
        ).data;
      } catch {
        // Status is a best-effort sub-view; the primary mission remains useful.
      }

      let health: unknown = { available: false };
      try {
        health = (
          await client.request<unknown>(
            "GET",
            `/api/missions/${encodedId}/health`,
            { query },
          )
        ).data;
      } catch {
        // Health is a best-effort sub-view; the primary mission remains useful.
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ mission: mission.data, status, health }),
          },
        ],
      };
    },
  );

  registerGovernedTool(
    server,
    governedInputSchemas,
    "move_task",
    {
      description:
        "Move a board task to another column (board reprioritisation)",
      inputSchema: moveTaskInputShape,
    },
    async ({ id, column, projectId }) => {
      const resolvedProjectId = projectId ?? config.defaultProjectId;
      auditLog(
        "move_task",
        `id=${id} column=${column} projectIdApplied=${resolvedProjectId !== undefined}`,
      );
      const response = await client.request<unknown>(
        "POST",
        `/api/tasks/${encodeURIComponent(id)}/move`,
        {
          body: {
            column,
            ...(resolvedProjectId === undefined
              ? {}
              : { projectId: resolvedProjectId }),
          },
        },
      );

      return {
        content: [
          { type: "text", text: JSON.stringify({ task: response.data }) },
        ],
      };
    },
  );

  registerGovernedTool(
    server,
    governedInputSchemas,
    "update_project_settings",
    {
      description:
        "Update project settings. Allowed keys: autoArchiveDuplicateTasksEnabled, autoMerge, directMergeCommitStrategy, githubTrackingDefaultRepo, integrationBranch, mergeConflictStrategy, mergeStrategy, planApprovalMode (require-all only), pushAfterMerge",
      inputSchema: updateProjectSettingsInputShape,
    },
    async ({ settings, projectId }) => {
      const resolvedProjectId = projectId ?? config.defaultProjectId;
      if (resolvedProjectId === undefined) {
        auditLog("update_project_settings", "validation=failed");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: {
                  code: "validation",
                  message: "Invalid tool arguments",
                  details: [
                    {
                      path: ["projectId"],
                      message:
                        "projectId is required when FUSION_DEFAULT_PROJECT_ID is not configured",
                    },
                  ],
                },
              }),
            },
          ],
          isError: true,
        };
      }
      const body = {
        ...(settings.mergeStrategy === undefined
          ? {}
          : { mergeStrategy: settings.mergeStrategy }),
        ...(settings.mergeConflictStrategy === undefined
          ? {}
          : { mergeConflictStrategy: settings.mergeConflictStrategy }),
        ...(settings.directMergeCommitStrategy === undefined
          ? {}
          : { directMergeCommitStrategy: settings.directMergeCommitStrategy }),
        ...(settings.integrationBranch === undefined
          ? {}
          : { integrationBranch: settings.integrationBranch }),
        ...(settings.githubTrackingDefaultRepo === undefined
          ? {}
          : { githubTrackingDefaultRepo: settings.githubTrackingDefaultRepo }),
        ...(settings.autoMerge === undefined
          ? {}
          : { autoMerge: settings.autoMerge }),
        ...(settings.pushAfterMerge === undefined
          ? {}
          : { pushAfterMerge: settings.pushAfterMerge }),
        ...(settings.autoArchiveDuplicateTasksEnabled === undefined
          ? {}
          : {
              autoArchiveDuplicateTasksEnabled:
                settings.autoArchiveDuplicateTasksEnabled,
            }),
        ...(settings.planApprovalMode === undefined
          ? {}
          : { planApprovalMode: settings.planApprovalMode }),
      };
      const keys = Object.keys(body).sort().join(",");
      auditLog(
        "update_project_settings",
        `projectIdApplied=${resolvedProjectId !== undefined} keys=${keys}`,
      );
      const response = await client.request<unknown>("PUT", "/api/settings", {
        query: { projectId: resolvedProjectId },
        body,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ settings: redactSettings(response.data) }),
          },
        ],
      };
    },
  );

  registerGovernedTool(
    server,
    governedInputSchemas,
    "update_task",
    {
      description:
        "Update task dependencies, priority, title, or description only",
      inputSchema: updateTaskInputSchema,
    },
    async ({ id, title, description, priority, dependencies, projectId }) => {
      const resolvedProjectId = projectId ?? config.defaultProjectId;
      const body = {
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(priority === undefined ? {} : { priority }),
        ...(dependencies === undefined ? {} : { dependencies }),
      };
      const fields = [
        title === undefined ? undefined : "title",
        description === undefined ? undefined : "description",
        priority === undefined ? undefined : "priority",
        dependencies === undefined ? undefined : "dependencies",
      ]
        .filter((field): field is string => field !== undefined)
        .sort()
        .join(",");
      auditLog(
        "update_task",
        `id=${id} fields=${fields} projectIdApplied=${resolvedProjectId !== undefined}`,
      );
      const response = await client.request<unknown>(
        "PATCH",
        `/api/tasks/${encodeURIComponent(id)}`,
        {
          query: { projectId: resolvedProjectId },
          body,
        },
      );

      return {
        content: [
          { type: "text", text: JSON.stringify({ task: response.data }) },
        ],
      };
    },
  );

  registerGovernedTool(
    server,
    governedInputSchemas,
    "archive_task",
    {
      description: "Archive a board task as recoverable board hygiene",
      inputSchema: archiveTaskInputShape,
    },
    async ({ id, projectId }) => {
      const resolvedProjectId = projectId ?? config.defaultProjectId;
      auditLog(
        "archive_task",
        `id=${id} projectIdApplied=${resolvedProjectId !== undefined}`,
      );
      const response = await client.request<unknown>(
        "POST",
        `/api/tasks/${encodeURIComponent(id)}/archive`,
        { query: { projectId: resolvedProjectId } },
      );

      return {
        content: [
          { type: "text", text: JSON.stringify({ task: response.data }) },
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

interface HttpSession {
  transport: HttpTransport;
  server: RuntimeMcpServer;
}

interface HttpRuntimeState {
  shuttingDown: boolean;
}

type HttpSessionRegistry = Map<string, HttpSession>;

const MAX_HTTP_REQUEST_BODY_BYTES = 1_048_576;

async function parseHttpRequestBody(
  request: IncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let byteLength = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as string);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_HTTP_REQUEST_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function requestHeader(
  request: IncomingMessage,
  name: "host" | "mcp-session-id",
): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function writeJsonRpcError(
  response: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  response.statusCode = status;
  response.setHeader?.("content-type", "application/json");
  response.end(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
  );
}

function closeSessionResources(session: HttpSession): Promise<void> {
  return Promise.all([
    session.transport.close().catch(() => undefined),
    session.server.close().catch(() => undefined),
  ]).then(() => undefined);
}

function removeRegisteredSession(
  sessionId: string,
  session: HttpSession,
  sessions: HttpSessionRegistry,
  dependencies: RuntimeDependencies,
): boolean {
  if (sessions.get(sessionId) !== session) {
    return false;
  }

  sessions.delete(sessionId);
  (dependencies.stderr ?? process.stderr).write(
    `fusion-mcp: session=${sessionId} event=close\n`,
  );
  return true;
}

function stopHttpServer(httpServer: HttpServerLike): Promise<void> {
  return new Promise((resolve) => {
    try {
      httpServer.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function dispatchHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: Config,
  allowedHosts: readonly string[],
  sessions: HttpSessionRegistry,
  pendingSessions: Set<HttpSession>,
  runtimeState: HttpRuntimeState,
  dependencies: RuntimeDependencies,
): Promise<void> {
  const path = request.url?.split("?", 1)[0];
  if (path !== "/mcp") {
    response.statusCode = 404;
    response.end();
    return;
  }

  const host = requestHeader(request, "host");
  if (host === undefined || !allowedHosts.includes(host)) {
    writeJsonRpcError(response, 403, -32_000, "Invalid Host header");
    return;
  }

  if (runtimeState.shuttingDown) {
    writeJsonRpcError(response, 503, -32_000, "Server is shutting down");
    return;
  }

  const sessionId = requestHeader(request, "mcp-session-id");
  if (sessionId !== undefined) {
    const session = sessions.get(sessionId);
    if (session === undefined) {
      writeJsonRpcError(response, 404, -32_001, "Session not found");
      return;
    }

    try {
      await session.transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.end("MCP request failed");
      }
      (dependencies.stderr ?? process.stderr).write(
        "fusion-mcp: HTTP request failed\n",
      );
    }
    return;
  }

  if (request.method !== "POST") {
    writeJsonRpcError(
      response,
      400,
      -32_000,
      "Bad Request: Mcp-Session-Id header is required",
    );
    return;
  }

  let parsedBody: unknown;
  try {
    parsedBody = await (
      dependencies.httpRequestBodyParser ?? parseHttpRequestBody
    )(request);
  } catch {
    writeJsonRpcError(response, 400, -32_700, "Parse error");
    return;
  }

  if (!isInitializeRequest(parsedBody)) {
    writeJsonRpcError(
      response,
      400,
      -32_000,
      "Bad Request: Mcp-Session-Id header is required",
    );
    return;
  }

  if (runtimeState.shuttingDown) {
    writeJsonRpcError(response, 503, -32_000, "Server is shutting down");
    return;
  }

  const serverFactory = dependencies.serverFactory ?? defaultServerFactory;
  const transportFactory =
    dependencies.httpTransportFactory ??
    ((options) => new StreamableHTTPServerTransport(options));
  const server = serverFactory(config);
  const sessionRef: { current?: HttpSession } = {};
  const transport = transportFactory({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: [...allowedHosts],
    onsessioninitialized: (initializedSessionId) => {
      const session = sessionRef.current;
      if (session === undefined || runtimeState.shuttingDown) {
        return;
      }
      pendingSessions.delete(session);
      sessions.set(initializedSessionId, session);
      (dependencies.stderr ?? process.stderr).write(
        `fusion-mcp: session=${initializedSessionId} event=init\n`,
      );
    },
    onsessionclosed: async (closedSessionId) => {
      const session = sessionRef.current;
      if (
        session !== undefined &&
        removeRegisteredSession(
          closedSessionId,
          session,
          sessions,
          dependencies,
        )
      ) {
        await session.server.close().catch(() => undefined);
      }
    },
  });
  const session = { transport, server };
  sessionRef.current = session;
  pendingSessions.add(session);

  try {
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(request, response, parsedBody);
  } catch {
    if (!response.headersSent) {
      response.statusCode = 500;
      response.end("MCP request failed");
    }
    (dependencies.stderr ?? process.stderr).write(
      "fusion-mcp: HTTP request failed\n",
    );
  } finally {
    if (pendingSessions.delete(session)) {
      await closeSessionResources(session);
    }
  }
}

export async function startHttpServer(
  config: Config,
  dependencies: RuntimeDependencies = {},
): Promise<HttpServerHandle> {
  const factory =
    dependencies.httpServerFactory ??
    ((listener: RequestListener) => createServer(listener));
  const allowedHosts = trustedHttpHosts(
    config,
    dependencies.env ?? process.env,
  );
  const sessions: HttpSessionRegistry = new Map();
  const pendingSessions = new Set<HttpSession>();
  const runtimeState: HttpRuntimeState = { shuttingDown: false };

  return await new Promise<HttpServerHandle>((resolve, reject) => {
    const httpServer = factory((request, response) => {
      void dispatchHttpRequest(
        request,
        response,
        config,
        allowedHosts,
        sessions,
        pendingSessions,
        runtimeState,
        dependencies,
      );
    });
    const signalSource = dependencies.signalSource ?? process;
    let shutdownPromise: Promise<void> | undefined;

    const shutdown = (): Promise<void> => {
      if (shutdownPromise !== undefined) {
        return shutdownPromise;
      }

      runtimeState.shuttingDown = true;
      signalSource.off("SIGINT", handleSignal);
      signalSource.off("SIGTERM", handleSignal);
      const stopped = stopHttpServer(httpServer);
      const registeredSessions = [...sessions.entries()];
      const resources = new Set<HttpSession>([
        ...registeredSessions.map(([, session]) => session),
        ...pendingSessions,
      ]);
      sessions.clear();
      pendingSessions.clear();
      for (const [sessionId] of registeredSessions) {
        (dependencies.stderr ?? process.stderr).write(
          `fusion-mcp: session=${sessionId} event=close\n`,
        );
      }

      shutdownPromise = Promise.all([...resources].map(closeSessionResources))
        .then(() => stopped)
        .then(() => undefined);
      return shutdownPromise;
    };

    const handleSignal = (): void => {
      void shutdown().then(() => {
        (
          dependencies.setExitCode ??
          ((code) => {
            process.exitCode = code;
          })
        )(0);
      });
    };

    const handle = Object.assign(httpServer, { shutdown });
    httpServer.once("error", reject);
    httpServer.listen(config.port, "127.0.0.1", () => {
      signalSource.on("SIGINT", handleSignal);
      signalSource.on("SIGTERM", handleSignal);
      resolve(handle);
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
    /^(FUSION_BASE_URL|FUSION_CF_ACCESS_CLIENT_ID|FUSION_CF_ACCESS_CLIENT_SECRET|FUSION_USER_AGENT|FUSION_REQUEST_TIMEOUT_MS|FUSION_MCP_ALLOWED_HOSTS|PORT) must/.test(
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
  const entryPath = argv[1];
  if (entryPath === undefined) {
    return false;
  }
  if (moduleUrl === pathToFileURL(entryPath).href) {
    return true;
  }
  // Package managers expose the CLI as a `node_modules/.bin` symlink while
  // Node resolves the module URL to the real file, so compare against the
  // resolved entry path as well.
  try {
    return moduleUrl === pathToFileURL(realpathSync(entryPath)).href;
  } catch {
    return false;
  }
}

if (isDirectExecution(import.meta.url)) {
  void runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

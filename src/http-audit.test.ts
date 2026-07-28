import type { RequestListener } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StreamableHTTPServerTransportOptions } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseConfig, type Config } from "./config.js";
import type { FetchLike } from "./fusion-client.js";
import {
  buildServer,
  startHttpServer,
  type HttpServerLike,
  type RuntimeDependencies,
} from "./index.js";
import type { ToolErrorEnvelope } from "./tool-error.js";

const tokenMarker = "http-audit-secret-marker";

type DiagnosticSink = { write: ReturnType<typeof vi.fn> };

async function createHarness(
  config: Config,
  fetch: FetchLike,
  prepareServer?: (server: McpServer) => void,
) {
  const stderr: DiagnosticSink = {
    write: vi.fn().mockReturnValue(true),
  };
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = buildServer(config, {
    fetch,
    stderr: stderr as unknown as Pick<NodeJS.WriteStream, "write">,
  });
  prepareServer?.(server);
  const client = new Client({ name: "http-audit-test", version: "1.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    stderr,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function auditLines(stderr: DiagnosticSink): string[] {
  return stderr.write.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes(" tool="));
}

function errorEnvelope(result: unknown): ToolErrorEnvelope {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error("expected tool result content");
  }
  const item: unknown = result.content[0];
  if (
    typeof item !== "object" ||
    item === null ||
    !("type" in item) ||
    item.type !== "text" ||
    !("text" in item) ||
    typeof item.text !== "string"
  ) {
    throw new Error("expected text tool result");
  }
  return JSON.parse(item.text) as ToolErrorEnvelope;
}

function expectSingleAudit(stderr: DiagnosticSink, expected: RegExp): void {
  const lines = auditLines(stderr);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(expected);
  expect(lines.join("\n")).not.toContain(tokenMarker);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("governed tool-call auditing", () => {
  it("audits an unknown hostile tool name once with a sanitized name", async () => {
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: tokenMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "../../evil tool\nname",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expectSingleAudit(
        harness.stderr,
        /^\[[^\]]+Z\] tool=.._.._evil_tool_name unknown_tool\n$/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("audits a governed pre-parse validation failure once", async () => {
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: tokenMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "get_task",
        arguments: { id: 42 },
      });

      expect(errorEnvelope(result).error.code).toBe("validation");
      expectSingleAudit(
        harness.stderr,
        /^\[[^\]]+Z\] tool=get_task validation=failed\n$/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("audits the in-handler project settings validation failure once", async () => {
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: tokenMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "update_project_settings",
        arguments: { settings: { autoMerge: false } },
      });

      expect(errorEnvelope(result).error.code).toBe("validation");
      expectSingleAudit(
        harness.stderr,
        /^\[[^\]]+Z\] tool=update_project_settings validation=failed\n$/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("audits an upstream failure once", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockRejectedValue(new Error(`network failed ${tokenMarker}`));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: tokenMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "get_task",
        arguments: { id: "KB-034" },
      });

      expect(errorEnvelope(result).error).toEqual({
        code: "upstream_error",
        message: "Upstream request failed",
      });
      expectSingleAudit(
        harness.stderr,
        /^\[[^\]]+Z\] tool=get_task id=KB-034 projectIdApplied=false\n$/,
      );
    } finally {
      await harness.close();
    }
  });

  it("treats omitted arguments as an empty object and audits once", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ status: "ok" }));
    const harness = await createHarness(parseConfig({}), fetchMock);

    try {
      const result = await harness.client.callTool({
        name: "get_board_health",
      });

      expect(result.isError).not.toBe(true);
      expectSingleAudit(
        harness.stderr,
        /^\[[^\]]+Z\] tool=get_board_health\n$/,
      );
    } finally {
      await harness.close();
    }
  });

  it("does not stack the normalizer when its installed handler is set again", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ status: "ok" }));
    const harness = await createHarness(
      parseConfig({}),
      fetchMock,
      (server) => {
        const protocol = server.server as unknown as {
          _requestHandlers: Map<string, never>;
        };
        const installed = protocol._requestHandlers.get("tools/call");
        if (installed === undefined) {
          throw new Error("tools/call handler was not installed");
        }
        server.server.setRequestHandler(CallToolRequestSchema, installed);
      },
    );

    try {
      const result = await harness.client.callTool({
        name: "stacked hostile tool",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expectSingleAudit(
        harness.stderr,
        /^\[[^\]]+Z\] tool=stacked_hostile_tool unknown_tool\n$/,
      );
    } finally {
      await harness.close();
    }
  });

  it("audits missing-token failure once before fetch", async () => {
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(parseConfig({}), fetchMock);

    try {
      const result = await harness.client.callTool({
        name: "list_tasks",
        arguments: {},
      });

      expect(errorEnvelope(result).error).toEqual({
        code: "missing_token",
        message: "Authentication token is required",
      });
      expectSingleAudit(
        harness.stderr,
        /^\[[^\]]+Z\] tool=list_tasks column=all limit=50 offset=0 projectIdApplied=false includeArchived=false\n$/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      const rendered = JSON.stringify(result);
      expect(rendered).not.toContain(tokenMarker);
      expect(rendered).not.toMatch(/authorization|stack/i);
    } finally {
      await harness.close();
    }
  });
});

type HttpRequestDouble = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

type HttpResponseDouble = ReturnType<typeof httpResponse>;

function httpFactoryHarness() {
  let listener: RequestListener | undefined;
  const server = {
    once: vi.fn(),
    listen: vi.fn(),
    close: vi.fn(),
  } as unknown as HttpServerLike;
  vi.mocked(server.once).mockReturnValue(server);
  vi.mocked(server.listen).mockImplementation(
    (_port: number, _host: string, callback: () => void) => {
      callback();
      return server;
    },
  );
  vi.mocked(server.close).mockImplementation((callback) => {
    callback();
    return server;
  });
  const factory = vi.fn((requestListener: RequestListener) => {
    listener = requestListener;
    return server;
  });
  return {
    factory,
    getListener() {
      if (listener === undefined) throw new Error("listener not installed");
      return listener;
    },
  };
}

function httpRequest(
  body: unknown,
  sessionId?: string,
  method = "POST",
  port = 4242,
): HttpRequestDouble {
  return {
    url: "/mcp",
    method,
    headers: {
      host: `127.0.0.1:${port}`,
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    },
    body,
  };
}

function httpResponse() {
  const headers = new Map<string, string>();
  let body = "";
  const response = {
    headersSent: false,
    statusCode: 200,
    setHeader: vi.fn((name: string, value: string) => {
      headers.set(name.toLowerCase(), value);
    }),
    getHeader: vi.fn((name: string) => headers.get(name.toLowerCase())),
    writeHead: vi.fn(),
    write: vi.fn((chunk: unknown) => {
      body += String(chunk);
      response.headersSent = true;
      return true;
    }),
    flushHeaders: vi.fn(),
    end: vi.fn((chunk?: unknown) => {
      if (chunk !== undefined) body += String(chunk);
      response.headersSent = true;
    }),
    body: () => body,
  };
  return response;
}

// The SDK's concrete HTTP transport depends on ServerResponse socket internals.
// This socket-free bridge still connects the real buildServer instance and
// forwards each parsed HTTP JSON-RPC message through the MCP Transport contract.
function bridgeTransportFactory() {
  let sessionSequence = 0;
  return vi.fn((options: StreamableHTTPServerTransportOptions) => {
    let responseResolver: ((message: JSONRPCMessage) => void) | undefined;
    const transport: Transport & {
      handleRequest(
        request: HttpRequestDouble,
        response: HttpResponseDouble,
        parsedBody?: unknown,
      ): Promise<void>;
    } = {
      start: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(async (message: JSONRPCMessage) => {
        responseResolver?.(message);
      }),
      async handleRequest(request, response, parsedBody) {
        if (request.method === "DELETE") {
          if (transport.sessionId !== undefined) {
            await options.onsessionclosed?.(transport.sessionId);
          }
          response.end();
          return;
        }
        const message = (parsedBody ?? request.body) as JSONRPCMessage;
        if (parsedBody !== undefined) {
          transport.sessionId = `audit-session-${++sessionSequence}`;
          await options.onsessioninitialized?.(transport.sessionId);
          response.setHeader("mcp-session-id", transport.sessionId);
        }
        if (!("id" in message)) {
          transport.onmessage?.(message);
          await new Promise((resolve) => setTimeout(resolve, 0));
          response.end();
          return;
        }
        const outgoing = new Promise<JSONRPCMessage>((resolve) => {
          responseResolver = resolve;
        });
        transport.onmessage?.(message);
        const result = await outgoing;
        responseResolver = undefined;
        response.end(JSON.stringify(result));
      },
    };
    return transport as never;
  });
}

async function dispatch(
  listener: RequestListener,
  request: HttpRequestDouble,
): Promise<HttpResponseDouble> {
  const response = httpResponse();
  listener(request as never, response as never);
  await vi.waitFor(() => expect(response.end).toHaveBeenCalledOnce());
  return response;
}

function parseRpcResult(response: HttpResponseDouble): Record<string, unknown> {
  return JSON.parse(response.body()) as Record<string, unknown>;
}

const initializeMessage = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "http-audit-test", version: "1.0.0" },
  },
};

describe("production HTTP dispatch auditing", () => {
  it("audits every configured-token lifecycle call on the shared sink", async () => {
    const http = httpFactoryHarness();
    const transportFactory = bridgeTransportFactory();
    const stderr: DiagnosticSink = { write: vi.fn().mockReturnValue(true) };
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const fetchMock = vi.fn<FetchLike>(async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/health") return Response.json({ status: "ok" });
      if (path === "/api/system/info")
        return Response.json({ version: "test" });
      throw new Error(`upstream failed ${tokenMarker}`);
    });
    const handle = await startHttpServer(
      parseConfig({ PORT: "4242", FUSION_TOKEN: tokenMarker }),
      {
        httpServerFactory: http.factory,
        httpTransportFactory: transportFactory,
        httpRequestBodyParser: async (request) =>
          (request as unknown as HttpRequestDouble).body,
        signalSource: { on: vi.fn(), off: vi.fn() },
        stderr: stderr as unknown as Pick<NodeJS.WriteStream, "write">,
        fetch: fetchMock,
      },
    );

    try {
      const listener = http.getListener();
      const initialized = await dispatch(
        listener,
        httpRequest(initializeMessage),
      );
      const sessionId = String(initialized.getHeader("mcp-session-id"));
      await dispatch(
        listener,
        httpRequest(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          sessionId,
        ),
      );
      const health = await dispatch(
        listener,
        httpRequest(
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "get_board_health", arguments: {} },
          },
          sessionId,
        ),
      );
      const invalid = await dispatch(
        listener,
        httpRequest(
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "get_task", arguments: { id: 42 } },
          },
          sessionId,
        ),
      );
      const unknown = await dispatch(
        listener,
        httpRequest(
          {
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: { name: "merge_pr", arguments: {} },
          },
          sessionId,
        ),
      );
      const upstream = await dispatch(
        listener,
        httpRequest(
          {
            jsonrpc: "2.0",
            id: 5,
            method: "tools/call",
            params: { name: "get_task", arguments: { id: "KB-034" } },
          },
          sessionId,
        ),
      );
      await dispatch(listener, httpRequest(undefined, sessionId, "DELETE"));

      expect(parseRpcResult(health)).toHaveProperty("result");
      expect(parseRpcResult(invalid)).toMatchObject({
        result: { isError: true },
      });
      expect(parseRpcResult(unknown)).toMatchObject({
        result: { isError: true },
      });
      expect(parseRpcResult(upstream)).toMatchObject({
        result: {
          isError: true,
          content: [
            {
              text: JSON.stringify({
                error: {
                  code: "upstream_error",
                  message: "Upstream request failed",
                },
              }),
            },
          ],
        },
      });
      const lines = stderr.write.mock.calls.map(([line]) => String(line));
      const audits = lines.filter((line) => line.includes(" tool="));
      expect(audits).toHaveLength(4);
      expect(
        audits.filter((line) => line.includes("tool=get_task")),
      ).toHaveLength(2);
      expect(audits).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^\[[^\]]+Z\] tool=get_board_health\n$/),
          expect.stringMatching(
            /^\[[^\]]+Z\] tool=get_task validation=failed\n$/,
          ),
          expect.stringMatching(/^\[[^\]]+Z\] tool=merge_pr unknown_tool\n$/),
          expect.stringMatching(
            /^\[[^\]]+Z\] tool=get_task id=KB-034 projectIdApplied=false\n$/,
          ),
        ]),
      );
      expect(lines).toContain(`fusion-mcp: session=${sessionId} event=init\n`);
      expect(lines).toContain(`fusion-mcp: session=${sessionId} event=close\n`);
      expect(lines.join("\n")).not.toContain(tokenMarker);
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      await handle.shutdown();
    }
  });

  it("audits a token-less authenticated call before fetch on the HTTP path", async () => {
    const http = httpFactoryHarness();
    const stderr: DiagnosticSink = { write: vi.fn().mockReturnValue(true) };
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const fetchMock = vi.fn<FetchLike>();
    const handle = await startHttpServer(parseConfig({ PORT: "4243" }), {
      httpServerFactory: http.factory,
      httpTransportFactory: bridgeTransportFactory(),
      httpRequestBodyParser: async (request) =>
        (request as unknown as HttpRequestDouble).body,
      signalSource: { on: vi.fn(), off: vi.fn() },
      stderr: stderr as unknown as Pick<NodeJS.WriteStream, "write">,
      fetch: fetchMock,
    });

    try {
      const listener = http.getListener();
      const initialized = await dispatch(
        listener,
        httpRequest(initializeMessage, undefined, "POST", 4243),
      );
      const sessionId = String(initialized.getHeader("mcp-session-id"));
      const result = await dispatch(
        listener,
        httpRequest(
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "list_tasks", arguments: {} },
          },
          sessionId,
          "POST",
          4243,
        ),
      );
      await dispatch(
        listener,
        httpRequest(undefined, sessionId, "DELETE", 4243),
      );

      expect(parseRpcResult(result)).toMatchObject({
        result: {
          isError: true,
          content: [
            {
              text: JSON.stringify({
                error: {
                  code: "missing_token",
                  message: "Authentication token is required",
                },
              }),
            },
          ],
        },
      });
      const lines = stderr.write.mock.calls.map(([line]) => String(line));
      expect(lines.filter((line) => line.includes(" tool="))).toEqual([
        expect.stringMatching(/^\[[^\]]+Z\] tool=list_tasks .*\n$/),
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(lines.join("\n")).not.toMatch(/authorization|stack/i);
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      await handle.shutdown();
    }
  });

  it("keeps injected-server runtime diagnostics on stderr without promising tool audits", async () => {
    const http = httpFactoryHarness();
    const stderr: DiagnosticSink = { write: vi.fn().mockReturnValue(true) };
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let sessionId: string | undefined;
    let transportOptions: StreamableHTTPServerTransportOptions | undefined;
    const transport = {
      close: vi.fn().mockResolvedValue(undefined),
      handleRequest: vi.fn(
        async (
          _request,
          response: HttpResponseDouble,
          parsedBody?: unknown,
        ) => {
          if (parsedBody !== undefined) {
            sessionId = "injected-session";
            await transportOptions?.onsessioninitialized?.(sessionId);
            response.setHeader("mcp-session-id", sessionId);
            response.end();
            return;
          }
          throw new Error("forced request failure");
        },
      ),
    };
    const dependencies: RuntimeDependencies = {
      httpServerFactory: http.factory,
      httpTransportFactory: vi.fn((options) => {
        transportOptions = options;
        return transport as never;
      }),
      httpRequestBodyParser: async (request) =>
        (request as unknown as HttpRequestDouble).body,
      serverFactory: vi.fn(() => ({
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      })),
      signalSource: { on: vi.fn(), off: vi.fn() },
      stderr: stderr as unknown as Pick<NodeJS.WriteStream, "write">,
    };
    const handle = await startHttpServer(
      parseConfig({ PORT: "4242" }),
      dependencies,
    );

    try {
      const listener = http.getListener();
      await dispatch(listener, httpRequest(initializeMessage));
      if (sessionId === undefined) throw new Error("session not initialized");
      await dispatch(
        listener,
        httpRequest({ jsonrpc: "2.0", id: 2 }, sessionId),
      );
      await handle.shutdown();

      const lines = stderr.write.mock.calls.map(([line]) => String(line));
      expect(lines).toContain(
        "fusion-mcp: session=injected-session event=init\n",
      );
      expect(lines).toContain("fusion-mcp: HTTP request failed\n");
      expect(lines).toContain(
        "fusion-mcp: session=injected-session event=close\n",
      );
      expect(lines.filter((line) => line.includes(" tool="))).toEqual([]);
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      await handle.shutdown();
    }
  });
});

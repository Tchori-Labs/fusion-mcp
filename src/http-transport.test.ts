import type { RequestListener } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { StreamableHTTPServerTransportOptions } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "./config.js";
import type { FetchLike } from "./fusion-client.js";
import {
  buildServer,
  startHttpServer,
  type HttpServerLike,
  type RuntimeDependencies,
  type SignalSource,
} from "./index.js";

const testConfig = parseConfig({
  PORT: "4242",
  FUSION_TOKEN: "test-secret-marker",
});

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "http-transport-test", version: "1.0.0" },
  },
};

function httpFactoryHarness() {
  let listener: RequestListener | undefined;
  const once = vi.fn();
  const listen = vi.fn();
  const close = vi.fn();
  const server = { once, listen, close } as unknown as HttpServerLike;
  once.mockReturnValue(server);
  listen.mockImplementation(
    (_port: number, _hostname: string, callback: () => void) => {
      callback();
      return server;
    },
  );
  close.mockImplementation((callback: (error?: Error) => void) => {
    callback();
    return server;
  });
  const factory = vi.fn((requestListener: RequestListener) => {
    listener = requestListener;
    return server;
  });

  return {
    factory,
    once,
    listen,
    close,
    getListener(): RequestListener {
      if (listener === undefined) {
        throw new Error("HTTP listener was not created");
      }
      return listener;
    },
  };
}

function signalSourceHarness() {
  const listeners = new Map<"SIGINT" | "SIGTERM", Set<() => void>>();
  const on = vi.fn(
    (signal: "SIGINT" | "SIGTERM", listener: () => void): SignalSource => {
      const signalListeners = listeners.get(signal) ?? new Set();
      signalListeners.add(listener);
      listeners.set(signal, signalListeners);
      return source;
    },
  );
  const off = vi.fn(
    (signal: "SIGINT" | "SIGTERM", listener: () => void): SignalSource => {
      listeners.get(signal)?.delete(listener);
      return source;
    },
  );
  const source: SignalSource = { on, off };

  return {
    source,
    on,
    off,
    emit(signal: "SIGINT" | "SIGTERM"): void {
      for (const listener of listeners.get(signal) ?? []) {
        listener();
      }
    },
  };
}

function request(
  method: string,
  headers: Record<string, string> = {},
  url = "/mcp",
) {
  return {
    url,
    method,
    headers: { host: "127.0.0.1:4242", ...headers },
  };
}

function response() {
  const result = {
    headersSent: false,
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  result.end.mockImplementation(() => {
    result.headersSent = true;
  });
  return result;
}

function statefulTransportHarness() {
  const transports: Array<{
    close: ReturnType<typeof vi.fn>;
    handleRequest: ReturnType<typeof vi.fn>;
    sessionId?: string;
  }> = [];
  const factory: NonNullable<RuntimeDependencies["httpTransportFactory"]> =
    vi.fn((options: StreamableHTTPServerTransportOptions) => {
      const close = vi.fn().mockResolvedValue(undefined);
      const state: (typeof transports)[number] = {
        close,
        handleRequest: vi.fn(
          async (incomingRequest, outgoingResponse, parsedBody?: unknown) => {
            if (parsedBody !== undefined) {
              const sessionId = options.sessionIdGenerator?.();
              if (sessionId === undefined) {
                throw new Error("stateful transport requires a session id");
              }
              state.sessionId = sessionId;
              await options.onsessioninitialized?.(sessionId);
              outgoingResponse.setHeader("mcp-session-id", sessionId);
              outgoingResponse.end();
              return;
            }

            if (incomingRequest.method === "DELETE") {
              if (state.sessionId === undefined) {
                throw new Error("session was not initialized");
              }
              await options.onsessionclosed?.(state.sessionId);
              await close();
            }
            outgoingResponse.end();
          },
        ),
      };
      transports.push(state);
      return state as never;
    });

  return { factory, transports };
}

function runtimeHarness(overrides: RuntimeDependencies = {}) {
  const http = httpFactoryHarness();
  const signals = signalSourceHarness();
  const transport = statefulTransportHarness();
  const servers: Array<{
    connect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const serverFactory = vi.fn(() => {
    const server = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    servers.push(server);
    return server;
  });
  const stderr = { write: vi.fn().mockReturnValue(true) };
  const bodyParser = vi.fn().mockResolvedValue(initializeRequest);

  const dependencies: RuntimeDependencies = {
    httpServerFactory: http.factory,
    httpTransportFactory: transport.factory,
    httpRequestBodyParser: bodyParser,
    serverFactory,
    signalSource: signals.source,
    stderr,
    ...overrides,
  };

  return {
    dependencies,
    http,
    signals,
    transport,
    servers,
    serverFactory,
    stderr,
    bodyParser,
  };
}

async function initializeSession(
  runtime: ReturnType<typeof runtimeHarness>,
): Promise<string> {
  const initializationResponse = response();
  runtime.http.getListener()(
    request("POST") as never,
    initializationResponse as never,
  );
  await vi.waitFor(() =>
    expect(initializationResponse.end).toHaveBeenCalledOnce(),
  );

  const sessionId = runtime.transport.transports[0]?.sessionId;
  if (sessionId === undefined) {
    throw new Error("session was not initialized");
  }
  return sessionId;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session-aware Streamable HTTP transport", () => {
  it("creates one session and reuses it for POST, GET, and DELETE", async () => {
    const runtime = runtimeHarness();
    const handle = await startHttpServer(testConfig, runtime.dependencies);

    try {
      const sessionId = await initializeSession(runtime);
      const followUpResponse = response();
      const getResponse = response();
      const deleteResponse = response();

      runtime.http.getListener()(
        request("POST", { "mcp-session-id": sessionId }) as never,
        followUpResponse as never,
      );
      runtime.http.getListener()(
        request("GET", { "mcp-session-id": sessionId }) as never,
        getResponse as never,
      );
      runtime.http.getListener()(
        request("DELETE", { "mcp-session-id": sessionId }) as never,
        deleteResponse as never,
      );

      await vi.waitFor(() => {
        expect(followUpResponse.end).toHaveBeenCalledOnce();
        expect(getResponse.end).toHaveBeenCalledOnce();
        expect(deleteResponse.end).toHaveBeenCalledOnce();
      });

      expect(runtime.serverFactory).toHaveBeenCalledOnce();
      expect(runtime.transport.factory).toHaveBeenCalledOnce();
      expect(runtime.bodyParser).toHaveBeenCalledOnce();
      expect(
        runtime.transport.transports[0]?.handleRequest,
      ).toHaveBeenCalledTimes(4);
      expect(
        runtime.transport.transports[0]?.handleRequest,
      ).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        expect.anything(),
        initializeRequest,
      );
      expect(
        runtime.transport.transports[0]?.handleRequest,
      ).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ method: "GET" }),
        getResponse,
      );
      expect(
        runtime.transport.transports[0]?.handleRequest,
      ).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({ method: "DELETE" }),
        deleteResponse,
      );
      expect(runtime.transport.transports[0]?.close).toHaveBeenCalledOnce();
      expect(runtime.servers[0]?.close).toHaveBeenCalledOnce();

      const postDeleteResponse = response();
      runtime.http.getListener()(
        request("POST", { "mcp-session-id": sessionId }) as never,
        postDeleteResponse as never,
      );
      await vi.waitFor(() =>
        expect(postDeleteResponse.end).toHaveBeenCalledOnce(),
      );
      expect(postDeleteResponse.statusCode).toBe(404);
      expect(runtime.serverFactory).toHaveBeenCalledOnce();
    } finally {
      await handle.shutdown();
    }
  });

  it("rejects unknown and missing session ids without constructing a session", async () => {
    const runtime = runtimeHarness();
    const handle = await startHttpServer(testConfig, runtime.dependencies);

    try {
      const unknownResponse = response();
      const missingResponse = response();
      runtime.http.getListener()(
        request("GET", { "mcp-session-id": "unknown-session" }) as never,
        unknownResponse as never,
      );
      runtime.http.getListener()(
        request("GET") as never,
        missingResponse as never,
      );

      await vi.waitFor(() => {
        expect(unknownResponse.end).toHaveBeenCalledOnce();
        expect(missingResponse.end).toHaveBeenCalledOnce();
      });
      expect(unknownResponse.statusCode).toBe(404);
      expect(missingResponse.statusCode).toBe(400);
      expect(runtime.serverFactory).not.toHaveBeenCalled();
      expect(runtime.transport.factory).not.toHaveBeenCalled();
      expect(runtime.bodyParser).not.toHaveBeenCalled();
    } finally {
      await handle.shutdown();
    }
  });

  it("rejects session-less non-initialize POST requests", async () => {
    const bodyParser = vi.fn().mockResolvedValue({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const runtime = runtimeHarness({ httpRequestBodyParser: bodyParser });
    const handle = await startHttpServer(testConfig, runtime.dependencies);

    try {
      const rejectedResponse = response();
      runtime.http.getListener()(
        request("POST") as never,
        rejectedResponse as never,
      );

      await vi.waitFor(() =>
        expect(rejectedResponse.end).toHaveBeenCalledOnce(),
      );
      expect(rejectedResponse.statusCode).toBe(400);
      expect(runtime.serverFactory).not.toHaveBeenCalled();
      expect(runtime.transport.factory).not.toHaveBeenCalled();
    } finally {
      await handle.shutdown();
    }
  });

  it("accepts the loopback Host and rejects a foreign Host before construction", async () => {
    const runtime = runtimeHarness();
    const handle = await startHttpServer(testConfig, runtime.dependencies);

    try {
      await initializeSession(runtime);
      const rejectedResponse = response();
      const foreignRequest = request("POST");
      foreignRequest.headers.host = "attacker.invalid";
      runtime.http.getListener()(
        foreignRequest as never,
        rejectedResponse as never,
      );

      await vi.waitFor(() => expect(rejectedResponse.end).toHaveBeenCalled());
      expect(rejectedResponse.statusCode).toBe(403);
      expect(runtime.transport.factory).toHaveBeenCalledOnce();
      expect(runtime.transport.factory).toHaveBeenCalledWith(
        expect.objectContaining({
          enableJsonResponse: true,
          enableDnsRebindingProtection: true,
          allowedHosts: ["127.0.0.1:4242"],
          sessionIdGenerator: expect.any(Function),
          onsessioninitialized: expect.any(Function),
          onsessionclosed: expect.any(Function),
        }),
      );
    } finally {
      await handle.shutdown();
    }
  });

  it("closes every session and the listener once during idempotent shutdown", async () => {
    const runtime = runtimeHarness();
    const handle = await startHttpServer(testConfig, runtime.dependencies);
    await initializeSession(runtime);
    await initializeSession(runtime);

    const firstShutdown = handle.shutdown();
    const secondShutdown = handle.shutdown();
    expect(secondShutdown).toBe(firstShutdown);
    await Promise.all([firstShutdown, secondShutdown]);

    expect(runtime.http.close).toHaveBeenCalledOnce();
    expect(runtime.transport.transports).toHaveLength(2);
    for (const session of runtime.transport.transports) {
      expect(session.close).toHaveBeenCalledOnce();
    }
    for (const server of runtime.servers) {
      expect(server.close).toHaveBeenCalledOnce();
    }
    expect(runtime.signals.off).toHaveBeenCalledTimes(2);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "gracefully shuts down and sets a clean exit code on %s",
    async (signal) => {
      const setExitCode = vi.fn();
      const runtime = runtimeHarness({ setExitCode });
      await startHttpServer(testConfig, runtime.dependencies);
      await initializeSession(runtime);

      runtime.signals.emit(signal);

      await vi.waitFor(() => expect(setExitCode).toHaveBeenCalledWith(0));
      expect(runtime.http.close).toHaveBeenCalledOnce();
      expect(runtime.transport.transports[0]?.close).toHaveBeenCalledOnce();
      expect(runtime.servers[0]?.close).toHaveBeenCalledOnce();
    },
  );

  it("logs secret-free session lifecycle events", async () => {
    const runtime = runtimeHarness();
    const handle = await startHttpServer(testConfig, runtime.dependencies);
    const sessionId = await initializeSession(runtime);

    await handle.shutdown();

    expect(runtime.stderr.write).toHaveBeenCalledWith(
      `fusion-mcp: session=${sessionId} event=init\n`,
    );
    expect(runtime.stderr.write).toHaveBeenCalledWith(
      `fusion-mcp: session=${sessionId} event=close\n`,
    );
    expect(JSON.stringify(runtime.stderr.write.mock.calls)).not.toContain(
      "test-secret-marker",
    );
  });

  it("keeps catalogue listing and tool-call auditing transport-independent", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ status: "ok" }));
    const server = buildServer(parseConfig({}), { fetch: fetchMock });
    const client = new Client({ name: "http-audit-test", version: "1.0.0" });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toEqual([
        "get_board_health",
        "list_tasks",
        "get_task",
        "get_task_logs",
        "get_task_workflow_results",
        "list_projects",
        "read_project_settings",
        "create_task",
        "comment_task",
        "steer_task",
        "pause_task",
        "unpause_task",
        "list_approvals",
        "get_approval",
        "list_missions",
        "get_mission",
        "move_task",
        "update_project_settings",
        "update_task",
        "archive_task",
      ]);

      await client.callTool({ name: "get_board_health", arguments: {} });
      expect(stderr).toHaveBeenCalledWith(
        expect.stringMatching(/ tool=get_board_health\n$/),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});

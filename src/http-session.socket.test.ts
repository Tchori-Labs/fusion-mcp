import dns from "node:dns";
import { createServer, type Server } from "node:http";
import net from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";
import {
  startHttpServer,
  type HttpServerHandle,
  type SignalSource,
} from "./index.js";
import { reserveLoopbackPort, waitForCondition } from "./live/live-harness.js";
import { LoopbackNetworkError } from "./test-setup/loopback-guard.js";

const expectedTools = [
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
];

const inertSignalSource: SignalSource = {
  on: () => undefined,
  off: () => undefined,
};

let httpHandle: HttpServerHandle | undefined;
let fusionStub: Server | undefined;
const clients: Client[] = [];

async function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function startFusionStub(
  requests: string[],
): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? "UNKNOWN"} ${request.url ?? ""}`);
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/api/health") {
      response.end(JSON.stringify({ status: "ok", source: "mock" }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/system/info") {
      response.end(JSON.stringify({ version: "test" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("mock Fusion did not receive a TCP port");
  }
  return { server, port: address.port };
}

function requireSessionId(transport: StreamableHTTPClientTransport): string {
  const sessionId = transport.sessionId;
  if (sessionId === undefined || sessionId === "") {
    throw new Error("HTTP initialization did not issue a session id");
  }
  return sessionId;
}

function resultPayload(result: unknown): unknown {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error("tool result has no content array");
  }
  const first: unknown = result.content[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("text" in first) ||
    typeof first.text !== "string"
  ) {
    throw new Error("tool result has no text content");
  }
  return JSON.parse(first.text) as unknown;
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close().catch(() => undefined);
  }
  await httpHandle?.shutdown().catch(() => undefined);
  httpHandle = undefined;
  await closeServer(fusionStub);
  fusionStub = undefined;
});

describe("real Streamable HTTP session lifecycle", () => {
  it("creates, reuses, isolates, terminates, and shuts down sessions", async () => {
    expect(() => net.connect(80, "203.0.113.1")).toThrow(LoopbackNetworkError);
    expect(() => dns.lookup("example.invalid", () => undefined)).toThrow(
      LoopbackNetworkError,
    );

    const upstreamRequests: string[] = [];
    const stub = await startFusionStub(upstreamRequests);
    fusionStub = stub.server;
    const port = await reserveLoopbackPort();
    const stderrLines: string[] = [];
    const config = parseConfig({
      PORT: String(port),
      FUSION_BASE_URL: `http://127.0.0.1:${stub.port}`,
      FUSION_TOKEN: "socket-test-value",
    });
    httpHandle = await startHttpServer(config, {
      env: {},
      signalSource: inertSignalSource,
      stderr: {
        write: (line) => {
          stderrLines.push(String(line));
          return true;
        },
      },
    });
    const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);

    const missingSession = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(missingSession.status).toBe(400);
    const unknownSession = await fetch(endpoint, {
      method: "POST",
      headers: { "mcp-session-id": "unknown-session" },
    });
    expect(unknownSession.status).toBe(404);
    expect((await fetch(new URL("/not-mcp", endpoint))).status).toBe(404);
    expect(stderrLines.filter((line) => line.includes("event=init"))).toEqual(
      [],
    );

    const firstTransport = new StreamableHTTPClientTransport(endpoint);
    const firstClient = new Client({ name: "socket-client-one", version: "1" });
    clients.push(firstClient);
    await firstClient.connect(firstTransport as Transport);
    const firstSessionId = requireSessionId(firstTransport);
    await waitForCondition(
      () =>
        stderrLines.join("").includes(`session=${firstSessionId} event=init`),
      "first session initialization",
    );

    const tools = await firstClient.listTools();
    expect(tools.tools.map(({ name }) => name)).toEqual(expectedTools);
    expect(firstTransport.sessionId).toBe(firstSessionId);
    const firstHealth = await firstClient.callTool({
      name: "get_board_health",
      arguments: {},
    });
    const secondHealth = await firstClient.callTool({
      name: "get_board_health",
      arguments: {},
    });
    expect(resultPayload(firstHealth)).toEqual({
      health: { status: "ok", source: "mock" },
      systemInfo: { version: "test" },
    });
    expect(resultPayload(secondHealth)).toEqual(resultPayload(firstHealth));
    expect(firstTransport.sessionId).toBe(firstSessionId);
    expect(
      upstreamRequests.filter((request) => request === "GET /api/health"),
    ).toHaveLength(2);
    expect(
      upstreamRequests.filter((request) => request === "GET /api/system/info"),
    ).toHaveLength(2);

    const secondTransport = new StreamableHTTPClientTransport(endpoint);
    const secondClient = new Client({
      name: "socket-client-two",
      version: "1",
    });
    clients.push(secondClient);
    await secondClient.connect(secondTransport as Transport);
    const secondSessionId = requireSessionId(secondTransport);
    expect(secondSessionId).not.toBe(firstSessionId);
    await expect(firstClient.listTools()).resolves.toBeDefined();
    await expect(secondClient.listTools()).resolves.toBeDefined();

    const getResponse = await fetch(endpoint, {
      headers: {
        accept: "application/json",
        "mcp-session-id": secondSessionId,
      },
    });
    // JSON response mode applies to POSTs; a GET still negotiates SSE and
    // rejects a client that does not advertise text/event-stream.
    expect(getResponse.status).toBe(406);

    await firstTransport.terminateSession();
    expect(firstTransport.sessionId).toBeUndefined();
    await waitForCondition(
      () =>
        stderrLines.join("").includes(`session=${firstSessionId} event=close`),
      "first session close",
    );
    const staleSession = await fetch(endpoint, {
      method: "POST",
      headers: { "mcp-session-id": firstSessionId },
    });
    expect(staleSession.status).toBe(404);
    expect(await staleSession.json()).toMatchObject({
      error: { message: "Session not found" },
    });
    await expect(secondClient.listTools()).resolves.toBeDefined();

    const firstShutdown = httpHandle.shutdown();
    const secondShutdown = httpHandle.shutdown();
    await expect(Promise.all([firstShutdown, secondShutdown])).resolves.toEqual(
      [undefined, undefined],
    );
    await waitForCondition(
      () =>
        stderrLines.join("").includes(`session=${secondSessionId} event=close`),
      "second session close during shutdown",
    );
    await expect(fetch(endpoint)).rejects.toThrow();
  });
});

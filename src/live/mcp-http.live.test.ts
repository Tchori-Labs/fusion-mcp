import { access } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { expect, it } from "vitest";

import {
  describeLive,
  liveChildEnvironment,
  liveIterations,
  redactToken,
  reserveLoopbackPort,
  spawnCapturedProcess,
  waitForChildExit,
  waitForCondition,
  waitForLoopbackListener,
  writeFailureTrace,
} from "./live-harness.js";

const serverEntryPoint = "dist/index.js";
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
];

function assertTokenAbsent(label: string, text: string, token: string): void {
  if (text.includes(token)) {
    throw new Error(`FUSION_TOKEN appeared in captured ${label}`);
  }
}

function assertHealthResult(result: unknown): void {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error("get_board_health returned no MCP content array");
  }
  const first: unknown = result.content[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("type" in first) ||
    first.type !== "text" ||
    !("text" in first) ||
    typeof first.text !== "string"
  ) {
    throw new Error("get_board_health did not return text content");
  }
  const parsed: unknown = JSON.parse(first.text);
  if (typeof parsed !== "object" || parsed === null || !("health" in parsed)) {
    throw new Error("get_board_health text did not contain a health field");
  }
}

function safeError(error: unknown): string {
  return redactToken(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
}

describeLive("live MCP Streamable HTTP transport", () => {
  it("reuses sessions, terminates them, audits, and shuts down gracefully", async () => {
    try {
      await access(serverEntryPoint);
    } catch {
      throw new Error(
        "dist/index.js is missing; run `pnpm build` before `pnpm test:live`",
      );
    }
    const token = process.env.FUSION_TOKEN;
    if (token === undefined || token.trim() === "") {
      throw new Error("live suite gate allowed an empty FUSION_TOKEN");
    }

    const port = await reserveLoopbackPort();
    const server = spawnCapturedProcess(
      process.execPath,
      [serverEntryPoint, "--http"],
      liveChildEnvironment({ PORT: String(port) }),
    );
    let failure: unknown;
    let gracefulExit = false;

    try {
      await waitForLoopbackListener(port, server.child);
      const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);

      for (let iteration = 1; iteration <= liveIterations(); iteration += 1) {
        const transport = new StreamableHTTPClientTransport(endpoint);
        const client = new Client({
          name: "fusion-mcp-live-http",
          version: "1.0.0",
        });
        let sessionId: string | undefined;

        try {
          // SDK 1.29's getter is `string | undefined`, while its Transport
          // interface models the same value as an exact optional property.
          await client.connect(transport as Transport);
          sessionId = transport.sessionId;
          if (sessionId === undefined || sessionId === "") {
            throw new Error(
              "HTTP initialization did not issue an mcp-session-id",
            );
          }
          await waitForCondition(
            () => server.stderr().includes(`session=${sessionId} event=init`),
            `HTTP session ${sessionId} initialization diagnostic`,
          );

          const tools = await client.listTools();
          expect(tools.tools.map(({ name }) => name)).toEqual(expectedTools);
          if (transport.sessionId !== sessionId) {
            throw new Error(
              "HTTP session changed between initialize and tools/list",
            );
          }

          const firstHealth = await client.callTool({
            name: "get_board_health",
            arguments: {},
          });
          assertHealthResult(firstHealth);
          if (transport.sessionId !== sessionId) {
            throw new Error(
              "HTTP session changed after the first governed call",
            );
          }

          const secondHealth = await client.callTool({
            name: "get_board_health",
            arguments: {},
          });
          assertHealthResult(secondHealth);
          if (transport.sessionId !== sessionId) {
            throw new Error(
              "HTTP session was not reused for the second governed call",
            );
          }

          await transport.terminateSession();
          if (transport.sessionId !== undefined) {
            throw new Error(
              "HTTP transport retained its session after DELETE teardown",
            );
          }
          await waitForCondition(
            () => server.stderr().includes(`session=${sessionId} event=close`),
            `HTTP session ${sessionId} close diagnostic`,
          );
        } finally {
          if (transport.sessionId !== undefined) {
            await transport.terminateSession().catch(() => undefined);
          }
          await client.close().catch(() => transport.close());
        }
      }

      await waitForCondition(
        () =>
          server
            .stderr()
            .split("\n")
            .filter((line) => line.includes("tool=get_board_health")).length >=
          liveIterations() * 2,
        "HTTP health audit lines",
      );

      const shutdownTransport = new StreamableHTTPClientTransport(endpoint);
      const shutdownClient = new Client({
        name: "fusion-mcp-live-http-shutdown",
        version: "1.0.0",
      });
      try {
        await shutdownClient.connect(shutdownTransport as Transport);
        const shutdownSessionId = shutdownTransport.sessionId;
        if (shutdownSessionId === undefined || shutdownSessionId === "") {
          throw new Error(
            "graceful-shutdown probe did not receive a session id",
          );
        }
        await waitForCondition(
          () =>
            server.stderr().includes(`session=${shutdownSessionId} event=init`),
          `shutdown session ${shutdownSessionId} initialization diagnostic`,
        );

        if (!server.child.kill("SIGTERM")) {
          throw new Error(
            "could not send SIGTERM to the HTTP MCP server child",
          );
        }
        const exit = await waitForChildExit(server.child);
        if (exit.code !== 0 || exit.signal !== null) {
          throw new Error("HTTP MCP server did not exit cleanly after SIGTERM");
        }
        gracefulExit = true;
        if (
          !server.stderr().includes(`session=${shutdownSessionId} event=close`)
        ) {
          throw new Error(
            "SIGTERM did not log closure of the active HTTP session",
          );
        }
      } finally {
        await shutdownClient.close().catch(() => shutdownTransport.close());
      }

      if (server.stdout() !== "") {
        throw new Error(
          "HTTP server wrote protocol or diagnostic noise to stdout",
        );
      }
      if (!server.stderr().includes("tool=get_board_health")) {
        throw new Error(
          "get_board_health audit line was absent from HTTP stderr",
        );
      }
      assertTokenAbsent("HTTP stdout", server.stdout(), token);
      assertTokenAbsent("HTTP stderr", server.stderr(), token);
    } catch (error) {
      failure = error;
    } finally {
      if (
        !gracefulExit &&
        server.child.exitCode === null &&
        server.child.signalCode === null
      ) {
        server.child.kill("SIGTERM");
        try {
          await waitForChildExit(server.child, 2_000);
        } catch {
          server.child.kill("SIGKILL");
          await waitForChildExit(server.child, 2_000).catch(() => undefined);
        }
      }
    }

    if (failure !== undefined) {
      const path = await writeFailureTrace(
        "http-journey",
        server.stdout(),
        `${server.stderr()}\n--- failure ---\n${safeError(failure)}`,
      );
      throw new Error(
        `HTTP live journey failed; inspect redacted trace: ${path}`,
      );
    }
  });
});

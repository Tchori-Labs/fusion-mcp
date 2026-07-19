import { access } from "node:fs/promises";
import type { Readable } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";

import {
  describeLive,
  liveChildEnvironment,
  liveIterations,
  redactToken,
  waitForCondition,
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
];

interface StdioProcessInternals {
  _process?: { stdout: Readable | null };
}

class CapturingStdioClientTransport extends StdioClientTransport {
  readonly stdoutChunks: Buffer[] = [];

  override async start(): Promise<void> {
    await super.start();
    const child = (this as unknown as StdioProcessInternals)._process;
    if (child?.stdout === null || child?.stdout === undefined) {
      throw new Error("stdio transport did not expose the spawned server stdout");
    }
    child.stdout.on("data", (chunk: Buffer | string) => {
      this.stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
  }

  capturedStdout(): string {
    return Buffer.concat(this.stdoutChunks).toString("utf8");
  }
}

function assertTokenAbsent(label: string, text: string, token: string): void {
  if (text.includes(token)) {
    throw new Error(`FUSION_TOKEN appeared in captured ${label}`);
  }
}

function parseHealthResult(result: unknown): unknown {
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
  return parsed;
}

function safeError(error: unknown): string {
  return redactToken(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

describeLive("live MCP stdio transport", () => {
  it("repeats initialize, catalogue, health, audit, and teardown", async () => {
    try {
      await access(serverEntryPoint);
    } catch {
      throw new Error("dist/index.js is missing; run `pnpm build` before `pnpm test:live`");
    }
    const token = process.env.FUSION_TOKEN;
    if (token === undefined || token.trim() === "") {
      throw new Error("live suite gate allowed an empty FUSION_TOKEN");
    }

    for (let iteration = 1; iteration <= liveIterations(); iteration += 1) {
      const transport = new CapturingStdioClientTransport({
        command: process.execPath,
        args: [serverEntryPoint, "--stdio"],
        env: liveChildEnvironment(),
        stderr: "pipe",
      });
      const stderrChunks: Buffer[] = [];
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      const capturedStderr = (): string => Buffer.concat(stderrChunks).toString("utf8");
      const client = new Client({ name: "fusion-mcp-live-stdio", version: "1.0.0" });
      let failure: unknown;

      try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.map(({ name }) => name)).toEqual(expectedTools);

        const result = await client.callTool({
          name: "get_board_health",
          arguments: {},
        });
        parseHealthResult(result);
        await waitForCondition(
          () => capturedStderr().includes("tool=get_board_health"),
          "stdio health audit line",
        );

        const stdout = transport.capturedStdout();
        const stderr = capturedStderr();
        if (stdout.includes("tool=")) {
          throw new Error("audit or diagnostic output appeared on stdio stdout");
        }
        if (!stderr.includes("tool=get_board_health")) {
          throw new Error("get_board_health audit line was absent from stdio stderr");
        }
        assertTokenAbsent("stdio stdout", stdout, token);
        assertTokenAbsent("stdio stderr", stderr, token);
      } catch (error) {
        failure = error;
      } finally {
        try {
          await client.close();
        } catch (error) {
          failure ??= error;
          await transport.close().catch(() => undefined);
        }
      }

      if (failure !== undefined) {
        const path = await writeFailureTrace(
          `stdio-iteration-${iteration}`,
          transport.capturedStdout(),
          `${capturedStderr()}\n--- failure ---\n${safeError(failure)}`,
        );
        throw new Error(
          `stdio live iteration ${iteration} failed; inspect redacted trace: ${path}`,
        );
      }
    }
  });
});

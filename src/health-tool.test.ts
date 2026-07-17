import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseConfig, type Config } from "./config.js";
import type { FetchLike } from "./fusion-client.js";
import { buildServer } from "./index.js";

async function createHarness(config: Config, fetch: FetchLike) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(config, { fetch });
  const client = new Client({ name: "fusion-mcp-test", version: "1.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    server,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function textResult(result: unknown): unknown {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error("expected tool result content");
  }
  const content: unknown = result.content[0];
  if (
    typeof content !== "object" ||
    content === null ||
    !("type" in content) ||
    content.type !== "text" ||
    !("text" in content) ||
    typeof content.text !== "string"
  ) {
    throw new Error("expected a text tool result");
  }
  return JSON.parse(content.text) as unknown;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("get_board_health", () => {
  it("registers exactly the implemented governed tools", async () => {
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(parseConfig({}), fetchMock);

    try {
      const tools = await harness.client.listTools();
      expect(tools.tools.map(({ name }) => name)).toEqual([
        "get_board_health",
        "get_task",
        "get_task_logs",
        "get_task_workflow_results",
        "list_projects",
        "read_project_settings",
        "list_tasks",
        "create_task",
        "pause_task",
        "unpause_task",
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("returns health without requiring or sending a token", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ status: "ok" }));
    const harness = await createHarness(parseConfig({}), fetchMock);

    try {
      const result = await harness.client.callTool({
        name: "get_board_health",
        arguments: {},
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({ health: { status: "ok" } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      expect(headers.has("authorization")).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("includes best-effort authenticated system information", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(Response.json({ status: "ok" }))
      .mockResolvedValueOnce(Response.json({ version: "2.0", agents: 3 }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: "test-secret-marker" }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "get_board_health",
        arguments: {},
      });

      expect(textResult(result)).toEqual({
        health: { status: "ok" },
        systemInfo: { version: "2.0", agents: 3 },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(
        false,
      );
      expect(
        new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("authorization"),
      ).toBe("Bearer test-secret-marker");
    } finally {
      await harness.close();
    }
  });

  it("keeps health successful when authenticated system info fails", async () => {
    const marker = "unsafe-upstream-marker";
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(Response.json({ status: "ok" }))
      .mockResolvedValueOnce(new Response(marker, { status: 500 }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: "test-secret-marker" }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "get_board_health",
        arguments: {},
      });
      const rendered = JSON.stringify(result);

      expect(textResult(result)).toEqual({
        health: { status: "ok" },
        systemInfo: { available: false },
      });
      expect(rendered).not.toContain(marker);
      expect(rendered).not.toContain("test-secret-marker");
    } finally {
      await harness.close();
    }
  });

  it("reports a health failure as a tool error", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response("unavailable", { status: 503 }));
    const harness = await createHarness(parseConfig({}), fetchMock);

    try {
      const result = await harness.client.callTool({
        name: "get_board_health",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("unavailable");
    } finally {
      await harness.close();
    }
  });

  it("writes exactly one timestamped stderr audit line per invocation", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ status: "ok" }));
    const harness = await createHarness(parseConfig({}), fetchMock);

    try {
      await harness.client.callTool({ name: "get_board_health", arguments: {} });
      await harness.client.callTool({ name: "get_board_health", arguments: {} });

      expect(stderr).toHaveBeenCalledTimes(2);
      for (const call of stderr.mock.calls) {
        expect(call[0]).toMatch(
          /^\[\d{4}-\d{2}-\d{2}T[^\]]+Z\] tool=get_board_health\n$/,
        );
      }
    } finally {
      await harness.close();
    }
  });
});

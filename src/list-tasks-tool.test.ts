import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function requestedUrl(fetchMock: ReturnType<typeof vi.fn<FetchLike>>): URL {
  const value = fetchMock.mock.calls[0]?.[0];
  if (value === undefined) {
    throw new Error("expected fetch to be called");
  }
  return new URL(value);
}

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("list_tasks", () => {
  it("returns an empty default page and drops undefined filters", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json([]));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: "fake-token-marker" }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "list_tasks",
        arguments: {},
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({
        tasks: [],
        pagination: { limit: 50, offset: 0 },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
      const url = requestedUrl(fetchMock);
      expect(url.pathname).toBe("/api/tasks");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        limit: "50",
        offset: "0",
      });
    } finally {
      await harness.close();
    }
  });

  it("returns a compact full page and forwards explicit project and task filters", async () => {
    const tasks = [
      {
        id: "FN-101",
        title: "First",
        column: "todo",
        priority: "high",
        status: "pending",
        projectId: "explicit-project",
        workflowId: "coding",
      },
      { id: "FN-102", title: "Second", column: "todo" },
    ];
    const upstreamTasks = tasks.map((task) => ({
      ...task,
      description: "full task body must not be exposed",
      internalSchedulerState: { runId: "internal-marker" },
    }));
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json(upstreamTasks));
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: "fake-token-marker",
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "list_tasks",
        arguments: {
          projectId: "explicit-project",
          limit: 2,
          offset: 4,
          q: "sensitive-search-marker",
          column: "todo",
          includeArchived: true,
        },
      });

      expect(textResult(result)).toEqual({
        tasks,
        pagination: { limit: 2, offset: 4 },
      });
      expect(JSON.stringify(textResult(result))).not.toContain("internal-marker");
      expect(JSON.stringify(textResult(result))).not.toContain(
        "full task body must not be exposed",
      );
      expect(Object.fromEntries(requestedUrl(fetchMock).searchParams)).toEqual({
        projectId: "explicit-project",
        limit: "2",
        offset: "4",
        q: "sensitive-search-marker",
        column: "todo",
        includeArchived: "true",
      });
      const auditOutput = vi
        .mocked(process.stderr.write)
        .mock.calls.map(([line]) => String(line))
        .join("");
      expect(auditOutput).toContain(
        "tool=list_tasks column=todo limit=2 offset=4 projectIdApplied=true includeArchived=true",
      );
      expect(auditOutput).not.toContain("sensitive-search-marker");
      expect(auditOutput).not.toContain("explicit-project");
      expect(auditOutput).not.toContain("fake-token-marker");
    } finally {
      await harness.close();
    }
  });

  it("uses the configured default project for an offset beyond range", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json([]));
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: "fake-token-marker",
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "list_tasks",
        arguments: { offset: 10_000 },
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({
        tasks: [],
        pagination: { limit: 50, offset: 10_000 },
      });
      expect(Object.fromEntries(requestedUrl(fetchMock).searchParams)).toEqual({
        projectId: "default-project",
        limit: "50",
        offset: "10000",
      });
    } finally {
      await harness.close();
    }
  });

  it.each([
    ["zero limit", { limit: 0 }],
    ["negative limit", { limit: -1 }],
    ["non-integer limit", { limit: 1.5 }],
    ["limit above maximum", { limit: 201 }],
    ["negative offset", { offset: -1 }],
    ["non-integer offset", { offset: 1.5 }],
    ["unsafe offset", { offset: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects %s before making a request", async (_name, arguments_) => {
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: "fake-token-marker" }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "list_tasks",
        arguments: arguments_,
      });

      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(process.stderr.write).toHaveBeenCalledTimes(1);
      const auditOutput = String(
        vi.mocked(process.stderr.write).mock.calls[0]?.[0],
      );
      expect(auditOutput).toMatch(
        /^\[[^\]]+\] tool=list_tasks validation=failed\n$/,
      );
      expect(auditOutput).not.toContain("fake-token-marker");
      expect(auditOutput).not.toContain(JSON.stringify(arguments_));
    } finally {
      await harness.close();
    }
  });

  it("rejects a malformed upstream task list without exposing its payload", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ tasks: ["malformed-marker"] }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: "fake-token-marker" }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "list_tasks",
        arguments: {},
      });
      const rendered = JSON.stringify(result);

      expect(result.isError).toBe(true);
      expect(rendered).toContain("Upstream returned an invalid payload");
      expect(rendered).not.toContain("malformed-marker");
      expect(rendered).not.toContain("fake-token-marker");
    } finally {
      await harness.close();
    }
  });

  it("surfaces an upstream FusionError without exposing response or token data", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(
        new Response("unsafe-upstream-marker", { status: 500 }),
      );
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: "fake-token-marker" }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "list_tasks",
        arguments: {},
      });
      const rendered = JSON.stringify(result);

      expect(result.isError).toBe(true);
      expect(rendered).toContain("Upstream request failed");
      expect(rendered).not.toContain("unsafe-upstream-marker");
      expect(rendered).not.toContain("fake-token-marker");
    } finally {
      await harness.close();
    }
  });
});

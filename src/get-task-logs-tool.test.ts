import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig, type Config, type Environment } from "./config.js";
import type { FetchLike } from "./fusion-client.js";
import { buildServer } from "./index.js";

const secretMarker = "distinctive-fake-secret-marker";

async function createHarness(config: Config, fetch: FetchLike) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = buildServer(config, { fetch });
  const client = new Client({ name: "fusion-mcp-test", version: "1.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
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
  const url = fetchMock.mock.calls[0]?.[0];
  if (url === undefined) {
    throw new Error("expected fetch to be called");
  }
  return new URL(url);
}

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("get_task_logs", () => {
  it("returns logs with parsed pagination headers and explicit bounds", async () => {
    const logs = [
      { id: 1, message: "started" },
      { id: 2, message: "continued" },
    ];
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      Response.json(logs, {
        headers: { "X-Total-Count": "12", "X-Has-More": "false" },
      }),
    );
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "get_task_logs",
        arguments: { id: "FN-200", limit: 2, offset: 4 },
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({
        logs,
        pagination: { total: 12, hasMore: false, limit: 2, offset: 4 },
      });
      const url = requestedUrl(fetchMock);
      expect(url.pathname).toBe("/api/tasks/FN-200/logs");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        limit: "2",
        offset: "4",
      });
      expect(url.searchParams.has("projectId")).toBe(false);
      const auditOutput = vi
        .mocked(process.stderr.write)
        .mock.calls.map(([line]) => String(line))
        .join("");
      expect(auditOutput).toContain(
        "tool=get_task_logs id=FN-200 limit=2 offset=4",
      );
      expect(auditOutput).not.toContain(secretMarker);
      expect(JSON.stringify(result)).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });

  it.each([
    {
      label: "explicit project over configured default",
      env: {
        FUSION_TOKEN: secretMarker,
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      },
      arguments: { id: "FN-201", projectId: "explicit-project" },
      expectedProjectId: "explicit-project",
    },
    {
      label: "configured default project",
      env: {
        FUSION_TOKEN: secretMarker,
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      },
      arguments: { id: "FN-201" },
      expectedProjectId: "default-project",
    },
    {
      label: "server default project",
      env: { FUSION_TOKEN: secretMarker },
      arguments: { id: "FN-201" },
      expectedProjectId: undefined,
    },
  ] satisfies Array<{
    label: string;
    env: Environment;
    arguments: { id: string; projectId?: string };
    expectedProjectId: string | undefined;
  }>)(
    "applies $label scope to the logs request",
    async ({ env, arguments: toolArguments, expectedProjectId }) => {
      const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
        Response.json([], {
          headers: { "X-Total-Count": "0", "X-Has-More": "false" },
        }),
      );
      const harness = await createHarness(parseConfig(env), fetchMock);

      try {
        const result = await harness.client.callTool({
          name: "get_task_logs",
          arguments: toolArguments,
        });

        expect(result.isError).not.toBe(true);
        const url = requestedUrl(fetchMock);
        expect(url.searchParams.get("projectId")).toBe(
          expectedProjectId ?? null,
        );
        expect(url.searchParams.has("projectId")).toBe(
          expectedProjectId !== undefined,
        );
        const auditOutput = vi
          .mocked(process.stderr.write)
          .mock.calls.map(([line]) => String(line))
          .join("");
        expect(auditOutput).toContain(
          `projectIdApplied=${String(expectedProjectId !== undefined)}`,
        );
        expect(auditOutput).not.toContain("explicit-project");
        expect(auditOutput).not.toContain("default-project");
      } finally {
        await harness.close();
      }
    },
  );

  it("parses a true has-more header and sends default bounds", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      Response.json([{ id: 1 }], {
        headers: { "X-Total-Count": "51", "X-Has-More": "true" },
      }),
    );
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "get_task_logs",
        arguments: { id: "FN-201" },
      });

      expect(textResult(result)).toEqual({
        logs: [{ id: 1 }],
        pagination: { total: 51, hasMore: true, limit: 50, offset: 0 },
      });
      expect(Object.fromEntries(requestedUrl(fetchMock).searchParams)).toEqual({
        limit: "50",
        offset: "0",
      });
    } finally {
      await harness.close();
    }
  });

  it.each([
    ["an empty first page", 0],
    ["an offset beyond range", 10_000],
  ])("returns %s without error", async (_name, offset) => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(
        Response.json([], { headers: { "X-Total-Count": "0" } }),
      );
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "get_task_logs",
        arguments: { id: "FN-202", offset },
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({
        logs: [],
        pagination: { total: 0, hasMore: false, limit: 50, offset },
      });
    } finally {
      await harness.close();
    }
  });

  it.each([
    ["missing", undefined],
    ["unparseable", "not-a-count"],
    ["unsafe", "9007199254740992"],
  ])("degrades gracefully when total count is %s", async (_name, total) => {
    const headers = new Headers();
    if (total !== undefined) {
      headers.set("X-Total-Count", total);
    }
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json([], { headers }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "get_task_logs",
        arguments: { id: "FN-203" },
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({
        logs: [],
        pagination: { total: null, hasMore: false, limit: 50, offset: 0 },
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
  ])("rejects %s before fetching", async (_name, arguments_) => {
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "get_task_logs",
        arguments: { id: "FN-204", ...arguments_ },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(secretMarker);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(process.stderr.write).toHaveBeenCalledOnce();
      expect(process.stderr.write).toHaveBeenCalledWith(
        expect.stringMatching(/tool=get_task_logs validation=failed\n$/),
      );
    } finally {
      await harness.close();
    }
  });

  it("rejects a non-string projectId with the governed validation envelope", async () => {
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "get_task_logs",
        arguments: { id: "FN-204", projectId: 123 },
      });

      expect(result.isError).toBe(true);
      expect(textResult(result)).toMatchObject({
        error: {
          code: "validation",
          details: [{ path: ["projectId"] }],
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(process.stderr.write).toHaveBeenCalledWith(
        expect.stringMatching(/tool=get_task_logs validation=failed\n$/),
      );
    } finally {
      await harness.close();
    }
  });

  it.each([undefined, ""])(
    "rejects missing or empty id %j before fetching",
    async (id) => {
      const fetchMock = vi.fn<FetchLike>();
      const harness = await createHarness(
        parseConfig({ FUSION_TOKEN: secretMarker }),
        fetchMock,
      );

      try {
        const result = await harness.client.callTool({
          name: "get_task_logs",
          arguments: id === undefined ? {} : { id },
        });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("id");
        expect(JSON.stringify(result)).not.toContain(secretMarker);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(process.stderr.write).toHaveBeenCalledOnce();
        expect(process.stderr.write).toHaveBeenCalledWith(
          expect.stringMatching(/tool=get_task_logs validation=failed\n$/),
        );
      } finally {
        await harness.close();
      }
    },
  );
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig, type Config } from "./config.js";
import type { FetchLike } from "./fusion-client.js";
import { buildServer } from "./index.js";

const tokenMarker = "distinctive-archive-token-marker";

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
    !("text" in content) ||
    typeof content.text !== "string"
  ) {
    throw new Error("expected a text tool result");
  }
  return JSON.parse(content.text) as unknown;
}

function requestedUrl(fetchMock: ReturnType<typeof vi.fn<FetchLike>>): URL {
  const url = fetchMock.mock.calls[0]?.[0];
  if (url === undefined) throw new Error("expected fetch call");
  return new URL(url);
}

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("archive_task", () => {
  it("posts the encoded archive path without a body when scope is unresolved", async () => {
    const id = "FN 14/../x";
    const task = { id, column: "archived" };
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(Response.json(task));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: tokenMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "archive_task",
        arguments: { id },
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({ task });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
      expect(requestedUrl(fetchMock).pathname).toBe(
        "/api/tasks/FN%2014%2F..%2Fx/archive",
      );
      expect(requestedUrl(fetchMock).search).toBe("");
      expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
      expect(
        new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("content-type"),
      ).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it.each([
    {
      name: "explicit project",
      env: {
        FUSION_TOKEN: tokenMarker,
        FUSION_DEFAULT_PROJECT_ID: "project-default",
      },
      arguments: { id: "FN-201", projectId: "project-explicit" },
      expectedProjectId: "project-explicit",
    },
    {
      name: "configured default project",
      env: {
        FUSION_TOKEN: tokenMarker,
        FUSION_DEFAULT_PROJECT_ID: "project-default",
      },
      arguments: { id: "FN-202" },
      expectedProjectId: "project-default",
    },
  ])(
    "sends $name as the projectId query parameter with no body",
    async ({ env, arguments: callArguments, expectedProjectId }) => {
      const fetchMock = vi
        .fn<FetchLike>()
        .mockResolvedValue(Response.json({ id: callArguments.id }));
      const harness = await createHarness(parseConfig(env), fetchMock);

      try {
        const result = await harness.client.callTool({
          name: "archive_task",
          arguments: callArguments,
        });

        expect(result.isError).not.toBe(true);
        expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
        expect(requestedUrl(fetchMock).pathname).toBe(
          `/api/tasks/${callArguments.id}/archive`,
        );
        expect(requestedUrl(fetchMock).searchParams.get("projectId")).toBe(
          expectedProjectId,
        );
        expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
      } finally {
        await harness.close();
      }
    },
  );

  it("rejects an empty id before reaching fetch", async () => {
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: tokenMarker,
        FUSION_DEFAULT_PROJECT_ID: "project-default",
      }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "archive_task",
        arguments: { id: "" },
      });

      expect(result.isError).toBe(true);
      expect(textResult(result)).toMatchObject({
        error: { code: "validation" },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("audits the tool call to stderr without the token", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ id: "FN-203" }));
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: tokenMarker,
        FUSION_DEFAULT_PROJECT_ID: "project-default",
      }),
      fetchMock,
    );

    try {
      await harness.client.callTool({
        name: "archive_task",
        arguments: { id: "FN-203" },
      });

      expect(stderr).toHaveBeenCalledOnce();
      expect(stderr.mock.calls[0]?.[0]).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T[^\]]+Z\] tool=archive_task id=FN-203 projectIdApplied=true\n$/,
      );
      expect(stderr.mock.calls.flat().join(" ")).not.toContain(tokenMarker);
    } finally {
      await harness.close();
    }
  });
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig, type Config, type Environment } from "./config.js";
import type { FetchLike } from "./fusion-client.js";
import { buildServer } from "./index.js";

const secretMarker = "distinctive-move-token-marker";
const unsafeUpstreamMarker = "unsafe-move-upstream-marker";

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

function requestDetails(fetchMock: ReturnType<typeof vi.fn<FetchLike>>) {
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  if (url === undefined || init?.body === undefined) {
    throw new Error("expected fetch request with a body");
  }
  return {
    url: new URL(url),
    method: init.method,
    headers: new Headers(init.headers),
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
  };
}

function auditLines(): string[] {
  return vi
    .mocked(process.stderr.write)
    .mock.calls.map(([line]) => String(line));
}

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("move_task", () => {
  it("moves a task with explicit project scope in the POST body", async () => {
    const id = "FN-013";
    const projectId = "proj-1";
    const task = { id, column: "in-progress" };
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(Response.json(task));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "move_task",
        arguments: { id, column: "in-progress", projectId },
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({ task });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const request = requestDetails(fetchMock);
      expect(request.method).toBe("POST");
      expect(request.url.pathname).toBe("/api/tasks/FN-013/move");
      expect(request.url.search).toBe("");
      expect(request.body).toEqual({ column: "in-progress", projectId });
      expect(request.headers.get("content-type")).toBe("application/json");

      const lines = auditLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(
        /^\[[^\]]+\] tool=move_task id=FN-013 column=in-progress projectIdApplied=true\n$/,
      );
      expect(lines[0]).not.toContain(projectId);
      expect(lines[0]).not.toContain(secretMarker);
      expect(JSON.stringify(result)).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });

  it("URL-encodes the task id path segment", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ id: "FN 14/../x" }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      await harness.client.callTool({
        name: "move_task",
        arguments: { id: "FN 14/../x", column: "todo" },
      });

      expect(requestDetails(fetchMock).url.pathname).toBe(
        "/api/tasks/FN%2014%2F..%2Fx/move",
      );
    } finally {
      await harness.close();
    }
  });

  it.each([
    {
      label: "configured default",
      env: {
        FUSION_TOKEN: secretMarker,
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      },
      arguments: { id: "FN-014", column: "todo" },
      expectedBody: { column: "todo", projectId: "default-project" },
      projectIdApplied: true,
    },
    {
      label: "server default",
      env: { FUSION_TOKEN: secretMarker },
      arguments: { id: "FN-014", column: "todo" },
      expectedBody: { column: "todo" },
      projectIdApplied: false,
    },
    {
      label: "explicit project over configured default",
      env: {
        FUSION_TOKEN: secretMarker,
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      },
      arguments: {
        id: "FN-014",
        column: "todo",
        projectId: "explicit-project",
      },
      expectedBody: { column: "todo", projectId: "explicit-project" },
      projectIdApplied: true,
    },
  ] satisfies Array<{
    label: string;
    env: Environment;
    arguments: { id: string; column: string; projectId?: string };
    expectedBody: Record<string, unknown>;
    projectIdApplied: boolean;
  }>)(
    "applies $label project scoping",
    async ({
      env,
      arguments: toolArguments,
      expectedBody,
      projectIdApplied,
    }) => {
      const fetchMock = vi
        .fn<FetchLike>()
        .mockResolvedValue(Response.json({ id: "FN-014" }));
      const harness = await createHarness(parseConfig(env), fetchMock);

      try {
        await harness.client.callTool({
          name: "move_task",
          arguments: toolArguments,
        });

        const request = requestDetails(fetchMock);
        expect(request.url.search).toBe("");
        expect(request.body).toEqual(expectedBody);
        if (!projectIdApplied) {
          expect(request.body).not.toHaveProperty("projectId");
        }
        const audit = auditLines().join("");
        expect(audit).toMatch(
          new RegExp(`projectIdApplied=${String(projectIdApplied)}\\n$`),
        );
        expect(audit).not.toContain("default-project");
        expect(audit).not.toContain("explicit-project");
        expect(audit).not.toContain(secretMarker);
      } finally {
        await harness.close();
      }
    },
  );

  it.each([
    { label: "missing id", arguments: { column: "todo" }, field: "id" },
    {
      label: "empty id",
      arguments: { id: "", column: "todo" },
      field: "id",
    },
    { label: "missing column", arguments: { id: "FN-015" }, field: "column" },
    {
      label: "empty column",
      arguments: { id: "FN-015", column: "" },
      field: "column",
    },
  ])(
    "rejects $label before fetch",
    async ({ arguments: toolArguments, field }) => {
      const fetchMock = vi.fn<FetchLike>();
      const harness = await createHarness(
        parseConfig({ FUSION_TOKEN: secretMarker }),
        fetchMock,
      );

      try {
        const result = await harness.client.callTool({
          name: "move_task",
          arguments: toolArguments,
        });
        const rendered = JSON.stringify(result);

        expect(result.isError).toBe(true);
        expect(textResult(result)).toMatchObject({
          error: {
            code: "validation",
            details: [{ path: [field] }],
          },
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(auditLines()).toHaveLength(1);
        expect(auditLines()[0]).toMatch(/tool=move_task validation=failed\n$/);
        expect(auditLines()[0]).not.toContain(secretMarker);
        expect(rendered).not.toContain(secretMarker);
      } finally {
        await harness.close();
      }
    },
  );

  it("surfaces an upstream failure without response or token details", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(unsafeUpstreamMarker, { status: 502 }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "move_task",
        arguments: { id: "FN-016", column: "in-review" },
      });
      const rendered = JSON.stringify(result);

      expect(result.isError).toBe(true);
      expect(textResult(result)).toEqual({
        error: {
          code: "upstream_error",
          message: "Upstream request failed",
          status: 502,
        },
      });
      expect(rendered).not.toContain(unsafeUpstreamMarker);
      expect(rendered).not.toContain(secretMarker);
      expect(auditLines().join("")).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });
});

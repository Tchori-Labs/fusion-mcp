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

function requestedUrl(fetchMock: ReturnType<typeof vi.fn<FetchLike>>): URL {
  const url = fetchMock.mock.calls[0]?.[0];
  if (url === undefined) {
    throw new Error("expected fetch to be called");
  }
  return new URL(url);
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

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("get_task_workflow_results", () => {
  it("returns the raw workflow-results payload", async () => {
    const workflowResults = [
      { step: 0, status: "completed", output: { verdict: "approve" } },
      { step: 1, status: "running" },
    ];
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json(workflowResults));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "get_task_workflow_results",
        arguments: { id: "task/with space" },
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({ workflowResults });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        "http://127.0.0.1:4040/api/tasks/task%2Fwith%20space/workflow-results",
      );
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
      const auditOutput = vi
        .mocked(process.stderr.write)
        .mock.calls.map(([line]) => String(line))
        .join("");
      expect(auditOutput).toContain(
        "tool=get_task_workflow_results id=task/with space",
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
      arguments: { id: "FN-202", projectId: "explicit-project" },
      expectedProjectId: "explicit-project",
    },
    {
      label: "configured default project",
      env: {
        FUSION_TOKEN: secretMarker,
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      },
      arguments: { id: "FN-202" },
      expectedProjectId: "default-project",
    },
    {
      label: "server default project",
      env: { FUSION_TOKEN: secretMarker },
      arguments: { id: "FN-202" },
      expectedProjectId: undefined,
    },
  ] satisfies Array<{
    label: string;
    env: Environment;
    arguments: { id: string; projectId?: string };
    expectedProjectId: string | undefined;
  }>)(
    "applies $label scope to the workflow-results request",
    async ({ env, arguments: toolArguments, expectedProjectId }) => {
      const fetchMock = vi.fn<FetchLike>().mockResolvedValue(Response.json([]));
      const harness = await createHarness(parseConfig(env), fetchMock);

      try {
        const result = await harness.client.callTool({
          name: "get_task_workflow_results",
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
          name: "get_task_workflow_results",
          arguments: id === undefined ? {} : { id },
        });
        const rendered = JSON.stringify(result);

        expect(result.isError).toBe(true);
        expect(rendered).toContain("id");
        expect(rendered).not.toContain(secretMarker);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(process.stderr.write).toHaveBeenCalledOnce();
        expect(process.stderr.write).toHaveBeenCalledWith(
          expect.stringMatching(
            /tool=get_task_workflow_results validation=failed\n$/,
          ),
        );
      } finally {
        await harness.close();
      }
    },
  );

  it("surfaces an upstream failure without response or token details", async () => {
    const responseMarker = "unsafe-workflow-body-marker";
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(responseMarker, { status: 503 }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "get_task_workflow_results",
        arguments: { id: "FN-503" },
      });
      const rendered = JSON.stringify(result);

      expect(result.isError).toBe(true);
      expect(rendered).toContain("Upstream request failed");
      expect(rendered).not.toContain(responseMarker);
      expect(rendered).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });
});

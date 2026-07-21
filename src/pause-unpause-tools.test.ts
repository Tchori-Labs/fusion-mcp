import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig, type Config, type Environment } from "./config.js";
import type { FetchLike } from "./fusion-client.js";
import { buildServer } from "./index.js";

const secretMarker = "distinctive-pause-token-marker";
const unsafeUpstreamMarker = "unsafe-upstream-response-marker";

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
  const value = fetchMock.mock.calls[0]?.[0];
  if (value === undefined) {
    throw new Error("expected fetch to be called");
  }
  return new URL(value);
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

describe.each([
  { tool: "pause_task", action: "pause" },
  { tool: "unpause_task", action: "unpause" },
] as const)("$tool", ({ tool, action }) => {
  it("posts an encoded task id without a request body", async () => {
    const id = "FN 14/../x";
    const task = { id, paused: action === "pause" };
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(Response.json(task));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: tool,
        arguments: { id },
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({ task });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
      expect(requestedUrl(fetchMock).pathname).toBe(
        `/api/tasks/FN%2014%2F..%2Fx/${action}`,
      );
      expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
      expect(
        new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("content-type"),
      ).toBe(false);

      const lines = auditLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(
        new RegExp(
          `^\\[\\d{4}-\\d{2}-\\d{2}T[^\\]]+Z\\] tool=${tool} id=FN 14/\\.\\./x projectIdApplied=false\\n$`,
        ),
      );
      expect(lines[0]).not.toContain(secretMarker);
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
      arguments: { id: "FN-014", projectId: "explicit-project" },
      expectedProjectId: "explicit-project",
    },
    {
      label: "configured default project",
      env: {
        FUSION_TOKEN: secretMarker,
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      },
      arguments: { id: "FN-014" },
      expectedProjectId: "default-project",
    },
  ] satisfies Array<{
    label: string;
    env: Environment;
    arguments: { id: string; projectId?: string };
    expectedProjectId: string;
  }>)(
    "posts $label scope in the request body",
    async ({ env, arguments: toolArguments, expectedProjectId }) => {
      const fetchMock = vi
        .fn<FetchLike>()
        .mockResolvedValue(Response.json({ id: "FN-014" }));
      const harness = await createHarness(parseConfig(env), fetchMock);

      try {
        const result = await harness.client.callTool({
          name: tool,
          arguments: toolArguments,
        });

        expect(result.isError).not.toBe(true);
        const init = fetchMock.mock.calls[0]?.[1];
        expect(init?.body).toBeDefined();
        expect(JSON.parse(String(init?.body))).toEqual({
          projectId: expectedProjectId,
        });
        expect(new Headers(init?.headers).get("content-type")).toBe(
          "application/json",
        );
        const audit = auditLines().join("");
        expect(audit).toContain("projectIdApplied=true");
        expect(audit).not.toContain("explicit-project");
        expect(audit).not.toContain("default-project");
      } finally {
        await harness.close();
      }
    },
  );

  it.each([
    { label: "missing", arguments: {} },
    { label: "empty", arguments: { id: "" } },
  ])(
    "rejects a $label id before fetch",
    async ({ arguments: toolArguments }) => {
      const fetchMock = vi.fn<FetchLike>();
      const harness = await createHarness(
        parseConfig({ FUSION_TOKEN: secretMarker }),
        fetchMock,
      );

      try {
        const result = await harness.client.callTool({
          name: tool,
          arguments: toolArguments,
        });

        expect(result.isError).toBe(true);
        expect(JSON.stringify(result).toLowerCase()).toContain("id");
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await harness.close();
      }
    },
  );

  it("surfaces non-2xx failures without upstream content or secrets", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(unsafeUpstreamMarker, { status: 503 }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: tool,
        arguments: { id: "FN-014" },
      });
      const rendered = JSON.stringify(result);

      expect(result.isError).toBe(true);
      expect(rendered).not.toContain(unsafeUpstreamMarker);
      expect(rendered).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });
});

describe("lifecycle tool governance", () => {
  it("registers pause and unpause without destructive or system-control tools", async () => {
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(parseConfig({}), fetchMock);

    try {
      const { tools } = await harness.client.listTools();
      const names = tools.map(({ name }) => name);
      const prohibited =
        /delete|archive|remove|restart|shutdown|reboot|merge|approve|publish|deploy/i;

      expect(names).toContain("pause_task");
      expect(names).toContain("unpause_task");
      expect(names.filter((name) => prohibited.test(name))).toEqual([]);

      for (const name of ["pause_task", "unpause_task"]) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
          "id",
          "projectId",
        ]);
        expect(tool?.inputSchema.required).toEqual(["id"]);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });
});

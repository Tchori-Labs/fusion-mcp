import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig, type Config } from "./config.js";
import type { FetchLike } from "./fusion-client.js";
import { buildServer } from "./index.js";

const tokenMarker = "distinctive-token-secret-marker";

async function createHarness(config: Config, fetch: FetchLike) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
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

function requestedBody(
  fetchMock: ReturnType<typeof vi.fn<FetchLike>>,
): Record<string, unknown> {
  const body = fetchMock.mock.calls[0]?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("expected a JSON request body");
  }
  return JSON.parse(body) as Record<string, unknown>;
}

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("create_task", () => {
  it("posts exactly the approved safe fields and returns the created task", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ id: "FN-100", column: "todo" }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: tokenMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "create_task",
        arguments: {
          description: "Implement the governed endpoint",
          title: "Governed task",
          column: "todo",
          priority: "high",
          dependencies: ["FN-001", "FN-002"],
          workflowId: "WF-001",
          baseBranch: "feature/base",
          projectId: "project-explicit",
        },
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({
        task: { id: "FN-100", column: "todo" },
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(requestedUrl(fetchMock).pathname).toBe("/api/tasks");
      expect(requestedUrl(fetchMock).search).toBe("");
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
      expect(
        new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("content-type"),
      ).toBe("application/json");
      expect(requestedBody(fetchMock)).toEqual({
        description: "Implement the governed endpoint",
        title: "Governed task",
        column: "todo",
        priority: "high",
        dependencies: ["FN-001", "FN-002"],
        workflowId: "WF-001",
        baseBranch: "feature/base",
        projectId: "project-explicit",
      });
    } finally {
      await harness.close();
    }
  });

  it("strips unsupported input instead of forwarding it", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ id: "FN-101" }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: tokenMarker }),
      fetchMock,
    );

    try {
      await harness.client.callTool({
        name: "create_task",
        arguments: {
          description: "Safe description",
          title: "Safe title",
          agentId: "must-not-pass-through",
          status: "done",
        },
      });

      expect(requestedBody(fetchMock)).toEqual({
        description: "Safe description",
        title: "Safe title",
      });
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
      arguments: { description: "Explicit scope", projectId: "project-explicit" },
      expectedProjectId: "project-explicit",
    },
    {
      name: "configured default project",
      env: {
        FUSION_TOKEN: tokenMarker,
        FUSION_DEFAULT_PROJECT_ID: "project-default",
      },
      arguments: { description: "Default scope" },
      expectedProjectId: "project-default",
    },
    {
      name: "server default project",
      env: { FUSION_TOKEN: tokenMarker },
      arguments: { description: "Server scope" },
      expectedProjectId: undefined,
    },
  ])("sends $name only through the POST body", async ({
    env,
    arguments: callArguments,
    expectedProjectId,
  }) => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ id: "FN-102" }));
    const harness = await createHarness(parseConfig(env), fetchMock);

    try {
      await harness.client.callTool({
        name: "create_task",
        arguments: callArguments,
      });

      expect(requestedUrl(fetchMock).search).toBe("");
      const body = requestedBody(fetchMock);
      if (expectedProjectId === undefined) {
        expect(body).not.toHaveProperty("projectId");
      } else {
        expect(body.projectId).toBe(expectedProjectId);
      }
    } finally {
      await harness.close();
    }
  });

  it.each([
    { name: "missing", arguments: {} },
    { name: "empty", arguments: { description: "" } },
  ])("rejects a $name description before fetch", async ({ arguments: callArguments }) => {
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: tokenMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "create_task",
        arguments: callArguments,
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("description");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it.each([
    { name: "non-array", dependencies: "FN-001" },
    { name: "non-string array", dependencies: ["FN-001", 2] },
  ])("rejects $name dependencies before fetch", async ({ dependencies }) => {
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: tokenMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "create_task",
        arguments: { description: "Typed dependencies", dependencies },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("dependencies");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("forwards valid string-array dependencies", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ id: "FN-103" }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: tokenMarker }),
      fetchMock,
    );

    try {
      await harness.client.callTool({
        name: "create_task",
        arguments: {
          description: "Typed dependencies",
          dependencies: ["FN-001", "FN-002"],
        },
      });

      expect(requestedBody(fetchMock).dependencies).toEqual([
        "FN-001",
        "FN-002",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("audits only title and column without body or secret values", async () => {
    const descriptionMarker = "distinctive-description-body-marker";
    const projectMarker = "distinctive-project-marker";
    const stderr = vi.mocked(process.stderr.write);
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ id: "FN-104" }));
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: tokenMarker,
        FUSION_DEFAULT_PROJECT_ID: projectMarker,
      }),
      fetchMock,
    );

    try {
      await harness.client.callTool({
        name: "create_task",
        arguments: {
          description: descriptionMarker,
          title: "Audit title",
          column: "todo",
          priority: "urgent",
          baseBranch: "private-branch-marker",
        },
      });

      expect(stderr).toHaveBeenCalledOnce();
      const auditLine = String(stderr.mock.calls[0]?.[0]);
      expect(auditLine).toMatch(/tool=create_task/);
      expect(auditLine).toContain("title=Audit title column=todo");
      expect(auditLine).not.toContain(descriptionMarker);
      expect(auditLine).not.toContain(tokenMarker);
      expect(auditLine).not.toContain(projectMarker);
      expect(auditLine).not.toContain("urgent");
      expect(auditLine).not.toContain("private-branch-marker");
    } finally {
      await harness.close();
    }
  });

  it("surfaces upstream failures without response bodies or tokens", async () => {
    const responseMarker = "distinctive-upstream-response-marker";
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(responseMarker, { status: 503 }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: tokenMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "create_task",
        arguments: { description: "Do not expose this request body" },
      });
      const rendered = JSON.stringify(result);

      expect(result.isError).toBe(true);
      expect(rendered).toContain("Fusion request failed: POST /api/tasks");
      expect(rendered).not.toContain(responseMarker);
      expect(rendered).not.toContain(tokenMarker);
      expect(rendered).not.toContain("Do not expose this request body");
    } finally {
      await harness.close();
    }
  });
});

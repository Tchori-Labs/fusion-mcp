import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig, type Config } from "./config.js";
import type { FetchLike } from "./fusion-client.js";
import { buildServer } from "./index.js";

const secretMarker = "distinctive-fake-secret-marker";

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

function auditOutput(): string {
  return vi
    .mocked(process.stderr.write)
    .mock.calls.map(([line]) => String(line))
    .join("");
}

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("list_approvals", () => {
  it("returns approvals and applies an explicit project", async () => {
    const approvals = [
      { id: "approval-1", taskId: "KB-001", status: "pending" },
      { id: "approval-2", taskId: "KB-002", status: "approved" },
    ];
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json(approvals));
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: secretMarker,
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "list_approvals",
        arguments: { projectId: "explicit-project" },
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({ approvals });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
      const url = requestedUrl(fetchMock);
      expect(url.pathname).toBe("/api/approvals");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        projectId: "explicit-project",
      });
      expect(auditOutput()).toContain(
        "tool=list_approvals projectIdApplied=true",
      );
      expect(auditOutput()).not.toContain("explicit-project");
      expect(auditOutput()).not.toContain(secretMarker);
      expect(JSON.stringify(result)).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });

  it("falls back to the configured default project", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(Response.json([]));
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: secretMarker,
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      }),
      fetchMock,
    );

    try {
      await harness.client.callTool({
        name: "list_approvals",
        arguments: {},
      });

      expect(requestedUrl(fetchMock).searchParams.get("projectId")).toBe(
        "default-project",
      );
      expect(auditOutput()).not.toContain("default-project");
      expect(auditOutput()).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });

  it("omits projectId when no explicit or default project exists", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(Response.json([]));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      await harness.client.callTool({
        name: "list_approvals",
        arguments: {},
      });

      expect(requestedUrl(fetchMock).search).toBe("");
      expect(auditOutput()).toContain(
        "tool=list_approvals projectIdApplied=false",
      );
      expect(auditOutput()).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });
});

describe("get_approval", () => {
  it("returns an approval and applies an explicit project", async () => {
    const approval = {
      id: "approval-3",
      taskId: "KB-003",
      status: "pending",
    };
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json(approval));
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: secretMarker,
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "get_approval",
        arguments: { id: "approval-3", projectId: "explicit-project" },
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({ approval });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
      const url = requestedUrl(fetchMock);
      expect(url.pathname).toBe("/api/approvals/approval-3");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        projectId: "explicit-project",
      });
      expect(auditOutput()).toContain(
        "tool=get_approval id=approval-3 projectIdApplied=true",
      );
      expect(auditOutput()).not.toContain("explicit-project");
      expect(auditOutput()).not.toContain(secretMarker);
      expect(JSON.stringify(result)).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });

  it("URL-encodes the approval id as one path segment", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ id: "appr/with space" }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      await harness.client.callTool({
        name: "get_approval",
        arguments: { id: "appr/with space" },
      });

      expect(requestedUrl(fetchMock).pathname).toBe(
        "/api/approvals/appr%2Fwith%20space",
      );
      expect(auditOutput()).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });

  it("falls back to the configured default project", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ id: "approval-4" }));
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: secretMarker,
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      }),
      fetchMock,
    );

    try {
      await harness.client.callTool({
        name: "get_approval",
        arguments: { id: "approval-4" },
      });

      expect(requestedUrl(fetchMock).searchParams.get("projectId")).toBe(
        "default-project",
      );
      expect(auditOutput()).not.toContain("default-project");
      expect(auditOutput()).not.toContain(secretMarker);
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
          name: "get_approval",
          arguments: id === undefined ? {} : { id },
        });
        const rendered = JSON.stringify(result);

        expect(result.isError).toBe(true);
        expect(textResult(result)).toMatchObject({
          error: {
            code: "validation",
            details: [{ path: ["id"] }],
          },
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(process.stderr.write).toHaveBeenCalledOnce();
        expect(process.stderr.write).toHaveBeenCalledWith(
          expect.stringMatching(/tool=get_approval validation=failed\n$/),
        );
        expect(auditOutput()).not.toContain(secretMarker);
        expect(rendered).not.toContain(secretMarker);
      } finally {
        await harness.close();
      }
    },
  );

  it("surfaces an upstream failure without response or token details", async () => {
    const responseMarker = "unsafe-upstream-body-marker";
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(responseMarker, { status: 503 }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "get_approval",
        arguments: { id: "approval-503" },
      });
      const rendered = JSON.stringify(result);

      expect(result.isError).toBe(true);
      expect(textResult(result)).toEqual({
        error: {
          code: "upstream_error",
          message: "Upstream request failed",
          status: 503,
        },
      });
      expect(rendered).not.toContain(responseMarker);
      expect(rendered).not.toContain(secretMarker);
      expect(auditOutput()).not.toContain(responseMarker);
      expect(auditOutput()).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });
});

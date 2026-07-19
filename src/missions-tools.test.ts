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

function requestedUrls(fetchMock: ReturnType<typeof vi.fn<FetchLike>>): URL[] {
  return fetchMock.mock.calls.map(([url]) => new URL(url));
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

describe("list_missions", () => {
  it("returns missions with explicit project and includeDrafts scoping", async () => {
    const missions = [
      { id: "M-001", title: "First mission" },
      { id: "M-002", title: "Draft mission" },
    ];
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json(missions));
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: secretMarker,
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "list_missions",
        arguments: { projectId: "explicit-project", includeDrafts: true },
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({ missions });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
      const [url] = requestedUrls(fetchMock);
      expect(url?.pathname).toBe("/api/missions");
      expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({
        projectId: "explicit-project",
        includeDrafts: "true",
      });
      expect(auditOutput()).toContain(
        "tool=list_missions includeDrafts=true projectIdApplied=true",
      );
      expect(auditOutput()).not.toContain("explicit-project");
      expect(auditOutput()).not.toContain(secretMarker);
      expect(JSON.stringify(result)).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });

  it("uses the default project and omits includeDrafts when absent", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(Response.json([]));
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: secretMarker,
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      }),
      fetchMock,
    );

    try {
      await harness.client.callTool({ name: "list_missions", arguments: {} });

      const [url] = requestedUrls(fetchMock);
      expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({
        projectId: "default-project",
      });
      expect(auditOutput()).toContain(
        "tool=list_missions includeDrafts=false projectIdApplied=true",
      );
      expect(auditOutput()).not.toContain("default-project");
      expect(auditOutput()).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });

  it("omits the query when no project or includeDrafts is supplied", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(Response.json([]));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      await harness.client.callTool({ name: "list_missions", arguments: {} });

      expect(requestedUrls(fetchMock)[0]?.search).toBe("");
      expect(auditOutput()).toContain(
        "tool=list_missions includeDrafts=false projectIdApplied=false",
      );
      expect(auditOutput()).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });

  it("rejects a non-boolean includeDrafts before fetching", async () => {
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "list_missions",
        arguments: { includeDrafts: "yes" },
      });
      const rendered = JSON.stringify(result);

      expect(result.isError).toBe(true);
      expect(textResult(result)).toMatchObject({
        error: {
          code: "validation",
          details: [{ path: ["includeDrafts"] }],
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(process.stderr.write).toHaveBeenCalledOnce();
      expect(process.stderr.write).toHaveBeenCalledWith(
        expect.stringMatching(/tool=list_missions validation=failed\n$/),
      );
      expect(rendered).not.toContain(secretMarker);
      expect(auditOutput()).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });
});

describe("get_mission", () => {
  it("returns a mission with status and health using explicit project scope", async () => {
    const mission = { id: "M-001", title: "Ship governed MCP" };
    const status = { status: "active", progress: 40 };
    const health = { healthy: true };
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(Response.json(mission))
      .mockResolvedValueOnce(Response.json(status))
      .mockResolvedValueOnce(Response.json(health));
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: secretMarker,
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "get_mission",
        arguments: { id: "M-001", projectId: "explicit-project" },
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({ mission, status, health });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual([
        "GET",
        "GET",
        "GET",
      ]);
      const urls = requestedUrls(fetchMock);
      expect(urls.map(({ pathname }) => pathname)).toEqual([
        "/api/missions/M-001",
        "/api/missions/M-001/status",
        "/api/missions/M-001/health",
      ]);
      for (const url of urls) {
        expect(Object.fromEntries(url.searchParams)).toEqual({
          projectId: "explicit-project",
        });
      }
      expect(auditOutput()).toContain(
        "tool=get_mission id=M-001 projectIdApplied=true",
      );
      expect(auditOutput()).not.toContain("explicit-project");
      expect(auditOutput()).not.toContain(secretMarker);
      expect(JSON.stringify(result)).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });

  it("applies the default project to all three requests", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ available: true }));
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: secretMarker,
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      }),
      fetchMock,
    );

    try {
      await harness.client.callTool({
        name: "get_mission",
        arguments: { id: "M-002" },
      });

      expect(requestedUrls(fetchMock)).toHaveLength(3);
      for (const url of requestedUrls(fetchMock)) {
        expect(url.searchParams.get("projectId")).toBe("default-project");
      }
      expect(auditOutput()).not.toContain("default-project");
      expect(auditOutput()).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });

  it("omits projectId from all requests when no scope is available", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ available: true }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      await harness.client.callTool({
        name: "get_mission",
        arguments: { id: "M-003" },
      });

      expect(requestedUrls(fetchMock)).toHaveLength(3);
      for (const url of requestedUrls(fetchMock)) {
        expect(url.search).toBe("");
      }
      expect(auditOutput()).toContain(
        "tool=get_mission id=M-003 projectIdApplied=false",
      );
      expect(auditOutput()).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });

  it("URL-encodes the mission id as one path segment for every request", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ available: true }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      await harness.client.callTool({
        name: "get_mission",
        arguments: { id: "mission/with space" },
      });

      expect(requestedUrls(fetchMock).map(({ pathname }) => pathname)).toEqual([
        "/api/missions/mission%2Fwith%20space",
        "/api/missions/mission%2Fwith%20space/status",
        "/api/missions/mission%2Fwith%20space/health",
      ]);
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
          name: "get_mission",
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
          expect.stringMatching(/tool=get_mission validation=failed\n$/),
        );
        expect(rendered).not.toContain(secretMarker);
        expect(auditOutput()).not.toContain(secretMarker);
      } finally {
        await harness.close();
      }
    },
  );

  it("surfaces a primary failure without response or token details", async () => {
    const responseMarker = "unsafe-upstream-body-marker";
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(responseMarker, { status: 404 }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "get_mission",
        arguments: { id: "M-404" },
      });
      const rendered = JSON.stringify(result);

      expect(result.isError).toBe(true);
      expect(textResult(result)).toEqual({
        error: {
          code: "upstream_error",
          message: "Upstream request failed",
          status: 404,
        },
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(rendered).not.toContain(responseMarker);
      expect(rendered).not.toContain(secretMarker);
      expect(auditOutput()).not.toContain(responseMarker);
      expect(auditOutput()).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });

  it("degrades a failed status sub-view without failing the mission", async () => {
    const responseMarker = "unsafe-status-body-marker";
    const mission = { id: "M-004" };
    const health = { healthy: true };
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(Response.json(mission))
      .mockResolvedValueOnce(new Response(responseMarker, { status: 503 }))
      .mockResolvedValueOnce(Response.json(health));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "get_mission",
        arguments: { id: "M-004" },
      });
      const rendered = JSON.stringify(result);

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({
        mission,
        status: { available: false },
        health,
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(rendered).not.toContain(responseMarker);
      expect(rendered).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });

  it("degrades a failed health sub-view without failing the mission", async () => {
    const responseMarker = "unsafe-health-body-marker";
    const mission = { id: "M-005" };
    const status = { status: "active" };
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(Response.json(mission))
      .mockResolvedValueOnce(Response.json(status))
      .mockResolvedValueOnce(new Response(responseMarker, { status: 500 }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "get_mission",
        arguments: { id: "M-005" },
      });
      const rendered = JSON.stringify(result);

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({
        mission,
        status,
        health: { available: false },
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(rendered).not.toContain(responseMarker);
      expect(rendered).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseConfig, type Config } from "./config.js";
import {
  FusionClient,
  FusionError,
  type FetchLike,
} from "./fusion-client.js";
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
  const call = fetchMock.mock.calls[0];
  if (call === undefined) {
    throw new Error("fetch was not called");
  }
  return new URL(call[0]);
}

function requestedMethod(fetchMock: ReturnType<typeof vi.fn<FetchLike>>): string | undefined {
  return fetchMock.mock.calls[0]?.[1]?.method;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("project read tools", () => {
  it("registers only the governed scaffold and project read tools", async () => {
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(parseConfig({}), fetchMock);

    try {
      const tools = await harness.client.listTools();

      expect(tools.tools.map(({ name }) => name)).toEqual([
        "get_board_health",
        "list_projects",
        "read_project_settings",
        "list_tasks",
      ]);
      const settingsTool = tools.tools.find(
        ({ name }) => name === "read_project_settings",
      );
      expect(settingsTool?.inputSchema).toMatchObject({
        type: "object",
        properties: { projectId: { type: "string", minLength: 1 } },
      });
      expect(settingsTool?.inputSchema).not.toHaveProperty("properties.value");
      expect(settingsTool?.inputSchema).not.toHaveProperty("properties.settings");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("lists projects with GET and no project query", async () => {
    const projects = [
      { id: "project-a", name: "Alpha" },
      { id: "project-b", name: "Beta" },
    ];
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json(projects));
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: "placeholder",
        FUSION_DEFAULT_PROJECT_ID: "must-not-be-sent",
      }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "list_projects",
        arguments: {},
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({ projects });
      expect(requestedMethod(fetchMock)).toBe("GET");
      expect(requestedUrl(fetchMock).pathname).toBe("/api/projects");
      expect([...requestedUrl(fetchMock).searchParams]).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("passes an explicit projectId when reading settings", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ theme: "dark" }));
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: "placeholder",
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "read_project_settings",
        arguments: { projectId: "explicit project" },
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({ settings: { theme: "dark" } });
      expect(requestedMethod(fetchMock)).toBe("GET");
      expect(requestedUrl(fetchMock).pathname).toBe("/api/settings");
      expect(requestedUrl(fetchMock).searchParams.get("projectId")).toBe(
        "explicit project",
      );
    } finally {
      await harness.close();
    }
  });

  it("redacts sensitive settings from the tool result", async () => {
    const secretMarker = "must-not-reach-the-mcp-client";
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      Response.json({
        theme: "dark",
        daemonToken: secretMarker,
        researchGlobalBraveApiKey: secretMarker,
        remoteAccess: {
          providers: { cloudflare: { tunnelToken: secretMarker } },
          tokenStrategy: {
            persistent: { token: secretMarker },
            shortLived: { ttlMs: 900_000 },
          },
        },
        taskTokenBudget: { maxTotalTokens: 10_000 },
        secretsAccessPolicy: "allowlist",
      }),
    );
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: "placeholder" }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "read_project_settings",
        arguments: {},
      });
      const rendered = JSON.stringify(result);

      expect(rendered).not.toContain(secretMarker);
      expect(textResult(result)).toEqual({
        settings: {
          theme: "dark",
          daemonToken: "[REDACTED]",
          researchGlobalBraveApiKey: "[REDACTED]",
          remoteAccess: {
            providers: { cloudflare: { tunnelToken: "[REDACTED]" } },
            tokenStrategy: {
              persistent: { token: "[REDACTED]" },
              shortLived: { ttlMs: 900_000 },
            },
          },
          taskTokenBudget: { maxTotalTokens: 10_000 },
          secretsAccessPolicy: "allowlist",
        },
      });
    } finally {
      await harness.close();
    }
  });

  it("falls back to the configured default projectId", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ notifications: true }));
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: "placeholder",
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      }),
      fetchMock,
    );

    try {
      await harness.client.callTool({
        name: "read_project_settings",
        arguments: {},
      });

      expect(requestedUrl(fetchMock).searchParams.get("projectId")).toBe(
        "default-project",
      );
    } finally {
      await harness.close();
    }
  });

  it("omits projectId when neither input nor a default is present", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ notifications: false }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: "placeholder" }),
      fetchMock,
    );

    try {
      await harness.client.callTool({
        name: "read_project_settings",
        arguments: {},
      });

      expect(requestedUrl(fetchMock).pathname).toBe("/api/settings");
      expect([...requestedUrl(fetchMock).searchParams]).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("rejects an empty projectId before invoking the handler", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: "placeholder" }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "read_project_settings",
        arguments: { projectId: "" },
      });

      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("normalizes a project-list failure without exposing secrets or bodies", async () => {
    const secretMarker = "distinctive-secret-marker";
    const bodyMarker = "unsafe-upstream-body-marker";
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(bodyMarker, { status: 503 }));
    const client = new FusionClient(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    const error = await client.listProjects().catch((caught: unknown) => caught);
    const rendered = `${String(error)} ${JSON.stringify(error)}`;

    expect(error).toBeInstanceOf(FusionError);
    expect(error).toMatchObject({
      method: "GET",
      path: "/api/projects",
      status: 503,
    });
    expect(rendered).not.toContain(secretMarker);
    expect(rendered).not.toContain(bodyMarker);
  });

  it("audits each tool once to stderr without secrets or stdout output", async () => {
    const secretMarker = "audit-secret-marker";
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ mode: "safe" }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      await harness.client.callTool({ name: "list_projects", arguments: {} });
      await harness.client.callTool({
        name: "read_project_settings",
        arguments: { projectId: "project-a" },
      });

      expect(stderr).toHaveBeenCalledTimes(2);
      expect(stderr.mock.calls[0]?.[0]).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T[^\]]+Z\] tool=list_projects\n$/,
      );
      expect(stderr.mock.calls[1]?.[0]).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T[^\]]+Z\] tool=read_project_settings projectId=project-a\n$/,
      );
      expect(stderr.mock.calls.flat().join(" ")).not.toContain(secretMarker);
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });
});

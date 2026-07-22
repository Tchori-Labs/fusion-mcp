import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig, type Config } from "./config.js";
import type { FetchLike } from "./fusion-client.js";
import { buildServer } from "./index.js";

const tokenMarker = "distinctive-settings-token-marker";

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
  if (url === undefined) throw new Error("expected fetch to be called");
  return new URL(url);
}

function requestedBody(
  fetchMock: ReturnType<typeof vi.fn<FetchLike>>,
): Record<string, unknown> {
  const body = fetchMock.mock.calls[0]?.[1]?.body;
  if (typeof body !== "string") throw new Error("expected a JSON body");
  return JSON.parse(body) as Record<string, unknown>;
}

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("update_project_settings", () => {
  it("puts exactly the allowlisted settings with explicit query scoping", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      Response.json({
        mergeStrategy: "squash",
        autoMerge: false,
        githubTrackingDefaultRepo: "example/repo",
      }),
    );
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: tokenMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "update_project_settings",
        arguments: {
          projectId: "project-explicit",
          settings: {
            mergeStrategy: "squash",
            autoMerge: false,
            githubTrackingDefaultRepo: "example/repo",
          },
        },
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({
        settings: {
          mergeStrategy: "squash",
          autoMerge: false,
          githubTrackingDefaultRepo: "example/repo",
        },
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PUT");
      expect(requestedUrl(fetchMock).pathname).toBe("/api/settings");
      expect(requestedUrl(fetchMock).searchParams.get("projectId")).toBe(
        "project-explicit",
      );
      expect(requestedBody(fetchMock)).toEqual({
        mergeStrategy: "squash",
        autoMerge: false,
        githubTrackingDefaultRepo: "example/repo",
      });
    } finally {
      await harness.close();
    }
  });

  it("applies the configured default project to the query", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ pushAfterMerge: true }));
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: tokenMarker,
        FUSION_DEFAULT_PROJECT_ID: "project-default",
      }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "update_project_settings",
        arguments: { settings: { pushAfterMerge: true } },
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({
        settings: { pushAfterMerge: true },
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(requestedUrl(fetchMock).pathname).toBe("/api/settings");
      expect(requestedUrl(fetchMock).searchParams.get("projectId")).toBe(
        "project-default",
      );
      expect(requestedBody(fetchMock)).toEqual({ pushAfterMerge: true });
    } finally {
      await harness.close();
    }
  });

  it("accepts the strengthen-only planApprovalMode require-all value", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ planApprovalMode: "require-all" }));
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: tokenMarker,
        FUSION_DEFAULT_PROJECT_ID: "project-default",
      }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "update_project_settings",
        arguments: { settings: { planApprovalMode: "require-all" } },
      });

      expect(result.isError).not.toBe(true);
      expect(requestedBody(fetchMock)).toEqual({
        planApprovalMode: "require-all",
      });
    } finally {
      await harness.close();
    }
  });

  it("rejects planApprovalMode values other than require-all", async () => {
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
        name: "update_project_settings",
        arguments: { settings: { planApprovalMode: "require-none" } },
      });

      expect(result.isError).toBe(true);
      expect(textResult(result)).toMatchObject({
        error: { code: "validation", message: "Invalid tool arguments" },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it.each(["daemonToken", "providerConfig", "planApprovalMode"])(
    "rejects the unknown %s key without exposing it or calling fetch",
    async (unknownKey) => {
      const secretValue = "distinctive-forbidden-setting-value";
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
          name: "update_project_settings",
          arguments: {
            settings: { mergeStrategy: "squash", [unknownKey]: secretValue },
          },
        });
        const serialized = JSON.stringify(result);

        expect(result.isError).toBe(true);
        expect(textResult(result)).toMatchObject({
          error: { code: "validation", message: "Invalid tool arguments" },
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(serialized).not.toContain(secretValue);
      } finally {
        await harness.close();
      }
    },
  );

  it("rejects an empty settings object before calling fetch", async () => {
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
        name: "update_project_settings",
        arguments: { settings: {} },
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

  it("redacts credential-bearing keys echoed in the upstream response", async () => {
    const echoedCredential = "distinctive-echoed-credential-marker";
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      Response.json({
        mergeStrategy: "squash",
        daemonToken: echoedCredential,
        nested: { providerSecret: echoedCredential },
      }),
    );
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: tokenMarker,
        FUSION_DEFAULT_PROJECT_ID: "project-default",
      }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "update_project_settings",
        arguments: { settings: { mergeStrategy: "squash" } },
      });
      const serialized = JSON.stringify(result);

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({
        settings: {
          mergeStrategy: "squash",
          daemonToken: "[REDACTED]",
          nested: { providerSecret: "[REDACTED]" },
        },
      });
      expect(serialized).not.toContain(echoedCredential);
    } finally {
      await harness.close();
    }
  });

  it("audits the tool call to stderr with keys but without the token", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ autoMerge: true }));
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: tokenMarker,
        FUSION_DEFAULT_PROJECT_ID: "project-default",
      }),
      fetchMock,
    );

    try {
      await harness.client.callTool({
        name: "update_project_settings",
        arguments: { settings: { autoMerge: true, mergeStrategy: "squash" } },
      });

      expect(stderr).toHaveBeenCalledOnce();
      expect(stderr.mock.calls[0]?.[0]).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T[^\]]+Z\] tool=update_project_settings projectIdApplied=true keys=autoMerge,mergeStrategy\n$/,
      );
      expect(stderr.mock.calls.flat().join(" ")).not.toContain(tokenMarker);
    } finally {
      await harness.close();
    }
  });

  it("rejects unresolved scope instead of reaching global settings", async () => {
    // A settings write with neither an explicit projectId nor a configured
    // default must be rejected before any request: an unscoped PUT would target
    // global settings instead of a project.
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: tokenMarker }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "update_project_settings",
        arguments: { settings: { pushAfterMerge: true } },
      });

      expect(result.isError).toBe(true);
      expect(textResult(result)).toMatchObject({
        error: {
          code: "validation",
          message: "Invalid tool arguments",
          details: [
            {
              path: ["projectId"],
              message:
                "projectId is required when FUSION_DEFAULT_PROJECT_ID is not configured",
            },
          ],
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("audits the rejected unresolved-scope call as a validation failure", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: tokenMarker }),
      fetchMock,
    );

    try {
      await harness.client.callTool({
        name: "update_project_settings",
        arguments: { settings: { autoMerge: false } },
      });

      expect(stderr).toHaveBeenCalledOnce();
      expect(stderr.mock.calls[0]?.[0]).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T[^\]]+Z\] tool=update_project_settings validation=failed\n$/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });
});

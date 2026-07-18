import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig, type Config } from "./config.js";
import {
  FusionClient,
  type FetchLike,
  type FusionResponse,
} from "./fusion-client.js";
import { buildServer, type BuildServerOptions } from "./index.js";
import type { ToolErrorEnvelope } from "./tool-error.js";

const tokenMarker = "distinctive-fake-token-marker";
const unsafeMarker = "distinctive-body-or-stack-marker";

async function createHarness(
  config: Config,
  options: BuildServerOptions,
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(config, options);
  const client = new Client({ name: "tool-error-test", version: "1.0.0" });

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

function errorEnvelope(result: unknown): ToolErrorEnvelope {
  if (
    typeof result !== "object" ||
    result === null ||
    !("isError" in result) ||
    result.isError !== true ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    throw new Error("expected MCP tool error result");
  }
  const item: unknown = result.content[0];
  if (
    typeof item !== "object" ||
    item === null ||
    !("type" in item) ||
    item.type !== "text" ||
    !("text" in item) ||
    typeof item.text !== "string"
  ) {
    throw new Error("expected text tool error result");
  }
  return JSON.parse(item.text) as ToolErrorEnvelope;
}

class UnexpectedSettingsClient extends FusionClient {
  override getSettings(): Promise<FusionResponse<unknown>> {
    const error = new Error(`${unsafeMarker} ${tokenMarker}`);
    error.stack = `${unsafeMarker}\n${tokenMarker}`;
    throw error;
  }
}

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("governed tool error envelopes", () => {
  // Every registration uses the same wrapper/registry helper, so future write
  // handlers receive the same contract without handler-specific error code.
  it("normalizes input validation before dispatch without echoing values", async () => {
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: tokenMarker }),
      { fetch: fetchMock },
    );

    try {
      const result = await harness.client.callTool({
        name: "get_task",
        arguments: { id: { supplied: unsafeMarker } },
      });
      const parsed = errorEnvelope(result);

      expect(parsed.error.code).toBe("validation");
      expect(parsed.error).not.toHaveProperty("status");
      expect(parsed.error.details).toEqual([
        { path: ["id"], message: "Invalid input: expected string, received object" },
      ]);
      expect(JSON.stringify(result)).not.toContain(unsafeMarker);
      expect(JSON.stringify(result)).not.toContain(tokenMarker);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("returns missing_token before an authenticated list request fetches", async () => {
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(parseConfig({}), { fetch: fetchMock });

    try {
      const result = await harness.client.callTool({
        name: "list_tasks",
        arguments: {},
      });
      const parsed = errorEnvelope(result);

      expect(parsed.error).toEqual({
        code: "missing_token",
        message: "Authentication token is required",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("returns upstream_error with status and redacts body and token", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(unsafeMarker, { status: 502 }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: tokenMarker }),
      { fetch: fetchMock },
    );

    try {
      const result = await harness.client.callTool({
        name: "get_task",
        arguments: { id: "FN-502" },
      });
      const parsed = errorEnvelope(result);

      expect(parsed.error).toMatchObject({
        code: "upstream_error",
        status: 502,
        details: { method: "GET", path: "/api/tasks/FN-502" },
      });
      const rendered = JSON.stringify(result);
      expect(rendered).not.toContain(unsafeMarker);
      expect(rendered).not.toContain(tokenMarker);
    } finally {
      await harness.close();
    }
  });

  it("returns timeout without status", async () => {
    const fetchMock = vi.fn<FetchLike>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException(unsafeMarker, "AbortError"));
          });
        }),
    );
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: tokenMarker,
        FUSION_REQUEST_TIMEOUT_MS: "1",
      }),
      { fetch: fetchMock },
    );

    try {
      const result = await harness.client.callTool({
        name: "read_project_settings",
        arguments: {},
      });
      const parsed = errorEnvelope(result);

      expect(parsed.error.code).toBe("timeout");
      expect(parsed.error).not.toHaveProperty("status");
      const rendered = JSON.stringify(result);
      expect(rendered).not.toContain(unsafeMarker);
      expect(rendered).not.toContain(tokenMarker);
    } finally {
      await harness.close();
    }
  });

  it("returns invalid_upstream_payload for malformed successful JSON", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(`{${unsafeMarker}`, { status: 200 }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: tokenMarker }),
      { fetch: fetchMock },
    );

    try {
      const result = await harness.client.callTool({
        name: "read_project_settings",
        arguments: {},
      });
      const parsed = errorEnvelope(result);

      expect(parsed.error).toMatchObject({
        code: "invalid_upstream_payload",
        status: 200,
      });
      const rendered = JSON.stringify(result);
      expect(rendered).not.toContain(unsafeMarker);
      expect(rendered).not.toContain(tokenMarker);
    } finally {
      await harness.close();
    }
  });

  it("returns a generic internal envelope for an unexpected handler throw", async () => {
    const config = parseConfig({ FUSION_TOKEN: tokenMarker });
    const client = new UnexpectedSettingsClient(config, vi.fn<FetchLike>());
    const harness = await createHarness(config, { client });

    try {
      const result = await harness.client.callTool({
        name: "read_project_settings",
        arguments: {},
      });

      expect(errorEnvelope(result)).toEqual({
        error: { code: "internal", message: "Internal error" },
      });
      const rendered = JSON.stringify(result);
      expect(rendered).not.toContain(unsafeMarker);
      expect(rendered).not.toContain(tokenMarker);
    } finally {
      await harness.close();
    }
  });
});

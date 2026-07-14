import type { RequestListener } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig, type Config } from "./config.js";
import type { FetchLike } from "./fusion-client.js";
import {
  buildServer,
  startHttpServer,
  type HttpServerLike,
  type RuntimeDependencies,
} from "./index.js";

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

function transportStub(handleRequest = vi.fn()) {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    handleRequest,
  } as unknown as Transport & {
    handleRequest: typeof handleRequest;
  };
}

function httpFactoryHarness() {
  let listener: RequestListener | undefined;
  const server = {} as HttpServerLike;
  server.once = vi.fn().mockReturnValue(server);
  server.listen = vi
    .fn()
    .mockImplementation(
      (_port: number, _hostname: string, callback: () => void) => {
        callback();
        return server;
      },
    );

  return {
    factory: vi.fn((requestListener: RequestListener) => {
      listener = requestListener;
      return server;
    }),
    getListener(): RequestListener {
      if (listener === undefined) {
        throw new Error("HTTP listener was not created");
      }
      return listener;
    },
  };
}

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HTTP trusted hosts", () => {
  it("accepts an explicitly trusted tunnel Host and still rejects other Hosts", async () => {
    const http = httpFactoryHarness();
    const processed = vi.fn();
    const httpTransportFactory: NonNullable<
      RuntimeDependencies["httpTransportFactory"]
    > = vi.fn((options) => {
      const handleRequest = vi.fn(async (request, response) => {
        if (!options.allowedHosts?.includes(request.headers.host ?? "")) {
          response.statusCode = 403;
          response.end("Invalid Host header");
          return;
        }
        processed();
        response.end();
      });
      return transportStub(handleRequest);
    });
    const mcpServer = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    await startHttpServer(parseConfig({ PORT: "4242" }), {
      env: {
        FUSION_MCP_ALLOWED_HOSTS:
          "mcp.example.test,mcp-alt.example.test:8443",
      },
      httpServerFactory: http.factory,
      httpTransportFactory,
      serverFactory: () => mcpServer,
    });

    const trustedResponse = {
      headersSent: false,
      statusCode: 200,
      end: vi.fn(),
    };
    const rejectedResponse = {
      headersSent: false,
      statusCode: 200,
      end: vi.fn(),
    };
    http.getListener()(
      { url: "/mcp", headers: { host: "mcp.example.test" } } as never,
      trustedResponse as never,
    );
    http.getListener()(
      { url: "/mcp", headers: { host: "untrusted.example.test" } } as never,
      rejectedResponse as never,
    );

    await vi.waitFor(() => {
      expect(trustedResponse.end).toHaveBeenCalledOnce();
      expect(rejectedResponse.end).toHaveBeenCalledWith("Invalid Host header");
    });
    expect(processed).toHaveBeenCalledOnce();
    expect(trustedResponse.statusCode).toBe(200);
    expect(rejectedResponse.statusCode).toBe(403);
    expect(httpTransportFactory).toHaveBeenCalledWith({
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [
        "127.0.0.1:4242",
        "mcp.example.test",
        "mcp-alt.example.test:8443",
      ],
    });
  });

  it("rejects malformed trusted-host configuration before listening", async () => {
    const http = httpFactoryHarness();

    await expect(
      startHttpServer(parseConfig({ PORT: "4242" }), {
        env: { FUSION_MCP_ALLOWED_HOSTS: "https://mcp.example.test/path" },
        httpServerFactory: http.factory,
      }),
    ).rejects.toThrow(
      "FUSION_MCP_ALLOWED_HOSTS must be a comma-separated list of exact Host values",
    );
    expect(http.factory).not.toHaveBeenCalled();
  });
});

describe("get_task", () => {
  it("returns a task and applies an explicit project", async () => {
    const task = { id: "FN-123", title: "Inspect task", column: "todo" };
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(Response.json(task));
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: secretMarker,
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "get_task",
        arguments: { id: "FN-123", projectId: "explicit-project" },
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({ task });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
      const url = requestedUrl(fetchMock);
      expect(url.pathname).toBe("/api/tasks/FN-123");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        projectId: "explicit-project",
      });
      const auditOutput = vi
        .mocked(process.stderr.write)
        .mock.calls.map(([line]) => String(line))
        .join("");
      expect(auditOutput).toContain(
        "tool=get_task id=FN-123 projectIdApplied=true",
      );
      expect(auditOutput).not.toContain("explicit-project");
      expect(auditOutput).not.toContain(secretMarker);
      expect(JSON.stringify(result)).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });

  it("falls back to the configured default project", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ id: "FN-124" }));
    const harness = await createHarness(
      parseConfig({
        FUSION_TOKEN: secretMarker,
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      }),
      fetchMock,
    );

    try {
      await harness.client.callTool({
        name: "get_task",
        arguments: { id: "FN-124" },
      });

      expect(requestedUrl(fetchMock).searchParams.get("projectId")).toBe(
        "default-project",
      );
    } finally {
      await harness.close();
    }
  });

  it("omits projectId when no explicit or default project exists", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ id: "FN-125" }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      await harness.client.callTool({
        name: "get_task",
        arguments: { id: "FN-125" },
      });

      expect(requestedUrl(fetchMock).search).toBe("");
    } finally {
      await harness.close();
    }
  });

  it("URL-encodes the task id as one path segment", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ id: "task/with space" }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: secretMarker }),
      fetchMock,
    );

    try {
      await harness.client.callTool({
        name: "get_task",
        arguments: { id: "task/with space" },
      });

      expect(requestedUrl(fetchMock).pathname).toBe(
        "/api/tasks/task%2Fwith%20space",
      );
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
          name: "get_task",
          arguments: id === undefined ? {} : { id },
        });
        const rendered = JSON.stringify(result);

        expect(result.isError).toBe(true);
        expect(rendered).toContain("id");
        expect(rendered).not.toContain(secretMarker);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(process.stderr.write).not.toHaveBeenCalled();
      } finally {
        await harness.close();
      }
    },
  );

  it("surfaces an upstream failure without response or token details", async () => {
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
        name: "get_task",
        arguments: { id: "FN-404" },
      });
      const rendered = JSON.stringify(result);

      expect(result.isError).toBe(true);
      expect(rendered).toContain(
        "Fusion request failed: GET /api/tasks/FN-404 (status 404)",
      );
      expect(rendered).not.toContain(responseMarker);
      expect(rendered).not.toContain(secretMarker);
    } finally {
      await harness.close();
    }
  });
});

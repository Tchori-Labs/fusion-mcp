import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseConfig } from "./config.js";
import {
  isDirectExecution,
  main,
  runCli,
  selectMode,
  startHttpServer,
  type HttpServerLike,
  type RuntimeDependencies,
} from "./index.js";

const testConfig = parseConfig({ PORT: "4242" });

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "index-test", version: "1.0.0" },
  },
};

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

function serverStub(connect = vi.fn().mockResolvedValue(undefined)) {
  return {
    connect,
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function httpFactoryHarness() {
  let listener: RequestListener | undefined;
  const once = vi.fn();
  const listen = vi.fn();
  const close = vi.fn();
  const server = { once, listen, close } as unknown as HttpServerLike;
  once.mockReturnValue(server);
  listen.mockImplementation(
    (_port: number, _hostname: string, callback: () => void) => {
      callback();
      return server;
    },
  );
  close.mockImplementation((callback: (error?: Error) => void) => {
    callback();
    return server;
  });
  const factory = vi.fn((requestListener: RequestListener) => {
    listener = requestListener;
    return server;
  });

  return {
    factory,
    server,
    once,
    listen,
    close,
    getListener(): RequestListener {
      if (listener === undefined) {
        throw new Error("HTTP listener was not created");
      }
      return listener;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mode selection", () => {
  it("selects stdio by default and when explicit", () => {
    expect(selectMode([])).toBe("stdio");
    expect(selectMode(["--stdio"])).toBe("stdio");
  });

  it("selects HTTP when explicit", () => {
    expect(selectMode(["--http"])).toBe("http");
  });

  it("rejects conflicting and unknown arguments", () => {
    expect(() => selectMode(["--stdio", "--http"])).toThrow(
      "--stdio and --http cannot be used together",
    );
    expect(() => selectMode(["--other"])).toThrow(
      "unknown argument: --other",
    );
    expect(() => selectMode(["--stdio", "--other"])).toThrow(
      "unknown argument: --other",
    );
  });

  it("recognizes that a test import is not direct CLI execution", () => {
    expect(
      isDirectExecution(import.meta.url, ["node", "/different/module.js"]),
    ).toBe(false);
  });

  it("recognizes execution through a package-manager bin symlink", () => {
    const directory = mkdtempSync(join(tmpdir(), "fusion-mcp-bin-"));
    try {
      const entrypoint = join(directory, "index.js");
      writeFileSync(entrypoint, "");
      const binSymlink = join(directory, "fusion-mcp");
      symlinkSync(entrypoint, binSymlink);
      const moduleUrl = pathToFileURL(realpathSync(entrypoint)).href;

      expect(isDirectExecution(moduleUrl, ["node", binSymlink])).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not treat a nonexistent entry path as direct execution", () => {
    expect(
      isDirectExecution(import.meta.url, ["node", "/does/not/exist.js"]),
    ).toBe(false);
  });
});

describe("main", () => {
  it.each([{ args: [] }, { args: ["--stdio"] }])(
    "connects stdio mode without constructing HTTP for args $args",
    async ({ args }) => {
      const transport = transportStub();
      const server = serverStub();
      const httpServerFactory = vi.fn();

      await main(args, {
        config: testConfig,
        serverFactory: vi.fn(() => server),
        stdioTransportFactory: () => transport,
        httpServerFactory,
      });

      expect(server.connect).toHaveBeenCalledOnce();
      expect(server.connect).toHaveBeenCalledWith(transport);
      expect(httpServerFactory).not.toHaveBeenCalled();
    },
  );

  it("reports invalid arguments only to stderr", async () => {
    const stderr = { write: vi.fn().mockReturnValue(true) };
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(
      runCli(["--unknown"], { config: testConfig, stderr }),
    ).resolves.toBe(1);

    expect(stderr.write).toHaveBeenCalledWith(
      "fusion-mcp: unknown argument: --unknown\n",
    );
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe("session-aware HTTP mode", () => {
  it("listens only on loopback and builds no MCP server before initialize", async () => {
    const http = httpFactoryHarness();
    const serverFactory = vi.fn();

    const handle = await startHttpServer(testConfig, {
      httpServerFactory: http.factory,
      serverFactory,
    });

    expect(http.listen).toHaveBeenCalledWith(
      4242,
      "127.0.0.1",
      expect.any(Function),
    );
    expect(http.once).toHaveBeenCalledWith("error", expect.any(Function));
    expect(serverFactory).not.toHaveBeenCalled();
    await handle.shutdown();
    expect(http.close).toHaveBeenCalledOnce();
  });

  it("constructs one stateful transport and reuses it by session id", async () => {
    const http = httpFactoryHarness();
    const handleRequest = vi.fn();
    const transport = transportStub(handleRequest);
    const httpTransportFactory: NonNullable<
      RuntimeDependencies["httpTransportFactory"]
    > = vi.fn((options) => {
      handleRequest.mockImplementation(
        async (_request, response, parsedBody?: unknown) => {
          if (parsedBody !== undefined) {
            await options.onsessioninitialized?.("index-session");
          }
          response.end();
        },
      );
      return transport;
    });
    const server = serverStub();
    const serverFactory = vi.fn(() => server);

    const handle = await startHttpServer(testConfig, {
      httpServerFactory: http.factory,
      httpTransportFactory,
      httpRequestBodyParser: vi.fn().mockResolvedValue(initializeRequest),
      serverFactory,
    });
    const initializationResponse = {
      headersSent: false,
      statusCode: 200,
      end: vi.fn(),
    };
    const followUpResponse = {
      headersSent: false,
      statusCode: 200,
      end: vi.fn(),
    };

    http.getListener()(
      {
        url: "/mcp",
        method: "POST",
        headers: { host: "127.0.0.1:4242" },
      } as never,
      initializationResponse as never,
    );
    await vi.waitFor(() =>
      expect(initializationResponse.end).toHaveBeenCalledOnce(),
    );
    http.getListener()(
      {
        url: "/mcp",
        method: "POST",
        headers: {
          host: "127.0.0.1:4242",
          "mcp-session-id": "index-session",
        },
      } as never,
      followUpResponse as never,
    );

    await vi.waitFor(() => expect(handleRequest).toHaveBeenCalledTimes(2));
    expect(serverFactory).toHaveBeenCalledOnce();
    expect(httpTransportFactory).toHaveBeenCalledOnce();
    expect(httpTransportFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionIdGenerator: expect.any(Function),
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: ["127.0.0.1:4242"],
      }),
    );
    expect(server.connect).toHaveBeenCalledWith(transport);
    expect(handleRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          "mcp-session-id": "index-session",
        }),
      }),
      followUpResponse,
    );
    await handle.shutdown();
  });

  it("serves no endpoint other than /mcp", async () => {
    const http = httpFactoryHarness();
    const serverFactory = vi.fn();
    const handle = await startHttpServer(testConfig, {
      httpServerFactory: http.factory,
      serverFactory,
    });
    const response = {
      headersSent: false,
      statusCode: 200,
      end: vi.fn(),
    };

    http.getListener()({ url: "/health" } as never, response as never);

    await vi.waitFor(() => expect(response.end).toHaveBeenCalledOnce());
    expect(response.statusCode).toBe(404);
    expect(serverFactory).not.toHaveBeenCalled();
    await handle.shutdown();
  });

  it("normalizes HTTP dispatch diagnostics without unsafe details", async () => {
    const marker = "unsafe-http-marker";
    const http = httpFactoryHarness();
    const server = serverStub(vi.fn().mockRejectedValue(new Error(marker)));
    const stderr = { write: vi.fn().mockReturnValue(true) };
    const response = {
      headersSent: false,
      statusCode: 200,
      end: vi.fn(),
    };
    const dependencies: RuntimeDependencies = {
      httpServerFactory: http.factory,
      httpTransportFactory: () => transportStub(),
      httpRequestBodyParser: vi.fn().mockResolvedValue(initializeRequest),
      serverFactory: () => server,
      stderr,
    };
    const handle = await startHttpServer(testConfig, dependencies);

    http.getListener()(
      {
        url: "/mcp",
        method: "POST",
        headers: { host: "127.0.0.1:4242" },
      } as never,
      response as never,
    );

    await vi.waitFor(() => expect(response.end).toHaveBeenCalledOnce());
    expect(response.statusCode).toBe(500);
    expect(response.end).toHaveBeenCalledWith("MCP request failed");
    expect(JSON.stringify(stderr.write.mock.calls)).not.toContain(marker);
    await handle.shutdown();
  });
});

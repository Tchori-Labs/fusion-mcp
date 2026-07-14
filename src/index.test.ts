import type { RequestListener } from "node:http";

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
  const server = { once, listen } as unknown as HttpServerLike;
  once.mockReturnValue(server);
  listen.mockImplementation(
    (_port: number, _hostname: string, callback: () => void) => {
      callback();
      return server;
    },
  );
  const factory = vi.fn((requestListener: RequestListener) => {
    listener = requestListener;
    return server;
  });

  return {
    factory,
    server,
    once,
    listen,
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

describe("minimal stateless HTTP mode", () => {
  it("listens only on loopback and does not build an MCP server at startup", async () => {
    const http = httpFactoryHarness();
    const serverFactory = vi.fn();

    await startHttpServer(testConfig, {
      httpServerFactory: http.factory,
      serverFactory,
    });

    expect(http.listen).toHaveBeenCalledWith(4242, "127.0.0.1", expect.any(Function));
    expect(http.once).toHaveBeenCalledWith("error", expect.any(Function));
    expect(serverFactory).not.toHaveBeenCalled();
  });

  it("constructs a fresh stateless JSON transport and server per MCP request", async () => {
    const http = httpFactoryHarness();
    const handleRequest = vi.fn().mockResolvedValue(undefined);
    const transport = transportStub(handleRequest);
    const httpTransportFactory = vi.fn(() => transport);
    const firstServer = serverStub();
    const secondServer = serverStub();
    const serverFactory = vi
      .fn()
      .mockReturnValueOnce(firstServer)
      .mockReturnValueOnce(secondServer);

    await startHttpServer(testConfig, {
      httpServerFactory: http.factory,
      httpTransportFactory,
      serverFactory,
    });

    const request = { url: "/mcp" };
    const response = {
      headersSent: false,
      statusCode: 200,
      end: vi.fn(),
    };
    http.getListener()(request as never, response as never);
    http.getListener()(request as never, response as never);

    await vi.waitFor(() => {
      expect(handleRequest).toHaveBeenCalledTimes(2);
      expect(firstServer.close).toHaveBeenCalledOnce();
      expect(secondServer.close).toHaveBeenCalledOnce();
    });
    expect(serverFactory).toHaveBeenCalledTimes(2);
    expect(httpTransportFactory).toHaveBeenCalledTimes(2);
    expect(httpTransportFactory).toHaveBeenCalledWith({
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: ["127.0.0.1:4242"],
    });
    expect(firstServer.connect).toHaveBeenCalledWith(transport);
    expect(handleRequest).toHaveBeenCalledWith(request, response);
  });

  it("allows the bound loopback Host and rejects a foreign Host", async () => {
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
      });
      return transportStub(handleRequest);
    });

    await startHttpServer(testConfig, {
      httpServerFactory: http.factory,
      httpTransportFactory,
      serverFactory: () => serverStub(),
    });

    const allowedResponse = {
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
      {
        url: "/mcp",
        headers: { host: "127.0.0.1:4242" },
      } as never,
      allowedResponse as never,
    );
    http.getListener()(
      {
        url: "/mcp",
        headers: { host: "attacker.invalid" },
      } as never,
      rejectedResponse as never,
    );

    await vi.waitFor(() => {
      expect(httpTransportFactory).toHaveBeenCalledTimes(2);
      expect(rejectedResponse.end).toHaveBeenCalledWith("Invalid Host header");
    });
    expect(processed).toHaveBeenCalledOnce();
    expect(allowedResponse.statusCode).toBe(200);
    expect(rejectedResponse.statusCode).toBe(403);
    expect(httpTransportFactory).toHaveBeenCalledWith({
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: ["127.0.0.1:4242"],
    });
  });

  it("serves no endpoint other than /mcp", async () => {
    const http = httpFactoryHarness();
    const serverFactory = vi.fn();
    await startHttpServer(testConfig, {
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
  });

  it("normalizes HTTP dispatch diagnostics without unsafe details", async () => {
    const marker = "unsafe-http-marker";
    const http = httpFactoryHarness();
    const server = serverStub(
      vi.fn().mockRejectedValue(new Error(marker)),
    );
    const stderr = { write: vi.fn().mockReturnValue(true) };
    const response = {
      headersSent: false,
      statusCode: 200,
      end: vi.fn(),
    };
    const dependencies: RuntimeDependencies = {
      httpServerFactory: http.factory,
      httpTransportFactory: () => transportStub(),
      serverFactory: () => server,
      stderr,
    };
    await startHttpServer(testConfig, dependencies);

    http.getListener()({ url: "/mcp" } as never, response as never);

    await vi.waitFor(() => expect(response.end).toHaveBeenCalledOnce());
    expect(response.statusCode).toBe(500);
    expect(response.end).toHaveBeenCalledWith("MCP request failed");
    expect(JSON.stringify(stderr.write.mock.calls)).not.toContain(marker);
  });
});

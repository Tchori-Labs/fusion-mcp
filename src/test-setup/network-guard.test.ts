import * as dns from "node:dns";
import * as net from "node:net";
import * as tls from "node:tls";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { parseConfig } from "../config.js";
import type { FetchLike } from "../fusion-client.js";
import { buildServer } from "../index.js";
import {
  HERMETIC_NETWORK_ERROR_MESSAGE,
  HermeticNetworkError,
} from "./network-guard.js";

const unusedPort = 65_534;
const loopbackHost = "127.0.0.1";

function rethrowGuardCause<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((error: unknown) => {
    let current: unknown = error;
    while (current instanceof Error) {
      if (current instanceof HermeticNetworkError) {
        throw current;
      }
      current = current.cause;
    }
    throw error;
  });
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
    !("text" in content) ||
    typeof content.text !== "string"
  ) {
    throw new Error("expected a text tool result");
  }
  return JSON.parse(content.text) as unknown;
}

describe("hermetic network guard", () => {
  it("blocks every raw TCP connection entry point synchronously", () => {
    const attempts = [
      () => new net.Socket().connect(unusedPort, loopbackHost),
      () => net.connect(unusedPort, loopbackHost),
      () => net.createConnection({ host: "192.0.2.1", port: unusedPort }),
    ];

    for (const attempt of attempts) {
      expect(attempt).toThrow(HermeticNetworkError);
      expect(attempt).toThrow(/Hermetic test guard/);
    }
  });

  it("blocks TLS connections synchronously", () => {
    expect(() =>
      tls.connect({ host: loopbackHost, port: unusedPort }),
    ).toThrow(HermeticNetworkError);
  });

  it("blocks callback and promise DNS lookup and resolve paths", async () => {
    expect(() => dns.lookup("example.invalid", () => undefined)).toThrow(
      HermeticNetworkError,
    );
    expect(() => dns.resolve4("example.invalid", () => undefined)).toThrow(
      HermeticNetworkError,
    );
    await expect(dns.promises.lookup("example.invalid")).rejects.toThrow(
      HermeticNetworkError,
    );
    await expect(dns.promises.resolve4("example.invalid")).rejects.toThrow(
      HermeticNetworkError,
    );
  });

  it.each([
    ["HTTP", `http://${loopbackHost}:${unusedPort}/`, "TCP connect"],
    ["HTTPS", `https://${loopbackHost}:${unusedPort}/`, "TLS connect"],
  ])("blocks %s fetch transitively at the socket layer", async (_name, url, operation) => {
    await expect(rethrowGuardCause(fetch(url))).rejects.toThrow(
      new RegExp(`Hermetic test guard.*Attempted ${operation}`),
    );
  });

  it("uses a stable, controlled, non-sensitive error message", () => {
    const error = new HermeticNetworkError("TCP connect");

    expect(error.message).toBe(
      `${HERMETIC_NETWORK_ERROR_MESSAGE} Attempted TCP connect.`,
    );
    expect(error.message).not.toMatch(/token|secret|company/i);
  });

  it("leaves injected fetch and in-memory MCP transport untouched", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ status: "ok" }));
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = buildServer(parseConfig({}), { fetch: fetchMock });
    const client = new Client({ name: "network-guard-test", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "get_board_health",
        arguments: {},
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({ health: { status: "ok" } });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfig, type Config, type Environment } from "./config.js";
import type { FetchLike } from "./fusion-client.js";
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

function requestDetails(fetchMock: ReturnType<typeof vi.fn<FetchLike>>) {
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  if (url === undefined || init?.body === undefined) {
    throw new Error("expected fetch request with a body");
  }
  return {
    url: new URL(url),
    method: init.method,
    body: JSON.parse(String(init.body)) as unknown,
  };
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

describe("comment_task", () => {
  it("posts text to an encoded task path without an author key", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ id: "comment-1" }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: "fake-token-marker" }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "comment_task",
        arguments: { id: "FN/013 ?", text: "A useful comment" },
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({ comment: { id: "comment-1" } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const request = requestDetails(fetchMock);
      expect(request.method).toBe("POST");
      expect(request.url.pathname).toBe("/api/tasks/FN%2F013%20%3F/comments");
      expect(request.body).toEqual({ text: "A useful comment" });
      expect(request.body).not.toHaveProperty("author");
    } finally {
      await harness.close();
    }
  });

  it("includes an explicitly provided author", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ accepted: true }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: "fake-token-marker" }),
      fetchMock,
    );

    try {
      await harness.client.callTool({
        name: "comment_task",
        arguments: {
          id: "FN-013",
          text: "A useful comment",
          author: "reviewer",
        },
      });

      expect(requestDetails(fetchMock).body).toEqual({
        text: "A useful comment",
        author: "reviewer",
      });
    } finally {
      await harness.close();
    }
  });

  it.each([
    {
      label: "explicit project over configured default",
      env: {
        FUSION_TOKEN: "fake-token-marker",
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      },
      arguments: {
        id: "FN-013",
        text: "A useful comment",
        author: "reviewer",
        projectId: "explicit-project",
      },
      expectedProjectId: "explicit-project",
    },
    {
      label: "configured default project",
      env: {
        FUSION_TOKEN: "fake-token-marker",
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      },
      arguments: {
        id: "FN-013",
        text: "A useful comment",
        author: "reviewer",
      },
      expectedProjectId: "default-project",
    },
    {
      label: "server default project",
      env: { FUSION_TOKEN: "fake-token-marker" },
      arguments: {
        id: "FN-013",
        text: "A useful comment",
        author: "reviewer",
      },
      expectedProjectId: undefined,
    },
  ] satisfies Array<{
    label: string;
    env: Environment;
    arguments: {
      id: string;
      text: string;
      author: string;
      projectId?: string;
    };
    expectedProjectId: string | undefined;
  }>) (
    "applies $label scope in the comment body",
    async ({ env, arguments: toolArguments, expectedProjectId }) => {
      const fetchMock = vi
        .fn<FetchLike>()
        .mockResolvedValue(Response.json({ accepted: true }));
      const harness = await createHarness(parseConfig(env), fetchMock);

      try {
        const result = await harness.client.callTool({
          name: "comment_task",
          arguments: toolArguments,
        });

        expect(result.isError).not.toBe(true);
        const body = requestDetails(fetchMock).body;
        expect(body).toEqual({
          text: "A useful comment",
          author: "reviewer",
          ...(expectedProjectId === undefined
            ? {}
            : { projectId: expectedProjectId }),
        });
        if (expectedProjectId === undefined) {
          expect(body).not.toHaveProperty("projectId");
        }
        expect(auditOutput()).toContain(
          `projectIdApplied=${String(expectedProjectId !== undefined)}`,
        );
        expect(auditOutput()).not.toContain("explicit-project");
        expect(auditOutput()).not.toContain("default-project");
      } finally {
        await harness.close();
      }
    },
  );

  it.each([
    ["missing id", { text: "comment" }],
    ["missing text", { id: "FN-013" }],
    ["empty text", { id: "FN-013", text: "" }],
  ])("rejects %s before making a request", async (_name, arguments_) => {
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: "fake-token-marker" }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "comment_task",
        arguments: arguments_,
      });

      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });
});

describe("steer_task", () => {
  it.each([
    ["one character", "x"],
    ["two thousand characters", "s".repeat(2000)],
  ])("posts %s unchanged", async (_name, text) => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ accepted: true }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: "fake-token-marker" }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "steer_task",
        arguments: { id: "FN/013", text },
      });

      expect(result.isError).not.toBe(true);
      expect(textResult(result)).toEqual({ steered: { accepted: true } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const request = requestDetails(fetchMock);
      expect(request.method).toBe("POST");
      expect(request.url.pathname).toBe("/api/tasks/FN%2F013/steer");
      expect(request.body).toEqual({ text });
    } finally {
      await harness.close();
    }
  });

  it.each([
    {
      label: "explicit project over configured default",
      env: {
        FUSION_TOKEN: "fake-token-marker",
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      },
      arguments: {
        id: "FN-013",
        text: "Steer safely",
        projectId: "explicit-project",
      },
      expectedProjectId: "explicit-project",
    },
    {
      label: "configured default project",
      env: {
        FUSION_TOKEN: "fake-token-marker",
        FUSION_DEFAULT_PROJECT_ID: "default-project",
      },
      arguments: { id: "FN-013", text: "Steer safely" },
      expectedProjectId: "default-project",
    },
    {
      label: "server default project",
      env: { FUSION_TOKEN: "fake-token-marker" },
      arguments: { id: "FN-013", text: "Steer safely" },
      expectedProjectId: undefined,
    },
  ] satisfies Array<{
    label: string;
    env: Environment;
    arguments: { id: string; text: string; projectId?: string };
    expectedProjectId: string | undefined;
  }>) (
    "applies $label scope in the steer body",
    async ({ env, arguments: toolArguments, expectedProjectId }) => {
      const fetchMock = vi
        .fn<FetchLike>()
        .mockResolvedValue(Response.json({ accepted: true }));
      const harness = await createHarness(parseConfig(env), fetchMock);

      try {
        const result = await harness.client.callTool({
          name: "steer_task",
          arguments: toolArguments,
        });

        expect(result.isError).not.toBe(true);
        const body = requestDetails(fetchMock).body;
        expect(body).toEqual({
          text: "Steer safely",
          ...(expectedProjectId === undefined
            ? {}
            : { projectId: expectedProjectId }),
        });
        if (expectedProjectId === undefined) {
          expect(body).not.toHaveProperty("projectId");
        }
        expect(auditOutput()).toContain(
          `projectIdApplied=${String(expectedProjectId !== undefined)}`,
        );
        expect(auditOutput()).not.toContain("explicit-project");
        expect(auditOutput()).not.toContain("default-project");
      } finally {
        await harness.close();
      }
    },
  );

  it.each([
    ["empty text", ""],
    ["text over the maximum", `rejected-${"x".repeat(1992)}`],
  ])("rejects %s without fetching or logging it", async (_name, text) => {
    expect(text).toHaveLength(text === "" ? 0 : 2001);
    const fetchMock = vi.fn<FetchLike>();
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: "fake-token-marker" }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "steer_task",
        arguments: { id: "FN-013", text },
      });

      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(auditOutput()).not.toContain(text || "rejected-");
    } finally {
      await harness.close();
    }
  });
});

describe("communication tool safety", () => {
  it.each([
    [
      "comment_task",
      { id: "FN-013", text: "comment-text-sentinel", author: "author-sentinel" },
    ],
    ["steer_task", { id: "FN-014", text: "steer-text-sentinel" }],
  ])("audits a successful %s call with the task id only", async (name, arguments_) => {
    const token = "FUSION_TOKEN_SENTINEL";
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ accepted: true }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: token }),
      fetchMock,
    );

    try {
      await harness.client.callTool({ name, arguments: arguments_ });

      expect(process.stderr.write).toHaveBeenCalledTimes(1);
      const output = auditOutput();
      expect(output).toMatch(
        new RegExp(
          `^\\[[^\\]]+\\] tool=${name} id=${arguments_.id} projectIdApplied=false\\n$`,
        ),
      );
      expect(output).not.toContain(arguments_.text);
      expect(output).not.toContain("author-sentinel");
      expect(output).not.toContain(token);
    } finally {
      await harness.close();
    }
  });

  it("surfaces a token-free FusionError without the upstream body", async () => {
    const token = "FUSION_TOKEN_SENTINEL";
    const upstreamMarker = "unsafe-upstream-response-marker";
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(upstreamMarker, { status: 503 }));
    const harness = await createHarness(
      parseConfig({ FUSION_TOKEN: token }),
      fetchMock,
    );

    try {
      const result = await harness.client.callTool({
        name: "steer_task",
        arguments: { id: "FN-013", text: "steer-text-sentinel" },
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
      expect(rendered).not.toContain(upstreamMarker);
      expect(rendered).not.toContain(token);
    } finally {
      await harness.close();
    }
  });
});

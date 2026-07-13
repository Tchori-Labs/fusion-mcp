import { afterEach, describe, expect, it, vi } from "vitest";

import { parseConfig, type Config } from "./config.js";
import {
  FusionClient,
  FusionError,
  type FetchLike,
} from "./fusion-client.js";

function config(overrides: Partial<Config> = {}): Config {
  return { ...parseConfig({}), ...overrides };
}

function calledInit(fetchMock: ReturnType<typeof vi.fn<FetchLike>>): RequestInit {
  const call = fetchMock.mock.calls[0];
  if (call === undefined) {
    throw new Error("fetch was not called");
  }
  return call[1] ?? {};
}

afterEach(() => {
  vi.useRealTimers();
});

describe("FusionClient", () => {
  it("keeps health auth-exempt even when a token exists", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      Response.json({ status: "ok" }),
    );
    const client = new FusionClient(
      config({ token: "test-secret-marker" }),
      fetchMock,
    );

    await expect(client.getHealth()).resolves.toMatchObject({
      data: { status: "ok" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4040/api/health",
      expect.objectContaining({ method: "GET" }),
    );
    expect(new Headers(calledInit(fetchMock).headers).has("authorization")).toBe(
      false,
    );
  });

  it("attaches bearer authorization to system info", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ version: "1.0" }));
    const client = new FusionClient(
      config({ token: "test-secret-marker" }),
      fetchMock,
    );

    await client.getSystemInfo();

    expect(new Headers(calledInit(fetchMock).headers).get("authorization")).toBe(
      "Bearer test-secret-marker",
    );
  });

  it("resolves paths, serializes query values, and drops undefined", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ items: [] }));
    const client = new FusionClient(config({ token: "placeholder" }), fetchMock);

    await client.request("GET", "/api/tasks", {
      query: {
        projectId: "project a",
        limit: 25,
        includeArchived: false,
        omitted: undefined,
      },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:4040/api/tasks?projectId=project+a&limit=25&includeArchived=false",
    );
  });

  it("encodes JSON bodies with the correct content type", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ created: true }));
    const client = new FusionClient(config({ token: "placeholder" }), fetchMock);

    await client.request("post", "/api/tasks", {
      body: { title: "A task" },
    });

    const init = calledInit(fetchMock);
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"title":"A task"}');
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("returns decoded data and response pagination headers", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      Response.json([{ id: "FN-1" }], {
        headers: {
          "x-total-count": "42",
          "x-has-more": "true",
        },
      }),
    );
    const client = new FusionClient(config({ token: "placeholder" }), fetchMock);

    const response = await client.request<Array<{ id: string }>>(
      "GET",
      "/api/tasks",
    );

    expect(response.data).toEqual([{ id: "FN-1" }]);
    expect(response.headers.get("x-total-count")).toBe("42");
    expect(response.headers.get("x-has-more")).toBe("true");
  });

  it("normalizes non-2xx responses without exposing response bodies", async () => {
    const marker = "unsafe-response-marker";
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(marker, { status: 503 }));
    const client = new FusionClient(config(), fetchMock);

    const error = await client.getHealth().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FusionError);
    expect(error).toMatchObject({
      method: "GET",
      path: "/api/health",
      status: 503,
    });
    expect(String(error)).not.toContain(marker);
  });

  it("normalizes malformed JSON without exposing response contents", async () => {
    const marker = "unsafe-json-marker";
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(`{${marker}`));
    const client = new FusionClient(config(), fetchMock);

    const error = await client.getHealth().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FusionError);
    expect(String(error)).toContain("Fusion returned invalid JSON");
    expect(String(error)).not.toContain(marker);
  });

  it("normalizes transport failures without exposing underlying errors", async () => {
    const marker = "unsafe-transport-marker";
    const fetchMock = vi
      .fn<FetchLike>()
      .mockRejectedValue(new Error(marker));
    const client = new FusionClient(config(), fetchMock);

    const error = await client.getHealth().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FusionError);
    expect(error).toMatchObject({ method: "GET", path: "/api/health" });
    expect(String(error)).not.toContain(marker);
  });

  it("aborts timed-out requests and clears the request timer", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<FetchLike>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const client = new FusionClient(config({ requestTimeoutMs: 10 }), fetchMock);

    const request = client.getHealth();
    const rejection = expect(request).rejects.toMatchObject({
      name: "FusionError",
      message: "Fusion request timed out: GET /api/health",
      method: "GET",
      path: "/api/health",
    });
    await vi.advanceTimersByTimeAsync(10);

    await rejection;
    expect(calledInit(fetchMock).signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never includes a configured secret in thrown or serialized errors", async () => {
    const marker = "distinctive-test-secret-marker";
    const fetchMock = vi
      .fn<FetchLike>()
      .mockRejectedValue(new Error(`upstream included ${marker}`));
    const client = new FusionClient(config({ token: marker }), fetchMock);

    const error = await client.getSystemInfo().catch((caught: unknown) => caught);
    const rendered = `${String(error)} ${JSON.stringify(error)}`;

    expect(error).toBeInstanceOf(FusionError);
    expect(rendered).not.toContain(marker);
  });
});

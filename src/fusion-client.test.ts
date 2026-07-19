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

  it("attaches edge and User-Agent headers to authenticated GET requests", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ version: "1.0" }));
    const client = new FusionClient(
      config({
        token: "bearer-secret-marker",
        cfAccessClientId: "access-client-marker",
        cfAccessClientSecret: "access-secret-marker",
        userAgent: "fusion-mcp-test-agent",
      }),
      fetchMock,
    );

    await client.getSystemInfo();

    const headers = new Headers(calledInit(fetchMock).headers);
    expect(headers.get("authorization")).toBe("Bearer bearer-secret-marker");
    expect(headers.get("CF-Access-Client-Id")).toBe("access-client-marker");
    expect(headers.get("CF-Access-Client-Secret")).toBe(
      "access-secret-marker",
    );
    expect(headers.get("User-Agent")).toBe("fusion-mcp-test-agent");
    expect(headers.has("content-type")).toBe(false);
  });

  it("attaches edge and User-Agent headers without changing POST headers", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ created: true }));
    const client = new FusionClient(
      config({
        token: "bearer-secret-marker",
        cfAccessClientId: "access-client-marker",
        cfAccessClientSecret: "access-secret-marker",
        userAgent: "fusion-mcp-test-agent",
      }),
      fetchMock,
    );

    await client.request("POST", "/api/tasks", { body: { title: "A task" } });

    const init = calledInit(fetchMock);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer bearer-secret-marker");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("CF-Access-Client-Id")).toBe("access-client-marker");
    expect(headers.get("CF-Access-Client-Secret")).toBe(
      "access-secret-marker",
    );
    expect(headers.get("User-Agent")).toBe("fusion-mcp-test-agent");
    expect(init.body).toBe('{"title":"A task"}');
  });

  it("attaches edge and User-Agent headers to auth-exempt health requests", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ status: "ok" }));
    const client = new FusionClient(
      config({
        token: "bearer-secret-marker",
        cfAccessClientId: "access-client-marker",
        cfAccessClientSecret: "access-secret-marker",
        userAgent: "fusion-mcp-test-agent",
      }),
      fetchMock,
    );

    await client.getHealth();

    const headers = new Headers(calledInit(fetchMock).headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.get("CF-Access-Client-Id")).toBe("access-client-marker");
    expect(headers.get("CF-Access-Client-Secret")).toBe(
      "access-secret-marker",
    );
    expect(headers.get("User-Agent")).toBe("fusion-mcp-test-agent");
  });

  it("omits edge and User-Agent headers when they are unconfigured", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(Response.json({ version: "1.0" }));
    const client = new FusionClient(config({ token: "placeholder" }), fetchMock);

    await client.getSystemInfo();

    const headers = new Headers(calledInit(fetchMock).headers);
    expect(headers.has("CF-Access-Client-Id")).toBe(false);
    expect(headers.has("CF-Access-Client-Secret")).toBe(false);
    expect(headers.has("User-Agent")).toBe(false);
  });

  it("preserves a configured base-URL path for both health call paths", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockImplementation(async () => Response.json({ status: "ok" }));
    const client = new FusionClient(
      parseConfig({
        FUSION_BASE_URL: "https://board.invalid/base///",
        FUSION_TOKEN: "placeholder",
      }),
      fetchMock,
    );

    await client.getHealth();
    await client.getSystemInfo();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://board.invalid/base/api/health",
      "https://board.invalid/base/api/system/info",
    ]);
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

  it("rejects a cross-origin request path before fetching", async () => {
    const fetchMock = vi.fn<FetchLike>();
    const client = new FusionClient(config(), fetchMock);

    await expect(
      client.request("GET", "https://foreign.invalid/api/health", {
        authenticated: false,
      }),
    ).rejects.toMatchObject({
      name: "FusionError",
      message: "Invalid Fusion request path",
      method: "GET",
      path: "https://foreign.invalid/api/health",
      kind: "network",
    });
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("cancels and normalizes non-2xx response bodies", async () => {
    const marker = "unsafe-response-marker";
    const response = new Response(marker, { status: 503 });
    const cancel = vi.spyOn(response.body!, "cancel");
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(response);
    const client = new FusionClient(config(), fetchMock);

    const error = await client.getHealth().catch((caught: unknown) => caught);

    expect(cancel).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(FusionError);
    expect(error).toMatchObject({
      method: "GET",
      path: "/api/health",
      status: 503,
      kind: "http",
    });
    expect(String(error)).not.toContain(marker);
  });

  it("cancels and normalizes malformed JSON response bodies", async () => {
    const marker = "unsafe-json-marker";
    const response = new Response(`{${marker}`);
    const cancel = vi.spyOn(response.body!, "cancel");
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(response);
    const client = new FusionClient(config(), fetchMock);

    const error = await client.getHealth().catch((caught: unknown) => caught);

    expect(cancel).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(FusionError);
    expect(error).toMatchObject({
      method: "GET",
      path: "/api/health",
      status: 200,
      kind: "invalid_payload",
    });
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
    expect(error).toMatchObject({
      method: "GET",
      path: "/api/health",
      kind: "network",
    });
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
      kind: "timeout",
    });
    await vi.advanceTimersByTimeAsync(10);

    await rejection;
    expect(calledInit(fetchMock).signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("classifies a timeout while reading the response body as timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<FetchLike>().mockImplementation(async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              controller.error(new DOMException("aborted", "AbortError"));
            });
          },
        }),
      ),
    );
    const client = new FusionClient(config({ requestTimeoutMs: 10 }), fetchMock);

    const request = client.getHealth();
    const rejection = expect(request).rejects.toMatchObject({
      name: "FusionError",
      method: "GET",
      path: "/api/health",
      kind: "timeout",
    });
    await vi.advanceTimersByTimeAsync(10);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("classifies non-timeout response body failures as network errors", async () => {
    const marker = "unsafe-body-transport-marker";
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(marker));
          },
        }),
      ),
    );
    const client = new FusionClient(config(), fetchMock);

    const error = await client.getHealth().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FusionError);
    expect(error).toMatchObject({
      method: "GET",
      path: "/api/health",
      kind: "network",
    });
    expect(String(error)).not.toContain(marker);
  });

  it("never includes configured secrets in thrown or serialized errors", async () => {
    const markers = {
      token: "distinctive-test-token-marker",
      accessClientId: "distinctive-test-access-id-marker",
      accessClientSecret: "distinctive-test-access-secret-marker",
    };
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      new Response(`denied ${markers.accessClientSecret}`, { status: 403 }),
    );
    const client = new FusionClient(
      config({
        token: markers.token,
        cfAccessClientId: markers.accessClientId,
        cfAccessClientSecret: markers.accessClientSecret,
      }),
      fetchMock,
    );

    const error = await client.getSystemInfo().catch((caught: unknown) => caught);
    const rendered = `${String(error)} ${JSON.stringify(error)}`;

    expect(error).toBeInstanceOf(FusionError);
    expect(error).toMatchObject({ status: 403, kind: "http" });
    for (const marker of Object.values(markers)) {
      expect(rendered).not.toContain(marker);
    }
  });
});

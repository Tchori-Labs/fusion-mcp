import { requireToken, type Config } from "./config.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  authenticated?: boolean;
  query?: Readonly<Record<string, QueryValue>>;
  body?: unknown;
}

export interface FusionResponse<T> {
  data: T;
  headers: Headers;
}

export type FusionErrorKind =
  | "http"
  | "timeout"
  | "invalid_payload"
  | "network";

export class FusionError extends Error {
  readonly method: string;
  readonly path: string;
  readonly status: number | undefined;
  readonly kind: FusionErrorKind;

  constructor(
    message: string,
    metadata: {
      method: string;
      path: string;
      status?: number;
      kind?: FusionErrorKind;
    },
  ) {
    super(message);
    this.name = "FusionError";
    this.method = metadata.method;
    this.path = metadata.path;
    this.status = metadata.status;
    this.kind = metadata.kind ?? (metadata.status === undefined ? "network" : "http");
  }
}

export class FusionClient {
  constructor(
    private readonly config: Config,
    private readonly fetch: FetchLike = globalThis.fetch,
  ) {}

  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<FusionResponse<T>> {
    const normalizedMethod = method.toUpperCase();
    const url = this.resolveUrl(normalizedMethod, path, options.query);
    const headers = new Headers();

    if (options.authenticated !== false) {
      headers.set("authorization", `Bearer ${requireToken(this.config)}`);
    }

    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.requestTimeoutMs);
    timeout.unref();

    try {
      const response = await this.fetch(url.toString(), {
        method: normalizedMethod,
        headers,
        signal: controller.signal,
        ...(body === undefined ? {} : { body }),
      });

      if (timedOut) {
        throw this.timeoutError(normalizedMethod, path);
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new FusionError(
          `Fusion request failed: ${normalizedMethod} ${path} (status ${response.status})`,
          {
            method: normalizedMethod,
            path,
            status: response.status,
            kind: "http",
          },
        );
      }

      let text: string;
      try {
        text = await response.text();
      } catch {
        await response.body?.cancel().catch(() => undefined);
        if (timedOut || controller.signal.aborted) {
          throw this.timeoutError(normalizedMethod, path);
        }
        throw new FusionError(
          `Fusion request failed: ${normalizedMethod} ${path}`,
          { method: normalizedMethod, path, kind: "network" },
        );
      }

      if (timedOut || controller.signal.aborted) {
        throw this.timeoutError(normalizedMethod, path);
      }

      let data: T;
      try {
        data = (text === "" ? undefined : JSON.parse(text)) as T;
      } catch {
        await response.body?.cancel().catch(() => undefined);
        throw new FusionError(
          `Fusion returned invalid JSON: ${normalizedMethod} ${path}`,
          {
            method: normalizedMethod,
            path,
            status: response.status,
            kind: "invalid_payload",
          },
        );
      }

      return { data, headers: response.headers };
    } catch (error) {
      if (error instanceof FusionError) {
        throw error;
      }
      if (timedOut || controller.signal.aborted) {
        throw this.timeoutError(normalizedMethod, path);
      }
      throw new FusionError(
        `Fusion request failed: ${normalizedMethod} ${path}`,
        { method: normalizedMethod, path, kind: "network" },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  getHealth(): Promise<FusionResponse<unknown>> {
    return this.request("GET", "/api/health", { authenticated: false });
  }

  getSystemInfo(): Promise<FusionResponse<unknown>> {
    return this.request("GET", "/api/system/info");
  }

  listProjects(): Promise<FusionResponse<unknown>> {
    return this.request("GET", "/api/projects");
  }

  getSettings(projectId?: string): Promise<FusionResponse<unknown>> {
    return this.request("GET", "/api/settings", {
      query: { projectId },
    });
  }

  private resolveUrl(
    method: string,
    path: string,
    query: Readonly<Record<string, QueryValue>> | undefined,
  ): URL {
    const base = new URL(`${this.config.baseUrl}/`);
    const url = new URL(path.replace(/^\//, ""), base);
    if (url.origin !== base.origin) {
      throw new FusionError("Invalid Fusion request path", {
        method,
        path,
        kind: "network",
      });
    }

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  private timeoutError(method: string, path: string): FusionError {
    return new FusionError(`Fusion request timed out: ${method} ${path}`, {
      method,
      path,
      kind: "timeout",
    });
  }
}

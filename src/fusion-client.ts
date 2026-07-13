import type { Config } from './config.js';
import { requireToken } from './config.js';

/** A JSON-serialisable request body. */
export type JsonBody = Record<string, unknown>;

/** Query parameters; `undefined` values are dropped before serialisation. */
export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  /** Query string parameters. */
  query?: Query;
  /** JSON request body (POST/PUT/PATCH). */
  body?: JsonBody;
  /**
   * Whether to attach the bearer token. Defaults to `true`. Set `false` only
   * for the auth-exempt `GET /api/health`.
   */
  auth?: boolean;
  /** Caller-supplied abort signal, merged with the per-request timeout. */
  signal?: AbortSignal;
}

/**
 * The subset of `fetch` this client uses: it always calls with a string URL and
 * a plain `RequestInit`. The global `fetch` satisfies this, and test doubles can
 * match it exactly. Narrower than the DOM `fetch` type on purpose.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Normalised result: parsed body plus the response headers callers need. */
export interface FusionResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

/**
 * Error thrown for any non-2xx Fusion response or transport failure. The
 * message is deliberately token-free — only method, path, status and a short
 * body snippet are exposed.
 */
export class FusionError extends Error {
  readonly status?: number;
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string, message: string, status?: number) {
    super(`Fusion API ${method} ${path} failed: ${message}`);
    this.name = 'FusionError';
    this.method = method;
    this.path = path;
    this.status = status;
  }
}

/**
 * Thin fetch wrapper around the Fusion REST API. Adds bearer auth, query
 * serialisation, JSON handling, a per-request timeout, and token-free error
 * normalisation. Endpoint-specific methods (tasks, logs, settings, …) are added
 * on top of {@link request} by the FM-00x tasks; this scaffold only ships the
 * health primitives.
 */
export class FusionClient {
  private readonly config: Config;
  private readonly fetchImpl: FetchLike;

  constructor(config: Config, opts: { fetch?: FetchLike } = {}) {
    this.config = config;
    // Bind so the global fetch keeps its expected `this` when no double is given.
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Core request primitive. All endpoint helpers route through here. */
  async request<T = unknown>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<FusionResponse<T>> {
    const url = this.buildUrl(path, opts.query);
    const headers: Record<string, string> = { Accept: 'application/json' };

    if (opts.auth !== false) {
      headers.Authorization = `Bearer ${requireToken(this.config)}`;
    }
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, controller.signal])
      : controller.signal;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal,
      });
    } catch (err) {
      const reason =
        controller.signal.aborted && !opts.signal?.aborted
          ? `timed out after ${this.config.requestTimeoutMs}ms`
          : errorMessage(err);
      throw new FusionError(method, path, reason);
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const snippet = await safeBodySnippet(res);
      throw new FusionError(
        method,
        path,
        `${res.status} ${res.statusText}${snippet ? ` — ${snippet}` : ''}`,
        res.status,
      );
    }

    return { data: await parseJson<T>(res), status: res.status, headers: res.headers };
  }

  /** `GET /api/health` — auth-exempt liveness probe. */
  async getHealth<T = unknown>(): Promise<FusionResponse<T>> {
    return this.request<T>('GET', '/api/health', { auth: false });
  }

  /** `GET /api/system/info` — richer diagnostics (requires auth). */
  async getSystemInfo<T = unknown>(): Promise<FusionResponse<T>> {
    return this.request<T>('GET', '/api/system/info');
  }

  private buildUrl(path: string, query?: Query): string {
    const url = new URL(this.config.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (text.length === 0) {
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

async function safeBodySnippet(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return '';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

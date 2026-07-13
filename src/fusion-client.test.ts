import { describe, expect, it, vi } from 'vitest';

import type { Config } from './config.js';
import { FusionClient, FusionError } from './fusion-client.js';

const TOKEN = 'fn_deadbeefdeadbeefdeadbeefdeadbeef';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    baseUrl: 'http://127.0.0.1:4040',
    token: TOKEN,
    port: 4141,
    requestTimeoutMs: 15000,
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('FusionClient.request', () => {
  it('attaches the bearer token and drops undefined query params', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ ok: true }),
    );
    const client = new FusionClient(makeConfig(), { fetch: fetchImpl });

    const res = await client.request('GET', '/api/tasks', {
      query: { limit: 20, offset: 0, projectId: undefined, q: 'bug' },
    });

    expect(res.data).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0]!;
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/tasks');
    expect(parsed.searchParams.get('limit')).toBe('20');
    expect(parsed.searchParams.get('offset')).toBe('0');
    expect(parsed.searchParams.get('q')).toBe('bug');
    expect(parsed.searchParams.has('projectId')).toBe(false);
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
  });

  it('serialises a JSON body with a content-type header', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ id: 't1' }, { status: 201 }),
    );
    const client = new FusionClient(makeConfig(), { fetch: fetchImpl });

    await client.request('POST', '/api/tasks', { body: { description: 'do the thing' } });

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ description: 'do the thing' }));
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('exposes response headers for pagination', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse([], { headers: { 'X-Total-Count': '42', 'X-Has-More': 'true' } }),
    );
    const client = new FusionClient(makeConfig(), { fetch: fetchImpl });

    const res = await client.request('GET', '/api/tasks/t1/logs', { query: { limit: 10 } });
    expect(res.headers.get('X-Total-Count')).toBe('42');
    expect(res.headers.get('X-Has-More')).toBe('true');
  });

  it('throws a token-free FusionError on a non-2xx response', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response('task not found', { status: 404, statusText: 'Not Found' }),
    );
    const client = new FusionClient(makeConfig(), { fetch: fetchImpl });

    const err = await client.request('GET', '/api/tasks/nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FusionError);
    const fe = err as FusionError;
    expect(fe.status).toBe(404);
    expect(fe.message).toContain('404 Not Found');
    expect(fe.message).toContain('task not found');
    expect(fe.message).not.toContain(TOKEN);
  });

  it('wraps transport failures without leaking the token', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
      throw new Error('ECONNREFUSED');
    });
    const client = new FusionClient(makeConfig(), { fetch: fetchImpl });

    const err = await client.request('GET', '/api/health').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FusionError);
    expect((err as FusionError).message).toContain('ECONNREFUSED');
    expect((err as FusionError).message).not.toContain(TOKEN);
  });

  it('reports a timeout when the request exceeds requestTimeoutMs', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const client = new FusionClient(makeConfig({ requestTimeoutMs: 5 }), { fetch: fetchImpl });

    const err = await client.request('GET', '/api/health').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FusionError);
    expect((err as FusionError).message).toContain('timed out');
  });
});

describe('FusionClient.getHealth', () => {
  it('calls the auth-exempt endpoint without an Authorization header', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ status: 'ok' }),
    );
    // No token configured — health must still work.
    const client = new FusionClient(makeConfig({ token: undefined }), { fetch: fetchImpl });

    const res = await client.getHealth();
    expect(res.data).toEqual({ status: 'ok' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(new URL(url).pathname).toBe('/api/health');
    expect(init?.headers).not.toHaveProperty('Authorization');
  });
});

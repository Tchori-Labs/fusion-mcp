import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import type { Config } from './config.js';
import { FusionClient, type FetchLike } from './fusion-client.js';
import { buildServer } from './index.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    baseUrl: 'http://127.0.0.1:4040',
    token: 'fn_deadbeefdeadbeefdeadbeefdeadbeef',
    port: 4141,
    requestTimeoutMs: 15000,
    ...overrides,
  };
}

function fusionFetch() {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/api/health') {
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    }
    if (path === '/api/system/info') {
      return new Response(JSON.stringify({ version: '1.2.3', uptimeS: 99 }), { status: 200 });
    }
    return new Response('not found', { status: 404, statusText: 'Not Found' });
  });
}

async function connect(config: Config, fetchImpl: FetchLike) {
  const server = buildServer(new FusionClient(config, { fetch: fetchImpl }), config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function firstText(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  const block = content.find(c => c.type === 'text');
  if (!block?.text) throw new Error('no text content returned');
  return block.text;
}

describe('get_board_health tool', () => {
  it('exposes ONLY the proof-of-life tool (governance: no write/merge tools yet)', async () => {
    const { client } = await connect(makeConfig(), fusionFetch());
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(['get_board_health']);
  });

  it('merges health and system info when a token is configured', async () => {
    const fetchImpl = fusionFetch();
    const { client } = await connect(makeConfig(), fetchImpl as unknown as typeof fetch);

    const result = await client.callTool({ name: 'get_board_health', arguments: {} });
    const payload = JSON.parse(firstText(result));

    expect(payload.tokenConfigured).toBe(true);
    expect(payload.health).toEqual({ status: 'ok' });
    expect(payload.system).toEqual({ version: '1.2.3', uptimeS: 99 });
  });

  it('returns health without system info when no token is configured', async () => {
    const fetchImpl = fusionFetch();
    const { client } = await connect(
      makeConfig({ token: undefined }),
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({ name: 'get_board_health', arguments: {} });
    const payload = JSON.parse(firstText(result));

    expect(payload.tokenConfigured).toBe(false);
    expect(payload.health).toEqual({ status: 'ok' });
    expect(payload.system).toBeUndefined();
    // system/info must never be requested without a token.
    const calledPaths = fetchImpl.mock.calls.map(([u]) => new URL(u).pathname);
    expect(calledPaths).not.toContain('/api/system/info');
  });
});

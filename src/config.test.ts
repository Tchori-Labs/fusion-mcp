import { describe, expect, it } from 'vitest';

import { parseConfig, requireToken } from './config.js';

describe('parseConfig', () => {
  it('applies documented defaults for an empty environment', () => {
    const config = parseConfig({});
    expect(config.baseUrl).toBe('http://127.0.0.1:4040');
    expect(config.token).toBeUndefined();
    expect(config.defaultProjectId).toBeUndefined();
    expect(config.port).toBe(4141);
    expect(config.requestTimeoutMs).toBe(15000);
  });

  it('reads overrides and strips a trailing slash from the base URL', () => {
    const config = parseConfig({
      FUSION_BASE_URL: 'https://fusion.internal:9000/',
      FUSION_TOKEN: 'fn_deadbeefdeadbeefdeadbeefdeadbeef',
      FUSION_DEFAULT_PROJECT_ID: 'proj_42',
      PORT: '5151',
    });
    expect(config.baseUrl).toBe('https://fusion.internal:9000');
    expect(config.token).toBe('fn_deadbeefdeadbeefdeadbeefdeadbeef');
    expect(config.defaultProjectId).toBe('proj_42');
    expect(config.port).toBe(5151);
  });

  it('trims whitespace and treats blank optionals as unset', () => {
    const config = parseConfig({ FUSION_TOKEN: '   ' });
    expect(config.token).toBeUndefined();
  });

  it('rejects an invalid base URL', () => {
    expect(() => parseConfig({ FUSION_BASE_URL: 'not a url' })).toThrow(/not a valid URL/);
  });

  it('rejects a non-numeric port', () => {
    expect(() => parseConfig({ PORT: 'abc' })).toThrow();
  });
});

describe('requireToken', () => {
  it('returns the token when present', () => {
    expect(requireToken({ ...base(), token: 'fn_abc' })).toBe('fn_abc');
  });

  it('throws a token-free error when missing', () => {
    expect(() => requireToken(base())).toThrow(/FUSION_TOKEN is required/);
  });
});

function base() {
  return { baseUrl: 'http://127.0.0.1:4040', port: 4141, requestTimeoutMs: 15000 };
}

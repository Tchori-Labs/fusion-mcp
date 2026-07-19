import { describe, expect, it } from "vitest";

import { MissingTokenError, parseConfig, requireToken } from "./config.js";

describe("parseConfig", () => {
  it("uses documented defaults", () => {
    expect(parseConfig({})).toEqual({
      baseUrl: "http://127.0.0.1:4040",
      port: 4141,
      requestTimeoutMs: 15_000,
    });
  });

  it("parses all overrides and removes trailing slashes", () => {
    expect(
      parseConfig({
        FUSION_BASE_URL: "https://board.invalid/base///",
        FUSION_TOKEN: " test-secret-marker ",
        FUSION_DEFAULT_PROJECT_ID: " project-a ",
        FUSION_CF_ACCESS_CLIENT_ID: " access-client ",
        FUSION_CF_ACCESS_CLIENT_SECRET: " access-secret ",
        FUSION_USER_AGENT: " fusion-mcp-test ",
        PORT: "5151",
        FUSION_REQUEST_TIMEOUT_MS: "2500",
      }),
    ).toEqual({
      baseUrl: "https://board.invalid/base",
      token: "test-secret-marker",
      defaultProjectId: "project-a",
      cfAccessClientId: "access-client",
      cfAccessClientSecret: "access-secret",
      userAgent: "fusion-mcp-test",
      port: 5151,
      requestTimeoutMs: 2500,
    });
  });

  it("treats blank optional values as unset", () => {
    const config = parseConfig({
      FUSION_TOKEN: "   ",
      FUSION_DEFAULT_PROJECT_ID: "\t",
      FUSION_CF_ACCESS_CLIENT_ID: " \t ",
      FUSION_CF_ACCESS_CLIENT_SECRET: "\n",
      FUSION_USER_AGENT: "   ",
    });

    expect(config).not.toHaveProperty("token");
    expect(config).not.toHaveProperty("defaultProjectId");
    expect(config).not.toHaveProperty("cfAccessClientId");
    expect(config).not.toHaveProperty("cfAccessClientSecret");
    expect(config).not.toHaveProperty("userAgent");
  });

  it("requires an Access client id when its secret is set", () => {
    expect(() =>
      parseConfig({ FUSION_CF_ACCESS_CLIENT_SECRET: "access-secret" }),
    ).toThrow(
      "FUSION_CF_ACCESS_CLIENT_ID must be set when FUSION_CF_ACCESS_CLIENT_SECRET is set",
    );
  });

  it("requires an Access client secret when its id is set", () => {
    expect(() =>
      parseConfig({ FUSION_CF_ACCESS_CLIENT_ID: "access-client" }),
    ).toThrow(
      "FUSION_CF_ACCESS_CLIENT_SECRET must be set when FUSION_CF_ACCESS_CLIENT_ID is set",
    );
  });

  it.each([
    {
      name: "FUSION_CF_ACCESS_CLIENT_ID",
      env: {
        FUSION_CF_ACCESS_CLIENT_ID: "access\rclient",
        FUSION_CF_ACCESS_CLIENT_SECRET: "access-secret",
      },
    },
    {
      name: "FUSION_CF_ACCESS_CLIENT_SECRET",
      env: {
        FUSION_CF_ACCESS_CLIENT_ID: "access-client",
        FUSION_CF_ACCESS_CLIENT_SECRET: "access\nsecret",
      },
    },
    {
      name: "FUSION_USER_AGENT",
      env: { FUSION_USER_AGENT: "fusion\u007fclient" },
    },
  ])("rejects control characters in $name", ({ env, name }) => {
    expect(() => parseConfig(env)).toThrow(
      `${name} must not contain control characters`,
    );
  });

  it.each(["not a url", "ftp://board.invalid", ""]) (
    "rejects invalid base URL %j",
    (baseUrl) => {
      expect(() => parseConfig({ FUSION_BASE_URL: baseUrl })).toThrow(
        "FUSION_BASE_URL must be a valid HTTP or HTTPS URL",
      );
    },
  );

  it.each(["0", "00", "0080", "-1", "1.5", "abc", "", "65536"])(
    "rejects invalid port %j",
    (port) => {
      expect(() => parseConfig({ PORT: port })).toThrow(/PORT must/);
    },
  );

  it.each(["0", "00", "0080", "-1", "1.5", "abc", ""])(
    "rejects invalid request timeout %j",
    (timeout) => {
      expect(() =>
        parseConfig({ FUSION_REQUEST_TIMEOUT_MS: timeout }),
      ).toThrow("FUSION_REQUEST_TIMEOUT_MS must be a positive integer");
    },
  );

  it.each([65_534, 65_535])(
    "accepts request timeout within the maximum: %i",
    (timeout) => {
      expect(
        parseConfig({ FUSION_REQUEST_TIMEOUT_MS: String(timeout) })
          .requestTimeoutMs,
      ).toBe(timeout);
    },
  );

  it("rejects a request timeout above the maximum", () => {
    expect(() =>
      parseConfig({ FUSION_REQUEST_TIMEOUT_MS: "65536" }),
    ).toThrow("FUSION_REQUEST_TIMEOUT_MS must be between 1 and 65535");
  });

  it("does not echo optional configuration in validation errors", () => {
    const markers = [
      "test-token-marker",
      "test-access-id-marker",
      "test-access-secret-marker",
      "test-user-agent-marker",
    ];

    try {
      parseConfig({
        FUSION_TOKEN: markers[0],
        FUSION_CF_ACCESS_CLIENT_ID: markers[1],
        FUSION_CF_ACCESS_CLIENT_SECRET: markers[2],
        FUSION_USER_AGENT: markers[3],
        PORT: "invalid",
      });
      expect.unreachable("expected parsing to fail");
    } catch (error) {
      for (const marker of markers) {
        expect(String(error)).not.toContain(marker);
      }
    }
  });
});

describe("requireToken", () => {
  it("returns a configured token", () => {
    const config = parseConfig({ FUSION_TOKEN: "test-secret-marker" });
    expect(requireToken(config)).toBe("test-secret-marker");
  });

  it("rejects a missing token with a stable typed error", () => {
    const invoke = () => requireToken(parseConfig({}));

    expect(invoke).toThrow(MissingTokenError);
    expect(invoke).toThrow(
      "FUSION_TOKEN is required for authenticated operations",
    );
    try {
      invoke();
      expect.unreachable("expected token requirement to fail");
    } catch (error) {
      expect(error).toMatchObject({ name: "MissingTokenError" });
    }
  });
});

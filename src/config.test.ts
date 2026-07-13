import { describe, expect, it } from "vitest";

import { parseConfig, requireToken } from "./config.js";

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
        PORT: "5151",
        FUSION_REQUEST_TIMEOUT_MS: "2500",
      }),
    ).toEqual({
      baseUrl: "https://board.invalid/base",
      token: "test-secret-marker",
      defaultProjectId: "project-a",
      port: 5151,
      requestTimeoutMs: 2500,
    });
  });

  it("treats blank optional values as unset", () => {
    const config = parseConfig({
      FUSION_TOKEN: "   ",
      FUSION_DEFAULT_PROJECT_ID: "\t",
    });

    expect(config).not.toHaveProperty("token");
    expect(config).not.toHaveProperty("defaultProjectId");
  });

  it.each(["not a url", "ftp://board.invalid", ""]) (
    "rejects invalid base URL %j",
    (baseUrl) => {
      expect(() => parseConfig({ FUSION_BASE_URL: baseUrl })).toThrow(
        "FUSION_BASE_URL must be a valid HTTP or HTTPS URL",
      );
    },
  );

  it.each(["0", "-1", "1.5", "abc", "", "65536"])(
    "rejects invalid port %j",
    (port) => {
      expect(() => parseConfig({ PORT: port })).toThrow(/PORT must/);
    },
  );

  it.each(["0", "-1", "1.5", "abc", ""])(
    "rejects invalid request timeout %j",
    (timeout) => {
      expect(() =>
        parseConfig({ FUSION_REQUEST_TIMEOUT_MS: timeout }),
      ).toThrow("FUSION_REQUEST_TIMEOUT_MS must be a positive integer");
    },
  );

  it("does not echo optional configuration in validation errors", () => {
    const marker = "test-secret-marker";

    try {
      parseConfig({ FUSION_TOKEN: marker, PORT: "invalid" });
      expect.unreachable("expected parsing to fail");
    } catch (error) {
      expect(String(error)).not.toContain(marker);
    }
  });
});

describe("requireToken", () => {
  it("returns a configured token", () => {
    const config = parseConfig({ FUSION_TOKEN: "test-secret-marker" });
    expect(requireToken(config)).toBe("test-secret-marker");
  });

  it("rejects a missing token without exposing a value", () => {
    expect(() => requireToken(parseConfig({}))).toThrow(
      "FUSION_TOKEN is required for authenticated operations",
    );
  });
});

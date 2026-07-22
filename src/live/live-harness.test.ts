import { afterEach, describe, expect, it, vi } from "vitest";

import {
  edgeCredentialsConfigured,
  liveSkipReason,
  redactToken,
} from "./live-harness.js";

const edgeClientId = "test-edge-client-id";
const edgeClientSecret = "test-edge-client-secret";

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubEdgeCredentials(
  clientId: string | undefined,
  clientSecret: string | undefined,
): void {
  vi.stubEnv("FUSION_CF_ACCESS_CLIENT_ID", clientId);
  vi.stubEnv("FUSION_CF_ACCESS_CLIENT_SECRET", clientSecret);
}

describe("edgeCredentialsConfigured", () => {
  it.each([
    { clientId: edgeClientId, clientSecret: edgeClientSecret, expected: true },
    { clientId: edgeClientId, clientSecret: undefined, expected: false },
    { clientId: undefined, clientSecret: edgeClientSecret, expected: false },
    { clientId: undefined, clientSecret: undefined, expected: false },
    { clientId: "", clientSecret: edgeClientSecret, expected: false },
    { clientId: edgeClientId, clientSecret: "  ", expected: false },
  ])(
    "returns $expected for clientId=$clientId and clientSecret=$clientSecret",
    ({ clientId, clientSecret, expected }) => {
      stubEdgeCredentials(clientId, clientSecret);

      expect(edgeCredentialsConfigured()).toBe(expected);
    },
  );
});

describe("live trace redaction", () => {
  it("redacts the bearer token and both edge credential values", () => {
    vi.stubEnv("FUSION_TOKEN", "test-bearer-token");
    stubEdgeCredentials(edgeClientId, edgeClientSecret);

    expect(
      redactToken(
        `token=test-bearer-token id=${edgeClientId} secret=${edgeClientSecret}`,
      ),
    ).toBe("token=[REDACTED] id=[REDACTED] secret=[REDACTED]");
  });

  it("keeps the explicit-token parameter backward compatible", () => {
    stubEdgeCredentials(undefined, undefined);

    expect(
      redactToken("value=explicit-test-token", "explicit-test-token"),
    ).toBe("value=[REDACTED]");
  });

  it("leaves text unchanged when no sensitive values are configured", () => {
    vi.stubEnv("FUSION_TOKEN", undefined);
    stubEdgeCredentials(undefined, undefined);

    expect(redactToken("ordinary diagnostic text")).toBe(
      "ordinary diagnostic text",
    );
  });
});

describe("liveSkipReason", () => {
  it("remains enabled only with opt-in, base URL, and bearer token", () => {
    vi.stubEnv("FUSION_MCP_LIVE", "yes");
    vi.stubEnv("FUSION_BASE_URL", "https://live.example.invalid");
    vi.stubEnv("FUSION_TOKEN", "test-bearer-token");

    expect(liveSkipReason()).toBeUndefined();
  });

  it("continues to report every missing live prerequisite", () => {
    vi.stubEnv("FUSION_MCP_LIVE", undefined);
    vi.stubEnv("FUSION_BASE_URL", "");
    vi.stubEnv("FUSION_TOKEN", "   ");

    expect(liveSkipReason()).toBe(
      "FUSION_MCP_LIVE must be set to one of: 1, true, yes, on; " +
        "FUSION_BASE_URL must name the reachable Fusion instance; " +
        "FUSION_TOKEN must be supplied from the environment or secret store",
    );
  });
});

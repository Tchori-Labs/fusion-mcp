import { describe, expect, it } from "vitest";

import { REDACTED, redactSettings } from "./redact-settings.js";

describe("redactSettings", () => {
  it("masks daemonToken and case-insensitive credential-bearing keys", () => {
    expect(
      redactSettings({
        daemonToken: "daemon-marker",
        AuthToken: "auth-marker",
        API_SECRET: "secret-marker",
        Passphrase: "passphrase-marker",
        credentials: "credentials-marker",
      }),
    ).toEqual({
      daemonToken: REDACTED,
      AuthToken: REDACTED,
      API_SECRET: REDACTED,
      Passphrase: REDACTED,
      credentials: REDACTED,
    });
  });

  it("redacts secrets nested in objects and arrays at every depth", () => {
    expect(
      redactSettings({
        remoteAccess: {
          providers: [
            { name: "primary", token: "remote-marker" },
            { config: { clientCredential: "client-marker" } },
          ],
        },
        repeated: {
          token: "outer-marker",
          nested: { token: "inner-marker" },
        },
      }),
    ).toEqual({
      remoteAccess: {
        providers: [
          { name: "primary", token: REDACTED },
          { config: { clientCredential: REDACTED } },
        ],
      },
      repeated: {
        token: REDACTED,
        nested: { token: REDACTED },
      },
    });
  });

  it("masks the entire value of credential-bearing keys regardless of type", () => {
    expect(
      redactSettings({
        tokenConfig: { value: "nested-marker", enabled: true },
        secretCount: 3,
        credentialEnabled: false,
        passphraseOptions: ["one", "two"],
      }),
    ).toEqual({
      tokenConfig: REDACTED,
      secretCount: REDACTED,
      credentialEnabled: REDACTED,
      passphraseOptions: REDACTED,
    });
  });

  it("preserves non-secret settings with structurally equal values", () => {
    const settings = {
      mergeTopology: "squash",
      trackingRepo: "example/repo",
      theme: "dark",
      notifications: true,
      nested: { retries: 2, providers: ["local", null] },
    };

    expect(redactSettings(settings)).toEqual(settings);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["string", "value"],
    ["number", 42],
    ["boolean", false],
  ])("returns %s inputs unchanged", (_label, value) => {
    expect(redactSettings(value)).toBe(value);
  });

  it("supports empty objects and arrays", () => {
    expect(redactSettings({})).toEqual({});
    expect(redactSettings([])).toEqual([]);
  });

  it("does not mutate the input", () => {
    const settings = {
      daemonToken: "daemon-marker",
      remoteAccess: [{ provider: { token: "remote-marker", mode: "relay" } }],
    };
    const original = structuredClone(settings);
    const redacted = redactSettings(settings);

    expect(settings).toEqual(original);
    expect(redacted).not.toBe(settings);
    expect(redacted).toEqual({
      daemonToken: REDACTED,
      remoteAccess: [{ provider: { token: REDACTED, mode: "relay" } }],
    });
  });
});

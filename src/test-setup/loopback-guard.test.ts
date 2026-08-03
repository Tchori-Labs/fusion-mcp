import { describe, expect, it } from "vitest";

import {
  isPermittedLoopbackDestination,
  LoopbackNetworkError,
} from "./loopback-guard.js";

describe("loopback-only socket lane policy", () => {
  it("permits only the literal IPv4 loopback destination", () => {
    expect(isPermittedLoopbackDestination("127.0.0.1")).toBe(true);
    for (const destination of [
      "localhost",
      "::1",
      "127.0.0.2",
      "0.0.0.0",
      "203.0.113.1",
      "example.invalid",
      undefined,
    ]) {
      expect(isPermittedLoopbackDestination(destination)).toBe(false);
    }
  });

  it("reports the operation and attempted destination without credentials", () => {
    const error = new LoopbackNetworkError("TCP connect", "203.0.113.1");

    expect(error.message).toBe(
      "Socket test guard: TCP connect to 203.0.113.1 is blocked; only literal 127.0.0.1 is permitted.",
    );
    expect(error.message).not.toMatch(/token|secret|credential/i);
  });
});

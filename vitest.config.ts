import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Mandatory-suite only: future live/opt-in configs must omit this guard.
    setupFiles: ["./src/test-setup/network-guard.ts"],
  },
});

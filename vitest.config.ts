import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Live tests are opt-in by filename and must run only through their own
    // explicit config, which must omit the mandatory suite's network guard.
    exclude: ["src/**/*.live.test.ts"],
    setupFiles: ["./src/test-setup/network-guard.ts"],
  },
});

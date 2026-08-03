import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Socket and live tests run only through their explicit lane configs and
    // are never collected with the mandatory suite's hermetic network guard.
    exclude: ["src/**/*.socket.test.ts", "src/**/*.live.test.ts"],
    setupFiles: ["./src/test-setup/network-guard.ts"],
  },
});

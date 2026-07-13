import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Tests must never hit the network — fetch is always stubbed/injected.
    testTimeout: 10000,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Los tests de servidor y MCP abren puertos y procesos: mejor en serie.
    fileParallelism: false,
  },
});

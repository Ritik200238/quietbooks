import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Circuit calls run the compiled contract in-process. They are CPU bound and
    // there are a lot of them, so the default five-second budget is not enough
    // on a cold cache.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
});

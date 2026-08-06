import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Integration suites share one isolated Postgres schema and reset it
    // between scenarios. Running files concurrently corrupts that isolation.
    fileParallelism: false
  }
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    fileParallelism: false,
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:55433/brad_test',
      REDIS_URL: 'redis://127.0.0.1:56379',
      BRAD_CONDUCTOR_MODE: 'active',
      JWT_SECRET: 'test-secret-at-least-sixteen-characters'
    }
  }
});

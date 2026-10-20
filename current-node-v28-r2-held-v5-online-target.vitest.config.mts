import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node',
  include: ['server/recovery/current-v28-r2-held-v5-online-target.qualification.ts'],
  testTimeout: 20_000, hookTimeout: 20_000, maxWorkers: 1, fileParallelism: false, pool: 'forks', bail: 1, retry: 0 } });

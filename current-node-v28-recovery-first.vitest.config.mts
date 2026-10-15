import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['server/recovery/current-v28-online-recovery.qualification.ts'],
  testTimeout: 20_000, hookTimeout: 20_000, maxWorkers: 1, fileParallelism: false, pool: 'forks', bail: 1 } });

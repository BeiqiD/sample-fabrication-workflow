import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['server/operations/current-v28-bound-comment-backup.qualification.ts'],
  testTimeout: 20_000, hookTimeout: 20_000, maxWorkers: 1, fileParallelism: false, pool: 'forks', bail: 1 } });

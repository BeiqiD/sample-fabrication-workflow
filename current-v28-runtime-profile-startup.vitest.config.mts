import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['server/collaboration/current-v28-runtime-profile-startup.qualification.ts'],
  environment: 'node', pool: 'forks', maxWorkers: 1, fileParallelism: false, testTimeout: 20_000, hookTimeout: 20_000, bail: 1 } });

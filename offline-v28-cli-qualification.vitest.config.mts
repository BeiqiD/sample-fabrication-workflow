import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  include: ["server/operations/restore-v28-cli.qualification.ts"],
  fileParallelism: false, maxWorkers: 1, bail: 1, retry: 0,
  testTimeout: 20000, hookTimeout: 20000,
} });

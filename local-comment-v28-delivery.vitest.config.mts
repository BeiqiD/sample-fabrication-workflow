import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["server/files/local-comment-v28-delivery.qualification.ts"],
  testTimeout: 20_000, hookTimeout: 20_000, maxWorkers: 1, fileParallelism: false, bail: 1 } });

import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["server/storage/local-profile-first-close.qualification.ts"],
  testTimeout: 20_000, hookTimeout: 10_000, maxWorkers: 1, fileParallelism: false, bail: 1 } });

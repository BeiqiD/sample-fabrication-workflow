import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["server/packages/public-r2-node-pair.qualification.ts"],
  environment: "node", testTimeout: 60000, hookTimeout: 20000,
  maxWorkers: 1, fileParallelism: false, pool: "forks", bail: 1, retry: 0,
  setupFiles: ["./test/setup-worker-crypto.ts"] } });

import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["scripts/qa/worker-v5-public-headed-native.qualification.ts"],
  maxWorkers: 1, fileParallelism: false, pool: "forks", bail: 1 } });

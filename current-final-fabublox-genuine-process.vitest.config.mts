import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: [
  "server/collaboration/current-final-fabublox-genuine-process.qualification.ts",
  "server/collaboration/current-final-fabublox-multipart-first-close.qualification.ts",
], environment: "node", maxWorkers: 1, fileParallelism: false, bail: 1, testTimeout: 20_000, hookTimeout: 20_000 } });

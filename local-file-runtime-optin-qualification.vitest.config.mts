import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  include: ["server/files/local-file-runtime-optin.qualification.ts"],
  environment: "node", setupFiles: ["./test/setup-worker-crypto.ts"],
  testTimeout: 5000, hookTimeout: 10000, maxWorkers: 1, fileParallelism: false, bail: 1, retry: 0,
} });

import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["server/template-read.test.ts", "worker/template-read.qualification.test.ts"],
  environment: "node", maxWorkers: 1, fileParallelism: false, setupFiles: ["./test/setup-worker-crypto.ts"] } });

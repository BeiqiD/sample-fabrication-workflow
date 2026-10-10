import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["server/project-read.test.ts", "worker/project-read.qualification.test.ts"],
  environment: "node", maxWorkers: 1, fileParallelism: false, setupFiles: ["./test/setup-worker-crypto.ts"] } });

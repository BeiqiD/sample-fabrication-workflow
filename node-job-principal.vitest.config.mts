import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "server/files/jobs/principal-authority.test.ts",
      "server/files/jobs/repository.test.ts",
    ],
    environment: "node",
    setupFiles: ["./test/setup-worker-crypto.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    bail: 1,
  },
});

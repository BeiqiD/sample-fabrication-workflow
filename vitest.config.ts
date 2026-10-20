import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest otherwise reserves one CPU and serializes source qualification on
    // two-CPU builders. Keep the defaults on other machines and file isolation.
    maxWorkers: availableParallelism() === 2 ? 2 : undefined,
    include: ["**/*.test.ts"],
    environment: "node",
    setupFiles: ["./test/setup-worker-crypto.ts"],
  },
});

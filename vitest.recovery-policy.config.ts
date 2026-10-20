import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/recovery/current-v28-recovery-capability-policy.qualification.ts"],
    environment: "node",
    setupFiles: ["./test/setup-worker-crypto.ts"],
    maxWorkers: 1,
  },
});

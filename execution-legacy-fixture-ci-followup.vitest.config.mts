import { defineConfig } from "vitest/config";

// Exactly the six mature Run trash cases and one Metrology lifecycle case.
// Default five-second case deadlines; parent owns the exclusive runtime GO.
export default defineConfig({ test: {
  include: ["worker/delete-run-route.test.ts", "worker/metrology-routes.test.ts"],
  environment: "node", maxWorkers: 1, fileParallelism: false,
  setupFiles: ["./test/setup-worker-crypto.ts"],
} });

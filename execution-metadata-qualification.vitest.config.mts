import { defineConfig } from "vitest/config";

// Thirty finite scopes: eighteen genuine Node/SQLite and twelve actual Worker.
// Running this file requires the parent-owned exclusive runtime window.
export default defineConfig({ test: {
  include: [
    "server/step-confirmation.test.ts",
    "server/run-trash.test.ts",
    "server/metrology-write.test.ts",
    "worker/step-confirmation.qualification.test.ts",
    "worker/run-trash.qualification.test.ts",
    "worker/metrology-write.qualification.test.ts"
  ],
  environment: "node", maxWorkers: 1, fileParallelism: false,
  setupFiles: ["./test/setup-worker-crypto.ts"],
} });

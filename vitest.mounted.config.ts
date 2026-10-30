import react from "@vitejs/plugin-react";
import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    // Match source qualification without serializing two-CPU builders.
    maxWorkers: availableParallelism() === 2 ? 2 : undefined,
    environment: "jsdom",
    include: ["src/*.mount.test.tsx"],
  },
});

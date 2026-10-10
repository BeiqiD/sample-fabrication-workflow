import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { temmlBundlerCompat } from "./scripts/temml-bundler-compat.mjs";

/** Shared frontend assets for the future Node composer. No Worker bindings or
 * deployment configuration are needed to build this client. */
export default defineConfig({
  plugins: [temmlBundlerCompat(), react()],
  optimizeDeps: {
    rolldownOptions: { plugins: [temmlBundlerCompat()] },
  },
  build: { outDir: "dist-node/client" },
});

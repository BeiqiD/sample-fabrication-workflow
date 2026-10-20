import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { temmlBundlerCompat } from "./scripts/temml-bundler-compat.mjs";

export default defineConfig({
  server: {
    allowedHosts: ["terminal.local"],
  },
  plugins: [
    temmlBundlerCompat(),
    react(),
    cloudflare({ configPath: ".wrangler/deploy.jsonc" }),
  ],
  optimizeDeps: {
    rolldownOptions: { plugins: [temmlBundlerCompat()] },
  },
});

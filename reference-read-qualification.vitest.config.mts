import { defineConfig } from "vitest/config";
export default defineConfig({test:{include:["server/reference-read.test.ts","worker/reference-read.qualification.test.ts"],
  environment:"node",maxWorkers:1,fileParallelism:false,setupFiles:["./test/setup-worker-crypto.ts"]}});

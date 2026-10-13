import { defineConfig } from "vitest/config";
export default defineConfig({test:{include:["server/workflow/node-v28-workflow-process.qualification.ts"],environment:"node",
  testTimeout:5000,hookTimeout:10000,maxWorkers:1,fileParallelism:false,bail:1,retry:0,setupFiles:["./test/setup-worker-crypto.ts"]}});

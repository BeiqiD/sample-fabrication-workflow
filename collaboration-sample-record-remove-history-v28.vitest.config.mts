import { defineConfig } from "vitest/config";
export default defineConfig({test:{environment:"node",include:["server/collaboration-sample-record-remove-history-v28.qualification.ts"],fileParallelism:false,maxWorkers:1,testTimeout:20000,hookTimeout:20000}});

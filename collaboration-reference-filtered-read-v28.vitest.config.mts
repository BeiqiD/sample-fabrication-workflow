import {defineConfig} from "vitest/config";
export default defineConfig({test:{include:["server/collaboration-reference-filtered-read-v28.qualification.ts"],environment:"node",maxWorkers:1,fileParallelism:false,hookTimeout:20000}});

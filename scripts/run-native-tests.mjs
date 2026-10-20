import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { pathToFileURL } from "node:url";

export function nativeTestArguments(files, cpus = availableParallelism()) {
  // Node otherwise reserves one CPU, serializing file-isolated tests on
  // two-CPU builders. Preserve its defaults on every other machine.
  return ["--test", ...(cpus === 2 ? ["--test-concurrency=2"] : []), ...files];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cpus = availableParallelism();
  console.log(`Native test file concurrency: ${cpus === 2 ? 2 : "Node default"}; available CPUs: ${cpus}`);
  const child = spawn(process.execPath, nativeTestArguments(process.argv.slice(2), cpus), { stdio: "inherit" });
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
}

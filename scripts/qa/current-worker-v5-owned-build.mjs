// The outer owned controller retains this original process group and first
// close. Every real nested compiler/build/verifier uses that same group and
// resolves only from its original close event; no tee/shell/background owner.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { verifyNodeDistribution } from "../lib/node-distribution-v28-manifest.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const stage = process.argv[2], receipt = process.env.WORKER_V5_OWNED_TOOL_RECEIPT;
if (!receipt || !["worker-v5-types", "worker-v5-build"].includes(stage)) throw new Error("worker_v5_owned_tool_selection");
const children = [];
async function original(argv) {
  const observation = { command: argv, originalCloseAcknowledged: false }; children.push(observation);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { cwd: root, env: process.env, stdio: "inherit", detached: false });
    let originalError;
    child.once("error", error => { originalError = error; });
    child.once("close", (code, signal) => {
      Object.assign(observation, { code, signal, originalCloseAcknowledged: true });
      if (originalError) reject(originalError);
      else if (code !== 0 || signal !== null) reject(new Error("worker_v5_owned_original_child_failed"));
      else resolve();
    });
  });
}
if (stage === "worker-v5-types") {
  for (const configuration of ["tsconfig.worker.json", "tsconfig.worker-v5-native-qualification.json",
    "tsconfig.worker-v5-local-r2-native-qualification.json", "tsconfig.worker-v5-held-node-roundtrip-qualification.json",
    "tsconfig.worker-v5-bound-local-r2-native-qualification.json",
    "tsconfig.worker-v5-present-head-bound-local-r2-native-qualification.json",
    "tsconfig.worker-v5-public-headed-native-qualification.json"])
    await original(["node_modules/typescript/bin/tsc", "-p", configuration]);
} else {
  try { await lstat(join(root, "dist-node")); throw new Error("worker_v5_owned_distribution_already_exists"); }
  catch (error) { if (!error || error.code !== "ENOENT") throw error; }
  await original(["node_modules/typescript/bin/tsc", "-b", "tsconfig.shared.json", "tsconfig.app.json"]);
  await original(["node_modules/vite/bin/vite.js", "build", "--config", "vite.node.config.ts"]);
  await original(["scripts/build-node.mjs"]);
  await original(["dist-node/distribution/tools/verify-node-distribution.mjs", "dist-node/distribution", "--runtime"]);
}
const result = { schema: "current-worker-v5-original-owned-tools/1", stage, originalChildren: children };
if (stage === "worker-v5-build") {
  const directory = join(root, "dist-node/distribution"), manifest = await verifyNodeDistribution(directory, { enforceRuntimeVersion: true });
  Object.assign(result, { distribution: directory, distributionManifestSha256: manifest.manifestSha256,
    distributionSourceInputsSha256: createHash("sha256").update(await readFile(join(directory, "source-inputs.json"))).digest("hex"),
    distributionVersion: manifest.version, distributionFiles: manifest.files, checkpoint: manifest.offlineRecoveryCheckpoint.id });
}
await writeFile(receipt, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });

import { build } from "esbuild";
import { builtinModules } from "node:module";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { distributionFormat, distributionVersion, distributionNodeVersion, distributionCapabilityScope, distributionInstallationCheckpoint, distributionOfflineRecoveryCheckpoint,
  inventoryDistribution, verifyNodeDistribution } from "./lib/node-distribution-v28-manifest.mjs";
import { WORKER_SCHEDULER_MIGRATION_NAME, WORKER_SCHEDULER_MIGRATION_SHA256 } from "../shared/contracts/worker-scheduler-schema-extension.ts";

// Fixed application/operations owners. This script intentionally cannot select
// an arbitrary prototype entry. A genuine main may package the current partial
// development app; its manifest remains explicitly restricted, never a release.
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const entries = [
  { source: "server/main.ts", output: "server/main.mjs", format: "esm" },
  { source: "server/operations/identity-cli.ts", output: "server/identity-cli.cjs", format: "cjs" },
  { source: "server/operations/installation-cli.ts", output: "server/installation-cli.cjs", format: "cjs" },
  { source: "server/operations/restore-v28-cli.ts", output: "server/restore-v28-cli.cjs", format: "cjs" },
];
const builtins = new Set(builtinModules.flatMap(name => [name, name.startsWith("node:") ? name : `node:${name}`]));
const sourceInputs = new Map();
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
let stage;

async function sourceBytes(relative) {
  const file = path.join(root, relative);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error("Invalid distribution source");
  const bytes = await readFile(file);
  sourceInputs.set(relative, { path: relative, bytes: bytes.length, sha256: sha256(bytes) });
  return bytes;
}
async function frontendSources(relative, depth = 0) {
  if (depth > 16 || sourceInputs.size > 8192) throw new Error("Distribution source inventory exceeds its bound");
  const stat = await lstat(path.join(root, relative));
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      await frontendSources(`${relative}/${name}`, depth + 1);
    }
  } else { await sourceBytes(relative); }
}

try {
  if (process.argv.length !== 2) throw new Error("build-node.mjs accepts no entry overrides");
  if (process.versions.node !== distributionNodeVersion) throw new Error(`Node ${distributionNodeVersion} is required for this pinned build`);
  for (const entry of entries) {
    try { await access(path.join(root, entry.source), constants.R_OK); }
    catch { throw new Error(`Distribution executable ${entry.source} is not implemented; no prototype entry fallback is supplied`); }
  }
  // Worker scheduling has a separately reviewed physical suffix. Do not put
  // that SQL in this bounded Node24 installation or its source-input receipt.
  // Refuse changed bytes even though the known suffix is not a Node migration.
  const workerSuccessor = WORKER_SCHEDULER_MIGRATION_NAME;
  const migrationInventory = await readdir(path.join(root, "migrations"), { withFileTypes: true });
  const workerMigration = migrationInventory.find(entry => entry.name === workerSuccessor);
  if (workerMigration && (!workerMigration.isFile()
    || sha256(await readFile(path.join(root, "migrations", workerSuccessor))) !== WORKER_SCHEDULER_MIGRATION_SHA256)) {
    throw new Error("Unreviewed Worker scheduler successor migration");
  }
  if (migrationInventory.some(entry => entry.name > "0024_rt3_local_volume_profiles.sql" && entry.name.endsWith(".sql")
    && entry.name !== workerSuccessor)) throw new Error("Unreviewed Node migration successor inventory");
  for (const relative of ["server/operational-installation-catalog.ts", "server/installation-catalog-v26.ts",
    "migrations/0024_rt3_local_volume_profiles.sql",
    "server/installation-catalog-v28-candidate.ts",
    "server/recovery/empty-target-v28-candidate.ts",
    "server/recovery/restore-v28-candidate.ts",
    "shared/contracts/system-backup-v5-archive-admission.ts",
    "shared/contracts/portable-runtime-v28-recovery-catalog.ts",
    "worker/recovery/portable-runtime-v28-trusted-schema.ts",
    "scripts/lib/restore-system-backup-v28-candidate.ts"]) await sourceBytes(relative);
  const lock = await sourceBytes("package-lock.json");
  const packageBytes = await sourceBytes("package.json");
  const packageJson = JSON.parse(packageBytes.toString("utf8"));
  const packageLock = JSON.parse(lock.toString("utf8"));
  if (packageLock.lockfileVersion !== 3 || packageLock.packages?.[""]?.name !== packageJson.name) {
    throw new Error("Existing exact dependency lock is required");
  }
  // Conservative frontend source inventory supplements the client artifact
  // hashes; it does not claim Vite's output is bitwise reproducible.
  for (const relative of ["src", "public", "shared"]) await frontendSources(relative);
  for (const relative of ["index.html", "vite.node.config.ts", "tsconfig.shared.json", "tsconfig.app.json", "scripts/temml-bundler-compat.mjs", "scripts/build-node.mjs"]) {
    await sourceBytes(relative);
  }
  await mkdir(path.join(root, "dist-node"), { recursive: true });
  // Stage separately. Never delete a populated installation or overwrite a
  // previously built distribution after a failed bundle.
  stage = await mkdtemp(path.join(root, "dist-node/.distribution-stage-"));
  await mkdir(path.join(stage, "server"));
  await cp(path.join(root, "dist-node/client"), path.join(stage, "client"), {
    recursive: true, dereference: false, errorOnExist: true, force: false,
  });
  for (const entry of entries) {
    const result = await build({ absWorkingDir: root, entryPoints: [entry.source],
      outfile: path.join(stage, entry.output), platform: "node", target: "node24.19.0",
      format: entry.format, bundle: true, packages: "bundle", write: false,
      // Preserve the explicitly installed local node_modules alias in input
      // receipts. The existing guard still rejects any application escape.
      preserveSymlinks: true,
      sourcemap: false, legalComments: "none", metafile: true, logLevel: "silent",
      banner: entry.format === "esm" ? { js: 'import {createRequire as __createRequire} from "node:module";const require=__createRequire(import.meta.url);' } : undefined,
      plugins: [{ name: "node-distribution-no-cloudflare-runtime", setup(plugin) {
        plugin.onResolve({ filter: /^(cloudflare:|workerd:|@cloudflare\/|wrangler(?:$|\/)|miniflare(?:$|\/))/ }, () => ({ errors: [{ text: "Cloudflare runtime dependency cannot enter the Node distribution" }] }));
      } }],
    });
    if (result.outputFiles.length !== 1) throw new Error("Unexpected Node bundle outputs");
    for (const output of Object.values(result.metafile.outputs)) {
      if (output.imports.some(item => item.external && !builtins.has(item.path))) {
        throw new Error("Node distribution contains an unbundled non-builtin dependency");
      }
    }
    for (const input of Object.keys(result.metafile.inputs)) {
      const normalized = input.replaceAll("\\", "/");
      if (path.isAbsolute(input) || normalized.startsWith("../") || ["worker/index.ts", "worker/application.ts"].includes(normalized)) {
        throw new Error("Unexpected application/platform source in the Node distribution");
      }
      await sourceBytes(normalized);
    }
    await writeFile(path.join(stage, entry.output), result.outputFiles[0].contents, { flag: "wx", mode: 0o644 });
  }
  await mkdir(path.join(stage, "tools/lib"), { recursive: true });
  const tools = [
    ["scripts/verify-node-distribution.mjs", "tools/verify-node-distribution.mjs"],
    ["scripts/lib/node-distribution-manifest.mjs", "tools/lib/node-distribution-manifest.mjs"],
    ["scripts/lib/node-distribution-v28-manifest.mjs", "tools/lib/node-distribution-v28-manifest.mjs"],
    ["distribution/container-entrypoint.sh", "tools/container-entrypoint.sh"],
  ];
  for (const [source, destination] of tools) {
    await sourceBytes(source);
    await copyFile(path.join(root, source), path.join(stage, destination), constants.COPYFILE_EXCL);
  }
  const inputs = [...sourceInputs.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const sourceReceipt = `${JSON.stringify({ version: 1, inputs }, null, 2)}\n`;
  await writeFile(path.join(stage, "source-inputs.json"), sourceReceipt, { flag: "wx", mode: 0o644 });
  const manifest = { format: distributionFormat, version: distributionVersion, nodeVersion: distributionNodeVersion,
    capabilityScope: distributionCapabilityScope, installationCheckpoint: distributionInstallationCheckpoint,
    offlineRecoveryCheckpoint: distributionOfflineRecoveryCheckpoint,
    packageLockSha256: sha256(lock), sourceInputsSha256: sha256(sourceReceipt),
    files: await inventoryDistribution(stage) };
  await writeFile(path.join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  const receipt = await verifyNodeDistribution(stage, { enforceRuntimeVersion: true });
  // Native rename refuses an existing populated distribution. Concurrent
  // build publishers are unsupported; an existing empty output dir can be
  // replaced. The caller retains old receipts before removing only its prior
  // build output, never a database/volume directory.
  await rename(stage, path.join(root, "dist-node/distribution"));
  stage = undefined;
  process.stdout.write(`${JSON.stringify({ ...receipt, output: "dist-node/distribution", sourceInputs: inputs.length })}\n`);
} catch (error) {
  // Build source errors are finite trusted inputs; no runtime account/configuration file is read.
  process.stderr.write(`${error instanceof Error ? error.message : "Node distribution build failed"}\n`);
  process.exitCode = 1;
} finally {
  if (stage) await rm(stage, { recursive: true, force: true });
}

// Separate QA producer only. Product image and its four executable manifest stay intact.
import assert from "node:assert/strict";
import { builtinModules, createRequire } from "node:module";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const values = process.argv.slice(2);
assert.equal(values.length, 6);
assert.equal(values[0], "--qa"); assert.equal(values[2], "--source"); assert.equal(values[4], "--output");
const qa = path.resolve(values[1]), source = path.resolve(values[3]), output = path.resolve(values[5]);
assert.equal(qa, values[1]); assert.equal(source, values[3]); assert.equal(output, values[5]);
assert.equal(process.getuid?.(), 1000); assert.equal(process.versions.node, "24.19.0");
const dirname = "scripts/qa/node-docker-current-enabled";
const require = createRequire(path.join(qa, "package.json")), { build } = require("esbuild");
const builtins = new Set(builtinModules.flatMap(name => [name, name.startsWith("node:") ? name : "node:" + name]));
const sha = value => createHash("sha256").update(value).digest("hex"), inputs = new Map();
const freeze = JSON.parse(await readFile(path.join(qa, dirname, "source-freeze.json"), "utf8"));
async function input(relative) {
  const file = path.join(qa, relative), observed = await lstat(file);
  assert.ok(observed.isFile() && !observed.isSymbolicLink() && observed.size <= 16 * 1024 * 1024);
  const bytes = await readFile(file);
  if (freeze.files[relative]) {
    const protectedInput = freeze.files[relative]; assert.equal(sha(bytes), protectedInput.sha256);
    assert.equal(sha(await readFile(path.join(source, relative))), protectedInput.sha256);
  } else assert.ok(relative.startsWith(dirname + "/") || relative.startsWith("node_modules/"));
  inputs.set(relative, { path: relative, bytes: bytes.length, sha256: sha(bytes) }); return bytes;
}
// Both installed packages and all source are the real current lock, not an ambient TS fallback.
const lock = await input("package-lock.json"); await input("package.json");
const installed = JSON.parse(await input("node_modules/.package-lock.json"));
assert.equal(installed.lockfileVersion, 3);
assert.deepEqual(JSON.parse(lock).packages[""].dependencies, JSON.parse(await readFile(path.join(qa, "package.json"), "utf8")).dependencies);
await mkdir(output, { mode: 0o700 });
const entries = [
  ["trusted-local-file-setup.ts", "trusted-local-file-setup.cjs"],
  ["inspect-local-file-state.ts", "inspect-local-file-state.cjs"],
  ["container-enabled-api-client.mjs", "container-enabled-api-client.cjs"],
  ["prepare-populated-v25.ts", "prepare-populated-v25.cjs"],
  ["inspect-upgrade-preservation.ts", "inspect-upgrade-preservation.cjs"],
  ["container-upgrade-api-client.mjs", "container-upgrade-api-client.cjs"],
];
const artifacts = [];
for (const [sourceName, artifactName] of entries) {
  await input(dirname + "/" + sourceName);
  const result = await build({ absWorkingDir: qa, entryPoints: [dirname + "/" + sourceName],
    outfile: path.join(output, artifactName), platform: "node", target: "node24.19.0", format: "cjs",
    bundle: true, packages: "bundle", preserveSymlinks: true, write: false, sourcemap: false,
    legalComments: "none", metafile: true, logLevel: "silent",
    plugins: [{ name: "qa-no-cloud-or-worker-platform", setup(plugin) {
      plugin.onResolve({ filter: /^(cloudflare:|workerd:|@cloudflare\/|wrangler(?:$|\/)|miniflare(?:$|\/))/ },
        () => ({ errors: [{ text: "Unsupported QA runtime dependency" }] }));
    } }],
  });
  assert.equal(result.outputFiles.length, 1);
  for (const row of Object.values(result.metafile.outputs))
    assert.ok(row.imports.every(item => !item.external || builtins.has(item.path)));
  for (const relative of Object.keys(result.metafile.inputs)) {
    assert.ok(!path.isAbsolute(relative) && !relative.startsWith("../"));
    assert.ok(!["worker/index.ts", "worker/application.ts"].includes(relative)); await input(relative);
  }
  const bytes = result.outputFiles[0].contents;
  await writeFile(path.join(output, artifactName), bytes, { flag: "wx", mode: 0o400 });
  artifacts.push({ path: artifactName, sha256: sha(bytes), bytes: bytes.length });
}
const sourceInputs = [...inputs.values()].sort((a, b) => a.path.localeCompare(b.path));
const sourceReceipt = JSON.stringify({ scope: "QA_COMPANIONS_ONLY; no product manifest or frontend producer", inputs: sourceInputs }, null, 2) + "\n";
await writeFile(path.join(output, "source-inputs.json"), sourceReceipt, { flag: "wx", mode: 0o400 });
const manifest = { version: 1, targetSourceHead: freeze.sourceHead, targetSourceTree: freeze.sourceTree,
  nodeVersion: process.versions.node, packagedProductExecutableAdditions: 0,
  sourceInputsSha256: sha(sourceReceipt), artifacts };
await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o400 });
process.stdout.write(JSON.stringify({ status: "PASS", qaArtifacts: 6, qaInputCount: inputs.size,
  productExecutableAdditions: 0, targetHead: freeze.sourceHead }) + "\n");

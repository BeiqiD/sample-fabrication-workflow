// Test-only reconstruction of the five reviewed pre-B E/B4 or contracted C
// source files. Reviewed reconstruction inputs may be frozen when production
// evolves; all original reconstruction/C/E hashes and patches stay authoritative.
// No Git history, mutable git ref, production file mutation, or runtime shim.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

async function buildHistoricalWorker(root, stage) {
  const read = (path) => readFileSync(new URL(path, root), "utf8");
  const fixtures = "scripts/fixtures/backend-bridge/";
  const current = JSON.parse(read(`${fixtures}reconstruction-source-hashes.json`));
  const contracted = JSON.parse(read(`${fixtures}c-writer-source-hashes.json`));
  const predecessor = JSON.parse(read(`${fixtures}e-reader-source-hashes.json`));
  const frozen = JSON.parse(read(`${fixtures}frozen-reconstruction-sources.json`));
  assert.equal(current.version, 1);
  assert.equal(contracted.version, 1);
  assert.equal(predecessor.version, 1);
  assert.equal(frozen.version, 1);
  const paths = Object.keys(current.files);
  assert.equal(paths.length, 5);
  assert.deepEqual(paths.sort(), Object.keys(contracted.files).sort());
  assert.deepEqual(paths.sort(), Object.keys(predecessor.files).sort());
  for (const path of Object.keys(frozen.files)) assert(paths.includes(path), `unknown frozen source: ${path}`);
  const scratch = mkdtempSync(join(tmpdir(), `historical-${stage.toLowerCase()}-worker-`));
  try {
    for (const path of paths) {
      assert.match(path, /^worker\/[a-z/-]+\.ts$/);
      const descriptor = frozen.files[path];
      let contents;
      if (descriptor) {
        assert.equal(descriptor.fixture, `${fixtures}reconstruction-sources/${path}.txt`);
        assert.match(descriptor.sourceCommit, /^[a-f0-9]{40}$/);
        assert.equal(descriptor.sha256, current.files[path]);
        const bytes = readFileSync(new URL(descriptor.fixture, root));
        assert.equal(bytes.length, descriptor.byteSize, `frozen source byte size: ${path}`);
        assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), descriptor.sourceBlob,
          `frozen source Git blob identity: ${path}`);
        contents = bytes.toString("utf8");
        assert(Buffer.from(contents, "utf8").equals(bytes), `frozen source UTF-8 bytes: ${path}`);
      } else contents = read(path);
      assert.equal(createHash("sha256").update(contents).digest("hex"), current.files[path], `reviewed reconstruction source: ${path}`);
      const target = join(scratch, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    // Preserve both historical source identities: runtime changes must not be
    // accepted merely by updating the historical C/E hash manifests.
    execFileSync("git", ["apply", "--whitespace=error-all", fileURLToPath(new URL(`${fixtures}restore-reviewed-c-source.patch`, root))], { cwd: scratch });
    for (const path of paths) {
      const contents = readFileSync(join(scratch, path), "utf8");
      assert.equal(createHash("sha256").update(contents).digest("hex"), contracted.files[path], `reviewed C source: ${path}`);
    }
    if (stage === "E") {
      // The original approved patches are B -> C and B -> E. Reconstruct C -> B -> E.
      execFileSync("git", ["apply", "--reverse", "--whitespace=error-all", fileURLToPath(new URL(`${fixtures}restore-c-writer.patch`, root))], { cwd: scratch });
      execFileSync("git", ["apply", "--whitespace=error-all", fileURLToPath(new URL(`${fixtures}restore-e-reader.patch`, root))], { cwd: scratch });
    }
    const expected = stage === "E" ? predecessor : contracted;
    const replacements = new Map(paths.map((path) => {
      const contents = readFileSync(join(scratch, path), "utf8");
      assert.equal(createHash("sha256").update(contents).digest("hex"), expected.files[path], `reviewed historical ${stage} source: ${path}`);
      return [fileURLToPath(new URL(path, root)), contents];
    }));
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL("worker/index.ts", root))],
      write: false, bundle: true, format: "esm", platform: "browser", target: "es2022",
      conditions: ["workerd", "worker", "browser"], logLevel: "silent",
      nodePaths: [fileURLToPath(new URL("node_modules", root))],
      plugins: [{ name: `verified-historical-${stage.toLowerCase()}-sources`, setup(bundler) {
        bundler.onLoad({ filter: /\.ts$/ }, ({ path }) => replacements.has(path)
          ? { contents: replacements.get(path), loader: "ts", resolveDir: dirname(path) } : undefined);
      } }],
    });
    return bundle.outputFiles[0].text;
  } finally { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

export function buildHistoricalEWorker(root) { return buildHistoricalWorker(root, "E"); }
export function buildHistoricalCWorker(root) { return buildHistoricalWorker(root, "C"); }

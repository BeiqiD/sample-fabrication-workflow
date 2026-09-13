// Test-only reconstruction of the five reviewed pre-B E/B4 source files.
// Current runtime changes are first undone to the immutable reviewed C inputs.
// No Git history, mutable git ref, production file mutation, or runtime shim.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export async function buildHistoricalEWorker(root) {
  const read = (path) => readFileSync(new URL(path, root), "utf8");
  const fixtures = "scripts/fixtures/backend-bridge/";
  const current = JSON.parse(read(`${fixtures}reconstruction-source-hashes.json`));
  const contracted = JSON.parse(read(`${fixtures}c-writer-source-hashes.json`));
  const predecessor = JSON.parse(read(`${fixtures}e-reader-source-hashes.json`));
  assert.equal(current.version, 1);
  assert.equal(contracted.version, 1);
  assert.equal(predecessor.version, 1);
  const paths = Object.keys(current.files);
  assert.equal(paths.length, 5);
  assert.deepEqual(paths.sort(), Object.keys(contracted.files).sort());
  assert.deepEqual(paths.sort(), Object.keys(predecessor.files).sort());
  const scratch = mkdtempSync(join(tmpdir(), "historical-e-worker-"));
  try {
    for (const path of paths) {
      assert.match(path, /^worker\/[a-z/-]+\.ts$/);
      const contents = read(path);
      assert.equal(createHash("sha256").update(contents).digest("hex"), current.files[path], `reviewed reconstruction source: ${path}`);
      const target = join(scratch, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    // Preserve both historical source identities: current runtime changes must
    // not be accepted merely by updating the historical C/E hash manifests.
    execFileSync("git", ["apply", "--whitespace=error-all", fileURLToPath(new URL(`${fixtures}restore-reviewed-c-source.patch`, root))], { cwd: scratch });
    for (const path of paths) {
      const contents = readFileSync(join(scratch, path), "utf8");
      assert.equal(createHash("sha256").update(contents).digest("hex"), contracted.files[path], `reviewed C source: ${path}`);
    }
    // The original approved patches are B -> C and B -> E. Reconstruct C -> B -> E.
    execFileSync("git", ["apply", "--reverse", "--whitespace=error-all", fileURLToPath(new URL(`${fixtures}restore-c-writer.patch`, root))], { cwd: scratch });
    execFileSync("git", ["apply", "--whitespace=error-all", fileURLToPath(new URL(`${fixtures}restore-e-reader.patch`, root))], { cwd: scratch });
    const replacements = new Map(paths.map((path) => {
      const contents = readFileSync(join(scratch, path), "utf8");
      assert.equal(createHash("sha256").update(contents).digest("hex"), predecessor.files[path], `reviewed historical E source: ${path}`);
      return [fileURLToPath(new URL(path, root)), contents];
    }));
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL("worker/index.ts", root))],
      write: false, bundle: true, format: "esm", platform: "browser", target: "es2022",
      conditions: ["workerd", "worker", "browser"], logLevel: "silent",
      nodePaths: [fileURLToPath(new URL("node_modules", root))],
      plugins: [{ name: "verified-historical-e-sources", setup(bundler) {
        bundler.onLoad({ filter: /\.ts$/ }, ({ path }) => replacements.has(path)
          ? { contents: replacements.get(path), loader: "ts", resolveDir: dirname(path) } : undefined);
      } }],
    });
    return bundle.outputFiles[0].text;
  } finally { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

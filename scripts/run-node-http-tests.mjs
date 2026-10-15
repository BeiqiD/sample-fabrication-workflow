import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Bundle the original fixed QA entrypoints so Node need not resolve the
// application's extensionless TypeScript imports. Cases and budgets stay owned
// by their original sources and Node's native test runner.
if (process.argv.length !== 2) throw new Error("run-node-http-tests.mjs accepts no entry overrides");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entries = ["http.test", "http-lifetime.test", "static-assets.test"];
const builtins = new Set(builtinModules.flatMap(name => [name, name.startsWith("node:") ? name : `node:${name}`]));
const temporary = await mkdtemp(join(tmpdir(), "node-http-tests-"));
let failed = false, failure;
try {
  await chmod(temporary, 0o700);
  const files = entries.map(name => join(temporary, `${name}.mjs`));
  const result = await build({
    absWorkingDir: root,
    entryPoints: Object.fromEntries(entries.map(name => [name, `server/${name}.mts`])),
    outdir: temporary, outExtension: { ".js": ".mjs" },
    bundle: true, packages: "bundle", platform: "node", format: "esm", target: "node24",
    write: false, metafile: true, sourcemap: false, legalComments: "none", logLevel: "silent",
    banner: { js: 'import {createRequire as __nodeHttpQaCreateRequire} from "node:module";const require=__nodeHttpQaCreateRequire(import.meta.url);' },
  });
  if (result.outputFiles.length !== files.length
    || result.outputFiles.some(output => !files.includes(output.path))) throw new Error("Unexpected Node HTTP QA bundle outputs");
  for (const output of Object.values(result.metafile.outputs)) {
    if (output.imports.some(item => item.external && !builtins.has(item.path)))
      throw new Error("Node HTTP QA bundle contains an unbundled non-builtin dependency");
  }
  for (const output of result.outputFiles) await writeFile(output.path, output.contents, { flag: "wx", mode: 0o600 });
  const child = spawn(process.execPath, ["--experimental-transform-types", "--test", "--test-concurrency=1", ...files],
    { cwd: root, stdio: "inherit" });
  let childError;
  const outcome = await new Promise(resolve => {
    child.once("error", error => { childError = error; });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  if (childError) throw childError;
  if (outcome.signal !== null) throw new Error(`Original Node HTTP test child closed with signal ${outcome.signal}`);
  process.exitCode = outcome.code ?? 1;
} catch (error) { failed = true; failure = error; }
// Wait for the original child close before removing its private bundle files.
// Cleanup failure remains visible alongside any original build/spawn failure.
try { await rm(temporary, { recursive: true, force: true }); }
catch (error) {
  failure = failed ? new AggregateError([failure, error], "Node HTTP QA runner and original cleanup failed") : error;
  failed = true;
}
if (failed) { process.exitCode ||= 1; throw failure; }

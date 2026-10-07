import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
const databasePath = option("--db"), bindingsPath = option("--bindings");
if (!databasePath || !bindingsPath) throw new Error("Usage: node scripts/run-file-jobs.mjs --db persisted.sqlite --bindings runtime-bindings.mjs [--once] [--enable]");
const temporary = await mkdtemp(join(tmpdir(), "fp3-local-runner-"));
let opened;
try {
  const bundled = join(temporary, "runtime.mjs");
  await build({ entryPoints: [new URL("./lib/file-job-node-runtime.ts", import.meta.url).pathname],
    outfile: bundled, bundle: true, platform: "node", format: "esm", packages: "external", logLevel: "silent" });
  const runtime = await import(pathToFileURL(bundled).href);
  opened = runtime.openNodeFileJobRepository(resolve(databasePath));
  // Trusted local runtime module supplies exact registered storage capabilities
  // and current administrator policy; it never fabricates a Cloudflare Env.
  const bindings = await import(pathToFileURL(resolve(bindingsPath)).href);
  const supplied = await bindings.createFileJobBindings();
  if (typeof supplied?.openStorage !== "function" || typeof supplied?.authorizeAdministrator !== "function"
    || typeof supplied?.authorizeSystemCleanup !== "function") throw new Error("Invalid File job runtime bindings");
  if (args.includes("--enable")) {
    if (supplied.authorizeSystemCleanup() !== true) throw new Error("Installation maintenance authority is required to enable local jobs");
    runtime.enableNodeFileJobs(opened.database);
  }
  const guard = opened.database.prepare("SELECT incarnation FROM file_job_runtime_guard WHERE singleton=1 AND enabled=1").get();
  if (!guard?.incarnation) throw new Error("Local File job executor is disabled; explicit --enable creates a new incarnation");
  const stopped = new AbortController();
  process.once("SIGINT", () => stopped.abort()); process.once("SIGTERM", () => stopped.abort());
  await runtime.runFileJobLoop({ ...supplied, repository: opened.repository, incarnation: guard.incarnation,
    now: () => new Date(), randomId: randomUUID }, { once: args.includes("--once"), signal: stopped.signal });
} finally { opened?.close(); await rm(temporary, { recursive: true, force: true }); }

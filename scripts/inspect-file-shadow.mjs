import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = "Usage: npm run inspect:file-shadow -- --database CLOSED_SNAPSHOT.sqlite --output NEW_REPORT.json";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  if (args.length !== 4) throw new Error(usage);
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!["--database", "--output"].includes(key) || options.has(key) || !value) throw new Error(usage);
    options.set(key, value);
  }
  if (!options.has("--database") || !options.has("--output")) throw new Error(usage);
  const temporary = await mkdtemp(join(tmpdir(), "file-shadow-inspection-"));
  try {
    const modulePath = join(temporary, "inspection.mjs");
    await build({ entryPoints: [join(root, "scripts/lib/file-shadow-inspection-cli.ts")], bundle: true,
      platform: "node", format: "esm", outfile: modulePath, logLevel: "silent" });
    const { inspectFileShadowSnapshot } = await import(pathToFileURL(modulePath).href);
    const result = await inspectFileShadowSnapshot({ databasePath: options.get("--database"), outputPath: options.get("--output") });
    console.log(JSON.stringify(result, null, 2));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

try { await main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : "File shadow inspection failed");
  process.exitCode = 1;
}

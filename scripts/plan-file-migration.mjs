import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const usage = "Usage: npm run plan:file-migration -- --snapshot COMPLETE_V10_SNAPSHOT.json --output NEW_REPORT.json";

async function main() {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  if (args.length !== 4 || args[0] !== "--snapshot" || !args[1] || args[2] !== "--output" || !args[3]) throw new Error(usage);
  const temporary = await mkdtemp(join(tmpdir(), "file-migration-plan-"));
  try {
    const modulePath = join(temporary, "planner.mjs");
    await build({ entryPoints: [join(root, "scripts/lib/file-migration-cli.ts")], bundle: true,
      platform: "node", format: "esm", outfile: modulePath, logLevel: "silent" });
    const { planFileMigrationSnapshot } = await import(pathToFileURL(modulePath).href);
    const result = await planFileMigrationSnapshot({ snapshotPath: args[1], outputPath: args[3] });
    console.log(JSON.stringify(result, null, 2));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

try { await main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : "File migration planning failed");
  process.exitCode = 1;
}

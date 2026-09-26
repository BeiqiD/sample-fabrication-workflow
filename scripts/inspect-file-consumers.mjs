import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = "Usage: npm run inspect:file-consumers -- --database CLOSED_SNAPSHOT.sqlite --output NEW_REPORT.json [--limit 20] [--after CURSOR_JSON]";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  if (args.length < 4 || args.length % 2 !== 0) throw new Error(usage);
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!["--database", "--output", "--limit", "--after"].includes(key) || options.has(key) || !value) throw new Error(usage);
    options.set(key, value);
  }
  if (!options.has("--database") || !options.has("--output")) throw new Error(usage);
  const limit = options.has("--limit") ? Number(options.get("--limit")) : undefined;
  if (limit !== undefined && (!/^[1-9][0-9]*$/.test(options.get("--limit")) || !Number.isSafeInteger(limit))) throw new Error(usage);
  let after;
  if (options.has("--after")) {
    if (Buffer.byteLength(options.get("--after"), "utf8") > 64 * 1024) throw new Error("Cursor exceeds the byte limit");
    try { after = JSON.parse(options.get("--after")); }
    catch { throw new Error("Cursor must be valid JSON from a previous report"); }
  }
  const temporary = await mkdtemp(join(tmpdir(), "file-consumer-preflight-"));
  try {
    const modulePath = join(temporary, "preflight.mjs");
    await build({ entryPoints: [join(root, "scripts/lib/file-consumer-preflight-cli.ts")], bundle: true,
      platform: "node", format: "esm", outfile: modulePath, logLevel: "silent" });
    const { inspectFileConsumerSnapshot } = await import(pathToFileURL(modulePath).href);
    const result = await inspectFileConsumerSnapshot({
      databasePath: options.get("--database"), outputPath: options.get("--output"), limit, after,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

try { await main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : "File consumer inspection failed");
  process.exitCode = 1;
}

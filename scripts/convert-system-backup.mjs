import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const usage = "Usage: node scripts/convert-system-backup.mjs --archive LEGACY_ARCHIVE.zip --destination NEW_LOCAL_DIRECTORY";
if (args.length !== 4 || args[0] !== "--archive" || !args[1] || args[2] !== "--destination" || !args[3]) throw new Error(usage);
const temporary = await mkdtemp(join(tmpdir(), "system-backup-converter-"));
try {
  const output = join(temporary, "converter.mjs");
  await build({ entryPoints: [join(root, "scripts/lib/convert-system-backup.ts")], bundle: true, platform: "node", format: "esm", outfile: output, logLevel: "silent",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
  const { convertLegacySystemBackup } = await import(pathToFileURL(output).href);
  process.stdout.write(`${JSON.stringify(await convertLegacySystemBackup({ archivePath: resolve(args[1]), destination: resolve(args[3]), migrationsDirectory: join(root, "migrations") }), null, 2)}\n`);
} finally { await rm(temporary, { recursive: true, force: true }); }

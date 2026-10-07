import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--archive" || !args[1] || args[2] !== "--destination" || !args[3])
  throw new Error("Usage: node scripts/restore-system-backup.mjs --archive SYSTEM_BACKUP.zip --destination NEW_LOCAL_DIRECTORY");
const temporary = await mkdtemp(join(tmpdir(), "system-backup-offline-"));
try {
  const output = join(temporary, "restore.mjs");
  await build({ entryPoints: [join(root, "scripts/lib/restore-system-backup.ts")], bundle: true, platform: "node", format: "esm", outfile: output, logLevel: "silent",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
  const { restoreSystemBackupToIsolatedDirectory } = await import(pathToFileURL(output).href);
  process.stdout.write(`${JSON.stringify(await restoreSystemBackupToIsolatedDirectory({ archivePath: resolve(args[1]), destination: resolve(args[3]) }), null, 2)}\n`);
} finally { await rm(temporary, { recursive: true, force: true }); }

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const usage = "Usage: npm run verify:export-restore -- --archive archive.zip --destination NEW_LOCAL_DIRECTORY [--target-schema S0|S1|S2] [--migrations-dir REVIEWED_LOCAL_DIRECTORY]";
if (args.length < 4 || args.length > 8 || args.length % 2 || args[0] !== "--archive" || args[2] !== "--destination") throw new Error(usage);
let targetCompatibilitySchema;
let migrationsDirectory = join(root, "migrations");
const seen = new Set();
for (let index = 4; index < args.length; index += 2) {
  const flag = args[index], value = args[index + 1];
  if (seen.has(flag)) throw new Error(usage);
  seen.add(flag);
  if (flag === "--target-schema" && ["S0", "S1", "S2"].includes(value)) targetCompatibilitySchema = value;
  else if (flag === "--migrations-dir" && value) migrationsDirectory = resolve(value);
  else throw new Error(usage);
}
const temporary = await mkdtemp(join(tmpdir(), "sample-export-restore-"));
try {
  const output = join(temporary, "restore.mjs");
  await build({
    entryPoints: [join(root, "scripts/lib/export-restore.ts")],
    bundle: true, platform: "node", format: "esm", outfile: output, logLevel: "silent",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  });
  const { restoreExportToIsolatedDirectory } = await import(pathToFileURL(output).href);
  const result = await restoreExportToIsolatedDirectory({
    archivePath: resolve(args[1]), destination: resolve(args[3]),
    migrationsDirectory, targetCompatibilitySchema,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}

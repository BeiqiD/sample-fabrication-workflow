import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baselineFilename, compatibilityDirectory, generateS2Baseline } from "./lib/backend-schema-baseline.mjs";

// This local-only generator creates no database file and accepts no target,
// credentials, deployment config or remote option.
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
assert(args.length === 1 && ["--check", "--write"].includes(args[0]),
  "Usage: node scripts/generate-backend-s2-baseline.mjs --check|--write");
const { sql } = generateS2Baseline(root);
const path = resolve(root, compatibilityDirectory, baselineFilename);
if (args[0] === "--write") await writeFile(path, sql, "utf8");
else assert.equal(await readFile(path, "utf8"), sql, "Inactive S2 baseline differs from the full historical chain and reviewed S1/S2 sources");
console.log(`Inactive S2 baseline ${args[0] === "--write" ? "generated" : "matches"}: ${compatibilityDirectory}/${baselineFilename}`);

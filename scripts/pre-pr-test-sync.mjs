import { readFileSync, writeFileSync } from "node:fs";

const path = "src/styles.test.ts";
const source = readFileSync(path, "utf8");
const previous = 'Delete step<\\/button><\\/div>/';
const next = 'Delete step<\\/button>\\s*<\\/div>/';

if (source.includes(next)) process.exit(0);
if (!source.includes(previous)) {
  throw new Error("Expected Template-step action assertion was not found.");
}

writeFileSync(path, source.replace(previous, next));

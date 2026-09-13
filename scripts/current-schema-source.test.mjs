import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const sqlNames = (directory) => readdirSync(new URL(directory, root)).filter((name) => name.endsWith(".sql")).sort();

test("the current chain admits the reviewed FP1 suffix and retains the S2 baseline and all 37 historical SQL files byte-for-byte", () => {
  assert.deepEqual(sqlNames("migrations/"), ["0001_v3_baseline.sql", "0002_fp1_file_registry.sql", "0003_fp1_import_acceptance.sql"]);
  const baseline = readFileSync(new URL("scripts/fixtures/backend-schema/s2-baseline.sql", root));
  assert.deepEqual(readFileSync(new URL("migrations/0001_v3_baseline.sql", root)), baseline);
  const recorded = [...baseline.toString("utf8").matchAll(/^-- Source migrations\/([^ /]+\.sql) sha256=([a-f0-9]{64})$/gm)];
  assert.equal(recorded.length, 37);
  assert.deepEqual(sqlNames("migrations-history/s0/"), recorded.map((match) => match[1]).sort());
  for (const [, name, expected] of recorded) {
    const actual = createHash("sha256").update(readFileSync(new URL(`migrations-history/s0/${name}`, root))).digest("hex");
    assert.equal(actual, expected, `Retained historical SQL bytes: ${name}`);
  }
});

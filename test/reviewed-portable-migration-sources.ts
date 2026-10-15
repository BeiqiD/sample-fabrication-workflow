import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { PORTABLE_RUNTIME_RECOVERY_MIGRATIONS as V25_MIGRATIONS } from "../shared/contracts/portable-runtime-recovery-catalog";
import { PORTABLE_RUNTIME_RECOVERY_MIGRATIONS as V26_MIGRATIONS } from "../shared/contracts/portable-runtime-v26-recovery-catalog";

/** Read exact reviewed fixture bytes, without executing SQL. A frozen V25
 * fixture still verifies the complete newer source inventory, then executes
 * only its original 23 receipts. Unknown successors never disappear in a
 * prefix filter, and SQL fixture flags never become physical authority. */
export function reviewedPortableMigrationSources(version: 25 | 26,
  directory = new URL("../migrations/", import.meta.url)) {
  if (version !== 25 && version !== 26) throw new Error("Unreviewed portable fixture version");
  const entries = readdirSync(directory, { withFileTypes: true });
  const names = entries.filter(entry => entry.name !== "README.md").map(entry => entry.name).sort();
  if (entries.some(entry => !entry.isFile())
    || JSON.stringify(names) !== JSON.stringify(V26_MIGRATIONS.map(migration => migration.name)))
    throw new Error("Unreviewed portable fixture migration inventory");
  if (V25_MIGRATIONS.length !== 23 || V26_MIGRATIONS.length !== 24
    || V25_MIGRATIONS.some((migration, index) => migration.name !== V26_MIGRATIONS[index].name
      || migration.sha256 !== V26_MIGRATIONS[index].sha256))
    throw new Error("Frozen V25 fixture receipts differ from the reviewed V26 prefix");
  const sources = V26_MIGRATIONS.map(migration => {
    const bytes = readFileSync(new URL(migration.name, directory));
    if (createHash("sha256").update(bytes).digest("hex") !== migration.sha256)
      throw new Error(`Reviewed portable fixture raw digest changed: ${migration.name}`);
    return { name: migration.name, sha256: migration.sha256, sql: bytes.toString("utf8") };
  });
  const selected = version === 25 ? V25_MIGRATIONS : V26_MIGRATIONS;
  return sources.filter(source => selected.some(migration => migration.name === source.name));
}

import { readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { planExportRestoreMigrations } from "./export-restore";

it("keeps V7–V18 schema upgrades while excluding only the reviewed deployment cleanup", () => {
  const cleanup = "0011_fp1_retire_legacy_test_projects.sql";
  const names = readdirSync(new URL("../../migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
  expect(names.at(-1)).toBe("0012_fp1_file_authority_runtime.sql");
  const schemaNames = names.filter(name => name !== cleanup);
  for (let version = 7; version <= 18; version++) {
    const plan = planExportRestoreMigrations(names, version);
    expect(plan).toEqual(planExportRestoreMigrations(schemaNames, version));
    expect(plan.schemaNames).toEqual(schemaNames);
    expect(plan.forwardNames).toEqual(schemaNames.slice(Math.max(1, version - 7)));
  }
  const legacyPrefix = schemaNames.slice(0, 3);
  expect(planExportRestoreMigrations(legacyPrefix, 8)).toEqual({
    schemaNames: legacyPrefix, forwardNames: legacyPrefix.slice(1),
  });
  const otherMigration = "0013_unreviewed_cleanup.sql";
  expect(planExportRestoreMigrations([...names, otherMigration], 17).schemaNames).toContain(otherMigration);
});

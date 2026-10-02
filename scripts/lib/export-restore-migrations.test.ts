import { readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { planExportRestoreMigrations } from "./export-restore";
import { SYSTEM_STORAGE_CONFIGURATION_MIGRATIONS } from "../../shared/contracts/storage-configuration-schema";

it("keeps V7–V20 content upgrades while excluding reviewed cleanup and installation configuration, check evidence and key-maintenance receipts", () => {
  const cleanup = "0011_fp1_retire_legacy_test_projects.sql";
  const names = readdirSync(new URL("../../migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
  expect(names).toContain("0017_fp2_native_storage_profiles.sql");
  const schemaNames = names.filter(name => name !== cleanup && !SYSTEM_STORAGE_CONFIGURATION_MIGRATIONS.includes(name as typeof SYSTEM_STORAGE_CONFIGURATION_MIGRATIONS[number]));
  for (let version = 7; version <= 20; version++) {
    const plan = planExportRestoreMigrations(names, version);
    expect(plan).toEqual(planExportRestoreMigrations(schemaNames, version));
    expect(plan.schemaNames).toEqual(schemaNames);
    expect(plan.forwardNames).toEqual(schemaNames.slice(Math.max(1, version - 7)));
  }
  const legacyPrefix = schemaNames.slice(0, 3);
  expect(planExportRestoreMigrations(legacyPrefix, 8)).toEqual({
    schemaNames: legacyPrefix, forwardNames: legacyPrefix.slice(1),
  });
  const otherMigration = "0016_unreviewed_cleanup.sql";
  expect(planExportRestoreMigrations([...names, otherMigration], 17).schemaNames).toContain(otherMigration);
});

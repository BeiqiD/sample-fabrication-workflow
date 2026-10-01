import { readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { planExportRestoreMigrations } from "./export-restore";
import { SYSTEM_STORAGE_CONFIGURATION_MIGRATION } from "../../shared/contracts/storage-configuration-schema";

it("keeps V7–V19 content upgrades while excluding reviewed cleanup and installation configuration", () => {
  const cleanup = "0011_fp1_retire_legacy_test_projects.sql";
  const names = readdirSync(new URL("../../migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
  expect(names.at(-1)).toBe(SYSTEM_STORAGE_CONFIGURATION_MIGRATION);
  const schemaNames = names.filter(name => name !== cleanup && name !== SYSTEM_STORAGE_CONFIGURATION_MIGRATION);
  for (let version = 7; version <= 19; version++) {
    const plan = planExportRestoreMigrations(names, version);
    expect(plan).toEqual(planExportRestoreMigrations(schemaNames, version));
    expect(plan.schemaNames).toEqual(schemaNames);
    expect(plan.forwardNames).toEqual(schemaNames.slice(Math.max(1, version - 7)));
  }
  const legacyPrefix = schemaNames.slice(0, 3);
  expect(planExportRestoreMigrations(legacyPrefix, 8)).toEqual({
    schemaNames: legacyPrefix, forwardNames: legacyPrefix.slice(1),
  });
  const otherMigration = "0014_unreviewed_cleanup.sql";
  expect(planExportRestoreMigrations([...names, otherMigration], 17).schemaNames).toContain(otherMigration);
});

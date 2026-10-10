import { expect } from "vitest";
import type { ExportTables } from "../shared/contracts/export";
import { FILE_NATIVE_RUNTIME_ADDED_COLUMNS } from "../shared/contracts/file-native-runtime";
import { SYSTEM_RECOVERY_EVIDENCE_EXPORT_COLUMNS } from "../shared/contracts/export-system-recovery-evidence";

/** Forward recovery may add classified nullable columns and bootstrap policy
 * history. Every original cell must survive, and no new execution or accepted
 * native target may be fabricated from a historical archive. */
export function expectHistoricalForwardTables(recovered: ExportTables, historical: ExportTables) {
  const addedColumns: Record<string, readonly string[]> = FILE_NATIVE_RUNTIME_ADDED_COLUMNS;
  const projected = Object.fromEntries(Object.keys(historical).map(name => [name, recovered[name].map(value => {
    const row = { ...value };
    for (const column of addedColumns[name] ?? []) {
      expect(row[column], `${name}.${column} historical value`).toBeNull();
      delete row[column];
    }
    return row;
  })]));
  expect(projected).toEqual(historical);
  for (const name of ["storage_profile_activations", "import_file_acceptances", "file_migration_jobs", "file_migration_items", "file_migration_attempts"])
    expect(recovered[name], `${name} forward history`).toEqual([]);
  for (const name of ["research_package_jobs", "research_package_requests", "research_package_records", "research_package_files",
    "research_package_attempts", "research_package_identity_maps"])
    expect(recovered[name], `${name} forward history`).toEqual([]);
  expect(recovered.research_package_source_identity).toEqual([
    { singleton: 1, installation_id: expect.stringMatching(/^[a-f0-9]{32}$/) },
  ]);
  for (const name of Object.keys(SYSTEM_RECOVERY_EVIDENCE_EXPORT_COLUMNS))
    expect(recovered[name], `${name} forward history`).toEqual([]);
  expect(recovered.storage_role_policy_revisions).toEqual((historical.storage_role_defaults ?? []).map(row => ({
    ...row, operation_id: "storage-role-policy:legacy:2", actor: "bootstrap",
  })));
}

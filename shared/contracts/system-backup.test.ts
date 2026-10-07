import { describe, expect, it } from "vitest";
import type { FullExportManifestV24 } from "./export";
import type { SystemRecoveryImageV1 } from "./system-recovery-image";
import { finishSystemBackupManifest, planSystemBackupSources, sourceBackupCheckpoint, systemBackupProtectedConfiguration,
  SYSTEM_BACKUP_MAX_FILES, type SystemBackupFile, type SystemBackupRecordsV1 } from "./system-backup";
import { validateSystemBackupMigrationLedger } from "./system-backup";
import { RECOVERY_MIGRATIONS } from "./system-recovery-catalog";

const digest = "a".repeat(64), clock = "2026-10-06T12:00:00.000Z";
function fixture(): SystemBackupRecordsV1 {
  const source = { locatorId: '["r2","r2","shared"]', storeKind: "r2", provider: "r2", objectKey: "shared", blobRecordIds: ["asset"], filename: "shared.png",
    expectedByteSize: 8, expectedSha256: digest, sourceOccurrences: [], downloadUrl: "/exports/r2/shared", initialOutcome: null,
    byteAuthority: "legacy", storageProfileId: null, storageProfileRevision: null, locationId: null };
  const content = { tables: { research_package_source_identity: [{ singleton: 1, installation_id: "installation" }],
    assets: [{ id: "asset", r2_key: "shared", file_id: null }], files: [], file_locations: [], legacy_file_mappings: [],
    file_consumer_projection: [
      { consumer_kind: "run_step_asset", consumer_id: "step", consumer_sub_id: "", file_slot: "primary", file_id: null, expected_purpose: "embedded_content", legacy_r2_object_key: "shared" },
      { consumer_kind: "template_version", consumer_id: "revision", consumer_sub_id: "", file_slot: "source", file_id: null, expected_purpose: "research_source", legacy_r2_object_key: "shared" },
    ] }, blobs: [source], relocatedSources: [], backupHoldOwner: "backup" } as unknown as FullExportManifestV24;
  const image: SystemRecoveryImageV1 = { version: 1, kind: "system-recovery-image", schemaSha256: digest, sourceSnapshotClock: clock,
    tables: { samples: { columns: ["id"], rows: [{ rowid: "9007199254740993", cells: [{ type: "text", value: "sample" }] }] },
      file_location_holds: { columns: ["hold_kind", "operation_id", "released_at"], rows: [] },
      system_storage_credential_payloads: { columns: ["key_id", "ciphertext"], rows: [{ rowid: "1", cells: [{ type: "text", value: "root-key" }, { type: "text", value: "encrypted-only" }] }] } } };
  return { schema: "system-backup-records/1", backupId: "backup", createdAt: clock, content, image,
    protectedConfiguration: systemBackupProtectedConfiguration(image), sourceMigrationLedger: { status: "unavailable", entries: [] },
    origin: { format: "native", schemaVersion: 24, archiveSha256: null, legacyArtifacts: null, migrationEvidence: [] } };
}
function packaged(records: SystemBackupRecordsV1): SystemBackupFile[] {
  return planSystemBackupSources(records.content).map(source => ({ ...source, path: `files/${source.id}`, outcome: "packaged", byteSize: 8, sha256: digest }));
}
describe("full system backup completeness and immutable source identity", () => {
  it("retains distinct internal/original purposes and consumer slots sharing one physical blob", () => {
    const records = fixture(), plan = planSystemBackupSources(records.content);
    expect(plan).toHaveLength(1); expect(plan[0].id).toBe("b_0000");
    expect(plan[0].purposes).toEqual(["embedded_content", "research_source"]);
    expect(plan[0].bindings.map(binding => binding.consumerKind).sort()).toEqual(["run_step_asset", "template_version"]);
    expect(plan[0].source).toEqual(records.content.blobs[0]);
  });
  it("reports partial recovery visibly and never invents ready bytes", async () => {
    const records = fixture(), files = packaged(records);
    const complete = await finishSystemBackupManifest(records, files);
    expect(complete.completeness).toBe("complete"); expect(complete.counts).toMatchObject({ sources: 1, packagedFiles: 1, unavailableFiles: 0, bytes: 8 });
    const missing = { ...files[0], path: null, outcome: "missing" as const, byteSize: null, sha256: null };
    const partial = await finishSystemBackupManifest(records, [missing]);
    expect(partial.completeness).toBe("partial"); expect(partial.counts).toMatchObject({ packagedFiles: 0, unavailableFiles: 1, bytes: 0 });
    await expect(finishSystemBackupManifest(records, [{ ...missing, path: "files/b_0000" }])).rejects.toThrow("unavailable_payload");
  });
  it("rejects altered promises, missing sources, hash mismatch and forged logical identities", async () => {
    const records = fixture(), files = packaged(records);
    await expect(finishSystemBackupManifest(records, [])).rejects.toThrow("file_inventory");
    await expect(finishSystemBackupManifest(records, [{ ...files[0], byteSize: 7 }])).rejects.toThrow("promised_size");
    await expect(finishSystemBackupManifest(records, [{ ...files[0], sha256: "b".repeat(64) }])).rejects.toThrow("promised_hash");
    await expect(finishSystemBackupManifest(records, [{ ...files[0], fileIds: ["invented"] }])).rejects.toThrow("source_inventory");
    const unavailable = structuredClone(records); unavailable.content.blobs[0].initialOutcome = "metadata_not_ready";
    await expect(finishSystemBackupManifest(unavailable, packaged(unavailable))).rejects.toThrow("unavailable_source_packaged");
  });
  it("keeps the shared physical file count budget explicit", () => {
    const records = fixture(); records.content.blobs = Array.from({ length: SYSTEM_BACKUP_MAX_FILES + 1 }, () => records.content.blobs[0]);
    expect(() => planSystemBackupSources(records.content)).toThrow("file_budget");
  });
  it("archives encrypted key descriptors while excluding root material and execution grants", () => {
    const records = fixture();
    expect(records.protectedConfiguration).toEqual({ policy: "encrypted-configuration-quarantine/1", status: "included_encrypted",
      tableNames: ["system_storage_credential_payloads"], keyIds: ["root-key"], rootKeysIncluded: false, automaticExecution: false });
    expect(() => systemBackupProtectedConfiguration(records.image, "excluded_legacy_content")).toThrow("legacy_configuration_not_empty");
  });
  it("admits actual migration receipts as bounded inert provenance with reviewed hashes only", () => {
    const reviewed = RECOVERY_MIGRATIONS[0];
    const ledger = { status: "observed", entries: [{ id: "9007199254740993", name: reviewed.name, appliedAt: clock, rawSha256: reviewed.sha256 }] };
    expect(validateSystemBackupMigrationLedger(ledger)).toEqual(ledger);
    expect(() => validateSystemBackupMigrationLedger({ ...ledger, entries: [...ledger.entries, ledger.entries[0]] })).toThrow("source_migration_ledger_entry");
    expect(() => validateSystemBackupMigrationLedger({ status: "unavailable", entries: ledger.entries })).toThrow("source_migration_ledger_unavailable");
    expect(() => validateSystemBackupMigrationLedger({ ...ledger, entries: [{ ...ledger.entries[0], rawSha256: digest }] })).toThrow("source_migration_ledger_hash");
  });
  it("checkpoint ignores only clock/read/owned export holds but detects int64 rows and business retention", async () => {
    const records = fixture(), before = await sourceBackupCheckpoint(records), changed = structuredClone(records);
    changed.image.sourceSnapshotClock = "2026-10-07T12:00:00.000Z"; changed.createdAt = changed.image.sourceSnapshotClock;
    const hold = (kind: string, operation: string, rowid: string) => ({ rowid, cells: [{ type: "text" as const, value: kind }, { type: "text" as const, value: operation }, { type: "null" as const }] });
    changed.image.tables.file_location_holds.rows.push(hold("read", "api-reader", "1"), hold("export", "fp5-backup:backup", "2"));
    expect(await sourceBackupCheckpoint(changed)).toBe(before);
    changed.image.tables.file_location_holds.rows.push(hold("operator", "business-manual", "3"));
    expect(await sourceBackupCheckpoint(changed)).not.toBe(before);
    const altered = structuredClone(records); altered.image.tables.samples.rows[0].rowid = "9007199254740992";
    expect(await sourceBackupCheckpoint(altered)).not.toBe(before);
    const otherExport = structuredClone(records); otherExport.image.tables.file_location_holds.rows.push(hold("export", "fp5-backup:another", "4"));
    expect(await sourceBackupCheckpoint(otherExport)).not.toBe(before);
  });
});

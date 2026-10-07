import { describe, expect, it } from "vitest";
import type { ExportRow, ExportTables } from "./export";
import { stableJson } from "../domain/content-addressing";
import { buildResearchPackageBlobExportPlan } from "./export-research-packages";
import { buildSystemRecoveryBlobExportPlan, validateSystemRecoveryEvidenceHistory } from "./export-system-recovery-evidence";

const digest = "a".repeat(64), now = "2026-10-06T12:00:00.000Z";
function fixture(kind: "legacy" | "native" = "legacy"): ExportTables {
  const profile = { id: "destination", adapter_type: "s3", configuration_revision: 1, namespace_identity: "s3:bucket/prefix" };
  const file = { id: "file", purpose: "embedded_content", access_scope: "system", expected_byte_size: 4, expected_sha256: digest };
  const location = { id: "destination-location", file_id: "file", storage_profile_id: "destination", object_key: "new/key" };
  const original: ExportRow = { id: "asset", import_id: null, r2_key: "old/key", original_name: "old.bin", mime_type: "application/octet-stream",
    byte_size: 4, status: "ready", sha256: digest, actor_email: null, created_at: now, file_id: null,
    storage_profile_id: null, storage_profile_revision: null, object_key: null };
  const tables: ExportTables = { assets: kind === "legacy" ? [{ ...original, file_id: "file" }] : [],
    storage_profiles: [profile], files: [file], file_locations: [location],
    file_location_publications: [{ location_id: location.id, file_id: file.id, storage_profile_id: profile.id, object_key: location.object_key,
      verified_byte_size: 4, verified_sha256: digest, verification_method: "full_read_sha256", verification_operation_id: "fp5:proof",
      verified_at: now, published_at: now }], file_location_availability: [{ location_id: location.id, availability: "available" }],
    file_location_retention_edges: [], file_consumer_projection: [{ consumer_kind: "event", consumer_id: "event", consumer_sub_id: "",
      file_slot: "primary", file_id: "file", expected_purpose: "embedded_content", legacy_r2_object_key: kind === "legacy" ? "old/key" : null }],
    events: [{ id: "event", asset_file_id: "file", asset_key: kind === "legacy" ? "old/key" : null }],
    recovery_file_evidence: [], recovery_file_alias_evidence: [], recovery_file_binding_evidence: [] };
  if (kind === "native") {
    tables.file_locations.push({ ...location, id: "source-location", object_key: "old/key" });
    tables.file_location_publications.push({ ...tables.file_location_publications[0], location_id: "source-location", object_key: "old/key", verification_operation_id: "old-operation" });
    tables.file_location_availability.push({ location_id: "source-location", availability: "available" });
  }
  const source = buildResearchPackageBlobExportPlan(tables).blobs.find(source => kind === "legacy" ? source.byteAuthority === "legacy" : source.locationId === "source-location")!;
  tables.recovery_file_evidence.push({ id: "proof", backup_id: "old-backup", source_image_sha256: digest, destination_metadata_sha256: digest,
    source_locator_json: stableJson({ sourceId: "b_0000", locatorId: source.locatorId, storeKind: source.storeKind, provider: source.provider,
      byteAuthority: source.byteAuthority, storageProfileId: source.storageProfileId, storageProfileRevision: source.storageProfileRevision,
      locationId: source.locationId, objectKey: source.objectKey, expectedByteSize: 4, expectedSha256: digest }),
    source_file_id: kind === "native" ? file.id : null, destination_file_id: file.id, location_id: location.id, profile_id: profile.id,
    profile_revision: 1, namespace_identity: profile.namespace_identity, object_key: location.object_key, purpose: file.purpose,
    byte_size: 4, sha256: digest, verification_operation_id: "fp5:proof", verified_at: now, published_at: now, producer_trust: "opaque_recovery", created_at: now });
  if (kind === "legacy") tables.recovery_file_alias_evidence.push({ evidence_id: "proof", table_name: "assets", alias_id: "asset", original_json: stableJson(original), destination_file_id: file.id });
  tables.recovery_file_binding_evidence.push({ evidence_id: "proof", consumer_kind: "event", consumer_id: "event", consumer_sub_id: "", file_slot: "primary",
    purpose: file.purpose, source_file_id: kind === "native" ? file.id : null, row_sha256: digest, preview_origin_json: stableJson({ kind: "none" }) });
  return tables;
}

describe("V24 explicit physical recovery relocation", () => {
  it.each(["legacy", "native"] as const)("keeps canonical %s history while packaging only qualified replacement bytes", kind => {
    const tables = fixture(kind), frozen = structuredClone(tables), result = buildSystemRecoveryBlobExportPlan(tables);
    expect(result.blobs.map(source => source.locationId)).toEqual(["destination-location"]);
    expect(result.relocatedSources).toEqual([{ evidenceId: "proof", sourceLocatorId: kind === "legacy" ? '["r2","r2","old/key"]'
      : '["file_location","destination",1,"old/key"]', sourceLocationId: kind === "legacy" ? null : "source-location",
      sourceFileId: kind === "legacy" ? null : "file", destinationFileId: "file", destinationLocationId: "destination-location",
      byteSize: 4, sha256: digest, reason: "verified_recovery_relocation" }]);
    expect(tables).toEqual(frozen); expect(result.excludedOutputs).toEqual([]);
  });
  it.each(["manual", "operator", "migration", "generic-export", "different-backup-prefix"])("preserves source bytes under %s holds", kind => {
    const tables = fixture("native");
    tables.file_location_holds = [{ id: "hold", location_id: "source-location", hold_kind: kind.includes("export") || kind.includes("prefix") ? "export" : kind,
      operation_id: kind.includes("prefix") ? "fp5-backup:old-backup-extra" : "unrelated", released_at: null }];
    const result = buildSystemRecoveryBlobExportPlan(tables, now, "current-backup");
    expect(result.relocatedSources).toEqual([]); expect(result.blobs).toHaveLength(2);
  });
  it("exempts only read leases and exact current/qualified previous backup ownership", () => {
    const tables = fixture("native");
    tables.file_location_holds = ["old-backup", "current-backup"].map(owner => ({ id: owner, location_id: "source-location", hold_kind: "export",
      operation_id: `fp5-backup:${owner}`, released_at: null }));
    tables.file_location_holds.push({ id: "reader", location_id: "source-location", hold_kind: "read", operation_id: "reader", released_at: null });
    expect(buildSystemRecoveryBlobExportPlan(tables, now, "current-backup").relocatedSources).toHaveLength(1);
    expect(buildSystemRecoveryBlobExportPlan(tables, now, null).relocatedSources).toEqual([]);
  });
  it("retains original bytes if a consumer has no exact recovery proof or replacement is unavailable", () => {
    const tables = fixture(); tables.recovery_file_binding_evidence = [];
    expect(buildSystemRecoveryBlobExportPlan(tables).relocatedSources).toEqual([]);
    const missing = fixture(); missing.file_location_availability[0].availability = "deleted";
    expect(buildSystemRecoveryBlobExportPlan(missing).relocatedSources).toEqual([]);
    const alias = fixture(); alias.assets[0].original_name = "altered.bin";
    expect(buildSystemRecoveryBlobExportPlan(alias).relocatedSources).toEqual([]);
  });
  it("preserves source-specific unfinished migrations and package inputs", () => {
    const migration = fixture("native"); migration.file_migration_items = [{ source_location_id: "source-location", cleanup_released_at: null }];
    expect(buildSystemRecoveryBlobExportPlan(migration).relocatedSources).toEqual([]);
    const pending = fixture("native"); pending.research_package_jobs = [{ id: "import", kind: "import", state: "paused" }];
    pending.research_package_files = [{ job_id: "import", entry_kind: "source", source_location_id: "source-location" }];
    expect(buildSystemRecoveryBlobExportPlan(pending).relocatedSources).toEqual([]);
  });
  it("requires a verified immutable native chain to preserve old result locations through repeated recovery", () => {
    const tables = fixture("native"), first = tables.recovery_file_evidence[0];
    const locator = JSON.parse(String(first.source_locator_json));
    const second = { ...first, id: "second", backup_id: "second-backup", location_id: "second-location", object_key: "second/key",
      verification_operation_id: "fp5:second", source_locator_json: stableJson({ ...locator, sourceId: "b_0001",
        locatorId: '["file_location","destination",1,"new/key"]', locationId: "destination-location", objectKey: "new/key" }) };
    tables.recovery_file_evidence.push(second);
    tables.file_locations.push({ ...tables.file_locations[0], id: second.location_id, object_key: second.object_key });
    tables.file_location_publications.push({ ...tables.file_location_publications[0], location_id: second.location_id,
      object_key: second.object_key, verification_operation_id: second.verification_operation_id });
    tables.file_location_availability.push({ location_id: second.location_id, availability: "available" });
    tables.recovery_file_binding_evidence.push({ ...tables.recovery_file_binding_evidence[0], evidence_id: second.id });
    expect(validateSystemRecoveryEvidenceHistory(tables).historicalResultLocation("file", "source-location", "second-location")).toBe(true);
    expect(buildSystemRecoveryBlobExportPlan(tables).blobs.map(source => source.locationId)).toEqual(["second-location"]);
    expect(buildSystemRecoveryBlobExportPlan(tables).relocatedSources).toHaveLength(2);
    expect(validateSystemRecoveryEvidenceHistory(tables).historicalResultLocation("different-file", "source-location", "second-location")).toBe(false);
    tables.files[0].expected_sha256 = null;
    second.sha256 = "b".repeat(64);
    second.source_locator_json = stableJson({ ...JSON.parse(second.source_locator_json), expectedSha256: null });
    tables.file_location_publications[2].verified_sha256 = second.sha256;
    expect(validateSystemRecoveryEvidenceHistory(tables).historicalResultLocation("file", "source-location", "second-location")).toBe(false);
  });
});

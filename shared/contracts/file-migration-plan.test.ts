import { describe, expect, it } from "vitest";
import type { ExportRow, FullExportManifestV10, FullExportManifestV11, FullExportManifestV12 } from "./export";
import {
  MAX_FILE_MIGRATION_INPUT_BYTES, MAX_FILE_MIGRATION_INPUT_ROWS, MAX_FILE_MIGRATION_PLAN_BYTES,
  planFileMigration, serializeFileMigrationPlan,
} from "./file-migration-plan";

const now = "2026-09-13T12:00:00.000Z";
const hash = "a".repeat(64);
const otherHash = "b".repeat(64);
const namespace = '{"kind":"local-r2","installationId":"11111111-1111-4111-8111-111111111111","bucketName":"assets"}';

// Planner tests focus on projection/planning. The CLI and native qualification
// validate complete archive schema/rows before calling this pure boundary.
function manifest(): FullExportManifestV10 {
  return {
    schemaVersion: 10, archiveWriter: 1, archiveProfile: "fp1-import-acceptance", exportedAt: now,
    tables: Object.fromEntries([
      "assets", "managed_storage_objects", "state_representation_assets", "state_representations",
      "run_step_assets", "metrology_template_references", "run_step_comments", "state_verifications",
      "comment_submission_items", "comment_submissions", "events", "imports", "template_versions",
      "project_content_attachments", "project_contents", "projects", "attachment_derivatives", "blob_retention_edges",
      "storage_profiles", "files", "file_locations", "legacy_file_mappings", "blob_gc_ledger", "blob_integrity_quarantine",
    ].map((table) => [table, []])),
    blobs: [],
    artifacts: {
      sourceSchema: { path: "schema.json", byteSize: 1, sha256: hash,
        value: { version: 1, kind: "observed-sqlite-schema", objects: [], compatibilityColumns: { samples: [], run_step_comments: [] } } },
      retiredFields: { path: "retired.json", byteSize: 1, sha256: hash,
        value: { version: 1,
          samplesProcessRevision: { presentInSourceSchema: false, complete: true, sourceRowCount: 0, values: [] },
          runStepCommentsBody: { presentInSourceSchema: false, complete: true, sourceRowCount: 0, values: [] } } },
    },
  };
}
function uploadManifest(): FullExportManifestV11 {
  const historical = manifest();
  return { ...historical, schemaVersion: 11, archiveProfile: "fp1-r2-upload-acceptance",
    tables: { ...historical.tables, r2_upload_requests: [] } };
}
function metrologyManifest(): FullExportManifestV12 {
  const historical = uploadManifest();
  return { ...historical, schemaVersion: 12, archiveProfile: "fp1-metrology-reference-acceptance",
    tables: { ...historical.tables, metrology_reference_upload_requests: [] } };
}
function metrologyUpload(extra: ExportRow = {}): ExportRow {
  return upload({ id: "metrology-upload", ingress: "metrology_reference", purpose: "research_source",
    template_version_id: "template", candidate_reference_id: "candidate-reference",
    publication_plan_json: '{"private":"PRIVATE-PUBLICATION-PLAN"}', ...extra });
}
function upload(extra: ExportRow = {}): ExportRow {
  return { id: "upload", actor_email: "PRIVATE-ACTOR", client_request_id: "request", operation_id: "operation",
    ingress: "ordinary_image", purpose: "embedded_content", request_scope: "system", request_sha256: hash,
    request_input_json: '{"private":"PRIVATE-UPLOAD-INPUT"}', storage_profile_id: "profile",
    storage_profile_revision: 1, storage_policy_revision: 1, candidate_asset_id: "candidate",
    candidate_object_key: "candidate-key", status: "pending", accepted_result_json: null,
    created_at: now, completed_at: null, expires_at: "2026-09-14T12:00:00.000Z", ...extra };
}
function asset(id = "asset", key = "bytes/asset", extra: ExportRow = {}): ExportRow {
  return { id, r2_key: key, status: "ready", byte_size: 5, sha256: hash, import_id: null, ...extra };
}
function profile(id = "profile", identity = namespace): ExportRow {
  return { id, adapter_type: "r2", namespace_identity: identity, configuration_revision: 1,
    configuration_source: "bootstrap", credential_reference: null, state: "historical", created_at: now };
}
function addMapping(input: FullExportManifestV10, key = "bytes/asset", purpose: string | null = "provenance", profileId = "profile") {
  input.tables.files.push({ id: `file:${key}`, purpose, expected_byte_size: 5, expected_sha256: hash });
  input.tables.file_locations.push({ id: `location:${key}`, file_id: `file:${key}`, storage_profile_id: profileId, object_key: key });
  input.tables.legacy_file_mappings.push({ store_kind: "r2", provider: "r2", object_key: key,
    file_id: `file:${key}`, location_id: `location:${key}`, classification: purpose ? "classified" : "unclassified",
    evidence_json: '{"version":1,"verification":"not_performed"}', observed_at: now });
}
function addImage(input: FullExportManifestV10, id = "image", assetId = "asset") {
  if (!input.tables.comment_submissions.length) input.tables.comment_submissions.push({ id: "comment", status: "ready" });
  input.tables.comment_submission_items.push({ id, submission_id: "comment", kind: "comment_image",
    status: "ready", asset_id: assetId, storage_object_id: null, related_item_id: null });
}
function addImport(input: FullExportManifestV10, extra: ExportRow = {}) {
  input.tables.imports.push({ id: "import", status: "ready", workbook_asset_key: "bytes/asset", manifest_asset_key: null,
    client_request_id: "request", storage_profile_id: "profile", storage_profile_revision: 1, ...extra });
}

describe("provider-free File migration planning", () => {
  it("includes registry, direct-only, GC-only, quarantine-only and old-mapping-only locators", async () => {
    const input = manifest();
    input.tables.assets.push(asset());
    input.tables.managed_storage_objects.push({ id: "managed", provider: "switchdrive", object_key: "old-original",
      status: "orphaned", byte_size: 5, sha256: hash });
    input.tables.events.push({ id: "event", sample_id: "sample", asset_key: "direct", metadata_json: null });
    input.tables.blob_gc_ledger.push({ store_kind: "r2", provider: "r2", object_key: "gc-only", state: "deleted" });
    input.tables.blob_integrity_quarantine.push({ store_kind: "r2", provider: "r2", object_key: "quarantine-only",
      reason: "missing", expected_byte_size: 5, observed_byte_size: null });
    input.tables.storage_profiles.push(profile());
    addMapping(input, "mapping-only");
    const plan = await planFileMigration(input);
    expect(plan.groups.map((group) => group.locator.objectKey).sort()).toEqual([
      "bytes/asset", "direct", "gc-only", "mapping-only", "old-original", "quarantine-only",
    ]);
    expect(plan).toMatchObject({ executable: false, bytesVerified: false });
    expect(plan.groups.every((group) => group.blockers.includes("bytes_unverified"))).toBe(true);
  });

  it("never assigns an unmapped legacy key to an otherwise available bootstrap profile", async () => {
    const input = manifest();
    input.tables.assets.push(asset());
    input.tables.storage_profiles.push(profile());
    addImage(input);
    const group = (await planFileMigration(input)).groups[0];
    expect(group.namespace).toEqual({ status: "unresolved", identity: null, evidence: [] });
    expect(group.proposals).toHaveLength(1);
    expect(group.proposals[0].proposedFileId).toBeNull();
    expect(group.blockers).toContain("namespace_unresolved");
  });

  it("uses accepted import ownership and direct-key evidence without following equal SHA values", async () => {
    const input = manifest();
    input.tables.assets.push(asset("owned", "owned-key", { import_id: "import" }), asset("unrelated", "unrelated-key"));
    input.tables.storage_profiles.push(profile());
    addImport(input);
    const groups = (await planFileMigration(input)).groups;
    expect(groups.find((group) => group.locator.objectKey === "owned-key")?.namespace.status).toBe("resolved");
    expect(groups.find((group) => group.locator.objectKey === "bytes/asset")?.namespace.status).toBe("resolved");
    expect(groups.find((group) => group.locator.objectKey === "unrelated-key")?.namespace.status).toBe("unresolved");
  });

  it("observes V11 upload candidate and explicit ready keys without adding consumers or following hashes", async () => {
    const input = uploadManifest();
    input.tables.storage_profiles.push(profile());
    input.tables.assets.push(asset("accepted", "accepted-key"), asset("unrelated", "same-sha-key"));
    input.tables.r2_upload_requests.push(upload({ status: "ready", completed_at: now,
      accepted_result_json: JSON.stringify({ id: "accepted", key: "accepted-key", deduplicated: true }) }));
    const plan = await planFileMigration(input);
    expect(plan.source).toMatchObject({ schemaVersion: 11, archiveProfile: "fp1-r2-upload-acceptance" });
    for (const key of ["candidate-key", "accepted-key"]) {
      const group = plan.groups.find((entry) => entry.locator.objectKey === key)!;
      expect(group.namespace).toMatchObject({ status: "resolved", identity: namespace,
        evidence: [{ kind: "accepted_upload", sourceId: "upload", profileId: "profile", configurationRevision: 1 }] });
      expect(group.consumers).toEqual([]);
      expect(group.proposals).toEqual([]);
      expect(group.blockers).toContain("no_typed_consumer");
      expect(group.blockers).toContain("bytes_unverified");
    }
    expect(plan.groups.find((entry) => entry.locator.objectKey === "same-sha-key")?.namespace.status).toBe("unresolved");
    expect(plan.summary.consumers).toBe(0);
    expect(plan.coverage).toMatchObject({ retentionEdges: 0, matchedEdges: 0, unmatchedEdges: [], ambiguousEdges: [] });
    expect(plan).toMatchObject({ executable: false, bytesVerified: false });
    expect(serializeFileMigrationPlan(plan)).not.toContain("PRIVATE-");
  });

  it("observes V12 metrology candidate and accepted occurrence keys without claiming purpose for legacy consumers or equal hashes", async () => {
    const input = metrologyManifest();
    input.tables.storage_profiles.push(profile());
    input.tables.assets.push(asset("accepted", "accepted-key"), asset("unrelated", "same-sha-key"));
    input.tables.metrology_template_references.push({ id: "legacy-reference", template_version_id: "template", asset_id: "accepted",
      display_name: "PRIVATE-FILENAME", position: 0, actor_email: "PRIVATE-ACTOR", created_at: now,
      deleted_at: null, deleted_by: null, superseded_by_occurrence_id: null });
    input.tables.template_versions.push({ id: "template", template_kind: "metrology", archived_at: null, deleted_at: null });
    input.tables.metrology_reference_upload_requests.push(metrologyUpload({ status: "ready", completed_at: now,
      accepted_result_json: JSON.stringify({ assetId: "accepted", deduplicated: true, reference: { id: "legacy-reference",
        filename: "PRIVATE-FILENAME", mimeType: "application/pdf", byteSize: 5, assetKey: "accepted-key", createdAt: now } }) }));
    const plan = await planFileMigration(input);
    expect(plan.source).toMatchObject({ schemaVersion: 12, archiveProfile: "fp1-metrology-reference-acceptance" });
    for (const key of ["candidate-key", "accepted-key"]) {
      const group = plan.groups.find((entry) => entry.locator.objectKey === key)!;
      expect(group.namespace).toMatchObject({ status: "resolved", identity: namespace,
        evidence: [{ kind: "accepted_metrology_reference", sourceId: "metrology-upload", profileId: "profile", configurationRevision: 1 }] });
      expect(group.proposals).toEqual([]);
      expect(group.blockers).toContain("bytes_unverified");
    }
    expect(plan.groups.find((entry) => entry.locator.objectKey === "candidate-key")?.consumers).toEqual([]);
    const legacy = plan.groups.find((entry) => entry.locator.objectKey === "accepted-key")!.consumers;
    expect(legacy).toHaveLength(1);
    expect(legacy[0].purpose).toBeNull();
    expect(plan.groups.find((entry) => entry.locator.objectKey === "same-sha-key")?.namespace.status).toBe("unresolved");
    expect(plan.summary.consumers).toBe(1);
    expect(plan).toMatchObject({ executable: false, bytesVerified: false });
    expect(serializeFileMigrationPlan(plan)).not.toContain("PRIVATE-");
  });

  it("binds V12 business decisions to the fingerprint while redacting their content and withholding unfinished results", async () => {
    const input = metrologyManifest();
    input.tables.storage_profiles.push(profile());
    input.tables.metrology_reference_upload_requests.push(metrologyUpload());
    const before = structuredClone(input);
    const first = await planFileMigration(input);
    expect(input).toEqual(before);
    expect(first.groups).toHaveLength(1);
    expect(first.groups[0].blockers).toContain("accepted_metrology_reference_unfinished");
    input.tables.metrology_reference_upload_requests[0].publication_plan_json = '{"private":"PRIVATE-CHANGED-PLAN"}';
    input.tables.metrology_reference_upload_requests[0].accepted_result_json = '{"private":"PRIVATE-UNFINISHED-RESULT"}';
    const changed = await planFileMigration(input);
    expect(changed.source.inputSha256).not.toBe(first.source.inputSha256);
    expect(changed.groups).toEqual(first.groups);
    expect(serializeFileMigrationPlan(changed)).not.toContain("PRIVATE-");
  });

  it("keeps malformed ready metrology evidence on its candidate without inventing a result locator", async () => {
    const input = metrologyManifest();
    input.tables.storage_profiles.push(profile());
    input.tables.metrology_reference_upload_requests.push(metrologyUpload({ status: "ready", completed_at: now,
      accepted_result_json: '{"assetId":"ignored","deduplicated":true,"reference":{"assetKey":"ignored-key"}}' }));
    const plan = await planFileMigration(input);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].locator.objectKey).toBe("candidate-key");
    expect(plan.groups[0].blockers).toContain("accepted_metrology_reference_result_invalid");
  });

  it("preserves pending candidate namespace evidence but never uses a result on an unfinished upload", async () => {
    const input = uploadManifest();
    input.tables.storage_profiles.push(profile());
    input.tables.r2_upload_requests.push(upload({
      accepted_result_json: JSON.stringify({ id: "ignore", key: "ignore-unfinished-result", deduplicated: true }),
    }));
    const plan = await planFileMigration(input);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].locator.objectKey).toBe("candidate-key");
    expect(plan.groups[0].namespace.status).toBe("resolved");
    expect(plan.groups[0].blockers).toContain("accepted_upload_unfinished");
    expect(plan.groups[0].consumers).toEqual([]);
  });

  it("blocks stale upload profile revisions on both the candidate and the ready result", async () => {
    const input = uploadManifest();
    input.tables.storage_profiles.push(profile());
    input.tables.r2_upload_requests.push(upload({ storage_profile_revision: 2, status: "ready", completed_at: now,
      accepted_result_json: JSON.stringify({ id: "accepted", key: "accepted-key", deduplicated: true }) }));
    const plan = await planFileMigration(input);
    expect(plan.groups).toHaveLength(2);
    for (const group of plan.groups) {
      expect(group.namespace).toEqual({ status: "unresolved", identity: null, evidence: [] });
      expect(group.blockers).toContain("namespace_evidence_invalid");
    }
  });

  it("binds complete V11 receipts to the input digest while keeping receipt payloads out of the report", async () => {
    const input = uploadManifest();
    input.tables.storage_profiles.push(profile());
    input.tables.r2_upload_requests.push(upload());
    const before = structuredClone(input);
    const first = await planFileMigration(input);
    expect(input).toEqual(before);
    input.tables.r2_upload_requests[0].actor_email = "PRIVATE-CHANGED-ACTOR";
    input.tables.r2_upload_requests[0].request_input_json = '{"private":"PRIVATE-CHANGED-INPUT"}';
    const changed = await planFileMigration(input);
    expect(changed.source.inputSha256).not.toBe(first.source.inputSha256);
    expect(changed.groups).toEqual(first.groups);
    expect(serializeFileMigrationPlan(changed)).not.toContain("PRIVATE-");
  });

  it("keeps malformed ready receipt evidence visible without inventing a result locator", async () => {
    for (const receipt of ['{"id":"accepted","key":"bad","deduplicated":true,"extra":"PRIVATE"}',
      '{"id":"accepted","key":"bad"}', '{"id":"accepted","key":"","deduplicated":true}', "INVALID"]) {
      const input = uploadManifest();
      input.tables.storage_profiles.push(profile());
      input.tables.r2_upload_requests.push(upload({ status: "ready", completed_at: now, accepted_result_json: receipt }));
      const plan = await planFileMigration(input);
      expect(plan.groups).toHaveLength(1);
      expect(plan.groups[0].locator.objectKey).toBe("candidate-key");
      expect(plan.groups[0].blockers).toContain("accepted_upload_result_invalid");
    }
  });

  it("blocks competing captured namespaces instead of selecting a default", async () => {
    const input = manifest();
    input.tables.assets.push(asset());
    input.tables.storage_profiles.push(profile(), profile("other-profile", "other-explicit-namespace"));
    addMapping(input);
    addImport(input, { storage_profile_id: "other-profile" });
    const group = (await planFileMigration(input)).groups[0];
    expect(group.namespace.status).toBe("conflicting");
    expect(group.blockers).toContain("namespace_conflict");
    expect(group.proposals[0].proposedFileId).toBeNull();
  });

  it("assigns exact typed consumers to independent purpose proposals for a shared key", async () => {
    const input = manifest();
    input.tables.assets.push(asset());
    input.tables.storage_profiles.push(profile());
    addImport(input);
    addImage(input);
    const group = (await planFileMigration(input)).groups[0];
    expect(group.proposals.map((proposal) => proposal.purpose)).toEqual(["embedded_content", "provenance"]);
    expect(new Set(group.proposals.map((proposal) => proposal.proposedFileId)).size).toBe(2);
    expect(group.proposals.every((proposal) => proposal.requiresIndependentVerifiedCopy)).toBe(true);
    expect(group.proposals.flatMap((proposal) => proposal.consumerIds).sort()).toEqual(group.consumers.map((consumer) => consumer.id).sort());
    expect(group.consumers.every((consumer) => consumer.derivationTrust === "not_assessed")).toBe(true);
    expect(group.blockers).toContain("independent_verified_copies_required");
  });

  it("preserves conflicting and incomplete expected metadata and unavailable observations", async () => {
    const input = manifest();
    input.tables.assets.push(asset("asset", "bytes/asset", { sha256: null, status: "failed" }));
    input.tables.storage_profiles.push(profile());
    addMapping(input);
    input.tables.blob_integrity_quarantine.push({ store_kind: "r2", provider: "r2", object_key: "bytes/asset",
      reason: "size_mismatch", expected_byte_size: 6, observed_byte_size: 3 });
    input.blobs.push({ locatorId: "blob", storeKind: "r2", provider: "r2", objectKey: "bytes/asset",
      blobRecordIds: ["asset"], filename: "old", expectedByteSize: 5, expectedSha256: otherHash,
      sourceOccurrences: [], downloadUrl: null, initialOutcome: "provider_unavailable" });
    const group = (await planFileMigration(input)).groups[0];
    expect(group.expectedByteSize).toBeNull();
    expect(group.expectedSha256).toBeNull();
    expect(group.blockers).toEqual(expect.arrayContaining([
      "expected_size_conflict", "expected_hash_incomplete", "expected_hash_conflict",
      "legacy_record_not_ready", "legacy_quarantine_present", "archive_bytes_unavailable",
    ]));
  });

  it("reports purpose changes against old immutable mappings without rewriting them", async () => {
    const input = manifest();
    input.tables.assets.push(asset());
    input.tables.storage_profiles.push(profile());
    addMapping(input);
    addImage(input);
    const before = structuredClone(input);
    const group = (await planFileMigration(input)).groups[0];
    expect(group.legacyMappings[0].purposeComparison).toBe("different");
    expect(group.blockers).toContain("legacy_mapping_purpose_changed");
    expect(group.legacyMappings[0].evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(input).toEqual(before);
  });

  it("is deterministic across relational row order and binds unrelated source fields", async () => {
    const input = manifest();
    input.tables.assets.push(asset(), asset("second", "second-key"));
    addImage(input);
    input.tables.unrelated_history = [{ id: "history", body: "original" }];
    input.artifacts.sourceSchema.value.objects = [
      { type: "table", name: "z", tableName: "z", sql: "CREATE TABLE z(id)" },
      { type: "table", name: "a", tableName: "a", sql: "CREATE TABLE a(id)" },
    ];
    const first = await planFileMigration(input);
    const reordered = structuredClone(input);
    reordered.tables.assets.reverse();
    reordered.artifacts.sourceSchema.value.objects.reverse();
    expect(serializeFileMigrationPlan(await planFileMigration(reordered))).toBe(serializeFileMigrationPlan(first));
    reordered.tables.unrelated_history[0].body = "changed";
    const changed = await planFileMigration(reordered);
    expect(changed.source.inputSha256).not.toBe(first.source.inputSha256);
    expect(changed.groups).toEqual(first.groups);
  });

  it("detaches the snapshot before asynchronous hashing can observe caller changes", async () => {
    const input = manifest();
    input.tables.assets.push(asset());
    addImage(input);
    const expected = await planFileMigration(structuredClone(input));
    const pending = planFileMigration(input);
    input.tables.assets[0].r2_key = "changed-during-hash";
    input.exportedAt = "changed-during-hash";
    expect(await pending).toEqual(expected);
  });

  it("keeps proposed identity tied to physical namespace rather than a profile label", async () => {
    const input = manifest();
    input.tables.assets.push(asset());
    input.tables.storage_profiles.push(profile());
    addImage(input);
    addMapping(input, "bytes/asset", "embedded_content");
    const first = await planFileMigration(input);
    input.tables.storage_profiles[0].id = "renamed-profile";
    input.tables.file_locations[0].storage_profile_id = "renamed-profile";
    const second = await planFileMigration(input);
    expect(second.groups[0].proposals).toEqual(first.groups[0].proposals);
    expect(second.source.inputSha256).not.toBe(first.source.inputSha256);
  });

  it("preserves unbound historical occurrences with their exact foreign key", async () => {
    const input = manifest();
    addImage(input, "historical", "missing-asset");
    input.tables.comment_submission_items[0].deleted_at = now;
    const plan = await planFileMigration(input);
    expect(plan.groups).toEqual([]);
    expect(plan.unresolvedConsumers).toHaveLength(1);
    expect(plan.unresolvedConsumers[0]).toMatchObject({
      source: { table: "comment_submission_items", primaryKey: { id: "historical" }, slot: "asset_id" },
      recordedValue: "missing-asset", history: { deletedAt: now },
    });
  });

  it("does not copy arbitrary archive payloads into the report", async () => {
    const input = manifest();
    input.tables.assets.push(asset("asset", "bytes/asset", { original_name: "PRIVATE-FILENAME" }));
    input.tables.storage_profiles.push(profile());
    addMapping(input);
    input.tables.legacy_file_mappings[0].evidence_json = '{"private":"PRIVATE-MAPPING-PAYLOAD"}';
    input.tables.blob_gc_ledger.push({ store_kind: "r2", provider: "r2", object_key: "bytes/asset",
      state: "orphaned", last_error: "PRIVATE-PROVIDER-ERROR" });
    input.blobs.push({ locatorId: "blob", storeKind: "r2", provider: "r2", objectKey: "bytes/asset",
      filename: "PRIVATE-FILENAME", downloadUrl: "https://example.test/PRIVATE-TOKEN", blobRecordIds: ["asset"],
      expectedByteSize: 5, expectedSha256: hash, sourceOccurrences: [], initialOutcome: null });
    const report = serializeFileMigrationPlan(await planFileMigration(input));
    expect(report).not.toContain("PRIVATE-");
  });

  it("does not promote a credential-bearing namespace observation into a proposal", async () => {
    const input = manifest();
    input.tables.assets.push(asset());
    input.tables.storage_profiles.push(profile("profile", "https://user:PRIVATE-PASS@example.test/root"));
    addMapping(input);
    addImage(input);
    const plan = await planFileMigration(input);
    expect(plan.groups[0].blockers).toContain("namespace_evidence_invalid");
    expect(plan.groups[0].proposals[0].proposedFileId).toBeNull();
    expect(serializeFileMigrationPlan(plan)).not.toContain("PRIVATE-PASS");
  });

  it("keeps unmatched retained locators visible and blocks their coverage", async () => {
    const input = manifest();
    input.tables.blob_retention_edges.push({ store_kind: "r2", provider: "r2", object_key: "unmatched",
      blob_record_id: null, source_type: "sample", source_id: "sample", occurrence_type: "future_consumer",
      occurrence_id: "future", retention_reason: "future", retain_until: null });
    const plan = await planFileMigration(input);
    expect(plan.coverage.unmatchedEdges).toHaveLength(1);
    expect(plan.groups[0].locator.objectKey).toBe("unmatched");
    expect(plan.groups[0].blockers).toContain("retention_coverage_mismatch");
  });

  it("rejects oversized input rows and bytes before projecting or hashing", async () => {
    const tooMany = manifest();
    tooMany.tables.unrelated_history = Array.from({ length: MAX_FILE_MIGRATION_INPUT_ROWS + 1 }, () => ({ id: "row" }));
    await expect(planFileMigration(tooMany)).rejects.toThrow("row limit");
    const tooLarge = manifest();
    tooLarge.tables.unrelated_history = [{ id: "row", body: "x".repeat(MAX_FILE_MIGRATION_INPUT_BYTES) }];
    await expect(planFileMigration(tooLarge)).rejects.toThrow("byte limit");
  });

  it("also enforces the serialized report bound", async () => {
    const plan = await planFileMigration(manifest());
    plan.source.exportedAt = "x".repeat(MAX_FILE_MIGRATION_PLAN_BYTES);
    expect(() => serializeFileMigrationPlan(plan)).toThrow("byte limit");
  });
});

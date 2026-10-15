import { describe, expect, it } from "vitest";
import type { ExportRow, ExportTables } from "./export";
import { projectFileConsumers } from "./file-consumer-projection";
import { MAX_FILE_CONSUMER_INPUT_ROWS } from "./file-consumers";

const HASH = "a".repeat(64);
function fixture(): ExportTables {
  return {
    assets: [{ id: "image", r2_key: "shared-key", status: "ready", sha256: HASH, byte_size: 10, import_id: null },
      { id: "preview", r2_key: "preview-key", status: "ready", sha256: HASH, byte_size: 10, import_id: null }],
    managed_storage_objects: [{ id: "original", provider: "switchdrive", object_key: "shared-key", status: "ready", sha256: HASH, byte_size: 10 }],
    state_representation_assets: [], state_representations: [], run_step_assets: [], metrology_template_references: [],
    run_step_comments: [], state_verifications: [], comment_submission_items: [], comment_submissions: [], events: [],
    imports: [], template_versions: [], project_content_attachments: [], project_contents: [], projects: [],
    attachment_derivatives: [], blob_retention_edges: [],
  };
}
function comment(id: string, overrides: ExportRow = {}): ExportRow {
  return { id, submission_id: "submission", kind: "comment_image", asset_id: "image", storage_object_id: null,
    related_item_id: null, status: "ready", position: 0, deleted_at: null, ...overrides };
}

describe("typed historical File consumer projection", () => {
  it("enumerates every canonical byte slot without filtering deleted, expired or superseded history", () => {
    const tables = fixture();
    tables.state_representations.push({ hash: "state:with:separator", representation_type: "diagram" });
    tables.state_representation_assets.push({ state_hash: "state:with:separator", asset_id: "image", position: 2 });
    tables.run_step_assets.push({ id: "run-image", run_step_id: "step", asset_id: "image", role: "execution", position: 4,
      deleted_at: "2000-01-01T00:00:00.000Z", superseded_by_occurrence_id: "replacement" });
    tables.metrology_template_references.push({ id: "reference", template_version_id: "template", asset_id: "image", superseded_by_occurrence_id: "replacement" });
    tables.run_step_comments.push({ id: "legacy", asset_id: "image", asset_deleted_at: "2000-01-01T00:00:00.000Z", legacy_body: "PRIVATE-COMMENT" });
    tables.state_verifications.push({ id: "verification", evidence_asset_id: "image", status: "stale" });
    tables.comment_submissions.push({ id: "submission", status: "ready", deleted_at: "2000-01-01T00:00:00.000Z", body: "PRIVATE-COMMENT" });
    tables.comment_submission_items.push(comment("comment", { deleted_at: "2000-01-01T00:00:00.000Z" }));
    tables.events.push({ id: "event:with:separator", sample_id: "sample", kind: "image", asset_key: "shared-key", metadata_json: '{"action":"sample_record","thumbnailKey":"preview-key","private":"PRIVATE-METADATA"}' });
    tables.imports.push({ id: "import", status: "failed", workbook_asset_key: "direct-workbook", manifest_asset_key: "direct-manifest", request_input_json: "PRIVATE-REQUEST" });
    tables.template_versions.push({ id: "template", source_asset_key: "direct-workbook" });
    tables.projects.push({ id: "project", deleted_at: "2000-01-01T00:00:00.000Z" });
    tables.project_contents.push({ id: "content", project_id: "project", deleted_at: "2000-01-01T00:00:00.000Z", markdown_source: "PRIVATE-MARKDOWN" });
    tables.project_content_attachments.push({ project_content_id: "content", asset_id: null, storage_object_id: "original" });
    tables.attachment_derivatives.push({ id: "derivative", derivative_kind: "browser_preview", derived_asset_id: "preview", retain_until: "2000-01-01T00:00:00.000Z", source_sha256: HASH });
    const before = JSON.stringify(tables);
    const result = projectFileConsumers(tables);
    expect(result.consumers).toHaveLength(13);
    expect(new Set(result.consumers.map((c) => c.source.table)).size).toBe(11);
    expect(result.consumers.find((c) => c.source.table === "state_representation_assets")?.source)
      .toEqual({ table: "state_representation_assets", primaryKey: { state_hash: "state:with:separator", asset_id: "image" }, slot: "asset_id" });
    expect(result.consumers.find((c) => c.source.table === "run_step_assets")?.history)
      .toMatchObject({ deletedAt: "2000-01-01T00:00:00.000Z", supersededBy: "replacement", position: 4 });
    expect(result.consumers.find((c) => c.source.table === "project_content_attachments"))
      .toMatchObject({ source: { slot: "storage_object_id" }, purpose: null, history: { parentDeletedAt: "2000-01-01T00:00:00.000Z" } });
    expect(result.consumers.find((c) => c.source.table === "metrology_template_references")?.purpose).toBeNull();
    expect(result.consumers.every((c) => c.derivationTrust === "not_assessed")).toBe(true);
    expect(result.coverage.consumersWithoutRetention).toHaveLength(13);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-");
    expect(JSON.stringify(tables)).toBe(before);
  });

  it("classifies actual Comment kinds and reciprocal same-submission previews without using hash or MIME", () => {
    const tables = fixture();
    tables.comment_submissions.push({ id: "submission", status: "ready" });
    tables.comment_submission_items.push(
      comment("original-item", { kind: "attachment", asset_id: null, storage_object_id: "original", related_item_id: "preview-item" }),
      comment("preview-item", { asset_id: "preview", related_item_id: "original-item" }),
      comment("illustration"),
      comment("broken-preview", { asset_id: "preview", related_item_id: "original-item" }),
      comment("pending", { asset_id: null, status: "uploading" }),
      comment("link", { kind: "link", asset_id: null }),
    );
    const result = projectFileConsumers(tables);
    const byId = Object.fromEntries(result.consumers.map((c) => [(c.source.primaryKey as { id: string }).id, c]));
    expect(byId["original-item"].purpose).toBe("research_source");
    expect(byId["preview-item"].purpose).toBe("derived_preview");
    expect(byId.illustration.purpose).toBe("embedded_content");
    expect(byId["broken-preview"].purpose).toBeNull();
    expect(byId.pending).toMatchObject({ locator: null, source: { slot: "pending_content" }, classificationReasons: ["comment_illustration", "consumer_not_bound"] });
    expect(byId.link).toBeUndefined();
    tables.comment_submission_items[0].submission_id = "different-submission";
    expect(projectFileConsumers(tables).consumers.find((c) => c.source.primaryKey.id === "preview-item")?.purpose).toBeNull();
  });

  it("preserves same-key thumbnail slots omitted by the retention view without manufacturing derivation", () => {
    const tables = fixture();
    tables.events.push({ id: "event", sample_id: "sample", kind: "image", asset_key: "shared-key", metadata_json: '{"action":"sample_record","thumbnailKey":"shared-key"}' });
    tables.blob_retention_edges.push({ store_kind: "r2", provider: "r2", object_key: "shared-key", blob_record_id: "image",
      source_type: "sample", source_id: "sample", occurrence_type: "event", occurrence_id: "event", retention_reason: "legacy_event_asset", retain_until: null });
    const result = projectFileConsumers(tables);
    expect(result.consumers).toHaveLength(2);
    const thumbnail = result.consumers.find((c) => c.source.slot === "metadata_json.thumbnailKey")!;
    expect(thumbnail).toMatchObject({ purpose: null, classificationReasons: ["thumbnail_aliases_primary_bytes"], derivationTrust: "not_assessed" });
    expect(result.coverage).toMatchObject({ matchedEdges: 1, unmatchedEdges: [], ambiguousEdges: [], consumersWithoutRetention: [thumbnail.id] });
  });

  it("reports orphan retention and registry mismatches while matching direct-only locators exactly", () => {
    const tables = fixture();
    tables.imports.push({ id: "i", workbook_asset_key: "direct", manifest_asset_key: "shared-key" });
    const edge = { store_kind: "r2", provider: "r2", object_key: "direct", blob_record_id: null,
      source_type: "import", source_id: "i", occurrence_type: "import_workbook", occurrence_id: "i:workbook", retention_reason: "import_provenance", retain_until: null };
    tables.blob_retention_edges.push(edge,
      { ...edge, object_key: "shared-key", blob_record_id: "wrong-record", occurrence_type: "import_manifest", occurrence_id: "i:manifest" },
      { ...edge, source_type: "unknown", occurrence_id: "never-parsed:workbook" });
    const result = projectFileConsumers(tables);
    expect(result.coverage.matchedEdges).toBe(1);
    expect(result.coverage.unmatchedEdges.map((i) => i.reason).sort()).toEqual(["no_canonical_consumer", "registry_identity_mismatch"]);
    expect(result.consumers.find((c) => c.source.slot === "workbook_asset_key"))
      .toMatchObject({ locator: { storeKind: "r2", provider: "r2", objectKey: "direct" }, registry: null, classificationReasons: ["import_workbook_provenance", "registry_record_missing"] });
  });

  it("does not discard unknown registry references or invalid dual bindings", () => {
    const tables = fixture();
    tables.comment_submission_items.push(comment("missing", { asset_id: "missing-asset" }),
      comment("dual", { storage_object_id: "original" }));
    const result = projectFileConsumers(tables);
    expect(result.consumers).toHaveLength(3);
    const dual = result.consumers.filter((c) => c.source.primaryKey.id === "dual");
    expect(dual.map((c) => c.source.slot).sort()).toEqual(["asset_id", "storage_object_id"]);
    expect(dual.every((c) => c.classificationReasons.includes("conflicting_registry_bindings"))).toBe(true);
    expect(result.consumers.find((c) => c.source.primaryKey.id === "missing"))
      .toMatchObject({ locator: null, registry: null, recordedValue: "missing-asset" });
  });

  it("keeps output deterministic under table and row reordering and excludes non-whitelisted fields", () => {
    const tables = fixture();
    tables.imports.push({ id: "z", workbook_asset_key: "shared-key", actor_email: "PRIVATE-ACTOR", request_input_json: "PRIVATE-INPUT" },
      { id: "a", manifest_asset_key: "preview-key", source_filename: "PRIVATE-FILENAME" });
    const first = projectFileConsumers(tables);
    const reordered = Object.fromEntries(Object.entries(tables).reverse().map(([name, rows]) => [name, [...rows].reverse()]));
    expect(projectFileConsumers(reordered)).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("PRIVATE-");
  });

  it("fails visibly for incomplete snapshots, duplicate source identities and excessive input", () => {
    const incomplete = fixture(); delete incomplete.events;
    expect(() => projectFileConsumers(incomplete)).toThrow("incomplete");
    const duplicated = fixture();
    duplicated.imports.push({ id: "same", workbook_asset_key: "shared-key" }, { id: "same", workbook_asset_key: "shared-key" });
    expect(() => projectFileConsumers(duplicated)).toThrow("duplicated");
    const oversized = fixture();
    oversized.unrelated = Array.from({ length: MAX_FILE_CONSUMER_INPUT_ROWS }, () => ({}));
    expect(() => projectFileConsumers(oversized)).toThrow("row bound");
    const badKey = fixture(); badKey.assets[0].r2_key = "x".repeat(4097);
    expect(() => projectFileConsumers(badKey)).toThrow("bound");
  });

  it("bounds materialized output independently of the input row count", () => {
    const tables = fixture();
    tables.imports = Array.from({ length: 1000 }, (_, i) => ({ id: `${i}-${"x".repeat(4000)}`, workbook_asset_key: "shared-key" }));
    expect(() => projectFileConsumers(tables)).toThrow("output bound");
  });
});

import type { ExportRow, ExportTables } from "./export";
import type { FilePurpose, LegacyFileLocator } from "./files";
import {
  MAX_FILE_CONSUMER_INPUT_ROWS, MAX_FILE_CONSUMER_OBSERVATIONS, MAX_FILE_CONSUMER_OUTPUT_BYTES,
  type FileConsumerObservation, type FileConsumerProjection, type FileConsumerRegistryObservation,
  type FileConsumerRetentionEdge, type FileConsumerRetentionIdentity, type FileConsumerSource,
} from "./file-consumers";

const REQUIRED_TABLES = ["assets", "managed_storage_objects", "state_representation_assets", "state_representations",
  "run_step_assets", "metrology_template_references", "run_step_comments", "state_verifications",
  "comment_submission_items", "comment_submissions", "events", "imports", "template_versions",
  "project_content_attachments", "project_contents", "projects", "attachment_derivatives", "blob_retention_edges"] as const;
const encoder = new TextEncoder();

function text(row: ExportRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.includes("\0") || encoder.encode(value).byteLength > 4096) {
    throw new Error("File consumer metadata is invalid or exceeds its bound");
  }
  return value;
}
function requiredText(row: ExportRow, key: string): string {
  const value = text(row, key);
  if (!value) throw new Error("File consumer identity is incomplete");
  return value;
}
function number(row: ExportRow, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("File consumer numeric metadata is invalid");
  return value;
}
function index(rows: ExportRow[], key: string): Map<string, ExportRow> {
  const result = new Map<string, ExportRow>();
  for (const row of rows) {
    const id = requiredText(row, key);
    if (result.has(id)) throw new Error("File consumer registry contains duplicate identities");
    result.set(id, row);
  }
  return result;
}
function compare(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
function canonical(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return `{${Object.entries(value).sort(([a], [b]) => compare(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function fileConsumerIdentity(source: FileConsumerSource): string { return canonical(source); }
function retentionKey(locator: LegacyFileLocator, identity: FileConsumerRetentionIdentity): string {
  return JSON.stringify([locator.storeKind, locator.provider, locator.objectKey,
    identity.sourceType, identity.sourceId, identity.occurrenceType, identity.occurrenceId]);
}
function retention(sourceType: string, sourceId: string, occurrenceType: string, occurrenceId: string): FileConsumerRetentionIdentity {
  return { sourceType, sourceId, occurrenceType, occurrenceId };
}

/** Pure metadata projection from an already validated, complete V10 snapshot.
 * No current time, provider, active File publication, historical mutation or
 * derivation trust is introduced. Historical occurrences are never filtered.
 */
export function projectFileConsumers(tables: ExportTables): FileConsumerProjection {
  let inputRows = 0;
  for (const rows of Object.values(tables)) {
    if (!Array.isArray(rows)) throw new Error("File consumer snapshot tables are invalid");
    inputRows += rows.length;
    if (inputRows > MAX_FILE_CONSUMER_INPUT_ROWS) throw new Error("File consumer input exceeds its row bound");
  }
  for (const name of REQUIRED_TABLES) {
    if (!Array.isArray(tables[name])) throw new Error("File consumer snapshot is incomplete");
  }
  const assets = index(tables.assets, "id");
  const managed = index(tables.managed_storage_objects, "id");
  const assetsByKey = index(tables.assets, "r2_key");
  const states = index(tables.state_representations, "hash");
  const comments = index(tables.comment_submission_items, "id");
  const submissions = index(tables.comment_submissions, "id");
  const projectContents = index(tables.project_contents, "id");
  const projects = index(tables.projects, "id");
  const consumers: FileConsumerObservation[] = [];
  const seen = new Set<string>();
  let outputBytes = 0;

  function resolve(assetId: string | null, managedId: string | null, directKey?: string) {
    const issues: string[] = [];
    let row: ExportRow | undefined;
    let table: "assets" | "managed_storage_objects" = "assets";
    let locator: LegacyFileLocator | null = directKey ? { storeKind: "r2", provider: "r2", objectKey: directKey } : null;
    if (assetId && managedId) issues.push("conflicting_registry_bindings");
    else if (directKey) row = assetsByKey.get(directKey);
    else if (assetId) row = assets.get(assetId);
    else if (managedId) { row = managed.get(managedId); table = "managed_storage_objects"; }
    else issues.push("consumer_not_bound");
    if (!row && (assetId || managedId || directKey)) issues.push("registry_record_missing");
    let registry: FileConsumerRegistryObservation | null = null;
    if (row) {
      if (table === "assets") locator = { storeKind: "r2", provider: "r2", objectKey: requiredText(row, "r2_key") };
      else if (row.provider === "switchdrive") locator = { storeKind: "managed", provider: "switchdrive", objectKey: requiredText(row, "object_key") };
      else issues.push("unsupported_registry_provider");
      registry = { table, id: requiredText(row, "id"), status: text(row, "status"),
        expectedSha256: text(row, "sha256"), expectedByteSize: number(row, "byte_size"), importId: text(row, "import_id") };
    }
    return { locator, registry, issues, recordedValue: directKey ?? assetId ?? managedId };
  }
  function add(source: FileConsumerSource, row: ExportRow, identity: FileConsumerRetentionIdentity,
    binding: ReturnType<typeof resolve>, purpose: FilePurpose | null, reasons: string[], parent?: ExportRow) {
    const id = fileConsumerIdentity(source);
    if (seen.has(id)) throw new Error("File consumer canonical source is duplicated");
    seen.add(id);
    const consumer: FileConsumerObservation = {
      id, source, recordedValue: binding.recordedValue, locator: binding.locator, registry: binding.registry, purpose,
      classificationReasons: [...new Set([...reasons, ...binding.issues])].sort(compare),
      history: { status: text(row, "status"), deletedAt: text(row, "deleted_at"), assetDeletedAt: text(row, "asset_deleted_at"),
        supersededBy: text(row, "superseded_by_occurrence_id"), supersededAt: text(row, "superseded_at"),
        position: number(row, "position"), retainUntil: text(row, "retain_until"),
        parentStatus: parent ? text(parent, "status") : null, parentDeletedAt: parent ? text(parent, "deleted_at") : null,
        parentRetryUntil: parent ? text(parent, "retry_until") : null, parentRetryClosedAt: parent ? text(parent, "retry_closed_at") : null },
      retentionIdentity: identity, derivationTrust: "not_assessed",
    };
    outputBytes += encoder.encode(JSON.stringify(consumer)).byteLength;
    if (consumers.length >= MAX_FILE_CONSUMER_OBSERVATIONS || outputBytes > MAX_FILE_CONSUMER_OUTPUT_BYTES) {
      throw new Error("File consumer projection exceeds its output bound");
    }
    consumers.push(consumer);
  }

  for (const row of tables.state_representation_assets) {
    const state = requiredText(row, "state_hash"), asset = requiredText(row, "asset_id");
    const isDiagram = states.get(state)?.representation_type === "diagram";
    add({ table: "state_representation_assets", primaryKey: { state_hash: state, asset_id: asset }, slot: "asset_id" }, row,
      retention("state_representation", state, "state_representation_asset", `${state}:${asset}`), resolve(asset, null),
      isDiagram ? "embedded_content" : null, [isDiagram ? "state_diagram_occurrence" : "state_representation_semantics_unknown"]);
  }
  for (const row of tables.run_step_assets) {
    const id = requiredText(row, "id"), role = text(row, "role");
    const known = role === "execution" || role === "state_observation";
    add({ table: "run_step_assets", primaryKey: { id }, slot: "asset_id" }, row,
      retention("run_step", requiredText(row, "run_step_id"), "run_step_asset", id), resolve(requiredText(row, "asset_id"), null),
      known ? "embedded_content" : null, [known ? "run_image_occurrence" : "run_asset_role_unknown"]);
  }
  for (const row of tables.metrology_template_references) {
    const id = requiredText(row, "id");
    add({ table: "metrology_template_references", primaryKey: { id }, slot: "asset_id" }, row,
      retention("template_version", requiredText(row, "template_version_id"), "metrology_template_reference", id),
      resolve(requiredText(row, "asset_id"), null), null, ["metrology_reference_purpose_not_recorded"]);
  }
  for (const row of tables.run_step_comments) {
    const asset = text(row, "asset_id");
    if (!asset) continue;
    const id = requiredText(row, "id");
    add({ table: "run_step_comments", primaryKey: { id }, slot: "asset_id" }, row,
      retention("run_step_comment", id, "run_step_comment_asset", id), resolve(asset, null),
      "embedded_content", ["legacy_comment_image_occurrence"]);
  }
  for (const row of tables.state_verifications) {
    const asset = text(row, "evidence_asset_id");
    if (!asset) continue;
    const id = requiredText(row, "id");
    add({ table: "state_verifications", primaryKey: { id }, slot: "evidence_asset_id" }, row,
      retention("state_verification", id, "state_verification_evidence", id), resolve(asset, null),
      "embedded_content", ["verification_image_occurrence"]);
  }
  for (const row of tables.comment_submission_items) {
    if (row.kind === "link" && !row.asset_id && !row.storage_object_id) continue;
    const id = requiredText(row, "id"), submissionId = requiredText(row, "submission_id");
    const relatedId = text(row, "related_item_id"), related = relatedId ? comments.get(relatedId) : undefined;
    let purpose: FilePurpose | null = null;
    let reason = "comment_item_semantics_unknown";
    if (row.kind === "attachment") { purpose = "research_source"; reason = "comment_original_attachment"; }
    else if (row.kind === "comment_image" && !relatedId) { purpose = "embedded_content"; reason = "comment_illustration"; }
    else if (row.kind === "comment_image" && related?.kind === "attachment"
      && related.submission_id === submissionId && related.related_item_id === id) {
      purpose = "derived_preview"; reason = "reciprocal_comment_preview";
    }
    const parent = submissions.get(submissionId);
    const assetId = text(row, "asset_id"), managedId = text(row, "storage_object_id");
    const slots: Array<"asset_id" | "storage_object_id" | "pending_content"> = [];
    if (assetId) slots.push("asset_id");
    if (managedId) slots.push("storage_object_id");
    if (!slots.length) slots.push("pending_content");
    for (const slot of slots) add({ table: "comment_submission_items", primaryKey: { id }, slot }, row,
      retention("comment_submission", submissionId, "comment_submission_item", id),
      resolve(slot === "asset_id" ? assetId : null, slot === "storage_object_id" ? managedId : null),
      purpose, [reason, ...(!parent ? ["comment_submission_missing"] : []),
        ...(assetId && managedId ? ["conflicting_registry_bindings"] : [])], parent);
  }
  for (const row of tables.events) {
    const id = requiredText(row, "id"), sample = requiredText(row, "sample_id"), asset = text(row, "asset_key");
    let metadata: Record<string, unknown> | null = null;
    if (typeof row.metadata_json === "string") {
      if (encoder.encode(row.metadata_json).byteLength > 1024 * 1024) throw new Error("File consumer event metadata exceeds its bound");
      try {
        const parsed: unknown = JSON.parse(row.metadata_json);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
      } catch { /* Opaque historical metadata establishes no thumbnail identity. */ }
    }
    if (asset) {
      const known = row.kind === "image" && metadata?.action === "sample_record";
      add({ table: "events", primaryKey: { id }, slot: "asset_key" }, row,
        retention("sample", sample, "event", id), resolve(null, null, asset), known ? "embedded_content" : null,
        [known ? "sample_record_image_occurrence" : "event_asset_purpose_not_recorded"]);
    }
    const thumbnail = metadata?.thumbnailKey;
    if (typeof thumbnail === "string" && thumbnail.trim()) {
      const key = requiredText({ key: thumbnail }, "key");
      const distinct = Boolean(asset) && key !== asset;
      add({ table: "events", primaryKey: { id }, slot: "metadata_json.thumbnailKey" }, row,
        retention("sample", sample, "event_thumbnail", `${id}:thumbnail`), resolve(null, null, key), distinct ? "derived_preview" : null,
        [distinct ? "distinct_event_thumbnail_slot" : key === asset ? "thumbnail_aliases_primary_bytes" : "thumbnail_source_missing"]);
    }
  }
  for (const row of tables.imports) {
    const id = requiredText(row, "id");
    for (const [slot, kind] of [["workbook_asset_key", "workbook"], ["manifest_asset_key", "manifest"]] as const) {
      const key = text(row, slot);
      if (key) add({ table: "imports", primaryKey: { id }, slot }, row,
        retention("import", id, `import_${kind}`, `${id}:${kind}`), resolve(null, null, key), "provenance", [`import_${kind}_provenance`]);
    }
  }
  for (const row of tables.template_versions) {
    const key = text(row, "source_asset_key");
    if (!key) continue;
    const id = requiredText(row, "id");
    add({ table: "template_versions", primaryKey: { id }, slot: "source_asset_key" }, row,
      retention("template_version", id, "template_source", `${id}:source`), resolve(null, null, key), "provenance", ["template_source_provenance"]);
  }
  for (const row of tables.project_content_attachments) {
    const id = requiredText(row, "project_content_id");
    const content = projectContents.get(id);
    const project = content && projects.get(requiredText(content, "project_id"));
    // These immutable bindings also accept copies of existing assets. Neither
    // their MIME nor the fact that a Project displays them proves original intent.
    const assetId = text(row, "asset_id"), managedId = text(row, "storage_object_id");
    const slots: Array<"asset_id" | "storage_object_id" | "pending_content"> = [];
    if (assetId) slots.push("asset_id");
    if (managedId) slots.push("storage_object_id");
    if (!slots.length) slots.push("pending_content");
    for (const slot of slots) add({ table: "project_content_attachments", primaryKey: { project_content_id: id }, slot },
      { ...row, deleted_at: content?.deleted_at ?? null }, retention("project_content", id, "project_content_attachment", id),
      resolve(slot === "asset_id" ? assetId : null, slot === "storage_object_id" ? managedId : null), null,
      ["project_source_purpose_not_recorded", ...(!content || !project ? ["project_owner_missing"] : []),
        ...(assetId && managedId ? ["conflicting_registry_bindings"] : [])], project);
  }
  for (const row of tables.attachment_derivatives) {
    const id = requiredText(row, "id");
    add({ table: "attachment_derivatives", primaryKey: { id }, slot: "derived_asset_id" }, row,
      retention("attachment_derivative", id, "attachment_derivative", id), resolve(text(row, "derived_asset_id"), null),
      row.derivative_kind === "browser_preview" ? "derived_preview" : null,
      [row.derivative_kind === "browser_preview" ? "browser_preview_derivative_record" : "derivative_kind_unknown"]);
  }

  consumers.sort((a, b) => compare(a.id, b.id));
  const candidates = new Map<string, FileConsumerObservation[]>();
  for (const consumer of consumers) {
    if (!consumer.locator) continue;
    const key = retentionKey(consumer.locator, consumer.retentionIdentity);
    const group = candidates.get(key) ?? [];
    group.push(consumer); candidates.set(key, group);
  }
  const projection: FileConsumerProjection = { version: 1, consumers,
    coverage: { retentionEdges: tables.blob_retention_edges.length, matchedEdges: 0,
      unmatchedEdges: [], ambiguousEdges: [], consumersWithoutRetention: [] } };
  const matched = new Set<string>();
  const sortedEdges = [...tables.blob_retention_edges].sort((a, b) => compare(canonical(a), canonical(b)));
  for (const row of sortedEdges) {
    if (!((row.store_kind === "r2" && row.provider === "r2")
      || (row.store_kind === "managed" && row.provider === "switchdrive"))) throw new Error("File consumer retention provider is unsupported");
    const edge: FileConsumerRetentionEdge = {
      locator: { storeKind: row.store_kind, provider: row.provider, objectKey: requiredText(row, "object_key") },
      sourceType: requiredText(row, "source_type"), sourceId: requiredText(row, "source_id"),
      occurrenceType: requiredText(row, "occurrence_type"), occurrenceId: requiredText(row, "occurrence_id"),
      blobRecordId: text(row, "blob_record_id"), retentionReason: requiredText(row, "retention_reason"), retainUntil: text(row, "retain_until"),
    };
    const group = candidates.get(retentionKey(edge.locator, edge)) ?? [];
    const previousIssues = projection.coverage.ambiguousEdges.length + projection.coverage.unmatchedEdges.length;
    if (group.length > 1) projection.coverage.ambiguousEdges.push({ edge, consumerIds: group.map((c) => c.id), reason: "ambiguous_canonical_identity" });
    else if (!group.length) projection.coverage.unmatchedEdges.push({ edge, consumerIds: [], reason: "no_canonical_consumer" });
    else if (edge.blobRecordId !== (group[0].registry?.id ?? null)) {
      projection.coverage.unmatchedEdges.push({ edge, consumerIds: [group[0].id], reason: "registry_identity_mismatch" });
    } else { projection.coverage.matchedEdges++; matched.add(group[0].id); }
    if (projection.coverage.ambiguousEdges.length + projection.coverage.unmatchedEdges.length !== previousIssues) {
      outputBytes += encoder.encode(JSON.stringify(edge)).byteLength + group.reduce((sum, c) => sum + encoder.encode(c.id).byteLength, 0) + 128;
      if (outputBytes > MAX_FILE_CONSUMER_OUTPUT_BYTES) throw new Error("File consumer projection exceeds its output bound");
    }
  }
  projection.coverage.consumersWithoutRetention = consumers.filter((c) => !matched.has(c.id)).map((c) => c.id);
  if (encoder.encode(JSON.stringify(projection)).byteLength > MAX_FILE_CONSUMER_OUTPUT_BYTES) {
    throw new Error("File consumer projection exceeds its output bound");
  }
  return projection;
}

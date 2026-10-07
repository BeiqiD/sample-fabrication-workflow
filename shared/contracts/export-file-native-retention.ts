import type { ExportRow, ExportTables } from "./export";
import { stableJson } from "../domain/content-addressing";

function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Full export rejected: invalid File retention ${reason}`);
}
const sameRows = (left: ExportRow[], right: ExportRow[]) => stableJson(left.map(stableJson).sort()) === stableJson(right.map(stableJson).sort());
const parsed = (value: unknown): Record<string, unknown> => {
  try { const result = JSON.parse(String(value)); return result && typeof result === "object" && !Array.isArray(result) ? result : {}; }
  catch { return {}; }
};
const nonempty = (value: unknown) => typeof value === "string" && value.length > 0;
// SQLite's date engine rounds fractional seconds to its integer millisecond
// representation; Date.parse truncates fractions beyond three digits.
const sqliteMillis = (value: unknown) => {
  const raw = String(value).trim(), local = raw.match(/^(\d{4}-\d{2}-\d{2})[ T]+(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/);
  // SQLite interprets an omitted offset as UTC; browsers interpret a local
  // date-time as the user's time zone. Explicit offsets retain their meaning.
  const text = local ? `${local[1]}T${local[2]}Z` : raw;
  const fraction = text.match(/\.(\d+)(?=Z$|[+-]\d{2}:\d{2}$)/)?.[1];
  return Date.parse(text) + (fraction ? Math.round(Number(`0.${fraction}`) * 1000) - Number((fraction + "000").slice(0, 3)) : 0);
};
const time = (value: unknown): value is string => typeof value === "string" && Number.isFinite(sqliteMillis(value));
const nextDay = (value: unknown) => new Date(sqliteMillis(value) + 86_400_000).toISOString();
type ExpectedEdge = { row: ExportRow; expires: boolean };

/** Reconstruct every File retention root at the SQL batch's source clock.
 * Clock-filtered grace edges must be strictly live at that clock; unfiltered
 * retry roots remain required regardless of their recorded deadline. Every
 * view must contain exactly those roots, including their multiplicity. */
export function validateFileNativeRetention(tables: ExportTables, snapshotClock: string) {
  ensure(time(snapshotClock), "source snapshot clock");
  const clock = sqliteMillis(snapshotClock), active = tables.file_authority_control[0]?.mode === "active";
  const edge = (file: unknown, sourceType: string, source: unknown, occurrenceType: string, occurrence: unknown,
    reason: string, until: unknown = null): ExportRow => ({ file_id: file as string, source_type: sourceType,
    source_id: source as string, occurrence_type: occurrenceType, occurrence_id: occurrence as string,
    retention_reason: reason, retain_until: until as string | null });
  const verify = (name: string, possible: ExpectedEdge[]) => {
    const remaining = possible.filter(expected => !expected.expires || (time(expected.row.retain_until)
      && sqliteMillis(expected.row.retain_until) > clock));
    for (const row of tables[name]) {
      const index = remaining.findIndex(expected => stableJson(expected.row) === stableJson(row));
      ensure(index >= 0, `${name} forged or duplicate root`); remaining.splice(index, 1);
    }
    ensure(remaining.length === 0, `${name} missing live root`);
  };
  const relational: ExpectedEdge[] = [], content: ExpectedEdge[] = [], direct: ExpectedEdge[] = [];
  const add = (target: ExpectedEdge[], row: ExportRow, expires = false) => target.push({ row, expires });
  for (const row of tables.state_representation_assets) if (row.file_id !== null)
    add(relational, edge(row.file_id, "state_representation", row.state_hash, "state_representation_asset", `${row.state_hash}:${row.asset_id}`, "state_representation"));
  for (const row of tables.run_step_assets) if (row.file_id !== null && row.superseded_by_occurrence_id === null) {
    ensure(row.deleted_at === null || time(row.deleted_at), "Run attachment grace clock");
    add(relational, edge(row.file_id, "run_step", row.run_step_id, "run_step_asset", row.id,
      row.deleted_at === null ? "run_step_asset" : "deleted_run_step_asset_grace", row.deleted_at === null ? null : nextDay(row.deleted_at)), row.deleted_at !== null);
  }
  for (const row of tables.metrology_template_references) if (row.file_id !== null && row.superseded_by_occurrence_id === null)
    add(relational, edge(row.file_id, "template_version", row.template_version_id, "metrology_template_reference", row.id, "metrology_template_reference"));
  for (const row of tables.run_step_comments) if (row.file_id !== null)
    add(relational, edge(row.file_id, "run_step_comment", row.id, "run_step_comment_file", row.id, "legacy_comment_file"));
  for (const row of tables.state_verifications) if (row.evidence_file_id !== null) {
    const asset = tables.assets.find(asset => asset.id === row.evidence_asset_id);
    const detached = active && tables.events.some(event => {
      const metadata = parsed(event.metadata_json);
      return event.kind === "verification" && event.sample_id === row.sample_id && event.asset_file_id === row.evidence_file_id
        && (event.asset_key !== null && event.asset_key === asset?.r2_key
          || asset?.r2_key === null && asset.file_id === row.evidence_file_id && event.asset_key === null && metadata.assetId === row.evidence_asset_id)
        && metadata.verificationId === row.id
        && nonempty(metadata.assetDeletionOperationId) && nonempty(metadata.assetDeletedAt);
    });
    if (!detached) add(relational, edge(row.evidence_file_id, "state_verification", row.id, "state_verification_evidence", row.id, "verification_evidence"));
  }
  for (const row of tables.comment_submission_items) if (row.file_id !== null) {
    const parent = tables.comment_submissions.find(parent => parent.id === row.submission_id);
    ensure(parent, "Comment retention parent");
    if (parent.status === "ready" && row.status === "ready") {
      ensure(row.deleted_at === null || time(row.deleted_at), "Comment grace clock");
      add(content, edge(row.file_id, "comment_submission", parent.id, "comment_submission_item", row.id,
        row.deleted_at === null ? "ready_comment_item" : "deleted_comment_item_grace", row.deleted_at === null ? null : nextDay(row.deleted_at)), row.deleted_at !== null);
    }
    if (row.status !== "cancelled" && row.deleted_at === null && parent.retry_closed_at === null
      && ["draft", "uploading", "failed"].includes(String(parent.status)))
      add(content, edge(row.file_id, "comment_submission", parent.id, "comment_submission_item", row.id,
        parent.status === "failed" ? "retryable_comment_item" : "unfinished_comment_item", parent.retry_until));
  }
  for (const row of tables.project_content_attachments) if (row.file_id !== null)
    add(content, edge(row.file_id, "project_content", row.project_content_id, "project_content_attachment", row.project_content_id, "project_attachment"));
  for (const row of tables.attachment_derivatives) if (row.derived_file_id !== null && row.status === "ready" && row.retain_until !== null)
    add(content, edge(row.derived_file_id, "attachment_derivative", row.id, "attachment_derivative", row.id, "derivative_cache", row.retain_until), true);
  for (const row of tables.events) {
    const metadata = parsed(row.metadata_json);
    if (active && (nonempty(metadata.assetDeletedAt) || nonempty(metadata.deletedAt))) continue;
    if (row.asset_file_id !== null) add(direct, edge(row.asset_file_id, "sample", row.sample_id, "event", row.id, "event_asset"));
    if (row.thumbnail_file_id !== null) add(direct, edge(row.thumbnail_file_id, "sample", row.sample_id, "event_thumbnail", `${row.id}:thumbnail`, "sample_record_thumbnail"));
  }
  for (const row of tables.imports) {
    if (row.workbook_file_id !== null) add(direct, edge(row.workbook_file_id, "import", row.id, "import_workbook", `${row.id}:workbook`, "import_provenance"));
    if (row.manifest_file_id !== null) add(direct, edge(row.manifest_file_id, "import", row.id, "import_manifest", `${row.id}:manifest`, "import_provenance"));
  }
  for (const row of tables.template_versions) if (row.source_file_id !== null)
    add(direct, edge(row.source_file_id, "template_version", row.id, "template_source", `${row.id}:source`, "template_provenance"));
  verify("file_relational_retention_edges", relational); verify("file_content_retention_edges", content); verify("file_direct_retention_edges", direct);
  const shadow: ExportRow[] = [];
  for (const head of tables.file_shadow_heads) if (head.present === 1) {
    const decision = tables.file_shadow_decisions.find(row => row.occurrence_id === head.occurrence_id);
    if (decision?.decision === "resolved") shadow.push(edge(decision.file_id, "file_shadow_occurrence", head.occurrence_id,
      "file_shadow_publication", head.occurrence_id, "shadow_publication"));
  }
  // This historical view is composed into both exported aggregates; it has
  // never been an independently serialized table in the frozen catalogs.
  ensure(sameRows(tables.file_retention_edges, [...tables.file_relational_retention_edges, ...tables.file_content_retention_edges,
    ...tables.file_direct_retention_edges, ...shadow]), "complete File root aggregate");
  const locationEdges: ExpectedEdge[] = [];
  const publications = new Map(tables.file_publications.filter(row => row.state === "ready").map(row => [row.file_id, row]));
  const locations = new Map(tables.file_locations.map(row => [row.id, row]));
  for (const root of tables.file_retention_edges) {
    const publication = publications.get(root.file_id);
    if (publication) add(locationEdges, { location_id: publication.active_location_id, ...root });
  }
  for (const hold of tables.file_holds) if (hold.released_at === null) {
    const publication = publications.get(hold.file_id);
    if (publication) add(locationEdges, { location_id: publication.active_location_id,
      ...edge(hold.file_id, "file", hold.file_id, "file_hold", hold.id, String(hold.hold_kind), hold.expires_at) }, hold.expires_at !== null);
  }
  for (const candidate of tables.file_acceptance_candidates) if (candidate.state === "candidate") {
    const id = `${candidate.acceptance_kind}:${candidate.acceptance_id}:${candidate.item_id}`;
    add(locationEdges, { location_id: candidate.candidate_location_id,
      ...edge(candidate.candidate_file_id, "file_acceptance_candidate", id, "candidate_registration", id, "acceptance_in_flight") });
  }
  for (const hold of tables.file_location_holds) if (hold.released_at === null) {
    const location = locations.get(hold.location_id); ensure(location, "physical hold owner");
    add(locationEdges, { location_id: hold.location_id,
      ...edge(location.file_id, "file_location", hold.location_id, "file_location_hold", hold.id, String(hold.hold_kind), hold.expires_at) }, hold.expires_at !== null);
  }
  for (const root of shadow) {
    const decision = tables.file_shadow_decisions.find(row => row.occurrence_id === root.occurrence_id)!;
    add(locationEdges, { location_id: decision.location_id, ...root });
  }
  verify("file_location_retention_edges", locationEdges);
}

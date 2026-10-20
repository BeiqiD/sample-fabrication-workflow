import type { ExportRow, ExportTables } from "./export";
import { stableJson } from "../domain/content-addressing";

/** V23 package publication uses neutral aliases on R2 as well as S3. Permit
 * only the exact R2 alias owned by a completed, independently verified copy. */
export function researchNativeR2AssetEvidence(tables: ExportTables) {
  const profiles = new Map(tables.storage_profiles.map(row => [row.id, row]));
  const jobs = new Map(tables.research_package_jobs.map(row => [row.id, row]));
  const locations = new Map(tables.file_locations.map(row => [row.id, row]));
  const aliases = new Map<unknown, ExportRow[]>();
  for (const file of tables.research_package_files) if (file.candidate_asset_id !== null)
    aliases.set(file.candidate_asset_id, [...(aliases.get(file.candidate_asset_id) ?? []), file]);
  return (asset: ExportRow): boolean => profiles.get(asset.storage_profile_id)?.adapter_type === "r2"
    && (aliases.get(asset.id) ?? []).some(file => {
      const job = jobs.get(file.job_id), location = locations.get(file.result_location_id);
      return job?.kind === "import" && job.state === "completed" && job.phase === "done"
        && file.entry_kind === "payload" && file.state === "published" && file.reuse_file_id === null
        && file.result_file_id === asset.file_id && file.target_profile_id === asset.storage_profile_id
        && file.target_profile_revision === asset.storage_profile_revision && location?.file_id === asset.file_id
        && location.storage_profile_id === asset.storage_profile_id && location.object_key === asset.object_key
        && file.sha256 === asset.sha256 && file.byte_size === asset.byte_size;
    });
}

/** Imported previews retain their accepted, unverified origin claim. This
 * successor-only proof does not create a trusted derivation or an I/O grant. */
export function researchImportedPreviewEvidence(tables: ExportTables) {
  const jobs = new Map(tables.research_package_jobs.map(row => [row.id, row]));
  const records = new Map(tables.research_package_records.map(row => [stableJson([row.job_id, row.record_kind, row.source_id]), row]));
  const files = new Map(tables.research_package_files.map(row => [stableJson([row.job_id, row.logical_file_id]), row]));
  const maps = new Map(tables.research_package_identity_maps.map(row => [stableJson([row.job_id, row.entity_kind, row.source_id]), row.destination_id]));
  const destinations = new Map<string, ExportRow[]>();
  for (const map of tables.research_package_identity_maps) {
    const key = stableJson([map.entity_kind, map.destination_id]);
    destinations.set(key, [...(destinations.get(key) ?? []), map]);
  }
  const destination = (job: unknown, kind: string, source: unknown) => maps.get(stableJson([job, kind, source]));
  const data = (job: unknown, kind: string, source: unknown): Record<string, unknown> | null => {
    const row = records.get(stableJson([job, kind, source]));
    if (!row) return null;
    const value = JSON.parse(String(row.record_json));
    return value && value.kind === kind && value.sourceId === source && value.data
      && typeof value.data === "object" && !Array.isArray(value.data) ? value.data : null;
  };
  const payload = (job: unknown, logical: unknown, fileId: unknown, purpose: string) => {
    const file = files.get(stableJson([job, logical]));
    return file?.entry_kind === "payload" && file.state === "published" && file.result_file_id === fileId && file.purpose === purpose;
  };
  return (table: string, row: ExportRow, column: string): boolean => {
    const kind = table === "events" && column === "thumbnail_file_id" ? "event"
      : table === "comment_submission_items" && column === "file_id" ? "commentItem" : null;
    if (!kind) return false;
    for (const map of destinations.get(stableJson([kind, row.id])) ?? []) {
      const job = jobs.get(map.job_id);
      if (job?.kind !== "import" || job.state !== "completed" || job.phase !== "done") continue;
      const accepted = data(map.job_id, kind, map.source_id);
      if (!accepted) continue;
      if (kind === "event") {
        if (payload(map.job_id, accepted.thumbnailPackageFileId, row.thumbnail_file_id, "derived_preview")
          && (accepted.packageFileId == null ? row.asset_file_id === null
            : payload(map.job_id, accepted.packageFileId, row.asset_file_id, "embedded_content"))) return true;
      } else {
        const original = data(map.job_id, "commentItem", accepted.related_item_id);
        const originalId = destination(map.job_id, "commentItem", accepted.related_item_id);
        const originalRow = tables.comment_submission_items.find(item => item.id === originalId);
        if (accepted.kind === "comment_image" && row.kind === "comment_image" && original?.kind === "attachment"
          && original.submission_id === accepted.submission_id && row.related_item_id === originalId
          && row.submission_id === destination(map.job_id, "comment", accepted.submission_id)
          && originalRow?.submission_id === row.submission_id && originalRow.kind === "attachment"
          && originalRow.related_item_id === (original.related_item_id == null ? null
            : destination(map.job_id, "commentItem", original.related_item_id))
          && payload(map.job_id, accepted.packageFileId, row.file_id, "derived_preview")
          && payload(map.job_id, original.packageFileId, originalRow.file_id, "research_source")) return true;
      }
    }
    return false;
  };
}

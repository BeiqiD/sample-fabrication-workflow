import type { ExportRow, ExportTables, FullExportBlobEntryV21, FullExportNativeBlobEntryV21 } from "./export";
import { buildFileShadowBlobExportPlan } from "./export-file-shadow";

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0");
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const size = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Full export rejected: invalid native File byte plan ${reason}`);
}

/** V21 explicitly inventories S3 File addresses. The historical planner receives
 * only actual historical locations; no native location becomes a legacy key. */
export function buildFileNativeBlobExportPlan(tables: ExportTables): FullExportBlobEntryV21[] {
  const profiles = new Map((tables.storage_profiles ?? []).map(row => [row.id, row]));
  const locations = tables.file_locations ?? [];
  const nativeLocations = locations.filter(location => profiles.get(location.storage_profile_id)?.adapter_type === "s3");
  const historical = buildFileShadowBlobExportPlan({ ...tables,
    file_locations: locations.filter(location => profiles.get(location.storage_profile_id)?.adapter_type !== "s3") });
  const files = new Map((tables.files ?? []).map(row => [row.id, row]));
  const publications = new Map((tables.file_location_publications ?? []).map(row => [row.location_id, row]));
  const availability = new Map((tables.file_location_availability ?? []).map(row => [row.location_id, row]));
  const result: FullExportBlobEntryV21[] = [...historical];
  for (const location of [...nativeLocations].sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)) {
    const profile = profiles.get(location.storage_profile_id), file = files.get(location.file_id);
    const publication = publications.get(location.id), available = availability.get(location.id);
    ensure(profile && file && text(location.id) && text(location.object_key) && text(profile.id)
      && profile.adapter_type === "s3" && size(profile.configuration_revision) && profile.configuration_revision > 0,
    "profile-qualified address");
    const ready = publication && available?.availability === "available"
      && hash(publication.verified_sha256) && size(publication.verified_byte_size);
    const occurrence = (edge: ExportRow) => ({ sourceType: String(edge.source_type), sourceId: String(edge.source_id),
      occurrenceType: String(edge.occurrence_type), occurrenceId: String(edge.occurrence_id),
      retentionReason: String(edge.retention_reason), retainUntil: typeof edge.retain_until === "string" ? edge.retain_until : null });
    const entry: FullExportNativeBlobEntryV21 = {
      locatorId: JSON.stringify(["file_location", profile.id, profile.configuration_revision, location.object_key]),
      storeKind: "file", provider: "s3", objectKey: location.object_key,
      blobRecordIds: [location.id], filename: `location-${location.id}.blob`,
      expectedByteSize: publication ? Number(publication.verified_byte_size) : typeof file.expected_byte_size === "number" ? file.expected_byte_size : null,
      expectedSha256: publication ? String(publication.verified_sha256) : typeof file.expected_sha256 === "string" ? file.expected_sha256 : null,
      sourceOccurrences: (tables.file_location_retention_edges ?? []).filter(edge => edge.location_id === location.id).map(occurrence),
      downloadUrl: ready ? `/exports/file-locations/${encodeURIComponent(location.id)}?profile=${encodeURIComponent(profile.id)}&revision=${profile.configuration_revision}` : null,
      initialOutcome: ready ? null : available?.availability === "deleted" ? "missing"
        : available?.availability === "profile_retired" ? "provider_unavailable" : "metadata_not_ready",
      byteAuthority: "file_location", storageProfileId: profile.id,
      storageProfileRevision: profile.configuration_revision, locationId: location.id,
    };
    result.push(entry);
  }
  ensure(new Set(result.map(entry => entry.locatorId)).size === result.length, "unique physical locators");
  return result;
}

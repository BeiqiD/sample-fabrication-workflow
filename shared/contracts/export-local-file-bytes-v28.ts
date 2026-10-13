import type { ExportRow, FullExportBlobEntryV21, FullExportNativeBlobEntryV21 } from "./export";
import type { FilePurpose } from "./files";
import type { LocalVolumeNamespace } from "./local-volume-profile";
import { checkedStoredLocalVolumeNamespace } from "./local-volume-profile";
import type { ArchiveSource } from "../domain/research-archive";
import { RESEARCH_ARCHIVE_CHUNK_BYTES, RESEARCH_ARCHIVE_PAYLOAD_MAX_BYTES } from "../domain/research-archive";
import { createResearchSha256 } from "../domain/research-sha256";
import { stableJson } from "../domain/content-addressing";
import { buildResearchPackageBlobExportPlan } from "./export-research-packages";
import { buildSystemRecoveryBlobExportPlanV28 } from "./export-system-recovery-evidence-v28";
import { localFileRuntimeSnapshotV28, type LocalFileRuntimeEvidenceV28 } from "./export-local-file-runtime-v28";

export interface LocalVolumeConsumerBindingV28 {
  consumerKind: string; consumerId: string; consumerSubId: string; fileSlot: string;
  fileId: string; purpose: FilePurpose | null;
}
/** A new physical locator branch. It never becomes an S3 address, filesystem
 * path, installation binding or permission to open an original provider. */
export interface LocalVolumeBlobEntryV28 extends Omit<FullExportNativeBlobEntryV21, "provider" | "storageProfileRevision"> {
  provider: "local";
  storageProfileRevision: 1;
  namespace: Readonly<LocalVolumeNamespace>;
  fileId: string;
  purpose: FilePurpose;
  accessScope: "system";
  consumerBindings: LocalVolumeConsumerBindingV28[];
}
export type FullExportBlobEntryV28 = FullExportBlobEntryV21 | LocalVolumeBlobEntryV28;
export type FileBlobExportPlanV28 = Omit<ReturnType<typeof buildSystemRecoveryBlobExportPlanV28>, "blobs"> & {
  blobs: FullExportBlobEntryV28[];
};
const PURPOSES = ["research_source", "embedded_content", "derived_preview", "provenance", "job_output"] as const;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0");
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const size = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`V28 local File byte inventory rejected: ${reason}`);
}
const ordered = <T>(values: T[]) => values.sort((a, b) => stableJson(a) < stableJson(b) ? -1 : stableJson(a) > stableJson(b) ? 1 : 0);
function occurrence(edge: ExportRow) {
  return { sourceType: String(edge.source_type), sourceId: String(edge.source_id), occurrenceType: String(edge.occurrence_type),
    occurrenceId: String(edge.occurrence_id), retentionReason: String(edge.retention_reason),
    retainUntil: typeof edge.retain_until === "string" ? edge.retain_until : null };
}

/** The original planner receives only its original nonlocal physical location
 * partition. All source cells, consumers and historical evidence remain in the
 * complete captured graph. The new branch inventories EVERY local location,
 * including unavailable or incomplete ones; it invents no download endpoint. */
export function planFileBlobExportV28(evidence: LocalFileRuntimeEvidenceV28,
  backupHoldOwner: string | null = null): FileBlobExportPlanV28 {
  const snapshot = localFileRuntimeSnapshotV28(evidence), tables = snapshot.tables;
  const localIds = new Set(snapshot.localProfileIds);
  const base = buildResearchPackageBlobExportPlan({ ...tables,
    file_locations: tables.file_locations.filter(row => !localIds.has(String(row.storage_profile_id))),
  }, snapshot.snapshotClock);
  const profiles = new Map(tables.storage_profiles.map(row => [row.id, row]));
  const files = new Map(tables.files.map(row => [row.id, row]));
  const publications = new Map(tables.file_location_publications.map(row => [row.location_id, row]));
  const availability = new Map(tables.file_location_availability.map(row => [row.location_id, row]));
  const locations = tables.file_locations.filter(row => localIds.has(String(row.storage_profile_id)))
    .sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
  const local = locations.map((location, index): LocalVolumeBlobEntryV28 => {
    const profile = profiles.get(location.storage_profile_id), file = files.get(location.file_id);
    const publication = publications.get(location.id), available = availability.get(location.id);
    ensure(profile && file && profile.adapter_type === "local" && profile.configuration_revision === 1
      && text(profile.id) && text(location.id) && text(location.object_key) && text(file.id)
      && file.access_scope === "system" && PURPOSES.includes(file.purpose as FilePurpose), "profile-qualified address");
    const namespace = checkedStoredLocalVolumeNamespace(profile.namespace_identity);
    const ready = publication && available?.availability === "available"
      && hash(publication.verified_sha256) && size(publication.verified_byte_size);
    const consumerBindings = ordered(tables.file_consumer_projection.filter(row => row.file_id === file.id).map(row => ({
      consumerKind: String(row.consumer_kind), consumerId: String(row.consumer_id), consumerSubId: String(row.consumer_sub_id),
      fileSlot: String(row.file_slot), fileId: String(row.file_id),
      purpose: PURPOSES.includes(row.expected_purpose as FilePurpose) ? row.expected_purpose as FilePurpose : null,
    })));
    return {
      locatorId: JSON.stringify(["local_file_location/v28", namespace, profile.id, 1, location.object_key]),
      storeKind: "file", provider: "local", byteAuthority: "file_location", storageProfileId: profile.id,
      storageProfileRevision: 1, locationId: location.id, objectKey: location.object_key, namespace,
      fileId: file.id, purpose: file.purpose as FilePurpose, accessScope: "system", consumerBindings,
      blobRecordIds: [location.id], filename: `local-location-${String(index).padStart(4, "0")}.blob`,
      expectedByteSize: publication ? Number(publication.verified_byte_size) : typeof file.expected_byte_size === "number" ? file.expected_byte_size : null,
      expectedSha256: publication ? String(publication.verified_sha256) : typeof file.expected_sha256 === "string" ? file.expected_sha256 : null,
      sourceOccurrences: ordered(tables.file_location_retention_edges.filter(row => row.location_id === location.id).map(occurrence)),
      downloadUrl: null,
      initialOutcome: ready ? null : available?.availability === "deleted" ? "missing"
        : available?.availability === "profile_retired" ? "provider_unavailable" : "metadata_not_ready",
    };
  });
  const blobs: FullExportBlobEntryV28[] = [...base.blobs, ...local];
  ensure(new Set(blobs.map(row => row.locatorId)).size === blobs.length, "unique physical locators");
  return buildSystemRecoveryBlobExportPlanV28(tables, { blobs, excludedOutputs: base.excludedOutputs }, backupHoldOwner);
}

/** Deserialized archive addresses must match the complete newly validated
 * source snapshot, including every occurrence and consumer, before byte I/O.
 * Matching metadata grants no access to any original volume or target path. */
export function checkedLocalVolumeSourceV28(evidence: LocalFileRuntimeEvidenceV28, value: unknown): LocalVolumeBlobEntryV28 {
  const encoded = stableJson(value);
  const source = planFileBlobExportV28(evidence).blobs.find(row => row.provider === "local"
    && stableJson(row) === encoded);
  ensure(source && source.storeKind === "file" && source.provider === "local" && "namespace" in source, "exact local source inventory");
  return source as LocalVolumeBlobEntryV28;
}

/** Full bounded SHA-256 of an admitted archive member or an independently
 * owned source read. The caller retains the original read owner and its close
 * promise; this metadata helper neither opens nor disposes a provider. Each
 * original bounded read is awaited before another starts. */
export async function verifyLocalVolumePayloadV28(evidence: LocalFileRuntimeEvidenceV28,
  value: unknown, source: ArchiveSource, signal?: AbortSignal): Promise<{ byteSize: number; sha256: string }> {
  const expected = checkedLocalVolumeSourceV28(evidence, value);
  ensure(expected.initialOutcome === null && size(expected.expectedByteSize) && hash(expected.expectedSha256)
    && expected.expectedByteSize <= RESEARCH_ARCHIVE_PAYLOAD_MAX_BYTES && source.byteSize === expected.expectedByteSize,
  "complete payload expectation");
  const digest = createResearchSha256(), byteSize = source.byteSize;
  for (let offset = 0; offset < byteSize; offset += RESEARCH_ARCHIVE_CHUNK_BYTES) {
    signal?.throwIfAborted();
    const length = Math.min(RESEARCH_ARCHIVE_CHUNK_BYTES, byteSize - offset);
    const bytes = await source.read(offset, length, signal);
    ensure(bytes instanceof Uint8Array && bytes.byteLength === length, "exact bounded payload read");
    digest.update(bytes);
  }
  signal?.throwIfAborted();
  const sha256 = digest.digestHex();
  ensure(sha256 === expected.expectedSha256 && source.byteSize === byteSize, "full payload SHA-256");
  return { byteSize, sha256 };
}

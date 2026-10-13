// Explicit V5 native LOCAL-to-R2 plan. No V3 source is cast or relabelled.
import type { ExportRow } from "../../shared/contracts/export";
import type { SystemBackupManifestV5, SystemBackupRecordsV5 } from "../../shared/contracts/system-backup-v5";
import type { SystemRecoveryTable, SystemRecoveryCell, RecoveryTableSpec } from "../../shared/contracts/system-recovery-image";
import { stableJson, sha256Hex } from "../../shared/domain/content-addressing";
import type { RecoveryDestinationProfile, RecoveryPlannedFile } from "./target-files";
import { reviewedRecoveryBinding } from "./target-files";
import type { V5R2PayloadMappingCandidate } from "./v5-fresh-target-candidate";
import { V5_RECOVERY_CATALOG_CANDIDATE as catalog } from "./v5-catalog-candidate";

function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error("v5_local_r2_plan_" + reason);
}
export async function planV5LocalR2FilesCandidate(records: SystemBackupRecordsV5, manifest: SystemBackupManifestV5,
  mappings: readonly V5R2PayloadMappingCandidate[], profiles: readonly RecoveryDestinationProfile[], incarnation: string) {
  ensure(manifest.completeness === "complete" && manifest.files.length <= 100 && records.image.version === 5
    && records.image.checkpointId === "portable-runtime/v28", "version_or_inventory");
  ensure(records.image.tables.file_shadow_heads.rows.every(row => {
    const column = records.image.tables.file_shadow_heads.columns.indexOf("present");
    return row.cells[column].type === "integer" && row.cells[column].value === "0";
  }), "active_shadow_heads_not_admitted");
  const sourceImageSha256 = await sha256Hex(stableJson(records.image));
  const result: RecoveryPlannedFile[] = [];
  for (const payload of manifest.files) {
    const source = payload.source;
    ensure(source.storeKind === "file" && source.provider === "local" && source.byteAuthority === "file_location"
      && payload.outcome === "packaged" && payload.path !== null && payload.byteSize !== null && payload.sha256 !== null,
    "complete_native_local_source_required");
    ensure(payload.fileIds.length === 1 && payload.fileIds[0] === source.fileId && payload.purposes.length === 1
      && payload.purposes[0] === source.purpose && source.accessScope === "system", "canonical_file_identity");
    // This finite first byte-publication slice preserves ordinary opaque Files.
    // Imported preview-origin conversion and legacy identity creation are later.
    ensure(source.purpose !== "derived_preview", "preview_origin_conversion_not_admitted");
    ensure(payload.bindings.length === 0 && source.consumerBindings.length === 0, "bound_files_not_admitted");
    const file = records.content.tables.files.find(row => row.id === source.fileId);
    const publication = records.content.tables.file_publications.find(row => row.file_id === source.fileId);
    const location = records.content.tables.file_locations.find(row => row.id === source.locationId);
    ensure(file && publication && location && file.purpose === source.purpose && file.access_scope === "system"
      && file.expected_byte_size === payload.byteSize && file.expected_sha256 === payload.sha256
      && publication.purpose === source.purpose && publication.access_scope === "system" && publication.state === "ready"
      && publication.verified_byte_size === payload.byteSize && publication.verified_sha256 === payload.sha256
      && location.file_id === source.fileId && location.storage_profile_id === source.storageProfileId
      && location.object_key === source.objectKey, "original_publication");
    const selected = mappings.find(mapping => mapping.sourceId === payload.id);
    const profile = profiles.find(profile => profile.id === selected?.destinationProfileId);
    ensure(selected && profile && profile.adapterType === "r2" && profile.configurationRevision === 1
      && selected.destinationNamespaceIdentity === profile.namespaceIdentity
      && stableJson(selected.source) === stableJson(source) && selected.archivePath === payload.path
      && selected.sha256 === payload.sha256 && selected.byteSize === payload.byteSize, "owned_explicit_mapping");
    const id = "rf_" + await sha256Hex(stableJson({ incarnation, source: payload.id, fileId: source.fileId,
      destination: profile.id, namespace: profile.namespaceIdentity }));
    const aliases = records.content.tables.assets.filter(row => row.file_id === source.fileId)
      .map(row => ({ table: "assets" as const, row: { ...row } }));
    const bindings = payload.bindings.map(binding => {
      const spec = reviewedRecoveryBinding(binding);
      ensure(binding.fileId === source.fileId && spec.purpose === source.purpose, "preserved_binding_identity");
      return { ...binding, purpose: source.purpose };
    });
    const bindingEvidence: RecoveryPlannedFile["bindingEvidence"] = [];
    for (const binding of bindings) {
      const spec = reviewedRecoveryBinding(binding), row = records.content.tables[spec.table].find(row =>
        Object.entries(spec.keys).every(([key, value]) => row[key] === value));
      ensure(row && row[spec.column] === source.fileId, "exact_canonical_consumer");
      bindingEvidence.push({ binding, rowSha256: await sha256Hex(stableJson(row)), previewOriginJson: stableJson({ kind: "none" }) });
    }
    result.push({ id, sourceId: payload.id, archivePath: payload.path, sourceProfileId: source.storageProfileId,
      destinationProfileId: profile.id, configurationRevision: 1, destinationNamespaceIdentity: profile.namespaceIdentity,
      destinationAdapterType: "r2", incarnation, fileId: source.fileId, purpose: source.purpose, createFile: false,
      nativePublicationExists: true, publishAsActive: publication.active_location_id === source.locationId,
      locationId: "fp5-location:" + incarnation + ":" + id.slice(3), objectKey: selected.objectKey,
      byteSize: payload.byteSize, sha256: payload.sha256, contentType: "application/octet-stream", filename: payload.id,
      bindings: [], aliases: [], backupId: records.backupId, sourceImageSha256,
      destinationMetadataSha256: profile.metadataSha256 ?? await sha256Hex(stableJson(profile)),
      sourceLocatorJson: stableJson({ sourceId: payload.id, locatorId: source.locatorId, storeKind: source.storeKind,
        provider: source.provider, byteAuthority: source.byteAuthority, storageProfileId: source.storageProfileId,
        storageProfileRevision: source.storageProfileRevision, locationId: source.locationId, objectKey: source.objectKey,
        expectedByteSize: source.expectedByteSize, expectedSha256: source.expectedSha256 }),
      originalAliases: aliases, bindingEvidence });
  }
  ensure(new Set(result.map(file => file.id)).size === result.length && new Set(result.map(file => file.objectKey)).size === result.length,
    "destination_identity_duplicate");
  ensure(result.reduce((sum, file) => sum + file.byteSize, 0) <= 96 * 1024 * 1024, "copy_budget");
  return result;
}
export interface V5PayloadImageChangeCandidate { table: "file_publications"; keys: { file_id: string }; column: "active_location_id"; value: string }
const value = (cell: SystemRecoveryCell): string | null => cell.type === "null" ? null : cell.value;
const rowKey = (spec: RecoveryTableSpec, row: { rowid: string | null; cells: SystemRecoveryCell[] }) => spec.withoutRowid
  ? stableJson((spec.primaryKeyColumns ?? spec.columns).map(column => row.cells[spec.columns.indexOf(column)])) : row.rowid;
/** Preserve old rowids and every old typed cell except the exact canonical
 * File active-location mapping. Immutable shadow history has no exemption. Appended rows must match every
 * typed scalar of the code-owned publication plan; their new physical rowids
 * are subsequently covered by the complete immutable registry claim proof. */
export function verifyV5PayloadImageCandidate(observed: Record<string, SystemRecoveryTable>,
  baseline: Record<string, SystemRecoveryTable>, appends: Record<string, ExportRow[]>, changes: readonly V5PayloadImageChangeCandidate[]) {
  for (const spec of catalog.tables) {
    if (spec.name === "system_recovery_target_claim") continue;
    const actual = observed[spec.name], original = baseline[spec.name];
    ensure(actual && original && stableJson(actual.columns) === stableJson(original.columns), "table_columns:" + spec.name);
    const remaining = new Map(actual.rows.map(row => [rowKey(spec, row), row]));
    for (const row of original.rows) {
      const found = remaining.get(rowKey(spec, row)); ensure(found, "original_row_missing:" + spec.name); remaining.delete(rowKey(spec, row));
      for (let index = 0; index < spec.columns.length; index++) {
        const before = row.cells[index], after = found.cells[index];
        if (stableJson(before) === stableJson(after)) continue;
        const allowed = changes.filter(change => change.table === spec.name && change.column === spec.columns[index]
          && Object.entries(change.keys).every(([key, expected]) => value(row.cells[spec.columns.indexOf(key)]) === expected));
        ensure(allowed.length === 1 && after.type === "text" && after.value === allowed[0].value,
          "unclassified_original_cell:" + spec.name + ":" + spec.columns[index]);
      }
    }
    const expected = (appends[spec.name] ?? []).map(row => stableJson(spec.columns.map(column => {
      const cell = row[column]; return spec.name === "file_registry_rowid_claims" && column === "claimed_rowid"
        ? { type: "integer", value: String(cell) } : cell === null ? { type: "null" } : typeof cell === "number"
        ? { type: Number.isInteger(cell) ? "integer" : "real", value: String(cell) } : { type: "text", value: cell };
    }))).sort();
    ensure(stableJson([...remaining.values()].map(row => stableJson(row.cells)).sort()) === stableJson(expected),
      "unclassified_appended_row:" + spec.name);
  }
}

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
export function planV5LocalR2FilesCandidate(records: SystemBackupRecordsV5,manifest: SystemBackupManifestV5,
  mappings: readonly V5R2PayloadMappingCandidate[],profiles: readonly RecoveryDestinationProfile[],incarnation: string) {
  return planV5NativeFiles(records,manifest,mappings,profiles,incarnation,false);
}
async function planV5NativeFiles(records: SystemBackupRecordsV5, manifest: SystemBackupManifestV5,
  mappings: readonly V5R2PayloadMappingCandidate[], profiles: readonly RecoveryDestinationProfile[], incarnation: string,nativeR2: boolean) {
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
    ensure((source.storeKind === "file" && source.provider === "local" || nativeR2 && source.storeKind === "r2" && source.provider === "r2")
      && source.byteAuthority === "file_location" && source.storageProfileId !== null && source.storageProfileRevision === 1 && source.locationId !== null
      && payload.outcome === "packaged" && payload.path !== null && payload.byteSize !== null && payload.sha256 !== null,
    nativeR2?"complete_native_local_or_r2_source_required":"complete_native_local_source_required");
    ensure(payload.fileIds.length === 1 && payload.purposes.length === 1,"canonical_file_identity");
    const fileId=payload.fileIds[0],purpose=payload.purposes[0];
    if(source.provider === "local") ensure(fileId === source.fileId && purpose === source.purpose && source.accessScope === "system","canonical_file_identity");
    // Reviewed native consumers already point to this canonical File. Preserve
    // their exact business cells/rowids and acceptance receipts; the recovered
    // address is published on that same File, never by rewriting a consumer.
    // Native-only consumers need no manufactured legacy shadow occurrence.
    // Nonzero current legacy heads remain separately denied above until their
    // global profileRevision successor events have an admitted append owner.
    ensure(purpose !== "derived_preview", "preview_origin_conversion_not_admitted");
    ensure(payload.bindings.length <= 16 && (source.provider !== "local" || stableJson(payload.bindings) === stableJson(source.consumerBindings)),
      "bounded_exact_native_consumers");
    const file = records.content.tables.files.find(row => row.id === fileId);
    const publication = records.content.tables.file_publications.find(row => row.file_id === fileId);
    const location = records.content.tables.file_locations.find(row => row.id === source.locationId);
    ensure(file && publication && location && file.purpose === purpose && file.access_scope === "system"
      && file.expected_byte_size === payload.byteSize && file.expected_sha256 === payload.sha256
      && publication.purpose === purpose && publication.access_scope === "system" && publication.state === "ready"
      && publication.verified_byte_size === payload.byteSize && publication.verified_sha256 === payload.sha256
      && location.file_id === fileId && location.storage_profile_id === source.storageProfileId
      && location.object_key === source.objectKey, "original_publication");
    const selected = mappings.find(mapping => mapping.sourceId === payload.id);
    const profile = profiles.find(profile => profile.id === selected?.destinationProfileId);
    ensure(selected && profile && profile.adapterType === "r2" && profile.configurationRevision === 1
      && selected.destinationNamespaceIdentity === profile.namespaceIdentity
      && stableJson(selected.source) === stableJson(source) && selected.archivePath === payload.path
      && selected.sha256 === payload.sha256 && selected.byteSize === payload.byteSize, "owned_explicit_mapping");
    const id = "rf_" + await sha256Hex(stableJson({ incarnation, source: payload.id, fileId: fileId,
      destination: profile.id, namespace: profile.namespaceIdentity }));
    const aliases = records.content.tables.assets.filter(row => row.file_id === fileId)
      .map(row => ({ table: "assets" as const, row: { ...row } }));
    ensure(aliases.length <= 16, "bounded_original_aliases");
    const bindings = payload.bindings.map(binding => {
      const spec = reviewedRecoveryBinding(binding);
      ensure(binding.fileId === fileId && spec.purpose === purpose, "preserved_binding_identity");
      return { ...binding, purpose: purpose };
    });
    const bindingEvidence: RecoveryPlannedFile["bindingEvidence"] = [];
    for (const binding of bindings) {
      const spec = reviewedRecoveryBinding(binding), row = records.content.tables[spec.table].find(row =>
        Object.entries(spec.keys).every(([key, value]) => row[key] === value));
      ensure(row && row[spec.column] === fileId, "exact_canonical_consumer");
      bindingEvidence.push({ binding, rowSha256: await sha256Hex(stableJson(row)), previewOriginJson: stableJson({ kind: "none" }) });
    }
    result.push({ id, sourceId: payload.id, archivePath: payload.path, sourceProfileId: source.storageProfileId,
      destinationProfileId: profile.id, configurationRevision: 1, destinationNamespaceIdentity: profile.namespaceIdentity,
      destinationAdapterType: "r2", incarnation, fileId: fileId, purpose: purpose, createFile: false,
      nativePublicationExists: true, publishAsActive: publication.active_location_id === source.locationId,
      locationId: "fp5-location:" + incarnation + ":" + id.slice(3), objectKey: selected.objectKey,
      byteSize: payload.byteSize, sha256: payload.sha256, contentType: "application/octet-stream", filename: payload.id,
      // Canonical native pointers and original aliases are immutable here.
      // bindingEvidence records their exact original tuple and row digest;
      // empty mutable lists deliberately issue no consumer/alias UPDATE.
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


import type { Env } from "../types";
import type { SystemRecoveryStorageMapping } from "../../shared/contracts/system-recovery";
import { resolveR2ProfileBinding } from "../files/r2-profile-bindings";
/** Fixed public V5 plan: full document admission precedes this pure mapping;
 * source bytes come only from that validated ZIP, destination bindings from
 * actual installation metadata. Canonical native consumers and head0 history
 * remain unchanged. No legacy/S3/URL/original LOCAL opening is admitted. */
export async function planV5NativeR2RecoveryFiles(env: Env,records: SystemBackupRecordsV5,manifest: SystemBackupManifestV5,
  mapping: readonly SystemRecoveryStorageMapping[],profiles: readonly RecoveryDestinationProfile[],incarnation: string) {
  ensure(Array.isArray(mapping)&&mapping.length<=100&&new Set(mapping.map(value=>value.sourceProfileId)).size===mapping.length,"mapping_inventory");
  const used=new Set<string>(),owned:V5R2PayloadMappingCandidate[]=[];
  for(const file of manifest.files){
    const sourceProfileId=file.source.storageProfileId;
    ensure(sourceProfileId!==null&&file.path!==null&&file.byteSize!==null&&file.sha256!==null,"complete_native_source");
    const selected=mapping.find(value=>value.sourceProfileId===sourceProfileId),profile=profiles.find(value=>value.id===selected?.destinationProfileId);
    ensure(selected&&profile&&selected.configurationRevision===1&&profile.adapterType==="r2"&&profile.configurationRevision===1
      &&profile.configurationSource==="bootstrap"&&profile.credentialReference===null&&profile.runtime?.state==="read_only"
      &&profile.runtime.activated_at===null&&profile.runtime.retired_at===null,"owned_native_r2_destination");
    const existing=records.content.tables.storage_profiles.find(row=>row.id===profile.id);
    if(existing) ensure(stableJson(existing)===stableJson({id:profile.id,adapter_type:"r2",namespace_identity:profile.namespaceIdentity,
      configuration_source:"bootstrap",credential_reference:null,configuration_revision:1,state:"historical",created_at:profile.createdAt})
      &&stableJson(records.content.tables.storage_profile_runtime.find(row=>row.storage_profile_id===profile.id))===stableJson({storage_profile_id:profile.id,
        state:"read_only",registered_at:profile.createdAt,activated_at:null,retired_at:null}),"destination_history_collision");
    const binding=resolveR2ProfileBinding(env,{id:profile.id,configurationRevision:1,namespaceIdentity:profile.namespaceIdentity});
    const digest=await sha256Hex(stableJson({sourceId:file.id,source:file.source,destinationProfileId:profile.id,namespaceIdentity:profile.namespaceIdentity,incarnation}));
    used.add(sourceProfileId);
    owned.push({sourceId:file.id,sourceProfileId,source:structuredClone(file.source),archivePath:file.path,fileIds:[...file.fileIds],
      byteSize:file.byteSize,sha256:file.sha256,destinationProfileId:profile.id,configurationRevision:1,destinationNamespaceIdentity:profile.namespaceIdentity,
      destinationBindingName:binding.bindingName,objectKey:`fp5-recovery/${incarnation}/${digest}`,bytesPublished:false});
  }
  ensure(used.size===mapping.length,"unused_mapping");
  return planV5NativeFiles(records,manifest,owned,profiles,incarnation,true);
}

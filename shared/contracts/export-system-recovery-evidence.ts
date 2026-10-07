import type { ExportRow, ExportTables, FullExportBlobEntryV21, RelocatedSystemRecoverySource } from "./export";
import { stableJson } from "../domain/content-addressing";
import { buildResearchPackageBlobExportPlan } from "./export-research-packages";

export const RECOVERY_FILE_EVIDENCE_TABLE_NAME = "recovery_file_evidence" as const;
export const RECOVERY_FILE_EVIDENCE_COLUMNS = ["id", "backup_id", "source_image_sha256", "destination_metadata_sha256", "source_locator_json", "source_file_id", "destination_file_id", "location_id", "profile_id", "profile_revision", "namespace_identity", "object_key", "purpose", "byte_size", "sha256", "verification_operation_id", "verified_at", "published_at", "producer_trust", "created_at"] as const;
export const SYSTEM_RECOVERY_EVIDENCE_EXPORT_COLUMNS = {
  recovery_file_evidence: RECOVERY_FILE_EVIDENCE_COLUMNS,
  recovery_file_alias_evidence: ["evidence_id", "table_name", "alias_id", "original_json", "destination_file_id"],
  recovery_file_binding_evidence: ["evidence_id", "consumer_kind", "consumer_id", "consumer_sub_id", "file_slot", "purpose", "source_file_id", "row_sha256", "preview_origin_json"],
} as const;
// Replaced with the exact reviewed 0022 whole-file/native D1 schema pin.
export const SYSTEM_RECOVERY_EVIDENCE_SCHEMA_FINGERPRINT_SHA256 = "81fe9ecaeb50ef90be66455c946bedd7c6a0d5ed41508b223805967da022df16";

function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Full export rejected: invalid system recovery evidence ${reason}`);
}
const text = (value: unknown, max = 256): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const size = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 96 * 1024 * 1024;
const time = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const nullableText = (value: unknown): value is string | null => value === null || text(value);
const purposes = ["research_source", "embedded_content", "derived_preview", "provenance", "job_output"] as const;
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value)
    && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort()), "closed JSON fields");
}
function parsed(value: unknown, maxBytes: number): Record<string, unknown> {
  ensure(typeof value === "string" && new TextEncoder().encode(value).byteLength <= maxBytes, "bounded JSON");
  let result: unknown;
  try { result = JSON.parse(value); } catch { ensure(false, "JSON encoding"); }
  ensure(result && typeof result === "object" && !Array.isArray(result), "JSON object");
  return result as Record<string, unknown>;
}
export interface RecoveryEvidenceBindingSpec { table: string; column: string; keys: Record<string, string>; purpose: string }
/** The same closed thirteen File slots used by the target installer. */
export function recoveryEvidenceBindingSpec(row: ExportRow): RecoveryEvidenceBindingSpec {
  ensure(text(row.consumer_kind) && text(row.consumer_id) && typeof row.consumer_sub_id === "string" && row.consumer_sub_id.length <= 256 && !row.consumer_sub_id.includes("\0"), "binding identity");
  const id = row.consumer_id, sub = row.consumer_sub_id, kind = row.consumer_kind, slot = row.file_slot;
  let result: RecoveryEvidenceBindingSpec | undefined;
  if (kind === "state_representation_asset" && slot === "primary" && text(sub)) result = { table: "state_representation_assets", column: "file_id", keys: { state_hash: id, asset_id: sub }, purpose: "embedded_content" };
  else if (sub === "") {
    if (kind === "run_step_asset" && slot === "primary") result = { table: "run_step_assets", column: "file_id", keys: { id }, purpose: "embedded_content" };
    else if (kind === "metrology_template_reference" && slot === "primary") result = { table: "metrology_template_references", column: "file_id", keys: { id }, purpose: "research_source" };
    else if (kind === "run_step_comment" && slot === "primary") result = { table: "run_step_comments", column: "file_id", keys: { id }, purpose: "embedded_content" };
    else if (kind === "state_verification" && slot === "evidence") result = { table: "state_verifications", column: "evidence_file_id", keys: { id }, purpose: "embedded_content" };
    else if (kind === "comment_submission_item" && slot === "primary" && ["research_source", "embedded_content", "derived_preview"].includes(String(row.purpose))) result = { table: "comment_submission_items", column: "file_id", keys: { id }, purpose: String(row.purpose) };
    else if (kind === "project_content_attachment" && slot === "primary") result = { table: "project_content_attachments", column: "file_id", keys: { project_content_id: id }, purpose: "research_source" };
    else if (kind === "attachment_derivative" && slot === "derived") result = { table: "attachment_derivatives", column: "derived_file_id", keys: { id }, purpose: "derived_preview" };
    else if (kind === "event" && slot === "primary") result = { table: "events", column: "asset_file_id", keys: { id }, purpose: "embedded_content" };
    else if (kind === "event" && slot === "thumbnail") result = { table: "events", column: "thumbnail_file_id", keys: { id }, purpose: "derived_preview" };
    else if (kind === "import" && slot === "workbook") result = { table: "imports", column: "workbook_file_id", keys: { id }, purpose: "provenance" };
    else if (kind === "import" && slot === "manifest") result = { table: "imports", column: "manifest_file_id", keys: { id }, purpose: "provenance" };
    else if (kind === "template_version" && slot === "source") result = { table: "template_versions", column: "source_file_id", keys: { id }, purpose: "provenance" };
  }
  ensure(result && result.purpose === row.purpose, "closed binding purpose");
  return result;
}
const aliasColumns = {
  assets: ["id", "import_id", "r2_key", "original_name", "mime_type", "byte_size", "status", "sha256", "actor_email", "created_at", "file_id", "storage_profile_id", "storage_profile_revision", "object_key"],
  managed_storage_objects: ["id", "provider", "object_key", "original_name", "mime_type", "byte_size", "sha256", "status", "actor_email", "created_at", "orphaned_at", "file_id"],
} as const;
export interface SystemRecoveryEvidenceHistory {
  publishedLocations: Set<string>;
  importedPreviewEvidence(table: string, row: ExportRow, column: string): boolean;
  packageR2AssetEvidence(asset: ExportRow): boolean;
  recoveredAliasEvidence(table: string, row: ExportRow): boolean;
  historicalResultLocation(fileId: unknown, source: unknown, destination: unknown): boolean;
}

/** These are audited recovery-origin claims, never trusted producer evidence,
 * credential bindings, executor grants or permission to replay historical jobs. */
export function validateSystemRecoveryEvidenceHistory(tables: ExportTables): SystemRecoveryEvidenceHistory {
  for (const [name, columns] of Object.entries(SYSTEM_RECOVERY_EVIDENCE_EXPORT_COLUMNS)) {
    ensure(Array.isArray(tables[name]), `${name} inventory`);
    for (const row of tables[name]) exact(row, columns);
  }
  const files = new Map((tables.files ?? []).map(row => [row.id, row]));
  const profiles = new Map((tables.storage_profiles ?? []).map(row => [row.id, row]));
  const locations = new Map((tables.file_locations ?? []).map(row => [row.id, row]));
  const publications = new Map((tables.file_location_publications ?? []).map(row => [row.location_id, row]));
  const evidence = new Map<unknown, ExportRow>(), locators = new Map<unknown, Record<string, unknown>>();
  const publishedLocations = new Set<string>();
  for (const row of tables.recovery_file_evidence) {
    ensure(text(row.id, 128) && !evidence.has(row.id) && text(row.backup_id, 128) && hash(row.source_image_sha256)
      && hash(row.destination_metadata_sha256) && nullableText(row.source_file_id) && text(row.destination_file_id)
      && text(row.location_id) && !publishedLocations.has(row.location_id) && text(row.profile_id) && row.profile_revision === 1
      && text(row.namespace_identity, 2048) && text(row.object_key, 4096) && purposes.includes(row.purpose as typeof purposes[number])
      && size(row.byte_size) && hash(row.sha256) && row.verification_operation_id === `fp5:${row.id}`
      && time(row.verified_at) && time(row.published_at) && Date.parse(row.published_at) >= Date.parse(row.verified_at)
      && time(row.created_at) && row.producer_trust === (row.purpose === "derived_preview" ? "untrusted_import" : "opaque_recovery"), "byte proof identity");
    const profile = profiles.get(row.profile_id), file = files.get(row.destination_file_id), location = locations.get(row.location_id), publication = publications.get(row.location_id);
    ensure(profile && ["r2", "s3"].includes(String(profile.adapter_type)) && profile.namespace_identity === row.namespace_identity && profile.configuration_revision === row.profile_revision
      && file && file.purpose === row.purpose && file.access_scope === "system"
      && (file.expected_byte_size === null || file.expected_byte_size === row.byte_size) && (file.expected_sha256 === null || file.expected_sha256 === row.sha256)
      && (row.source_file_id === null || files.has(row.source_file_id) && row.source_file_id === row.destination_file_id)
      && location && location.file_id === row.destination_file_id && location.storage_profile_id === row.profile_id && location.object_key === row.object_key
      && publication && publication.file_id === row.destination_file_id && publication.storage_profile_id === row.profile_id && publication.object_key === row.object_key
      && publication.verified_byte_size === row.byte_size && publication.verified_sha256 === row.sha256 && publication.verification_method === "full_read_sha256"
      && publication.verification_operation_id === row.verification_operation_id && publication.verified_at === row.verified_at && publication.published_at === row.published_at, "exact readback publication");
    const locator = parsed(row.source_locator_json, 16_384);
    exact(locator, ["sourceId", "locatorId", "storeKind", "provider", "byteAuthority", "storageProfileId", "storageProfileRevision", "locationId", "objectKey", "expectedByteSize", "expectedSha256"]);
    ensure(text(locator.sourceId, 128) && text(locator.locatorId, 8192) && ["r2", "managed", "file"].includes(String(locator.storeKind))
      && ["r2", "switchdrive", "s3"].includes(String(locator.provider)) && ["legacy", "file_location"].includes(String(locator.byteAuthority))
      && text(locator.objectKey, 4096) && nullableText(locator.storageProfileId) && (locator.storageProfileRevision === null || locator.storageProfileRevision === 1)
      && nullableText(locator.locationId) && (locator.expectedByteSize === null || locator.expectedByteSize === row.byte_size)
      && (locator.expectedSha256 === null || locator.expectedSha256 === row.sha256), "source byte address");
    ensure(locator.byteAuthority === "legacy" ? locator.storageProfileId === null && locator.storageProfileRevision === null && locator.locationId === null
      && (locator.storeKind === "r2" && locator.provider === "r2" || locator.storeKind === "managed" && locator.provider === "switchdrive")
      : text(locator.storageProfileId) && locator.storageProfileRevision === 1 && text(locator.locationId)
        && (locator.storeKind === "r2" && locator.provider === "r2" || locator.storeKind === "managed" && locator.provider === "switchdrive" || locator.storeKind === "file" && locator.provider === "s3"), "source namespace kind");
    if (locator.byteAuthority === "file_location") {
      const sourceLocation = locations.get(locator.locationId), sourceProfile = profiles.get(locator.storageProfileId);
      ensure(sourceLocation && sourceProfile && sourceLocation.file_id === row.source_file_id
        && sourceLocation.storage_profile_id === locator.storageProfileId && sourceLocation.object_key === locator.objectKey
        && sourceProfile.configuration_revision === locator.storageProfileRevision && sourceProfile.adapter_type === locator.provider,
      "original native File byte address");
    }
    evidence.set(row.id, row); locators.set(row.id, locator); publishedLocations.add(String(row.location_id));
  }
  const aliases: Array<{ evidence: ExportRow; table: string; original: Record<string, unknown> }> = [], aliasKeys = new Set<string>();
  for (const row of tables.recovery_file_alias_evidence) {
    const proof = evidence.get(row.evidence_id), locator = locators.get(row.evidence_id), key = stableJson([row.evidence_id, row.table_name, row.alias_id]);
    ensure(proof && locator && !aliasKeys.has(key) && (row.table_name === "assets" || row.table_name === "managed_storage_objects")
      && text(row.alias_id) && row.destination_file_id === proof.destination_file_id, "alias proof identity");
    const original = parsed(row.original_json, 24_576); exact(original, aliasColumns[row.table_name]);
    ensure(original.id === row.alias_id && typeof original.original_name === "string" && typeof original.mime_type === "string"
      && original.byte_size === proof.byte_size && (original.sha256 === null || original.sha256 === proof.sha256)
      && nullableText(original.file_id), "original alias metadata");
    ensure(row.table_name === "assets" ? locator.storeKind === "r2" && original.r2_key === locator.objectKey
      || original.file_id === proof.source_file_id && proof.source_file_id !== null
      : locator.storeKind === "managed" && original.provider === locator.provider && original.object_key === locator.objectKey
        || original.file_id === proof.source_file_id && proof.source_file_id !== null, "original alias byte address");
    aliases.push({ evidence: proof, table: row.table_name, original }); aliasKeys.add(key);
  }
  const bindings: Array<{ evidence: ExportRow; spec: RecoveryEvidenceBindingSpec; origin: Record<string, unknown> }> = [], bindingKeys = new Set<string>();
  for (const row of tables.recovery_file_binding_evidence) {
    const proof = evidence.get(row.evidence_id), key = stableJson([row.evidence_id, row.consumer_kind, row.consumer_id, row.consumer_sub_id, row.file_slot]);
    ensure(proof && !bindingKeys.has(key) && proof.purpose === row.purpose && nullableText(row.source_file_id)
      && (row.source_file_id === null || files.has(row.source_file_id)) && hash(row.row_sha256), "binding proof identity");
    const spec = recoveryEvidenceBindingSpec(row), origin = parsed(row.preview_origin_json, 8192);
    if (row.purpose !== "derived_preview") exact(origin, ["kind"]), ensure(origin.kind === "none", "non-preview origin");
    else if (spec.table === "events") {
      exact(origin, ["kind", "parentFileId"]); ensure(origin.kind === "event_thumbnail" && nullableText(origin.parentFileId), "event preview origin");
    } else if (spec.table === "comment_submission_items") {
      exact(origin, ["kind", "relatedItemId", "submissionId", "parentFileId", "originalKind", "originalRelatedItemId"]);
      ensure(origin.kind === "comment_preview" && text(origin.relatedItemId) && text(origin.submissionId) && nullableText(origin.parentFileId)
        && origin.originalKind === "attachment" && nullableText(origin.originalRelatedItemId), "Comment preview origin");
    } else {
      ensure(spec.table === "attachment_derivatives", "closed preview consumer");
      exact(origin, ["kind", "derivativeKind", "generatorVersion", "sourceSha256", "sourceByteSize"]);
      ensure(origin.kind === "attachment_derivative" && origin.derivativeKind === "browser_preview" && text(origin.generatorVersion)
        && hash(origin.sourceSha256) && size(origin.sourceByteSize), "legacy browser preview origin");
    }
    bindings.push({ evidence: proof, spec, origin }); bindingKeys.add(key);
  }
  const recoveredAliasEvidence = (table: string, row: ExportRow) => aliases.some(alias => alias.table === table && alias.original.id === row.id
    && row.file_id === alias.evidence.destination_file_id && Object.entries(alias.original).every(([column, value]) =>
      column === "file_id" || column === "status" || table === "managed_storage_objects" && column === "orphaned_at" || stableJson(row[column]) === stableJson(value)));
  return { publishedLocations, recoveredAliasEvidence,
    packageR2AssetEvidence: asset => profiles.get(asset.storage_profile_id)?.adapter_type === "r2" && recoveredAliasEvidence("assets", asset),
    historicalResultLocation(fileId, source, destination) {
      if (!text(fileId) || !text(source) || !text(destination) || source === destination) return false;
      // Only an immutable native File can retain a historical result address
      // through repeated recoveries. Every hop has the same purpose/hash/size
      // and an exact independently verified publication; legacy IDs never
      // become a bridge to a different logical File.
      const file = files.get(fileId);
      if (!file) return false;
      const possible = [...evidence.values()].filter(proof => proof.source_file_id === fileId
        && proof.destination_file_id === fileId && proof.purpose === file.purpose
        && locators.get(proof.id)?.byteAuthority === "file_location");
      for (const first of possible.filter(proof => locators.get(proof.id)?.locationId === source)) {
        const frontier = [source], visited = new Set<string>();
        while (frontier.length) {
          const address = frontier.pop()!;
          if (visited.has(address)) continue;
          visited.add(address);
          for (const proof of possible) if (locators.get(proof.id)?.locationId === address
            && proof.byte_size === first.byte_size && proof.sha256 === first.sha256) {
            const next = String(proof.location_id);
            if (visited.has(next)) continue;
            if (next === destination) return true;
            frontier.push(next);
          }
        }
      }
      return false;
    },
    importedPreviewEvidence(table, row, column) {
      return bindings.some(binding => binding.spec.table === table && binding.spec.column === column
        && binding.evidence.purpose === "derived_preview" && binding.evidence.producer_trust === "untrusted_import"
        && binding.evidence.destination_file_id === row[column] && Object.entries(binding.spec.keys).every(([key, value]) => row[key] === value)
        && (table === "events" ? row.asset_file_id === binding.origin.parentFileId
          : table === "comment_submission_items" ? row.kind === "comment_image" && row.related_item_id === binding.origin.relatedItemId && row.submission_id === binding.origin.submissionId
            && (tables.comment_submission_items ?? []).some(original => original.id === row.related_item_id && original.kind === "attachment"
              && original.submission_id === row.submission_id && original.file_id === binding.origin.parentFileId && original.related_item_id === binding.origin.originalRelatedItemId)
            : row.derivative_kind === binding.origin.derivativeKind && row.generator_version === binding.origin.generatorVersion
              && row.source_sha256 === binding.origin.sourceSha256 && row.source_byte_size === binding.origin.sourceByteSize));
    },
  };
}

/** V24 starts with the V23 byte inventory. Explicit qualified relocation
 * inventory is added by the V24 writer, never silently discarded here. */
export function buildSystemRecoveryBlobExportPlan(tables: ExportTables, clock?: string, ownedBackupId?: string | null) {
  ensure(ownedBackupId === undefined || ownedBackupId === null || text(ownedBackupId, 128), "backup hold owner");
  const history = validateSystemRecoveryEvidenceHistory(tables), base = buildResearchPackageBlobExportPlan(tables, clock);
  const blobs = new Map(base.blobs.map(source => [source.locatorId, source]));
  const locators = new Map(tables.recovery_file_evidence.map(proof => [proof.id, parsed(proof.source_locator_json, 16_384)]));
  const bindingIdentity = (row: ExportRow) => stableJson([row.consumer_kind, row.consumer_id, row.consumer_sub_id, row.file_slot]);
  const sameAddress = (source: FullExportBlobEntryV21, locator: Record<string, unknown>) =>
    source.locatorId === locator.locatorId && source.storeKind === locator.storeKind && source.provider === locator.provider
    && source.byteAuthority === locator.byteAuthority && source.storageProfileId === locator.storageProfileId
    && source.storageProfileRevision === locator.storageProfileRevision && source.locationId === locator.locationId
    && source.objectKey === locator.objectKey && source.expectedByteSize === locator.expectedByteSize
    && source.expectedSha256 === locator.expectedSha256;
  const candidates = new Map<string, { sources: ExportRow[]; destinations: string[] }>();
  for (const source of base.blobs) {
    const proofs = tables.recovery_file_evidence.filter(proof => sameAddress(source, locators.get(proof.id)!));
    if (!proofs.length) continue;
    if (source.byteAuthority === "file_location" && !proofs.every(proof => (tables.file_locations ?? []).some(location =>
      location.id === source.locationId && location.file_id === proof.source_file_id
      && location.storage_profile_id === source.storageProfileId && location.object_key === source.objectKey))) continue;
    const sourceFiles = new Set(proofs.flatMap(proof => typeof proof.source_file_id === "string" ? [proof.source_file_id] : []));
    for (const mapping of tables.legacy_file_mappings ?? []) if (source.byteAuthority === "legacy"
      && mapping.store_kind === source.storeKind && mapping.provider === source.provider && mapping.object_key === source.objectKey)
      sourceFiles.add(String(mapping.file_id));
    const backupOwners = new Set(proofs.map(proof => `fp5-backup:${proof.backup_id}`));
    if (ownedBackupId) backupOwners.add(`fp5-backup:${ownedBackupId}`);
    const harmlessHold = (hold: ExportRow) => hold.hold_kind === "read"
      || hold.hold_kind === "export" && typeof hold.operation_id === "string" && backupOwners.has(hold.operation_id);
    const held = (tables.file_location_holds ?? []).some(hold => hold.released_at === null && !harmlessHold(hold)
      && (hold.location_id === source.locationId || source.sourceOccurrences.some(edge => edge.occurrenceType === "file_location_hold" && edge.occurrenceId === hold.id)))
      || (tables.file_holds ?? []).some(hold => hold.released_at === null && !harmlessHold(hold)
        && (sourceFiles.has(String(hold.file_id)) || source.sourceOccurrences.some(edge => edge.occurrenceType === "file_hold" && edge.occurrenceId === hold.id)))
      || (tables.file_shadow_legacy_holds ?? []).some(hold => hold.released_at === null
        && hold.store_kind === source.storeKind && hold.provider === source.provider && hold.object_key === source.objectKey)
      || (tables.file_migration_items ?? []).some(item => item.cleanup_released_at === null
        && (source.locationId !== null && (item.source_location_id === source.locationId || item.destination_location_id === source.locationId)
          || source.byteAuthority === "legacy" && sourceFiles.has(String(item.file_id))))
      || (tables.research_package_files ?? []).some(item => item.entry_kind === "source"
        && !["completed", "cancelled"].includes(String((tables.research_package_jobs ?? []).find(job => job.id === item.job_id)?.state))
        && (source.locationId !== null && item.source_location_id === source.locationId
          || source.byteAuthority === "legacy" && sourceFiles.has(String(item.source_file_id))))
      || source.sourceOccurrences.some(edge => ["file_shadow_hold", "candidate_registration"].includes(edge.occurrenceType));
    if (held) continue;
    const bindings = (tables.file_consumer_projection ?? []).filter(row => sourceFiles.has(String(row.file_id))
      || source.byteAuthority === "legacy" && (source.storeKind === "r2" && row.legacy_r2_object_key === source.objectKey
        || source.storeKind === "managed" && row.legacy_managed_provider === source.provider && row.legacy_managed_object_key === source.objectKey));
    if (!bindings.every(binding => proofs.some(proof => proof.destination_file_id === binding.file_id
      && (binding.expected_purpose === null || proof.purpose === binding.expected_purpose)
      && tables.recovery_file_binding_evidence.some(evidence => evidence.evidence_id === proof.id
        && bindingIdentity(evidence) === bindingIdentity(binding) && evidence.purpose === proof.purpose
        && (() => {
          const spec = recoveryEvidenceBindingSpec(evidence);
          return (tables[spec.table] ?? []).some(row =>
            Object.entries(spec.keys).every(([column, expected]) => row[column] === expected) && row[spec.column] === proof.destination_file_id);
        })())))) continue;
    const aliases: Array<{ table: "assets" | "managed_storage_objects"; row: ExportRow }> = source.byteAuthority === "legacy"
      ? source.storeKind === "r2" ? (tables.assets ?? []).filter(row => row.r2_key === source.objectKey).map(row => ({ table: "assets", row }))
        : (tables.managed_storage_objects ?? []).filter(row => row.provider === source.provider && row.object_key === source.objectKey).map(row => ({ table: "managed_storage_objects", row }))
      : [...(tables.assets ?? []).filter(row => sourceFiles.has(String(row.file_id))).map(row => ({ table: "assets" as const, row })),
        ...(tables.managed_storage_objects ?? []).filter(row => sourceFiles.has(String(row.file_id))).map(row => ({ table: "managed_storage_objects" as const, row }))];
    if (!aliases.every(alias => history.recoveredAliasEvidence(alias.table, alias.row)
      && proofs.some(proof => proof.destination_file_id === alias.row.file_id && tables.recovery_file_alias_evidence.some(evidence =>
        evidence.evidence_id === proof.id && evidence.table_name === alias.table && evidence.alias_id === alias.row.id)))) continue;
    // Every claimed destination must still have a complete, available physical
    // byte entry. An old receipt cannot conceal a deleted replacement.
    const destinations = proofs.map(proof => base.blobs.find(entry => entry.locationId === proof.location_id
      && entry.storageProfileId === proof.profile_id && entry.storageProfileRevision === proof.profile_revision
      && entry.objectKey === proof.object_key && entry.initialOutcome === null
      && entry.expectedByteSize === proof.byte_size && entry.expectedSha256 === proof.sha256)?.locatorId);
    if (destinations.some(destination => !destination || destination === source.locatorId)) continue;
    candidates.set(source.locatorId, { sources: proofs, destinations: destinations as string[] });
  }
  // Repeated recoveries can form a chain. Its terminal verified bytes must be
  // packaged; cycles and chains ending at missing metadata retain old sources.
  const reachesPayload = (locator: string, visiting: Set<string>): boolean => {
    if (visiting.has(locator)) return false;
    const candidate = candidates.get(locator);
    if (!candidate) return blobs.get(locator)?.initialOutcome === null;
    const next = new Set(visiting); next.add(locator);
    return candidate.destinations.every(destination => reachesPayload(destination, next));
  };
  const relocatedSources: RelocatedSystemRecoverySource[] = [];
  const relocated = new Set<string>();
  for (const [locator, candidate] of candidates) if (reachesPayload(locator, new Set())) {
    relocated.add(locator);
    for (const proof of candidate.sources) {
      const source = locators.get(proof.id)!;
      relocatedSources.push({ evidenceId: String(proof.id), sourceLocatorId: locator,
        sourceLocationId: source.locationId as string | null, sourceFileId: proof.source_file_id as string | null,
        destinationFileId: String(proof.destination_file_id), destinationLocationId: String(proof.location_id),
        byteSize: Number(proof.byte_size), sha256: String(proof.sha256), reason: "verified_recovery_relocation" });
    }
  }
  relocatedSources.sort((left, right) => stableJson(left) < stableJson(right) ? -1 : stableJson(left) > stableJson(right) ? 1 : 0);
  return { blobs: base.blobs.filter(source => !relocated.has(source.locatorId)), excludedOutputs: base.excludedOutputs, relocatedSources };
}

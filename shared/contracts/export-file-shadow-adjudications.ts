import type { ExportRow, ExportSchemaObject, ExportTables, FileShadowSourceRowids } from "./export";
import { sha256Hex, stableJson } from "../domain/content-addressing";
import { sqliteTableColumns } from "../domain/sqlite-table-columns";
import { fileShadowSchemaFingerprint, validateFileShadowRows } from "./export-file-shadow";
import { validateFileShadowWithdrawalRows } from "./export-file-shadow-withdrawals";
import { checkedShadowAdjudicationRequest, checkedShadowAdjudicationRevocationRequest,
  FILE_SHADOW_ADJUDICATION_EXPORT_COLUMNS, shadowAdjudicationRequestSha256, shadowAdjudicationRevocationRequestSha256,
  type ShadowAdjudicationRequest } from "./file-shadow-adjudication";

// Independent V17 checkpoint. Never broaden the V15 or V16 fingerprints.
export const FILE_SHADOW_ADJUDICATION_SCHEMA_FINGERPRINT_SHA256 = "bcaccdb8d55f93ad615766f2a50aec75f245ac8d65eb10fd02cfd5ad4565dbaa";
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Full export rejected: invalid File shadow adjudication ${reason}`);
}
function parsed(value: unknown, reason: string): Record<string, any> {
  let result: unknown;
  try { result = typeof value === "string" ? JSON.parse(value) : undefined; } catch { /* checked below */ }
  ensure(result && typeof result === "object" && !Array.isArray(result), reason);
  return result as Record<string, any>;
}
function canonical(value: unknown, reason: string) {
  const result = parsed(value, reason); ensure(stableJson(result) === value, `${reason} canonical JSON`); return result;
}
function receipt(row: ExportRow) {
  ensure(typeof row.created_by === "string" && row.created_by.length > 0 && row.created_by.length <= 256 && !row.created_by.includes("\0")
    && typeof row.created_at === "string" && row.created_at.length <= 200 && !row.created_at.includes("\0")
    && Number.isFinite(Date.parse(row.created_at)), "actor/time");
}
const key = (row: ExportRow) => ({ consumerKind: row.consumer_kind, consumerId: row.consumer_id, consumerSubId: row.consumer_sub_id, fileSlot: row.file_slot });
const at = (row: ExportRow) => Date.parse(String(row.created_at));

export async function validateFileShadowAdjudicationExport(tables: ExportTables, schemaObjects: ExportSchemaObject[], sourceRowids?: FileShadowSourceRowids) {
  ensure(await fileShadowSchemaFingerprint(schemaObjects) === FILE_SHADOW_ADJUDICATION_SCHEMA_FINGERPRINT_SHA256, "schema fingerprint");
  await validateFileShadowRows(tables, schemaObjects, sourceRowids);
  await validateFileShadowWithdrawalRows(tables, schemaObjects);
  await validateFileShadowAdjudicationRows(tables, schemaObjects);
}

/** Historical validation uses retained occurrence/dependency evidence, never the
 * current head, current profile state, or the installation's runtime authority. */
export async function validateFileShadowAdjudicationRows(tables: ExportTables, schemaObjects: ExportSchemaObject[], runtime?: { schemaSha256: string; allowActive: boolean; historicalSchemaSha256s?: readonly string[] }) {
  for (const [name, columns] of Object.entries(FILE_SHADOW_ADJUDICATION_EXPORT_COLUMNS)) {
    const schema = schemaObjects.find((entry) => entry.type === "table" && entry.name === name);
    ensure(schema && typeof schema.sql === "string" && stableJson(sqliteTableColumns(schema.sql, name).sort()) === stableJson([...columns].sort()), "schema columns");
    ensure(Array.isArray(tables[name]), "table inventory");
    for (const row of tables[name]) ensure(stableJson(Object.keys(row).sort()) === stableJson([...columns].sort()), "row columns");
  }
  const occurrences = new Map(tables.file_shadow_occurrences.map((row) => [row.id, row]));
  const profiles = new Map(tables.storage_profiles.map((row) => [row.id, row]));
  const operations = new Map(tables.file_shadow_operations.map((row) => [row.id, row]));
  const accepted = new Map<string, { row: ExportRow; request: ShadowAdjudicationRequest }>();
  const epoch = Number(tables.file_shadow_control[0].epoch);
  for (const row of tables.file_shadow_adjudications) {
    receipt(row);
    const request = checkedShadowAdjudicationRequest(canonical(row.request_json, "request"));
    ensure(request.requestId === row.id && request.occurrenceId === row.occurrence_id && request.supersedesId === row.supersedes_id
      && !accepted.has(request.requestId), "request identity");
    ensure(await shadowAdjudicationRequestSha256(request) === row.request_sha256, "request digest");
    const occurrence = occurrences.get(request.occurrenceId), profile = profiles.get(request.sourceProfile.profileId);
    ensure(occurrence && occurrence.present === 1 && occurrence.generation === request.generation
      && stableJson(key(occurrence)) === stableJson(request.key)
      && row.source_json === occurrence.source_json && await sha256Hex(String(row.source_json)) === request.sourceSha256
      && request.sourceLocator.storeKind === occurrence.legacy_store_kind && request.sourceLocator.provider === occurrence.legacy_provider
      && request.sourceLocator.objectKey === occurrence.legacy_object_key
      && Number(occurrence.observed_epoch) <= request.expectedEpoch && request.expectedEpoch < epoch, "retained source identity");
    ensure(profile && profile.adapter_type === request.sourceLocator.provider
      && profile.configuration_revision === request.sourceProfile.configurationRevision, "frozen profile");
    ensure(typeof row.source_expected_byte_size === "number" && Number.isSafeInteger(row.source_expected_byte_size) && row.source_expected_byte_size >= 0 && row.source_expected_byte_size <= 104857600
      && typeof row.source_expected_sha256 === "string" && /^[a-f0-9]{64}$/.test(row.source_expected_sha256), "byte expectations");
    const baseline = canonical(row.baseline_json, "baseline"), { baselineSha256, ...unsigned } = baseline;
    ensure(baselineSha256 === request.expectedBaselineSha256 && await sha256Hex(stableJson(unsigned)) === baselineSha256, "baseline digest");
    ensure(baseline.version === 1 && baseline.kind === "file-shadow-baseline" && baseline.bytesVerified === false
      && [FILE_SHADOW_ADJUDICATION_SCHEMA_FINGERPRINT_SHA256, ...(runtime ? [runtime.schemaSha256, ...(runtime.historicalSchemaSha256s ?? [])] : [])].includes(baseline.schemaSha256)
      && stableJson(baseline.key) === stableJson(request.key) && baseline.epoch === request.expectedEpoch
      && baseline.runtime?.enabled === 0 && baseline.runtime.incarnation === request.expectedIncarnation
      && baseline.adjudication === null && baseline.authority?.mode === "overlap" && baseline.decision === null && baseline.status === "ambiguous"
      && baseline.head?.present === 1 && baseline.head.occurrence_id === request.occurrenceId
      && baseline.head.generation === request.generation && baseline.head.source_sha256 === request.sourceSha256
      && stableJson(key(baseline.head)) === stableJson(request.key)
      && String(baseline.head.source_rowid) === occurrence.source_rowid && baseline.head.observed_epoch === occurrence.observed_epoch
      && stableJson(baseline.sourceLocator) === stableJson(request.sourceLocator), "pre-adjudication baseline identity");
    ensure(baseline.record && stableJson(baseline.record.key) === stableJson(request.key)
      && stableJson(baseline.record.locator) === stableJson(request.sourceLocator)
      && Array.isArray(baseline.record.registries) && baseline.record.registries.length === 1, "baseline source registry");
    ensure(Array.isArray(baseline.reasons) && baseline.reasons.some((reason: unknown) => ["consumer_purpose_unresolved", "namespace_evidence_missing"].includes(String(reason)))
      && baseline.reasons.every((reason: unknown) => ["consumer_purpose_unresolved", "namespace_evidence_missing", "source_profile_unresolved"].includes(String(reason)))
      && (baseline.purpose === null || baseline.purpose === "research_source")
      && Array.isArray(baseline.record.receipts) && baseline.record.receipts.length === 0
      && Array.isArray(baseline.record.mappings) && baseline.record.mappings.length === 0, "pre-adjudication eligibility");
    const registry = baseline.record.registries[0], source = parsed(row.source_json, "source"), token = source._dependencies?.sourceAsset;
    ensure(baseline.record.source && typeof baseline.record.source === "object" && !Array.isArray(baseline.record.source), "baseline source metadata");
    for (const [field, value] of Object.entries(baseline.record.source)) if (Object.hasOwn(source, field)) ensure(stableJson(value) === stableJson(source[field]), "baseline retained source metadata");
    ensure(registry.table === "assets" && registry.id === source.asset_id && registry.r2_key === request.sourceLocator.objectKey
      && registry.status === "ready" && registry.import_id === null && registry.byte_size === row.source_expected_byte_size && registry.sha256 === row.source_expected_sha256
      && token && typeof token === "object", "baseline byte expectations");
    const retained = tables.file_shadow_dependency_versions.find((entry) => entry.dependency_kind === "assets"
      && stableJson(JSON.parse(String(entry.dependency_key))) === stableJson(token.dependency_key) && entry.revision === token.revision && entry.present === 1);
    ensure(retained, "retained registry revision");
    const snapshot = parsed(retained.snapshot_json, "registry snapshot");
    for (const field of ["id", "r2_key", "sha256", "byte_size", "status"]) ensure(snapshot[field] === registry[field], "retained registry metadata");
    accepted.set(request.requestId, { row, request });
  }
  ensure(accepted.size === 0 || (runtime?.allowActive ? ["overlap", "active"] : ["overlap"]).includes(String(tables.file_authority_control[0].mode)), "recorded authority");
  const withdrawals = new Set<string>();
  for (const row of tables.file_shadow_adjudication_withdrawals) {
    receipt(row);
    const request = checkedShadowAdjudicationRequest(canonical(row.request_json, "withdrawal request"));
    ensure(request.requestId === row.request_id && !withdrawals.has(request.requestId) && !accepted.has(request.requestId)
      && await shadowAdjudicationRequestSha256(request) === row.request_sha256, "withdrawal exclusion/identity");
    withdrawals.add(request.requestId);
  }
  const revoked = new Map<string, ExportRow>(), revocationIds = new Set<string>();
  for (const row of tables.file_shadow_adjudication_revocations) {
    receipt(row);
    const request = checkedShadowAdjudicationRevocationRequest(canonical(row.request_json, "revocation request"));
    const target = accepted.get(request.adjudicationId);
    ensure(request.requestId === row.id && request.adjudicationId === row.adjudication_id
      && !revocationIds.has(request.requestId) && !revoked.has(request.adjudicationId)
      && target && target.row.request_sha256 === request.adjudicationRequestSha256
      && await shadowAdjudicationRevocationRequestSha256(request) === row.request_sha256
      && at(row) >= at(target.row), "revocation identity/order");
    revoked.set(request.adjudicationId, row); revocationIds.add(request.requestId);
  }
  const roots = new Set<string>(), successors = new Set<string>(), active = new Set<string>();
  for (const { row, request } of accepted.values()) {
    if (request.supersedesId === null) {
      ensure(!roots.has(request.occurrenceId), "duplicate correction root"); roots.add(request.occurrenceId);
    } else {
      const predecessor = accepted.get(request.supersedesId), revocation = revoked.get(request.supersedesId);
      ensure(predecessor && revocation && !successors.has(request.supersedesId)
        && predecessor.request.occurrenceId === request.occurrenceId && predecessor.request.expectedEpoch < request.expectedEpoch
        && at(row) >= at(revocation), "correction chain");
      successors.add(request.supersedesId);
    }
    if (!revoked.has(request.requestId)) {
      ensure(!active.has(request.occurrenceId), "competing active decisions"); active.add(request.occurrenceId);
    }
  }
  const bindings = new Set<string>();
  for (const row of tables.file_shadow_operation_adjudications) {
    const target = accepted.get(String(row.adjudication_id)), operation = operations.get(row.operation_id);
    ensure(typeof row.operation_id === "string" && !bindings.has(row.operation_id) && target && operation
      && target.row.request_sha256 === row.adjudication_request_sha256 && operation.occurrence_id === target.request.occurrenceId
      && operation.source_store_kind === target.request.sourceLocator.storeKind && operation.source_provider === target.request.sourceLocator.provider
      && operation.source_object_key === target.request.sourceLocator.objectKey && operation.source_profile_id === target.request.sourceProfile.profileId
      && operation.source_profile_revision === target.request.sourceProfile.configurationRevision
      && operation.purpose === target.request.purpose && operation.source_expected_sha256 === target.row.source_expected_sha256
      && operation.source_expected_byte_size === target.row.source_expected_byte_size
      && Number(operation.captured_epoch) > target.request.expectedEpoch && at(operation) >= at(target.row), "immutable operation binding");
    const revocation = revoked.get(String(row.adjudication_id));
    if (revocation) ensure(operation.status === "cancelled" && at(operation) <= at(revocation)
      && tables.file_shadow_attempts.filter((attempt) => attempt.operation_id === operation.id).every((attempt) =>
        ["failed", "cancelled"].includes(String(attempt.state)) && attempt.write_started_at === null && attempt.verified_at === null)
      && !tables.file_shadow_decisions.some((decision) => decision.operation_id === operation.id), "revoked operation recovery state");
    bindings.add(row.operation_id);
  }
  for (const operation of operations.values()) {
    const prior = [...accepted.values()].filter(({ request }) => request.occurrenceId === operation.occurrence_id
      && request.expectedEpoch < Number(operation.captured_epoch));
    if (prior.length && operation.source_profile_id !== null) ensure(bindings.has(String(operation.id)), "missing operation binding");
  }
}

// Inert Native V5 source proof. Standalone V28 Research cannot issue this proof.
import type { ExportRow, ExportTables, FileShadowSourceRowids } from "./export";
import type { SystemRecoveryImageV1 } from "./system-recovery-image";
import { validateSystemRecoveryImage } from "./system-recovery-image";
import { PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256,
  PORTABLE_RUNTIME_RECOVERY_TABLES } from "./portable-runtime-v28-recovery-catalog";
import { SYSTEM_BACKUP_MAX_RECORDS_BYTES } from "./system-backup";
import { projectCompatibilitySnapshot } from "./export-compatibility";
import { isFileShadowRowidColumn } from "./file-shadow-rowid";
import { validateNativeV5CommentAcceptance } from "./export-native-v5-comment-acceptance";
import { validateCommentAcceptanceInput, validateCommentPublicationPlan,
  validateCommentPublicationResult } from "./comment-acceptance";
import { validateLocalCommentAcceptedItemResult } from "./comment-acceptance-local";
import { validateFileJobHistory } from "./export-file-jobs";
import { validateSystemRecoveryEvidenceHistoryV28 } from "./export-system-recovery-evidence-v28";
import { sha256Hex, stableJson } from "../domain/content-addressing";

interface NativeSource { readonly image: SystemRecoveryImageV1; readonly historyJson: string }
const nativeSources = new WeakMap<object, NativeSource>();
export interface NativeV5CommentProvenance { readonly kind: "native-v5-completed-local-comment/1" }
interface QualifiedRows { readonly itemRows: ReadonlySet<string>; readonly candidateRows: ReadonlySet<string>; readonly locationRows: ReadonlySet<string> }
const qualifiedRows = new WeakMap<NativeV5CommentProvenance, QualifiedRows>();
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Native V5 completed local Comment rejected: ${reason}`);
}
const sortedRows = (rows: readonly ExportRow[]) => stableJson(rows.map(stableJson).sort());
function only(rows: readonly ExportRow[], reason: string): ExportRow { ensure(rows.length === 1, reason); return rows[0]; }

/** Copy plain bounded data using descriptors. No getter or mutable caller image
 * remains reachable by the private source record. This records no binding,
 * provider capability, replay permission, or destination execution authority. */
function frozenData(value: unknown): unknown {
  let nodes = 0;
  const copy = (item: unknown, depth: number): unknown => {
    ensure(depth <= 32 && ++nodes <= 2_000_000, "source data bounds");
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number") { ensure(Number.isFinite(item), "source number"); return item; }
    ensure(item && typeof item === "object" && [Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(item)), "source plain data");
    if (Array.isArray(item)) {
      ensure(Reflect.ownKeys(item).length === item.length + 1, "source array inventory");
      return Object.freeze(Array.from({ length: item.length }, (_, index) => {
        const cell = Object.getOwnPropertyDescriptor(item, String(index)); ensure(cell && "value" in cell, "source array data");
        return copy(cell.value, depth + 1);
      }));
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(item)) {
      ensure(typeof key === "string", "source key");
      const field = Object.getOwnPropertyDescriptor(item, key); ensure(field?.enumerable && "value" in field, "source field data");
      result[key] = copy(field.value, depth + 1);
    }
    return Object.freeze(result);
  };
  const captured = copy(value, 0);
  ensure(new TextEncoder().encode(stableJson(captured)).byteLength <= SYSTEM_BACKUP_MAX_RECORDS_BYTES, "source byte budget");
  return captured;
}

/** Called only by the V5 image owner after its original complete image check.
 * Revalidate the copied exact V5 tuple/catalog before retaining any source data.
 * The two-key protected history remains ordinary serialized data; copying it
 * loses this private association and cannot qualify a Comment payload. */
export function bindNativeV5CommentSourceHistory(history: object, imageValue: unknown): void {
  const captured = frozenData(imageValue);
  ensure(captured && typeof captured === "object" && !Array.isArray(captured), "source image");
  const image = captured as Record<string, unknown>;
  ensure(stableJson(Object.keys(image).sort()) === stableJson(["version", "kind", "schemaSha256", "checkpointId", "sourceSnapshotClock", "tables"].sort())
    && image.version === 5 && image.checkpointId === PORTABLE_RUNTIME_CHECKPOINT_ID, "source V5 tuple");
  const { checkpointId: _checkpoint, ...typed } = image;
  const checked = validateSystemRecoveryImage({ ...typed, version: 1 }, { schemaSha256: PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256,
    tables: PORTABLE_RUNTIME_RECOVERY_TABLES, maxMetadataBytes: SYSTEM_BACKUP_MAX_RECORDS_BYTES });
  // Preserve V5's additional protected account admission after the generic
  // typed image validator; the generic historical reader alone is insufficient.
  const accounts = checked.tables.local_accounts;
  const enabled = accounts.columns.indexOf("enabled"), principal = accounts.columns.indexOf("principal_id"), username = accounts.columns.indexOf("username");
  for (const row of accounts.rows) {
    const state = row.cells[enabled], id = row.cells[principal], name = row.cells[username];
    ensure(state.type === "integer" && ["0", "1"].includes(state.value)
      && id.type === "text" && /^local_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id.value)
      && name.type === "text" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name.value), "protected account identity/state");
  }
  const expectedHistory = Object.fromEntries(["local_storage_profile_registrations", "local_storage_profile_activations"].map(name =>
    [name, checked.tables[name].rows.map(row => Object.fromEntries(checked.tables[name].columns.map((column, index) => {
      const cell = row.cells[index];
      ensure(cell.type !== "blob" && (cell.type !== "integer" || Number.isSafeInteger(Number(cell.value))), "protected history scalar fidelity");
      return [column, cell.type === "null" ? null : cell.type === "integer" || cell.type === "real" ? Number(cell.value) : cell.value];
    })))]));
  const historyJson = stableJson(frozenData(expectedHistory));
  ensure(historyJson === stableJson(frozenData(history)), "history belongs to exact source image");
  nativeSources.set(history, Object.freeze({ image: checked, historyJson }));
}

/** Read only an original data descriptor before the runtime input is copied.
 * No accessor is invoked, and no serialized/public marker can issue a source. */
export function nativeV5CommentSourceHistory(input: object): object | undefined {
  const field = Object.getOwnPropertyDescriptor(input, "protectedLocalHistory");
  ensure(field && "value" in field, "protected history data descriptor");
  return field.value && typeof field.value === "object" && nativeSources.has(field.value) ? field.value : undefined;
}

export function nativeV5CommentItemRow(proof: NativeV5CommentProvenance | undefined, row: ExportRow): boolean {
  return Boolean(proof && qualifiedRows.get(proof)?.itemRows.has(stableJson(row)));
}
export function nativeV5CommentCandidateRow(proof: NativeV5CommentProvenance | undefined, row: ExportRow): boolean {
  return Boolean(proof && qualifiedRows.get(proof)?.candidateRows.has(stableJson(row)));
}
export function nativeV5CommentLocationRow(proof: NativeV5CommentProvenance | undefined, row: ExportRow): boolean {
  return Boolean(proof && qualifiedRows.get(proof)?.locationRows.has(stableJson(row)));
}

/** All physical business rows, complete immutable shadow/dependency history,
 * every typed source-rowid binding, protected history and clock must match the
 * same captured V5 image. Original content/image agreement is still required by
 * the V5 owner; this earlier proof permits only the finite completed row set. */
export async function validateNativeV5CompletedCommentProvenance(sourceHistory: object | undefined,
  tables: ExportTables, history: object, snapshotClock: string, sourceRowids: FileShadowSourceRowids): Promise<NativeV5CommentProvenance | undefined> {
  if (!sourceHistory) return undefined;
  const source = nativeSources.get(sourceHistory); ensure(source, "issued source history");
  ensure(source.image.sourceSnapshotClock === snapshotClock && source.historyJson === stableJson(history), "same source clock/history");
  const physical: ExportTables = Object.create(null);
  for (const [name, table] of Object.entries(source.image.tables)) {
    if (!Object.hasOwn(tables, name)) continue;
    physical[name] = table.rows.map(row => Object.fromEntries(table.columns.map((column, index) => {
      const cell = row.cells[index];
      ensure(cell.type !== "blob" && (cell.type !== "integer" || isFileShadowRowidColumn(name, column)
        || Number.isSafeInteger(Number(cell.value))), "business scalar fidelity");
      return [column, cell.type === "null" ? null : cell.type === "integer" && isFileShadowRowidColumn(name, column) ? cell.value
        : cell.type === "integer" || cell.type === "real" ? Number(cell.value) : cell.value];
    })) as ExportRow);
  }
  const projected = projectCompatibilitySnapshot(physical, { compatibilityColumns: {
    samples: source.image.tables.samples.columns, run_step_comments: source.image.tables.run_step_comments.columns,
  } }, "file-authority-v14").tables;
  for (const [name, rows] of Object.entries(projected)) ensure(sortedRows(rows) === sortedRows(tables[name]), `same source business table:${name}`);
  for (const [name, values] of Object.entries(sourceRowids.tables)) {
    const imageTable = source.image.tables[name], rows = projected[name];
    ensure(imageTable && rows && imageTable.rows.length === values.length, "same source rowid inventory");
    const expected = new Map(values.map(row => [row.rowid, row.rowSha256]));
    ensure(expected.size === values.length, "same source unique rowids");
    for (let index = 0; index < rows.length; index++) {
      const rowid = imageTable.rows[index].rowid;
      ensure(rowid !== null && await sha256Hex(stableJson(rows[index])) === expected.get(rowid), "same source rowid binding");
    }
  }
  const localIds = new Set(tables.storage_profiles.filter(row => row.adapter_type === "local").map(row => String(row.id)));
  await validateNativeV5CommentAcceptance(tables, localIds);
  const migrations = validateFileJobHistory(tables), recovery = validateSystemRecoveryEvidenceHistoryV28(tables);
  const historicalResultLocation = (fileId: unknown, source: unknown, destination: unknown) =>
    migrations.historicalResultLocation(fileId, source, destination) || recovery.historicalResultLocation(fileId, source, destination);
  const itemRows = new Set<string>(), candidateRows = new Set<string>(), locationRows = new Set<string>();
  for (const receipt of tables.comment_item_acceptances.filter(row => localIds.has(String(row.storage_profile_id)))) {
    const parent = only(tables.comment_submission_acceptances.filter(row => row.submission_id === receipt.submission_id), "exact parent receipt");
    const input = validateCommentAcceptanceInput(JSON.parse(String(parent.request_input_json)));
    const plan = validateCommentPublicationPlan(JSON.parse(String(parent.publication_plan_json)));
    const parentResult = validateCommentPublicationResult(JSON.parse(String(parent.accepted_result_json)));
    const result = validateLocalCommentAcceptedItemResult(JSON.parse(String(receipt.accepted_result_json)));
    const inputItem = input.items.find(item => item.id === receipt.item_id);
    const item = only(tables.comment_submission_items.filter(row => row.id === receipt.item_id), "exact bound item");
    const submission = only(tables.comment_submissions.filter(row => row.id === receipt.submission_id), "exact canonical submission");
    ensure(inputItem?.kind === "attachment" && !inputItem.relatedCommentImageId && input.context.kind === "run_steps"
      && parentResult.itemIds.includes(String(receipt.item_id)) && item.kind === "attachment" && item.related_item_id === null
      && item.submission_id === receipt.submission_id && item.status === "ready" && item.deleted_at === null && item.storage_object_id === null
      && item.file_id === result.fileId && item.asset_id === result.blobRecordId && item.sha256 === result.sha256 && item.byte_size === result.byteSize
      && item.filename === inputItem.filename && item.mime_type === inputItem.mimeType && item.created_at === receipt.created_at,
    "completed unpaired typed attachment binding");
    ensure(submission.status === "ready" && submission.deleted_at === null && submission.actor_email === parent.actor_email
      && submission.created_at === parent.created_at && submission.completed_at === parent.completed_at && submission.body === input.body
      && submission.context_kind === "run_steps" && submission.sample_id === null && submission.scope === input.context.scope
      && submission.retry_closed_at === parent.completed_at && submission.last_mutation_id === plan.mutationId, "completed canonical parent binding");
    const targets = tables.comment_submission_targets.filter(row => row.submission_id === parent.submission_id);
    ensure(targets.length === input.context.targets.length && input.context.targets.every(target => targets.some(row =>
      row.sample_id === target.sampleId && row.run_id === target.runId && row.run_step_id === target.stepId
      && row.expected_updated_at === target.expectedUpdatedAt)), "immutable accepted target inventory");
    for (const occurrence of plan.occurrences) {
      const target = input.context.targets[occurrence.targetIndex];
      const published = only(tables.run_step_comments.filter(row => row.id === occurrence.id), "exact published occurrence");
      ensure(published.submission_id === parent.submission_id && published.run_step_id === target.stepId
        && published.scope === input.context.scope && published.operation_group_id === plan.operationGroupId
        && published.actor_email === parent.actor_email && published.created_at === parent.completed_at, "published occurrence plan binding");
    }
    for (const event of plan.events) {
      const published = only(tables.events.filter(row => row.id === event.id), "exact published event");
      const metadata: unknown = JSON.parse(String(published.metadata_json));
      ensure(metadata && typeof metadata === "object" && !Array.isArray(metadata)
        && (metadata as Record<string, unknown>).action === "comment_submission"
        && (metadata as Record<string, unknown>).submissionId === parent.submission_id
        && published.sample_id === event.sampleId && published.kind === "comment" && published.actor_email === parent.actor_email
        && published.created_at === parent.completed_at, "published event plan binding");
    }
    const candidate = only(tables.file_acceptance_candidates.filter(row => row.acceptance_kind === "comment_item"
      && row.acceptance_id === receipt.item_id && row.item_id === ""), "exact accepted File candidate");
    ensure(candidate.state === "ready" && candidate.purpose === "research_source" && candidate.access_scope === "system"
      && candidate.storage_profile_id === receipt.storage_profile_id && candidate.expected_sha256 === result.sha256
      && candidate.expected_byte_size === result.byteSize && candidate.candidate_object_key === receipt.candidate_object_key
      && candidate.result_file_id === result.fileId, "completed File candidate binding");
    const file = only(tables.files.filter(row => row.id === result.fileId), "exact result File");
    const location = only(tables.file_locations.filter(row => row.id === candidate.result_location_id), "exact result location");
    const publication = only(tables.file_location_publications.filter(row => row.location_id === location.id), "exact result location publication");
    const filePublication = only(tables.file_publications.filter(row => row.file_id === file.id), "exact result File publication");
    const alias = only(tables.assets.filter(row => row.id === result.blobRecordId), "exact neutral alias");
    ensure(file.purpose === "research_source" && file.access_scope === "system" && file.expected_sha256 === result.sha256
      && file.expected_byte_size === result.byteSize && location.file_id === file.id && location.storage_profile_id === result.storageProfileId
      && location.object_key === result.objectKey && publication.file_id === file.id && publication.storage_profile_id === result.storageProfileId
      && publication.object_key === result.objectKey && publication.verification_method === "full_read_sha256"
      && publication.verified_sha256 === result.sha256 && publication.verified_byte_size === result.byteSize
      && filePublication.state === "ready" && (filePublication.active_location_id === location.id
        || historicalResultLocation(file.id, location.id, filePublication.active_location_id))
      && filePublication.purpose === "research_source" && filePublication.access_scope === "system"
      && filePublication.verified_sha256 === result.sha256 && filePublication.verified_byte_size === result.byteSize,
    "verified current result File/location binding");
    ensure(alias.status === "ready" && alias.r2_key === null && alias.import_id === null && alias.file_id === file.id
      && alias.storage_profile_id === result.storageProfileId && alias.storage_profile_revision === result.storageProfileRevision
      && alias.object_key === result.objectKey && alias.sha256 === result.sha256 && alias.byte_size === result.byteSize, "neutral accepted alias binding");
    const candidateLocation = only(tables.file_locations.filter(row => row.id === candidate.candidate_location_id), "exact original candidate location");
    const candidatePublication = only(tables.file_location_publications.filter(row => row.location_id === candidateLocation.id), "exact original candidate publication");
    ensure(candidateLocation.file_id === candidate.candidate_file_id && candidateLocation.storage_profile_id === receipt.storage_profile_id
      && candidateLocation.object_key === receipt.candidate_object_key && candidatePublication.file_id === candidate.candidate_file_id
      && candidatePublication.storage_profile_id === receipt.storage_profile_id && candidatePublication.object_key === receipt.candidate_object_key
      && candidatePublication.verification_operation_id === parent.operation_id && candidatePublication.verification_method === "full_read_sha256"
      && candidatePublication.verified_sha256 === result.sha256 && candidatePublication.verified_byte_size === result.byteSize,
    "original accepted candidate publication");
    const consumer = only(tables.file_consumer_projection.filter(row => row.consumer_kind === "comment_submission_item"
      && row.consumer_id === item.id && row.consumer_sub_id === "" && row.file_slot === "primary"), "exact typed consumer");
    ensure(consumer.file_id === file.id && consumer.expected_purpose === "research_source" && consumer.resolution_state === "resolved", "typed consumer File binding");
    const head = only(tables.file_shadow_heads.filter(row => row.consumer_kind === consumer.consumer_kind
      && row.consumer_id === consumer.consumer_id && row.consumer_sub_id === "" && row.file_slot === "primary"), "exact current physical head");
    const occurrence = only(tables.file_shadow_occurrences.filter(row => row.id === head.occurrence_id), "exact current owned occurrence");
    const itemIndex = tables.comment_submission_items.indexOf(item);
    ensure(head.present === 1 && head.source_rowid === sourceRowids.tables.comment_submission_items[itemIndex]?.rowid
      && head.generation === occurrence.generation && occurrence.present === 1 && occurrence.source_rowid === head.source_rowid
      && occurrence.consumer_kind === consumer.consumer_kind && occurrence.consumer_id === item.id
      && occurrence.consumer_sub_id === "" && occurrence.file_slot === "primary" && occurrence.expected_purpose === "research_source"
      && occurrence.source_json === head.source_json && occurrence.observed_epoch === head.observed_epoch
      && !tables.file_shadow_closures.some(row => row.occurrence_id === occurrence.id), "owned present physical Comment head");
    itemRows.add(stableJson(receipt)); candidateRows.add(stableJson(candidate));
    locationRows.add(stableJson(candidateLocation)); locationRows.add(stableJson(location));
  }
  const proof = Object.freeze({ kind: "native-v5-completed-local-comment/1" as const });
  qualifiedRows.set(proof, Object.freeze({ itemRows, candidateRows, locationRows }));
  return proof;
}

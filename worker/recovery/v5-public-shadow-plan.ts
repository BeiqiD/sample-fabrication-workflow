// Code-owned, pre-trigger history for the original public V5 dispatcher.
// This record restricts an actual job; it supplies no actor or SQL authority.
import type { ExportRow } from "../../shared/contracts/export";
import { recoveryCellBinding, type SystemRecoveryRow, type SystemRecoveryTable } from "../../shared/contracts/system-recovery-image";
import { stableJson, sha256Hex } from "../../shared/domain/content-addressing";
import { validateSystemBackupDocumentsV5, type SystemBackupRecordsV5, type SystemBackupManifestV5 } from "../../shared/contracts/system-backup-v5";
import type { RecoveryDestinationProfile, RecoveryPlannedFile } from "./target-files";
import { V5_RECOVERY_CATALOG_CANDIDATE as catalog } from "./v5-catalog-candidate";
import { planV5ShadowProfileHistoryCandidate, type V5ShadowProfileHistoryCandidate } from "./v5-shadow-profile-history-candidate";

const encoder = new TextEncoder(), MAX_BYTES = 384 * 1024, CHUNK_BYTES = 48 * 1024;
const FAMILY = "#v5-public-shadow-plan/1", SCHEMA = "worker-v5-public-shadow-plan/1";
const supported = new Set(["run_step_asset", "run_step_comment", "comment_submission_item", "event"]);
function ensure(value: unknown, reason: string): asserts value {
  if (!value) throw new Error("v5_public_shadow_plan_" + reason);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(child => freeze(child)); Object.freeze(value);
  }
  return value;
}
function chunks(text: string): string[] {
  const result: string[] = []; let current = "", bytes = 0;
  for (const character of text) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > CHUNK_BYTES) { result.push(current); current = ""; bytes = 0; }
    current += character; bytes += size;
  }
  if (current) result.push(current);
  ensure(result.length > 0 && result.length <= 9, "chunk_budget"); return result;
}
function column(table: string, name: string): number {
  const spec = catalog.tables.find(spec => spec.name === table), index = spec?.columns.indexOf(name);
  ensure(index !== undefined && index >= 0, "catalog_column"); return index;
}
function text(row: SystemRecoveryRow, table: string, name: string): string {
  const cell = row.cells[column(table, name)]; ensure(cell?.type === "text", "text_cell"); return cell.value;
}
export function hasV5PublicPresentHeads(tables: Record<string, SystemRecoveryTable>): boolean {
  const table = tables.file_shadow_heads; ensure(table, "heads_table");
  const present = table.columns.indexOf("present"); ensure(present >= 0, "present_column");
  return table.rows.some(row => row.cells[present]?.type === "integer" && row.cells[present].value === "1");
}
export function assertV5PublicHeadInventory(tables: Record<string, SystemRecoveryTable>): void {
  const heads = tables.file_shadow_heads, present = column("file_shadow_heads", "present");
  ensure(heads && heads.rows.every(row => row.cells[present]?.type === "integer"
    && ["0", "1"].includes(row.cells[present].value)), "present_cell");
  const actual = heads.rows.filter(row => row.cells[present].type === "integer" && row.cells[present].value === "1");
  ensure(actual.length <= 16 && actual.every(row => supported.has(text(row, "file_shadow_heads", "consumer_kind"))
    && text(row, "file_shadow_heads", "file_slot") === "primary"), "bounded_run_step_comment_inventory");
}
export interface V5PublicShadowPlan { readonly kind: "worker-v5-public-shadow-plan/1"; readonly sha256: string }
interface Input {
  jobId: string; expectedTargetId: string; incarnation: string;
  records: SystemBackupRecordsV5; manifest: SystemBackupManifestV5;
  mapping: readonly unknown[]; profiles: readonly RecoveryDestinationProfile[]; files: readonly RecoveryPlannedFile[];
  /** Actual original job accepted_at during execution; snapshot clock for read-only preview. */
  clock: string;
}
interface Original {
  jobId: string; targetId: string; incarnation: string; sourceImageSha256: string;
  history: V5ShadowProfileHistoryCandidate; text: string; chunks: readonly string[];
  profilesText: string; profilesChunks: readonly string[]; profilesSha256: string; clock: string;
  finalHeads: readonly SystemRecoveryRow[]; finalEpoch: number; finalProfileRevision: number;
  occurrenceCount: number; closureCount: number;
}
const originals = new WeakMap<V5PublicShadowPlan, Original>(), inputs = new WeakMap<object, V5PublicShadowPlan>();

/** Deterministic IDs make a restart validate the original persisted plan,
 * instead of accepting mutable target observations or minting new history. */
async function ownedHistory(input: Input, sourceImageSha256: string): Promise<V5ShadowProfileHistoryCandidate> {
  const destinations = input.profiles.filter(profile => !input.records.content.tables.storage_profiles.some(row => row.id === profile.id))
    .map(profile => ({
      profile: { id: profile.id, adapter_type: "r2", namespace_identity: profile.namespaceIdentity,
        configuration_source: "bootstrap", credential_reference: null, configuration_revision: 1, state: "historical",
        created_at: profile.createdAt } as ExportRow,
      runtime: { storage_profile_id: profile.id, state: "read_only", registered_at: profile.createdAt,
        activated_at: null, retired_at: null } as ExportRow,
    }));
  const history = planV5ShadowProfileHistoryCandidate(input.records.image.tables, destinations, input.clock, {
    extraRows: input.files.reduce((sum, file) => sum + 12 + file.originalAliases.length + file.bindingEvidence.length, destinations.length),
    extraBytes: encoder.encode(stableJson(input.files)).byteLength * 4 + input.files.length * 8192,
  });
  ensure(history, "present_history_required");
  const replacements = new Map<string, string>(), occupied = new Set(input.records.image.tables.file_shadow_occurrences.rows
    .map(row => text(row, "file_shadow_occurrences", "id")));
  for (let eventIndex = 0; eventIndex < history.events.length; eventIndex++) {
    for (const occurrence of history.events[eventIndex].occurrences) {
      const id = "shadow:" + await sha256Hex(stableJson({ schema: "worker-v5-public-shadow-occurrence/1", jobId: input.jobId,
        targetId: input.expectedTargetId, incarnation: input.incarnation, sourceImageSha256, eventIndex,
        tuple: ["consumer_kind", "consumer_id", "consumer_sub_id", "file_slot"].map(name => text(occurrence, "file_shadow_occurrences", name)),
        generation: occurrence.cells[column("file_shadow_occurrences", "generation")] }));
      ensure(!occupied.has(id), "deterministic_occurrence_collision"); occupied.add(id);
      replacements.set(text(occurrence, "file_shadow_occurrences", "id"), id);
    }
  }
  const row = (table: string, value: SystemRecoveryRow): SystemRecoveryRow => {
    const names = table === "file_shadow_occurrences" ? ["id"] : table === "file_shadow_heads" ? ["occurrence_id"]
      : table === "file_shadow_closures" ? ["occurrence_id", "successor_occurrence_id"] : [];
    const copy = structuredClone(value);
    for (const name of names) {
      const index = column(table, name), cell = copy.cells[index];
      if (cell.type === "text" && replacements.has(cell.value)) copy.cells[index] = { type: "text", value: replacements.get(cell.value)! };
    }
    return copy;
  };
  const result = {
    events: history.events.map(event => ({ ...event, beforeHeads: event.beforeHeads.map(value => row("file_shadow_heads", value)),
      afterHeads: event.afterHeads.map(value => row("file_shadow_heads", value)),
      occurrences: event.occurrences.map(value => row("file_shadow_occurrences", value)),
      closures: event.closures.map(value => row("file_shadow_closures", value)) })),
    typedAppends: Object.fromEntries(Object.entries(history.typedAppends).map(([table, values]) => [table, values.map(value => row(table, value))])),
    changes: history.changes.map(change => change.column === "occurrence_id" && change.cell.type === "text"
      ? { ...change, cell: { type: "text" as const, value: replacements.get(change.cell.value) ?? change.cell.value } } : change),
  };
  ensure(result.events.every(event => encoder.encode(stableJson(event)).byteLength <= 48 * 1024), "remapped_event_wire_budget");
  return freeze(result);
}
export async function createV5PublicShadowPlan(input: Input): Promise<V5PublicShadowPlan | undefined> {
  assertV5PublicHeadInventory(input.records.image.tables);
  if (!hasV5PublicPresentHeads(input.records.image.tables)) return undefined;
  ensure(/^[A-Za-z0-9_:.-]{1,256}$/.test(input.jobId) && /^[A-Za-z0-9_:.-]{1,256}$/.test(input.expectedTargetId)
    && /^[a-f0-9]{32}$/.test(input.incarnation) && Number.isFinite(Date.parse(input.clock)), "original_identity");
  await validateSystemBackupDocumentsV5(input.manifest, input.records);
  const sourceImageSha256 = await sha256Hex(stableJson(input.records.image)), history = await ownedHistory(input, sourceImageSha256);
  const profilesText = stableJson(input.profiles), profilesSha256 = await sha256Hex(profilesText);
  const envelope = { schema: SCHEMA, jobId: input.jobId, targetId: input.expectedTargetId, incarnation: input.incarnation,
    sourceImageSha256, schemaSha256: input.records.image.schemaSha256, sourceCheckpoint: input.manifest.sourceCheckpoint,
    recordsSha256: await sha256Hex(stableJson(input.records)), manifestSha256: await sha256Hex(stableJson(input.manifest)),
    mapping: input.mapping, profiles: input.profiles, files: input.files, clock: input.clock, history };
  const value = stableJson(envelope); ensure(encoder.encode(value).byteLength <= MAX_BYTES, "frozen_plan_budget");
  const plan = Object.freeze({ kind: SCHEMA, sha256: await sha256Hex(value) });
  const last = history.events[history.events.length - 1], control = input.records.image.tables.file_shadow_control;
  const epoch = control.rows[0]?.cells[column("file_shadow_control", "epoch")];
  ensure(epoch?.type === "integer" && Number.isSafeInteger(Number(epoch.value)), "original_control_epoch");
  const finalHeads = last?.afterHeads ?? input.records.image.tables.file_shadow_heads.rows.filter(row => {
    const present = row.cells[column("file_shadow_heads", "present")];
    return present.type === "integer" && present.value === "1";
  });
  const originalProfileRevision = input.records.image.tables.file_shadow_dependency_versions.rows.filter(row =>
    ["storage_profiles", "storage_profile_runtime"].includes(text(row, "file_shadow_dependency_versions", "dependency_kind"))).length;
  originals.set(plan, { jobId: input.jobId, targetId: input.expectedTargetId, incarnation: input.incarnation, sourceImageSha256,
    history, text: value, chunks: freeze(chunks(value)), profilesText, profilesChunks: freeze(chunks(profilesText)), profilesSha256, clock: input.clock,
    finalHeads: freeze(structuredClone(finalHeads)), finalEpoch: last?.afterEpoch ?? Number(epoch.value),
    finalProfileRevision: originalProfileRevision + history.events.length,
    occurrenceCount: input.records.image.tables.file_shadow_occurrences.rows.length + (history.typedAppends.file_shadow_occurrences?.length ?? 0),
    closureCount: input.records.image.tables.file_shadow_closures.rows.length + (history.typedAppends.file_shadow_closures?.length ?? 0) });
  return plan;
}
function original(plan: V5PublicShadowPlan): Original {
  const value = originals.get(plan); ensure(value, "unissued_plan"); return value;
}
export function bindV5PublicShadowPlan(input: { jobId: string; expectedTargetId: string; incarnation: string }, plan: V5PublicShadowPlan): void {
  const value = original(plan), prior = inputs.get(input);
  ensure(!prior || prior.sha256 === plan.sha256, "input_plan_changed");
  ensure(value.jobId === input.jobId && value.targetId === input.expectedTargetId && value.incarnation === input.incarnation,
    "original_job_target_binding"); inputs.set(input, plan);
}
export function v5PublicShadowHistory(plan: V5PublicShadowPlan, jobId: string, imageSha256: string): V5ShadowProfileHistoryCandidate {
  const value = original(plan); ensure(value.jobId === jobId && value.sourceImageSha256 === imageSha256, "verification_lineage"); return value.history;
}
/** No regeneration after even the first native claim. The full exact frozen
 * bytes, their ordinal inventory and cursor pin must already be present. */
export async function assertV5PublicShadowPlanPersisted(db: D1Database, plan: V5PublicShadowPlan): Promise<void> {
  const value = original(plan), result = await db.prepare("SELECT ordinal,image_sha256,chunk FROM system_recovery_target_provenance WHERE job_id=? ORDER BY ordinal")
    .bind(value.jobId + FAMILY).all<{ ordinal: number; image_sha256: string; chunk: string }>();
  ensure(result.success && result.results.length === value.chunks.length && result.results.every((row, index) =>
    row.ordinal === index && row.image_sha256 === plan.sha256 && row.chunk === value.chunks[index])
    && result.results.map(row => row.chunk).join("") === value.text, "frozen_provenance_changed_or_missing");
}
export function v5PublicShadowPlanInitialStatements(db: D1Database, plan: V5PublicShadowPlan): D1PreparedStatement[] {
  const value = original(plan), createdAt = value.clock;
  return [{ key: value.jobId + FAMILY, sha256: plan.sha256, chunks: value.chunks },
    { key: value.jobId + "#destination-plan", sha256: value.profilesSha256, chunks: value.profilesChunks }]
    .flatMap(family => family.chunks.map((chunk, ordinal) => db.prepare(`INSERT INTO system_recovery_target_provenance(job_id,ordinal,image_sha256,chunk,created_at)
      VALUES(?,?,?,?,?)`).bind(family.key, ordinal, family.sha256, chunk, createdAt)));
}
/** Appended to the original target claim predicate. Every native issuer
 * repeats the same full plan bytes, not just an observed hash/count. */
export function v5PublicShadowPlanNativeRestriction(input: object): { sql: string; bindings: unknown[] } {
  const plan = inputs.get(input); if (!plan) return { sql: "", bindings: [] };
  const value = original(plan), bindings: unknown[] = [plan.sha256, value.jobId + FAMILY, value.chunks.length];
  const rows = value.chunks.map((chunk, ordinal) => {
    bindings.push(value.jobId + FAMILY, ordinal, plan.sha256, chunk);
    return "EXISTS(SELECT 1 FROM system_recovery_target_provenance p WHERE p.job_id=? AND p.ordinal=? AND p.image_sha256=? AND p.chunk=?)";
  });
  ensure(bindings.length <= 39, "native_binding_budget");
  return { sql: ` AND json_valid(cursor_json) AND json_extract(cursor_json,'$.shadowPlanSha256')=?
    AND (SELECT count(*) FROM system_recovery_target_provenance WHERE job_id=?)=? AND ${rows.join(" AND ")}`, bindings };
}
export function v5PublicShadowProfileRowidGuard(db: D1Database): D1PreparedStatement {
  return db.prepare(`SELECT CASE WHEN (SELECT COALESCE(MAX(rowid),0) FROM storage_profiles)<9223372036854775807
    AND NOT EXISTS(SELECT 1 FROM file_registry_rowid_claims WHERE registry_name='storage_profiles'
      AND claimed_rowid=(SELECT COALESCE(MAX(rowid),0)+1 FROM storage_profiles))
    THEN 1 ELSE json('V5 public frozen profile rowid would be reused') END`);
}
/** Validate the completed frozen event cursor and exact final current tuples
 * before any payload issue, including the unchanged zero-event headed plan. */
export function v5PublicShadowFinalStateStatements(db: D1Database, plan: V5PublicShadowPlan): D1PreparedStatement[] {
  const value = original(plan), quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const row = (table: string, expected: SystemRecoveryRow) => {
    const spec = catalog.tables.find(spec => spec.name === table); ensure(spec, "final_table");
    const cells = expected.cells.map(recoveryCellBinding);
    return db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM ${quote(table)} WHERE ${spec.columns.map((name, index) =>
      `${quote(name)} IS ${cells[index].expression}`).join(" AND ")}) THEN 1 ELSE json('V5 public frozen event result changed') END`)
      .bind(...cells.map(cell => cell.value));
  };
  const statements = [db.prepare(`SELECT CASE WHEN
    (SELECT json_extract(cursor_json,'$.profileEventIndex') FROM system_recovery_target_claim WHERE singleton=1)=?
    AND (SELECT epoch FROM file_shadow_control WHERE singleton=1)=?
    AND (SELECT count(*) FROM file_shadow_dependency_versions WHERE dependency_kind IN('storage_profiles','storage_profile_runtime'))=?
    AND (SELECT count(*) FROM file_shadow_heads WHERE present=1)=?
    AND (SELECT count(*) FROM file_shadow_occurrences)=? AND (SELECT count(*) FROM file_shadow_closures)=?
    THEN 1 ELSE json('V5 public frozen event inventory changed') END`)
    .bind(value.history.events.length, value.finalEpoch, value.finalProfileRevision, value.finalHeads.length,
      value.occurrenceCount, value.closureCount), ...value.finalHeads.map(expected => row("file_shadow_heads", expected)),
    ...value.history.events.flatMap(event => [row(event.metadataTable, event.metadata), row("file_shadow_dependency_versions", event.dependency)])];
  ensure(statements.length + 2 <= 128, "final_native_statement_budget"); return statements;
}

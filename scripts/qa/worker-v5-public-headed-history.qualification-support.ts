import { expect } from "vitest";
import { createHash } from "node:crypto";
import { pairJson, type GenuineR2Pair } from "../../server/recovery/current-v26-r2-node-pair.qualification-support";
import { checkedSystemRecoveryJobStatus, type SystemRecoveryJobStatus } from "../../shared/contracts/system-recovery";
import type { SystemBackupRecordsV5, SystemBackupManifestV5 } from "../../shared/contracts/system-backup-v5";
import type { SystemRecoveryCell, SystemRecoveryRow, RecoveryTableSpec } from "../../shared/contracts/system-recovery-image";
import { PORTABLE_RUNTIME_RECOVERY_TABLES as tables } from "../../shared/contracts/portable-runtime-v28-recovery-catalog";
import { stableJson } from "../../shared/domain/content-addressing";
import { FILE_SHADOW_DEPENDENCY_SPECS } from "../../shared/contracts/file-shadow-schema";

type Port = Pick<GenuineR2Pair, "readRows" | "schedule" | "request">;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function ensure(value: unknown, reason: string): asserts value { if (!value) throw new Error("worker_v5_public_headed_" + reason); }
function object(value: unknown): Record<string, unknown> {
  ensure(value && typeof value === "object" && !Array.isArray(value), "object"); return value as Record<string, unknown>;
}
function spec(table: string) { const value = tables.find(value => value.name === table); ensure(value, "table"); return value; }
function cell(value: unknown): SystemRecoveryCell {
  const row = object(value);
  if (row.type === "null") { expect(Object.keys(row)).toEqual(["type"]); return { type: "null" }; }
  ensure(["integer", "real", "text", "blob"].includes(String(row.type)) && typeof row.value === "string", "typed_cell");
  expect(Object.keys(row).sort()).toEqual(["type", "value"]);
  if (row.type === "integer") return { type: "integer", value: row.value };
  if (row.type === "real") return { type: "real", value: row.value };
  if (row.type === "blob") return { type: "blob", value: row.value };
  return { type: "text", value: row.value };
}
function rows(value: unknown, table: string): SystemRecoveryRow[] {
  ensure(Array.isArray(value), "typed_rows");
  return value.map(item => {
    const row = object(item); expect(Object.keys(row).sort()).toEqual(["cells", "rowid"]);
    ensure(row.rowid === null && Array.isArray(row.cells) && row.cells.length === spec(table).columns.length, "typed_shape");
    return { rowid: null, cells: row.cells.map(cell) };
  });
}
function value(row: SystemRecoveryRow, table: string, name: string): string | null {
  const found = row.cells[spec(table).columns.indexOf(name)]; ensure(found, "column"); return found.type === "null" ? null : found.value;
}
function integer(row: SystemRecoveryRow, table: string, name: string): number {
  const found = row.cells[spec(table).columns.indexOf(name)];
  ensure(found?.type === "integer" && Number.isSafeInteger(Number(found.value)), "integer"); return Number(found.value);
}
export interface FrozenPublicHeadHistory {
  raw: string; sha256: string; sourceArchiveSha256: string; jobId: string; targetId: string; incarnation: string;
  changes: Array<{ table: string; keys: Record<string, string>; column: string; cell: SystemRecoveryCell }>;
  typedAppends: Record<string, SystemRecoveryRow[]>; originalScheduledCalls: number;
  generationBefore: number; generationAfter: number; epochBefore: number; epochAfter: number;
  profileRevisionBefore: number; profileRevisionAfter: number;
}
/** Observe the ORIGINAL pre-write plan after real public dispatch and before
 * any application rows/provider writes. Independently check its event lineage
 * against the strict original archive; this is an oracle, never a grant. */
export async function captureOriginalPublicHeadPlan(pair: Port, target: Port & { id: string }, initial: SystemRecoveryJobStatus,
  records: SystemBackupRecordsV5, manifest: SystemBackupManifestV5, sourceArchiveSha256: string,
  expectedKind: "run_step_asset" | "comment_submission_item"): Promise<{ job: SystemRecoveryJobStatus; history: FrozenPublicHeadHistory }> {
  const originalHeads = records.image.tables.file_shadow_heads.rows.filter(row => integer(row, "file_shadow_heads", "present") === 1);
  expect(originalHeads).toHaveLength(1); const head = originalHeads[0];
  expect(value(head, "file_shadow_heads", "consumer_kind")).toBe(expectedKind);
  expect(value(head, "file_shadow_heads", "file_slot")).toBe("primary");
  let job = initial, originalScheduledCalls = 0, provenance: Array<Record<string, unknown>> = [];
  for (; originalScheduledCalls < 3; originalScheduledCalls++) {
    await pair.schedule();
    const answer = await pair.request("/api/system-recovery/jobs/" + job.id);
    expect(answer.response.status).toBe(200); job = checkedSystemRecoveryJobStatus(pairJson(answer.value));
    expect(job.state, "Original claim before application writes; " + job.reason).toBe("queued");
    const present = await target.readRows("SELECT name FROM sqlite_schema WHERE type='table' AND name='system_recovery_target_provenance'");
    if (present.length) {
      provenance = await target.readRows("SELECT ordinal,image_sha256,chunk FROM system_recovery_target_provenance WHERE job_id=? ORDER BY ordinal", [job.id + "#v5-public-shadow-plan/1"]);
      if (provenance.length) { originalScheduledCalls++; break; }
    }
  }
  ensure(provenance.length > 0 && provenance.length <= 9, "original_prewrite_plan");
  const raw = provenance.map((row, index) => { expect(row.ordinal).toBe(index); ensure(typeof row.chunk === "string", "chunk"); return row.chunk; }).join("");
  const sha256 = hash(raw); expect(provenance.every(row => row.image_sha256 === sha256)).toBe(true);
  const frozen = object(JSON.parse(raw));
  const originalJobs = await pair.readRows("SELECT actor,accepted_at,target_incarnation,input_json FROM system_recovery_jobs WHERE id=?", [job.id]);
  expect(originalJobs).toHaveLength(1); const original = originalJobs[0];
  expect(frozen).toMatchObject({ schema: "worker-v5-public-shadow-plan/1", jobId: job.id, targetId: target.id,
    incarnation: original.target_incarnation, sourceImageSha256: hash(stableJson(records.image)), schemaSha256: records.image.schemaSha256,
    sourceCheckpoint: manifest.sourceCheckpoint, recordsSha256: hash(stableJson(records)), manifestSha256: hash(stableJson(manifest)), clock: original.accepted_at });
  ensure(typeof original.input_json === "string" && typeof original.accepted_at === "string" && typeof original.target_incarnation === "string", "actual_original_job");
  expect(frozen.mapping).toEqual(object(JSON.parse(original.input_json)).mapping);
  ensure(Array.isArray(frozen.profiles) && frozen.profiles.length === 1, "one_original_destination_profile");
  const destination = object(frozen.profiles[0]);
  ensure(typeof destination.id === "string" && typeof destination.createdAt === "string" && typeof destination.namespaceIdentity === "string", "original_destination_identity");
  expect(destination).toMatchObject({ adapterType: "r2", configurationRevision: 1, configurationSource: "bootstrap", credentialReference: null,
    runtime: { state: "read_only", registered_at: destination.createdAt, activated_at: null, retired_at: null } });
  const actualProfiles = await pair.readRows("SELECT * FROM storage_profiles WHERE id=?", [destination.id]);
  expect(actualProfiles).toHaveLength(1);
  expect(actualProfiles[0]).toMatchObject({ adapter_type: "r2", configuration_revision: 1, configuration_source: "bootstrap",
    credential_reference: null, namespace_identity: destination.namespaceIdentity, created_at: destination.createdAt });
  const expectedMetadata: Record<string, Record<string, string | number | null>> = {
    storage_profiles: { id: destination.id, adapter_type: "r2", namespace_identity: destination.namespaceIdentity,
      configuration_source: "bootstrap", credential_reference: null, configuration_revision: 1, state: "historical", created_at: destination.createdAt },
    storage_profile_runtime: { storage_profile_id: destination.id, state: "read_only", registered_at: destination.createdAt, activated_at: null, retired_at: null },
  };
  ensure(Array.isArray(frozen.files) && frozen.files.length === 1, "one_original_payload");
  expect(frozen.files[0]).toMatchObject({ sourceId: manifest.files[0].id, archivePath: manifest.files[0].path,
    destinationProfileId: destination.id, destinationNamespaceIdentity: destination.namespaceIdentity,
    fileId: manifest.files[0].fileIds[0], purpose: manifest.files[0].purposes[0],
    byteSize: manifest.files[0].byteSize, sha256: manifest.files[0].sha256, createFile: false, nativePublicationExists: true });
  const created = await target.readRows("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name");
  for (const table of tables.filter(table => !table.local && created.some(row => row.name === table.name)))
    expect(await target.readRows('SELECT count(*) n FROM "' + table.name + '"'), "Plan precedes original application rows " + table.name).toEqual([{ n: 0 }]);
  const claims = await target.readRows("SELECT cursor_json FROM system_recovery_target_claim WHERE singleton=1");
  expect(claims).toHaveLength(1); ensure(typeof claims[0].cursor_json === "string", "actual_cursor");
  expect(object(JSON.parse(claims[0].cursor_json))).toMatchObject({ shadowPlanSha256: sha256, profileEventIndex: 0, fileIndex: 0 });
  const history = object(frozen.history); ensure(Array.isArray(history.events), "events"); expect(history.events).toHaveLength(2);
  const immutable = records.image.tables.file_shadow_occurrences.rows.find(row => value(row, "file_shadow_occurrences", "id") === value(head, "file_shadow_heads", "occurrence_id"));
  ensure(immutable, "original_occurrence");
  let beforeHead = head, beforeOccurrence = immutable;
  const epochBefore = integer(records.image.tables.file_shadow_control.rows[0], "file_shadow_control", "epoch");
  const profileRevisionBefore = records.image.tables.file_shadow_dependency_versions.rows.filter(row =>
    ["storage_profiles", "storage_profile_runtime"].includes(String(value(row, "file_shadow_dependency_versions", "dependency_kind")))).length;
  const allAppends: Record<string, SystemRecoveryRow[]> = { file_shadow_dependency_versions: [], file_shadow_occurrences: [], file_shadow_closures: [] };
  for (let index = 0; index < 2; index++) {
    const event = object(history.events[index]);
    const metadataTable = index === 0 ? "storage_profiles" : "storage_profile_runtime";
    expect(event.metadataTable).toBe(metadataTable); expect(event.destinationProfileId).toBe(destination.id);
    const metadata = rows([event.metadata], metadataTable)[0];
    expect(metadata.cells).toEqual(spec(metadataTable).columns.map(column => {
      const value = expectedMetadata[metadataTable][column];
      return value === null ? { type: "null" } : typeof value === "number"
        ? { type: "integer", value: String(value) } : { type: "text", value };
    }));
    expect(event).toMatchObject({ beforeEpoch: epochBefore + index, afterEpoch: epochBefore + index + 1,
      beforeProfileRevision: profileRevisionBefore + index, afterProfileRevision: profileRevisionBefore + index + 1 });
    expect(rows(event.beforeHeads, "file_shadow_heads")).toEqual([beforeHead]);
    const nextHeads = rows(event.afterHeads, "file_shadow_heads"), nextOccurrences = rows(event.occurrences, "file_shadow_occurrences"), closures = rows(event.closures, "file_shadow_closures");
    expect(nextHeads).toHaveLength(1); expect(nextOccurrences).toHaveLength(1); expect(closures).toHaveLength(1);
    const nextHead = nextHeads[0], nextOccurrence = nextOccurrences[0], closure = closures[0];
    const generation = integer(beforeHead, "file_shadow_heads", "generation") + 1;
    const id = "shadow:" + hash(stableJson({ schema: "worker-v5-public-shadow-occurrence/1", jobId: job.id,
      targetId: target.id, incarnation: original.target_incarnation, sourceImageSha256: hash(stableJson(records.image)), eventIndex: index,
      tuple: ["consumer_kind", "consumer_id", "consumer_sub_id", "file_slot"].map(name => value(beforeHead, "file_shadow_heads", name)),
      generation: { type: "integer", value: String(generation) } }));
    expect(value(nextHead, "file_shadow_heads", "occurrence_id")).toBe(id);
    expect(value(nextOccurrence, "file_shadow_occurrences", "id")).toBe(id);
    expect(integer(nextHead, "file_shadow_heads", "generation")).toBe(generation);
    expect(integer(nextOccurrence, "file_shadow_occurrences", "generation")).toBe(generation);
    const source = value(beforeHead, "file_shadow_heads", "source_json"), afterSource = value(nextHead, "file_shadow_heads", "source_json");
    ensure(source !== null && afterSource !== null, "source_json");
    const originalJson = object(JSON.parse(source)), afterJson = object(JSON.parse(afterSource));
    const dependency = object(originalJson._dependencies);
    expect(afterJson).toEqual({ ...originalJson, _dependencies: { ...dependency, profileRevision: profileRevisionBefore + index + 1 } });
    expect(value(nextOccurrence, "file_shadow_occurrences", "source_json")).toBe(afterSource);
    for (let column = 0; column < spec("file_shadow_occurrences").columns.length; column++) {
      const name = spec("file_shadow_occurrences").columns[column];
      if (["id", "generation", "source_json", "observed_epoch", "observed_at"].includes(name)) continue;
      expect(nextOccurrence.cells[column], "Exact immutable successor source field " + name).toEqual(beforeOccurrence.cells[column]);
    }
    expect(integer(nextHead, "file_shadow_heads", "observed_epoch")).toBe(epochBefore + index + 1);
    expect(integer(nextOccurrence, "file_shadow_occurrences", "observed_epoch")).toBe(epochBefore + index + 1);
    expect(value(nextOccurrence, "file_shadow_occurrences", "observed_at")).toBe(original.accepted_at);
    expect(closure.cells).toEqual([{ type: "text", value: value(beforeHead, "file_shadow_heads", "occurrence_id") },
      { type: "text", value: id }, { type: "integer", value: String(epochBefore + index + 1) }, { type: "text", value: original.accepted_at }]);
    const dependencies = rows([event.dependency], "file_shadow_dependency_versions");
    expect(value(dependencies[0], "file_shadow_dependency_versions", "dependency_kind")).toBe(event.metadataTable);
    expect(integer(dependencies[0], "file_shadow_dependency_versions", "revision")).toBe(1);
    expect(integer(dependencies[0], "file_shadow_dependency_versions", "present")).toBe(1);
    const dependencySpec = FILE_SHADOW_DEPENDENCY_SPECS[metadataTable];
    expect(value(dependencies[0], "file_shadow_dependency_versions", "dependency_key")).toBe(JSON.stringify([destination.id]));
    expect(value(dependencies[0], "file_shadow_dependency_versions", "snapshot_json")).toBe(JSON.stringify(Object.fromEntries(
      dependencySpec.snapshotColumns.map(column => [column, expectedMetadata[metadataTable][column]]))));
    allAppends.file_shadow_dependency_versions.push(...dependencies); allAppends.file_shadow_occurrences.push(...nextOccurrences); allAppends.file_shadow_closures.push(...closures);
    beforeHead = nextHead; beforeOccurrence = nextOccurrence;
  }
  const typedAppends = object(history.typedAppends);
  expect(Object.keys(typedAppends).sort()).toEqual(Object.keys(allAppends).sort());
  for (const [table, expected] of Object.entries(allAppends)) expect(rows(typedAppends[table], table)).toEqual(expected);
  ensure(Array.isArray(history.changes), "changes");
  const changes = history.changes.map(item => {
    const change = object(item), keys = object(change.keys);
    ensure(typeof change.table === "string" && typeof change.column === "string" && ["file_shadow_control", "file_shadow_heads"].includes(change.table)
      && Object.values(keys).every(value => typeof value === "string"), "change_shape");
    return { table: change.table, column: change.column, keys: Object.fromEntries(Object.entries(keys).map(([key, value]) => [key, String(value)])), cell: cell(change.cell) };
  });
  expect(changes).toHaveLength(5);
  const expectedChanges = [{ table: "file_shadow_control", keys: { singleton: "1" }, column: "epoch", cell: { type: "integer", value: String(epochBefore + 2) } },
    ...["generation", "occurrence_id", "source_json", "observed_epoch"].map(column => ({ table: "file_shadow_heads", column,
      keys: Object.fromEntries(["consumer_kind", "consumer_id", "consumer_sub_id", "file_slot"].map(name => [name, value(head, "file_shadow_heads", name)])),
      cell: beforeHead.cells[spec("file_shadow_heads").columns.indexOf(column)] }))];
  expect(changes).toEqual(expectedChanges);
  return { job, history: { raw, sha256, sourceArchiveSha256, jobId: job.id, targetId: target.id, incarnation: original.target_incarnation,
    changes, typedAppends: allAppends, originalScheduledCalls, generationBefore: integer(head, "file_shadow_heads", "generation"),
    generationAfter: integer(beforeHead, "file_shadow_heads", "generation"), epochBefore, epochAfter: epochBefore + 2,
    profileRevisionBefore, profileRevisionAfter: profileRevisionBefore + 2 } };
}
export function frozenPublicHeadCellChange(history: FrozenPublicHeadHistory, table: string, original: SystemRecoveryRow,
  descriptor: RecoveryTableSpec, column: number, after: SystemRecoveryCell): boolean {
  const allowed = history.changes.filter(change => change.table === table && change.column === descriptor.columns[column]
    && Object.entries(change.keys).every(([name, value]) => {
      const cell = original.cells[descriptor.columns.indexOf(name)]; return cell?.type !== "null" && cell?.value === value;
    }));
  return allowed.length === 1 && stableJson(allowed[0].cell) === stableJson(after);
}

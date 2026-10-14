import { originalNodeV28TargetSourceGuard } from "./node-system-recovery-v28-application.ts";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { stableJson } from "../../shared/domain/content-addressing.ts";
import { openStoreArchiveEntry, type ArchiveSource, type ArchiveIndexEntry } from "../../shared/domain/research-archive.ts";
import { type SystemBackupManifestV5, type SystemBackupRecordsV5, protectedLocalHistoryFromV5Image } from "../../shared/contracts/system-backup-v5.ts";
import { validateLocalFileRuntimeV28 } from "../../shared/contracts/export-local-file-runtime-v28.ts";
import { type SystemRecoveryImportInput, type SystemRecoveryPublicReport, checkedSystemRecoveryImportInput } from "../../shared/contracts/system-recovery.ts";
import { recoveryCellBinding, type RecoveryTableSpec, type SystemRecoveryRow, type SystemRecoveryTable } from "../../shared/contracts/system-recovery-image.ts";
import { PORTABLE_RUNTIME_SCHEMA_STATEMENTS as schema, PORTABLE_RUNTIME_RECOVERY_TABLES as tables, PORTABLE_RUNTIME_SEED_TABLE_ROWS as seeds, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256 } from "../../worker/recovery/portable-runtime-v28-trusted-schema.ts";
import type { JobSqlDatabase, JobSqlStatement } from "../../worker/files/jobs/sql-repository.ts";
import type { RecoveryClaim, RecoveryJob, jobSqlSystemRecoveryRepository } from "../../worker/recovery/sql-repository.ts";
import type { RecoveryStepResult } from "../../worker/recovery/kernel.ts";
import { nodeSha256 } from "../storage/node-sha256.ts";
import { constructEmptyV28RecoveryTargetCandidate } from "./empty-target-v28-candidate.ts";
import { verifyInertLocalVolumeDestinationV28, LocalVolumeDestinationCleanupError, type PackagedLocalVolumePayloadV28 } from "./local-volume-byte-destination-v28.ts";
import { nodeV28TargetReadTable, nodeV28TargetEqual, nodeV28TargetImageTable, verifyNodeV28InertTarget, assertNodeV28TargetSeeds } from "./node-v28-target-verification.ts";
import type { NodeV28RecoveryTarget, NodeV28TargetIntent } from "./node-v28-recovery-target.ts";

const MAX_GROUP_BYTES = 83 * 1024, MAX_STAGE_BYTES = 256 * 1024, MAX_STAGE_STATEMENTS = 96;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const sha = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
function ensure(value: unknown, reason = "target_unavailable"): asserts value { if (!value) throw new Error(reason); }
type Repository = ReturnType<typeof jobSqlSystemRecoveryRepository>;
type DatabaseIdentity = Awaited<ReturnType<NodeV28RecoveryTarget["databaseIdentity"]>>;
interface Cursor {
  version: 1; actor: string; pending: boolean; stage: "claim" | "schema" | "rows" | "files" | "reinstall" | "verify" | "ready";
  cleared: boolean; clearIndex: number; group: number; file: number; database: DatabaseIdentity | null;
  installationId: string | null; construction: ReturnType<typeof constructEmptyV28RecoveryTargetCandidate>["construction"] | null;
  report: SystemRecoveryPublicReport | null; targetCheckpoint: string | null;
}
interface ClaimRow { target_id: string; job_id: string; incarnation: string; challenge: string; schema_sha256: string;
  image_sha256: string; status: string; cursor_json: string }
interface FileRow { logical_id: string; state: "pending" | "write_started" | "unknown" | "verified" | "published";
  byte_size: number; sha256: string; owner_token: string | null; generation: number | null; namespace: string }
interface Documents { records: SystemBackupRecordsV5; manifest: SystemBackupManifestV5 }
interface RowGroup { spec: RecoveryTableSpec; rows: SystemRecoveryRow[]; prefix: SystemRecoveryRow[]; bytes: number }
function groups(records: SystemBackupRecordsV5): RowGroup[] {
  const result: RowGroup[] = [];
  for (const spec of tables.filter(value => !value.local)) {
    const rows = nodeV28TargetImageTable(records, spec.name).rows; let group: SystemRecoveryRow[] = [], prefix: SystemRecoveryRow[] = [], bytes = 2;
    for (const row of rows) {
      const length = Buffer.byteLength(stableJson(row)) + 1; ensure(length <= MAX_GROUP_BYTES, "archive_budget");
      if (group.length && (bytes + length > MAX_GROUP_BYTES || group.length === MAX_STAGE_STATEMENTS)) { result.push({ spec, rows: group, prefix, bytes }); prefix = [...prefix, ...group]; group = []; bytes = 2; }
      group.push(row); bytes += length;
    }
    if (group.length) result.push({ spec, rows: group, prefix, bytes });
  }
  return result;
}
function insert(native: DatabaseSync, spec: RecoveryTableSpec, row: SystemRecoveryRow): void {
  const columns = [...spec.columns], cells = row.cells.map(recoveryCellBinding);
  if (!spec.withoutRowid) { columns.unshift("rowid"); cells.unshift({ expression: "CAST(? AS INTEGER)", value: row.rowid }); }
  native.prepare(`INSERT INTO ${quote(spec.name)} (${columns.map(quote).join(",")}) VALUES (${cells.map(cell => cell.expression).join(",")})`)
    .run(...cells.map(cell => cell.value));
}
function atomic(native: DatabaseSync, guard: () => void, work: () => void): void {
  guard(); native.exec("PRAGMA foreign_keys=OFF"); let failed = false, failure: unknown;
  try { guard(); native.exec("BEGIN IMMEDIATE"); try { work(); guard(); native.exec("COMMIT"); }
    catch (error) { failed = true; failure = error; if (native.isTransaction) { try { native.exec("ROLLBACK"); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Original target transaction and rollback failed"); } } throw error; } }
  finally { try { native.exec("PRAGMA foreign_keys=ON"); } catch (cleanup) { throw failed ? new AggregateError([failure, cleanup]) : cleanup; } }
}
function cleanupUnproven(error: unknown): boolean {
  return error instanceof LocalVolumeDestinationCleanupError || error instanceof AggregateError && error.errors.some(cleanupUnproven);
}

/** V5-only Node target stages behind the unchanged shared claim/deadline kernel.
 * Source-local intent/cursors survive loss of either target or source ACK. Every
 * retry proves exact owned positive target evidence before advancing; existing
 * unknown paths are never overwritten or erased. Restored authority tables stay
 * empty because these execution ledgers belong only to the source installation.
 */
export function createNodeV28TargetStages(options: {
  target: NodeV28RecoveryTarget; repository: Repository; assertSource(): void; quarantine(error: unknown): void;
  guard(claim: RecoveryClaim, signal: AbortSignal, deadline: number): void;
  originalIntentGuard(claim: RecoveryClaim, db: JobSqlDatabase): JobSqlStatement;
  documents(upload: RecoveryJob): Promise<Documents>;
  withArchive<T>(claim: RecoveryClaim, current: () => Promise<boolean>, signal: AbortSignal,
    operation: (source: ArchiveSource, index: readonly ArchiveIndexEntry[]) => Promise<T>): Promise<T>;
}) {
  const { target, repository } = options, pending = new Set<Promise<unknown>>();
  const owner = { closed: false, failed: false, failure: undefined as unknown, closing: undefined as Promise<void> | undefined };
  const originalGuard = originalNodeV28TargetSourceGuard(options.assertSource, options.guard, target, repository);
  function lifetime(): void { if (owner.closed || owner.failed) throw owner.failed ? owner.failure : new Error("target_unavailable"); }
  function base(): void { lifetime(); options.assertSource(); }
  function track<T>(work: () => Promise<T>): Promise<T> { base(); if (pending.size) throw new Error("write_outcome_unknown"); const original = Promise.resolve().then(work); pending.add(original);
    void original.then(() => pending.delete(original), error => { pending.delete(original); if (cleanupUnproven(error)) {
      owner.failed = true; owner.failure = error; options.quarantine(error); } }); return original; }
  function assertJob(job: RecoveryJob): SystemRecoveryImportInput {
    base(); const accepted = checkedSystemRecoveryImportInput(JSON.parse(job.input_json));
    const checkpoint = JSON.parse(job.checkpoint_json ?? "null") as { targetNamespace?: unknown } | null;
    ensure(job.kind === "recovery" && job.target_id === target.identity.targetId && accepted.expectedTargetId === target.identity.targetId
      && accepted.mapping.length === 0 && job.source_upload_job_id === accepted.uploadJobId
      && stableJson(checkpoint?.targetNamespace) === stableJson(target.identity), "artifact_namespace_changed");
    return accepted;
  }
  async function upload(job: RecoveryJob): Promise<RecoveryJob> {
    assertJob(job); const value = await repository.job(job.source_upload_job_id!); base();
    ensure(value && value.kind === "upload" && value.state === "preview" && value.actor === job.actor && value.artifact_key
      && value.archive_sha256 && value.archive_byte_size, "archive_invalid"); return value;
  }
  async function accepted(job: RecoveryJob): Promise<Documents> {
    const input = assertJob(job), source = await upload(job), value = await options.documents(source); base();
    ensure(value.manifest.completeness === "complete" && value.manifest.sourceCheckpoint === job.source_checkpoint, "archive_invalid");
    if (input.mode === "planned") {
      const sourceJob = await repository.job(value.records.backupId);
      const window = await repository.db().prepare("SELECT state,backup_job_id,checkpoint_sha256,(SELECT count(*) FROM system_recovery_write_leases WHERE released_at IS NULL) writers FROM system_recovery_maintenance WHERE singleton=1")
        .first<{ state: string; backup_job_id: string | null; checkpoint_sha256: string | null; writers: number }>();
      ensure(sourceJob?.kind === "backup" && sourceJob.state === "completed" && sourceJob.source_checkpoint === value.manifest.sourceCheckpoint
        && window?.state === "fenced" && window.writers === 0 && window.backup_job_id === sourceJob.id
        && window.checkpoint_sha256 === value.manifest.sourceCheckpoint, "source_checkpoint_changed");
    }
    return value;
  }
  const intent = (job: RecoveryJob, source: RecoveryJob): NodeV28TargetIntent => ({ jobId: job.id,
    archiveSha256: source.archive_sha256!, imageSha256: job.source_checkpoint! });
  const challenge = (job: RecoveryJob, source: RecoveryJob) => sha({ target: target.identity, jobId: job.id,
    actor: job.actor, uploadJobId: source.id, archiveSha256: source.archive_sha256, sourceCheckpoint: job.source_checkpoint });
  async function cursor(job: RecoveryJob, source: RecoveryJob): Promise<Cursor | null> {
    const row = await repository.db().prepare("SELECT target_id,job_id,incarnation,challenge,schema_sha256,image_sha256,status,cursor_json FROM system_recovery_target_claim WHERE singleton=1")
      .first<ClaimRow>(); if (!row) return null;
    ensure(row.target_id === target.identity.targetId && row.job_id === job.id && row.incarnation === target.identity.rootBindingId
      && row.challenge === challenge(job, source) && row.schema_sha256 === PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256
      && row.image_sha256 === job.source_checkpoint, "target_not_fresh");
    const value = JSON.parse(row.cursor_json) as Cursor;
    ensure(value && typeof value === "object" && !Array.isArray(value)
      && stableJson(Object.keys(value).sort()) === stableJson(["version", "actor", "pending", "stage", "cleared", "clearIndex", "group", "file", "database", "installationId", "construction", "report", "targetCheckpoint"].sort())
      && value.version === 1 && value.actor === job.actor && typeof value.pending === "boolean" && ["claim", "schema", "rows", "files", "reinstall", "verify", "ready"].includes(value.stage)
      && Number.isSafeInteger(value.group) && value.group >= 0 && Number.isSafeInteger(value.file) && value.file >= 0
      && typeof value.cleared === "boolean" && Number.isSafeInteger(value.clearIndex) && value.clearIndex >= 0, "target_unavailable"); return value;
  }
  async function save(claim: RecoveryClaim, source: RecoveryJob, value: Cursor, status: string): Promise<void> {
    const db = repository.db(); await db.batch([repository.guard(claim, db),
      db.prepare(`UPDATE system_recovery_target_claim SET status=?,cursor_json=?,owner_token=?,generation=?,runtime_incarnation=?,lease_expires_at=?
        WHERE singleton=1 AND target_id=? AND job_id=? AND challenge=?`)
        .bind(status, stableJson(value), claim.owner_token, claim.generation, claim.runtime_incarnation, claim.lease_expires_at,
          target.identity.targetId, claim.id, challenge(claim, source))]);
  }
  async function files(jobId: string): Promise<FileRow[]> {
    return (await repository.db().prepare("SELECT logical_id,state,byte_size,sha256,owner_token,generation,namespace FROM system_recovery_target_files WHERE job_id=? ORDER BY logical_id")
      .bind(jobId).all<FileRow>()).results;
  }
  function queued(value: Cursor, manifest: SystemBackupManifestV5): RecoveryStepResult<JobSqlStatement> {
    return { patch: { state: "queued", phase: value.stage === "claim" ? "schema" : value.stage,
      target_incarnation: target.identity.rootBindingId, total_files: manifest.files.length,
      completed_files: Math.min(value.file, manifest.files.length), bytes_done: manifest.files.slice(0, value.file).reduce((n, file) => n + (file.byteSize ?? 0), 0) },
      outcome: value.stage === "claim" ? "target_claimed" : `target_${value.stage}` };
  }
  function step(claim: RecoveryClaim, current: () => Promise<boolean>, signal: AbortSignal): Promise<RecoveryStepResult<JobSqlStatement>> {
    return track(async () => {
      const deadline = Math.min(Date.now() + 60000, Date.parse(claim.lease_expires_at) - 5000);
      const guard = () => {
        if (originalGuard) { lifetime(); originalGuard(claim, signal, deadline); }
        else { base(); options.guard(claim, signal, deadline); }
      };
      guard(); const source = await upload(claim), docs = await accepted(claim); guard();
      const selectedIntent = intent(claim, source); let value = await cursor(claim, source); guard();
      if (!value) {
        ensure(claim.phase === "claim" && await target.fresh(), "target_not_fresh"); guard();
        value = { version: 1, actor: claim.actor, pending: false, stage: "claim", cleared: false, clearIndex: 0, group: 0, file: 0, database: null,
          installationId: null, construction: null, report: null, targetCheckpoint: null };
        const db = repository.db(); await db.batch([repository.guard(claim, db),
          db.prepare(`INSERT INTO system_recovery_target_claim(singleton,target_id,job_id,incarnation,challenge,schema_sha256,image_sha256,status,cursor_json,owner_token,generation,runtime_incarnation,lease_expires_at)
            VALUES(1,?,?,?,?,?,?,'claimed',?,?,?,?,?)`).bind(target.identity.targetId, claim.id, target.identity.rootBindingId,
              challenge(claim, source), docs.records.image.schemaSha256, claim.source_checkpoint, stableJson(value),
              claim.owner_token, claim.generation, claim.runtime_incarnation, claim.lease_expires_at)]);
      }
      // Register the current original stage before any target path/Native I/O.
      // Loss of either ACK leaves this intent held even after cancel/release.
      value.pending = true; await save(claim, source, value, value.stage === "claim" ? "claimed" : value.stage === "schema" ? "installing" : value.stage === "rows" ? "loading" : value.stage === "files" ? "files" : "verifying");
      if (value.stage === "claim") {
        guard(); await target.create(selectedIntent, guard);
        guard(); value.database = await target.databaseIdentity(selectedIntent); value.stage = "schema";
        value.pending = false; await save(claim, source, value, "installing"); return queued(value, docs.manifest);
      }
      ensure(value.database && Object.keys(value.database).length === 5
        && [value.database.dev, value.database.ino, value.database.uid, value.database.gid, value.database.mode]
          .every(part => typeof part === "string" && /^[0-9]+$/.test(part)), "write_outcome_unknown");
      if (value.stage === "schema") {
        const construction = await target.withNative(selectedIntent, guard, opened => {
          const objects = opened.native.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'").all(); guard();
          if (!objects.length) return constructEmptyV28RecoveryTargetCandidate(opened.native, { assertCurrent: guard });
          // A constructor COMMIT may have lost its source cursor ACK. Reconcile
          // only the exact reviewed, healthy all-seed Native checkpoint.
          assertNodeV28TargetSeeds(opened.native, guard);
          const installed = verifyNodeV28SeedIdentity(opened.native, guard);
          return { installation: installed, construction: { kind: "reviewed-empty-recovery-checkpoint-construction/v28" as const,
            constructionProvenance: "reviewed-final-schema" as const, rawMigrationExecution: false as const,
            nativeLedgerMeaning: "implemented-reviewed-checkpoint-lineage" as const, destinationInstallationId: installed.installationId,
            checkpointId: installed.checkpointId, schemaSha256: installed.schemaSha256,
            reviewedLineage: V28_NODE_INSTALLATION_CATALOG_CANDIDATE.migrations.map((migration, index) => ({ ordinal: index + 1, name: migration.name,
              rawSha256: migration.rawSha256, checkpointId: migration.checkpoint.id, schemaSha256: migration.checkpoint.schemaSha256 })) } };
        }, value.database);
        guard(); value.installationId = construction.installation.installationId; value.construction = construction.construction;
        await target.writeDocument(selectedIntent, "metadata/destination-checkpoint-construction.json", construction.construction, guard);
        value.stage = "rows"; value.pending = false; await save(claim, source, value, "loading"); return queued(value, docs.manifest);
      }
      if (value.stage === "rows") {
        if (!value.cleared) {
          const clearing = [
            ...["trigger", "view", "index"].flatMap(type => schema.filter(object => object.type === type)
              .map(object => ({ kind: "drop" as const, type, name: object.name }))),
            ...tables.filter(spec => !spec.local).map(spec => ({ kind: "clear" as const, spec, name: spec.name })),
          ];
          ensure(value.clearIndex <= clearing.length && value.group === 0 && value.file === 0, "target_unavailable");
          const end = Math.min(clearing.length, value.clearIndex + MAX_STAGE_STATEMENTS);
          await target.withNative(selectedIntent, guard, ({ native }) => atomic(native, guard, () => {
            for (const operation of clearing.slice(value!.clearIndex, end)) {
              guard();
              if (operation.kind === "drop") {
                if (native.prepare("SELECT 1 FROM sqlite_schema WHERE type=? AND name=?").get(operation.type, operation.name))
                  native.exec(`DROP ${operation.type.toUpperCase()} ${quote(operation.name)}`);
              } else {
                const observed = nodeV28TargetReadTable(native, operation.spec);
                // No historical row has been inserted before every clear ACK.
                // Reconcile empty tables or the fixed constructor's exact seed.
                ensure(observed.rows.length === 0 || nodeV28TargetEqual(observed, targetSeed(operation.spec.name)), "write_outcome_unknown");
                if (observed.rows.length) native.exec(`DELETE FROM ${quote(operation.name)}`);
              }
            }
          }), value.database);
          guard(); value.clearIndex = end; value.cleared = end === clearing.length;
          value.pending = false; await save(claim, source, value, "loading"); return queued(value, docs.manifest);
        }
        const plan = groups(docs.records), start = value.group;
        ensure(start <= plan.length && value.file === 0, "target_unavailable");
        let end = start, bytes = 0, count = 0;
        while (end < plan.length && bytes + plan[end]!.bytes <= MAX_STAGE_BYTES
          && count + plan[end]!.rows.length <= MAX_STAGE_STATEMENTS) { bytes += plan[end]!.bytes; count += plan[end]!.rows.length; end++; }
        ensure(end > start || start === plan.length, "archive_budget");
        await target.withNative(selectedIntent, guard, ({ native }) => {
          const selected = plan.slice(start, end), expected = new Map<string, { spec: RecoveryTableSpec; before: SystemRecoveryTable; after: SystemRecoveryTable }>();
          for (const group of selected) {
            const prior = expected.get(group.spec.name);
            if (prior) prior.after.rows.push(...group.rows);
            else expected.set(group.spec.name, { spec: group.spec, before: { columns: [...group.spec.columns], rows: [...group.prefix] },
              after: { columns: [...group.spec.columns], rows: [...group.prefix, ...group.rows] } });
          }
          let allBefore = true, allAfter = true;
          for (const pair of expected.values()) { guard(); const observed = nodeV28TargetReadTable(native, pair.spec);
            allBefore &&= nodeV28TargetEqual(observed, pair.before); allAfter &&= nodeV28TargetEqual(observed, pair.after); }
          // The entire bounded row group shares one actual Native transaction.
          // A lost source cursor ACK therefore has all-before or all-after proof.
          ensure(allBefore || allAfter, "write_outcome_unknown");
          if (!allAfter) atomic(native, guard, () => { for (const group of selected) for (const row of group.rows) {
            guard(); insert(native, group.spec, row); } });
        }, value.database);
        guard(); value.group = end; if (end === plan.length) value.stage = "files";
        value.pending = false; await save(claim, source, value, end === plan.length ? "files" : "loading"); return queued(value, docs.manifest);
      }
      if (value.stage === "files") {
        ensure(value.file <= docs.manifest.files.length, "target_unavailable");
        const file = docs.manifest.files[value.file];
        if (!file) { value.stage = "reinstall"; value.pending = false; await save(claim, source, value, "verifying"); return queued(value, docs.manifest); }
        ensure(file.outcome === "packaged" && file.path === `files/${file.id}` && file.byteSize !== null && file.sha256 !== null, "archive_invalid");
        const expected = { byteSize: file.byteSize, sha256: file.sha256 }, namespace = stableJson(target.identity), db = repository.db();
        let recorded = (await files(claim.id)).find(row => row.logical_id === file.id);
        if (!recorded) {
          const logical = sha([target.identity.targetId, claim.id, file.id]);
          await db.batch([repository.guard(claim, db), db.prepare(`INSERT INTO system_recovery_target_files(job_id,logical_id,source_blob_id,file_id,location_id,profile_id,namespace,object_key,purpose,byte_size,sha256,state,incarnation)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?)`).bind(claim.id, file.id, file.source.locatorId, file.fileIds[0] ?? file.id,
              `node-recovery-inert-location:${logical}`, `node-recovery-inert-profile:${target.identity.targetId}`, namespace,
              `node-v28-target/${target.identity.targetId}/${claim.id}/${file.id}`, file.purposes.join(",") || "unknown",
              file.byteSize, file.sha256, target.identity.rootBindingId)]);
          recorded = (await files(claim.id)).find(row => row.logical_id === file.id); ensure(recorded);
        }
        ensure(recorded.byte_size === file.byteSize && recorded.sha256 === file.sha256 && recorded.namespace === namespace, "artifact_namespace_changed");
        if (!["verified", "published"].includes(recorded.state)) {
          let originalStarted = false;
          try {
            guard(); const existing = await target.verifyPayload(selectedIntent, file.id, expected, guard);
            if (!existing) {
              ensure(recorded.state === "pending", "write_outcome_unknown");
              await db.batch([repository.guard(claim, db), db.prepare("UPDATE system_recovery_target_files SET state='write_started',owner_token=?,generation=? WHERE job_id=? AND logical_id=? AND state='pending'")
                .bind(claim.owner_token, claim.generation, claim.id, file.id)]);
              originalStarted = true;
              await options.withArchive(claim, current, signal, async (archive, index) => {
                const entry = index.find(entry => entry.path === file.path); ensure(entry && entry.byteSize === file.byteSize && entry.sha256 === file.sha256, "archive_invalid");
                guard(); const body = await openStoreArchiveEntry(archive, entry, { createHash: nodeSha256, signal });
                await target.writePayload(selectedIntent, file.id, body, expected, guard);
              });
            }
            // An original directory ACK may arrive after the outer kernel
            // already paused. Admission, exact-byte proof and publication all
            // remain inside its issued-write catch; late ACK cannot publish.
            guard(); ensure(await target.verifyPayload(selectedIntent, file.id, expected, guard), "write_outcome_unknown");
            await db.batch([repository.guard(claim, db), db.prepare("UPDATE system_recovery_target_files SET state='verified',verified_at=? WHERE job_id=? AND logical_id=? AND state IN('pending','write_started','unknown') AND byte_size=? AND sha256=? AND namespace=?")
              .bind(new Date().toISOString(), claim.id, file.id, file.byteSize, file.sha256, namespace)]);
          } catch (error) {
            if (originalStarted) {
              // This conservative intent transition belongs to the exact OLD
              // owner/generation/runtime, not a live/expired job claim. The
              // original source/install/admin remains admitted in the same
              // BEGIN. A denial retains write_started plus pending cursor.
              const originalDb = repository.db();
              await originalDb.batch([options.originalIntentGuard(claim, originalDb),
                originalDb.prepare(`UPDATE system_recovery_target_files SET state='unknown'
                  WHERE job_id=? AND logical_id=? AND state='write_started' AND owner_token=? AND generation=? AND incarnation=?
                    AND byte_size=? AND sha256=? AND namespace=?`)
                  .bind(claim.id, file.id, claim.owner_token, claim.generation, target.identity.rootBindingId,
                    file.byteSize, file.sha256, namespace)]);
            }
            throw error;
          }
        }
        value.file++; value.pending = false; await save(claim, source, value, "files"); return queued(value, docs.manifest);
      }
      if (value.stage === "reinstall") {
        await target.withNative(selectedIntent, guard, ({ native }) => {
          const actual = native.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND tbl_name NOT IN('node_installation','node_migrations') ORDER BY type,name").all();
          if (stableJson(actual) !== stableJson(schema)) atomic(native, guard, () => {
            const existing = new Set(actual.map(row => String(row.name)));
            for (const type of ["index", "view", "trigger"] as const) for (const object of schema.filter(object => object.type === type)) {
              guard(); if (!existing.has(object.name)) native.exec(object.sql); }
            guard(); native.prepare("UPDATE system_recovery_maintenance SET state='fenced',updated_at=? WHERE singleton=1").run(new Date().toISOString());
          });
          if (native.prepare("SELECT state FROM system_recovery_maintenance WHERE singleton=1").get()?.state !== "fenced") atomic(native, guard, () => {
            guard(); native.prepare("UPDATE system_recovery_maintenance SET state='fenced',updated_at=? WHERE singleton=1").run(new Date().toISOString()); });
        }, value.database);
        guard(); value.stage = "verify"; value.pending = false; await save(claim, source, value, "verifying"); return queued(value, docs.manifest);
      }
      if (value.stage === "verify" || value.stage === "ready") {
        for (const file of docs.manifest.files) { guard(); ensure(file.byteSize !== null && file.sha256 !== null
          && await target.verifyPayload(selectedIntent, file.id, { byteSize: file.byteSize, sha256: file.sha256 }, guard), "write_outcome_unknown"); }
        const verified = await target.withNative(selectedIntent, guard, ({ native }) => verifyNodeV28InertTarget(native, docs.records, docs.manifest, guard), value.database);
        guard(); ensure(value.installationId === verified.installationId, "target_alias");
        const evidence = await validateLocalFileRuntimeV28({ businessTables: docs.records.content.tables,
          sourceSchema: docs.records.content.artifacts.sourceSchema.value.objects, sourceRowids: docs.records.content.artifacts.sourceRowids.value,
          snapshotClock: docs.records.image.sourceSnapshotClock, protectedLocalHistory: protectedLocalHistoryFromV5Image(docs.records.image) });
        guard(); const payloads = docs.manifest.files.filter(file => file.source.storeKind === "file" && file.source.provider === "local")
          .map(file => ({ id: file.id, source: file.source, path: file.path!, byteSize: file.byteSize!, sha256: file.sha256! })) as PackagedLocalVolumePayloadV28[];
        const mappings = await verifyInertLocalVolumeDestinationV28({ directory: target.destination, evidence, payloads,
          backupHoldOwner: docs.records.content.backupHoldOwner }); guard();
        const checkpoint = sha({ targetNamespace: target.identity, installationId: verified.installationId, sourceCheckpoint: claim.source_checkpoint,
          archiveSha256: source.archive_sha256, exactTypedRows: true, exactRowids: true, files: docs.manifest.files.map(file => [file.id, file.byteSize, file.sha256]) });
        const input = assertJob(claim), snapshot = docs.manifest.sourceSnapshotClock.replace(" ", "T");
        const recoveryPoint = new Date(/Z$|[+-]\d\d:\d\d$/.test(snapshot) ? snapshot : `${snapshot}Z`).toISOString();
        const report: SystemRecoveryPublicReport = { schema: "system-recovery-public-report/1", jobId: claim.id, targetId: target.identity.targetId,
          recoveryPoint, mode: input.mode, historicalLaterChangesLost: input.mode === "historical", sourceImageSha256: claim.source_checkpoint!, targetCheckpoint: checkpoint,
          counts: { tables: docs.manifest.counts.tables, originalRows: verified.originalRows, files: docs.manifest.files.length,
            bytes: docs.manifest.counts.bytes, auditedCellDifferences: verified.disabledAccountCells },
          protectedSettings: { included: true, policy: "quarantined", rootKeysIncluded: false, automaticExecution: false, freshConfigurationRequired: true },
          execution: { shadow: false, authority: false, fileJobs: false, recoveryJobs: false, cleanup: false, oldJobReplay: false },
          changes: verified.disabledAccountCells ? [{ table: "local_accounts", column: "enabled", reason: "protected_accounts_disabled", count: verified.disabledAccountCells }] : [],
          handoff: { automaticBindingChange: false, operatorRequired: true, sourceRetainedReadOnly: true, rollback: "safe_before_target_writes_only",
            steps: ["Keep source writes fenced and source executors stopped.", "Verify the fresh destination installation and this checkpoint.",
              "After recording handoff, use the stopped V28 identity operator to restore the selected disabled principal explicitly.",
              "Review quarantined settings and supply root keys independently.", "Admit destination volume bindings and bytes explicitly before enabling new writes.",
              "The operator selects the destination configuration; retain the source read-only."] } };
        await target.writeDocument(selectedIntent, "metadata/records.json", docs.records, guard);
        await target.writeDocument(selectedIntent, "metadata/manifest.json", docs.manifest, guard);
        await target.writeDocument(selectedIntent, "inert-local-volume-mappings.json", { schema: "offline-local-volume-source-mappings/v28",
          sourceArchiveSha256: source.archive_sha256, mappings, installationBindingsRestored: false, executionEnabled: false }, guard);
        await target.writeDocument(selectedIntent, "source-byte-inventory.json", { schema: "offline-system-recovery-bytes/1", backupId: docs.records.backupId,
          sourceArchiveSha256: source.archive_sha256, files: docs.manifest.files.map(file => ({ ...file, localPath: file.path })) }, guard);
        await target.writeDocument(selectedIntent, "recovery-report.json", { kind: "offline-system-backup-recovery", backupId: docs.records.backupId,
          sourceArchiveSha256: source.archive_sha256, sourceImageSchemaSha256: docs.records.image.schemaSha256, databasePath: "database.sqlite",
          destinationInstallationId: verified.installationId, destinationCheckpoint: "portable-runtime/v28", payloads: docs.manifest.files.length,
          payloadBytes: docs.manifest.counts.bytes, verifiedInertLocalVolumePayloads: mappings.length,
          verification: { exactTypedRows: true, exactRowids: true, foreignKeys: true, integrity: "ok", reviewedSchema: true },
          nativeBindingsRestored: false, executionEnabled: false, maintenanceState: "fenced", deploymentChanged: false,
          installationConstruction: value.construction, executionPath: "node-v28-shared-kernel-stages/1",
          payloadIO: "owned-local-filesystem", sourceBusinessProviderIO: false, publicReport: report }, guard);
        guard(); value.stage = "ready"; value.report = report; value.targetCheckpoint = checkpoint;
        value.pending = false; await save(claim, source, value, "ready");
        const db = repository.db();
        return { patch: { state: "completed", phase: "ready", reason: null, target_incarnation: target.identity.rootBindingId,
          completed_files: docs.manifest.files.length, bytes_done: docs.manifest.counts.bytes,
          result_json: stableJson({ targetId: target.identity.targetId, ready: true, cutover: false, checkpoint }) },
          statements: [...repository.metadataStatements(claim.id, "report", report),
            db.prepare("UPDATE system_recovery_target_files SET state='published' WHERE job_id=? AND state='verified'").bind(claim.id)], outcome: "target_ready" };
      }
      throw new Error("target_unavailable");
    });
  }
  function reservation(plan: { id: string; actor: string; sourceCheckpoint: string }, source: RecoveryJob,
    docs: Documents, db: JobSqlDatabase): readonly JobSqlStatement[] {
    base(); ensure(source.kind === "upload" && source.state === "preview" && source.actor === plan.actor
      && docs.manifest.completeness === "complete" && docs.manifest.sourceCheckpoint === plan.sourceCheckpoint, "archive_invalid");
    const value: Cursor = { version: 1, actor: plan.actor, pending: false, stage: "claim", cleared: false, clearIndex: 0, group: 0, file: 0,
      database: null, installationId: null, construction: null, report: null, targetCheckpoint: null };
    const acceptedChallenge = sha({ target: target.identity, jobId: plan.id, actor: plan.actor, uploadJobId: source.id,
      archiveSha256: source.archive_sha256, sourceCheckpoint: plan.sourceCheckpoint });
    return [db.prepare(`INSERT INTO system_recovery_target_claim(singleton,target_id,job_id,incarnation,challenge,schema_sha256,image_sha256,status,cursor_json)
      VALUES(1,?,?,?,?,?,?,'claimed',?)`).bind(target.identity.targetId, plan.id, target.identity.rootBindingId,
        acceptedChallenge, docs.records.image.schemaSha256, plan.sourceCheckpoint, stableJson(value))];
  }
  async function preview(uploadJob: RecoveryJob): Promise<{ available: boolean; reason: string | null }> {
    base(); if (uploadJob.kind !== "upload" || uploadJob.state !== "preview") return { available: false, reason: "archive_invalid" };
    const claimed = await repository.db().prepare("SELECT 1 FROM system_recovery_target_claim WHERE singleton=1").first();
    return claimed || !await target.fresh() ? { available: false, reason: "target_not_fresh" } : { available: true, reason: null };
  }
  function verifyReady(job: RecoveryJob, guard: () => void): Promise<{ report: SystemRecoveryPublicReport; checkpoint: string }> {
    return track(async () => {
      guard(); const source = await upload(job), docs = await accepted(job), value = await cursor(job, source);
      ensure(value?.stage === "ready" && !value.pending && value.database && value.report && value.targetCheckpoint, "target_unavailable");
      const selectedIntent = intent(job, source); guard();
      for (const file of docs.manifest.files) { ensure(file.byteSize !== null && file.sha256 !== null, "archive_invalid");
        guard(); ensure(await target.verifyPayload(selectedIntent, file.id, { byteSize: file.byteSize, sha256: file.sha256 }, guard), "write_outcome_unknown"); }
      const verified = await target.withNative(selectedIntent, guard, ({ native }) => verifyNodeV28InertTarget(native, docs.records, docs.manifest, guard), value.database);
      const checkpoint = sha({ targetNamespace: target.identity, installationId: verified.installationId, sourceCheckpoint: job.source_checkpoint,
        archiveSha256: source.archive_sha256, exactTypedRows: true, exactRowids: true, files: docs.manifest.files.map(file => [file.id, file.byteSize, file.sha256]) });
      guard(); ensure(checkpoint === value.targetCheckpoint && checkpoint === value.report.targetCheckpoint, "target_unavailable");
      return { report: value.report, checkpoint };
    });
  }
  function close(): Promise<void> { return owner.closing ??= (async () => { owner.closed = true; await Promise.allSettled([...pending]);
    if (owner.failed) throw owner.failure; })(); }
  return Object.freeze({ step, preview, assertJob, accepted, cursor, reservation, verifyReady, close });
}
function targetSeed(name: string): SystemRecoveryTable { const value = seeds[name]; ensure(value); return value; }
function verifyNodeV28SeedIdentity(native: DatabaseSync, guard: () => void) {
  guard(); const row = native.prepare("SELECT installation_id FROM node_installation WHERE singleton=1").get(); ensure(typeof row?.installation_id === "string");
  // Full reviewed native admission, integrity and FK validation remains the
  // positive construction proof; a named checkpoint is never a migration gate.
  const admission = requireSeedAdmission(native); guard(); return admission;
}
import { admitInstallationRecoverySource } from "../migrations.ts";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "../installation-catalog-v28-candidate.ts";
function requireSeedAdmission(native: DatabaseSync) { return admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE).receipt; }

import { HTTPException } from "hono/http-exception";
import { DEFAULT_SAMPLE_STATUS, isSampleStatus, type SampleStatus } from "../../shared/types";
import { configurationSqlInteger, type ConfigurationSqlDatabase, type ConfigurationSqlRow, type ConfigurationSqlStatement } from "../runtime/configuration-sql";

/** Reuse the genuine exact-cell top-level mutation capability. This group
 * adds no RETURNING/CTE, DDL, File/provider or duplicate driver capability. */
export interface RunTrashCapabilities {
  database(): ConfigurationSqlDatabase;
  /** Required trusted composer current principal AND current installation
   * write controls. Rechecked before reads, before SQL and after acceptance.
   * A denied final ACK never undoes an already committed mutation. */
  admit(actor: string): Promise<void>;
  now(): number;
  randomId(): string;
}
export type RunTrashWrite = { ok: true; updatedAt: string };
function revisionInput(value: unknown): { expectedSampleUpdatedAt: string } {
  const expectedSampleUpdatedAt = value && typeof value === "object" && "expectedSampleUpdatedAt" in value
    ? value.expectedSampleUpdatedAt : undefined;
  if (typeof expectedSampleUpdatedAt !== "string") {
    throw new HTTPException(400, { message: "The current sample revision is required" });
  }
  // Capture before the first await. Mutable caller objects never supply a
  // later revision after current admission or SQL reads have suspended.
  return Object.freeze({ expectedSampleUpdatedAt });
}
function text(row: ConfigurationSqlRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new TypeError(`Invalid Run trash field: ${name}`);
  return value;
}
function nullableText(row: ConfigurationSqlRow, name: string): string | null {
  return row[name] === null ? null : text(row, name);
}
function runKind(value: string): "process" | "metrology" {
  if (value !== "process" && value !== "metrology") throw new TypeError("Invalid Run trash kind");
  return value;
}
function runStatus(value: string): "active" | "complete" | "cancelled" | "superseded" {
  if (value !== "active" && value !== "complete" && value !== "cancelled" && value !== "superseded") throw new TypeError("Invalid Run trash status");
  return value;
}
function sampleStatus(value: string): SampleStatus {
  if (!isSampleStatus(value)) throw new TypeError("Invalid Run trash Sample status");
  return value;
}
function decodeRun(row: ConfigurationSqlRow) {
  return { id: text(row, "id"), run_kind: runKind(text(row, "run_kind")), status: runStatus(text(row, "status")),
    // Retained schema has no nonnegative CHECK on these two snapshots. Exact
    // safe signed integers retain old values; only consumed fields convert.
    sequence_no: configurationSqlInteger(row.sequence_no, "Run trash sequence_no", Number.MIN_SAFE_INTEGER),
    template_name_snapshot: text(row, "template_name_snapshot"),
    template_version_snapshot: configurationSqlInteger(row.template_version_snapshot, "Run trash template_version_snapshot", Number.MIN_SAFE_INTEGER),
    created_at: text(row, "created_at"), sample_status: sampleStatus(text(row, "sample_status")),
    sample_updated_at: text(row, "sample_updated_at"),
    other_active_count: configurationSqlInteger(row.other_active_count, "Run trash other_active_count") };
}
function decodeRestorableRun(row: ConfigurationSqlRow) {
  return { id: text(row, "id"), run_kind: runKind(text(row, "run_kind")), status: runStatus(text(row, "status")),
    sequence_no: configurationSqlInteger(row.sequence_no, "Run restore sequence_no", Number.MIN_SAFE_INTEGER),
    predecessor_run_id: nullableText(row, "predecessor_run_id"), deleted_at: text(row, "deleted_at"),
    template_name_snapshot: text(row, "template_name_snapshot"),
    template_version_snapshot: configurationSqlInteger(row.template_version_snapshot, "Run restore template_version_snapshot", Number.MIN_SAFE_INTEGER),
    sample_status: sampleStatus(text(row, "sample_status")), sample_updated_at: text(row, "sample_updated_at"),
    active_process_count: configurationSqlInteger(row.active_process_count, "Run restore active_process_count"),
    newer_visible_process_count: configurationSqlInteger(row.newer_visible_process_count, "Run restore newer_visible_process_count"),
    successor_conflict_count: configurationSqlInteger(row.successor_conflict_count, "Run restore successor_conflict_count") };
}

/** The existing Run soft-delete/restore implementation is shared, not a
 * parallel Node model. The mature SQL/CAS/audits/unique-conflict policy remain. */
export function createRunTrashService(capabilities: RunTrashCapabilities) {
  return {
    async remove(sampleId: string, runId: string, value: unknown, actor: string): Promise<RunTrashWrite> {
      const input = revisionInput(value);
      await capabilities.admit(actor);
      const db = capabilities.database();
      const row = await db.prepare(
        `SELECT r.id, r.run_kind, r.status, r.sequence_no,
            r.template_name_snapshot, r.template_version_snapshot, r.created_at,
            s.status AS sample_status, s.updated_at AS sample_updated_at,
            (SELECT COUNT(*) FROM runs active
             WHERE active.sample_id = r.sample_id
               AND active.status = 'active'
               AND active.deleted_at IS NULL
               AND active.id != r.id) AS other_active_count
     FROM runs r
     JOIN samples s ON s.id = r.sample_id
     WHERE r.id = ? AND r.sample_id = ?
       AND s.deleted_at IS NULL AND r.deleted_at IS NULL`,
      ).bind(runId, sampleId).first();
      if (!row) throw new HTTPException(404, { message: "Run not found" });
      const run = decodeRun(row);
      if (run.sample_updated_at !== input.expectedSampleUpdatedAt) {
        throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before deleting the run." });
      }
  
      const matchedActivationEvent = await db.prepare(
        `SELECT metadata_json FROM events
     WHERE sample_id = ? AND kind = 'status' AND created_at = ?
       AND json_extract(metadata_json, '$.current') = 'active'
     ORDER BY id DESC LIMIT 1`,
      ).bind(sampleId, run.created_at).first();
      let nextSampleStatus = run.sample_status;
      if (run.status === "active" && Number(run.other_active_count) === 0 && run.sample_status === "active") {
        let previousStatus: unknown;
        try {
          previousStatus = JSON.parse(matchedActivationEvent ? text(matchedActivationEvent, "metadata_json") : "{}").previous;
        } catch {
          previousStatus = null;
        }
        nextSampleStatus = isSampleStatus(previousStatus) && previousStatus !== "active"
          ? previousStatus
          : DEFAULT_SAMPLE_STATUS;
      }
  
      const now = new Date(Math.max(capabilities.now(), Date.parse(run.sample_updated_at) + 1)).toISOString();
      const userEmail = actor;
      const mutationId = capabilities.randomId();
      const guardSql = "EXISTS (SELECT 1 FROM samples WHERE id = ? AND last_mutation_id = ? AND deleted_at IS NULL)";
      const statements: ConfigurationSqlStatement[] = [
        db.prepare(
          `UPDATE samples
       SET status = ?, updated_by = ?, last_mutation_id = ?, updated_at = ?
       WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`,
        ).bind(nextSampleStatus, userEmail, mutationId, now, sampleId, input.expectedSampleUpdatedAt),
        db.prepare(
          `UPDATE runs SET deleted_at = ?, deleted_by = ?
       WHERE id = ? AND sample_id = ? AND deleted_at IS NULL AND ${guardSql}`,
        ).bind(now, userEmail, runId, sampleId, sampleId, mutationId),
        db.prepare(
          `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'run', ?, ?, ?, ?
       WHERE ${guardSql} AND EXISTS (
         SELECT 1 FROM runs
         WHERE id = ? AND sample_id = ? AND deleted_at = ?
       )`,
        ).bind(
          capabilities.randomId(),
          sampleId,
          `Moved ${run.run_kind} run to trash · ${run.template_name_snapshot}${run.run_kind === "process" ? ` v${run.template_version_snapshot}` : ""}`,
          JSON.stringify({
            action: "run_deleted",
            deletedRunId: runId,
            runKind: run.run_kind,
            sequenceNo: Number(run.sequence_no),
            templateName: run.template_name_snapshot,
            templateVersion: Number(run.template_version_snapshot),
            recoverable: true,
          }),
          userEmail,
          now,
          sampleId,
          mutationId,
          runId,
          sampleId,
          now,
        ),
      ];
  
      await capabilities.admit(actor);
      const results = await db.batch(statements);
      await capabilities.admit(actor);
      if (results.length !== 3) throw new Error("Incomplete Run trash batch acknowledgement");
      if (results.some((result) => !result.directChanges)) {
        throw new HTTPException(409, { message: "The run changed while it was being deleted. Reload and try again." });
      }
      return { ok: true as const, updatedAt: now };
    },
    async restore(sampleId: string, runId: string, value: unknown, actor: string): Promise<RunTrashWrite> {
      const input = revisionInput(value);
      await capabilities.admit(actor);
      const db = capabilities.database();
      const row = await db.prepare(
        `SELECT r.id, r.run_kind, r.status, r.sequence_no, r.predecessor_run_id, r.deleted_at,
            r.template_name_snapshot, r.template_version_snapshot,
            s.status AS sample_status, s.updated_at AS sample_updated_at,
            (SELECT COUNT(*) FROM runs active
             WHERE active.sample_id = r.sample_id
               AND active.run_kind = 'process'
               AND active.status = 'active'
               AND active.deleted_at IS NULL
               AND active.id != r.id) AS active_process_count
            ,(SELECT COUNT(*) FROM runs newer
              WHERE newer.sample_id = r.sample_id
                AND newer.run_kind = 'process'
                AND newer.sequence_no > r.sequence_no
                AND newer.deleted_at IS NULL) AS newer_visible_process_count
            ,(SELECT COUNT(*) FROM runs successor
              WHERE r.predecessor_run_id IS NOT NULL
                AND successor.predecessor_run_id = r.predecessor_run_id
                AND successor.deleted_at IS NULL
                AND successor.id != r.id) AS successor_conflict_count
     FROM runs r
     JOIN samples s ON s.id = r.sample_id
     WHERE r.id = ? AND r.sample_id = ?
       AND s.deleted_at IS NULL AND r.deleted_at IS NOT NULL`,
      ).bind(runId, sampleId).first();
      if (!row) throw new HTTPException(404, { message: "Run not found in trash" });
      const run = decodeRestorableRun(row);
      if (run.sample_updated_at !== input.expectedSampleUpdatedAt) {
        throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before restoring the run." });
      }
      if (run.run_kind === "process" && run.status === "active" && Number(run.active_process_count) > 0) {
        throw new HTTPException(409, { message: "Finish or move the current active process run to trash before restoring this run." });
      }
      if (run.run_kind === "process" && run.status === "active" && Number(run.newer_visible_process_count) > 0) {
        throw new HTTPException(409, { message: "An active process run can only be restored when it is the latest visible process run." });
      }
      if (run.predecessor_run_id && Number(run.successor_conflict_count) > 0) {
        throw new HTTPException(409, { message: "Another visible run already succeeds this run's predecessor." });
      }
  
      const now = new Date(Math.max(
        capabilities.now(),
        Date.parse(run.sample_updated_at) + 1,
        Date.parse(run.deleted_at) + 1,
      )).toISOString();
      const userEmail = actor;
      const mutationId = capabilities.randomId();
      const nextSampleStatus = run.status === "active" ? "active" : run.sample_status;
      const guardSql = "EXISTS (SELECT 1 FROM samples WHERE id = ? AND last_mutation_id = ? AND deleted_at IS NULL)";
      await capabilities.admit(actor);
      try {
        const results = await db.batch([
          db.prepare(
            `UPDATE samples
         SET status = ?, updated_by = ?, last_mutation_id = ?, updated_at = ?
         WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`,
          ).bind(nextSampleStatus, userEmail, mutationId, now, sampleId, input.expectedSampleUpdatedAt),
          db.prepare(
            `UPDATE runs SET deleted_at = NULL, deleted_by = NULL
         WHERE id = ? AND sample_id = ? AND deleted_at = ? AND ${guardSql}
           AND NOT EXISTS (
             SELECT 1 FROM runs successor
             WHERE runs.predecessor_run_id IS NOT NULL
               AND successor.predecessor_run_id = runs.predecessor_run_id
               AND successor.deleted_at IS NULL
               AND successor.id != runs.id
           )
           AND NOT (
             run_kind = 'process' AND status = 'active' AND EXISTS (
               SELECT 1 FROM runs newer
               WHERE newer.sample_id = runs.sample_id
                 AND newer.run_kind = 'process'
                 AND newer.sequence_no > runs.sequence_no
                 AND newer.deleted_at IS NULL
             )
           )`,
          ).bind(runId, sampleId, run.deleted_at, sampleId, mutationId),
          db.prepare(
            `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
         SELECT ?, ?, 'run', ?, ?, ?, ?
         WHERE ${guardSql} AND EXISTS (
           SELECT 1 FROM runs
           WHERE id = ? AND sample_id = ? AND deleted_at IS NULL
         )`,
          ).bind(
            capabilities.randomId(),
            sampleId,
            `Restored ${run.run_kind} run · ${run.template_name_snapshot}${run.run_kind === "process" ? ` v${run.template_version_snapshot}` : ""}`,
            JSON.stringify({
              action: "run_restored",
              restoredRunId: runId,
              runKind: run.run_kind,
              sequenceNo: Number(run.sequence_no),
              templateName: run.template_name_snapshot,
              templateVersion: Number(run.template_version_snapshot),
            }),
            userEmail,
            now,
            sampleId,
            mutationId,
            runId,
            sampleId,
          ),
        ]);
        await capabilities.admit(actor);
        if (results.length !== 3) throw new Error("Incomplete Run trash batch acknowledgement");
        if (results.some((result) => !result.directChanges)) {
          throw new HTTPException(409, { message: "The run changed while it was being restored. Reload and try again." });
        }
      } catch (error) {
        if (error instanceof HTTPException) throw error;
        if (/runs_single_successor_idx|UNIQUE constraint failed: runs\.predecessor_run_id/.test(String(error))) {
          throw new HTTPException(409, { message: "Another visible run already succeeds this run's predecessor." });
        }
        if (/runs_one_active_process_per_sample_idx|UNIQUE constraint failed: runs\.sample_id/.test(String(error))) {
          throw new HTTPException(409, { message: "Another active process run became visible before this run was restored." });
        }
        throw error;
      }
      return { ok: true as const, updatedAt: now };
    },
  };
}
export type RunTrashService = ReturnType<typeof createRunTrashService>;

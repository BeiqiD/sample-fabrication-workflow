import { HTTPException } from "hono/http-exception";
import { insertionPosition } from "../run-position";
import { configurationSqlInteger, type ConfigurationSqlDatabase, type ConfigurationSqlRow, type ConfigurationSqlStatement } from "../runtime/configuration-sql";

/** Two existing metadata-only execution methods. Reuses the genuine owned
 * top-level SQL batch; it does not open File/media/provider capabilities. */
export interface MetrologyWriteCapabilities {
  database(): ConfigurationSqlDatabase;
  /** Required trusted exact-Request current principal plus persisted current
   * installation controls before reads/prebatch/postaccepted ACK. */
  admit(actor: string): Promise<void>;
  now(): number;
  randomId(): string;
}
export function startInput(value: unknown): Readonly<{ templateVersionId: string }> {
  const templateVersionId = value && typeof value === "object" && "templateVersionId" in value ? value.templateVersionId : undefined;
  if (typeof templateVersionId !== "string" || !templateVersionId) throw new HTTPException(400, { message: "A metrology template is required" });
  return Object.freeze({ templateVersionId });
}
export function entryInput(value: unknown): Readonly<{ templateVersionId: string; afterStepId?: string }> {
  const templateVersionId = value && typeof value === "object" && "templateVersionId" in value ? value.templateVersionId : undefined;
  const afterStepId = value && typeof value === "object" && "afterStepId" in value ? value.afterStepId : undefined;
  if (typeof templateVersionId !== "string" || !templateVersionId || afterStepId !== undefined && typeof afterStepId !== "string") {
    throw new HTTPException(400, { message: "A metrology template and insertion point are required" });
  }
  return Object.freeze({ templateVersionId, ...(afterStepId === undefined ? {} : { afterStepId }) });
}
function text(row: ConfigurationSqlRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`Invalid Metrology SQL text: ${field}`);
  return value;
}
function decodeRun(row: ConfigurationSqlRow) {
  return { id: text(row, "id"), anchor_step_id: row.anchor_step_id === null ? null : text(row, "anchor_step_id") };
}
function position(value: unknown): number {
  if (typeof value === "bigint") return configurationSqlInteger(value, "Metrology step position", Number.MIN_SAFE_INTEGER);
  if (typeof value !== "number" || !Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new RangeError("Metrology step position is outside exact decimal range");
  }
  return value;
}
function decodeStep(row: ConfigurationSqlRow) {
  return { id: text(row, "id"), position: position(row.position), updated_at: text(row, "updated_at") };
}
function decodeTemplate(row: ConfigurationSqlRow) {
  // Inline placement does not consume template version/family. They remain
  // unconverted exact SQL cells; no whole-row numeric map is permitted.
  return { id: text(row, "id"), name: text(row, "name"), template_step_id: text(row, "template_step_id"),
    logical_step_key: text(row, "logical_step_key"), definition_hash: text(row, "definition_hash") };
}
function decodeStandaloneTemplate(row: ConfigurationSqlRow) {
  const template_type = text(row, "template_type");
  if (template_type !== "process" && template_type !== "module" && template_type !== "recipe") throw new TypeError("Invalid Metrology template type");
  return { ...decodeTemplate(row), recipe_family_id: text(row, "recipe_family_id"), template_type,
    version: configurationSqlInteger(row.version, "Metrology template version", Number.MIN_SAFE_INTEGER) };
}

/** Shares the mature single implementation; preserves query/bind/order/CAS,
 * positional/adjacency snapshot, template identity and audit semantics. */
export function createMetrologyWriteService(capabilities: MetrologyWriteCapabilities) {
  return {
    async addEntry(sampleId: string, runId: string, value: unknown, actor: string): Promise<{ id: string }> {
      const input = entryInput(value);
      await capabilities.admit(actor);
      const db = capabilities.database();
      const [run, template, stepRows] = await Promise.all([
        db.prepare(
          `SELECT r.id, r.anchor_step_id FROM runs r
       JOIN samples s ON s.id = r.sample_id
       WHERE r.id = ? AND r.sample_id = ? AND r.run_kind = 'process' AND r.status = 'active'
         AND s.deleted_at IS NULL AND r.deleted_at IS NULL`,
        ).bind(runId, sampleId).first().then(row => row === null ? null : decodeRun(row)),
        db.prepare(
          `SELECT tv.id, tv.name, tv.version, tv.recipe_family_id,
              ts.id AS template_step_id, ts.logical_step_key, ts.definition_hash
       FROM template_versions tv
       JOIN template_steps ts ON ts.template_version_id = tv.id
       WHERE tv.id = ? AND tv.template_kind = 'metrology' AND tv.archived_at IS NULL
         AND tv.deleted_at IS NULL
         AND (SELECT COUNT(*) FROM template_steps only_step WHERE only_step.template_version_id = tv.id) = 1`,
        ).bind(input.templateVersionId).first().then(row => row === null ? null : decodeTemplate(row)),
        db.prepare("SELECT id, position, updated_at FROM run_steps WHERE run_id = ? AND deleted_at IS NULL ORDER BY position")
          .bind(runId).all().then(rows => ({ results: rows.results.map(decodeStep) })),
      ]);
      if (!run) throw new HTTPException(404, { message: "Active process run not found" });
      if (!template) throw new HTTPException(404, { message: "Metrology template not found" });
      const position = insertionPosition(stepRows.results, input.afterStepId);
      if (position === null) throw new HTTPException(404, { message: "Insertion point not found" });
      const afterIndex = input.afterStepId ? stepRows.results.findIndex((step) => step.id === input.afterStepId) : -1;
      const nextStepId = stepRows.results[afterIndex + 1]?.id ?? null;
      const stepId = capabilities.randomId();
      const mutationId = capabilities.randomId();
      const now = new Date(capabilities.now()).toISOString();
      const userEmail = actor;
      const adjacentSteps = stepRows.results.filter((step) => step.id === input.afterStepId || step.id === nextStepId);
      const stepSnapshotSql = `AND (
       SELECT COUNT(*) FROM run_steps snapshot
       WHERE snapshot.run_id = runs.id AND snapshot.deleted_at IS NULL
     ) = ?
     ${adjacentSteps.map(() => `AND EXISTS (
       SELECT 1 FROM run_steps snapshot
       WHERE snapshot.run_id = runs.id AND snapshot.id = ?
         AND snapshot.position = ? AND snapshot.updated_at = ?
         AND snapshot.deleted_at IS NULL
     )`).join("\n")}`;
      const stepSnapshotBindings = [
        stepRows.results.length,
        ...adjacentSteps.flatMap((step) => [step.id, step.position, step.updated_at]),
      ];
      const statements: ConfigurationSqlStatement[] = [
        db.prepare(
          `UPDATE runs SET last_mutation_id = ?
       WHERE id = ? AND sample_id = ? AND run_kind = 'process'
         AND status = 'active' AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM samples s
           WHERE s.id = runs.sample_id AND s.deleted_at IS NULL
         )
         AND EXISTS (
           SELECT 1 FROM template_versions tv
           WHERE tv.id = ? AND tv.template_kind = 'metrology'
             AND tv.archived_at IS NULL AND tv.deleted_at IS NULL
         )
         ${stepSnapshotSql}`,
        ).bind(mutationId, runId, sampleId, input.templateVersionId, ...stepSnapshotBindings),
        db.prepare(
          `INSERT INTO run_steps
        (id, run_id, previous_step_id, position, status, origin, entry_kind, template_step_id,
         logical_step_key, definition_hash, actualized_at, created_at, updated_by, updated_at)
       SELECT ?, r.id, ?, ?, 'pending', 'ad_hoc', 'metrology', ?, ?, ?, ?, ?, ?, ?
       FROM runs r JOIN template_versions tv ON tv.id = ?
       WHERE r.id = ? AND r.sample_id = ? AND r.run_kind = 'process' AND r.status = 'active'
         AND r.deleted_at IS NULL AND r.last_mutation_id = ?
         AND EXISTS (
           SELECT 1 FROM samples s
           WHERE s.id = r.sample_id AND s.deleted_at IS NULL
         )
         AND tv.template_kind = 'metrology' AND tv.archived_at IS NULL
         AND tv.deleted_at IS NULL`,
        ).bind(stepId, input.afterStepId ?? run.anchor_step_id, position, template.template_step_id,
          template.logical_step_key, template.definition_hash, now, now, userEmail, now,
          input.templateVersionId, runId, sampleId, mutationId),
      ];
      if (nextStepId) statements.push(db.prepare(
        `UPDATE run_steps SET previous_step_id = ?
     WHERE id = ? AND run_id = ? AND deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM run_steps inserted JOIN runs r ON r.id = inserted.run_id
         WHERE inserted.id = ? AND inserted.run_id = ?
           AND r.last_mutation_id = ? AND r.status = 'active'
           AND r.deleted_at IS NULL
       )`,
      ).bind(stepId, nextStepId, runId, stepId, runId, mutationId));
      statements.push(
        db.prepare(
          `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'step', ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM run_steps inserted JOIN runs r ON r.id = inserted.run_id
         WHERE inserted.id = ? AND inserted.run_id = ?
           AND r.last_mutation_id = ? AND r.status = 'active'
           AND r.deleted_at IS NULL
       )`,
        ).bind(capabilities.randomId(), sampleId, `Added metrology: ${template.name}`,
          JSON.stringify({ runId, stepId, action: "metrology_added", templateVersionId: template.id, afterStepId: input.afterStepId ?? null }),
          userEmail, now, stepId, runId, mutationId),
        db.prepare(
          `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM run_steps inserted JOIN runs r ON r.id = inserted.run_id
           WHERE inserted.id = ? AND inserted.run_id = ?
             AND r.sample_id = samples.id AND r.last_mutation_id = ?
             AND r.status = 'active' AND r.deleted_at IS NULL
             AND inserted.deleted_at IS NULL
         )`,
        ).bind(userEmail, now, sampleId, stepId, runId, mutationId),
      );
      await capabilities.admit(actor);
      const results = await db.batch(statements);
      await capabilities.admit(actor);
      if (results.length !== statements.length) throw new Error("Incomplete Metrology entry batch acknowledgement");
      if (!results[0].directChanges || !results[1].directChanges || !results.at(-1)?.directChanges) {
        throw new HTTPException(409, { message: "The process run or metrology template changed while the record was being added" });
      }
      return { id: stepId };
    },
    async startRun(sampleId: string, value: unknown, actor: string): Promise<{ id: string }> {
      const input = startInput(value);
      await capabilities.admit(actor);
      const db = capabilities.database();
      const [sample, template, latestSequence] = await Promise.all([
        db.prepare("SELECT updated_at FROM samples WHERE id = ? AND deleted_at IS NULL")
          .bind(sampleId).first().then(row => row === null ? null : ({ updated_at: text(row, "updated_at") })),
        db.prepare(
          `SELECT tv.id, tv.name, tv.version, tv.recipe_family_id, tv.template_type,
              ts.id AS template_step_id, ts.logical_step_key, ts.definition_hash
       FROM template_versions tv
       JOIN template_steps ts ON ts.template_version_id = tv.id
       WHERE tv.id = ? AND tv.template_kind = 'metrology' AND tv.archived_at IS NULL
         AND tv.deleted_at IS NULL
         AND (SELECT COUNT(*) FROM template_steps only_step WHERE only_step.template_version_id = tv.id) = 1`,
        ).bind(input.templateVersionId).first().then(row => row === null ? null : decodeStandaloneTemplate(row)),
        db.prepare("SELECT COALESCE(MAX(sequence_no), 0) AS sequence_no FROM runs WHERE sample_id = ?")
          .bind(sampleId).first().then(row => row === null ? null : ({ sequence_no: configurationSqlInteger(row.sequence_no, "Metrology latest sequence_no", Number.MIN_SAFE_INTEGER) })),
      ]);
      if (!sample) throw new HTTPException(404, { message: "Sample not found" });
      if (!template) throw new HTTPException(404, { message: "Metrology template not found" });
      const runId = capabilities.randomId();
      const stepId = capabilities.randomId();
      const now = new Date(Math.max(capabilities.now(), Date.parse(sample.updated_at) + 1)).toISOString();
      const userEmail = actor;
      const nextSequence = configurationSqlInteger(Number(latestSequence?.sequence_no ?? 0) + 1, "Metrology next sequence_no", Number.MIN_SAFE_INTEGER);
      const statements: ConfigurationSqlStatement[] = [
        db.prepare(
          `INSERT INTO runs
        (id, sample_id, recipe_family_id, template_version_id, sequence_no, run_group_id, run_kind,
         template_name_snapshot, template_type_snapshot, template_version_snapshot,
         created_by, created_at)
       SELECT ?, s.id, ?, ?, ?, ?, 'metrology', ?, ?, ?, ?, ?
       FROM samples s
       WHERE s.id = ? AND s.updated_at = ? AND s.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM template_versions tv
           WHERE tv.id = ? AND tv.template_kind = 'metrology' AND tv.archived_at IS NULL
             AND tv.deleted_at IS NULL
         )`,
        ).bind(runId, template.recipe_family_id, template.id, nextSequence,
          capabilities.randomId(), template.name, template.template_type, template.version, userEmail, now,
          sampleId, sample.updated_at, template.id),
        db.prepare(
          `INSERT INTO run_steps
        (id, run_id, position, status, origin, entry_kind, template_step_id,
         logical_step_key, definition_hash, created_at, updated_by, updated_at)
       SELECT ?, ?, 1000, 'pending', 'template', 'metrology', ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND run_kind = 'metrology')`,
        ).bind(stepId, runId, template.template_step_id, template.logical_step_key,
          template.definition_hash, now, userEmail, now, runId),
        db.prepare(
          `INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
       SELECT ?, ?, 'run', ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM runs WHERE id = ? AND run_kind = 'metrology')`,
        ).bind(capabilities.randomId(), sampleId, `Started metrology run · ${template.name}`,
          JSON.stringify({ runId, stepId, action: "metrology_run_started", templateVersionId: template.id }),
          userEmail, now, runId),
        db.prepare(
          `UPDATE samples SET updated_by = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM runs WHERE id = ? AND run_kind = 'metrology' AND deleted_at IS NULL)`,
        ).bind(userEmail, now, sampleId, runId),
      ];
      await capabilities.admit(actor);
      const results = await db.batch(statements);
      await capabilities.admit(actor);
      if (results.length !== statements.length) throw new Error("Incomplete Metrology Run batch acknowledgement");
      if (results.some((result) => !result.directChanges)) {
        throw new HTTPException(409, { message: "The sample or metrology template changed while the run was being started" });
      }
      return { id: runId };
    },
  };
}
export type MetrologyWriteService = ReturnType<typeof createMetrologyWriteService>;

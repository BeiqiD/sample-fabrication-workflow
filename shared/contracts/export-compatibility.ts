import type { CompatibilitySchema, ExportCell, ExportRow, ExportTables, ObservedExportSchema, RetiredExportField, RetiredExportFields } from "./export";

const sampleColumns = ["id", "code", "title", "description", "status", "location", "parent_id", "pinned", "process_revision", "created_by", "updated_by", "last_mutation_id", "created_at", "updated_at", "inherited_state_hash", "deleted_at", "deleted_by"];
const occurrenceColumns = ["id", "run_step_id", "scope", "operation_group_id", "body", "asset_id", "actor_email", "created_at", "submission_id", "updated_at", "updated_by", "deleted_at", "deleted_by", "asset_deleted_at", "asset_deleted_by", "last_mutation_id", "deletion_operation_id", "asset_deletion_operation_id"];

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Export compatibility rejected: ${message}`);
}
function sameKeys(actual: string[], expected: string[]) {
  return actual.length === expected.length && actual.every((name) => expected.includes(name)) && new Set(actual).size === actual.length;
}
export function exportCompatibilityColumns(schema: CompatibilitySchema) {
  return {
    samples: schema === "S2" ? sampleColumns.filter((name) => name !== "process_revision") : [...sampleColumns],
    run_step_comments: schema === "S0" ? [...occurrenceColumns] : [
      ...occurrenceColumns.filter((name) => schema === "S1" || name !== "body"), "legacy_body",
    ],
  };
}
function inspectRows(rows: ExportRow[] | undefined, columns: string[], name: string) {
  ensure(Array.isArray(rows), `missing ${name} rows`);
  const ids = new Set<string>();
  for (const row of rows) {
    ensure(row && typeof row === "object" && !Array.isArray(row) && sameKeys(Object.keys(row), columns), `${name} columns differ from observed schema`);
    ensure(typeof row.id === "string" && row.id.length > 0 && !ids.has(row.id), `${name} has invalid or duplicate IDs`);
    ids.add(row.id);
    ensure(Object.values(row).every((value) => value === null || typeof value === "string"
      || typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))), `${name} has invalid cells`);
  }
  return rows;
}

export function classifyExportCompatibilitySchema(columns: ObservedExportSchema["compatibilityColumns"]): CompatibilitySchema {
  for (const schema of ["S0", "S1", "S2"] as const) {
    const expected = exportCompatibilityColumns(schema);
    if (sameKeys(columns.samples, expected.samples) && sameKeys(columns.run_step_comments, expected.run_step_comments)) return schema;
  }
  throw new Error("Export compatibility rejected: unrecognized physical compatibility columns");
}

function retired<T extends ExportCell>(rows: ExportRow[], key: string, present: boolean, valid: (value: ExportCell) => value is T): RetiredExportField<T> {
  const values: Array<{ id: string; value: T }> = [];
  if (present) for (const row of rows) {
    ensure(valid(row[key]), `invalid recorded ${key}`);
    values.push({ id: row.id as string, value: row[key] as T });
  }
  return { presentInSourceSchema: present, complete: present, sourceRowCount: rows.length, values };
}

// Pure projection only: the caller owns the single database snapshot and the
// artifact hashes. No retired value is inferred, defaulted or repaired here.
export function projectCompatibilitySnapshot(tables: ExportTables, sourceSchema: Pick<ObservedExportSchema, "compatibilityColumns">) {
  const schema = classifyExportCompatibilitySchema(sourceSchema.compatibilityColumns);
  const columns = exportCompatibilityColumns(schema);
  const samples = inspectRows(tables.samples, columns.samples, "samples");
  const occurrences = inspectRows(tables.run_step_comments, columns.run_step_comments, "run_step_comments");
  const retiredFields: RetiredExportFields = {
    version: 1,
    samplesProcessRevision: retired(samples, "process_revision", schema !== "S2", (value): value is number => typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))),
    runStepCommentsBody: retired(occurrences, "body", schema !== "S2", (value): value is string => typeof value === "string"),
  };
  const logicalTables: ExportTables = {
    ...tables,
    samples: samples.map((row) => Object.fromEntries(Object.entries(row).filter(([name]) => name !== "process_revision"))),
    run_step_comments: occurrences.map((row) => {
      ensure(row.submission_id === null || typeof row.submission_id === "string" && row.submission_id.length > 0, "invalid Comment ownership");
      const body = row.submission_id === null ? row[schema === "S0" ? "body" : "legacy_body"] : null;
      ensure(row.submission_id !== null || typeof body === "string", "missing operational legacy text");
      ensure(schema === "S0" || row.submission_id === null || row.legacy_body === null, "canonical occurrence contains legacy text");
      return { ...Object.fromEntries(Object.entries(row).filter(([name]) => name !== "body" && name !== "legacy_body")), legacy_body: body };
    }),
  };
  return { schema, tables: logicalTables, retiredFields };
}

function restoreField<T extends ExportCell>(field: RetiredExportField<T>, rows: ExportRow[], name: string, required: boolean, valid: (value: ExportCell) => value is T) {
  ensure(field && typeof field.presentInSourceSchema === "boolean" && field.complete === field.presentInSourceSchema, `${name} has inconsistent availability`);
  ensure(Number.isSafeInteger(field.sourceRowCount) && field.sourceRowCount === rows.length && Array.isArray(field.values)
    && field.values.length === (field.presentInSourceSchema ? rows.length : 0), `${name} coverage is incomplete`);
  if (!field.presentInSourceSchema) {
    ensure(!required, `${name} is unavailable for the requested physical target`);
    return new Map<string, T>();
  }
  const ids = new Set(rows.map((row) => row.id));
  const values = new Map<string, T>();
  for (const item of field.values) {
    ensure(item && typeof item.id === "string" && ids.has(item.id) && !values.has(item.id) && valid(item.value), `${name} has invalid identity or value`);
    values.set(item.id, item.value);
  }
  return values;
}

// Used by an isolated recovery tool after validating archive inventory,
// artifacts, hashes and the explicitly selected target schema fingerprint.
export function restoreCompatibilityRows(tables: ExportTables, retiredFields: RetiredExportFields, target: CompatibilitySchema): ExportTables {
  ensure(["S0", "S1", "S2"].includes(target), "unknown recovery target");
  ensure(retiredFields?.version === 1, "unsupported retired-field evidence");
  const logicalColumns = exportCompatibilityColumns("S2");
  const samples = inspectRows(tables.samples, logicalColumns.samples, "samples");
  const occurrences = inspectRows(tables.run_step_comments, logicalColumns.run_step_comments, "run_step_comments");
  for (const row of occurrences) ensure(row.submission_id === null ? typeof row.legacy_body === "string" : typeof row.submission_id === "string" && row.submission_id.length > 0 && row.legacy_body === null, "invalid operational Comment text ownership");
  const counters = restoreField(retiredFields.samplesProcessRevision, samples, "process_revision", target !== "S2", (value): value is number => typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));
  const bodies = restoreField(retiredFields.runStepCommentsBody, occurrences, "run_step_comments.body", target !== "S2", (value): value is string => typeof value === "string");
  ensure(retiredFields.samplesProcessRevision.presentInSourceSchema === retiredFields.runStepCommentsBody.presentInSourceSchema, "retired families describe different compatibility states");
  if (target === "S2") return { ...tables, samples: samples.map((row) => ({ ...row })), run_step_comments: occurrences.map((row) => ({ ...row })) };
  return {
    ...tables,
    samples: samples.map((row) => ({ ...row, process_revision: counters.get(row.id as string)! })),
    run_step_comments: occurrences.map((row) => {
      const body = bodies.get(row.id as string)!;
      ensure(target !== "S0" || row.submission_id !== null || body === row.legacy_body, "S0 cannot preserve recorded body and readable legacy text together");
      return { ...Object.fromEntries(Object.entries(row).filter(([name]) => target !== "S0" || name !== "legacy_body")), body };
    }),
  };
}

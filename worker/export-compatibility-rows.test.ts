import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ExportTables, ObservedExportSchema } from "../shared/contracts/export";
import { classifyExportCompatibilitySchema, projectCompatibilitySnapshot, restoreCompatibilityRows } from "../shared/contracts/export-compatibility";
import { referenceTestDatabase, seedReferenceGraph } from "./reference-test-support";

function snapshot(database: DatabaseSync) {
  const names = ["samples", "run_step_comments", "comment_submissions"];
  const tables = Object.fromEntries(names.map((name) => [name, database.prepare(`SELECT * FROM ${name} ORDER BY id`).all()])) as ExportTables;
  const columns = (table: string) => database.prepare(`PRAGMA table_xinfo(${table})`).all().map((row) => row.name as string);
  const sourceSchema: ObservedExportSchema = {
    version: 1, kind: "observed-sqlite-schema",
    objects: database.prepare("SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema ORDER BY type, name").all() as unknown as ObservedExportSchema["objects"],
    compatibilityColumns: { samples: columns("samples"), run_step_comments: columns("run_step_comments") },
  };
  return { tables, sourceSchema };
}

function fixture() {
  const database = referenceTestDatabase();
  seedReferenceGraph(database);
  database.exec(`
    UPDATE samples SET process_revision = 37 WHERE id = 'reference-sample-a';
    UPDATE samples SET process_revision = -2 WHERE id = 'reference-sample-b';
    UPDATE run_step_comments SET body = 'Original duplicate, retained verbatim';
    INSERT INTO run_step_comments (id, run_step_id, scope, body, created_at)
      VALUES ('legacy-text', 'reference-step-a', 'individual', 'Legacy original', '2026-08-01T06:00:00.000Z'),
             ('legacy-image', 'reference-step-a', 'individual', '', '2026-08-01T07:00:00.000Z');
  `);
  return database;
}

function expandedColumns(database: DatabaseSync) {
  // This fixture qualifies row-shape conversion, not the later transactional
  // table rebuild/default/triggers required to deploy Stage B.
  database.exec(`ALTER TABLE run_step_comments ADD COLUMN legacy_body TEXT;
    UPDATE run_step_comments SET legacy_body = CASE WHEN submission_id IS NULL THEN body ELSE NULL END;
    UPDATE run_step_comments SET body = '' WHERE submission_id IS NOT NULL;`);
}

describe("lossless compatibility row projection before v8 activation", () => {
  it("projects S0 and restores its exact original rows including nonzero and negative retired counters", () => {
    const database = fixture();
    try {
      const input = snapshot(database);
      const original = structuredClone(input);
      const logical = projectCompatibilitySnapshot(input.tables, input.sourceSchema);
      expect(logical.schema).toBe("S0");
      expect(logical.retiredFields.samplesProcessRevision.values).toEqual(expect.arrayContaining([
        { id: "reference-sample-a", value: 37 }, { id: "reference-sample-b", value: -2 },
      ]));
      expect(logical.tables.run_step_comments.find((row) => row.id === "legacy-text")?.legacy_body).toBe("Legacy original");
      expect(logical.tables.run_step_comments.find((row) => row.id === "legacy-image")?.legacy_body).toBe("");
      expect(logical.tables.run_step_comments.filter((row) => row.submission_id !== null).every((row) => row.legacy_body === null && !("body" in row))).toBe(true);
      expect(restoreCompatibilityRows(logical.tables, logical.retiredFields, "S0")).toEqual(input.tables);
      expect(restoreCompatibilityRows(logical.tables, logical.retiredFields, "S2")).toEqual(logical.tables);
      const expanded = restoreCompatibilityRows(logical.tables, logical.retiredFields, "S1");
      expect(expanded.run_step_comments.map((row) => row.body)).toEqual(input.tables.run_step_comments.map((row) => row.body));
      expect(expanded.run_step_comments.map((row) => row.legacy_body)).toEqual(logical.tables.run_step_comments.map((row) => row.legacy_body));
      expect(input).toEqual(original);
    } finally { database.close(); }
  });

  it("preserves S1 placeholders and rejects S0 when a later legacy-only write would lose readable text", () => {
    const database = fixture();
    try {
      expandedColumns(database);
      let input = snapshot(database);
      let logical = projectCompatibilitySnapshot(input.tables, input.sourceSchema);
      expect(logical.schema).toBe("S1");
      expect(restoreCompatibilityRows(logical.tables, logical.retiredFields, "S1")).toEqual(input.tables);
      const s0 = restoreCompatibilityRows(logical.tables, logical.retiredFields, "S0");
      expect(s0.run_step_comments.filter((row) => row.submission_id !== null).every((row) => row.body === "")).toBe(true);
      database.exec("UPDATE run_step_comments SET body = '' WHERE id = 'legacy-text'");
      input = snapshot(database);
      logical = projectCompatibilitySnapshot(input.tables, input.sourceSchema);
      expect(() => restoreCompatibilityRows(logical.tables, logical.retiredFields, "S0")).toThrow("S0 cannot preserve recorded body and readable legacy text together");
      expect(restoreCompatibilityRows(logical.tables, logical.retiredFields, "S1")).toEqual(input.tables);
      expect(restoreCompatibilityRows(logical.tables, logical.retiredFields, "S2").run_step_comments.find((row) => row.id === "legacy-text")?.legacy_body).toBe("Legacy original");
    } finally { database.close(); }
  });

  it("records absence after contraction and never manufactures retired fields for S0 or S1", () => {
    const database = fixture();
    try {
      expandedColumns(database);
      database.exec("ALTER TABLE run_step_comments DROP COLUMN body; ALTER TABLE samples DROP COLUMN process_revision;");
      const input = snapshot(database);
      const logical = projectCompatibilitySnapshot(input.tables, input.sourceSchema);
      expect(logical.schema).toBe("S2");
      expect(logical.retiredFields.samplesProcessRevision).toEqual({ presentInSourceSchema: false, complete: false, sourceRowCount: input.tables.samples.length, values: [] });
      expect(logical.retiredFields.runStepCommentsBody).toEqual({ presentInSourceSchema: false, complete: false, sourceRowCount: input.tables.run_step_comments.length, values: [] });
      expect(restoreCompatibilityRows(logical.tables, logical.retiredFields, "S2")).toEqual(input.tables);
      for (const target of ["S0", "S1"] as const) expect(() => restoreCompatibilityRows(logical.tables, logical.retiredFields, target)).toThrow("unavailable");
    } finally { database.close(); }
  });

  it.each(["missing", "duplicate", "foreign", "invalid", "incorrect count", "false completeness", "mixed families"])("rejects %s retired evidence before any SQL write", (kind) => {
    const database = fixture();
    try {
      const input = snapshot(database);
      const logical = projectCompatibilitySnapshot(input.tables, input.sourceSchema);
      const field = logical.retiredFields.samplesProcessRevision;
      if (kind === "missing") field.values.pop();
      if (kind === "duplicate") field.values[1] = field.values[0];
      if (kind === "foreign") field.values[0].id = "foreign-sample";
      if (kind === "invalid") field.values[0].value = NaN;
      if (kind === "incorrect count") field.sourceRowCount += 1;
      if (kind === "false completeness") field.complete = false;
      if (kind === "mixed families") { field.presentInSourceSchema = false; field.complete = false; field.values = []; }
      for (const target of ["S0", "S1", "S2"] as const) expect(() => restoreCompatibilityRows(logical.tables, logical.retiredFields, target)).toThrow("Export compatibility rejected");
      expect(snapshot(database)).toEqual(input);
    } finally { database.close(); }
  });

  it("rejects unknown columns, shape disagreement and invalid legacy ownership rather than silently dropping data", () => {
    const database = fixture();
    try {
      const input = snapshot(database);
      input.sourceSchema.compatibilityColumns.samples.push("unknown_new_field");
      expect(() => classifyExportCompatibilitySchema(input.sourceSchema.compatibilityColumns)).toThrow("unrecognized");
      expect(() => projectCompatibilitySnapshot(input.tables, input.sourceSchema)).toThrow("unrecognized");
      const good = snapshot(database);
      delete good.tables.samples[0].process_revision;
      expect(() => projectCompatibilitySnapshot(good.tables, good.sourceSchema)).toThrow("columns differ");
      expandedColumns(database);
      database.exec("UPDATE run_step_comments SET legacy_body = NULL WHERE id = 'legacy-text'");
      const missingLegacy = snapshot(database);
      expect(() => projectCompatibilitySnapshot(missingLegacy.tables, missingLegacy.sourceSchema)).toThrow("missing operational legacy text");
      database.exec("UPDATE run_step_comments SET legacy_body = 'Legacy original' WHERE id = 'legacy-text'; UPDATE run_step_comments SET legacy_body = 'wrong owner' WHERE submission_id IS NOT NULL");
      const wrongOwner = snapshot(database);
      expect(() => projectCompatibilitySnapshot(wrongOwner.tables, wrongOwner.sourceSchema)).toThrow("canonical occurrence contains legacy text");
    } finally { database.close(); }
  });

  it("keeps empty-table availability distinct from physical absence", () => {
    const database = referenceTestDatabase();
    try {
      const input = snapshot(database);
      // Built-in templates exist, while these compatibility tables are empty.
      expect(input.tables.samples).toEqual([]);
      expect(input.tables.run_step_comments).toEqual([]);
      const logical = projectCompatibilitySnapshot(input.tables, input.sourceSchema);
      expect(logical.retiredFields.samplesProcessRevision).toEqual({ presentInSourceSchema: true, complete: true, sourceRowCount: 0, values: [] });
      expect(restoreCompatibilityRows(logical.tables, logical.retiredFields, "S0")).toEqual(input.tables);
    } finally { database.close(); }
  });
});

import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { FILE_AUTHORITY_EXPORT_VIEW_COLUMNS } from "../shared/contracts/export-file-authority";
import { validateFileNativeRetention } from "../shared/contracts/export-file-native-retention";
import type { ExportTables } from "../shared/contracts/export";
import { checkedNativeRetentionSnapshot, NATIVE_RETENTION_SNAPSHOT_QUERY, NATIVE_RETENTION_VIEW_NAMES } from "./export-native-retention-snapshot";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach(sql => sql.close()));
const emptyTables = () => Object.fromEntries(["state_representation_assets", "run_step_assets", "metrology_template_references", "run_step_comments", "state_verifications",
  "assets", "comment_submissions", "comment_submission_items", "project_content_attachments", "attachment_derivatives", "events", "imports", "template_versions",
  "file_relational_retention_edges", "file_content_retention_edges", "file_direct_retention_edges", "file_retention_edges", "file_shadow_heads", "file_shadow_decisions",
  "file_holds", "file_acceptance_candidates", "file_location_holds", "file_location_retention_edges", "file_publications", "file_locations"].map(name => [name, []])) as ExportTables;

it("materializes all retention rows and its clock before streaming small per-edge values", () => {
  const sql = new DatabaseSync(":memory:"); databases.push(sql);
  const columns = { blob_retention_edges: ["store_kind", "provider", "object_key", "blob_record_id", "source_type", "source_id", "occurrence_type", "occurrence_id", "retention_reason", "retain_until"],
    ...Object.fromEntries(Object.entries(FILE_AUTHORITY_EXPORT_VIEW_COLUMNS).filter(([name]) => NATIVE_RETENTION_VIEW_NAMES.has(name))) };
  let clock = 0;
  // Advance the host's clock function on each invocation. MATERIALIZED rows
  // still finish before the first returned edge; this emulates a grace boundary
  // while the result consumer takes arbitrarily long to drain the statement.
  sql.function("strftime", { varargs: true }, () => `2026-10-05T12:00:00.${String(clock++).padStart(3, "0")}Z`);
  for (const [name, names] of Object.entries(columns)) {
    sql.exec(`CREATE TABLE ${name}(${names.map(column => `${column} TEXT`).join(",")})`);
    const insert = sql.prepare(`INSERT INTO ${name} VALUES(${names.map(() => "?").join(",")})`);
    insert.run(...names.map(column => column === "retain_until" ? null : `${name}:${column}`));
  }
  const iterator = sql.prepare(NATIVE_RETENTION_SNAPSHOT_QUERY).iterate();
  const first = iterator.next();
  expect(clock).toBe(1);
  const rows = [first.value, ...iterator];
  expect(clock).toBe(1);
  const snapshot = checkedNativeRetentionSnapshot(rows);
  expect(snapshot.snapshotClock).toBe("2026-10-05T12:00:00.000Z");
  expect(Object.values(snapshot.tables).every(rows => rows.length === 1)).toBe(true);
  expect(rows.every(row => row.row_json === null || String(row.row_json).length < 1024)).toBe(true);
  expect(() => checkedNativeRetentionSnapshot(rows.map((row, index) => index === 1 ? { ...row, snapshot_clock: "2026-10-05T12:00:00.001Z" } : row))).toThrow("clocks differ");
});

it("preserves nested compound-view multiplicity above SQLite's flattened 500-term limit", () => {
  const sql = new DatabaseSync(":memory:"); databases.push(sql);
  const columns = { blob_retention_edges: ["store_kind", "provider", "object_key", "blob_record_id", "source_type", "source_id", "occurrence_type", "occurrence_id", "retention_reason", "retain_until"],
    ...Object.fromEntries(Object.entries(FILE_AUTHORITY_EXPORT_VIEW_COLUMNS).filter(([name]) => NATIVE_RETENTION_VIEW_NAMES.has(name))) };
  const expanded: string[] = [];
  for (const [name, names] of Object.entries(columns)) {
    const branch = `SELECT ${names.map(column => column === "retain_until" ? `NULL AS ${column}` : `'${name}:${column}' AS ${column}`).join(",")}`;
    sql.exec(`CREATE VIEW ${name}_branches AS ${Array.from({ length: 96 }, () => branch).join(" UNION ALL ")}`);
    sql.exec(`CREATE VIEW ${name} AS SELECT * FROM ${name}_branches`);
    const json = `json_object(${names.map(column => `'${column}',${column}`).join(",")})`;
    expanded.push(...Array.from({ length: 96 }, () => `SELECT '${name}' AS archive_view,${json} AS row_json FROM (${branch})`));
  }
  // This is the semantically equivalent expansion D1 must not combine into
  // one compound select. Each individual view stays safely under the limit.
  expect(expanded.length).toBeGreaterThan(500);
  expect(() => sql.prepare(expanded.join(" UNION ALL "))).toThrow("too many terms in compound SELECT");
  const result = checkedNativeRetentionSnapshot(sql.prepare(NATIVE_RETENTION_SNAPSHOT_QUERY).all());
  for (const name of Object.keys(columns)) expect(result.tables[name]).toEqual(sql.prepare(`SELECT * FROM ${name}`).all());
  expect(Object.values(result.tables).every(rows => rows.length === 96)).toBe(true);
});

it.each([0, 1, 2, 4, 8, 16, 32, 21, 63])("matches each source multiset with empty-view mask %i and one clock sentinel", mask => {
  const sql = new DatabaseSync(":memory:"); databases.push(sql);
  const columns = { blob_retention_edges: ["store_kind", "provider", "object_key", "blob_record_id", "source_type", "source_id", "occurrence_type", "occurrence_id", "retention_reason", "retain_until"],
    ...Object.fromEntries(Object.entries(FILE_AUTHORITY_EXPORT_VIEW_COLUMNS).filter(([name]) => NATIVE_RETENTION_VIEW_NAMES.has(name))) };
  let clockCalls = 0;
  sql.function("strftime", { varargs: true }, () => { clockCalls++; return "2026-10-05T12:00:00.000Z"; });
  for (const [index, [name, names]] of Object.entries(columns).entries()) {
    sql.exec(`CREATE TABLE ${name}(${names.map(column => `${column} TEXT`).join(",")})`);
    if (!(mask & (1 << index))) continue;
    const insert = sql.prepare(`INSERT INTO ${name} VALUES(${names.map(() => "?").join(",")})`);
    // Two identical rows and a different row exercise bag semantics rather
    // than the DISTINCT semantics of a set union.
    for (const value of ["duplicate", "duplicate", "distinct"])
      insert.run(...names.map(column => column === "retain_until" ? null : `${name}:${column}:${value}`));
  }
  const rows = sql.prepare(NATIVE_RETENTION_SNAPSHOT_QUERY).all();
  const snapshot = checkedNativeRetentionSnapshot(rows);
  expect(clockCalls).toBe(1);
  expect(rows.filter(row => row.archive_view === null && row.row_json === null)).toHaveLength(1);
  const sorted = (values: unknown[]) => values.map(value => JSON.stringify(value)).sort();
  for (const name of Object.keys(columns))
    expect(sorted(snapshot.tables[name])).toEqual(sorted(sql.prepare(`SELECT * FROM ${name}`).all()));
});

it("requires exact live physical roots at the source clock and rejects expired or duplicate roots", () => {
  const clock = "2026-10-05T12:00:00.000Z";
  const tables = emptyTables();
  tables.file_authority_control = [{ mode: "active" }];
  tables.file_locations = [{ id: "location", file_id: "file" }];
  tables.file_location_holds = [{ id: "expired", location_id: "location", operation_id: "operation", hold_kind: "read", released_at: null, expires_at: clock }];
  expect(() => validateFileNativeRetention(tables, clock)).not.toThrow();
  const holdEdge = { location_id: "location", file_id: "file", source_type: "file_location", source_id: "location",
    occurrence_type: "file_location_hold", occurrence_id: "expired", retention_reason: "read", retain_until: clock };
  tables.file_location_retention_edges = [holdEdge];
  expect(() => validateFileNativeRetention(tables, clock)).toThrow("forged or duplicate root");
  tables.file_location_retention_edges = [];
  tables.file_location_holds[0].expires_at = "2026-10-05T12:00:00.0004Z";
  expect(() => validateFileNativeRetention(tables, clock)).not.toThrow();
  tables.file_location_holds[0].expires_at = "2026-10-05T12:00:00.0005Z";
  expect(() => validateFileNativeRetention(tables, clock)).toThrow("missing live root");
  const sql = new DatabaseSync(":memory:"); databases.push(sql);
  expect(sql.prepare("SELECT julianday(?)=julianday(?) AS same,julianday(?)>julianday(?) AS live")
    .get("2026-10-05T12:00:00.0004Z", clock, "2026-10-05T12:00:00.0005Z", clock)).toEqual({ same: 1, live: 1 });
  tables.file_location_holds[0].expires_at = "2026-10-05T12:00:00.001Z";
  expect(() => validateFileNativeRetention(tables, clock)).toThrow("missing live root");
  tables.file_location_retention_edges = [{ ...holdEdge, retain_until: "2026-10-05T12:00:00.001Z" }];
  expect(() => validateFileNativeRetention(tables, clock)).not.toThrow();
  tables.file_location_retention_edges.push({ ...tables.file_location_retention_edges[0] });
  expect(() => validateFileNativeRetention(tables, clock)).toThrow("duplicate root");
  tables.file_location_retention_edges = []; tables.file_location_holds = [];
  tables.comment_submissions = [{ id: "comment", status: "failed", retry_closed_at: null, retry_until: "2026-10-04T12:00:00.000Z" }];
  tables.comment_submission_items = [{ id: "item", submission_id: "comment", status: "failed", file_id: "file", deleted_at: null }];
  const retry = { file_id: "file", source_type: "comment_submission", source_id: "comment", occurrence_type: "comment_submission_item",
    occurrence_id: "item", retention_reason: "retryable_comment_item", retain_until: "2026-10-04T12:00:00.000Z" };
  tables.file_content_retention_edges = [retry]; tables.file_retention_edges = [retry];
  expect(() => validateFileNativeRetention(tables, clock)).not.toThrow();
  tables.file_content_retention_edges = []; tables.file_retention_edges = [];
  expect(() => validateFileNativeRetention(tables, clock)).toThrow("missing live root");
});

it.each(["UTC", "Asia/Shanghai", "America/Los_Angeles"])("matches SQLite raw timestamps and explicit offsets in %s", zone => {
  const previous = process.env.TZ; process.env.TZ = zone;
  try {
    const sql = new DatabaseSync(":memory:"); databases.push(sql);
    const clock = "2026-10-05T12:00:00.000Z", tables = emptyTables();
    const expiry = sql.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ',?,'+1 day') AS expiry")
      .get("2026-10-04 12:00:00.001")!.expiry;
    tables.file_authority_control = [{ mode: "active" }];
    tables.file_locations = [{ id: "location", file_id: "file" }];
    tables.file_publications = [{ file_id: "file", active_location_id: "location", state: "ready" }];
    tables.run_step_assets = [{ file_id: "file", run_step_id: "step", id: "run-attachment",
      superseded_by_occurrence_id: null, deleted_at: "2026-10-04 12:00:00.001" }];
    tables.file_relational_retention_edges = [{ file_id: "file", source_type: "run_step", source_id: "step",
      occurrence_type: "run_step_asset", occurrence_id: "run-attachment", retention_reason: "deleted_run_step_asset_grace", retain_until: expiry }];
    tables.comment_submissions = [{ id: "comment", status: "ready" }];
    tables.comment_submission_items = [{ id: "item", submission_id: "comment", status: "ready", file_id: "file",
      deleted_at: "2026-10-04T20:00:00.001+08:00" }];
    tables.file_content_retention_edges = [{ file_id: "file", source_type: "comment_submission", source_id: "comment",
      occurrence_type: "comment_submission_item", occurrence_id: "item", retention_reason: "deleted_comment_item_grace", retain_until: expiry }];
    tables.file_retention_edges = [...tables.file_relational_retention_edges, ...tables.file_content_retention_edges];
    tables.file_location_holds = ["expired", "live"].map(id => ({ id, location_id: "location", hold_kind: "read", released_at: null,
      expires_at: id === "live" ? "2026-10-05 12:00:00.001" : "2026-10-05 12:00:00" }));
    const live = { location_id: "location", file_id: "file", source_type: "file_location", source_id: "location",
      occurrence_type: "file_location_hold", occurrence_id: "live", retention_reason: "read", retain_until: "2026-10-05 12:00:00.001" };
    tables.file_location_retention_edges = [...tables.file_retention_edges.map(row => ({ location_id: "location", ...row })), live];
    expect(() => validateFileNativeRetention(tables, clock)).not.toThrow();
    tables.file_location_retention_edges.pop();
    expect(() => validateFileNativeRetention(tables, clock)).toThrow("missing live root");
    tables.file_location_retention_edges.push(live, { ...live, occurrence_id: "expired", retain_until: "2026-10-05 12:00:00" });
    expect(() => validateFileNativeRetention(tables, clock)).toThrow("forged or duplicate root");
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

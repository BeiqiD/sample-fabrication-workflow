import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const referenceGraphSql = readFileSync(
  new URL("./fixtures/reference-graph.sql", import.meta.url),
  "utf8",
);

export class SqliteD1Statement {
  constructor(
    private readonly owner: SqliteD1Database,
    private readonly sql: string,
    private readonly bindings: unknown[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new SqliteD1Statement(this.owner, this.sql, values);
  }

  async all<T>() {
    this.owner.recordQuery();
    return {
      results: this.owner.compiledStatement(this.sql).all(...this.bindings) as T[],
      success: true,
      meta: { changes: 0 },
    };
  }

  async first<T>() {
    this.owner.recordQuery();
    return (this.owner.compiledStatement(this.sql).get(...this.bindings) as T | undefined) ?? null;
  }

  async run() {
    this.owner.recordQuery();
    return this.execute();
  }

  execute() {
    const statement = this.owner.compiledStatement(this.sql);
    if (statement.columns().length > 0) {
      const before = Number(this.owner.compiledStatement("SELECT total_changes() AS count").get()?.count);
      const results = statement.all(...this.bindings);
      return {
        results,
        success: true,
        meta: { changes: Number(this.owner.compiledStatement("SELECT total_changes() AS count").get()?.count) - before },
      };
    }
    const result = statement.run(...this.bindings);
    return { results: [], success: true, meta: { changes: Number(result.changes) } };
  }
}

export class SqliteD1Database {
  queryCount = 0;
  private readonly compiled = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  constructor(readonly database: DatabaseSync) {}

  /** Native D1 reuses repeated SQL preparation in the measured fixture. Match
   * that behavior with a bounded connection-local cache, without caching any
   * results or changing execution counts. SQLite retains automatic schema
   * recompilation; these timings are not a remote performance guarantee. */
  compiledStatement(sql: string) {
    let statement = this.compiled.get(sql);
    if (statement) this.compiled.delete(sql);
    else statement = this.database.prepare(sql);
    this.compiled.set(sql, statement);
    if (this.compiled.size > 256) this.compiled.delete(this.compiled.keys().next().value!);
    return statement;
  }

  recordQuery() {
    this.queryCount += 1;
  }

  prepare(sql: string) {
    return new SqliteD1Statement(this, sql);
  }

  async batch(statements: D1PreparedStatement[]) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => {
        this.recordQuery();
        return (statement as unknown as SqliteD1Statement).execute();
      });
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  resetQueryCount() {
    this.queryCount = 0;
  }
}

export function referenceTestDatabase(options: { throughMigration?: string } = {}) {
  const database = new DatabaseSync(":memory:");
  const migrationDirectory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")
    && (!options.throughMigration || name <= options.throughMigration)).sort()) {
    database.exec(readFileSync(new URL(filename, migrationDirectory), "utf8"));
  }
  return database;
}

export const REFERENCE_FIXTURE_IDS = {
  sampleA: "reference-sample-a",
  sampleB: "reference-sample-b",
  runA: "reference-run-a",
  runB: "reference-run-b",
  stepA: "reference-step-a",
  stepB: "reference-step-b",
  comment: "reference-comment",
  commentOccurrenceA: "reference-comment-occurrence-a",
  commentOccurrenceB: "reference-comment-occurrence-b",
  commentAttachment: "reference-comment-attachment",
  executionImage: "reference-execution-image",
  metrologyReference: "reference-metrology-reference",
  recipeRevision: "reference-process-template",
  metrologyRevision: "reference-metrology-template",
} as const;

export function seedReferenceGraph(database: DatabaseSync) {
  database.exec(referenceGraphSql);
  return REFERENCE_FIXTURE_IDS;
}

/** Historical archive/migration fixtures only; business API tests use referenceTestDatabase. */
export function historicalReferenceTestDatabase() {
  const database = new DatabaseSync(":memory:");
  const directory = new URL("../migrations-history/s0/", import.meta.url);
  for (const filename of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(filename, directory), "utf8"));
  }
  return database;
}

export function seedHistoricalReferenceGraph(database: DatabaseSync) {
  database.exec(readFileSync(new URL("./fixtures/reference-graph-s0.sql", import.meta.url), "utf8"));
  return REFERENCE_FIXTURE_IDS;
}

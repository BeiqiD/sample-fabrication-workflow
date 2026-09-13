import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { sqliteTableColumns } from "../shared/domain/sqlite-table-columns";
import { referenceTestDatabase } from "./reference-test-support";

describe("recorded SQLite table column parsing without executing archive SQL", () => {
  it("matches actual migrated compatibility tables and subsequent column additions/removals", () => {
    const database = referenceTestDatabase();
    try {
      const check = () => {
        for (const { name: table } of database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>) {
          const sql = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)!.sql as string;
          const names = database.prepare(`PRAGMA table_xinfo(${table})`).all().map((row) => row.name);
          expect(sqliteTableColumns(sql, table)).toEqual(names);
        }
      };
      check();
      database.exec("ALTER TABLE run_step_comments ADD COLUMN legacy_body TEXT;");
      check();
      database.exec("ALTER TABLE run_step_comments DROP COLUMN body; ALTER TABLE samples DROP COLUMN process_revision;");
      check();
    } finally { database.close(); }
  });

  it("matches quoted names, Unicode identifiers, comments, nested defaults and table constraints", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`CREATE TABLE sample (
        id TEXT PRIMARY KEY,
        "name, with ) punctuation" TEXT DEFAULT '(),',
        'single''quote' TEXT,
        [bracket] TEXT,
        \`backtick\` TEXT,
        a b TEXT,
        a😀b TEXT,
        "CHECK" TEXT,
        generated TEXT AS (coalesce(id, printf('%s,%s', '(', ')'))),
        /* not_a_column TEXT, */
        CONSTRAINT id_shape CHECK (length(id) > 0),
        UNIQUE ("name, with ) punctuation"),
        FOREIGN KEY (id) REFERENCES sample(id)
      ) WITHOUT ROWID;`);
      const sql = database.prepare("SELECT sql FROM sqlite_schema WHERE name = 'sample'").get()!.sql as string;
      expect(sqliteTableColumns(sql, "sample")).toEqual(database.prepare("PRAGMA table_xinfo(sample)").all().map((row) => row.name));
    } finally { database.close(); }
  });

  it.each(["CREATE TABLE other (id TEXT)", "CREATE TABLE sample AS SELECT 1 AS id", "CREATE TABLE sample (id TEXT); DROP TABLE sample", "CREATE TABLE sample (id TEXT /* unclosed)", "CREATE TABLE sample (id TEXT, 'unclosed)"])("rejects a wrong, incomplete or compound recorded definition: %s", (sql) => {
    expect(() => sqliteTableColumns(sql, "sample")).toThrow("Invalid recorded SQLite table definition");
  });
});

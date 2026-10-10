import type { DatabaseSync } from "node:sqlite";

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** Compare the complete SQLite fixture, including hidden int64 rowids and
 * native cell types. This observes data; it does not cache or normalize it. */
export function sqliteFixtureImage(database: DatabaseSync) {
  const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
    .all() as { name: string }[];
  const withoutRowid = new Set((database.prepare("PRAGMA table_list").all() as { name: string; wr: number }[])
    .filter((table) => table.wr === 1).map((table) => table.name));
  return { schema, tables: Object.fromEntries(tables.map(({ name }) => {
    const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as { name: string; pk: number }[];
    const primaryKey = columns.filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk).map((column) => quoteIdentifier(column.name));
    const storageTypes = columns.map((column, index) =>
      `typeof(${quoteIdentifier(column.name)}) AS ${quoteIdentifier(`_fixture_type_${index}`)}`).join(",");
    const rows = database.prepare(withoutRowid.has(name)
      ? `SELECT *,${storageTypes} FROM ${quoteIdentifier(name)} ORDER BY ${primaryKey.join(",")}`
      : `SELECT rowid AS _fixture_rowid,*,${storageTypes} FROM ${quoteIdentifier(name)} ORDER BY rowid`);
    rows.setReadBigInts(true);
    return [name, rows.all()];
  })) };
}

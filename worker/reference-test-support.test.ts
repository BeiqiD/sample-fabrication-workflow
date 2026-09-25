import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { SqliteD1Database } from "./reference-test-support";

it("reexecutes cached SQL with fresh bindings and recompiles after schema or trigger changes", async () => {
  const sql = new DatabaseSync(":memory:"), db = new SqliteD1Database(sql);
  try {
    sql.exec("CREATE TABLE fixture(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO fixture VALUES(1,'one'),(2,'two')");
    const read = db.prepare("SELECT * FROM fixture WHERE id=?");
    const update = db.prepare("UPDATE fixture SET value=? WHERE id=?");
    expect(await read.bind(1).first()).toEqual({ id: 1, value: "one" });
    await update.bind("changed", 2).run();
    expect(await read.bind(2).first()).toEqual({ id: 2, value: "changed" });
    sql.exec("ALTER TABLE fixture ADD COLUMN marker TEXT DEFAULT 'new'; CREATE TRIGGER marker_update AFTER UPDATE OF value ON fixture BEGIN UPDATE fixture SET marker=NEW.value WHERE id=NEW.id; END");
    await update.bind("triggered", 1).run();
    expect(await read.bind(1).first()).toEqual({ id: 1, value: "triggered", marker: "triggered" });
    sql.exec("DROP TRIGGER marker_update");
    await update.bind("after-drop", 1).run();
    expect(await read.bind(1).first()).toEqual({ id: 1, value: "after-drop", marker: "triggered" });
    await expect(db.batch([update.bind("must-rollback", 1), db.prepare("INSERT INTO fixture(id,value) VALUES(1,'duplicate')")] as unknown as D1PreparedStatement[])).rejects.toThrow(/UNIQUE/);
    expect(await read.bind(1).first()).toEqual({ id: 1, value: "after-drop", marker: "triggered" });
    expect(db.queryCount).toBe(10);
  } finally { sql.close(); }
});

import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import type { LiveConsumerDatabase, LiveConsumerKey } from "./live-consumer-baseline";
import { readShadowBaseline } from "./shadow-baseline";

const databases: DatabaseSync[] = [];
const eventKey: LiveConsumerKey = { consumerKind: "event", consumerId: "event", consumerSubId: "", fileSlot: "primary" };
const createdAt = "2026-01-01T00:00:00.000Z";

function fixture(rowid: string) {
  const sql = referenceTestDatabase();
  databases.push(sql);
  const db = new SqliteD1Database(sql);
  sql.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('s','S','Sample',?,?)").run(createdAt, createdAt);
  sql.prepare("INSERT INTO assets(id,r2_key,original_name,mime_type,byte_size,status,sha256,created_at) VALUES('asset','source','file.png','image/png',1,'ready',?,?)")
    .run("a".repeat(64), createdAt);
  const insert = sql.prepare(`INSERT INTO events(rowid,id,sample_id,kind,asset_key,metadata_json,created_at)
    VALUES(CAST(? AS INTEGER),'event','s','image','source','{"action":"sample_record"}',?)`);
  insert.setReadBigInts(true);
  insert.run(rowid, createdAt);
  return { sql, db };
}

afterEach(() => databases.splice(0).forEach((db) => db.close()));

describe("File shadow baseline physical rowid precision", () => {
  it.each([
    "-9223372036854775808", "-9007199254740993", "-9007199254740992", "-1", "0", "1",
    "9007199254740992", "9007199254740993", "9223372036854775807",
  ])("preserves signed SQLite rowid %s as exact decimal text", async rowid => {
    const { sql, db } = fixture(rowid);
    const baseline = await readShadowBaseline(db, eventKey);
    expect(baseline.head).toMatchObject({ present: 1, source_rowid: rowid });
    expect(sql.prepare("SELECT CAST(rowid AS TEXT) rowid FROM events WHERE id='event'").get()!.rowid).toBe(rowid);
    expect(JSON.parse(JSON.stringify(baseline)).head.source_rowid).toBe(rowid);
    expect(baseline.baselineSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["9007199254740992", "9007199254740993"],
    ["-9007199254740992", "-9007199254740993"],
    ["9223372036854775806", "9223372036854775807"],
  ])("keeps adjacent physical rows %s and %s distinct", async (first, second) => {
    const { sql, db } = fixture(first);
    const before = await readShadowBaseline(db, eventKey);
    const update = sql.prepare("UPDATE events SET rowid=CAST(? AS INTEGER) WHERE id='event'");
    update.setReadBigInts(true);
    update.run(second);
    const after = await readShadowBaseline(db, eventKey);
    expect(before.head!.source_rowid).toBe(first);
    expect(after.head!.source_rowid).toBe(second);
    expect(after.head!.source_sha256).toBe(before.head!.source_sha256);
    expect(after.head!.generation).toBe(before.head!.generation + 1);
    expect(after.head!.occurrence_id).not.toBe(before.head!.occurrence_id);
    expect(after.baselineSha256).not.toBe(before.baselineSha256);
  });

  it("preserves a null source rowid when the source is removed", async () => {
    const { sql, db } = fixture("9223372036854775807");
    sql.exec("DELETE FROM events WHERE id='event'");
    const baseline = await readShadowBaseline(db, eventKey);
    expect(baseline).toMatchObject({ status: "absent", head: { present: 0, source_rowid: null } });
  });

  it("rejects malformed or out-of-range rowids in a baseline snapshot", async () => {
    const { db } = fixture("1");
    for (const rowid of [1, "", "01", "-0", "+1", "1.0", "1e3", "9223372036854775808", "-9223372036854775809"]) {
      const malformed: LiveConsumerDatabase = { prepare(query) {
        const statement = db.prepare(query);
        return { bind(...values) {
          const bound = statement.bind(...values);
          return { bind() { throw new Error("Unexpected rebind"); }, async all<T>() {
            const result = await bound.all<{ shadow_head: string }>();
            const results = result.results.map(row => ({ ...row,
              shadow_head: JSON.stringify({ ...JSON.parse(row.shadow_head), source_rowid: rowid }) }));
            return { ...result, results: results as T[] };
          } };
        }, all() { throw new Error("Expected bound statement"); } };
      } };
      await expect(readShadowBaseline(malformed, eventKey)).rejects.toThrow("Invalid shadow source metadata");
    }
  });
});

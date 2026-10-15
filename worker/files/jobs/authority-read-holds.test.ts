import { afterEach, describe, expect, it, vi } from "vitest";
import { referenceTestDatabase, SqliteD1Database } from "../../reference-test-support";
import { FILE_READ_MAX_LIFETIME_MS, readPublishedFile } from "../authority-reader";
import { openShadowProfile } from "../shadow-profile";
import type { Env } from "../../types";

vi.mock("../shadow-profile", () => ({ openShadowProfile: vi.fn() }));
const databases: ReturnType<typeof referenceTestDatabase>[] = [];
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); databases.splice(0).forEach(db => db.close()); });

function fixture(body: ReadableStream) {
  const sql = referenceTestDatabase(); databases.push(sql);
  const now = new Date().toISOString(), sha = "a".repeat(64);
  const triggers = sql.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all() as { name: string; sql: string }[];
  triggers.forEach(trigger => sql.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`));
  sql.prepare("UPDATE file_authority_control SET mode='active',activated_at=?,updated_at=?").run(now, now);
  sql.prepare("INSERT INTO storage_profiles VALUES('profile','r2','fixture','bootstrap',NULL,1,'historical',?)").run(now);
  sql.prepare("INSERT INTO storage_profile_runtime VALUES('profile','read_write',?,?,NULL)").run(now, now);
  sql.prepare("INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at) VALUES('file','embedded_content','system',4,?,'unresolved',?)")
    .run(sha, now);
  for (const location of ["old", "new"]) {
    sql.prepare("INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at) VALUES(?,'file','profile',?,'unresolved',?)").run(location, location, now);
    sql.prepare("INSERT INTO file_location_publications VALUES(?,'file','profile',?,4,?,'full_read_sha256','fixture',?,?)").run(location, location, sha, now, now);
  }
  sql.prepare("INSERT INTO file_publications VALUES('file','embedded_content','system',4,?,'old','ready',?,NULL)").run(sha, now);
  triggers.forEach(trigger => sql.exec(trigger.sql));
  const read = vi.fn(async () => ({ outcome: "available" as const, body, contentType: "text/plain", etag: null, httpMetadata: {} }));
  vi.mocked(openShadowProfile).mockResolvedValue({ reader: { read, stat: vi.fn() } } as unknown as Awaited<ReturnType<typeof openShadowProfile>>);
  const env = { DB: new SqliteD1Database(sql) as unknown as D1Database } as Env;
  const hold = () => sql.prepare("SELECT * FROM file_location_holds WHERE hold_kind='read'").get();
  return { sql, env, read, hold };
}

describe("published File read location holds", () => {
  it("pins the exact old location across cutover and blocks GC until stream EOF", async () => {
    const f = fixture(new Response("data").body!);
    const result = await readPublishedFile(f.env, { fileId: "file", purpose: "embedded_content" });
    expect(result.outcome).toBe("available");
    expect(f.hold()).toMatchObject({ location_id: "old", released_at: null });
    // Fixture a completed cutover without fabricating provider evidence. Restore
    // all production guards before testing the old stream's native GC fence.
    const guards = f.sql.prepare("SELECT name,sql FROM sqlite_schema WHERE name IN('file_publications_update_guard','file_migration_cutover_fence')").all() as { name: string; sql: string }[];
    guards.forEach(guard => f.sql.exec(`DROP TRIGGER "${guard.name}"`));
    f.sql.exec("UPDATE file_publications SET active_location_id='new' WHERE file_id='file'");
    guards.forEach(guard => f.sql.exec(guard.sql));
    const at = new Date().toISOString();
    const orphan = () => f.sql.prepare("INSERT INTO file_location_gc_ledger(location_id,state,orphaned_at,updated_at) VALUES('old','orphaned',?,?)").run(at, at);
    expect(orphan).toThrow();
    if (result.outcome !== "available") throw new Error("missing fixture stream");
    expect(await new Response(result.body).text()).toBe("data");
    expect(f.hold()!.released_at).not.toBeNull();
    expect(orphan).not.toThrow();
  });

  it("releases the hold on browser cancellation without waiting for EOF", async () => {
    const cancelled = vi.fn();
    const f = fixture(new ReadableStream({ cancel: cancelled }));
    const result = await readPublishedFile(f.env, { fileId: "file", purpose: "embedded_content" });
    if (result.outcome !== "available") throw new Error("missing fixture stream");
    await result.body.cancel();
    expect(cancelled).toHaveBeenCalledOnce(); expect(f.hold()!.released_at).not.toBeNull();
  });

  it("enforces stream lifetime shorter than the durable hold expiry", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const f = fixture(new ReadableStream({ cancel: cancelled }));
    const result = await readPublishedFile(f.env, { fileId: "file", purpose: "embedded_content" });
    if (result.outcome !== "available") throw new Error("missing fixture stream");
    const reader = result.body.getReader(), pending = reader.read();
    const failed = expect(pending).rejects.toThrow("unavailable");
    await vi.advanceTimersByTimeAsync(FILE_READ_MAX_LIFETIME_MS + 1);
    await failed; reader.releaseLock();
    expect(cancelled).toHaveBeenCalledOnce(); expect(f.hold()!.released_at).not.toBeNull();
  });

  it("keeps recovered expired read history while a fresh stream independently protects its captured location", async () => {
    const f = fixture(new ReadableStream());
    f.sql.prepare(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at,expires_at)
      VALUES('historical-read','old','read','historical-reader','Recovered read history',?,?)`)
      .run(new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() - 1800_000).toISOString());
    const result = await readPublishedFile(f.env, { fileId: 'file', purpose: 'embedded_content' });
    if (result.outcome !== 'available') throw new Error('missing fixture stream');
    const guards = f.sql.prepare("SELECT name,sql FROM sqlite_schema WHERE name IN('file_publications_update_guard','file_migration_cutover_fence')").all() as { name: string; sql: string }[];
    guards.forEach(guard => f.sql.exec(`DROP TRIGGER "${guard.name}"`));
    f.sql.exec("UPDATE file_publications SET active_location_id='new' WHERE file_id='file'");
    guards.forEach(guard => f.sql.exec(guard.sql));
    const at = new Date().toISOString();
    const orphan = () => f.sql.prepare("INSERT INTO file_location_gc_ledger(location_id,state,orphaned_at,updated_at) VALUES('old','orphaned',?,?)").run(at, at);
    expect(orphan).toThrow();
    await result.body.cancel();
    expect(orphan).not.toThrow();
    expect(f.sql.prepare("SELECT released_at FROM file_location_holds WHERE id='historical-read'").get()!.released_at).toBeNull();
    expect(f.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

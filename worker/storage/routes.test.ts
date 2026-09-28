import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";

const databases: DatabaseSync[] = [];
const executionContext = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
function fixture() {
  const sql = referenceTestDatabase(); databases.push(sql);
  const db = new SqliteD1Database(sql), io = vi.fn(() => { throw new Error("Provider I/O is forbidden"); });
  vi.stubGlobal("fetch", io);
  const env: Env = { DB: db as unknown as D1Database, AUTH_MODE: "disabled",
    ASSETS: { get: io, head: io, put: io, list: io, delete: io } as unknown as R2Bucket,
    R2_BOOTSTRAP_NAMESPACE: JSON.stringify({ kind: "cloudflare-r2", accountId: "a".repeat(32), bucketName: "private-bucket" }),
    MANAGED_STORAGE_PROVIDER: "switchdrive", SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/private-account",
    SWITCHDRIVE_USERNAME: "private-account", SWITCHDRIVE_APP_PASSWORD: "private-credential", SWITCHDRIVE_ROOT: "private-root" };
  const request = (bindings = env, method = "GET") => worker.fetch(new Request("https://app.test/api/settings/storage", { method }), bindings, executionContext);
  return { sql, db, env, io, request };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); databases.splice(0).forEach(database => database.close()); });

describe("authenticated read-only Storage Settings route", () => {
  it("uses the root application route and never performs a configured provider connection check", async () => {
    const f = fixture(), changes = f.sql.prepare("SELECT total_changes() n").get()!.n;
    const response = await f.request(); expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("pragma")).toBe("no-cache");
    const result = await response.json();
    expect(result).toMatchObject({ health: "not_checked", readOnly: true, configurationSource: "deployment",
      bindings: { r2: { configuration: "configured" }, managed: { provider: "switchdrive", configuration: "configured" } }, profiles: { items: [] } });
    for (const secret of ["private-bucket", "private-account", "private-credential", "private-root", "a".repeat(32)]) expect(JSON.stringify(result)).not.toContain(secret);
    expect(f.db.queryCount).toBe(1); expect(f.io).not.toHaveBeenCalled();
    expect(f.sql.prepare("SELECT total_changes() n").get()!.n).toBe(changes);
  });

  it("rejects an unauthenticated Access request before database/provider calls and keeps errors private", async () => {
    const f = fixture(), log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await f.request({ ...f.env, AUTH_MODE: "access", ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "audience" });
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "Authentication required" });
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("pragma")).toBe("no-cache");
    expect(f.db.queryCount).toBe(0); expect(f.io).not.toHaveBeenCalled(); log.mockRestore();
  });

  it("returns a fixed private failure instead of raw schema/configuration details", async () => {
    const f = fixture(); vi.spyOn(f.db, "prepare").mockImplementation(() => { throw new Error("private-credential private-account private SQL namespace"); });
    const response = await f.request(); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Storage settings are temporarily unavailable." });
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(f.io).not.toHaveBeenCalled();
  });

  it("provides no mutation endpoint", async () => {
    const f = fixture();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect((await f.request(f.env, method)).status).toBe(404);
    expect(f.db.queryCount).toBe(0); expect(f.io).not.toHaveBeenCalled();
  });
});

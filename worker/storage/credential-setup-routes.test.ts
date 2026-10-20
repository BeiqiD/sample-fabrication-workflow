import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { referenceTestDatabase, SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";
import { generateInstallationSecretSeed } from "../../shared/contracts/installation-secret-seed";

const auth = vi.hoisted(() => vi.fn());
vi.mock("../auth", () => ({ authenticateRequest: auth }));
const databases: DatabaseSync[] = [];
const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
function fixture() {
  const sql = referenceTestDatabase(); databases.push(sql);
  const db = new SqliteD1Database(sql), io = vi.fn(() => { throw new Error("Provider I/O forbidden"); });
  const env = { DB: db as unknown as D1Database, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: "admin@example.test",
    ASSETS: { get: io, put: io, head: io, list: io, delete: io } as unknown as R2Bucket } as Env;
  const request = (path = "/encryption-readiness", method = "GET", headers: HeadersInit = {}) => worker.fetch(
    new Request(`https://app.test/api/storage/configuration${path}`, { method, headers }), env, context);
  return { sql, db, io, env, request };
}
beforeEach(() => auth.mockReset().mockResolvedValue({ email: "admin@example.test" }));
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach(sql => sql.close()); });
describe("administrator-only encryption readiness HTTP surface", () => {
  it("returns only private non-secret status and preserves the exact historical capability DTO", async () => {
    const f = fixture(), before = f.sql.prepare("SELECT total_changes() n").get()!.n;
    const response = await f.request();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ version: 1, runtime: "cloudflare_worker", state: "setup_required" });
    expect(await (await f.request("/capability")).json()).toEqual({ canManage: true, credentialEditingAvailable: false });
    f.env.INSTALLATION_SECRET_SEED = generateInstallationSecretSeed();
    const ready = await f.request(); expect(await ready.json()).toEqual({ version: 1, runtime: "cloudflare_worker", state: "seed_ready" });
    expect(await (await f.request("/capability")).json()).toEqual({ canManage: true, credentialEditingAvailable: true });
    expect(f.sql.prepare("SELECT total_changes() n").get()!.n).toBe(before); expect(f.io).not.toHaveBeenCalled();
  });
  it("denies readers and forged actor headers without reading D1 or installing anything", async () => {
    const f = fixture(); auth.mockResolvedValue({ email: "reader@example.test" });
    const response = await f.request("/encryption-readiness", "GET", { "x-user-email": "admin@example.test", "cf-access-authenticated-user-email": "admin@example.test" });
    expect(response.status).toBe(403); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "System administrator access is required." });
    expect(f.db.queryCount).toBe(0); expect(f.io).not.toHaveBeenCalled();
  });
  it("provides no route for uploading or remotely installing an encryption seed", async () => {
    const f = fixture(), response = await f.request("/encryption-readiness", "POST");
    expect(response.status).toBe(404); expect(f.db.queryCount).toBe(0); expect(f.io).not.toHaveBeenCalled();
    expect(f.env.INSTALLATION_SECRET_SEED).toBeUndefined();
  });
});

import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_STORAGE_CONFIGURATION_INPUT_BYTES, type SaveStorageCandidateInput } from "../../shared/contracts/storage-configuration";
import worker from "../index";
import { SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";
import { futureActiveRuntimeDatabase } from "../files/authority-runtime-test-support";

const auth = vi.hoisted(() => vi.fn());
vi.mock("../auth", () => ({ authenticateRequest: auth }));
const databases: DatabaseSync[] = [];
const executionContext = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const input = (): SaveStorageCandidateInput => ({ expectedRevision: null, label: "Research archive",
  namespace: { kind: "s3", endpoint: "https://objects.example.org", bucket: "research-files", region: "us-east-1", root: "work", forcePathStyle: true },
  credentials: { mode: "replace", value: { accessKeyId: "private-id", secretAccessKey: "private-secret" } } });
function fixture() {
  const sql = futureActiveRuntimeDatabase(); databases.push(sql);
  sql.exec("UPDATE file_authority_runtime_guard SET enabled=0");
  const db = new SqliteD1Database(sql), io = vi.fn(() => { throw new Error("Provider I/O is forbidden"); });
  vi.stubGlobal("fetch", io);
  const env: Env = { DB: db as unknown as D1Database, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: "admin@example.org",
    STORAGE_CREDENTIAL_KEYRING: JSON.stringify({ version: 1, currentKeyId: "key-test", keys: { "key-test": btoa(String.fromCharCode(...new Uint8Array(32).fill(31))) } }),
    ASSETS: { get: io, head: io, put: io, list: io, delete: io } as unknown as R2Bucket };
  const request = (path = "", method = "GET", body?: unknown, bindings = env, headers: HeadersInit = {}) => worker.fetch(new Request(`https://app.test/api/storage/configuration${path}`, {
    method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  }), bindings, executionContext);
  return { sql, db, env, io, request };
}
beforeEach(() => auth.mockReset().mockResolvedValue({ email: "admin@example.org" }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); databases.splice(0).forEach(database => database.close()); });

describe("separately authorized storage candidate routes", () => {
  it("keeps non-administrators and File operators read only, ignoring forged principal headers", async () => {
    const f = fixture(); auth.mockResolvedValue({ email: "reader@example.org" });
    f.env.FILE_EVIDENCE_OPERATOR_EMAILS = "reader@example.org";
    const capability = await f.request("/capability");
    expect(await capability.json()).toEqual({ canManage: false, credentialEditingAvailable: false });
    for (const [path, method, body] of [["", "GET", undefined], ["/candidates", "PUT", input()]] as const) {
      const response = await f.request(path, method, body, f.env, { "x-user-email": "admin@example.org", "cf-access-authenticated-user-email": "admin@example.org" });
      expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "System administrator access is required." });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(f.db.queryCount).toBe(0); expect(f.io).not.toHaveBeenCalled();
  });

  it("does not grant administration with a missing policy or local authentication", async () => {
    const f = fixture();
    for (const env of [{ ...f.env, SYSTEM_ADMIN_EMAILS: undefined }, { ...f.env, AUTH_MODE: "disabled" }]) {
      expect(await (await f.request("/capability", "GET", undefined, env)).json()).toEqual({ canManage: false, credentialEditingAvailable: false });
      expect((await f.request("/candidates", "PUT", input(), env)).status).toBe(403);
    }
    expect(f.db.queryCount).toBe(0);
  });

  it("remains available during recovered File pause, atomically saves encrypted candidates and reads metadata only", async () => {
    const f = fixture();
    const before = f.sql.prepare("SELECT * FROM file_authority_runtime_guard").get();
    const capability = await f.request("/capability"); expect(await capability.json()).toEqual({ canManage: true, credentialEditingAvailable: true });
    const response = await f.request("/candidates", "PUT", input()); expect(response.status).toBe(200);
    const saved = await response.json() as { profileId: string; credentials: { status: string } };
    expect(saved.credentials.status).toBe("configured");
    const read = await f.request(); expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("private, no-store"); expect(read.headers.get("pragma")).toBe("no-cache");
    const body = await read.json(); expect(body).toMatchObject({ scope: "system", candidates: { items: [{ profileId: saved.profileId, revision: 1 }] } });
    for (const secret of ["private-id", "private-secret", "ciphertext", "nonce", "key-test"]) expect(JSON.stringify(body)).not.toContain(secret);
    expect(f.sql.prepare("SELECT count(*) n FROM system_storage_configuration_audit").get()!.n).toBe(1);
    expect(f.sql.prepare("SELECT * FROM file_authority_runtime_guard").get()).toEqual(before);
    expect(f.sql.prepare("SELECT count(*) n FROM storage_profiles").get()!.n).toBe(0);
    expect(f.io).not.toHaveBeenCalled();
  });

  it("requires the keyring only for external saves and reads missing credential status safely", async () => {
    const f = fixture(); await f.request("/candidates", "PUT", input());
    const env = { ...f.env, STORAGE_CREDENTIAL_KEYRING: undefined };
    expect(await (await f.request("/capability", "GET", undefined, env)).json()).toEqual({ canManage: true, credentialEditingAvailable: false });
    const read = await f.request("", "GET", undefined, env); expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ credentialEditingAvailable: false, candidates: { items: [{ credentials: { status: "unavailable" } }] } });
    const rejected = await f.request("/candidates", "PUT", { ...input(), label: "Other archive" }, env);
    expect(rejected.status).toBe(503); expect(await rejected.json()).toEqual({ error: "Storage credential encryption is unavailable." });
  });

  it("rejects unauthenticated, cross-origin, invalid and oversized requests before committing", async () => {
    const f = fixture(); vi.spyOn(console, "warn").mockImplementation(() => undefined);
    auth.mockRejectedValueOnce(new Error("private authentication detail"));
    const unauthenticated = await f.request("/capability"); expect(unauthenticated.status).toBe(403);
    expect(unauthenticated.headers.get("cache-control")).toBe("private, no-store");
    expect((await f.request("/candidates", "PUT", input(), f.env, { origin: "https://other.test" })).status).toBe(403);
    expect((await f.request("/candidates", "PUT", { ...input(), namespace: { ...input().namespace, endpoint: "https://private-user:private-secret@objects.example.org" } })).status).toBe(400);
    expect((await f.request("/candidates", "PUT", { ...input(), label: "x".repeat(MAX_STORAGE_CONFIGURATION_INPUT_BYTES) })).status).toBe(413);
    expect(f.sql.prepare("SELECT count(*) n FROM system_storage_profiles").get()!.n).toBe(0); expect(f.io).not.toHaveBeenCalled();
  });

  it("returns fixed service failures and provides no activation or role-default endpoint", async () => {
    const f = fixture();
    for (const path of ["/activate", "/defaults", "/candidates/activate"]) expect((await f.request(path, "PUT", {})).status).toBe(404);
    vi.spyOn(f.db, "prepare").mockImplementation(() => { throw new Error("private-secret private SQL"); });
    const response = await f.request(); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Storage configuration is temporarily unavailable." }); expect(f.io).not.toHaveBeenCalled();
  });
});

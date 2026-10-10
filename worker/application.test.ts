import type { DatabaseSync } from "node:sqlite";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerApplication } from "./application";
import worker from "./index";
import { referenceTestDatabase, SqliteD1Database } from "./reference-test-support";
import { futureActiveRuntimeDatabase } from "./files/authority-runtime-test-support";
import type { Env } from "./types";

const executionContext = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const databases: DatabaseSync[] = [];
const teamDomain = "https://application-fixture.cloudflareaccess.test";
const audience = "application-fixture";
const administrator = "admin@example.test";
let signingKey: CryptoKey;
let publicKey: Awaited<ReturnType<typeof exportJWK>>;
let providerIO: ReturnType<typeof vi.fn<() => never>>;
let keyRequests: ReturnType<typeof vi.fn<(url: string) => void>>;

beforeAll(async () => {
  const keys = await generateKeyPair("ES256");
  signingKey = keys.privateKey;
  publicKey = { ...await exportJWK(keys.publicKey), alg: "ES256", kid: "application-fixture" };
});
beforeEach(() => {
  providerIO = vi.fn(() => { throw new Error("Unexpected provider I/O"); });
  keyRequests = vi.fn<(url: string) => void>();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== `${teamDomain}/cdn-cgi/access/certs`) return providerIO();
    keyRequests(url);
    return Response.json({ keys: [publicKey] });
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  databases.splice(0).forEach(database => database.close());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function bucket() {
  return { get: providerIO, head: providerIO, put: providerIO, list: providerIO, delete: providerIO } as unknown as R2Bucket;
}
function fixture(active = false) {
  const sql = active ? futureActiveRuntimeDatabase() : referenceTestDatabase();
  databases.push(sql);
  const db = new SqliteD1Database(sql);
  const env: Env = { AUTH_MODE: "disabled", DB: db as unknown as D1Database, ASSETS: bucket() };
  return { sql, db, env };
}
function unavailableDatabase() {
  const unexpected = vi.fn(() => { throw new Error("Unexpected database I/O"); });
  const env: Env = { AUTH_MODE: "access", DB: { prepare: unexpected, batch: unexpected } as unknown as D1Database, ASSETS: bucket() };
  return { env, unexpected };
}
async function access(env: Env, email = administrator) {
  const token = await new SignJWT({ email }).setProtectedHeader({ alg: "ES256", kid: "application-fixture" })
    .setIssuer(teamDomain).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(signingKey);
  return {
    env: { ...env, AUTH_MODE: "access", ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: audience, SYSTEM_ADMIN_EMAILS: administrator } satisfies Env,
    headers: { "cf-access-jwt-assertion": token },
  };
}
type ApiFetch = (request: Request, env: Env) => Response | Promise<Response>;
function request(fetch: ApiFetch, env: Env, path: string, method = "GET", body?: unknown, headers: HeadersInit = {}) {
  const requestHeaders = new Headers(headers);
  if (body !== undefined) requestHeaders.set("content-type", "application/json");
  return fetch(new Request(`https://app.test/api${path}`, {
    method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}
const implementations = [
  ["application factory", () => {
    const app = createWorkerApplication();
    return (request: Request, env: Env) => app.fetch(request, env, executionContext);
  }],
  ["Worker entry point", () => (request: Request, env: Env) => worker.fetch(request, env, executionContext)],
] as const;

describe.each(implementations)("%s authority and platform boundaries", (_name, createFetch) => {
  it("keeps health public without reading unavailable database or provider bindings", async () => {
    const { env, unexpected } = unavailableDatabase();
    const response = await request(createFetch(), env, "/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(unexpected).not.toHaveBeenCalled();
    expect(keyRequests).not.toHaveBeenCalled();
    expect(providerIO).not.toHaveBeenCalled();
  });

  it("rejects readiness without trusted authentication before any binding I/O", async () => {
    const { env, unexpected } = unavailableDatabase();
    const response = await request(createFetch(), env, "/ready");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Authentication required" });
    expect(unexpected).not.toHaveBeenCalled();
    expect(providerIO).not.toHaveBeenCalled();
  });

  it("executes only the current readiness SELECT against actual SQLite without optional provider probes", async () => {
    const f = fixture();
    const prepare = vi.spyOn(f.db, "prepare");
    const response = await request(createFetch(), f.env, "/ready");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(prepare.mock.calls).toEqual([["SELECT 1 AS ok"]]);
    expect(f.db.queryCount).toBe(1);
    expect(providerIO).not.toHaveBeenCalled();
  });

  it("retains the current readiness error contract when the actual SQLite connection is unavailable", async () => {
    const f = fixture();
    databases.splice(databases.indexOf(f.sql), 1);
    f.sql.close();
    const response = await request(createFetch(), f.env, "/ready");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Unexpected server error" });
    expect(providerIO).not.toHaveBeenCalled();
  });

  it("rejects cross-origin mutations before authentication or database execution", async () => {
    const { env, unexpected } = unavailableDatabase();
    const response = await request(createFetch(), env, "/samples", "POST", { code: "CROSS", title: "Cross origin" }, { origin: "https://other.test" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Cross-origin writes are not allowed" });
    expect(unexpected).not.toHaveBeenCalled();
    expect(keyRequests).not.toHaveBeenCalled();
    expect(providerIO).not.toHaveBeenCalled();
  });

  it.each(["/storage/configuration", "/storage/configuration/capability", "/settings/storage", "/settings/storage/roles", "/files/migrations"])(
    "applies private no-store before the authentication error for %s", async path => {
      const { env, unexpected } = unavailableDatabase();
      const response = await request(createFetch(), env, path);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Authentication required" });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(unexpected).not.toHaveBeenCalled();
      expect(providerIO).not.toHaveBeenCalled();
    });

  it("retains zero-I/O input validation before the paused File execution gate", async () => {
    const f = fixture(true);
    f.sql.exec("UPDATE file_authority_runtime_guard SET enabled=0");
    const response = await request(createFetch(), f.env, "/samples", "POST", { title: "Missing permanent code" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid sample fields" });
    expect(f.db.queryCount).toBe(0);
    expect(f.sql.prepare("SELECT count(*) n FROM system_recovery_write_leases").get()!.n).toBe(0);
  });

  it("denies a valid Sample mutation through the paused File gate while preserving original bindings", async () => {
    const f = fixture(true), originalAssets = f.env.ASSETS;
    f.sql.exec("UPDATE file_authority_runtime_guard SET enabled=0");
    const count = f.sql.prepare("SELECT count(*) n FROM samples").get()!.n;
    const response = await request(createFetch(), f.env, "/samples", "POST", { code: "PAUSED", title: "Paused sample" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "File execution is paused on this installation. An operator must enable it after recovery." });
    expect(f.sql.prepare("SELECT count(*) n FROM samples").get()!.n).toBe(count);
    expect(f.sql.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()!.n).toBe(0);
    expect(f.env.DB).toBe(f.db);
    expect(f.env.ASSETS).toBe(originalAssets);
    expect(providerIO).not.toHaveBeenCalled();
  });

  it("keeps reads available in source maintenance and exposes separately authorized recovery repair before the File gate", async () => {
    const f = fixture(true), fetch = createFetch();
    const created = await request(fetch, f.env, "/samples", "POST", { code: "FENCED", title: "Retained sample" });
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    f.sql.exec("UPDATE file_authority_runtime_guard SET enabled=0");
    const a = await access({ ...f.env, RECOVERY_TARGET_ID: "private-fixture-target" });
    const enter = await request(fetch, a.env, "/system-recovery/maintenance", "POST", {
      requestId: "fixture-enter", action: "enter", expectedGeneration: 0,
    }, a.headers);
    expect(enter.status).toBe(200);
    expect(await enter.json()).toMatchObject({ status: { state: "draining", generation: 1, activeWriters: 0 } });
    const read = await request(fetch, a.env, `/samples/${id}`, "GET", undefined, a.headers);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id, code: "FENCED", title: "Retained sample" });
    const leaseCount = f.sql.prepare("SELECT count(*) n FROM system_recovery_write_leases").get()!.n;
    const paused = await request(fetch, a.env, "/samples", "POST", { code: "DENIED", title: "Unwritten sample" }, a.headers);
    expect(paused.status).toBe(503);
    expect(await paused.json()).toEqual({ error: "Source mutations are paused for system recovery" });
    expect(f.sql.prepare("SELECT count(*) n FROM samples").get()!.n).toBe(1);
    expect(f.sql.prepare("SELECT count(*) n FROM system_recovery_write_leases").get()!.n).toBe(leaseCount);
    const release = await request(fetch, a.env, "/system-recovery/maintenance", "POST", {
      requestId: "fixture-release", action: "release", expectedGeneration: 1,
    }, a.headers);
    expect(release.status).toBe(200);
    expect(await release.json()).toMatchObject({ status: { state: "open", generation: 2, activeWriters: 0 } });
    expect(f.env.DB).toBe(f.db);
    expect(providerIO).not.toHaveBeenCalled();
  });

  it("never grants administrator privileges to forged headers or development-disabled authentication", async () => {
    const f = fixture(true), fetch = createFetch();
    f.sql.exec("UPDATE file_authority_runtime_guard SET enabled=0");
    const reader = await access(f.env, "reader@example.test");
    for (const [env, headers] of [
      [reader.env, { ...reader.headers, "x-user-email": administrator, "cf-access-authenticated-user-email": administrator }],
      [{ ...f.env, SYSTEM_ADMIN_EMAILS: administrator }, { "x-user-email": administrator }],
    ] as const) {
      const response = await request(fetch, env, "/storage/configuration", "GET", undefined, headers);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "System administrator access is required." });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(f.db.queryCount).toBe(0);
    expect(providerIO).not.toHaveBeenCalled();
  });

  it("allows genuine administrator configuration before the paused File gate while retaining source maintenance admission", async () => {
    const f = fixture(true), fetch = createFetch();
    f.sql.exec("UPDATE file_authority_runtime_guard SET enabled=0");
    const keyring = JSON.stringify({ version: 1, currentKeyId: "fixture-key", keys: { "fixture-key": btoa(String.fromCharCode(...new Uint8Array(32).fill(31))) } });
    const a = await access({ ...f.env, STORAGE_CREDENTIAL_KEYRING: keyring, RECOVERY_TARGET_ID: "private-fixture-target" });
    const input = { expectedRevision: null, label: "Unactivated fixture candidate",
      namespace: { kind: "s3", endpoint: "https://objects.example.test", bucket: "research-files", region: "us-east-1", root: "work", forcePathStyle: true },
      credentials: { mode: "replace", value: { accessKeyId: "fixture-id", secretAccessKey: "fixture-secret" } } };
    const saved = await request(fetch, a.env, "/storage/configuration/candidates", "PUT", input, a.headers);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ credentials: { status: "configured" } });
    expect(f.sql.prepare("SELECT count(*) n FROM system_storage_configuration_audit").get()!.n).toBe(1);
    expect(f.sql.prepare("SELECT enabled FROM file_authority_runtime_guard").get()!.enabled).toBe(0);
    expect(f.sql.prepare("SELECT count(*) n FROM storage_profiles").get()!.n).toBe(0);
    const entered = await request(fetch, a.env, "/system-recovery/maintenance", "POST", {
      requestId: "fixture-storage-enter", action: "enter", expectedGeneration: 0,
    }, a.headers);
    expect(entered.status).toBe(200);
    const blocked = await request(fetch, a.env, "/storage/configuration/candidates", "PUT", { ...input, label: "Unwritten candidate" }, a.headers);
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toEqual({ error: "Source mutations are paused for system recovery" });
    expect(blocked.headers.get("cache-control")).toBe("private, no-store");
    expect(f.sql.prepare("SELECT count(*) n FROM system_storage_configuration_audit").get()!.n).toBe(1);
    expect(f.sql.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()!.n).toBe(0);
    expect(providerIO).not.toHaveBeenCalled();
  });
});

it("keeps independent factory instances and request database bindings isolated through actual Sample writes and reads", async () => {
  const a = fixture(), b = fixture();
  const actorA = await access(a.env, "actor-a@example.test");
  const actorB = await access(b.env, "actor-b@example.test");
  const first = createWorkerApplication(), second = createWorkerApplication();
  const firstFetch: ApiFetch = (request, env) => first.fetch(request, env, executionContext);
  const secondFetch: ApiFetch = (request, env) => second.fetch(request, env, executionContext);
  const [createdA, createdB] = await Promise.all([
    request(firstFetch, actorA.env, "/samples", "POST", { code: "INSTANCE-A", title: "A" }, actorA.headers),
    request(secondFetch, actorB.env, "/samples", "POST", { code: "INSTANCE-B", title: "B" }, actorB.headers),
  ]);
  expect([createdA.status, createdB.status]).toEqual([201, 201]);
  const { id: idA } = await createdA.json() as { id: string };
  const { id: idB } = await createdB.json() as { id: string };
  expect(a.sql.prepare("SELECT code,created_by FROM samples").all()).toEqual([{ code: "INSTANCE-A", created_by: "actor-a@example.test" }]);
  expect(b.sql.prepare("SELECT code,created_by FROM samples").all()).toEqual([{ code: "INSTANCE-B", created_by: "actor-b@example.test" }]);
  // Each application must use the current request binding, even when the same
  // factory receives a database used by another instance on the prior request.
  const read = await request(firstFetch, actorB.env, `/samples/${idB}`, "GET", undefined, actorB.headers);
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ id: idB, code: "INSTANCE-B" });
  expect((await request(secondFetch, actorB.env, `/samples/${idA}`, "GET", undefined, actorB.headers)).status).toBe(404);
  expect(a.env.DB).toBe(a.db);
  expect(b.env.DB).toBe(b.db);
  expect(providerIO).not.toHaveBeenCalled();
});

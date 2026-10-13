import { PORTABLE_RUNTIME_RECOVERY_MIGRATIONS as V26_MIGRATIONS } from "../shared/contracts/portable-runtime-v26-recovery-catalog";
import { validateFullExportV26 } from "../shared/contracts/export-portable-runtime-v26";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createWorkerApplication } from "./application";
import { SqliteD1Database } from "./reference-test-support";
import { PORTABLE_RUNTIME_RECOVERY_MIGRATIONS } from "../shared/contracts/portable-runtime-recovery-catalog";
import { validateFullExportV25 } from "../shared/contracts/export-portable-runtime";
import type { Env } from "./types";

// Genuine current Cloudflare SQL/auth composition, using the repository's real
// SQLite D1 test helper and a signed Access JWT. This is not a Node Env adapter.
const at = "2026-10-10T12:00:00.000Z", domain = "https://portable-export-fixture.cloudflareaccess.test";
const audience = "portable-export-fixture", administrator = "admin@example.test";
const verifier = "Opaque protected verifier must never enter a research export";
const opened: DatabaseSync[] = [], directories: string[] = [];
const executionContext = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
let signingKey: CryptoKey, publicKey: Awaited<ReturnType<typeof exportJWK>>;
let providerIO: ReturnType<typeof vi.fn<() => never>>;
beforeAll(async () => {
  const keys = await generateKeyPair("ES256"); signingKey = keys.privateKey;
  publicKey = { ...await exportJWK(keys.publicKey), alg: "ES256", kid: "portable-export-fixture" };
});
beforeEach(() => {
  providerIO = vi.fn(() => { throw new Error("Unexpected provider I/O"); });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${domain}/cdn-cgi/access/certs`) return Response.json({ keys: [publicKey] });
    return providerIO();
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const native of opened.splice(0)) native.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function fixture(current: boolean | "v26" = true) {
  const directory = mkdtempSync(join(tmpdir(), "portable-export-negotiation-")); directories.push(directory);
  const native = new DatabaseSync(join(directory, "source.sqlite")); opened.push(native); native.exec("PRAGMA foreign_keys=ON");
  for (const migration of (current === "v26" ? V26_MIGRATIONS : PORTABLE_RUNTIME_RECOVERY_MIGRATIONS.slice(0, current ? 23 : 22))) {
    const sql = readFileSync(new URL(`../migrations/${migration.name}`, import.meta.url), "utf8");
    expect(createHash("sha256").update(sql).digest("hex")).toBe(migration.sha256);
    if (migration.name !== "0001_v3_baseline.sql") { native.exec(sql); continue; }
    // Only the empty baseline batches its original DDL commits. Later
    // migration PRAGMA/rebuild boundaries retain original autocommit.
    native.exec("BEGIN");
    try { native.exec(sql); native.exec("COMMIT"); }
    catch (error) {
      try { native.exec("ROLLBACK"); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "Fixture baseline and rollback failed"); }
      throw error;
    }
  }
  native.prepare("INSERT INTO samples(id,code,title,created_at,updated_at) VALUES('retained','KEPT','Retained export',?,?)").run(at, at);
  if (current) native.prepare("INSERT INTO local_accounts VALUES('local_10000000-0000-4000-8000-000000000001','retained.admin',?,1,1,0)").run(verifier);
  const db = new SqliteD1Database(native);
  const bucket = { get: providerIO, head: providerIO, put: providerIO, list: providerIO, delete: providerIO } as unknown as R2Bucket;
  const env: Env = { AUTH_MODE: "access", DB: db as unknown as D1Database, ASSETS: bucket,
    ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: audience, SYSTEM_ADMIN_EMAILS: administrator };
  return { db, env, native };
}
async function accessHeaders(): Promise<HeadersInit> {
  const token = await new SignJWT({ email: administrator }).setProtectedHeader({ alg: "ES256", kid: "portable-export-fixture" })
    .setIssuer(domain).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(signingKey);
  return { "cf-access-jwt-assertion": token };
}
function request(env: Env, version: 24 | 25 | 26, headers?: HeadersInit) {
  return createWorkerApplication().fetch(new Request(`https://application.test/api/exports/all?archiveSchema=${version}&archiveWriter=1`, { headers }), env, executionContext);
}
it("denies unauthenticated current export before database or provider reads", async () => {
  const f = fixture(), before = f.db.queryCount, response = await request(f.env, 25);
  expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "Authentication required" });
  expect(f.db.queryCount).toBe(before); expect(providerIO).not.toHaveBeenCalled();
}, 10_000);
it("refuses V24 on the real current schema and serves explicit V25 through authenticated factory routes without account/verifier authority", async () => {
  const f = fixture(), headers = await accessHeaders();
  const old = await request(f.env, 24, headers); expect(old.status).toBe(409);
  expect(await old.json()).toEqual({ error: "This archive writer is out of date. Refresh the page and download the full ZIP again." });
  const current = await request(f.env, 25, headers); expect(current.status).toBe(200);
  const content = await validateFullExportV25(await current.json());
  expect(content.schemaVersion).toBe(25); expect(content.tables.samples[0].title).toBe("Retained export");
  expect(JSON.stringify(content)).not.toContain(verifier);
  for (const name of ["local_accounts", "local_admin_grants", "local_sessions", "local_login_throttle", "local_auth_events"])
    expect(Object.hasOwn(content.tables, name)).toBe(false);
  expect(f.native.prepare("SELECT enabled,password_verifier FROM local_accounts").get()).toEqual({ enabled: 1, password_verifier: verifier });
  expect(providerIO).not.toHaveBeenCalled();
}, 15_000);
it("preserves authenticated explicit V24 on the historical 22-migration schema and refuses its V25 negotiation", async () => {
  const f = fixture(false), headers = await accessHeaders();
  const historical = await request(f.env, 24, headers); expect(historical.status).toBe(200);
  expect(await historical.json()).toMatchObject({ schemaVersion: 24, tables: { samples: [{ id: "retained", title: "Retained export" }] } });
  const current = await request(f.env, 25, headers); expect(current.status).toBe(409);
  expect(providerIO).not.toHaveBeenCalled();
}, 15_000);

it("negotiates actual V26 explicitly, refusing both V24 and V25 while excluding protected local histories and authority", async () => {
  const f = fixture("v26"), headers = await accessHeaders();
  for (const oldVersion of [24, 25] as const) expect((await request(f.env, oldVersion, headers)).status).toBe(409);
  const current = await request(f.env, 26, headers); expect(current.status).toBe(200);
  const content = await validateFullExportV26(await current.json());
  expect(content.schemaVersion).toBe(26); expect(content.tables.samples[0].title).toBe("Retained export");
  for (const name of ["local_accounts", "local_auth_events", "local_storage_profile_registrations", "local_storage_profile_activations", "local_storage_profile_checks", "local_storage_profile_admissions", "local_storage_profile_bindings"])
    expect(Object.hasOwn(content.tables, name)).toBe(false);
  expect(JSON.stringify(content)).not.toContain(verifier); expect(providerIO).not.toHaveBeenCalled();
}, 20_000);
it("denies unauthenticated V26 and malformed metadata before snapshots, and refuses V26 on the unchanged V25 catalog", async () => {
  const latest = fixture("v26"), before = latest.db.queryCount;
  expect((await request(latest.env, 26)).status).toBe(403); expect(latest.db.queryCount).toBe(before);
  const old = fixture(), headers = await accessHeaders(); expect((await request(old.env, 26, headers)).status).toBe(409);
  const guarded = fixture("v26"), batch = vi.spyOn(guarded.db, "batch");
  const prepare = guarded.db.prepare.bind(guarded.db);
  let responseRow: unknown;
  const probe = vi.spyOn(guarded.db, "prepare").mockImplementation(sql => {
    const statement = prepare(sql);
    if (!sql.includes("AS local_profile_present") || !sql.includes("AS identity_present")) return statement;
    const bind = statement.bind.bind(statement);
    vi.spyOn(statement, "bind").mockImplementation((...bindings) => {
      const bound = bind(...bindings), first = bound.first.bind(bound);
      vi.spyOn(bound, "first").mockImplementation(async <T>() => {
        // Execute the genuine metadata observation before corrupting its reply;
        // this control never fabricates installation or provider authority.
        expect(await first()).toEqual({ local_profile_present: 1, identity_present: 1 });
        return responseRow as T | null;
      });
      return bound;
    });
    return statement;
  });
  for (responseRow of [null, {}, { local_profile_present: 2, identity_present: 1 },
    { local_profile_present: 1, identity_present: "1" }, { local_profile_present: null, identity_present: 1 }]) {
    expect((await request(guarded.env, 26, headers)).status).toBe(500);
    expect(batch).not.toHaveBeenCalled();
    expect(providerIO).not.toHaveBeenCalled();
  }
  probe.mockRestore();
  expect(providerIO).not.toHaveBeenCalled();
}, 20_000);

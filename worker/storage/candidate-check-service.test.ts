import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkedStorageCandidateCheck, checkedStorageCandidateCheckList } from "../../shared/contracts/storage-candidate-check";
import type { SaveStorageCandidateInput } from "../../shared/contracts/storage-configuration";
import type { Sha256Factory } from "../files/byte-verification";
import { SqliteD1Database } from "../reference-test-support";
import type { Env } from "../types";
import { saveStorageCandidate } from "./configuration-registry";
import { storageCandidateCheckRoutes } from "./candidate-check-routes";
import { controlSourceMaintenance, sourceMaintenanceAdmission } from "../recovery/maintenance";
import {
  cleanupStorageCandidateCheck, listStorageCandidateChecks, readStorageCandidateCheck,
  startStorageCandidateCheck, StorageCandidateCheckError, type StorageCandidateCheckOptions,
} from "./candidate-check-service";

const actor = "admin@example.test";
const rawKeyring = JSON.stringify({ version: 1, currentKeyId: "fixture", keys: { fixture: btoa(String.fromCharCode(...new Uint8Array(32).fill(13))) } });
const input: SaveStorageCandidateInput = { expectedRevision: null, label: "Test S3",
  namespace: { kind: "s3", endpoint: "https://objects.example.test", bucket: "test-bucket", region: "eu-test-1", root: "research", forcePathStyle: true },
  credentials: { mode: "replace", value: { accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" } } };
const databases: DatabaseSync[] = [];
const hash: Sha256Factory = () => {
  const value = createHash("sha256");
  return { async write(bytes) { value.update(bytes); }, async finish() { return value.digest("hex"); }, async abort() {} };
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
async function fixture() {
  const sql = new DatabaseSync(":memory:"); databases.push(sql); sql.exec("PRAGMA foreign_keys=ON");
  for (const name of ["0014_fp2_storage_configuration.sql", "0015_fp2_storage_candidate_checks.sql"]) sql.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  const db = new SqliteD1Database(sql), env = { DB: db as unknown as D1Database, AUTH_MODE: "access", SYSTEM_ADMIN_EMAILS: actor, STORAGE_CREDENTIAL_KEYRING: rawKeyring } as Env;
  const saved = await saveStorageCandidate(env, input, actor), objects = new Map<string, ArrayBuffer>();
  const fetch = vi.fn(async (request: Request) => {
    const key = new URL(request.url).pathname;
    if (request.method === "PUT") { objects.set(key, await request.arrayBuffer()); return new Response(null, { status: 200 }); }
    if (request.method === "DELETE") { objects.delete(key); return new Response(null, { status: 204 }); }
    const stored = objects.get(key);
    if (!stored) return new Response(null, { status: 404 });
    return new Response(request.method === "GET" ? stored.slice(0) : null, { status: 200, headers: { "content-length": String(stored.byteLength), "content-type": "application/octet-stream" } });
  });
  const options: StorageCandidateCheckOptions = { fetch, createHash: hash };
  const command = () => ({ checkId: crypto.randomUUID(), profileId: saved.profileId, expectedRevision: 1 });
  return { sql, db, env, saved, objects, fetch, options, command };
}
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach(sql => sql.close()); });
function installMaintenance(f: Awaited<ReturnType<typeof fixture>>) {
  f.sql.exec(readFileSync(new URL("../../migrations/0021_fp5_system_recovery.sql", import.meta.url), "utf8"));
  for (const name of ["file_shadow_attempts", "file_migration_attempts", "research_package_attempts"]) {
    f.sql.exec(`CREATE TABLE ${name}(state TEXT)`);
  }
  for (const name of ["r2_upload_requests", "metrology_reference_upload_requests", "comment_submission_acceptances", "import_file_acceptances"]) {
    f.sql.exec(`CREATE TABLE ${name}(status TEXT)`);
  }
  f.env.RECOVERY_TARGET_ID = "isolated-fixture-target";
}
async function retainCompletedCheckWithoutFinalPublication(f: Awaited<ReturnType<typeof fixture>>) {
  const command = f.command();
  f.sql.exec("CREATE TRIGGER fixture_failure BEFORE UPDATE ON system_storage_candidate_checks WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'Fixture final publication lost'); END");
  await expect(startStorageCandidateCheck(f.env, command, actor, {
    ...f.options, now: () => new Date("2020-01-01T00:00:00.000Z"),
  })).rejects.toMatchObject({ status: 503 });
  f.sql.exec("DROP TRIGGER fixture_failure");
  return command;
}
function protectedCheckRows(f: Awaited<ReturnType<typeof fixture>>) {
  return JSON.stringify([
    f.sql.prepare("SELECT * FROM system_storage_candidate_checks ORDER BY id").all(),
    f.sql.prepare("SELECT * FROM system_storage_candidate_check_audit ORDER BY id").all(),
  ]);
}

describe("durable administrator candidate checks", () => {
  it.each(["draining", "fenced"] as const)("keeps real expired check GETs visible and protected rows unchanged while source is %s", async state => {
    const f = await fixture(), command = await retainCompletedCheckWithoutFinalPublication(f);
    installMaintenance(f);
    f.sql.prepare("UPDATE system_recovery_maintenance SET state=? WHERE singleton=1").run(state);
    const before = protectedCheckRows(f), calls = f.fetch.mock.calls.length;
    const globalProvider = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Status reads must not contact a provider"));
    const app = new Hono<{ Bindings: Env; Variables: { userEmail: string } }>();
    app.use("*", async (c, next) => { c.set("userEmail", actor); await next(); });
    app.use("*", sourceMaintenanceAdmission);
    app.route("/api", storageCandidateCheckRoutes);
    const response = await app.request(`/api/storage/configuration/checks/${command.checkId}`, {}, f.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "running", write: "passed", cleanup: "confirmed_absent" });
    const history = await app.request(`/api/storage/configuration/checks?profileId=${encodeURIComponent(f.saved.profileId)}`, {}, f.env);
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ items: [{ id: command.checkId, status: "running" }] });
    expect(protectedCheckRows(f)).toBe(before);
    expect(f.fetch).toHaveBeenCalledTimes(calls);
    expect(globalProvider).not.toHaveBeenCalled();
    f.sql.exec("UPDATE system_recovery_maintenance SET state='open' WHERE singleton=1");
    expect(await readStorageCandidateCheck(f.env, command.checkId, actor)).toMatchObject({
      status: "interrupted", cleanup: "confirmed_absent", code: "execution_interrupted",
    });
    expect(protectedCheckRows(f)).not.toBe(before);
    expect(f.fetch).toHaveBeenCalledTimes(calls);
  });

  it.each([false, true])("atomically suppresses expiry reconciliation if installation/fencing changes after schema discovery (installed=%s)", async alreadyInstalled => {
    const f = await fixture(), command = await retainCompletedCheckWithoutFinalPublication(f), before = protectedCheckRows(f);
    if (alreadyInstalled) installMaintenance(f);
    const database = new Proxy(f.env.DB, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== "prepare") return typeof value === "function" ? value.bind(target) : value;
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("SELECT 1 AS present FROM sqlite_schema")) return statement;
          return new Proxy(statement, {
            get(inner, name) {
              const method = Reflect.get(inner, name, inner);
              if (name !== "first") return typeof method === "function" ? method.bind(inner) : method;
              return async () => {
                const result = await inner.first();
                if (!alreadyInstalled) installMaintenance(f);
                f.sql.exec("UPDATE system_recovery_maintenance SET state='fenced' WHERE singleton=1");
                return result;
              };
            },
          });
        };
      },
    });
    expect(await readStorageCandidateCheck({ ...f.env, DB: database }, command.checkId, actor)).toMatchObject({ status: "running" });
    expect(protectedCheckRows(f)).toBe(before);
  });

  it("does not finalize an expired unknown PUT after negative absence or late acknowledgement, while genuinely verified checks drain", async () => {
    const f = await fixture();
    installMaintenance(f);
    const command = f.command(), entered = deferred<Request>(), late = deferred<Response>();
    const pending = startStorageCandidateCheck(f.env, command, actor, {
      ...f.options, timeoutMs: 40, fetch: async request => { entered.resolve(request); return late.promise; },
    });
    await entered.promise;
    expect(await pending).toMatchObject({ status: "interrupted", write: "unknown", cleanup: "required" });
    expect(await cleanupStorageCandidateCheck(f.env, command.checkId, actor, f.options)).toMatchObject({
      write: "unknown", cleanup: "absence_observed",
    });
    await controlSourceMaintenance(f.env, actor, { requestId: crypto.randomUUID(), action: "enter", expectedGeneration: 0 });
    await expect(controlSourceMaintenance(f.env, actor, {
      requestId: crypto.randomUUID(), action: "finalize", expectedGeneration: 1,
    })).rejects.toMatchObject({ status: 409 });
    const before = protectedCheckRows(f);
    late.resolve(new Response(null, { status: 200 }));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(protectedCheckRows(f)).toBe(before);
    await expect(controlSourceMaintenance(f.env, actor, {
      requestId: crypto.randomUUID(), action: "finalize", expectedGeneration: 1,
    })).rejects.toMatchObject({ status: 409 });

    const settled = await fixture();
    installMaintenance(settled);
    expect(await startStorageCandidateCheck(settled.env, settled.command(), actor, settled.options)).toMatchObject({
      status: "succeeded", write: "passed", read: "passed", cleanup: "confirmed_absent",
    });
    await controlSourceMaintenance(settled.env, actor, { requestId: crypto.randomUUID(), action: "enter", expectedGeneration: 0 });
    expect((await controlSourceMaintenance(settled.env, actor, {
      requestId: crypto.randomUUID(), action: "finalize", expectedGeneration: 1,
    })).status.state).toBe("fenced");
  });
  it("accepts exact protected context before I/O, verifies complete bytes and metadata, and confirms cleanup", async () => {
    const f = await fixture(), command = f.command();
    const fetch = vi.fn(async (request: Request) => {
      const row = f.sql.prepare("SELECT * FROM system_storage_candidate_checks WHERE id=?").get(command.checkId)!;
      expect(row).toMatchObject({ profile_id: f.saved.profileId, configuration_revision: 1, envelope_revision: 1, payload_size: 1024, write_outcome: request.method === "PUT" ? "unknown" : "acknowledged" });
      expect(new URL(request.url).pathname).toContain(row.probe_key as string);
      return f.fetch(request);
    });
    const result = checkedStorageCandidateCheck(await startStorageCandidateCheck(f.env, command, actor, { ...f.options, fetch }));
    expect(result).toMatchObject({ status: "succeeded", write: "passed", read: "passed", metadata: "passed", delete: "passed", cleanup: "confirmed_absent", code: null });
    expect(fetch.mock.calls.map(([request]) => request.method)).toEqual(["PUT", "GET", "HEAD", "DELETE", "HEAD"]);
    expect(f.objects.size).toBe(0);
    const protectedRow = f.sql.prepare("SELECT * FROM system_storage_candidate_checks").get()!;
    expect(protectedRow.namespace_json).toBe(JSON.stringify(input.namespace));
    for (const secret of ["fixture-secret", "fixture-access", protectedRow.ciphertext as string, protectedRow.probe_key as string, protectedRow.key_id as string]) {
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(f.sql.prepare("SELECT * FROM system_storage_candidate_check_audit").all())).not.toContain(secret);
    }
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(checkedStorageCandidateCheckList(await listStorageCandidateChecks(f.env, f.saved.profileId, actor))).toEqual({ items: [result], hasMore: false });
  });

  it("never replays accepted IDs after candidate edits or response loss; conflicting reuse is rejected", async () => {
    const f = await fixture(), command = f.command(), result = await startStorageCandidateCheck(f.env, command, actor, f.options), calls = f.fetch.mock.calls.length;
    await saveStorageCandidate(f.env, { ...input, profileId: f.saved.profileId, expectedRevision: 1, credentials: { mode: "retain" }, namespace: { ...input.namespace, region: "auto", forcePathStyle: false } }, actor);
    expect(await startStorageCandidateCheck(f.env, command, actor, f.options)).toEqual(result);
    await expect(startStorageCandidateCheck(f.env, { ...command, expectedRevision: 2 }, actor, f.options)).rejects.toMatchObject({ status: 409 });
    expect(f.fetch).toHaveBeenCalledTimes(calls);
  });

  it("enforces administrator permission before any database or provider access", async () => {
    const f = await fixture(), env = { ...f.env, SYSTEM_ADMIN_EMAILS: "someone@example.test" }; f.db.resetQueryCount();
    for (const operation of [() => startStorageCandidateCheck(env, f.command(), actor, f.options),
      () => readStorageCandidateCheck(env, crypto.randomUUID(), actor), () => listStorageCandidateChecks(env, f.saved.profileId, actor),
      () => cleanupStorageCandidateCheck(env, crypto.randomUUID(), actor, f.options)]) await expect(operation()).rejects.toMatchObject({ status: 403 });
    expect(f.db.queryCount).toBe(0); expect(f.fetch).not.toHaveBeenCalled();
  });

  it("rejects unsupported providers and invalid commands without provider I/O", async () => {
    const f = await fixture(), webdav = await saveStorageCandidate(f.env, { expectedRevision: null, label: "WebDAV",
      namespace: { kind: "webdav", endpoint: "https://drive.example.test/dav", root: "research" }, credentials: { mode: "replace", value: { username: "fixture", password: "secret" } } }, actor);
    await expect(startStorageCandidateCheck(f.env, { ...f.command(), profileId: webdav.profileId }, actor, f.options)).rejects.toMatchObject({ status: 400 });
    await expect(startStorageCandidateCheck(f.env, { ...f.command(), key: "arbitrary" }, actor, f.options)).rejects.toMatchObject({ status: 400 });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("serializes active profile execution while same-ID concurrent posts return the accepted check", async () => {
    const f = await fixture(), entered = deferred<void>(), release = deferred<void>(), command = f.command();
    const fetch = async (request: Request) => { if (request.method === "PUT") { entered.resolve(); await release.promise; } return f.fetch(request); };
    const first = startStorageCandidateCheck(f.env, command, actor, { ...f.options, fetch }); await entered.promise;
    expect(await startStorageCandidateCheck(f.env, command, actor, f.options)).toMatchObject({ status: "running", write: "unknown" });
    await expect(startStorageCandidateCheck(f.env, f.command(), actor, f.options)).rejects.toMatchObject({ status: 409 });
    release.resolve(); expect((await first).status).toBe("succeeded");
    expect(f.fetch.mock.calls.filter(([request]) => request.method === "PUT")).toHaveLength(1);
    expect((await startStorageCandidateCheck(f.env, f.command(), actor, f.options)).status).toBe("succeeded");
  });

  it("does no provider I/O when acceptance or its audit fails, and hides database details", async () => {
    const f = await fixture(); f.sql.exec("CREATE TRIGGER fixture_failure BEFORE INSERT ON system_storage_candidate_check_audit BEGIN SELECT RAISE(ABORT,'secret-database-detail'); END;");
    await expect(startStorageCandidateCheck(f.env, f.command(), actor, f.options)).rejects.toEqual(new StorageCandidateCheckError(503, "Storage candidate checks are temporarily unavailable."));
    expect(f.sql.prepare("SELECT count(*) n FROM system_storage_candidate_checks").get()!.n).toBe(0); expect(f.fetch).not.toHaveBeenCalled();
  });

  it("final acceptance CAS rejects an envelope rotation after context capture without I/O", async () => {
    const f = await fixture(), original = f.db.prepare.bind(f.db); let rotated = false;
    vi.spyOn(f.db, "prepare").mockImplementation((sql: string) => {
      const statement = original(sql);
      if (!sql.startsWith("INSERT INTO system_storage_candidate_checks")) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...args: unknown[]) => {
        const bound = bind(...args), run = bound.run.bind(bound);
        bound.run = async () => { if (!rotated) { rotated = true; f.sql.exec("UPDATE system_storage_credential_payloads SET envelope_revision=envelope_revision+1,ciphertext=ciphertext||'A'"); } return run(); };
        return bound;
      };
      return statement;
    });
    await expect(startStorageCandidateCheck(f.env, f.command(), actor, f.options)).rejects.toMatchObject({ status: 409 }); expect(f.fetch).not.toHaveBeenCalled();
  });

  it("stops after acknowledgement publication fails and leaves durable uncertainty for later cleanup", async () => {
    const f = await fixture(), command = f.command();
    f.sql.exec("CREATE TRIGGER fixture_failure BEFORE UPDATE ON system_storage_candidate_checks WHEN NEW.write_outcome='acknowledged' BEGIN SELECT RAISE(ABORT,'private-publication-detail'); END;");
    await expect(startStorageCandidateCheck(f.env, command, actor, f.options)).rejects.toMatchObject({ status: 503 });
    expect(f.fetch.mock.calls.map(([request]) => request.method)).toEqual(["PUT"]);
    expect(await startStorageCandidateCheck(f.env, command, actor, f.options)).toMatchObject({ status: "running", write: "unknown" });
    f.sql.exec("DROP TRIGGER fixture_failure");
    const future = () => new Date(Date.now() + 60_000);
    expect(await readStorageCandidateCheck(f.env, command.checkId, actor, { now: future })).toMatchObject({ status: "interrupted", write: "unknown", cleanup: "required", code: "execution_interrupted" });
    expect(await cleanupStorageCandidateCheck(f.env, command.checkId, actor, { ...f.options, now: future })).toMatchObject({ status: "interrupted", write: "unknown", cleanup: "absence_observed" });
  });

  it("records full-body verification failure, then confirms cleanup of an acknowledged write", async () => {
    const f = await fixture(), fetch = async (request: Request) => request.method === "GET" ? new Response(new Uint8Array(1024)) : f.fetch(request);
    expect(await startStorageCandidateCheck(f.env, f.command(), actor, { ...f.options, fetch })).toMatchObject({ status: "failed", write: "passed", read: "failed", metadata: "not_run", cleanup: "confirmed_absent", code: "read_verification_failed" });
    expect(f.objects.size).toBe(0);
  });

  it("checks HEAD size independently of readback and ETag", async () => {
    const f = await fixture(), fetch = async (request: Request) => {
      const response = await f.fetch(request); if (request.method === "HEAD" && response.status === 200) response.headers.set("content-length", "3"); return response;
    };
    expect(await startStorageCandidateCheck(f.env, f.command(), actor, { ...f.options, fetch })).toMatchObject({ status: "failed", read: "passed", metadata: "failed", cleanup: "confirmed_absent", code: "metadata_verification_failed" });
  });

  it("preserves unknown PUT outcomes through automatic and manual absence observations, allowing a new isolated check", async () => {
    const f = await fixture(), command = f.command(), fetch = async (request: Request) => {
      const response = await f.fetch(request); if (request.method === "PUT") throw new Error("provider credential and private body"); return response;
    };
    const result = await startStorageCandidateCheck(f.env, command, actor, { ...f.options, fetch });
    expect(result).toMatchObject({ status: "failed", write: "unknown", read: "not_run", cleanup: "absence_observed", code: "provider_unavailable" });
    expect(JSON.stringify(result)).not.toContain("credential");
    expect(await cleanupStorageCandidateCheck(f.env, command.checkId, actor, f.options)).toMatchObject({ status: "failed", write: "unknown", cleanup: "absence_observed" });
    expect(f.fetch.mock.calls.filter(([request]) => request.method === "PUT")).toHaveLength(1);
    expect((await startStorageCandidateCheck(f.env, f.command(), actor, f.options)).status).toBe("succeeded");
  });

  it("cleanup uses the exact historical protected context after candidate edits and never writes again", async () => {
    const f = await fixture(), command = f.command(), fetch = async (request: Request) => request.method === "DELETE" ? new Response(null, { status: 500 }) : f.fetch(request);
    expect(await startStorageCandidateCheck(f.env, command, actor, { ...f.options, fetch })).toMatchObject({ status: "failed", cleanup: "required", code: "cleanup_unconfirmed" });
    const old = f.sql.prepare("SELECT probe_key,ciphertext FROM system_storage_candidate_checks").get()!;
    await saveStorageCandidate(f.env, { ...input, profileId: f.saved.profileId, expectedRevision: 1,
      namespace: { ...input.namespace, forcePathStyle: false, region: "auto" }, credentials: { mode: "replace", value: { accessKeyId: "new-access", secretAccessKey: "new-secret" } } }, actor);
    const calls = f.fetch.mock.calls.length;
    expect(await cleanupStorageCandidateCheck(f.env, command.checkId, actor, f.options)).toMatchObject({ status: "failed", cleanup: "confirmed_absent", write: "passed" });
    const requests = f.fetch.mock.calls.slice(calls).map(([request]) => request);
    expect(requests.map(request => request.method)).toEqual(["DELETE", "HEAD"]);
    for (const request of requests) {
      expect(request.url).toContain(`/test-bucket/research/${old.probe_key}`);
      expect(request.headers.get("authorization")).toContain("Credential=fixture-access/");
      expect(request.headers.get("authorization")).not.toContain("new-access");
    }
  });

  it("manual cleanup has its own lease, returns an existing cleanup on duplicate, and excludes a fresh active check", async () => {
    const f = await fixture(), command = f.command();
    await startStorageCandidateCheck(f.env, command, actor, { ...f.options, fetch: async request => request.method === "DELETE" ? new Response(null, { status: 500 }) : f.fetch(request) });
    const entered = deferred<void>(), release = deferred<void>(), fetch = async (request: Request) => { if (request.method === "DELETE") { entered.resolve(); await release.promise; } return f.fetch(request); };
    const cleanup = cleanupStorageCandidateCheck(f.env, command.checkId, actor, { ...f.options, fetch }); await entered.promise;
    expect(await cleanupStorageCandidateCheck(f.env, command.checkId, actor, f.options)).toMatchObject({ cleanup: "running" });
    await expect(startStorageCandidateCheck(f.env, f.command(), actor, f.options)).rejects.toMatchObject({ status: 409 });
    release.resolve(); expect((await cleanup).cleanup).toBe("confirmed_absent");
  });

  it("bounds a hanging PUT, passes abort to the provider and fences its late acknowledgement", async () => {
    const f = await fixture(), command = f.command(), entered = deferred<Request>(), release = deferred<Response>();
    const fetch = vi.fn(async (request: Request) => { entered.resolve(request); return release.promise; });
    const pending = startStorageCandidateCheck(f.env, command, actor, { ...f.options, fetch, timeoutMs: 40 });
    const request = await entered.promise, result = await pending;
    expect(request.signal.aborted).toBe(true);
    expect(result).toMatchObject({ status: "interrupted", write: "unknown", cleanup: "required", code: "execution_interrupted" });
    release.resolve(new Response(null, { status: 200 })); await Promise.resolve(); await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readStorageCandidateCheck(f.env, command.checkId, actor)).toEqual(result);
  });

  it("the same deadline cancels a hanging GET response body and does not start cleanup afterward", async () => {
    const f = await fixture(), signals: AbortSignal[] = [], fetch = async (request: Request) => {
      signals.push(request.signal);
      if (request.method !== "GET") return f.fetch(request);
      return new Response(new ReadableStream({ start(controller) { request.signal.addEventListener("abort", () => controller.error(new Error("private cancellation")), { once: true }); } }));
    };
    const result = await startStorageCandidateCheck(f.env, f.command(), actor, { ...f.options, fetch, timeoutMs: 40 });
    expect(result).toMatchObject({ status: "interrupted", write: "passed", read: "not_run", cleanup: "required" });
    expect(signals).toHaveLength(2); expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it("missing keys preserve captured envelopes and skip privileged provider I/O", async () => {
    const f = await fixture(), command = f.command(), env = { ...f.env, STORAGE_CREDENTIAL_KEYRING: undefined };
    expect(await startStorageCandidateCheck(env, command, actor, f.options)).toMatchObject({ status: "failed", write: "not_run", cleanup: "confirmed_absent", code: "credential_unavailable" });
    expect(f.fetch).not.toHaveBeenCalled();
    const row = f.sql.prepare("SELECT ciphertext FROM system_storage_candidate_checks").get()!;
    expect(row.ciphertext).toBe(f.sql.prepare("SELECT ciphertext FROM system_storage_credential_payloads").get()!.ciphertext);
  });

  it("an expired manual cleanup stays terminal, can receive a fresh cleanup lease, and fences old work", async () => {
    const f = await fixture(), command = f.command();
    await startStorageCandidateCheck(f.env, command, actor, { ...f.options, fetch: async request => request.method === "DELETE" ? new Response(null, { status: 500 }) : f.fetch(request) });
    const entered = deferred<Request>(), release = deferred<Response>();
    const fetch = vi.fn(async (request: Request) => { entered.resolve(request); return release.promise; });
    const first = cleanupStorageCandidateCheck(f.env, command.checkId, actor, { ...f.options, fetch, timeoutMs: 40 });
    const request = await entered.promise;
    expect(await first).toMatchObject({ status: "failed", write: "passed", cleanup: "required", code: "execution_interrupted" });
    expect(request.signal.aborted).toBe(true);
    expect(await cleanupStorageCandidateCheck(f.env, command.checkId, actor, f.options)).toMatchObject({ status: "failed", cleanup: "confirmed_absent" });
    release.resolve(new Response(null, { status: 204 })); await Promise.resolve(); await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readStorageCandidateCheck(f.env, command.checkId, actor)).toMatchObject({ status: "failed", cleanup: "confirmed_absent" });
  });

  it("keeps confirmed cleanup evidence if final status publication is lost", async () => {
    const f = await fixture(), command = f.command();
    f.sql.exec("CREATE TRIGGER fixture_failure BEFORE UPDATE ON system_storage_candidate_checks WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'private final publication failure'); END;");
    await expect(startStorageCandidateCheck(f.env, command, actor, f.options)).rejects.toMatchObject({ status: 503 });
    expect(f.fetch.mock.calls.map(([request]) => request.method)).toEqual(["PUT", "GET", "HEAD", "DELETE", "HEAD"]);
    expect(f.objects.size).toBe(0); f.sql.exec("DROP TRIGGER fixture_failure");
    expect(await readStorageCandidateCheck(f.env, command.checkId, actor, { now: () => new Date(Date.now() + 60_000) }))
      .toMatchObject({ status: "interrupted", write: "passed", read: "passed", metadata: "passed", delete: "passed", cleanup: "confirmed_absent", code: "execution_interrupted" });
  });
});

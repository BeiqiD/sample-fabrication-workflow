import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { createInstalledLocalIdentity } from "../auth/identity.ts";
import { createPasswordHasher } from "../auth/passwords.ts";
import { createLocalAuthentication } from "../auth/local-auth-http.ts";
import { createLoopbackLocalAuthTransport } from "../auth/local-auth-transport.ts";
import { LocalRequestSubjectError } from "../auth/local-request-subject.ts";
import { createNodeHttpServer, stopNodeHttpServerAndDrain } from "../http.ts";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "../installation-catalog-v28-candidate.ts";
import { admitInstallationRecoverySource } from "../migrations.ts";
import { createLocalVolumeProfileOpeningV28Candidate } from "../storage/local-volume-profile-opening-v28-candidate.ts";
import { assertLocalPackageRequestExecutionOwner, createLocalPackageRequestExecutionV28Candidate } from "../files/local-upload-execution.ts";
import { ownedCommentAcceptanceBody } from "../files/owned-comment-acceptance-body.ts";
import { createLocalPackagePermissionV28Candidate, ownedLocalPackagePermissionV28Candidate } from "./local-permission-v28-candidate.ts";
import { readPackageRequestJson } from "../../worker/packages/routes-core.ts";
import type { JobSqlDatabase, JobSqlStatement } from "../../worker/files/jobs/sql-repository.ts";
import type { SqliteCapability } from "../sqlite.ts";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease.ts";
import { CANONICAL_FILE_PASSWORD, CANONICAL_FILE_IDENTITY_POLICY, assertCanonicalFileOwnersReleased,
  prepareCanonicalCommentFileBaseline, retainedCanonicalFileCase, withCanonicalFileDatabase,
  canonicalFilePrivateOrigin, canonicalFileClient } from "../collaboration/current-v28-canonical-comment-file.qualification-support.ts";

// Qualification-only real HTTP route. It consumes the genuine Package factory
// receipt and reads one existing lawful Sample; it never accepts/queues a job,
// supplies business rows, creates an auth token or changes any production port.
// Both original HTTP server/client limits remain5000ms. Only these new finite
// cases allow60s for the genuine stopped baseline and original first closes.
const CASE_MS = 60_000;
type Scope = ReturnType<typeof createLocalPackageRequestExecutionV28Candidate>;
type Client = ReturnType<typeof canonicalFileClient>;
type Answer = Awaited<ReturnType<Client["request"]>>;
type Negative = "logout" | "same-cookie-schema";
function ensure(value: unknown): asserts value { if (!value) throw new Error("Original Package prepared-view qualification is unavailable"); }
function barrier<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const original = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void original.catch(() => undefined); return Object.freeze({ original, resolve, reject });
}
interface HeldOwner {
  readonly kind: Negative;
  readonly prepared: ReturnType<typeof barrier<void>>;
  readonly issue: ReturnType<typeof barrier<void>>;
  readonly denied: ReturnType<typeof barrier<void>>;
  readonly restored: ReturnType<typeof barrier<void>>;
  scope?: Scope; originalWork?: Promise<Readonly<{ denied: number; positiveAfterRestoration: boolean }>>;
  originalResponse?: Promise<Answer>; firstFinish?: Promise<Answer>; view?: JobSqlDatabase; statement?: JobSqlStatement;
  ready: boolean; failure?: unknown;
}
const heldOwners = new Set<HeldOwner>();
interface SchemaWriterOwner {
  native?: DatabaseSync; constructionStarted?: true; originalClose?: () => void;
  setDefensive?: (enabled: boolean) => void; originalWork?: Promise<void>; firstClose?: Promise<void>;
  failed: boolean; failure?: unknown;
}
const schemaWriters = new Set<SchemaWriterOwner>();
afterEach(() => {
  if (heldOwners.size || schemaWriters.size) throw new AggregateError([
    ...[...heldOwners].map(owner => owner.failure ?? owner.firstFinish ?? owner.originalWork ?? owner.originalResponse),
    ...[...schemaWriters].map(owner => owner.failed ? owner.failure : owner.firstClose ?? owner.originalWork),
  ], "Original Package request or test schema Native ownership remains retained");
});
function rememberSchemaWriter(owner: SchemaWriterOwner, cause: unknown): void {
  if (!owner.failed) { owner.failed = true; owner.failure = cause; }
}
function closeSchemaWriter(owner: SchemaWriterOwner): Promise<void> {
  if (owner.firstClose) return owner.firstClose;
  owner.firstClose = Promise.resolve().then(() => {
    ensure(owner.native && owner.originalClose);
    const failures: unknown[] = [];
    try { owner.setDefensive?.(true); } catch (cause) { failures.push(cause); }
    try { owner.originalClose(); ensure(!owner.native.isOpen); } catch (cause) { failures.push(cause); }
    if (failures.length) throw new AggregateError(failures, "Original test schema Native first close failed");
    schemaWriters.delete(owner);
  }).catch(cause => { rememberSchemaWriter(owner, cause); throw cause; });
  void owner.firstClose.catch(() => undefined); return owner.firstClose;
}
async function withActualSchemaWriter(path: string, lease: LinuxWriterLease, database: SqliteCapability,
  originalNative: DatabaseSync, work: (writer: DatabaseSync) => Promise<void>): Promise<void> {
  // Same original physical writer throughout. This second actual Native is a
  // test fault writer only: never bind it to the core/lease or mint an opening,
  // admission, auth, request or execution owner from it. The original bound
  // application's Native keeps defensive mode unchanged.
  const owner: SchemaWriterOwner = { failed: false }; schemaWriters.add(owner);
  let failed = false, failure: unknown;
  try {
    assertLinuxWriterLeaseBinding(lease, database, originalNative);
    owner.constructionStarted = true;
    const writer = owner.native = new DatabaseSync(path, { allowExtension: false, enableForeignKeyConstraints: true });
    owner.originalClose = writer.close.bind(writer); ensure(writer !== originalNative);
    const enable = Reflect.get(writer, "enableDefensive") as unknown; ensure(typeof enable === "function");
    owner.setDefensive = enabled => { Reflect.apply(enable, writer, [enabled]); }; owner.setDefensive(false);
    ensure(!writer.isTransaction); assertLinuxWriterLeaseBinding(lease, database, originalNative);
    const original = owner.originalWork = Promise.resolve().then(() => work(writer));
    void original.catch(() => undefined); await original;
    assertLinuxWriterLeaseBinding(lease, database, originalNative);
  } catch (cause) { failed = true; failure = cause; rememberSchemaWriter(owner, cause); }
  try { const first = closeSchemaWriter(owner); expect(closeSchemaWriter(owner)).toBe(first); await first; }
  catch (cleanup) { throw failed ? new AggregateError([failure, cleanup], "Original test schema fault and first close failed") : cleanup; }
  if (failed) throw failure;
  assertLinuxWriterLeaseBinding(lease, database, originalNative);
}
function cookie(native: DatabaseSync): number {
  const value = native.prepare("PRAGMA main.schema_version").get()?.schema_version;
  ensure(typeof value === "number" && Number.isSafeInteger(value) && value >= 0); return value;
}
async function refused(original: () => Promise<unknown>, code: LocalRequestSubjectError["code"]): Promise<void> {
  const failures: unknown[] = [];
  try { await original(); } catch (cause) { failures.push(cause); }
  expect(failures).toHaveLength(1); expect(failures[0]).toBeInstanceOf(LocalRequestSubjectError);
  expect(failures[0]).toMatchObject({ code });
}
function newHeld(kind: Negative): HeldOwner {
  const held: HeldOwner = { kind, prepared: barrier<void>(), issue: barrier<void>(), denied: barrier<void>(),
    restored: barrier<void>(), ready: false };
  heldOwners.add(held); return held;
}
function finishHeld(held: HeldOwner): Promise<Answer> {
  if (held.firstFinish) return held.firstFinish;
  // Cache before releasing either test barrier. No original response failure
  // can skip joining the already-issued work and exact source settlement.
  held.firstFinish = Promise.resolve().then(async () => {
    held.issue.resolve(); held.restored.resolve();
    const response = held.originalResponse, work = held.originalWork, scope = held.scope;
    const settlement = scope?.settled;
    const originals: Promise<unknown>[] = [
      ...(response ? [response] : []), ...(work ? [work] : []), ...(settlement ? [settlement] : []),
    ];
    const results = await Promise.allSettled(originals);
    const failures: unknown[] = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (!response || !work || !scope || !settlement)
      failures.push(new Error("Original Package response/work/settlement owner is unavailable"));
    if (failures.length) throw new AggregateError(failures, "Original Package request and independent original settlement failed");
    ensure(response && held.view && held.statement);
    const answer = await response; // Same already-ACKed original; no retry.
    expect(() => held.view!.prepare("SELECT 1")).toThrow();
    await expect(held.statement.first()).rejects.toThrow();
    heldOwners.delete(held); return answer;
  });
  void held.firstFinish.catch(cause => { held.failure = cause; });
  return held.firstFinish;
}
async function caseWork(kind: Negative): Promise<void> {
  const baseline = await prepareCanonicalCommentFileBaseline(); assertCanonicalFileOwnersReleased();
  const sampleId = baseline.targets[0]?.sampleId; ensure(sampleId);
  await withCanonicalFileDatabase(baseline.path, async (owner, lease, native, core) => {
    const origin = await canonicalFilePrivateOrigin(owner), transport = createLoopbackLocalAuthTransport({ publicOrigin: origin });
    let identity!: Awaited<ReturnType<typeof createInstalledLocalIdentity>>;
    let authentication!: ReturnType<typeof createLocalAuthentication>;
    let permissions!: ReturnType<typeof createLocalPackagePermissionV28Candidate>;
    const admission = admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE);
    await lease.withWriter(async () => {
      identity = await createInstalledLocalIdentity({ database: core, nativeDatabase: native, admission,
        hasher: createPasswordHasher(), policy: CANONICAL_FILE_IDENTITY_POLICY });
      authentication = createLocalAuthentication({ identity, transport, now: () => Date.now() });
      const operator = await identity.login({ username: "operator", password: CANONICAL_FILE_PASSWORD,
        sourceKey: "genuine-package-prepared-view-opening", now: Date.now() });
      expect(operator.principal.actor).toBe(baseline.operatorActor); expect(operator.principal.capabilities.systemAdministrator).toBe(true);
      owner.openingAttempted = true;
      owner.opening = createLocalVolumeProfileOpeningV28Candidate({ database: core, nativeDatabase: native, admission,
        writerLease: lease, descriptors: baseline.descriptors, filesystemRootOwnerUid: baseline.rootOwnerUid, authentication,
        async authorizeAdministrator(actor) { const current = await identity.authenticate(operator.token, Date.now());
          return current?.actor === actor && current.capabilities.systemAdministrator; } });
      permissions = createLocalPackagePermissionV28Candidate({ opening: owner.opening, authentication, admission });
    });
    const held = newHeld(kind), app = new Hono();
    app.route("/api/auth", authentication.routes);
    app.onError(() => Response.json({ error: "Original Package qualification request failed" }, { status: 503 }));
    app.post("/api/packages/jobs", async c => {
      const request = c.req.raw;
      try {
        ensure(owner.opening && !held.scope);
        const principal = await authentication.authenticateRequest(request);
        expect(principal.id).toBe(baseline.alice.principalId); expect(principal.capabilities.systemAdministrator).toBe(false);
        const token = await permissions.capture(request), opening = owner.opening;
        const permission = ownedLocalPackagePermissionV28Candidate(token, opening, request, principal.actor);
        const scope = held.scope = createLocalPackageRequestExecutionV28Candidate({ opening, request, actor: principal.actor,
          admission, authentication, permission: token });
        const original = held.originalWork = scope.run(async execution => {
          assertLocalPackageRequestExecutionOwner(execution, opening, request, principal.actor);
          ensure(execution.packageDatabase && execution.assertPackageRequestCurrent);
          const body = ownedCommentAcceptanceBody(request, execution.assertPackageRequestCurrent);
          let failed = false, failure: unknown;
          try { permission.selectJson(await readPackageRequestJson(request, body.body)); }
          catch (cause) { failed = true; failure = cause; }
          try { const first = body.dispose(); expect(body.dispose()).toBe(first); await first; }
          catch (cleanup) { throw failed ? new AggregateError([failure, cleanup], "Original Package JSON and first close failed") : cleanup; }
          if (failed) throw failure;
          const view = held.view = execution.packageDatabase([]);
          const statement = held.statement = view.prepare("SELECT id FROM samples WHERE id=? AND deleted_at IS NULL").bind(sampleId);
          expect(await statement.first<{ id: string }>()).toEqual({ id: sampleId });
          held.ready = true; held.prepared.resolve();
          // No transaction/native work remains outstanding across this actual
          // await. The exact already-prepared view retains its original lease.
          await held.issue.original;
          const code = kind === "logout" ? "authentication_required" : "unavailable";
          await refused(() => statement.first(), code);
          await refused(() => statement.all(), code);
          await refused(() => view.batch([statement]), code);
          held.denied.resolve();
          await held.restored.original;
          if (kind === "same-cookie-schema") expect(await statement.first<{ id: string }>()).toEqual({ id: sampleId });
          return Object.freeze({ denied: 3, positiveAfterRestoration: kind === "same-cookie-schema" });
        });
        void original.catch(cause => { held.failure = cause; held.prepared.reject(cause); held.denied.reject(cause); });
        const result = await original; return c.json(result);
      } catch (cause) { held.failure = cause; held.prepared.reject(cause); held.denied.reject(cause); throw cause; }
    });
    const server = owner.server = createNodeHttpServer(request => lease.withWriter(() => app.fetch(request)), {
      publicOrigin: origin, requestAdmission: (request, incoming, listener) => transport.admit(request, incoming, listener), timeoutMs: 5000,
    });
    await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(Number(new URL(origin).port), "127.0.0.1",
      () => { server.off("error", fail); done(); }); });
    const client = canonicalFileClient(owner, origin), session = await client.login("alice");
    held.originalResponse = client.request("/api/packages/jobs", "POST", { requestId: randomUUID(), kind: "data_package",
      roots: [{ kind: "sample", id: sampleId }] }, session);
    void held.originalResponse.catch(cause => { held.failure = cause; if (!held.ready) held.prepared.reject(cause); held.denied.reject(cause); });
    let failed = false, failure: unknown;
    try {
      await held.prepared.original; ensure(held.scope && held.view && held.statement);
      expect(native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL AND kind='http'").get()?.n).toBe(1);
      if (kind === "logout") {
        // Real current public logout, same original bearer/CSRF. The paused
        // Package Request still owns its source lease and prepared statement.
        expect((await client.request("/api/auth/logout", "POST", {}, session)).status).toBe(204);
        held.issue.resolve(); await held.denied.original; held.restored.resolve();
      } else await lease.withWriter(() => withActualSchemaWriter(baseline.path, lease, core, native, async writer => {
        const originalCookie = cookie(native), trigger = native.prepare(`SELECT rowid AS schema_rowid,sql FROM sqlite_schema
          WHERE type='trigger' AND name='collaboration_control_update_guard' AND tbl_name='collaboration_control'`).get();
        ensure(typeof trigger?.schema_rowid === "number" && typeof trigger.sql === "string");
        const rowid = trigger.schema_rowid, originalSql = trigger.sql;
        expect(cookie(writer)).toBe(originalCookie); expect(native.prepare("PRAGMA writable_schema").get()?.writable_schema).toBe(0);
        // The original application's Native remains defensive. This assertion
        // also proves that this separate actual fault writer is necessary.
        expect(() => native.prepare("UPDATE sqlite_schema SET sql=? WHERE rowid=?").run(originalSql, rowid)).toThrow(/sqlite_master may not be modified/);
        let faultFailed = false, faultFailure: unknown;
        try {
          writer.exec("PRAGMA writable_schema=ON");
          expect(writer.prepare("UPDATE sqlite_schema SET sql=? WHERE rowid=?").run(originalSql + " /* original Package prepared-view fault */", rowid).changes).toBe(1);
          writer.exec("PRAGMA writable_schema=OFF"); expect(writer.isTransaction).toBe(false);
          expect(cookie(writer)).toBe(originalCookie); expect(cookie(native)).toBe(originalCookie);
          expect(writer.prepare("PRAGMA writable_schema").get()?.writable_schema).toBe(0);
          expect(native.prepare("PRAGMA writable_schema").get()?.writable_schema).toBe(0);
          assertLinuxWriterLeaseBinding(lease, core, native);
          held.issue.resolve(); await held.denied.original;
        } catch (cause) { faultFailed = true; faultFailure = cause; }
        try {
          writer.exec("PRAGMA writable_schema=ON");
          expect(writer.prepare("UPDATE sqlite_schema SET sql=? WHERE rowid=?").run(originalSql, rowid).changes).toBe(1);
          writer.exec("PRAGMA writable_schema=OFF"); expect(writer.isTransaction).toBe(false);
          expect(cookie(writer)).toBe(originalCookie); expect(cookie(native)).toBe(originalCookie);
          expect(native.prepare("SELECT sql FROM sqlite_schema WHERE rowid=?").get(rowid)?.sql).toBe(originalSql);
          expect(writer.prepare("PRAGMA writable_schema").get()?.writable_schema).toBe(0);
        } catch (cleanup) { throw faultFailed ? new AggregateError([faultFailure, cleanup], "Original Package schema fault and restoration failed") : cleanup; }
        finally { held.restored.resolve(); }
        if (faultFailed) throw faultFailure;
      }));
    } catch (cause) { failed = true; failure = cause; }
    try {
      const first = finishHeld(held); expect(finishHeld(held)).toBe(first);
      const answer = await first; expect(answer.status).toBe(200);
      expect(answer.value).toEqual({ denied: 3, positiveAfterRestoration: kind === "same-cookie-schema" });
    } catch (cleanup) { throw failed ? new AggregateError([failure, cleanup], "Original Package negative and settlement failed") : cleanup; }
    if (failed) throw failure;
    // Only after every original work/body/native-fault promise ACKs: zero
    // leases and no fabricated Package jobs, requests, Files or domain writes.
    expect(native.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()?.n).toBe(0);
    expect(native.prepare("SELECT count(*) n FROM research_package_jobs").get()?.n).toBe(0);
    expect(native.prepare("SELECT count(*) n FROM research_package_requests").get()?.n).toBe(0);
    expect(native.prepare("SELECT count(*) n FROM files").get()?.n).toBe(0);
    expect(native.prepare("SELECT id FROM samples WHERE id=?").get(sampleId)).toEqual({ id: sampleId });
    expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const stopped = stopNodeHttpServerAndDrain(server); expect(stopNodeHttpServerAndDrain(server)).toBe(stopped); await stopped;
    const firstPermissionsClose = permissions.close(); expect(permissions.close()).toBe(firstPermissionsClose); await firstPermissionsClose;
  });
  assertCanonicalFileOwnersReleased(); ensure(heldOwners.size === 0 && schemaWriters.size === 0);
}

describe("current V28 original Package prepared-view permission and Native currentness", () => {
  it("refuses an already prepared genuine Package Sample read after real HTTP session logout and drains the original source lease",
    () => retainedCanonicalFileCase(() => caseWork("logout")), CASE_MS);
  it("refuses an already prepared genuine Package Sample read after a same-cookie original-trigger fault and restores the original first closes",
    () => retainedCanonicalFileCase(() => caseWork("same-cookie-schema")), CASE_MS);
});

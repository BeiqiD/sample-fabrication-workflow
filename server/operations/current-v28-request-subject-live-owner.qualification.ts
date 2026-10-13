import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createInstalledLocalIdentity } from "../auth/identity.ts";
import { createPasswordHasher } from "../auth/passwords.ts";
import { createLocalAuthentication } from "../auth/local-auth-http.ts";
import { createLoopbackLocalAuthTransport } from "../auth/local-auth-transport.ts";
import { createLocalRequestSubjectIssuer, LocalRequestSubjectError, type LocalRequestSubject } from "../auth/local-request-subject.ts";
import { createNodeHttpServer } from "../http.ts";
import { V28_NODE_INSTALLATION_CATALOG_CANDIDATE } from "../installation-catalog-v28-candidate.ts";
import { admitInstallationRecoverySource, type ReviewedInstallationAdmission } from "../migrations.ts";
import type { SqliteCapability } from "../sqlite.ts";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "./writer-lease.ts";
import { executeV28OrdinaryAccountOperatorCandidate } from "./ordinary-account-v28-candidate.ts";
import { CANONICAL_FILE_PASSWORD, CANONICAL_FILE_IDENTITY_POLICY, prepareCanonicalCommentFileBaseline,
  retainedCanonicalFileCase, withCanonicalFileDatabase, canonicalFilePrivateOrigin, canonicalFileClient,
  canonicalFileObject, assertCanonicalFileOwnersReleased, type CanonicalFileSession } from "../collaboration/current-v28-canonical-comment-file.qualification-support.ts";

// New finite qualification only. The genuine baseline/setup owns its existing
// first closes. Every HTTP client and this real HTTP server retain the original
// 5000ms limit; the dedicated config retains ordinary 20s defaults/hooks.
const CASE_MS = 60_000;
type Issuer = ReturnType<typeof createLocalRequestSubjectIssuer>;
type Captured = Readonly<{ request: Request; token: LocalRequestSubject }>;
interface SchemaWriterOwner {
  native?: DatabaseSync; constructionStarted?: true; originalClose?: () => void;
  setDefensive?: (enabled: boolean) => void; originalWork?: Promise<void>; firstClose?: Promise<void>;
  failed: boolean; failure?: unknown;
}
const schemaWriters = new Set<SchemaWriterOwner>();
afterEach(() => {
  if (schemaWriters.size) throw new AggregateError([...schemaWriters].map(owner => owner.failed ? owner.failure
    : owner.firstClose ?? owner.originalWork ?? new Error("Original test schema Native constructor/close is unproven")),
    "Original test schema writer Native ownership remains retained");
});
function ensure(value: unknown): asserts value { if (!value) throw new Error("Original current request-subject qualification owner is unavailable"); }
function rememberSchemaWriter(owner: SchemaWriterOwner, error: unknown): void {
  if (!owner.failed) { owner.failed = true; owner.failure = error; }
}
function closeSchemaWriter(owner: SchemaWriterOwner): Promise<void> {
  if (owner.firstClose) return owner.firstClose;
  owner.firstClose = Promise.resolve().then(() => {
    ensure(owner.native && owner.originalClose);
    const failures: unknown[] = [];
    // Only this actual test-owned second Native has its defensive mode changed.
    // Attempt its original close once even if restoring that mode rejects.
    try { owner.setDefensive?.(true); } catch (error) { failures.push(error); }
    try { owner.originalClose(); ensure(!owner.native.isOpen); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Original test schema Native first close failed");
    schemaWriters.delete(owner);
  }).catch(error => { rememberSchemaWriter(owner, error); throw error; });
  void owner.firstClose.catch(() => undefined); return owner.firstClose;
}
async function withActualSchemaWriter(path: string, lease: LinuxWriterLease, database: SqliteCapability,
  originalNative: DatabaseSync, work: (writer: DatabaseSync) => void | Promise<void>): Promise<void> {
  // The unchanged original physical writer owns this whole awaited setup/work/
  // close scope. Never bind the second Native to that lease/core or mint any
  // identity/admission/callback authority from it; it is a test fault writer.
  const owner: SchemaWriterOwner = { failed: false }; schemaWriters.add(owner);
  let failed = false, failure: unknown;
  try {
    assertLinuxWriterLeaseBinding(lease, database, originalNative);
    owner.constructionStarted = true;
    const writer = owner.native = new DatabaseSync(path, { allowExtension: false, enableForeignKeyConstraints: true });
    owner.originalClose = writer.close.bind(writer);
    ensure(writer !== originalNative);
    const enable = Reflect.get(writer, "enableDefensive") as unknown;
    ensure(typeof enable === "function");
    owner.setDefensive = enabled => { Reflect.apply(enable, writer, [enabled]); };
    owner.setDefensive(false);
    ensure(!writer.isTransaction);
    assertLinuxWriterLeaseBinding(lease, database, originalNative);
    const original = owner.originalWork = Promise.resolve().then(() => work(writer));
    void original.catch(() => undefined); await original;
    assertLinuxWriterLeaseBinding(lease, database, originalNative);
  } catch (error) { failed = true; failure = error; rememberSchemaWriter(owner, error); }
  try { const first = closeSchemaWriter(owner); expect(closeSchemaWriter(owner)).toBe(first); await first; }
  catch (cleanup) { throw failed ? new AggregateError([failure, cleanup], "Original test schema fault and Native first close failed") : cleanup; }
  if (failed) throw failure;
  assertLinuxWriterLeaseBinding(lease, database, originalNative);
}
function refusal(work: () => unknown, code: LocalRequestSubjectError["code"]): void {
  const failures: unknown[] = [];
  try { work(); } catch (error) { failures.push(error); }
  expect(failures).toHaveLength(1);
  expect(failures[0]).toBeInstanceOf(LocalRequestSubjectError);
  expect(failures[0]).toMatchObject({ code });
}
function restoredFault(work: () => void, restore: () => void): void {
  // These are test-owned SQL fault/restoration calls, never an authority or
  // physical owner. Preserve the first failure, including falsy thrown values.
  let failed = false, failure: unknown;
  try { work(); } catch (error) { failed = true; failure = error; }
  try { restore(); }
  catch (cleanup) { throw failed ? new AggregateError([failure, cleanup], "Original metadata fault and restoration failed") : cleanup; }
  if (failed) throw failure;
}
function schemaCookie(native: DatabaseSync): number {
  const value = native.prepare("PRAGMA main.schema_version").get()?.schema_version;
  ensure(typeof value === "number" && Number.isSafeInteger(value) && value >= 0); return value;
}
function actualControlTrigger(native: DatabaseSync, name: string) {
  const row = native.prepare("SELECT rowid AS schema_rowid,type,name,tbl_name,rootpage,sql FROM sqlite_schema WHERE name=? AND type='trigger'").get(name);
  ensure(row && typeof row.schema_rowid === "number" && Number.isSafeInteger(row.schema_rowid) && row.schema_rowid > 0
    && row.type === "trigger" && typeof row.name === "string" && row.name === name && row.tbl_name === "collaboration_control" && row.rootpage === 0
    && typeof row.sql === "string");
  return Object.freeze({ rowid: row.schema_rowid, type: row.type, name: row.name, tableName: row.tbl_name, sql: row.sql });
}
function authorityRows(native: DatabaseSync) {
  // Existing lawful Alice/Bob Group authority belongs to the original baseline.
  // The new ordinary subject receives none; these exact rows stay unchanged.
  return {
    administrators: native.prepare("SELECT * FROM local_admin_grants ORDER BY principal_id").all(),
    control: native.prepare("SELECT * FROM collaboration_control ORDER BY singleton").all(),
    members: native.prepare("SELECT * FROM collaboration_members ORDER BY member_id").all(),
    identities: native.prepare("SELECT * FROM collaboration_identities ORDER BY provider,issuer,subject").all(),
    resources: native.prepare("SELECT * FROM collaboration_resources ORDER BY root_kind,root_id").all(),
    grants: native.prepare("SELECT * FROM collaboration_grants ORDER BY root_kind,root_id,member_id").all(),
  };
}

describe("current V28 genuine HTTP request-subject live execution owner", () => {
  it("keeps ordinary facts current through warm metadata faults, same-cookie schema edits, explicit reconstruction and account revocation", () => retainedCanonicalFileCase(async () => {
    const baseline = await prepareCanonicalCommentFileBaseline();
    assertCanonicalFileOwnersReleased();
    const ordinary = await executeV28OrdinaryAccountOperatorCandidate({ databasePath: baseline.path,
      filesystemRootOwnerUid: baseline.rootOwnerUid, kind: "provision-account", username: "subject-only" }, CANONICAL_FILE_PASSWORD);
    expect(ordinary.systemAdministrator).toBe(false);
    const ended = await withCanonicalFileDatabase(baseline.path, async (owner, lease, native, core) => {
      const originalAuthority = authorityRows(native);
      expect(native.prepare("SELECT count(*) n FROM local_admin_grants WHERE principal_id=?").get(ordinary.principalId)?.n).toBe(0);
      expect(native.prepare("SELECT count(*) n FROM collaboration_identities WHERE provider='local' AND subject=?").get(ordinary.principalId)?.n).toBe(0);
      const origin = await canonicalFilePrivateOrigin(owner), transport = createLoopbackLocalAuthTransport({ publicOrigin: origin });
      let admission!: ReviewedInstallationAdmission;
      let identity!: Awaited<ReturnType<typeof createInstalledLocalIdentity>>;
      let authentication!: ReturnType<typeof createLocalAuthentication>;
      let issuer!: Issuer;
      async function reconstructFromFullAdmission(): Promise<void> {
        await lease.withWriter(async () => {
          assertLinuxWriterLeaseBinding(lease, core, native);
          // Reconstruction mints a fresh full reviewed admission, not an owner
          // from a changed cookie or an observed schema/success cache.
          admission = admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE);
          identity = await createInstalledLocalIdentity({ database: core, nativeDatabase: native, admission,
            hasher: createPasswordHasher(), policy: CANONICAL_FILE_IDENTITY_POLICY });
          authentication = createLocalAuthentication({ identity, transport, now: () => Date.now() });
          issuer = createLocalRequestSubjectIssuer({ database: core, nativeDatabase: native, admission,
            writerLease: lease, authentication });
        });
      }
      await reconstructFromFullAdmission();
      let captured: Captured | undefined;
      const app = new Hono(); app.route("/api/auth", authentication.routes);
      app.onError(error => Response.json({ error: "Current request identity unavailable" }, { status: error instanceof HTTPException ? error.status
        : error instanceof LocalRequestSubjectError && error.code === "authentication_required" ? 401 : 503 }));
      app.on(["GET", "POST"], "/current-subject", async c => {
        const request = c.req.raw, token = await issuer.issue(request); captured = Object.freeze({ request, token });
        return c.json({ facts: issuer.read(request, token) });
      });
      const server = owner.server = createNodeHttpServer(request => lease.withWriter(() => app.fetch(request)), {
        publicOrigin: origin, requestAdmission: (request, incoming, listener) => transport.admit(request, incoming, listener), timeoutMs: 5000,
      });
      await new Promise<void>((done, fail) => {
        server.once("error", fail); server.listen(Number(new URL(origin).port), "127.0.0.1", () => { server.off("error", fail); done(); });
      });
      const client = canonicalFileClient(owner, origin);
      const login = await client.request("/api/auth/login", "POST", { username: "subject-only", password: CANONICAL_FILE_PASSWORD });
      expect(login.status).toBe(200);
      const loginValue = canonicalFileObject(login.value), principal = canonicalFileObject(loginValue.principal);
      expect(principal.id).toBe(ordinary.principalId);
      expect(principal.capabilities).toEqual({ systemAdministrator: false, fileEvidenceOperator: false });
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0], csrf = loginValue.csrf;
      ensure(typeof cookie === "string" && cookie.startsWith("sfw_dev_session=") && typeof csrf === "string");
      const session: CanonicalFileSession = Object.freeze({ cookie, csrf });
      const facts = { provider: "local", issuer: `node-installation:${baseline.installationId}`, subject: ordinary.principalId };
      async function currentHttp(method: "GET" | "POST" = "GET"): Promise<Captured> {
        const answer = await client.request("/current-subject", method, method === "POST" ? {} : undefined, session);
        expect(answer.status).toBe(200); expect(answer.value).toEqual({ facts });
        expect(answer.text).not.toContain(session.cookie.slice("sfw_dev_session=".length));
        ensure(captured); return captured;
      }
      let issued = await currentHttp();
      const warmIssuer = issuer;
      await lease.withWriter(() => {
        assertLinuxWriterLeaseBinding(lease, core, native);
        expect(issuer.read(issued.request, issued.token)).toEqual(facts);
        refusal(() => issuer.read(issued.request.clone(), issued.token), "not_issued");
        refusal(() => issuer.read(issued.request, { ...issued.token } as LocalRequestSubject), "not_issued");
        const second = createLocalRequestSubjectIssuer({ database: core, nativeDatabase: native, admission, writerLease: lease, authentication });
        refusal(() => second.read(issued.request, issued.token), "not_issued");
        expect(() => createLocalRequestSubjectIssuer({ database: core, nativeDatabase: native, admission,
          writerLease: { ...lease } as LinuxWriterLease, authentication })).toThrow();
        expect(() => createLocalRequestSubjectIssuer({ database: core, nativeDatabase: new Proxy(native, {}), admission,
          writerLease: lease, authentication })).toThrow();
        expect(() => createLocalRequestSubjectIssuer({ database: { ...core } as SqliteCapability, nativeDatabase: native, admission,
          writerLease: lease, authentication })).toThrow();
        expect(() => createLocalRequestSubjectIssuer({ database: core, nativeDatabase: native,
          admission: { ...admission }, writerLease: lease, authentication })).toThrow();
      });
      // Genuine unsafe requests use the actual delivered CSRF. A new request
      // without it refuses before it can replace the successfully issued token.
      issued = await currentHttp("POST");
      expect((await client.request("/current-subject", "POST", {}, session, { "x-sfw-csrf": "" })).status).toBe(403);
      await lease.withWriter(async () => {
        const originalCookie = schemaCookie(native);
        const ledgerHash = native.prepare("SELECT raw_sha256 FROM node_migrations WHERE ordinal=1").get()?.raw_sha256;
        ensure(typeof ledgerHash === "string");
        restoredFault(() => {
          native.prepare("UPDATE node_migrations SET raw_sha256=? WHERE ordinal=1").run("0".repeat(64));
          refusal(() => issuer.read(issued.request, issued.token), "unavailable");
        }, () => { native.prepare("UPDATE node_migrations SET raw_sha256=? WHERE ordinal=1").run(ledgerHash); });
        expect(issuer.read(issued.request, issued.token)).toEqual(facts);
        restoredFault(() => {
          native.prepare("UPDATE node_installation SET installation_id=? WHERE singleton=1").run(randomUUID());
          refusal(() => issuer.read(issued.request, issued.token), "unavailable");
        }, () => { native.prepare("UPDATE node_installation SET installation_id=? WHERE singleton=1").run(baseline.installationId); });
        expect(issuer.read(issued.request, issued.token)).toEqual(facts);
        restoredFault(() => {
          native.exec("PRAGMA foreign_keys=OFF");
          expect(native.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(0);
          refusal(() => issuer.read(issued.request, issued.token), "unavailable");
        }, () => { native.exec("PRAGMA foreign_keys=ON"); });
        expect(issuer.read(issued.request, issued.token)).toEqual(facts);
        restoredFault(() => {
          native.exec("ATTACH DATABASE ':memory:' AS qualification_subject_extra");
          refusal(() => issuer.read(issued.request, issued.token), "unavailable");
        }, () => { native.exec("DETACH DATABASE qualification_subject_extra"); });
        expect(issuer.read(issued.request, issued.token)).toEqual(facts);
        expect(native.prepare("PRAGMA writable_schema").get()?.writable_schema).toBe(0);
        const originalSql = native.prepare("SELECT sql FROM sqlite_schema WHERE name='local_accounts' AND type='table'").get()?.sql;
        ensure(typeof originalSql === "string");
        // The genuine bound application Native keeps its defensive setting.
        // Even a same-value metadata UPDATE must still be rejected there.
        expect(() => native.prepare("UPDATE sqlite_schema SET sql=? WHERE name='local_accounts' AND type='table'")
          .run(originalSql)).toThrow(/sqlite_master may not be modified/);
        await withActualSchemaWriter(baseline.path, lease, core, native, writer => {
          expect(() => createLocalRequestSubjectIssuer({ database: core, nativeDatabase: writer, admission,
            writerLease: lease, authentication })).toThrow(); // Actual distinct Native, same real DB path.
          expect(schemaCookie(writer)).toBe(originalCookie);
          assertLinuxWriterLeaseBinding(lease, core, native);
          restoredFault(() => {
            writer.exec("PRAGMA writable_schema=ON");
            expect(writer.prepare("UPDATE sqlite_schema SET sql=? WHERE name='local_accounts' AND type='table'")
              .run(originalSql + " /* original live-schema qualification suffix */").changes).toBe(1);
            expect(writer.isTransaction).toBe(false); // Original autocommit returned before application read.
            writer.exec("PRAGMA writable_schema=OFF");
            expect(writer.prepare("PRAGMA writable_schema").get()?.writable_schema).toBe(0);
            expect(native.prepare("PRAGMA writable_schema").get()?.writable_schema).toBe(0);
            // This is the missed-cookie fault: only live schema bytes change,
            // with privileged writable mode OFF before the current-owner read.
            expect(schemaCookie(writer)).toBe(originalCookie);
            expect(schemaCookie(native)).toBe(originalCookie);
            assertLinuxWriterLeaseBinding(lease, core, native);
            refusal(() => issuer.read(issued.request, issued.token), "unavailable");
          }, () => restoredFault(() => {
            assertLinuxWriterLeaseBinding(lease, core, native);
            writer.exec("PRAGMA writable_schema=ON");
            writer.prepare("UPDATE sqlite_schema SET sql=? WHERE name='local_accounts' AND type='table'").run(originalSql);
            expect(writer.isTransaction).toBe(false);
          }, () => { writer.exec("PRAGMA writable_schema=OFF"); }));
          expect(schemaCookie(writer)).toBe(originalCookie);
          expect(schemaCookie(native)).toBe(originalCookie);
          expect(native.prepare("PRAGMA writable_schema").get()?.writable_schema).toBe(0);
          expect(native.prepare("SELECT sql FROM sqlite_schema WHERE name='local_accounts' AND type='table'").get()?.sql).toBe(originalSql);
          assertLinuxWriterLeaseBinding(lease, core, native);
          expect(issuer.read(issued.request, issued.token)).toEqual(facts);
          // Same count, all rows individually known, but one required name is
          // missing and another appears twice. Change only a real saved trigger
          // metadata row (both original rootpage0), never any table/data page.
          const known = actualControlTrigger(native, "collaboration_control_update_guard");
          const replaced = actualControlTrigger(native, "collaboration_control_delete_guard");
          expect(known.rowid).not.toBe(replaced.rowid);
          const inventory = () => native.prepare("SELECT count(*) n,count(DISTINCT name COLLATE BINARY) d FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*'").get();
          const observedInventory = inventory();
          ensure(observedInventory && typeof observedInventory.n === "number" && typeof observedInventory.d === "number"
            && observedInventory.n === observedInventory.d && observedInventory.n > 1);
          const originalInventory = Object.freeze({ n: observedInventory.n, d: observedInventory.d });
          assertLinuxWriterLeaseBinding(lease, core, native);
          restoredFault(() => {
            writer.exec("PRAGMA writable_schema=ON");
            expect(writer.prepare("UPDATE sqlite_schema SET type=?,name=?,tbl_name=?,sql=? WHERE rowid=?")
              .run(known.type, known.name, known.tableName, known.sql, replaced.rowid).changes).toBe(1);
            expect(writer.isTransaction).toBe(false);
            writer.exec("PRAGMA writable_schema=OFF");
            expect(writer.prepare("PRAGMA writable_schema").get()?.writable_schema).toBe(0);
            expect(native.prepare("PRAGMA writable_schema").get()?.writable_schema).toBe(0);
            expect(schemaCookie(writer)).toBe(originalCookie);
            expect(schemaCookie(native)).toBe(originalCookie);
            expect(inventory()).toEqual({ n: originalInventory.n, d: originalInventory.d - 1 });
            expect(native.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='collaboration_control_update_guard'").get()?.n).toBe(2);
            expect(native.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='collaboration_control_delete_guard'").get()?.n).toBe(0);
            assertLinuxWriterLeaseBinding(lease, core, native);
            refusal(() => issuer.read(issued.request, issued.token), "unavailable");
          }, () => restoredFault(() => {
            assertLinuxWriterLeaseBinding(lease, core, native);
            writer.exec("PRAGMA writable_schema=ON");
            writer.prepare("UPDATE sqlite_schema SET type=?,name=?,tbl_name=?,sql=? WHERE rowid=?")
              .run(replaced.type, replaced.name, replaced.tableName, replaced.sql, replaced.rowid);
            expect(writer.isTransaction).toBe(false);
          }, () => { writer.exec("PRAGMA writable_schema=OFF"); }));
          expect(schemaCookie(writer)).toBe(originalCookie);
          expect(schemaCookie(native)).toBe(originalCookie);
          expect(native.prepare("PRAGMA writable_schema").get()?.writable_schema).toBe(0);
          expect(inventory()).toEqual(originalInventory);
          expect(actualControlTrigger(native, known.name)).toEqual(known);
          expect(actualControlTrigger(native, replaced.name)).toEqual(replaced);
          assertLinuxWriterLeaseBinding(lease, core, native);
          expect(issuer.read(issued.request, issued.token)).toEqual(facts);
        });
        restoredFault(() => {
          native.exec("CREATE TEMP TABLE qualification_current_subject_temp(value)");
          refusal(() => issuer.read(issued.request, issued.token), "unavailable");
          expect(() => admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE)).toThrow();
        }, () => { native.exec("DROP TABLE temp.qualification_current_subject_temp"); });
        // Removing TEMP does not rewind the old captured TEMP cookie.
        refusal(() => warmIssuer.read(issued.request, issued.token), "unavailable");
      });
      await reconstructFromFullAdmission(); issued = await currentHttp();
      const beforeDdl = issuer, beforeDdlIssued = issued;
      await lease.withWriter(() => {
        const originalCookie = schemaCookie(native);
        restoredFault(() => {
          native.exec("CREATE INDEX qualification_current_subject_index ON local_sessions(principal_id)");
          expect(schemaCookie(native)).not.toBe(originalCookie);
          refusal(() => beforeDdl.read(beforeDdlIssued.request, beforeDdlIssued.token), "unavailable");
          expect(() => admitInstallationRecoverySource(native, V28_NODE_INSTALLATION_CATALOG_CANDIDATE)).toThrow();
        }, () => { native.exec("DROP INDEX qualification_current_subject_index"); });
        expect(schemaCookie(native)).not.toBe(originalCookie);
        refusal(() => beforeDdl.read(beforeDdlIssued.request, beforeDdlIssued.token), "unavailable");
        // The old private owner is not revived by returning to the same DDL.
      });
      await reconstructFromFullAdmission(); issued = await currentHttp();
      await lease.withWriter(async () => {
        expect(issuer.read(issued.request, issued.token)).toEqual(facts);
        await identity.offline(lease).disableAccount(ordinary.principalId, Date.now());
        refusal(() => issuer.read(issued.request, issued.token), "authentication_required");
      });
      const denied = await client.request("/current-subject", "GET", undefined, session); expect(denied.status).toBe(401);
      expect(native.prepare("SELECT count(*) n FROM local_admin_grants WHERE principal_id=?").get(ordinary.principalId)?.n).toBe(0);
      expect(native.prepare("SELECT count(*) n FROM collaboration_identities WHERE provider='local' AND subject=?").get(ordinary.principalId)?.n).toBe(0);
      expect(native.prepare("SELECT enabled FROM local_accounts WHERE principal_id=?").get(ordinary.principalId)?.enabled).toBe(0);
      expect(native.prepare("SELECT count(*) n FROM local_sessions WHERE principal_id=? AND revoked_at IS NULL").get(ordinary.principalId)?.n).toBe(0);
      expect(authorityRows(native)).toEqual(originalAuthority);
      expect(native.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      assertLinuxWriterLeaseBinding(lease, core, native);
      return Object.freeze({ issuer, issued });
    });
    assertCanonicalFileOwnersReleased();
    // Only after the unchanged helper's actual first native/physical close ACK:
    // an old real Request/token cannot revive the retired execution owner.
    refusal(() => ended.issuer.read(ended.issued.request, ended.issued.token), "unavailable");
  }), CASE_MS);
});

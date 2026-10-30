import { randomUUID } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import type { MiddlewareHandler } from "hono";
import { createFileMigrationRoutes, type FileMigrationEnvironment, type FileMigrationHttpRepository } from "../../../worker/files/migration-http-routes";
import { SqlFileJobRepository, type JobSqlDatabase, type JobSqlStatement } from "../../../worker/files/jobs/sql-repository";
import { setFileJobExecutionWithDatabase } from "../../../worker/files/jobs/executor-control-service";
import { ensureSqlFileAuthorityExecution } from "../../../worker/files/authority-execution-service";
import { localAuthenticationIdentityAuthority } from "../../auth/local-auth-http";
import { assertInstalledLocalIdentityOwner } from "../../auth/identity";
import type { ReviewedInstallationAdmission } from "../../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../../operations/writer-lease";
import { checkedSafeInteger, createSqliteBatchAdmission, runSqliteAdmittedBatch,
  type SqliteBatchAdmission, type SqliteRow, type SqliteStatement } from "../../sqlite";
import { ownedJobPrincipalAuthority, type InstalledJobPrincipalAuthority } from "./principal-authority";

type Operation = "list" | "inventory" | "executorStatus" | "setExecutor" | "plan" | "accept" | "requestReceipt" | "status" | "items" | "cleanup" | "control";
type Selection = Readonly<{ operation: Operation; jobId?: string; action?: string; requestId?: string }>;
type SourceLease = Readonly<{ id: string; generation: bigint }>;
function ingress(request: Request): Selection {
  const path = new URL(request.url).pathname, prefix = "/api/files/migrations";
  if (path === prefix && request.method === "GET") return Object.freeze({ operation: "list" });
  if (path === prefix && request.method === "POST") return Object.freeze({ operation: "accept" });
  if (path === prefix + "/files" && request.method === "GET") return Object.freeze({ operation: "inventory" });
  if (path === prefix + "/executor" && request.method === "GET") return Object.freeze({ operation: "executorStatus" });
  if (path === prefix + "/executor" && request.method === "POST") return Object.freeze({ operation: "setExecutor" });
  if (path === prefix + "/plans" && request.method === "POST") return Object.freeze({ operation: "plan" });
  const receipt = /^\/api\/files\/migrations\/requests\/([^/]+)$/.exec(path);
  if (receipt && request.method === "GET") {
    let requestId: string;
    try { requestId = decodeURIComponent(receipt[1]!); }
    catch { throw new HTTPException(400, { message: "Invalid File migration request path" }); }
    return Object.freeze({ operation: "requestReceipt", requestId });
  }
  const match = /^\/api\/files\/migrations\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (!match) throw new HTTPException(403, { message: "Original File job ingress is required." });
  let jobId: string, action: string | undefined;
  try { jobId = decodeURIComponent(match[1]!); action = match[2] === undefined ? undefined : decodeURIComponent(match[2]); }
  catch { throw new HTTPException(400, { message: "Invalid File job path" }); }
  if (request.method === "GET" && action === undefined) return Object.freeze({ operation: "status", jobId });
  if (request.method === "GET" && action === "items") return Object.freeze({ operation: "items", jobId });
  if (request.method === "POST" && action === "cleanup") return Object.freeze({ operation: "cleanup", jobId });
  if (request.method === "POST" && action !== undefined) return Object.freeze({ operation: "control", jobId, action });
  throw new HTTPException(403, { message: "Original File job ingress is required." });
}
function generation(cell: unknown): bigint {
  const exact = typeof cell === "bigint" ? cell : typeof cell === "number" && Number.isSafeInteger(cell) ? BigInt(cell) : -1n;
  if (exact < 0n || exact > 9223372036854775807n) throw new Error("Original File job source lease is unavailable");
  return exact;
}

/** A failed first cleanup retains the exact original request/SQL/source owner.
 * The application must retain its Native connection and physical writer lease,
 * closed to new ingress, rather than retry cleanup or release the lock. */
export class NodeFileJobHttpCleanupError extends Error {
  declare readonly originalCause: unknown;
  declare readonly cleanupCause: unknown;
  declare readonly owner: object;
  constructor(originalCause: unknown, cleanupCause: unknown, owner: object) {
    super("Original Node File job HTTP cleanup is unavailable."); this.name = "NodeFileJobHttpCleanupError";
    // Preserve exact custody without enumerating the original Request's cookie
    // or SQL owner in ordinary JSON/error logging.
    Object.defineProperties(this, {
      originalCause: { value: originalCause }, cleanupCause: { value: cleanupCause }, owner: { value: owner },
    });
  }
}

/** Complete, deliberately UNMOUNTED metadata HTTP component. It consumes the
 * existing composer's exact installed identity/core/physical lease, never a
 * second host or provider. The composer creates its original app Promise in
 * its one writerLease.withWriter boundary, stops this ingress, and awaits this
 * drain plus its actual transport/body/dispatcher owners before Native close.
 * These admin endpoints do not issue ordinary File/resource/Group grants. */
export function createNodeFileJobHttpRoutes<Bindings extends object>(options: {
  authority: InstalledJobPrincipalAuthority; authentication: object;
  admission: ReviewedInstallationAdmission; writerLease: LinuxWriterLease;
}) {
  const { authority, authentication, admission, writerLease } = Object.freeze({ ...options });
  const owner = ownedJobPrincipalAuthority(authority), auth = localAuthenticationIdentityAuthority(authentication);
  const policy = assertInstalledLocalIdentityOwner(auth.identity, owner.database, owner.nativeDatabase, admission);
  assertLinuxWriterLeaseBinding(writerLease, owner.database, owner.nativeDatabase);
  const core = owner.database, native = owner.nativeDatabase;
  let admitting = true, drainPromise: Promise<void> | undefined;
  type RequestOwner = {
    readonly request: Request; readonly actor: string; readonly selection: Selection;
    original?: Promise<void>; cleanup?: Promise<void>; readonly pending: Set<Promise<unknown>>;
    readonly repository: FileMigrationHttpRepository; readonly database: JobSqlDatabase;
    ensureFileExecution(): Promise<void>; acknowledge(): Promise<void>; canAdminister(): boolean; close(cause?: unknown): Promise<void>;
  };
  const byRequest = new WeakMap<Request, RequestOwner>(), requests = new Set<RequestOwner>();
  function physical(): void {
    owner.assertCurrent(); assertLinuxWriterLeaseBinding(writerLease, core, native);
    if (localAuthenticationIdentityAuthority(authentication) !== auth)
      throw new HTTPException(503, { message: "Original File job authentication owner changed." });
    assertInstalledLocalIdentityOwner(auth.identity, core, native, admission);
  }
  function createRequestOwner(request: Request, actor: string): RequestOwner {
    physical();
    if (!(request instanceof Request) || request.bodyUsed) throw new HTTPException(403, { message: "Original File job Request is required." });
    const selection = ingress(request), session = auth.currentSessionPredicate(request, actor);
    const fileState = native.prepare(`SELECT c.mode,g.enabled,g.incarnation FROM file_authority_control c
      JOIN file_authority_runtime_guard g ON g.singleton=c.singleton WHERE c.singleton=1`).get();
    if (!fileState || !["legacy", "overlap", "active"].includes(String(fileState.mode))
      || ![0, 1].includes(Number(fileState.enabled)) || !(fileState.incarnation === null || typeof fileState.incarnation === "string"))
      throw new HTTPException(503, { message: "Current File job installation is unavailable." });
    const fileMode = fileState.mode, fileEnabled = fileState.enabled, fileIncarnation = fileState.incarnation;
    const pending = new Set<Promise<unknown>>(), statements = new WeakMap<JobSqlStatement, SqliteStatement>();
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const leaseId = randomUUID(), createdAt = new Date().toISOString(), expiresAt = new Date(Date.parse(createdAt) + 300_000).toISOString();
    let source: SourceLease | undefined, acquisition: Promise<void> | undefined, release: Promise<void> | undefined;
    let closed = false, fileExecutionRequired = false, admissionFailure: HTTPException | undefined;
    const installation = owner.installation, identityInstallation = owner.identityInstallation;
    function current(): void {
      physical();
      if (closed || auth.currentSessionPredicate(request, actor).tokenHash !== session.tokenHash)
        throw new HTTPException(403, { message: "Original File job Request changed." });
    }
    function checks(includeMaintenance: boolean): SqliteBatchAdmission {
      current();
      const authenticationCheck = core.prepare(`SELECT 1 AS admitted FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id
        CROSS JOIN (WITH observed AS MATERIALIZED (SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now) SELECT now FROM observed) clock
        WHERE s.token_hash=? AND ('local-account:' || a.principal_id)=? AND a.enabled=1
          AND a.credential_revision=s.credential_revision AND s.revoked_at IS NULL
          AND typeof(clock.now)='integer' AND clock.now BETWEEN 0 AND 9007199254740991
          AND clock.now>=s.last_seen_at AND clock.now<s.absolute_expires_at AND clock.now<s.last_seen_at+? LIMIT 1`)
        .bind(session.tokenHash, actor, policy.idleLifetimeMs);
      const installed = core.prepare(`SELECT 1 AS admitted WHERE EXISTS(SELECT 1 FROM node_installation
        WHERE singleton=1 AND installation_id=? AND catalog_id=? AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)
        AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'
          AND bootstrap_principal_id=? AND initialized_at=?)`).bind(installation.installationId, installation.catalogId,
          installation.checkpointId, installation.schemaSha256, installation.createdAt,
          identityInstallation.bootstrapPrincipalId, identityInstallation.initializedAt);
      const administrator = core.prepare(`SELECT 1 AS admitted FROM local_admin_grants g JOIN local_accounts a ON a.principal_id=g.principal_id
        JOIN local_sessions s ON s.principal_id=a.principal_id WHERE s.token_hash=? AND ('local-account:' || a.principal_id)=? AND a.enabled=1 LIMIT 1`)
        .bind(session.tokenHash, actor);
      const file = core.prepare(`SELECT 1 AS admitted FROM file_authority_control c JOIN file_authority_runtime_guard g ON g.singleton=c.singleton
        WHERE c.singleton=1 AND c.mode=? AND g.enabled=? AND g.incarnation IS ?
          AND (?=0 OR c.mode<>'active' OR g.enabled=1)`).bind(fileMode, fileEnabled, fileIncarnation, fileExecutionRequired ? 1 : 0);
      const guards = [
        { statement: authenticationCheck, rejection: new HTTPException(401, { message: "Authentication is required." }) },
        { statement: installed, rejection: new HTTPException(503, { message: "Installation write admission is unavailable." }) },
        { statement: administrator, rejection: new HTTPException(403, { message: "System administrator access is required." }) },
        { statement: file, rejection: new HTTPException(503, { message: "Current File job installation changed." }) },
      ];
      if (includeMaintenance) guards.push({ statement: source ? core.prepare(`SELECT 1 AS admitted FROM system_recovery_maintenance m
          JOIN system_recovery_write_leases l ON l.id=? AND l.generation=? AND l.owner=? AND l.kind='http'
            AND l.created_at=? AND l.expires_at=? AND l.released_at IS NULL
          WHERE m.singleton=1 AND ((m.state='open' AND m.generation=l.generation)
            OR (m.state='draining' AND m.generation=l.generation+1))`).bind(source.id, source.generation, actor, createdAt, expiresAt)
        : core.prepare("SELECT 1 AS admitted FROM system_recovery_maintenance WHERE singleton=1 AND state='open'"),
        rejection: new HTTPException(503, { message: "Source mutations are paused for system recovery" }) });
      return createSqliteBatchAdmission(core, guards);
    }
    function remember<T>(promise: Promise<T>): Promise<T> {
      pending.add(promise);
      void promise.then(() => pending.delete(promise), error => {
        pending.delete(promise);
        if (error instanceof HTTPException && !admissionFailure) admissionFailure = error;
      });
      return promise;
    }
    function acquire(): Promise<void> {
      if (acquisition) return acquisition;
      acquisition = remember((async () => {
        const rows = await runSqliteAdmittedBatch(core, [core.prepare(`INSERT INTO system_recovery_write_leases(id,owner,kind,generation,created_at,expires_at)
          SELECT ?,?,'http',generation,?,? FROM system_recovery_maintenance WHERE singleton=1 AND state='open' RETURNING id,generation`)
          .bind(leaseId, actor, createdAt, expiresAt)], checks(true));
        const row = rows[0]?.results[0];
        if (!row || row.id !== leaseId) throw new HTTPException(503, { message: "Source mutations are paused for system recovery" });
        source = Object.freeze({ id: leaseId, generation: generation(row.generation) }); physical();
      })());
      return acquisition;
    }
    const execute = (items: readonly SqliteStatement[]) => remember((async () => {
      if (unsafe) await acquire();
      const result = await runSqliteAdmittedBatch(core, items, checks(unsafe)); physical(); return result;
    })());
    const row = (value: SqliteRow) => Object.fromEntries(Object.entries(value).map(([key, cell]) =>
      [key, typeof cell === "bigint" ? checkedSafeInteger(cell, `Column ${key}`) : cell]));
    function wrap(original: SqliteStatement): JobSqlStatement {
      const view: JobSqlStatement = {
        bind(...values) { current(); return wrap(original.bind(...values)); },
        async first<T>() { const found = (await execute([original]))[0]?.results[0]; return found === undefined ? null : row(found) as T; },
        async all<T>() { return { results: (await execute([original]))[0]!.results.map(value => row(value) as T) }; },
        async run() { return (await execute([original]))[0]!; },
      };
      statements.set(view, original); return Object.freeze(view);
    }
    const database: JobSqlDatabase = Object.freeze({
      prepare(sql: string) { current(); return wrap(core.prepare(sql)); },
      batch(items: JobSqlStatement[]) { return execute(items.map(item => {
        const statement = statements.get(item); if (!statement) throw new Error("Foreign original Node File job statement"); return statement;
      })); },
      primary() { current(); core.primary(); return database; },
    });
    const originalRepository = new SqlFileJobRepository(database, () => new Date(), randomUUID);
    function select(operation: Operation | Operation[], jobId?: string, action?: string, requestId?: string): void {
      current();
      if (!(Array.isArray(operation) ? operation.includes(selection.operation) : operation === selection.operation)
        || jobId !== selection.jobId || action !== selection.action || requestId !== selection.requestId)
        throw new HTTPException(403, { message: "Original File job operation changed." });
    }
    function canAdminister(): boolean {
      try {
        current();
        // Early callbacks retain the mature repository's original boolean
        // contract. Actual session/admin checks still run in every real BEGIN.
        return !!native.prepare(`SELECT 1 FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id
          JOIN local_admin_grants g ON g.principal_id=a.principal_id
          WHERE s.token_hash=? AND ('local-account:' || a.principal_id)=? AND a.enabled=1
            AND s.revoked_at IS NULL AND s.credential_revision=a.credential_revision`).get(session.tokenHash, actor);
      } catch { return false; }
    }
    const repository: FileMigrationHttpRepository = Object.freeze({
      list() { select("list"); return originalRepository.list(); },
      inventory(input) { select("inventory"); return originalRepository.inventory(input); },
      executorStatus() { select(["executorStatus", "setExecutor"]); return originalRepository.executorStatus(); },
      plan(input) { select("plan"); return originalRepository.plan(input); },
      accept(input, selectedActor, authorize) {
        select("accept"); if (selectedActor !== actor) throw new HTTPException(403, { message: "Original File job actor changed." });
        return originalRepository.accept(input, actor, () => canAdminister() && (!authorize || authorize() === true));
      },
      requestReceipt(requestId, selectedActor) {
        select("requestReceipt", undefined, undefined, requestId);
        if (selectedActor !== actor) throw new HTTPException(403, { message: "Original File job actor changed." });
        return originalRepository.requestReceipt(requestId, actor);
      },
      status(id) { select(["status", "items"], id); return originalRepository.status(id); },
      items(id, cursor) { select("items", id); return originalRepository.items(id, cursor); },
      requestCleanup(id, selectedActor, authorize) {
        select("cleanup", id); if (selectedActor !== actor) throw new HTTPException(403, { message: "Original File job actor changed." });
        return originalRepository.requestCleanup(id, actor, () => canAdminister() && (!authorize || authorize() === true));
      },
      control(id, action) { select("control", id, action); return originalRepository.control(id, action); },
    });
    let record!: RequestOwner;
    record = { request, actor, selection, pending, database, repository, canAdminister,
      async ensureFileExecution() {
        select(["accept", "control", "cleanup"], selection.jobId, selection.action);
        fileExecutionRequired = true;
        await ensureSqlFileAuthorityExecution(() => ({ prepare(sql) {
          const prepared = database.prepare(sql);
          return { bind(...values) { return prepared.bind(...values); }, first: () => prepared.first(), all: () => prepared.all() };
        } }));
      },
      async acknowledge() {
        if (admissionFailure) throw admissionFailure;
        // Invalid input never acquires a source lease solely for an ACK read.
        await runSqliteAdmittedBatch(core, [core.prepare("SELECT 1 AS admitted")], checks(unsafe)); physical();
      },
      close(cause?: unknown) {
        if (record.cleanup) return record.cleanup;
        closed = true;
        record.cleanup = (async () => {
          while (pending.size) await Promise.allSettled([...pending]);
          physical();
          if (!source && acquisition) {
            // The original acquisition has settled. Read only its exact
            // immutable receipt; do not repeat admission or infer expiry.
            const receipt = await core.primary().prepare(`SELECT id,generation,released_at FROM system_recovery_write_leases
              WHERE id=? AND owner=? AND kind='http' AND created_at=? AND expires_at=?`).bind(leaseId, actor, createdAt, expiresAt).first();
            physical();
            if (receipt) {
              if (receipt.released_at !== null) throw new Error("Original File job source lease ownership changed");
              source = Object.freeze({ id: leaseId, generation: generation(receipt.generation) });
            }
          }
          if (source) {
            const exact = source;
            release = (async () => {
              physical(); const at = new Date().toISOString();
              const result = await core.primary().prepare(`UPDATE system_recovery_write_leases SET released_at=?
                WHERE id=? AND generation=? AND owner=? AND kind='http' AND created_at=? AND expires_at=? AND released_at IS NULL`)
                .bind(at, exact.id, exact.generation, actor, createdAt, expiresAt).run();
              physical();
              if (result.meta.directChanges !== 1) throw new Error("Original File job source lease release is unavailable");
              const receipt = await core.primary().prepare(`SELECT released_at FROM system_recovery_write_leases
                WHERE id=? AND generation=? AND owner=? AND kind='http' AND created_at=? AND expires_at=?`)
                .bind(exact.id, exact.generation, actor, createdAt, expiresAt).first();
              physical(); if (receipt?.released_at !== at) throw new Error("Original File job source lease release ACK is unavailable");
            })();
            await release;
          }
        })().catch(error => { throw new NodeFileJobHttpCleanupError(cause, error, Object.freeze({ record, authority, writerLease, acquisition, release })); });
        record.cleanup.then(() => undefined, () => undefined); return record.cleanup;
      },
    };
    return record;
  }
  const select = (request: Request, actor: string): RequestOwner => {
    const record = byRequest.get(request);
    if (!record || record.actor !== actor) throw new HTTPException(403, { message: "Original File job request owner is unavailable." });
    return record;
  };
  const administrator: MiddlewareHandler<FileMigrationEnvironment<Bindings>> = async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    const existing = byRequest.get(c.req.raw);
    if (existing) { await next(); return; }
    if (!admitting) throw new HTTPException(503, { message: "Node File job HTTP admission is closed." });
    // Capture original ingress before any body parsing; lookup rejects an
    // independently constructed Request even with the same cookie and URL.
    const record = createRequestOwner(c.req.raw, c.get("userEmail"));
    byRequest.set(record.request, record); requests.add(record);
    let bodyCause: unknown;
    record.original = (async () => {
      try {
        const principal = await auth.authenticateRequest(record.request);
        if (principal.actor !== record.actor || principal.capabilities.systemAdministrator !== true)
          throw new HTTPException(403, { message: "System administrator access is required." });
        await next(); await record.acknowledge();
      } catch (error) { bodyCause = error; throw error; }
      finally {
        await record.close(bodyCause);
        requests.delete(record); byRequest.delete(record.request);
      }
    })();
    record.original.then(() => undefined, () => undefined);
    await record.original;
  };
  const routes = createFileMigrationRoutes<Bindings>({
    administrator,
    repository: (request, _bindings, actor) => select(request, actor).repository,
    ensureFileExecution: (request, _bindings, actor) => select(request, actor).ensureFileExecution(),
    canAdminister: (request, _bindings, actor) => select(request, actor).canAdminister(),
    setExecution(request, _bindings, actor, enabled) {
      const record = select(request, actor);
      if (record.selection.operation !== "setExecutor") throw new HTTPException(403, { message: "Original File job operation changed." });
      return setFileJobExecutionWithDatabase(record.database, record.repository, enabled);
    },
  });
  return Object.freeze({ routes,
    stopAdmission() { admitting = false; },
    drain() {
      if (drainPromise) return drainPromise;
      admitting = false;
      drainPromise = (async () => {
        while (requests.size) {
          const retained = [...requests];
          await Promise.allSettled(retained.map(record => record.original));
          for (const record of retained) {
            // Same cached first cleanup outcome; failure keeps its strong
            // record plus Native/physical owner for application quarantine.
            await record.close();
          }
        }
      })();
      drainPromise.then(() => undefined, () => undefined); return drainPromise;
    },
  });
}

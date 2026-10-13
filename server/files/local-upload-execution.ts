import { consumeLocalPackageExecutionPermissionV28Candidate, ownedLocalPackagePermissionV28Candidate,
  type LocalPackagePermissionV28Candidate } from "../packages/local-permission-v28-candidate";
import { consumeLocalFabubloxExecutionPermissionV28Candidate, ownedLocalFabubloxPermissionV28Candidate,
  type LocalFabubloxPermissionV28Candidate } from "../imports/local-fabublox-permission-v28-candidate";
import type { PreparedFabubloxPayload } from "../../worker/imports/fabublox-payload";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { captureInstalledIdentityExecutionOwner } from "../auth/installed-identity-execution-owner";
import { ownedLocalVolumeIdentityV28Candidate } from "../storage/local-volume-profile-opening";
import { consumeLocalCommentExecutionPermissionV28Candidate, ownedLocalCommentPermissionV28Candidate,
  type LocalCommentPermissionV28Candidate } from "./local-comment-permission-v28-candidate";
import type { LocalVolumeProfileOpeningV28Candidate } from "../storage/local-volume-profile-opening-v28-candidate";
import { runSqliteAdmittedBatch, asAdmittedJobSqlDatabase, joinSqliteBatchAdmissions } from "../sqlite";
import { PACKAGE_HTTP_ROUTES } from "../../worker/packages/routes-core";
import type { JobSqlDatabase } from "../../worker/files/jobs/sql-repository";
import { HTTPException } from "hono/http-exception";
import { configurationSqlInteger } from "../../worker/runtime/configuration-sql";
import type { AuthorityProfileOpener } from "../../worker/files/authority-profile-opening";
import { readPublishedFileOwned, type OwnedPublishedFileRead } from "../../worker/files/authority-reader-core";
import type { FilePurpose } from "../../shared/contracts/files";
import { openStorageProfile, StorageProfileCleanupError, type OpenedStorageProfile } from "../../worker/files/storage-profile-opening";
import type { ReviewedInstallationAdmission } from "../migrations";
import { asAdmittedFileAuthoritySqlDatabase, asFileAuthoritySqlDatabase, type NativeFileAuthoritySqlDatabase } from "../file-authority-sql";
import { createSqliteBatchAdmission } from "../sqlite";
import { captureLocalVolumeProfileAuthority, createAdmittedLocalVolumeFileAuthorityDatabase,
  ownedLocalVolumeProfileContext, prepareLocalVolumeProfileSqliteFence, type LocalVolumeProfileAuthority, type LocalVolumeProfileOpening } from "../storage/local-volume-profile-opening";

/** Internal ordinary system-scope upload execution only. This is not a public
 * route, a resource-link grant, a Job/Comment/import executor, or permission to
 * activate File/volumes. The trusted composer supplies the exact authenticated
 * original Request before body work. The actual current V26 opening is required. */
export interface LocalUploadExecution {
  readonly actor: string;
  readonly incarnation: string;
  /** Only the genuine Package Request issuer exposes this same-core facade. */
  readonly packageDatabase?: (authorities?: readonly LocalVolumeProfileAuthority[]) => JobSqlDatabase;
  readonly packageSettlementDatabase?: () => JobSqlDatabase;
  readonly assertPackageRequestCurrent?: () => Promise<void>;
  readonly packageActorAllowed?: () => boolean;
  readonly openProfile: AuthorityProfileOpener;
  database(authorities: readonly LocalVolumeProfileAuthority[]): NativeFileAuthoritySqlDatabase;
  historyDatabase(): NativeFileAuthoritySqlDatabase;
  /** Present only on a privately issued V28 canonical Comment execution. */
  readonly readCommentAcceptanceBody?: (maximum: number) => Promise<ArrayBuffer>;
  readonly assertCommentRequestCurrent?: () => Promise<void>;
  /** Present only on the genuine privately issued original import execution. */
  readonly readFabubloxImportPayload?: () => Promise<PreparedFabubloxPayload & { requestId: string }>;
  readonly assertFabubloxRequestCurrent?: () => Promise<void>;
  /** Metadata acceptance only; original physical pins and current pre-provider
   * purpose checks stay owned, while openProfile still requires its receipt. */
  readonly fabubloxAcceptanceDatabase?: (authorities: readonly LocalVolumeProfileAuthority[]) => NativeFileAuthoritySqlDatabase;
  /** Caller first authorizes the exact accepted/business File. The returned
   * read scope owns its original body/disposer and independent hold release. */
  openRead(input: Readonly<{ fileId: string | null; purpose: FilePurpose }>): Promise<OwnedPublishedFileRead>;
}
const executions = new WeakMap<LocalUploadExecution, Readonly<{ opening: LocalVolumeProfileOpening; request: Request; actor: string;
  packageRequest: boolean; assertHeld(): void; assertPhysicalHeld(): void }>>();
/** Additional internal composer check: a copied callback bag cannot stand in
 * for an original currently held authenticated execution. No new grant issues. */
export function assertLocalUploadExecutionOwner(execution: LocalUploadExecution, opening: LocalVolumeProfileOpening): void {
  const issued = executions.get(execution);
  if (!issued || issued.opening !== opening) throw new Error("Original local upload execution is unavailable");
  issued.assertHeld();
}
/** Same original Request and actor, registered only by the genuine execution
 * issuer. It narrows an already-held owner; a copied execution or options bag
 * cannot create permission or start a second source lifetime. */
export function assertLocalUploadExecutionRequestOwner(execution: LocalUploadExecution,
  opening: LocalVolumeProfileOpening, request: Request, actor: string): void {
  const issued = executions.get(execution);
  if (!issued || issued.opening !== opening || issued.request !== request || issued.actor !== actor)
    throw new Error("Original local upload Request execution is unavailable");
  issued.assertHeld();
}
/** Exact original physical/source lifetime only. This permits the closed
 * import owner to inspect its own uncertain finalization after live Request
 * denial. It issues no SQL view, business permission or provider callback. */
export function assertLocalUploadExecutionPhysicalRequestOwner(execution: LocalUploadExecution,
  opening: LocalVolumeProfileOpening, request: Request, actor: string): void {
  const issued = executions.get(execution);
  if (!issued || issued.opening !== opening || issued.request !== request || issued.actor !== actor)
    throw new Error("Original local upload physical Request execution is unavailable");
  issued.assertPhysicalHeld();
}
const LOCAL_REQUEST_SESSION_SQL = `SELECT 1 AS admitted FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id
      CROSS JOIN (WITH observed AS MATERIALIZED (SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now)
        SELECT now FROM observed) clock
      WHERE s.token_hash=? AND ('local-account:' || a.principal_id)=? AND a.enabled=1
        AND a.credential_revision=s.credential_revision AND s.revoked_at IS NULL
        AND typeof(clock.now)='integer' AND clock.now BETWEEN 0 AND 9007199254740991
        AND clock.now >= s.last_seen_at AND clock.now < s.absolute_expires_at AND clock.now < s.last_seen_at + ?
        AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1') LIMIT 1`;
interface DurableLease { readonly id: string; readonly generation: number }
interface ProfileOwner { readonly profile: OpenedStorageProfile<"local">; dispose(): Promise<void> }

/** One trusted request lifetime. Every original profile opening is retained,
 * every returned disposer is memoized before callers receive it, and lease
 * release follows the original openings and provider disposal. A timer or a
 * raced business Promise is never evidence that the original transport stopped. */
export function createLocalUploadExecution(options: {
  opening: LocalVolumeProfileOpening; request: Request; actor: string;
  admission: ReviewedInstallationAdmission; authentication: object;
}) {
  return createOwnedLocalUploadExecution(options);
}
/** Private concrete V26 Package request issuer. It consumes the actual
 * authenticated Request; no scheduled token, callback bag or V28 grant is used. */
export function createLocalPackageRequestExecution(options: {
  opening: LocalVolumeProfileOpening; request: Request; actor: string;
  admission: ReviewedInstallationAdmission; authentication: object;
}) {
  const pathname = new URL(options.request.url).pathname;
  if (!PACKAGE_HTTP_ROUTES.some(route => route.method === options.request.method
    && new RegExp(`^/api${route.path.replace(/:[A-Za-z]+/g, "[^/]+")}$`).test(pathname)))
    throw new HTTPException(403, { message: "Original Package Request ingress is required." });
  const auth = localAuthenticationIdentityAuthority(options.authentication);
  auth.currentSessionPredicate(options.request, options.actor);
  return createOwnedLocalUploadExecution(options, undefined, true);
}
/** Original source/provider/settlement lifetime with a consumed genuine V28
 * Package-purpose receipt. V26/default constructors remain separate. */
export function createLocalPackageRequestExecutionV28Candidate(options: {
  opening: LocalVolumeProfileOpeningV28Candidate; request: Request; actor: string;
  admission: ReviewedInstallationAdmission; authentication: object; permission: LocalPackagePermissionV28Candidate;
}) {
  if (Object.keys(options).sort().join(",") !== "actor,admission,authentication,opening,permission,request")
    throw new Error("Local V28 Package execution configuration is unavailable");
  const permission = consumeLocalPackageExecutionPermissionV28Candidate(options.permission,options.opening,options.request,options.actor);
  return createOwnedLocalUploadExecution({opening:options.opening,request:options.request,actor:options.actor,
    admission:options.admission,authentication:options.authentication},permission,true);
}
export function assertLocalPackageRequestExecutionOwner(execution: LocalUploadExecution,
  opening: LocalVolumeProfileOpening, request: Request, actor: string): void {
  const issued = executions.get(execution);
  if (!issued?.packageRequest) throw new Error("Original Package Request execution is unavailable");
  assertLocalUploadExecutionRequestOwner(execution, opening, request, actor);
}
export function createLocalUploadExecutionV28Candidate(options: {
  opening: LocalVolumeProfileOpeningV28Candidate; request: Request; actor: string;
  admission: ReviewedInstallationAdmission; authentication: object; permission: LocalCommentPermissionV28Candidate;
}) {
  if (Object.keys(options).sort().join(",") !== "actor,admission,authentication,opening,permission,request")
    throw new Error("Local V28 upload configuration is unavailable");
  const permission = consumeLocalCommentExecutionPermissionV28Candidate(options.permission, options.opening, options.request, options.actor);
  return createOwnedLocalUploadExecution({ opening: options.opening, request: options.request, actor: options.actor,
    admission: options.admission, authentication: options.authentication }, permission);
}
/** Same mature physical/source owner; this additional constructor consumes
 * only the actual import-purpose receipt, never a Comment/V26 token. */
export function createLocalFabubloxUploadExecutionV28Candidate(options: {
  opening: LocalVolumeProfileOpeningV28Candidate; request: Request; actor: string;
  admission: ReviewedInstallationAdmission; authentication: object; permission: LocalFabubloxPermissionV28Candidate;
}) {
  if (Object.keys(options).sort().join(",") !== "actor,admission,authentication,opening,permission,request")
    throw new Error("Local V28 import execution configuration is unavailable");
  const permission = consumeLocalFabubloxExecutionPermissionV28Candidate(options.permission, options.opening, options.request, options.actor);
  return createOwnedLocalUploadExecution({ opening: options.opening, request: options.request, actor: options.actor,
    admission: options.admission, authentication: options.authentication }, permission);
}
function createOwnedLocalUploadExecution(options: {
  opening: LocalVolumeProfileOpening; request: Request; actor: string;
  admission: ReviewedInstallationAdmission; authentication: object;
}, permission?: ReturnType<typeof ownedLocalCommentPermissionV28Candidate> | ReturnType<typeof ownedLocalFabubloxPermissionV28Candidate> | ReturnType<typeof ownedLocalPackagePermissionV28Candidate>, packageRequest = false) {
  const keys = Object.keys(options).sort();
  if (keys.join(",") !== "actor,admission,authentication,opening,request")
    throw new Error("Local upload configuration is unavailable");
  const { opening, request, actor, admission, authentication } = options;
  const packagePermission = permission && "kind" in permission && permission.kind === "package" ? permission : undefined;
  if (!(request instanceof Request) || request.bodyUsed)
    throw new HTTPException(403, { message: "Request admission is required." });
  const owner = ownedLocalVolumeProfileContext(opening);
  owner.assertCurrent();
  // Private factory registrations reject copied/fake method bags and an actual
  // authentication service belonging to another installed connection. Session
  // lifetime comes only from this genuine identity owner's immutable policy.
  const auth = localAuthenticationIdentityAuthority(authentication);
  const identityOwner = permission
    ? ownedLocalVolumeIdentityV28Candidate(opening, authentication, admission)
    : captureInstalledIdentityExecutionOwner(auth.identity, owner.database, owner.nativeDatabase, admission);
  const capturedPolicy = identityOwner.policy, installation = identityOwner.installation;
  const idleLifetimeMs = capturedPolicy.idleLifetimeMs;
  const session = Object.freeze({ tokenHash: auth.captureSessionDigest(request), actor });
  function assertAuthenticationOwner(): void {
    // A consumed V28 permission owns the concrete opening-bound issuer: its
    // synchronous current check covers this same privately issued opening
    // identity and physical lifetime. Generic/V26 keeps its original guards.
    if (permission) permission.assertCurrent();
    else { owner.assertCurrent(); identityOwner.assertCurrent(); }
    if (packageRequest) auth.currentSessionPredicate(request, actor);
    if (localAuthenticationIdentityAuthority(authentication) !== auth
      || auth.captureSessionDigest(request) !== session.tokenHash)
      throw new HTTPException(403, { message: "Request admission is required." });
  }
  const sentinel = owner.nativeDatabase.prepare("SELECT bootstrap_principal_id,initialized_at FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'").get();
  if (typeof sentinel?.bootstrap_principal_id !== "string" || typeof sentinel.initialized_at !== "number"
    || !Number.isSafeInteger(sentinel.initialized_at)) throw new Error("Local identity installation is unavailable");
  const bootstrapPrincipalId = sentinel.bootstrap_principal_id, initializedAt = sentinel.initialized_at;
  const active = owner.nativeDatabase.prepare(`SELECT g.incarnation FROM file_authority_control a JOIN file_authority_runtime_guard g
    ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active'`).get();
  if (typeof active?.incarnation !== "string" || !active.incarnation) throw new HTTPException(503, { message: "File execution is paused on this installation." });
  const incarnation = active.incarnation;
  let used = false;
  let resolveSettled!: () => void, rejectSettled!: (error: unknown) => void;
  const settled = new Promise<void>((resolve, reject) => { resolveSettled = resolve; rejectSettled = reject; });
  settled.then(() => undefined, () => undefined);

  function admitted(lease?: DurableLease, boundary: "preflight" | "business" | "final" = "business",
    selectedFile?: Readonly<{ fileId: string; purpose: FilePurpose }>) {
    assertAuthenticationOwner();
    // These exact session/installation predicates are the qualified native
    // Request admission predicates. No administrator or profile label is used
    // as ordinary upload permission, and no second cookie parser is introduced.
    const authentication = owner.database.prepare(LOCAL_REQUEST_SESSION_SQL)
      .bind(session.tokenHash, session.actor, idleLifetimeMs);
    const currentInstallation = owner.database.prepare(`SELECT 1 AS admitted WHERE
      EXISTS(SELECT 1 FROM node_installation WHERE singleton=1 AND installation_id=? AND catalog_id=?
        AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)
      AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'
        AND bootstrap_principal_id=? AND initialized_at=?)`)
      .bind(installation.installationId, installation.catalogId, installation.checkpointId, installation.schemaSha256,
        installation.createdAt, bootstrapPrincipalId, initializedAt);
    const file = owner.database.prepare(`SELECT 1 AS admitted FROM file_authority_control a JOIN file_authority_runtime_guard g
      ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active' AND g.incarnation=?`)
      .bind(incarnation);
    const maintenance = lease ? owner.database.prepare(`SELECT 1 AS admitted FROM system_recovery_maintenance m
      JOIN system_recovery_write_leases l ON l.id=? AND l.generation=? AND l.owner=? AND l.kind='http'
        AND l.released_at IS NULL WHERE m.singleton=1 AND ((m.state='open' AND m.generation=l.generation)
        OR(m.state='draining' AND m.generation=l.generation+1))`)
      .bind(lease.id, lease.generation, actor) : owner.database.prepare(`SELECT 1 AS admitted FROM system_recovery_maintenance
        WHERE singleton=1 AND state='open'`);
    // Expiry remains diagnostic, just as in the mature source-write lease.
    // Draining allows only this exact previously acquired unreleased owner.
    return createSqliteBatchAdmission(owner.database, [
      ...(packagePermission ? [] : [{ statement: authentication, rejection: new HTTPException(401, { message: "Authentication is required." }) }]),
      { statement: currentInstallation, rejection: new HTTPException(503, { message: "Installation write admission is unavailable." }) },
      { statement: file, rejection: new HTTPException(503, { message: "File execution is paused on this installation." }) },
      { statement: maintenance, rejection: new HTTPException(503, { message: "Source mutations are paused for system recovery." }) },
      ...(permission ? boundary === "preflight" ? permission.preflight()
        : boundary === "final" ? permission.final() : permission.business(selectedFile) : []),
    ]);
  }

  return Object.freeze({
    // The host owns this exact execution settlement independently of a
    // Response promise or listener close. Disposal does not pretend to cancel
    // a running original; its one original provider drain must actually finish.
    settled,
    dispose(): Promise<void> {
      if (!used) { used = true; resolveSettled(); }
      return settled;
    },
    async run<T>(work: (execution: LocalUploadExecution) => Promise<T>): Promise<T> {
      if (used) throw new Error("The original local upload execution was already consumed");
      used = true;
      const original = owner.writerLease.withWriter(async () => {
        const id = crypto.randomUUID(), now = new Date(), expires = new Date(now.getTime() + 300_000).toISOString();
        const pending = new Set<Promise<unknown>>(), profiles = new Set<ProfileOwner>();
        const reads = new Set<OwnedPublishedFileRead>();
        const cleanupFailures: unknown[] = [];
        let lease: DurableLease | undefined, originalRelease: Promise<unknown> | undefined, disposal: Promise<void> | undefined;
        let closing = false;
        const physical = { assertHeld() { owner.assertCurrent(); } };
        const executionLifetime = { assertHeld() {
          assertAuthenticationOwner();
          if (closing) throw new Error("The original local upload execution has closed");
        } };
        const cleanupDatabase = asFileAuthoritySqlDatabase(owner.database, physical);
        function track<TValue>(original: Promise<TValue>): Promise<TValue> {
          pending.add(original);
          original.then(() => pending.delete(original), error => {
            pending.delete(original);
            if (error instanceof StorageProfileCleanupError) cleanupFailures.push(error);
          });
          return original;
        }
        /** Private V28 delivery owner: only this consumed original Request
         * permission issues these checks. The original V26 read is unchanged.
         * Every awaited original read is fenced again before releasing bytes;
         * a physical profile pin alone never proves current Group permission. */
        async function currentCommentRead(read: OwnedPublishedFileRead,
          selectedFile: Readonly<{ fileId: string | null; purpose: FilePurpose }>): Promise<OwnedPublishedFileRead> {
          if (read.result.outcome !== "available") return read;
          const selected = selectedFile.fileId === null ? undefined
            : Object.freeze({ fileId: selectedFile.fileId, purpose: selectedFile.purpose });
          // The original read is registered before getReader. Once its actual
          // reader returns, transfer ownership to this retained cached wrapper
          // before constructing the outward stream or awaiting any operation.
          const reader = read.result.body.getReader();
          const originalCancel = reader.cancel.bind(reader), originalReleaseLock = reader.releaseLock.bind(reader);
          const originalDispose = read.dispose.bind(read);
          const originalReaderClosed = reader.closed, originalReadSettled = read.settled;
          let originalReaderEnded = false, originalReaderFailed = false, originalReaderError: unknown;
          // Observe the exact native reader promise; this is not a bodyUsed or
          // locked heuristic. A terminal errored reader needs no second cancel.
          originalReaderClosed.then(() => { originalReaderEnded = true; }, error => {
            originalReaderEnded = true; originalReaderFailed = true; originalReaderError = error;
          });
          const originalReads = new Set<ReturnType<typeof reader.read>>();
          const originalChecks = new Set<ReturnType<typeof runSqliteAdmittedBatch>>();
          let ended = false, completion: Promise<void> | undefined;
          let controller: ReadableStreamDefaultController<Uint8Array> | undefined, outwardTerminal = false;
          function errorOutput(error: unknown): void {
            if (!outwardTerminal && controller) { outwardTerminal = true; controller.error(error); }
          }
          function closeOutput(): void {
            if (!outwardTerminal && controller) { outwardTerminal = true; controller.close(); }
          }
          let resolveSettled!: () => void, rejectSettled!: (error: unknown) => void;
          const settled = new Promise<void>((resolve, reject) => { resolveSettled = resolve; rejectSettled = reject; });
          settled.then(() => undefined, () => undefined);
          let result = read.result;
          const held: OwnedPublishedFileRead = Object.freeze({ get result() { return result; }, settled,
            dispose: () => finish(true), ...(read.createHash ? { createHash: read.createHash } : {}) });
          reads.add(held); reads.delete(read);
          function checkDelivery() {
            executionLifetime.assertHeld();
            const original = runSqliteAdmittedBatch(owner.database, [], admitted(lease, "business", selected));
            originalChecks.add(original);
            original.then(() => originalChecks.delete(original), () => originalChecks.delete(original));
            return original;
          }
          function finish(cancel: boolean, reason?: unknown): Promise<void> {
            if (completion) return completion;
            ended = true;
            let resolve!: () => void, reject!: (error: unknown) => void;
            // Cache before invoking cancellation, including synchronous throw
            // or callback reentry. A failed first ACK is never retried.
            completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
            completion.then(resolveSettled, rejectSettled);
            let cancellation: Promise<void> | undefined;
            if (cancel && !originalReaderEnded) {
              try { cancellation = originalCancel(reason); }
              catch (error) { cancellation = Promise.reject(error); }
              cancellation.then(() => undefined, () => undefined);
            }
            (async () => {
              const failures: unknown[] = [];
              if (cancellation) { try { await cancellation; } catch (error) { failures.push(error); } }
              await Promise.allSettled([...originalReads, ...originalChecks]);
              try { originalReleaseLock(); } catch (error) { failures.push(error); }
              // Uncertain child cancellation/reader release forbids provider,
              // location-hold and source-lease release by this parent.
              if (failures.length) throw new StorageProfileCleanupError(reason,
                failures.length === 1 ? failures[0] : new AggregateError(failures, "Original Comment delivery cleanup is incomplete"), {
                  owner: Object.freeze({ opening, request, actor, read, reader, originalReaderClosed, originalReadSettled,
                    originalReads, originalChecks, cancellation, held }),
                  dispose: () => finish(true),
                });
              try { await originalDispose(); }
              catch (error) {
                throw new StorageProfileCleanupError(reason, error, {
                  owner: Object.freeze({ opening, request, actor, read, reader, originalReaderClosed, originalReadSettled,
                    originalReads, originalChecks, held }),
                  dispose: () => finish(true),
                });
              }
              // EOF/error is delivered only after the original first provider
              // and location-hold ACK, including external parent disposal.
              if (originalReaderFailed) errorOutput(originalReaderError); else closeOutput();
            })().then(resolve, error => { errorOutput(error); reject(error); });
            return completion;
          }
          // The original deadline operates even while the outward body remains
          // unread. Join its exact stream-terminal and cleanup outcomes, without
          // a replacement timer or another cancellation/close attempt.
          const originalTerminal = Promise.allSettled([originalReaderClosed, originalReadSettled]);
          originalTerminal.then(() => {
            if (!completion) finish(false, originalReaderFailed ? originalReaderError : undefined)
              .then(() => undefined, () => undefined);
          });
          try {
            const body = new ReadableStream<Uint8Array>({
              start(output) { controller = output; },
              async pull(_output) {
                if (ended) return;
                try {
                  await checkDelivery();
                  if (ended) return;
                  const original = reader.read(); originalReads.add(original);
                  original.then(() => originalReads.delete(original), () => originalReads.delete(original));
                  const next = await original;
                  if (ended) return;
                  // This is a real fresh same-native BEGIN check of the source
                  // lease, session/member, every target and typed File tuple.
                  // No bytes, including the first chunk, bypass this boundary.
                  await checkDelivery();
                  if (ended) return;
                  if (next.done) await finish(false);
                  else controller!.enqueue(next.value);
                } catch (error) {
                  errorOutput(error);
                  await finish(true, error);
                }
              },
              cancel(reason) { outwardTerminal = true; return finish(true, reason); },
            }, { highWaterMark: 0 });
            result = { ...read.result, body };
          } catch (error) {
            await finish(true, error); throw error;
          }
          return held;
        }
        function release() {
          if (originalRelease) return originalRelease;
          if (!lease) return Promise.resolve();
          // The exact mature release SQL is allowed after session revocation:
          // it only settles this in-process owner's durable existing lease.
          try { originalRelease = cleanupDatabase.primary().prepare("UPDATE system_recovery_write_leases SET released_at=? WHERE id=? AND generation=? AND released_at IS NULL")
            .bind(new Date().toISOString(), lease.id, lease.generation).run(); }
          catch (error) { originalRelease = Promise.reject(error); }
          originalRelease.then(() => undefined, () => undefined); return originalRelease;
        }
        function dispose(validationCause?: unknown): Promise<void> {
          if (disposal) return disposal;
          closing = true;
          disposal = (async () => {
            // Capture all original opening promises before provider disposal.
            // Actual provider ownership drains original read/PUT/cancel work.
            await Promise.allSettled([...pending]);
            // Every delivered accepted read must settle/cancel its original
            // stream and release its own hold before provider/source closure.
            const readCloses = await Promise.allSettled([...reads].map(read => read.dispose()));
            for (const close of readCloses) if (close.status === "rejected") cleanupFailures.push(close.reason);
            const closes = await Promise.allSettled([...profiles].map(profile => profile.dispose()));
            for (const close of closes) if (close.status === "rejected") cleanupFailures.push(close.reason);
            try { owner.database.primary(); } catch (error) { cleanupFailures.push(error); }
            if (!cleanupFailures.length) {
              try { await release(); } catch (error) { cleanupFailures.push(error); }
            }
            if (cleanupFailures.length) throw new StorageProfileCleanupError(validationCause,
              new AggregateError(cleanupFailures, "Local upload ownership cleanup is incomplete"), {
                owner: Object.freeze({ opening, actor, id, lease, profiles, reads, pending, originalRelease }), dispose,
              });
          })();
          disposal.then(() => undefined, () => undefined); return disposal;
        }
        const acquireDatabase = asAdmittedFileAuthoritySqlDatabase(owner.database, admitted(undefined, "preflight"), physical);
        let result: T, cause: unknown, failed = false;
        try {
          const row = await acquireDatabase.prepare(`INSERT INTO system_recovery_write_leases(id,owner,kind,generation,created_at,expires_at)
    SELECT ?,?,?,generation,?,? FROM system_recovery_maintenance WHERE singleton=1 AND state='open' RETURNING id,generation`)
            .bind(id, actor, "http", now.toISOString(), expires).first();
          if (!row || row.id !== id) throw new HTTPException(503, { message: "Source mutations are paused for system recovery." });
          lease = Object.freeze({ id, generation: configurationSqlInteger(row.generation, "localUpload.sourceLeaseGeneration") });
          const continuing = admitted(lease, permission ? "preflight" : "business");
          const historyDatabase = asAdmittedFileAuthoritySqlDatabase(owner.database, continuing, executionLifetime);
          const execution: LocalUploadExecution = Object.freeze({ actor, incarnation,
            database(authorities: readonly LocalVolumeProfileAuthority[]) {
              executionLifetime.assertHeld();
              return createAdmittedLocalVolumeFileAuthorityDatabase(opening, authorities, permission ? admitted(lease) : continuing, executionLifetime);
            },
            historyDatabase() {
              if (permission) return asAdmittedFileAuthoritySqlDatabase(owner.database, admitted(lease, "final"), executionLifetime);
              historyDatabase.primary(); return historyDatabase;
            },
            ...(packageRequest ? {
              packageDatabase(authorities: readonly LocalVolumeProfileAuthority[] = []) {
                return asAdmittedJobSqlDatabase(owner.database, () => {
                  executionLifetime.assertHeld();
                  const selected = [...new Set(authorities)];
                  if (selected.length > 4) throw new Error("Package Request profile check budget exceeded");
                  const profileChecks = selected.map(authority => ({
                    statement: prepareLocalVolumeProfileSqliteFence(authority, owner.database),
                    rejection: new HTTPException(503, { message: "Selected package volume is unavailable." }),
                  }));
                  const requestAdmission = admitted(lease);
                  return profileChecks.length ? joinSqliteBatchAdmissions(owner.database, [requestAdmission,
                    createSqliteBatchAdmission(owner.database, profileChecks)]) : requestAdmission;
                }, executionLifetime);
              },
              packageSettlementDatabase() {
                const retained = { assertHeld() {
                  owner.assertCurrent();
                  if (closing || !lease) throw new Error("Original Package Request lifetime is unavailable");
                } };
                return asAdmittedJobSqlDatabase(owner.database, () => {
                  retained.assertHeld();
                  return createSqliteBatchAdmission(owner.database, [{
                    statement: owner.database.prepare(`SELECT 1 AS admitted FROM node_installation n
                      JOIN system_recovery_write_leases l ON l.id=? AND l.generation=? AND l.owner=?
                        AND l.kind='http' AND l.released_at IS NULL
                      WHERE n.singleton=1 AND n.installation_id=? AND n.schema_sha256=?`)
                      .bind(lease!.id, lease!.generation, actor, installation.installationId, installation.schemaSha256),
                    rejection: new Error("Original Package settlement owner is unavailable"),
                  }]);
                }, retained);
              },
              async assertPackageRequestCurrent() { await runSqliteAdmittedBatch(owner.database, [], admitted(lease)); },
              packageActorAllowed() {
                try {
                  executionLifetime.assertHeld();
                  if (packagePermission) return packagePermission.authorized();
                  const row = owner.nativeDatabase.prepare(LOCAL_REQUEST_SESSION_SQL)
                    .get(session.tokenHash, actor, idleLifetimeMs);
                  return row?.admitted === 1;
                } catch { return false; }
              },
            } : {}),
            ...(permission && !packagePermission ? "kind" in permission && permission.kind === "fabublox" ? {
              readFabubloxImportPayload: () => permission.preparePayload(execution),
              async assertFabubloxRequestCurrent() { await runSqliteAdmittedBatch(owner.database, [], admitted(lease, "final")); },
              fabubloxAcceptanceDatabase(authorities: readonly LocalVolumeProfileAuthority[]) {
                executionLifetime.assertHeld();
                return createAdmittedLocalVolumeFileAuthorityDatabase(opening, authorities, admitted(lease, "final"), executionLifetime);
              },
            } : {
              readCommentAcceptanceBody: "boundedBody" in permission ? permission.boundedBody.bind(permission) : undefined,
              async assertCommentRequestCurrent() { await runSqliteAdmittedBatch(owner.database, [], admitted(lease, "final")); },
            } : {}),
            openRead(input: Readonly<{ fileId: string | null; purpose: FilePurpose }>) {
              executionLifetime.assertHeld();
              const captured = Object.freeze({ ...input });
              const original = (async () => {
                const selectedRead = permission ? asAdmittedFileAuthoritySqlDatabase(owner.database,
                  admitted(lease, "business", captured.fileId === null ? undefined : { fileId: captured.fileId, purpose: captured.purpose }), executionLifetime) : historyDatabase;
                const read = await readPublishedFileOwned({ database: selectedRead, openProfile: execution.openProfile,
                  // Only this trusted core receives the newly allocated hold
                  // ID. No raw cleanup database/callback escapes the execution.
                  // Principal revocation may deny new work, never original
                  // physical-owner settlement of its already-acquired hold.
                  releaseHold(holdId, releasedAt) {
                    return cleanupDatabase.primary().prepare("UPDATE file_location_holds SET released_at=? WHERE id=? AND released_at IS NULL")
                      .bind(releasedAt, holdId).run();
                  },
                }, captured);
                reads.add(read);
                // Only the private V28 permission adds delivery checks. Default
                // V26 returns the identical original read and disposer.
                return permission || packageRequest ? currentCommentRead(read, captured) : read;
              })();
              return track(original);
            },
            openProfile(frozen: Parameters<AuthorityProfileOpener>[0], access: Parameters<AuthorityProfileOpener>[1],
              lifecycle: Parameters<AuthorityProfileOpener>[2]) {
              executionLifetime.assertHeld();
              if (permission && "access" in permission && permission.access === "read" && access !== "read")
                throw new HTTPException(403, { message: "The original Comment request selects read access only." });
              // Capture the issued physical/source tuple before the first open
              // await; returned label/JSON cannot substitute its ownership.
              const authority = captureLocalVolumeProfileAuthority(opening, frozen, access);
              const selected = createAdmittedLocalVolumeFileAuthorityDatabase(opening, [authority], permission ? admitted(lease) : continuing, executionLifetime);
              const original = (async () => {
                const profile = await openStorageProfile(opening.capabilities, frozen, access, {
                  ...lifecycle, async beforeRequest(operation) {
                    if (lifecycle.beforeRequest && await lifecycle.beforeRequest(operation) !== true) return false;
                    try {
                      const live = await selected.primary().prepare(`SELECT 1 AS live FROM system_recovery_write_leases l JOIN system_recovery_maintenance m ON m.singleton=1
                        WHERE l.id=? AND l.generation=? AND l.owner=? AND l.kind='http' AND l.released_at IS NULL
                          AND ((m.state='open' AND m.generation=l.generation)
                            OR(m.state='draining' AND m.generation=l.generation+1))`)
                        .bind(lease!.id, lease!.generation, actor).first();
                      return live?.live === 1 || live?.live === 1n;
                    } catch { return false; }
                  },
                });
                const originalDispose = profile.dispose?.bind(profile);
                let closed: Promise<void> | undefined;
                const profileOwner = Object.freeze({ profile, dispose() {
                  if (!closed) {
                    try { closed = originalDispose ? originalDispose() : Promise.resolve(); }
                    catch (error) { closed = Promise.reject(error); }
                    closed.then(() => undefined, () => undefined);
                  }
                  return closed;
                } });
                profiles.add(profileOwner);
                return { ...profile, dispose: profileOwner.dispose };
              })();
              return track(original);
            },
          });
          executions.set(execution, Object.freeze({ opening, request, actor, packageRequest, assertHeld: executionLifetime.assertHeld,
            assertPhysicalHeld() {
              owner.assertCurrent();
              if (closing || !lease) throw new Error("The original local upload source lifetime has closed");
              const held = owner.nativeDatabase.prepare(`SELECT 1 held FROM system_recovery_write_leases
                WHERE id=? AND generation=? AND owner=? AND kind='http' AND released_at IS NULL`)
                .get(lease.id, lease.generation, actor);
              if (held?.held !== 1) throw new Error("The original local upload source lease is unavailable");
            } }));
          result = await work(execution);
        } catch (error) {
          failed = true; cause = error;
          if (error instanceof StorageProfileCleanupError) cleanupFailures.push(error);
          // A committed acquisition may lose its ACK. Reconcile only the exact
          // UUID/owner/type/times from this original attempt to retain cleanup;
          // never start byte work or dispatch another acquisition after error.
          if (!lease) {
            try {
              const row = await cleanupDatabase.primary().prepare(`SELECT id,generation FROM system_recovery_write_leases
                WHERE id=? AND owner=? AND kind='http' AND created_at=? AND expires_at=? AND released_at IS NULL`)
                .bind(id, actor, now.toISOString(), expires).first();
              if (row) lease = Object.freeze({ id, generation: configurationSqlInteger(row.generation, "localUpload.sourceLeaseGeneration") });
            } catch (cleanupCause) { cleanupFailures.push(cleanupCause); }
          }
        }
        await dispose(cause);
        if (failed) throw cause;
        return result!;
      });
      original.then(resolveSettled, rejectSettled);
      return original;
    },
  });
}

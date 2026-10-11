import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { captureInstalledIdentityExecutionOwner } from "../auth/installed-identity-execution-owner";
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
  ownedLocalVolumeProfileContext, type LocalVolumeProfileAuthority, type LocalVolumeProfileOpening } from "../storage/local-volume-profile-opening";

/** Internal ordinary system-scope upload execution only. This is not a public
 * route, a resource-link grant, a Job/Comment/import executor, or permission to
 * activate File/volumes. The trusted composer supplies the exact authenticated
 * original Request before body work. The actual current V26 opening is required. */
export interface LocalUploadExecution {
  readonly actor: string;
  readonly incarnation: string;
  readonly openProfile: AuthorityProfileOpener;
  database(authorities: readonly LocalVolumeProfileAuthority[]): NativeFileAuthoritySqlDatabase;
  historyDatabase(): NativeFileAuthoritySqlDatabase;
  /** Caller first authorizes the exact accepted/business File. The returned
   * read scope owns its original body/disposer and independent hold release. */
  openRead(input: Readonly<{ fileId: string | null; purpose: FilePurpose }>): Promise<OwnedPublishedFileRead>;
}
const executions = new WeakMap<LocalUploadExecution, Readonly<{ opening: LocalVolumeProfileOpening; assertHeld(): void }>>();
/** Additional internal composer check: a copied callback bag cannot stand in
 * for an original currently held authenticated execution. No new grant issues. */
export function assertLocalUploadExecutionOwner(execution: LocalUploadExecution, opening: LocalVolumeProfileOpening): void {
  const issued = executions.get(execution);
  if (!issued || issued.opening !== opening) throw new Error("Original local upload execution is unavailable");
  issued.assertHeld();
}
interface DurableLease { readonly id: string; readonly generation: number }
interface ProfileOwner { readonly profile: OpenedStorageProfile<"local">; dispose(): Promise<void> }

/** One trusted request lifetime. Every original profile opening is retained,
 * every returned disposer is memoized before callers receive it, and lease
 * release follows the original openings and provider disposal. A timer or a
 * raced business Promise is never evidence that the original transport stopped. */
export function createLocalUploadExecution(options: {
  opening: LocalVolumeProfileOpening;
  request: Request;
  actor: string;
  admission: ReviewedInstallationAdmission;
  authentication: object;
}) {
  const keys = Object.keys(options).sort();
  if (keys.join(",") !== "actor,admission,authentication,opening,request")
    throw new Error("Local upload configuration is unavailable");
  const { opening, request, actor, admission, authentication } = options;
  if (!(request instanceof Request) || request.bodyUsed)
    throw new HTTPException(403, { message: "Request admission is required." });
  const owner = ownedLocalVolumeProfileContext(opening);
  owner.assertCurrent();
  // Private factory registrations reject copied/fake method bags and an actual
  // authentication service belonging to another installed connection. Session
  // lifetime comes only from this genuine identity owner's immutable policy.
  const auth = localAuthenticationIdentityAuthority(authentication);
  const identityOwner = captureInstalledIdentityExecutionOwner(auth.identity, owner.database, owner.nativeDatabase, admission);
  const capturedPolicy = identityOwner.policy, installation = identityOwner.installation;
  const idleLifetimeMs = capturedPolicy.idleLifetimeMs;
  const session = Object.freeze({ tokenHash: auth.captureSessionDigest(request), actor });
  function assertAuthenticationOwner(): void {
    owner.assertCurrent();
    identityOwner.assertCurrent();
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

  function admitted(lease?: DurableLease) {
    assertAuthenticationOwner();
    // These exact session/installation predicates are the qualified native
    // Request admission predicates. No administrator or profile label is used
    // as ordinary upload permission, and no second cookie parser is introduced.
    const authentication = owner.database.prepare(`SELECT 1 AS admitted FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id
      CROSS JOIN (WITH observed AS MATERIALIZED (SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now)
        SELECT now FROM observed) clock
      WHERE s.token_hash=? AND ('local-account:' || a.principal_id)=? AND a.enabled=1
        AND a.credential_revision=s.credential_revision AND s.revoked_at IS NULL
        AND typeof(clock.now)='integer' AND clock.now BETWEEN 0 AND 9007199254740991
        AND clock.now >= s.last_seen_at AND clock.now < s.absolute_expires_at AND clock.now < s.last_seen_at + ?
        AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1') LIMIT 1`)
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
      { statement: authentication, rejection: new HTTPException(401, { message: "Authentication is required." }) },
      { statement: currentInstallation, rejection: new HTTPException(503, { message: "Installation write admission is unavailable." }) },
      { statement: file, rejection: new HTTPException(503, { message: "File execution is paused on this installation." }) },
      { statement: maintenance, rejection: new HTTPException(503, { message: "Source mutations are paused for system recovery." }) },
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
        const acquireDatabase = asAdmittedFileAuthoritySqlDatabase(owner.database, admitted(), physical);
        let result: T, cause: unknown, failed = false;
        try {
          const row = await acquireDatabase.prepare(`INSERT INTO system_recovery_write_leases(id,owner,kind,generation,created_at,expires_at)
    SELECT ?,?,?,generation,?,? FROM system_recovery_maintenance WHERE singleton=1 AND state='open' RETURNING id,generation`)
            .bind(id, actor, "http", now.toISOString(), expires).first();
          if (!row || row.id !== id) throw new HTTPException(503, { message: "Source mutations are paused for system recovery." });
          lease = Object.freeze({ id, generation: configurationSqlInteger(row.generation, "localUpload.sourceLeaseGeneration") });
          const continuing = admitted(lease);
          const historyDatabase = asAdmittedFileAuthoritySqlDatabase(owner.database, continuing, executionLifetime);
          const execution: LocalUploadExecution = Object.freeze({ actor, incarnation,
            database(authorities: readonly LocalVolumeProfileAuthority[]) {
              executionLifetime.assertHeld();
              return createAdmittedLocalVolumeFileAuthorityDatabase(opening, authorities, continuing, executionLifetime);
            },
            historyDatabase() { historyDatabase.primary(); return historyDatabase; },
            openRead(input: Readonly<{ fileId: string | null; purpose: FilePurpose }>) {
              executionLifetime.assertHeld();
              const captured = Object.freeze({ ...input });
              const original = (async () => {
                const read = await readPublishedFileOwned({ database: historyDatabase, openProfile: execution.openProfile,
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
                return read;
              })();
              return track(original);
            },
            openProfile(frozen: Parameters<AuthorityProfileOpener>[0], access: Parameters<AuthorityProfileOpener>[1],
              lifecycle: Parameters<AuthorityProfileOpener>[2]) {
              executionLifetime.assertHeld();
              // Capture the issued physical/source tuple before the first open
              // await; returned label/JSON cannot substitute its ownership.
              const authority = captureLocalVolumeProfileAuthority(opening, frozen, access);
              const selected = createAdmittedLocalVolumeFileAuthorityDatabase(opening, [authority], continuing, executionLifetime);
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
          executions.set(execution, Object.freeze({ opening, assertHeld: executionLifetime.assertHeld }));
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

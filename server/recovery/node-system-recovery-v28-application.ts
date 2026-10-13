import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createInstalledLocalIdentity, type IdentityPolicy } from "../auth/identity.ts";
import { captureInstalledIdentityExecutionOwnerV28Candidate } from "../auth/installed-identity-execution-owner-v28-candidate.ts";
import { createLocalAuthentication, localAuthenticationIdentityAuthority, type LocalAuthEnvironment } from "../auth/local-auth-http.ts";
import { createLoopbackLocalAuthTransport } from "../auth/local-auth-transport.ts";
import type { PasswordHasher } from "../auth/passwords.ts";
import { createGroupV28RequestBodyCustody, readGroupV28Json, registerGroupV28BodyReader, readGroupV28OriginalBody,
  cancelGroupV28OriginalBody, releaseGroupV28OriginalBody } from "../collaboration/group-v28-request-body-custody.ts";
import { createNodeHttpServer, stopNodeHttpServerAndDrain } from "../http.ts";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations.ts";
import { assertNodeRuntimeConfigurationForProfile, type LoadedNodeRuntimeConfiguration } from "../node-runtime-config.ts";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease.ts";
import { asAdmittedJobSqlDatabase, createSqliteBatchAdmission, type SqliteCapability } from "../sqlite.ts";
import { createLocalVolumeProfileOpeningV28, type LocalVolumeProfileOpening } from "../storage/local-volume-profile-opening.ts";
import { nodeSha256 } from "../storage/node-sha256.ts";
import type { JobSqlDatabase, JobSqlStatement } from "../../worker/files/jobs/sql-repository.ts";
import { runSystemRecoveryJobStep, writeSystemRecoveryUpload, type SystemRecoveryCapabilitiesAdapter } from "../../worker/recovery/kernel.ts";
import { SqlSystemRecoveryRepository, type RecoveryAttempt, type RecoveryClaim, type RecoveryJob } from "../../worker/recovery/sql-repository.ts";
import { checkedSystemRecoveryBackupInput, checkedSystemRecoveryUploadInput, checkedSystemRecoveryJobControl,
  checkedSystemRecoveryCapabilities, checkedSystemRecoveryJobStatus, checkedSystemRecoveryPreview, checkedSystemRecoveryMaintenanceInput,
  type SystemRecoveryCapabilities, type SystemRecoveryJobStatus } from "../../shared/contracts/system-recovery.ts";
import { openNodePrivateRecoveryArtifacts, type NodePrivateRecoveryArtifacts } from "./node-private-artifacts.ts";
import { createNodeV28ArchiveStages } from "./node-v28-archive-stages.ts";
import { createNodeRecoverySourceMaintenance } from "./node-source-maintenance.ts";

export const NODE_V28_RECOVERY_SURFACE = Object.freeze({ kind: "node-v28-recovery-only/1" as const,
  backup: "fenced-quiesced-v5" as const, upload: "strict-v5" as const, maintenance: "explicit-source-control" as const,
  sourceBusinessWriters: false as const, targetRecovery: false as const });
export interface NodeSystemRecoveryV28Application {
  readonly server: Server;
  readonly surfaceCapabilities: typeof NODE_V28_RECOVERY_SURFACE;
  dispatchRecoveryJobsOnce(): Promise<{ jobId: string | null; outcome: string }>;
  close(): Promise<void>;
}
type ApiEnvironment = LocalAuthEnvironment;
type ArtifactScope = { readonly actor: string; readonly request?: Request; readonly claim?: RecoveryClaim; readonly cleanup?: string };
type BodyOwner = { close(reason?: unknown): Promise<void> };
const claimed = new WeakSet<LinuxWriterLease>(), retained = new Set<object>();
const routes = Object.freeze([
  ["POST", "/api/auth/login"], ["GET", "/api/auth/session"], ["POST", "/api/auth/logout"], ["POST", "/api/auth/rotate"],
  ["GET", "/api/health"], ["GET", "/api/ready"],
  ["GET", "/api/system-recovery/capabilities"], ["POST", "/api/system-recovery/executor"],
  ["GET", "/api/system-recovery/maintenance"], ["POST", "/api/system-recovery/maintenance"],
  ["GET", "/api/system-recovery/maintenance/requests/:requestId"],
  ["GET", "/api/system-recovery/backup-preview"], ["GET", "/api/system-recovery/jobs"], ["POST", "/api/system-recovery/jobs"],
  ["POST", "/api/system-recovery/uploads"], ["GET", "/api/system-recovery/requests/:requestId"],
  ["GET", "/api/system-recovery/jobs/:jobId"], ["GET", "/api/system-recovery/jobs/:jobId/upload-intent"],
  ["PUT", "/api/system-recovery/jobs/:jobId/upload"], ["GET", "/api/system-recovery/jobs/:jobId/preview"],
  ["POST", "/api/system-recovery/jobs/:jobId/control"], ["GET", "/api/system-recovery/jobs/:jobId/download"],
].map(([method, path]) => Object.freeze({ method: method!, path: path!,
  pattern: new RegExp(`^${path!.replace(/:[A-Za-z]+/g, "[^/]+")}$`) })));
const unavailable = () => Response.json({ error: "This operation is unavailable in the Node V28 Recovery-only runtime." },
  { status: 503, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
const fail = (message: string, status: 400 | 403 | 404 | 409 | 413 | 503 = 409) => new HTTPException(status, { message });

/** This concrete Node binding preserves the shared SQL/kernel. Only an issued
 * LOCAL PUT's ambiguous rejection is narrowed to unknown, never failed. The
 * shared positive exact-key/full-byte reconciliation remains the only recovery.
 * Native grant checks extend the original claim guard inside its own BEGIN. */
class NodeRecoveryRepository extends SqlSystemRecoveryRepository<JobSqlStatement, JobSqlDatabase> {
  private claimObserver?: (claim: RecoveryClaim | null) => void;
  constructor(database: JobSqlDatabase, private readonly issued: Set<string>, private readonly namespace: () => string) {
    super(database, current => current.primary());
  }
  observeClaims(observer: (claim: RecoveryClaim | null) => void): void { this.claimObserver = observer; }
  override async claim(id: string, actor: string, incarnation: string, token: string, upload = false): Promise<RecoveryClaim | null> {
    const claim = await super.claim(id, actor, incarnation, token, upload); this.claimObserver?.(claim); return claim;
  }
  override guard(claim: RecoveryClaim, db = this.db()): JobSqlStatement {
    return db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_jobs j JOIN system_recovery_runtime r ON r.singleton=1 AND r.enabled=1
      AND r.incarnation=j.runtime_incarnation WHERE j.id=? AND j.actor=? AND j.state='running' AND j.generation=? AND j.owner_token=?
      AND j.runtime_incarnation=? AND julianday(j.lease_expires_at)>julianday(?))
      AND EXISTS(SELECT 1 FROM local_accounts a JOIN local_admin_grants g ON g.principal_id=a.principal_id
        WHERE ('local-account:'||a.principal_id)=? AND a.enabled=1)
      THEN 1 ELSE json('System recovery lease or administrator lost') END`)
      .bind(claim.id, claim.actor, claim.generation, claim.owner_token, claim.runtime_incarnation, this.now().toISOString(), claim.actor);
  }
  override async next(): Promise<RecoveryJob | null> {
    return this.db().prepare(`SELECT * FROM system_recovery_jobs WHERE state='queued' AND kind IN('backup','upload')
      AND CASE WHEN json_valid(checkpoint_json) THEN json_extract(checkpoint_json,'$.artifactNamespace.sha256') END=?
      ORDER BY updated_at,id LIMIT 1`).bind(this.namespace()).first<RecoveryJob>();
  }
  override settleAttempt(attempt: RecoveryAttempt, state: "settled" | "failed" | "unknown"): Promise<void> {
    return super.settleAttempt(attempt, state === "failed" && this.issued.has(attempt.object_key) ? "unknown" : state);
  }
}

/** Explicit Recovery-only HTTP owner, not a business application's online
 * maintenance/restore owner. ALL source business/File/GC writers are absent.
 * Its one physical installation lease lasts through every V5 payload pass.
 * Backup additionally requires an explicitly requested, persisted drained fence.
 * Authenticated maintenance enter stops source executor advertisements and jobs;
 * startup never seeds a fence, execution flag, account/grant/profile or role.
 * No admitted recovery target is provisioned by this capture-only owner.
 * The default and existing V28 profiles never call this factory. */
export function createNodeSystemRecoveryV28Application(options: {
  configuration: LoadedNodeRuntimeConfiguration; database: SqliteCapability; nativeDatabase: DatabaseSync;
  writerLease: LinuxWriterLease; admission: ReviewedInstallationAdmission; hasher: PasswordHasher;
  identityPolicy: IdentityPolicy; publicOrigin: string;
}): Promise<NodeSystemRecoveryV28Application> {
  const captured = Object.freeze({ ...options, identityPolicy: Object.freeze({ ...options.identityPolicy }) });
  const { database, nativeDatabase: native, writerLease: lease, admission, configuration } = captured;
  const config = assertNodeRuntimeConfigurationForProfile(configuration, "v28-recovery");
  assertLinuxWriterLeaseBinding(lease, database, native);
  const installation = assertInstallationAdmission(native, admission);
  const main = native.prepare("PRAGMA database_list").all().filter(row => row.name === "main");
  if (installation.checkpointId !== "portable-runtime/v28" || installation.installationId !== config.expectedInstallationId
    || main.length !== 1 || main[0]?.file !== config.databasePath || captured.publicOrigin !== config.publicOrigin || claimed.has(lease))
    throw new Error("Original Node Recovery installation is unavailable");
  claimed.add(lease);
  const owner = { database, native, lease, configuration, pending: new Set<Promise<unknown>>(), bodies: new Set<BodyOwner>(),
    ingressBodies: new Set<ReturnType<typeof createGroupV28RequestBodyCustody>>(),
    artifactScopes: new Map<string, ArtifactScope>(), issued: new Set<string>(), active: true,
    openingAttempted: false, artifactsAttempted: false, serverAttempted: false, failed: false, failure: undefined as unknown,
    opening: undefined as LocalVolumeProfileOpening | undefined, artifacts: undefined as NodePrivateRecoveryArtifacts | undefined,
    server: undefined as Server | undefined, construction: undefined as Promise<void> | undefined,
    closing: undefined as Promise<void> | undefined, dispatch: undefined as Promise<{ jobId: string | null; outcome: string }> | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined };
  retained.add(owner);
  let stages: ReturnType<typeof createNodeV28ArchiveStages> | undefined;
  let application: Hono<ApiEnvironment> | undefined;
  let identity: ReturnType<typeof captureInstalledIdentityExecutionOwnerV28Candidate> | undefined;
  let auth: ReturnType<typeof createLocalAuthentication> | undefined;
  let authentication: ReturnType<typeof localAuthenticationIdentityAuthority> | undefined;
  const quarantine = (error: unknown): void => { if (!owner.failed) { owner.failed = true; owner.failure = error; } owner.active = false;
    if (owner.timer !== undefined) { clearTimeout(owner.timer); owner.timer = undefined; } };
  function physical(): void {
    if (!owner.active || owner.failed || assertNodeRuntimeConfigurationForProfile(configuration, "v28-recovery") !== config) throw fail("Recovery admission is unavailable", 503);
    identity?.assertCurrent(); assertLinuxWriterLeaseBinding(lease, database, native);
    if (authentication && localAuthenticationIdentityAuthority(auth!) !== authentication) throw fail("Recovery authentication is unavailable", 503);
  }
  function administrator(actor: string): boolean {
    try { physical(); return Boolean(native.prepare(`SELECT 1 FROM local_accounts a JOIN local_admin_grants g ON g.principal_id=a.principal_id
      WHERE ('local-account:'||a.principal_id)=? AND a.enabled=1`).get(actor)); } catch { return false; }
  }
  function sessionCurrent(request: Request, actor: string): void {
    physical(); const session = authentication!.currentSessionPredicate(request, actor);
    const row = native.prepare(`SELECT 1 FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id
      JOIN local_admin_grants g ON g.principal_id=a.principal_id WHERE s.token_hash=? AND ('local-account:'||a.principal_id)=?
        AND a.enabled=1 AND a.credential_revision=s.credential_revision AND s.revoked_at IS NULL
        AND ?>=s.last_seen_at AND ?<s.absolute_expires_at AND ?<s.last_seen_at+?`)
      .get(session.tokenHash, actor, Date.now(), Date.now(), Date.now(), captured.identityPolicy.idleLifetimeMs);
    if (!row) throw fail("System administrator access is required.", 403);
  }
  function maintenance() {
    physical(); const row = native.prepare(`SELECT state,generation,token,checkpoint_sha256,backup_job_id,
      (SELECT count(*) FROM system_recovery_write_leases WHERE released_at IS NULL) writers
      FROM system_recovery_maintenance WHERE singleton=1`).get();
    if (!row || !["open", "draining", "fenced"].includes(String(row.state)) || typeof row.generation !== "number" || !Number.isSafeInteger(row.generation)
      || row.generation < 0 || typeof row.writers !== "number" || !Number.isSafeInteger(row.writers) || row.writers < 0)
      throw fail("Source maintenance is unavailable", 503);
    return { state: row.state as "open" | "draining" | "fenced", generation: row.generation, token: row.token,
      checkpoint: row.checkpoint_sha256 as string | null, backupJobId: row.backup_job_id, writers: row.writers };
  }
  function assertQuiesced(): void {
    const state = maintenance();
    const row = native.prepare(`SELECT 1 WHERE
      (SELECT enabled FROM file_authority_runtime_guard WHERE singleton=1)=0
      AND (SELECT enabled FROM file_shadow_runtime_guard WHERE singleton=1)=0
      AND (SELECT enabled FROM file_job_runtime_guard WHERE singleton=1)=0
      AND NOT EXISTS(SELECT 1 FROM file_shadow_attempts WHERE state IN('write_started','unknown'))
      AND NOT EXISTS(SELECT 1 FROM file_migration_attempts WHERE state IN('write_started','unknown'))
      AND NOT EXISTS(SELECT 1 FROM research_package_attempts WHERE state IN('write_started','unknown'))
      AND NOT EXISTS(SELECT 1 FROM r2_upload_requests WHERE status='pending')
      AND NOT EXISTS(SELECT 1 FROM metrology_reference_upload_requests WHERE status='pending')
      AND NOT EXISTS(SELECT 1 FROM comment_submission_acceptances WHERE status='pending')
      AND NOT EXISTS(SELECT 1 FROM import_file_acceptances WHERE status='pending')
      AND NOT EXISTS(SELECT 1 FROM system_storage_candidate_checks WHERE status='running' OR cleanup_outcome='running' OR write_outcome='unknown')`).get();
    if (state.state !== "fenced" || state.writers !== 0 || !row) throw fail("A backup requires a drained fenced source with all source executors stopped", 409);
  }
  function assertBackupWindow(job: RecoveryJob): void {
    if (job.kind !== "backup") return;
    assertQuiesced(); const state = maintenance();
    const checkpoint = JSON.parse(job.checkpoint_json ?? "null") as { sourceWindow?: { generation?: unknown; token?: unknown } } | null;
    if (!checkpoint?.sourceWindow || checkpoint.sourceWindow.generation !== state.generation || checkpoint.sourceWindow.token !== state.token)
      throw new Error("source_checkpoint_changed");
  }
  const installationAdmission = (request?: Request, actor?: string) => {
    physical();
    const checks = [{ statement: database.prepare(`SELECT 1 admitted WHERE EXISTS(SELECT 1 FROM node_installation WHERE singleton=1 AND installation_id=?
      AND catalog_id=? AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)`)
      .bind(installation.installationId, installation.catalogId, installation.checkpointId, installation.schemaSha256, installation.createdAt),
      rejection: fail("Recovery installation changed", 503) }];
    if (request !== undefined && actor !== undefined) {
      const session = authentication!.currentSessionPredicate(request, actor);
      checks.push({ statement: database.prepare(`SELECT 1 admitted FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id
        JOIN local_admin_grants g ON g.principal_id=a.principal_id
        CROSS JOIN (WITH observed AS MATERIALIZED (SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) now) SELECT now FROM observed) clock
        WHERE s.token_hash=? AND ('local-account:'||a.principal_id)=? AND a.enabled=1 AND s.revoked_at IS NULL
          AND a.credential_revision=s.credential_revision AND typeof(clock.now)='integer'
          AND clock.now BETWEEN s.last_seen_at AND 9007199254740991
          AND clock.now<s.absolute_expires_at AND clock.now<s.last_seen_at+?`)
        .bind(session.tokenHash, actor, captured.identityPolicy.idleLifetimeMs), rejection: fail("System administrator access is required.", 403) });
    }
    return createSqliteBatchAdmission(database, checks);
  };
  const repository = (request?: Request, actor?: string) => new NodeRecoveryRepository(
    asAdmittedJobSqlDatabase(database, () => installationAdmission(request, actor), { assertHeld: physical }), owner.issued,
    () => owner.artifacts!.identity.sha256);
  let base: NodeRecoveryRepository;
  async function checkedInput<T>(request: Request, check: (value: unknown) => T, maxBytes = 65536): Promise<T> {
    const value = await readGroupV28Json(request, maxBytes);
    try { return check(value); } catch { throw fail("Invalid recovery input", 400); }
  }
  function ingressUploadBody(request: Request): ReadableStream<Uint8Array> {
    const reader = request.body?.getReader(); if (!reader) throw fail("Recovery upload body is required", 400);
    registerGroupV28BodyReader(request, reader);
    let ended = false, closing: Promise<void> | undefined;
    const closeReader = (): Promise<void> => closing ??= (async () => {
      ended = true; await cancelGroupV28OriginalBody(request, reader); releaseGroupV28OriginalBody(request, reader);
    })();
    return new ReadableStream<Uint8Array>({ async pull(controller) {
      try { const next = await readGroupV28OriginalBody(request, reader); if (ended) return;
        if (next.done) { await closeReader(); controller.close(); } else controller.enqueue(next.value);
      } catch (error) { try { await closeReader(); } catch (cleanup) { controller.error(new AggregateError([error, cleanup])); return; } controller.error(error); }
    }, cancel() { return closeReader(); } }, { highWaterMark: 0 });
  }
  function ownBody(body: ReadableStream<Uint8Array>, current: () => Promise<boolean>, finish: () => void): ReadableStream<Uint8Array> {
    const reader = body.getReader(); let ended = false, closing: Promise<void> | undefined;
    const retainedBody: BodyOwner = { close(reason) { return closing ??= (async () => {
      try { if (!ended) { ended = true; await reader.cancel(reason); } reader.releaseLock(); finish(); owner.bodies.delete(retainedBody); }
      catch (error) { quarantine(error); throw error; }
    })(); } };
    owner.bodies.add(retainedBody);
    return new ReadableStream<Uint8Array>({ async pull(controller) {
      try { if (!await current()) throw new Error("administrator_revoked"); const next = await reader.read();
        if (!await current()) throw new Error("administrator_revoked");
        if (next.done) { ended = true; await retainedBody.close(); controller.close(); } else controller.enqueue(next.value);
      } catch (error) { try { await retainedBody.close(error); } catch (cleanup) { controller.error(new AggregateError([error, cleanup])); return; } controller.error(error); }
    }, cancel(reason) { return retainedBody.close(reason); } }, { highWaterMark: 0 });
  }
  async function artifactRead(key: string, scope: ArtifactScope, current: () => Promise<boolean>): Promise<ReadableStream<Uint8Array> | null> {
    if (owner.artifactScopes.has(key)) throw new Error("Recovery artifact is already in use");
    owner.artifactScopes.set(key, scope);
    try { const body = await owner.artifacts!.read(key); if (!body) { owner.artifactScopes.delete(key); return null; }
      return ownBody(body, current, () => owner.artifactScopes.delete(key));
    } catch (error) { owner.artifactScopes.delete(key); throw error; }
  }
  function cleanupGuard(jobId: string, repo: NodeRecoveryRepository) {
    return repo.db().prepare(`SELECT CASE WHEN
      NOT EXISTS(SELECT 1 FROM system_recovery_jobs WHERE id=? AND state IN('queued','running','awaiting_upload'))
      AND NOT EXISTS(SELECT 1 FROM system_recovery_jobs WHERE source_upload_job_id=? AND state IN('queued','running','paused'))
      AND NOT EXISTS(SELECT 1 FROM system_recovery_attempts WHERE job_id=? AND state IN('started','unknown','settled'))
      AND NOT EXISTS(SELECT 1 FROM system_recovery_maintenance WHERE singleton=1 AND state='fenced' AND checkpoint_sha256 IS NOT NULL AND backup_job_id IS NOT ?)
      THEN 1 ELSE json('Recovery cleanup still holds unresolved writes or final checkpoint') END`).bind(jobId, jobId, jobId, jobId);
  }
  function capabilities(repo: NodeRecoveryRepository, actor: string, request?: Request): Promise<SystemRecoveryCapabilitiesAdapter<JobSqlStatement> | null> {
    return (async () => {
      physical(); const runtime = await repo.runtime(); if (!runtime || runtime.enabled !== 1) return null;
      const allowed = (selected: string) => selected === actor && administrator(selected)
        && (request === undefined || (() => { try { sessionCurrent(request, selected); return true; } catch { return false; } })());
      let activeClaim: RecoveryClaim | undefined;
      // Reconciliation may read an existing attempt without issuing a new PUT.
      // Capture the ORIGINAL claimed owner tuple for those read-only resumes.
      repo.observeClaims(claim => { activeClaim = claim ?? undefined; });
      const currentClaim = async (): Promise<boolean> => {
        if (!activeClaim || !allowed(activeClaim.actor)) return false;
        try { owner.artifacts!.assertJob(activeClaim); assertBackupWindow(activeClaim); return await repo.current(activeClaim); } catch { return false; }
      };
      return { repository: repo, incarnation: runtime.incarnation, authorizeActor: allowed, now: () => new Date(), randomId: randomUUID, hash: nodeSha256,
        async step(claim, current, signal) { activeClaim = claim; owner.artifacts!.assertJob(claim); assertBackupWindow(claim);
          return stages!.step(claim, async () => await current() && await currentClaim(), signal); },
        async exportBody(claim, current, signal) { activeClaim = claim; owner.artifacts!.assertJob(claim); assertBackupWindow(claim);
          return stages!.exportBody(claim, async () => await current() && await currentClaim(), signal); },
        async put(key, body, byteSize) {
          // Upload write precedes step/export; capture its exact live claim from the ledger.
          const match = /^fp5-system\/([^/]+)\/[^/]+$/.exec(key), live = match ? await repo.job(match[1]!) : null;
          if (!live || live.state !== "running" || live.actor !== actor || !live.owner_token || !live.runtime_incarnation || !live.lease_expires_at) throw new Error("archive_invalid");
          activeClaim = live as RecoveryClaim; const scope: ArtifactScope = { actor, request, claim: activeClaim };
          if (owner.artifactScopes.has(key)) throw new Error("Recovery artifact is already in use");
          owner.artifactScopes.set(key, scope);
          try { await owner.artifacts!.put(key, body, byteSize); } finally { owner.artifactScopes.delete(key); }
        },
        read(key) { return artifactRead(key, { actor, request, claim: activeClaim }, currentClaim); },
      };
    })();
  }
  async function status(repo: NodeRecoveryRepository, job: RecoveryJob): Promise<SystemRecoveryJobStatus> {
    let namespace = false; try { owner.artifacts!.assertJob(job); namespace = true; } catch { /* Historical binding stays unavailable. */ }
    const verified = (await repo.attempts(job.id)).some(attempt => attempt.state === "verified" && attempt.object_key === job.artifact_key);
    return checkedSystemRecoveryJobStatus({ id: job.id, requestId: job.request_id, kind: job.kind, state: job.state, phase: job.phase,
      acceptedAt: job.accepted_at, updatedAt: job.updated_at, reason: job.reason,
      progress: { completedFiles: job.completed_files, totalFiles: job.total_files, bytesDone: job.bytes_done, bytesTotal: job.bytes_total },
      output: job.archive_byte_size && job.archive_sha256 && job.expires_at ? { available: namespace && verified && job.state === "completed"
        && Date.parse(job.expires_at) > Date.now(), byteSize: job.archive_byte_size, sha256: job.archive_sha256, expiresAt: job.expires_at } : null,
      result: job.result_json ? JSON.parse(job.result_json) : null });
  }
  async function publicCapabilities(repo: NodeRecoveryRepository, actor: string): Promise<SystemRecoveryCapabilities> {
    const canManage = administrator(actor);
    if (!canManage) return checkedSystemRecoveryCapabilities({ supported: false, canManage: false, enabled: false, stale: true,
      lastHeartbeatAt: null, cadenceSeconds: 120, maxStepMs: 60000, reason: "administrator_required",
      target: { configured: false, id: null, mode: "fresh" }, maintenance: { state: "open", checkpoint: null } });
    const source = maintenance();
    const runtime = canManage ? await repo.runtime() : null;
    return checkedSystemRecoveryCapabilities({ supported: canManage, canManage, enabled: canManage && runtime?.enabled === 1,
      stale: !runtime?.last_heartbeat_at || Date.now() - Date.parse(runtime.last_heartbeat_at) > 300_000,
      lastHeartbeatAt: runtime?.last_heartbeat_at ?? null, cadenceSeconds: 120, maxStepMs: 60000,
      reason: !canManage ? "administrator_required" : runtime?.enabled === 1 ? null : "executor_disabled",
      target: { configured: false, id: null, mode: "fresh" }, maintenance: { state: source.state, checkpoint: source.checkpoint } });
  }
  async function owned(repo: NodeRecoveryRepository, id: string, actor: string): Promise<RecoveryJob> {
    const job = await repo.job(id); if (!job || job.actor !== actor) throw fail("Recovery job does not exist", 404); return job;
  }
  async function receipt(repo: NodeRecoveryRepository, requestId: string, accepted: { job: RecoveryJob; reused: boolean }) {
    return { requestId, job: await status(repo, accepted.job), reused: accepted.reused };
  }
  async function dispatchRecoveryJobsOnce(): Promise<{ jobId: string | null; outcome: string }> {
    physical(); if (owner.dispatch) throw new Error("Recovery dispatcher is busy");
    const original = lease.withWriter(async () => {
      const next = await base.next(), runtime = await base.runtime();
      if (!runtime || runtime.enabled !== 1) return { jobId: null, outcome: "disabled" };
      await base.db().prepare("UPDATE system_recovery_runtime SET last_heartbeat_at=? WHERE singleton=1 AND enabled=1 AND incarnation=?")
        .bind(new Date().toISOString(), runtime.incarnation).run();
      if (!next) return { jobId: null, outcome: "idle" };
      const port = await capabilities(base, next.actor); if (!port) return { jobId: null, outcome: "disabled" };
      return runSystemRecoveryJobStep(port);
    });
    owner.dispatch = original; owner.pending.add(original);
    try { return await original; } finally { owner.pending.delete(original); owner.dispatch = undefined; }
  }
  function schedule(): void {
    if (!owner.active || owner.timer !== undefined) return;
    owner.timer = setTimeout(() => { owner.timer = undefined;
      const work = dispatchRecoveryJobsOnce(); void work.catch(quarantine).finally(() => schedule());
    }, 120_000);
  }
  function close(): Promise<void> {
    if (owner.closing) return owner.closing;
    owner.active = false; if (owner.timer !== undefined) { clearTimeout(owner.timer); owner.timer = undefined; }
    owner.closing = (async () => {
      await owner.construction?.catch(() => undefined);
      if (owner.serverAttempted && !owner.server || owner.openingAttempted && !owner.opening || owner.artifactsAttempted && !owner.artifacts)
        throw new Error("Original Recovery constructor ownership is unavailable");
      const transport = owner.server ? stopNodeHttpServerAndDrain(owner.server) : Promise.resolve();
      const physicalDrain = lease.stopAdmissionAndDrain();
      void transport.catch(() => undefined); void physicalDrain.catch(() => undefined);
      const bodyDrains = await Promise.allSettled([...owner.bodies].map(body => body.close(new Error("Recovery admission closed"))));
      const childDrains = await Promise.allSettled([owner.artifacts?.close(), stages?.close()]);
      await Promise.allSettled([...owner.pending]);
      const transportDrain = await Promise.allSettled([transport, physicalDrain,
        ...[...owner.ingressBodies].map(body => body.close())]);
      const failures = [...bodyDrains, ...childDrains, ...transportDrain].flatMap(value => value.status === "rejected" ? [value.reason as unknown] : []);
      if (failures.length || owner.failed) throw new AggregateError([...failures, ...(owner.failed ? [owner.failure] : [])], "Original Recovery ownership did not drain");
      await owner.opening?.close(); database.close(); if (native.isOpen) throw new Error("Original Recovery native close is unavailable");
      await lease.release(); application = undefined; retained.delete(owner);
    })().catch(error => { quarantine(error); throw error; });
    void owner.closing.catch(() => undefined); return owner.closing;
  }
  const construction = lease.withWriter(async () => {
    const transport = createLoopbackLocalAuthTransport({ publicOrigin: captured.publicOrigin });
    const installedIdentity = await createInstalledLocalIdentity({ database, nativeDatabase: native, admission,
      hasher: captured.hasher, policy: captured.identityPolicy });
    identity = captureInstalledIdentityExecutionOwnerV28Candidate(installedIdentity, database, native, admission);
    auth = createLocalAuthentication({ identity: installedIdentity, transport, now: Date.now });
    authentication = localAuthenticationIdentityAuthority(auth); physical();
    base = repository();
    owner.openingAttempted = true;
    owner.opening = createLocalVolumeProfileOpeningV28({ database, nativeDatabase: native, admission, authentication: auth, writerLease: lease,
      filesystemRootOwnerUid: config.filesystemRootOwnerUid, descriptors: config.localVolumes, authorizeAdministrator: () => false });
    owner.artifactsAttempted = true;
    owner.artifacts = await openNodePrivateRecoveryArtifacts({ binding: { root: config.recoveryArtifacts!.root,
      namespace: { volumeId: installation.installationId, rootId: config.recoveryArtifacts!.rootBindingId, profileId: "system-recovery-private", namespaceRevision: 1 } },
      assertCurrent: physical, quarantine,
      markIssued(key, method) { if (method === "PUT") owner.issued.add(key); },
      async beforeMutation(operation) { const scope = owner.artifactScopes.get(operation.key); if (!scope) return false;
        if (scope.request) sessionCurrent(scope.request, scope.actor); if (!administrator(scope.actor)) return false;
        if (scope.claim) { assertBackupWindow(scope.claim); return base.current(scope.claim); }
        return operation.method === "DELETE" && scope.cleanup !== undefined; },
      async expectation(key, access) {
        const scope = owner.artifactScopes.get(key); if (!scope || !administrator(scope.actor)) throw new Error("administrator_revoked");
        if (scope.request) sessionCurrent(scope.request, scope.actor);
        const match = /^fp5-system\/([^/]+)\/([^/]+)$/.exec(key); if (!match) throw new Error("artifact_namespace_changed");
        const repo = scope.request ? repository(scope.request, scope.actor) : base;
        const job = await owned(repo, match[1]!, scope.actor); owner.artifacts!.assertJob(job);
        const attempt = (await repo.attempts(job.id)).find(row => row.id === match[2] && row.object_key === key);
        if (!attempt) throw new Error("archive_invalid");
        if (access === "put" && (!scope.claim || attempt.owner_token !== scope.claim.owner_token || attempt.generation !== scope.claim.generation
          || attempt.runtime_incarnation !== scope.claim.runtime_incarnation || attempt.state !== "started" || !await repo.current(scope.claim))) throw new Error("administrator_revoked");
        if (scope.claim) { assertBackupWindow(scope.claim); if (!await repo.current(scope.claim)) throw new Error("administrator_revoked"); }
        if (access === "delete") { if (scope.cleanup !== job.id || !["verified", "failed"].includes(attempt.state)) throw new Error("archive_invalid");
          await cleanupGuard(job.id, repo).first(); }
        return { byteSize: attempt.expected_byte_size, sha256: attempt.expected_sha256 };
      } });
    stages = createNodeV28ArchiveStages({ database, nativeDatabase: native, admission, opening: owner.opening, repository: base,
      assertQuiesced, quarantine,
      async artifactRead(key) {
        const match = /^fp5-system\/([^/]+)\/[^/]+$/.exec(key), job = match ? await base.job(match[1]!) : null;
        if (!job || job.kind !== "upload" || !administrator(job.actor)) throw new Error("archive_invalid");
        return artifactRead(key, { actor: job.actor }, async () => administrator(job.actor));
      } });
    const app = new Hono<ApiEnvironment>();
    app.onError((error, c) => error instanceof HTTPException ? c.json({ error: error.message }, error.status)
      : c.json({ error: "System recovery conflicts with its accepted state or an unavailable capability. Refresh its receipt." }, 409));
    app.use("*", async (c, next) => { c.header("Cache-Control", "private, no-store"); c.header("X-Content-Type-Options", "nosniff"); await next(); });
    app.route("/api/auth", auth.routes);
    app.get("/api/health", c => c.json({ ok: true, capabilities: NODE_V28_RECOVERY_SURFACE }));
    app.get("/api/ready", auth.middleware, c => { physical(); return c.json({ ok: true, fullReady: false, capabilities: NODE_V28_RECOVERY_SURFACE }); });
    app.use("/api/system-recovery/*", auth.middleware);
    const requestOwner = (request: Request, actor: string) => { sessionCurrent(request, actor); return repository(request, actor); };
    app.get("/api/system-recovery/capabilities", async c => c.json(await publicCapabilities(administrator(c.get("userEmail"))
      ? requestOwner(c.req.raw, c.get("userEmail")) : base, c.get("userEmail"))));
    app.get("/api/system-recovery/maintenance", async c => {
      const actor = c.get("userEmail"), repo = requestOwner(c.req.raw, actor);
      const result = await createNodeRecoverySourceMaintenance(repo.db()).read();
      sessionCurrent(c.req.raw, actor); return c.json(result); });
    app.get("/api/system-recovery/maintenance/requests/:requestId", async c => {
      const actor = c.get("userEmail"), repo = requestOwner(c.req.raw, actor), id = c.req.param("requestId");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw fail("Invalid maintenance request ID", 400);
      const result = await createNodeRecoverySourceMaintenance(repo.db()).receipt(actor, id);
      if (!result) throw fail("Maintenance request has not been accepted", 404);
      sessionCurrent(c.req.raw, actor); return c.json(result); });
    app.post("/api/system-recovery/maintenance", async c => {
      const actor = c.get("userEmail"), repo = requestOwner(c.req.raw, actor);
      const input = await checkedInput(c.req.raw, checkedSystemRecoveryMaintenanceInput, 4096);
      const result = await createNodeRecoverySourceMaintenance(repo.db()).control(actor, input);
      sessionCurrent(c.req.raw, actor); return c.json(result); });
    app.post("/api/system-recovery/executor", async c => { const actor = c.get("userEmail"), repo = requestOwner(c.req.raw, actor);
      const input = await checkedInput(c.req.raw, value => {
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join() !== "enabled"
          || typeof (value as { enabled?: unknown }).enabled !== "boolean") throw new Error(); return value as { enabled: boolean }; });
      await repo.configure(input.enabled); sessionCurrent(c.req.raw, actor); return c.json(await publicCapabilities(repo, actor)); });
    app.get("/api/system-recovery/backup-preview", async c => { const repo = requestOwner(c.req.raw, c.get("userEmail"));
      const capability = await publicCapabilities(repo, c.get("userEmail")); let quiesced = true; try { assertQuiesced(); } catch { quiesced = false; }
      return c.json({ schema: "system-backup-preview/1", available: capability.enabled && quiesced,
        reasons: [capability.reason, quiesced ? null : "source_maintenance_required"].filter(Boolean),
        bounds: { archiveBytes: 104857600, payloadBytes: 100663296, metadataBytes: 4194304, files: 100, maxStepMs: 60000 },
        includesProtectedSettings: true, credentialsRequireKeyring: true, maintenance: capability.maintenance }); });
    app.get("/api/system-recovery/jobs", async c => { const repo = requestOwner(c.req.raw, c.get("userEmail"));
      return c.json({ jobs: await Promise.all((await repo.list(c.get("userEmail"))).map(job => status(repo, job))) }); });
    app.post("/api/system-recovery/jobs", async c => { const actor = c.get("userEmail"), repo = requestOwner(c.req.raw, actor);
      const input = await checkedInput(c.req.raw, checkedSystemRecoveryBackupInput), prior = await repo.request(input.requestId, actor, input);
      if (prior) return c.json(await receipt(repo, input.requestId, { job: prior, reused: true }), 202);
      assertQuiesced(); const source = maintenance();
      const accepted = await repo.accept({ id: randomUUID(), requestId: input.requestId, actor, kind: "backup", input,
        checkpoint: { ...owner.artifacts!.checkpoint(), sourceWindow: { generation: source.generation, token: source.token } } }, () => {
          try { sessionCurrent(c.req.raw, actor); assertQuiesced(); return true; } catch { return false; } });
      return c.json(await receipt(repo, input.requestId, accepted), 202); });
    app.post("/api/system-recovery/uploads", async c => { const actor = c.get("userEmail"), repo = requestOwner(c.req.raw, actor);
      const input = await checkedInput(c.req.raw, checkedSystemRecoveryUploadInput);
      const accepted = await repo.accept({ id: randomUUID(), requestId: input.requestId, actor, kind: "upload", input,
        checkpoint: owner.artifacts!.checkpoint() }, () => { try { sessionCurrent(c.req.raw, actor); return true; } catch { return false; } });
      return c.json(await receipt(repo, input.requestId, accepted), 202); });
    app.get("/api/system-recovery/requests/:requestId", async c => { const actor = c.get("userEmail"), repo = requestOwner(c.req.raw, actor);
      const job = await repo.request(c.req.param("requestId"), actor); if (!job) throw fail("Recovery request is not accepted", 404);
      return c.json(await receipt(repo, c.req.param("requestId"), { job, reused: true })); });
    app.get("/api/system-recovery/jobs/:jobId", async c => { const actor = c.get("userEmail"), repo = requestOwner(c.req.raw, actor);
      return c.json(await status(repo, await owned(repo, c.req.param("jobId"), actor))); });
    app.get("/api/system-recovery/jobs/:jobId/upload-intent", async c => { const actor = c.get("userEmail"), repo = requestOwner(c.req.raw, actor);
      const job = await owned(repo, c.req.param("jobId"), actor); if (job.kind !== "upload") throw fail("Recovery job has no upload intent", 404);
      return c.json(checkedSystemRecoveryUploadInput(JSON.parse(job.input_json))); });
    app.put("/api/system-recovery/jobs/:jobId/upload", async c => { const actor = c.get("userEmail"), repo = requestOwner(c.req.raw, actor);
      const job = await owned(repo, c.req.param("jobId"), actor); if (job.kind !== "upload") throw fail("This is not a recovery upload", 400);
      if (job.phase !== "write") return c.json(await status(repo, job)); owner.artifacts!.assertJob(job);
      const input = checkedSystemRecoveryUploadInput(JSON.parse(job.input_json)), length = c.req.header("content-length");
      if (length !== undefined && (!/^[1-9][0-9]*$/.test(length) || Number(length) !== input.byteSize)) throw fail("Upload size differs from accepted identity", 400);
      if (!c.req.raw.body) throw fail("Recovery upload body is required", 400);
      const port = await capabilities(repo, actor, c.req.raw); if (!port) throw fail("Recovery executor is disabled", 503);
      const claim = await repo.claim(job.id, actor, port.incarnation, randomUUID(), true); if (!claim) throw fail("Another attempt owns this upload", 409);
      await writeSystemRecoveryUpload(port, claim, ingressUploadBody(c.req.raw)); sessionCurrent(c.req.raw, actor);
      return c.json(await status(repo, (await repo.job(job.id))!)); });
    app.get("/api/system-recovery/jobs/:jobId/preview", async c => { const actor = c.get("userEmail"), repo = requestOwner(c.req.raw, actor);
      const job = await owned(repo, c.req.param("jobId"), actor); owner.artifacts!.assertJob(job);
      if (!(job.kind === "upload" && job.state === "preview" || job.kind === "backup" && job.state === "completed")) throw fail("Recovery archive validation has not completed", 409);
      const preview = checkedSystemRecoveryPreview(await stages!.preview(job)); sessionCurrent(c.req.raw, actor); return c.json(preview); });
    app.post("/api/system-recovery/jobs/:jobId/control", async c => { const actor = c.get("userEmail"), repo = requestOwner(c.req.raw, actor);
      const action = await checkedInput(c.req.raw, checkedSystemRecoveryJobControl), job = await owned(repo, c.req.param("jobId"), actor);
      owner.artifacts!.assertJob(job);
      if (job.kind === "recovery") throw fail("This runtime has no admitted recovery target", 503);
      if (action === "cleanup") {
        await cleanupGuard(job.id, repo).first();
        await repo.db().batch([cleanupGuard(job.id, repo),
          repo.db().prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM system_recovery_jobs WHERE id=? AND actor=? AND generation=?) THEN 1 ELSE json('Recovery cleanup revision changed') END")
            .bind(job.id, actor, job.generation), repo.db().prepare(`UPDATE system_recovery_jobs SET
          state=CASE WHEN state='completed' THEN 'completed' ELSE 'cancelled' END,generation=generation+1,expires_at=?,updated_at=? WHERE id=? AND actor=? AND generation=?`)
          .bind(new Date().toISOString(), new Date().toISOString(), job.id, actor, job.generation)]);
        for (const attempt of (await repo.attempts(job.id)).filter(row => ["verified", "failed"].includes(row.state))) {
          if (owner.artifactScopes.has(attempt.object_key)) throw fail("Recovery artifact is still in use", 409);
          owner.artifactScopes.set(attempt.object_key, { actor, request: c.req.raw, cleanup: job.id });
          try { await owner.artifacts!.delete(attempt.object_key); } finally { owner.artifactScopes.delete(attempt.object_key); }
          await repo.db().batch([cleanupGuard(job.id, repo), repo.db().prepare("UPDATE system_recovery_attempts SET state='cleaned',cleaned_at=? WHERE id=? AND state IN('verified','failed')")
            .bind(new Date().toISOString(), attempt.id)]);
        }
        await repo.db().batch([cleanupGuard(job.id, repo),
          repo.db().prepare("UPDATE system_recovery_legacy_holds SET released_at=? WHERE job_id=? AND released_at IS NULL").bind(new Date().toISOString(), job.id),
          repo.db().prepare("UPDATE file_location_holds SET released_at=? WHERE operation_id=? AND released_at IS NULL").bind(new Date().toISOString(), `fp5-backup:${job.id}`)]);
      } else await repo.control(job, action);
      sessionCurrent(c.req.raw, actor); return c.json(await status(repo, (await repo.job(job.id))!)); });
    app.get("/api/system-recovery/jobs/:jobId/download", async c => { const actor = c.get("userEmail"), repo = requestOwner(c.req.raw, actor);
      const job = await owned(repo, c.req.param("jobId"), actor), state = await status(repo, job);
      if (!state.output?.available || !job.artifact_key) throw fail("Recovery archive output is expired or unavailable", 404);
      const body = await artifactRead(job.artifact_key, { actor, request: c.req.raw }, async () => { try { sessionCurrent(c.req.raw, actor); return true; } catch { return false; } });
      if (!body) throw fail("Recovery archive output is unavailable", 404);
      return new Response(body, { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="system-backup-${job.id}.zip"`,
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } }); });
    app.all("*", () => unavailable()); application = app;
    owner.serverAttempted = true;
    owner.server = createNodeHttpServer(async request => {
      if (!owner.active || !routes.some(route => route.method === request.method && route.pattern.test(new URL(request.url).pathname))) return unavailable();
      const original = lease.withWriter(async () => {
        if (!application || !owner.active) return unavailable();
        const body = createGroupV28RequestBodyCustody(request); owner.ingressBodies.add(body);
        try { return await application.fetch(request, {}); }
        finally { try { await body.close(); owner.ingressBodies.delete(body); } catch (error) { quarantine(error); throw error; } }
      });
      owner.pending.add(original); try { return await original; } finally { owner.pending.delete(original); }
    }, { publicOrigin: captured.publicOrigin, maxBodyBytes: 104857600,
      requestAdmission(request, incoming, server) { try { transport.admit(request, incoming, server); } catch { return failResponse(); } } });
    owner.server.once("listening", schedule);
  });
  owner.construction = construction;
  return construction.then(() => Object.freeze({ server: owner.server!, surfaceCapabilities: NODE_V28_RECOVERY_SURFACE,
    dispatchRecoveryJobsOnce, close }), async error => { quarantine(error); try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Recovery construction and original parent cleanup failed"); } throw error; });
}
function failResponse(): Response { return Response.json({ error: "Request admission is required." },
  { status: 403, headers: { "Cache-Control": "private, no-store" } }); }

import { createHash } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http.ts";
import { assertLinuxWriterLeaseBinding } from "../operations/writer-lease.ts";
import { asAdmittedJobSqlDatabase, createSqliteBatchAdmission, joinSqliteBatchAdmissions, runSqliteAdmittedBatch } from "../sqlite.ts";
import { assertLocalVolumeProfileOpeningV28, assertLocalVolumeProfileOpeningV28Binding,
  ownedLocalVolumeIdentityV28Candidate, prepareLocalVolumeProfileSqliteFence,
  type LocalVolumeProfileOpening } from "../storage/local-volume-profile-opening.ts";
import type { ReviewedInstallationAdmission } from "../migrations.ts";
import { SqlSystemRecoveryRepository, type RecoveryJob } from "../../worker/recovery/sql-repository.ts";
import { checkedSystemRecoveryMaintenanceStatus } from "../../shared/contracts/system-recovery.ts";
import { recoveryTableSnapshotSql } from "../../shared/contracts/system-recovery-image.ts";
import { PORTABLE_RUNTIME_RECOVERY_TABLES } from "../../shared/contracts/portable-runtime-v28-recovery-catalog.ts";
import { assertNodeV28OriginalSourceResumeHost, type NodeV28OriginalSourceResumeHost } from "./node-system-recovery-v28-application.ts";
import { ownedNodeV28SourceResumeVerification, type NodeV28SourceResumeVerification } from "./node-v28-archive-stages.ts";
import { stableJson } from "../../shared/domain/content-addressing.ts";
import type { NodeSystemBackupRecordsV5, SystemBackupRecordsV5 } from "../../shared/contracts/system-backup-v5.ts";

export interface NodeV28SourceResumeInput {
  requestId: string; releaseRequestId: string; backupJobId: string; expectedGeneration: number;
}
export interface NodeV28SourceResumeResult extends NodeV28SourceResumeInput {
  schema: "node-original-source-resume/1"; sourceInstallationId: string; incarnation: string;
  sourceCheckpoint: string; resumedAt: string; enabled: true; shadowEnabled: false; jobsEnabled: false;
  noBindingCutover: true; noJobReplay: true;
}
const digest = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
const conflict = () => new HTTPException(409, { message: "Original source resume requires a released, unchanged, drained writable LOCAL source" });
function ensure(value: unknown): asserts value { if (!value) throw conflict(); }
function id(value: unknown): asserts value is string { ensure(typeof value === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(value)); }
export function checkedNodeV28SourceResumeInput(value: unknown): NodeV28SourceResumeInput {
  ensure(value && typeof value === "object" && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  ensure(Object.keys(row).sort().join(",") === "backupJobId,expectedGeneration,releaseRequestId,requestId");
  id(row.requestId); id(row.releaseRequestId); id(row.backupJobId);
  ensure(typeof row.expectedGeneration === "number" && Number.isSafeInteger(row.expectedGeneration) && row.expectedGeneration >= 2);
  return Object.freeze({ requestId: row.requestId, releaseRequestId: row.releaseRequestId,
    backupJobId: row.backupJobId, expectedGeneration: row.expectedGeneration });
}
// Conservative settled-state proof. Expiry is never settlement. No source
// executor, pending ingress, unknown target/backup write or irreversible GC may
// run while the Recovery-only owner validates the source and commits resume.
const QUIET = `NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM file_holds WHERE released_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM file_location_holds WHERE released_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM system_recovery_legacy_holds WHERE released_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM file_shadow_attempts WHERE state IN('staged','write_started','unknown','verified'))
 AND NOT EXISTS(SELECT 1 FROM file_migration_attempts WHERE state IN('write_started','unknown'))
 AND NOT EXISTS(SELECT 1 FROM research_package_attempts WHERE state IN('write_started','unknown'))
 AND NOT EXISTS(SELECT 1 FROM system_recovery_attempts WHERE state IN('started','unknown'))
 AND NOT EXISTS(SELECT 1 FROM system_recovery_target_files WHERE state IN('write_started','unknown'))
 AND NOT EXISTS(SELECT 1 FROM system_recovery_target_claim WHERE status IN('claimed','installing','loading','files','verifying'))
 AND NOT EXISTS(SELECT 1 FROM system_recovery_jobs WHERE state IN('queued','running'))
 AND NOT EXISTS(SELECT 1 FROM file_migration_jobs WHERE state IN('queued','running'))
 AND NOT EXISTS(SELECT 1 FROM research_package_jobs WHERE state IN('queued','running'))
 AND NOT EXISTS(SELECT 1 FROM r2_upload_requests WHERE status='pending')
 AND NOT EXISTS(SELECT 1 FROM metrology_reference_upload_requests WHERE status='pending')
 AND NOT EXISTS(SELECT 1 FROM comment_submission_acceptances WHERE status='pending')
 AND NOT EXISTS(SELECT 1 FROM comment_item_acceptances WHERE status='pending')
 AND NOT EXISTS(SELECT 1 FROM import_file_acceptances WHERE status='pending')
 AND NOT EXISTS(SELECT 1 FROM imports WHERE status='pending')
 AND NOT EXISTS(SELECT 1 FROM file_acceptance_candidates WHERE state='candidate')
 AND NOT EXISTS(SELECT 1 FROM system_storage_candidate_checks WHERE status='running' OR cleanup_outcome='running' OR write_outcome='unknown')
 AND NOT EXISTS(SELECT 1 FROM blob_gc_ledger WHERE state='deleting')
 AND NOT EXISTS(SELECT 1 FROM file_location_gc_ledger WHERE state='deleting')
 AND EXISTS(SELECT 1 FROM file_shadow_runtime_guard WHERE singleton=1 AND enabled=0)
 AND EXISTS(SELECT 1 FROM file_job_runtime_guard WHERE singleton=1 AND enabled=0)
 AND EXISTS(SELECT 1 FROM system_recovery_runtime WHERE singleton=1 AND enabled=0)`;
const READY = `EXISTS(SELECT 1 FROM system_recovery_maintenance WHERE singleton=1 AND state='open'
 AND generation=? AND token IS NULL AND backup_job_id IS NULL AND checkpoint_sha256 IS NULL)
 AND EXISTS(SELECT 1 FROM system_recovery_maintenance_requests r WHERE r.request_id=? AND r.actor=? AND r.action='release'
 AND r.expected_generation=? AND json_extract(r.result_json,'$.state')='open'
 AND json_extract(r.result_json,'$.generation')=? AND json_extract(r.result_json,'$.token') IS NULL)
 AND EXISTS(SELECT 1 FROM file_authority_control c JOIN file_authority_runtime_guard g ON g.singleton=c.singleton
 JOIN file_shadow_checkpoints cp ON cp.id=g.incarnation AND cp.captured_at=c.updated_at
 WHERE c.singleton=1 AND c.mode='active' AND g.enabled=0 AND g.incarnation IS NOT NULL
 AND (SELECT count(*) FROM file_shadow_checkpoints WHERE captured_at=c.updated_at)=1)
 AND ${QUIET}`;

declare const sourceResumeLoginBrand: unique symbol;
export interface NodeV28SourceResumeLoginOwner { readonly [sourceResumeLoginBrand]: true }
interface OriginalLoginSession { tokenHash: string; principalId: string; createdAt: string; credentialRevision: string }
export interface NodeV28SourceResumeLoginAuditSummary {
  schema: "node-original-source-resume-authentication/1";
  principalId: string; sessionCreatedAt: string; credentialRevision: string;
  originalRows: number; currentRows: number; originalSha256: string; currentSha256: string;
  appendedSequence: string | null; appendedAt: string | null;
}
const sourceResumeLogins = new WeakMap<NodeV28SourceResumeLoginOwner, Readonly<{
  opening: LocalVolumeProfileOpening; database: ReturnType<typeof assertLocalVolumeProfileOpeningV28>["database"];
  native: ReturnType<typeof assertLocalVolumeProfileOpeningV28>["nativeDatabase"]; admission: ReviewedInstallationAdmission;
  request: Request; actor: string; session: Readonly<OriginalLoginSession>; current(): void;
}>>();
/** One operational LOGIN from this exact privately authenticated session only.
 * The returned hash input normalizes that proved append for comparison; the
 * caller retains the truthful complete current V5 image for its commit proof.
 * No archive document, format, protected table or old audit row is rewritten. */
export function verifyNodeV28SourceResumeLoginAudit(login: NodeV28SourceResumeLoginOwner,
  opening: LocalVolumeProfileOpening, database: ReturnType<typeof assertLocalVolumeProfileOpeningV28>["database"],
  native: ReturnType<typeof assertLocalVolumeProfileOpeningV28>["nativeDatabase"], admission: ReviewedInstallationAdmission,
  request: Request, job: RecoveryJob, original: SystemBackupRecordsV5, fresh: NodeSystemBackupRecordsV5) {
  const owner = sourceResumeLogins.get(login);
  ensure(owner && owner.opening === opening && owner.database === database && owner.native === native
    && owner.admission === admission && owner.request === request && owner.actor === job.actor);
  owner.current();
  const before = original.image.tables.local_auth_events, after = fresh.image.tables.local_auth_events;
  ensure(before && after && stableJson(before.columns) === stableJson(["sequence", "principal_id", "kind", "happened_at"])
    && stableJson(after.columns) === stableJson(before.columns));
  const prior = [...before.rows].sort((a, b) => BigInt(a.rowid!) < BigInt(b.rowid!) ? -1 : 1);
  const current = [...after.rows].sort((a, b) => BigInt(a.rowid!) < BigInt(b.rowid!) ? -1 : 1);
  ensure(current.length === prior.length || current.length === prior.length + 1);
  ensure(prior.every((row, index) => stableJson(row) === stableJson(current[index])));
  let appendedSequence: string | null = null, appendedAt: string | null = null;
  if (current.length !== prior.length) {
    const row = current[current.length - 1]!;
    const [sequence, principal, kind, at] = row.cells;
    ensure(sequence?.type === 'integer' && row.rowid === sequence.value
      && principal?.type === 'text' && principal.value === owner.session.principalId
      && kind?.type === 'text' && kind.value === 'login' && at?.type === 'integer'
      && at.value === owner.session.createdAt);
    const last = prior.length ? BigInt(prior[prior.length - 1]!.rowid!) : 0n;
    const completed = Date.parse(job.updated_at);
    ensure(BigInt(sequence.value) === last + 1n && Number.isFinite(completed)
      && BigInt(at.value) >= BigInt(completed) && BigInt(at.value) <= BigInt(Number.MAX_SAFE_INTEGER));
    appendedSequence = sequence.value; appendedAt = at.value;
  }
  const summary: NodeV28SourceResumeLoginAuditSummary = Object.freeze({ schema: 'node-original-source-resume-authentication/1',
    principalId: owner.session.principalId, sessionCreatedAt: owner.session.createdAt,
    credentialRevision: owner.session.credentialRevision, originalRows: prior.length, currentRows: current.length,
    originalSha256: digest(before), currentSha256: digest(after), appendedSequence, appendedAt });
  const checkpointRecords: NodeSystemBackupRecordsV5 = { ...structuredClone(fresh), image: { ...structuredClone(fresh.image),
    tables: { ...structuredClone(fresh.image.tables), local_auth_events: structuredClone(before) } } };
  owner.current(); return Object.freeze({ checkpointRecords, summary });
}

/** Concrete source action only. Every owner comes from the existing private
 * V28 opening registry; no caller Native/core/lease/callback can issue a grant.
 * The HTTP host additionally excludes mounted business writers and joins its
 * real archive/body/provider owners before calling this component. */
export function createNodeV28OriginalSourceResume(options: {
  scope: NodeV28OriginalSourceResumeHost; opening: LocalVolumeProfileOpening; authentication: object; admission: ReviewedInstallationAdmission; request: Request; actor: string;
}) {
  ensure(Object.keys(options).sort().join(",") === "actor,admission,authentication,opening,request,scope");
  const { scope, opening, authentication, admission, request, actor } = Object.freeze({ ...options });
  const owner = assertLocalVolumeProfileOpeningV28(opening), auth = localAuthenticationIdentityAuthority(authentication);
  const { database, nativeDatabase: native, writerLease } = owner;
  const identity = ownedLocalVolumeIdentityV28Candidate(opening, authentication, admission), installation = identity.installation;
  ensure(request instanceof Request);
  let originalSession: Readonly<OriginalLoginSession> | undefined;
  function session(): OriginalLoginSession {
    const predicate = auth.currentSessionPredicate(request, actor);
    const statement = native.prepare(`SELECT s.principal_id,s.created_at,a.credential_revision FROM local_sessions s
      JOIN local_accounts a ON a.principal_id=s.principal_id JOIN local_admin_grants g ON g.principal_id=a.principal_id
      WHERE s.token_hash=? AND ('local-account:'||a.principal_id)=? AND a.enabled=1 AND s.revoked_at IS NULL
        AND s.credential_revision=a.credential_revision`);
    statement.setReadBigInts(true); const row = statement.get(predicate.tokenHash, actor);
    ensure(row && typeof row.principal_id === 'string' && typeof row.created_at === 'bigint'
      && typeof row.credential_revision === 'bigint' && row.created_at >= 0n && row.credential_revision >= 1n);
    return { tokenHash: predicate.tokenHash, principalId: row.principal_id,
      createdAt: row.created_at.toString(), credentialRevision: row.credential_revision.toString() };
  }
  function current(): void {
    assertNodeV28OriginalSourceResumeHost(scope, opening, authentication, admission, request, actor);
    ensure(!request.signal.aborted);
    assertLocalVolumeProfileOpeningV28Binding(opening, database, native, writerLease, authentication);
    owner.assertCurrent(); assertLinuxWriterLeaseBinding(writerLease, database, native);
    ensure(localAuthenticationIdentityAuthority(authentication) === auth);
    owner.assertAdministrator(actor); auth.currentSessionPredicate(request, actor);
    if (originalSession) ensure(stableJson(session()) === stableJson(originalSession));
  }
  current(); originalSession = Object.freeze(session());
  const login = Object.freeze({}) as NodeV28SourceResumeLoginOwner;
  sourceResumeLogins.set(login, Object.freeze({ opening, database, native, admission, request, actor,
    session: originalSession, current }));
  function admitted() {
    current(); const session = auth.currentSessionPredicate(request, actor);
    return createSqliteBatchAdmission(database, [{ statement: database.prepare(`SELECT 1 admitted FROM local_sessions s
      JOIN local_accounts a ON a.principal_id=s.principal_id JOIN local_admin_grants g ON g.principal_id=a.principal_id
      CROSS JOIN (WITH observed AS MATERIALIZED (SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) now) SELECT now FROM observed) clock
      WHERE s.token_hash=? AND ('local-account:'||a.principal_id)=? AND a.enabled=1 AND s.revoked_at IS NULL
        AND a.credential_revision=s.credential_revision AND s.created_at=? AND a.credential_revision=? AND clock.now>=s.last_seen_at
        AND clock.now<s.absolute_expires_at AND clock.now<s.last_seen_at+?
        AND EXISTS(SELECT 1 FROM node_installation WHERE singleton=1 AND installation_id=? AND catalog_id=?
          AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)`)
      .bind(session.tokenHash, actor, originalSession!.createdAt, originalSession!.credentialRevision, identity.policy.idleLifetimeMs, installation.installationId, installation.catalogId,
        installation.checkpointId, installation.schemaSha256, installation.createdAt), rejection: conflict() }]);
  }
  const db = asAdmittedJobSqlDatabase(database, admitted, { assertHeld: current });
  const repository = new SqlSystemRecoveryRepository(db, value => value.primary());
  const key = (requestId: string) => "node_source_resume:" + requestId;
  const name = (requestId: string) => "node-source-resume/" + requestId;
  const bindings = (input: NodeV28SourceResumeInput) => [input.expectedGeneration, input.releaseRequestId, actor,
    input.expectedGeneration - 1, input.expectedGeneration];
  function assertCurrent(input: NodeV28SourceResumeInput): void {
    current(); assertNodeV28OriginalSourceResumeHost(scope, opening, authentication, admission, request, actor, true);
    ensure(native.prepare(`SELECT 1 admitted WHERE ${READY}`).get(...bindings(input)));
  }
  async function receipt(requestId: string): Promise<NodeV28SourceResumeResult | null> {
    id(requestId); current();
    const row = await db.prepare('SELECT job_id,input_sha256,accepted_at FROM system_recovery_requests WHERE actor=? AND request_id=?')
      .bind(actor, key(requestId)).first<{ job_id: string; input_sha256: string; accepted_at: string }>();
    if (!row) return null;
    const metadata = await repository.metadata(row.job_id, name(requestId)); current();
    ensure(metadata && typeof metadata === 'object' && !Array.isArray(metadata));
    const document = metadata as { schema?: unknown; input?: unknown; result?: unknown };
    ensure(document.schema === 'node-source-resume-receipt/1' && Object.keys(document).sort().join(',') === 'input,result,schema'
      && digest(document) === row.input_sha256);
    const input = checkedNodeV28SourceResumeInput(document.input), result = document.result as NodeV28SourceResumeResult;
    ensure(result && typeof result === 'object' && Object.keys(result).sort().join(',') ===
      'backupJobId,enabled,expectedGeneration,incarnation,jobsEnabled,noBindingCutover,noJobReplay,releaseRequestId,requestId,resumedAt,schema,shadowEnabled,sourceCheckpoint,sourceInstallationId'
      && result.schema === 'node-original-source-resume/1' && result.sourceInstallationId === installation.installationId
      && result.requestId === requestId && result.backupJobId === row.job_id && stableJson(checkedNodeV28SourceResumeInput({
        requestId: result.requestId, releaseRequestId: result.releaseRequestId, backupJobId: result.backupJobId,
        expectedGeneration: result.expectedGeneration })) === stableJson(input)
      && result.enabled === true && result.shadowEnabled === false && result.jobsEnabled === false
      && result.noBindingCutover === true && result.noJobReplay === true && result.resumedAt === row.accepted_at
      && typeof result.incarnation === 'string' && result.incarnation.length > 0
      && typeof result.sourceCheckpoint === 'string' && /^[a-f0-9]{64}$/.test(result.sourceCheckpoint));
    const authenticationReceipt = await db.prepare('SELECT job_id,input_sha256,accepted_at FROM system_recovery_requests WHERE actor=? AND request_id=?')
      .bind(actor, 'node_source_resume_auth:' + requestId).first<{ job_id: string; input_sha256: string; accepted_at: string }>();
    ensure(authenticationReceipt && authenticationReceipt.job_id === row.job_id && authenticationReceipt.accepted_at === row.accepted_at);
    const authenticationDocument = await repository.metadata(row.job_id, 'node-source-resume-auth/' + requestId); current();
    ensure(authenticationDocument && typeof authenticationDocument === 'object' && !Array.isArray(authenticationDocument)
      && digest(authenticationDocument) === authenticationReceipt.input_sha256);
    const provenance = authenticationDocument as NodeV28SourceResumeLoginAuditSummary & { backupId: string; releaseRequestId: string };
    ensure(Object.keys(provenance).sort().join(',') === 'appendedAt,appendedSequence,backupId,credentialRevision,currentRows,currentSha256,originalRows,originalSha256,principalId,releaseRequestId,schema,sessionCreatedAt'
      && provenance.schema === 'node-original-source-resume-authentication/1' && provenance.backupId === row.job_id
      && provenance.releaseRequestId === input.releaseRequestId && 'local-account:' + provenance.principalId === actor
      && /^[1-9][0-9]*$/.test(provenance.credentialRevision) && /^(0|[1-9][0-9]*)$/.test(provenance.sessionCreatedAt)
      && Number.isSafeInteger(provenance.originalRows) && provenance.originalRows >= 0
      && Number.isSafeInteger(provenance.currentRows) && (provenance.currentRows === provenance.originalRows
        || provenance.currentRows === provenance.originalRows + 1)
      && /^[a-f0-9]{64}$/.test(provenance.originalSha256) && /^[a-f0-9]{64}$/.test(provenance.currentSha256)
      && (provenance.currentRows === provenance.originalRows
        ? provenance.appendedSequence === null && provenance.appendedAt === null && provenance.currentSha256 === provenance.originalSha256
        : typeof provenance.appendedSequence === 'string' && /^[1-9][0-9]*$/.test(provenance.appendedSequence)
          && provenance.appendedAt === provenance.sessionCreatedAt));
    return result;
  }
  async function accepted(input: NodeV28SourceResumeInput) {
    const previous = await receipt(input.requestId);
    if (previous) ensure(stableJson({ requestId: previous.requestId, releaseRequestId: previous.releaseRequestId,
      backupJobId: previous.backupJobId, expectedGeneration: previous.expectedGeneration }) === stableJson(input));
    return previous;
  }
  async function backup(input: NodeV28SourceResumeInput): Promise<RecoveryJob> {
    assertCurrent(input); const job = await repository.job(input.backupJobId); assertCurrent(input);
    ensure(job && job.kind === 'backup' && job.state === 'completed' && job.phase === 'done' && job.actor === actor
      && job.source_checkpoint && job.artifact_key && job.archive_byte_size && job.archive_sha256);
    const window = JSON.parse(job.checkpoint_json ?? 'null')?.sourceWindow;
    ensure(window && window.generation === input.expectedGeneration - 1 && typeof window.token === 'string');
    const entered = await db.prepare("SELECT result_json FROM system_recovery_maintenance_requests WHERE request_id=? AND actor=? AND action='enter'")
      .bind(window.token, actor).first<{ result_json: string }>();
    ensure(entered); const original = checkedSystemRecoveryMaintenanceStatus(JSON.parse(entered.result_json));
    ensure(original.generation === window.generation && original.token === window.token && original.state === 'draining');
    assertCurrent(input); return job;
  }
  async function commit(input: NodeV28SourceResumeInput, proof: NodeV28SourceResumeVerification): Promise<NodeV28SourceResumeResult> {
    assertCurrent(input); const job = await backup(input);
    const verified = ownedNodeV28SourceResumeVerification(proof, opening, database, native, admission, request, job);
    const { records, authentication: authenticationProof } = verified;
    ensure(records.backupId === job.id && records.sourceMigrationLedger.installationId === installation.installationId);
    const roles = await db.prepare(`SELECT d.role,d.storage_profile_id,d.storage_profile_revision FROM storage_role_defaults d
      JOIN storage_role_policy_revisions h ON h.role=d.role AND h.policy_revision=d.policy_revision
        AND h.storage_profile_id=d.storage_profile_id AND h.storage_profile_revision=d.storage_profile_revision AND h.created_at=d.created_at
      ORDER BY d.role`).all<{ role: string; storage_profile_id: string; storage_profile_revision: number }>();
    ensure(roles.results.length === 2 && roles.results[0]?.role === 'internal' && roles.results[1]?.role === 'originals');
    const authorities = [...new Set(roles.results.map(row => { ensure(row.storage_profile_revision === 1); return row.storage_profile_id; }))]
      .map(profileId => owner.captureProfileAuthority({ profileId, configurationRevision: 1 }, 'write'));
    ensure(authorities.every(authority => authority.profile.adapterType === 'local' && authority.profile.runtimeState === 'read_write'));
    const activation = await db.prepare(`SELECT g.incarnation,cp.captured_at FROM file_authority_control c
      JOIN file_authority_runtime_guard g ON g.singleton=c.singleton JOIN file_shadow_checkpoints cp ON cp.id=g.incarnation
      WHERE c.singleton=1 AND c.mode='active' AND g.enabled=0 AND cp.captured_at=c.updated_at
      AND (SELECT count(*) FROM file_shadow_checkpoints WHERE captured_at=c.updated_at)=1`).first<{ incarnation: string; captured_at: string }>();
    ensure(activation && records.content.tables.file_shadow_checkpoints.some(row => row.id === activation.incarnation && row.captured_at === activation.captured_at));
    const result: NodeV28SourceResumeResult = Object.freeze({ schema: 'node-original-source-resume/1', ...input,
      sourceInstallationId: installation.installationId, incarnation: activation.incarnation, sourceCheckpoint: job.source_checkpoint!,
      resumedAt: new Date().toISOString(), enabled: true, shadowEnabled: false, jobsEnabled: false, noBindingCutover: true, noJobReplay: true });
    const document = { schema: 'node-source-resume-receipt/1', input, result }, hash = digest(document);
    const authenticationDocument = { ...authenticationProof, backupId: job.id, releaseRequestId: input.releaseRequestId };
    // Every original typed cell/rowid is compared INSIDE this same BEGIN. The
    // read-only validation made no publication/profile/business/hold mutation.
    const snapshots = PORTABLE_RUNTIME_RECOVERY_TABLES.filter(table => !table.local).map(table => {
      const expected = records.image.tables[table.name]; ensure(expected);
      return database.prepare(`SELECT CASE WHEN (SELECT count(*) FROM "${table.name}")=? AND NOT EXISTS(
        SELECT rowid,cells FROM (${recoveryTableSnapshotSql(table)}) EXCEPT
        SELECT json_extract(value,'$.rowid'),json(json_extract(value,'$.cells')) FROM json_each(?))
        THEN 1 ELSE json('Source resume typed metadata changed') END`).bind(expected.rows.length, JSON.stringify(expected.rows));
    });
    const checks = [database.prepare(`SELECT 1 admitted WHERE ${READY}`).bind(...bindings(input)),
      ...authorities.map(authority => prepareLocalVolumeProfileSqliteFence(authority, database))];
    checks.push(database.prepare(`SELECT 1 admitted FROM system_recovery_jobs WHERE id=? AND actor=? AND kind='backup'
      AND state='completed' AND phase='done' AND source_checkpoint=? AND artifact_key=? AND archive_byte_size=?
      AND archive_sha256=? AND checkpoint_json IS ? AND owner_token IS NULL`)
      .bind(job.id, actor, job.source_checkpoint, job.artifact_key, job.archive_byte_size, job.archive_sha256, job.checkpoint_json));
    assertCurrent(input); const batchAdmission = joinSqliteBatchAdmissions(database, [admitted(),
      createSqliteBatchAdmission(database, checks.map(statement => ({ statement, rejection: conflict() })))]);
    // The original frozen trigger permits this original incarnation only at
    // its immutable activation timestamp. Restore that disabled marker first,
    // then enable in the SAME guarded transaction. No checkpoint or identity
    // is fabricated; the independent durable receipt records the resume time.
    try {
      await runSqliteAdmittedBatch(database, [...snapshots,
        database.prepare("UPDATE file_authority_runtime_guard SET updated_at=? WHERE singleton=1 AND enabled=0 AND incarnation=?")
          .bind(activation.captured_at, activation.incarnation),
        database.prepare("UPDATE file_authority_runtime_guard SET enabled=1,enabled_by=?,updated_at=? WHERE singleton=1 AND enabled=0 AND incarnation=?")
          .bind(actor, activation.captured_at, activation.incarnation),
        database.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_authority_runtime_guard WHERE singleton=1 AND enabled=1 AND incarnation=? AND enabled_by=?)
          THEN 1 ELSE json('Original source File authority did not resume') END`).bind(activation.incarnation, actor),
        database.prepare("INSERT INTO system_recovery_requests(request_id,actor,job_id,input_sha256,accepted_at) VALUES(?,?,?,?,?)")
          .bind(key(input.requestId), actor, job.id, hash, result.resumedAt),
        database.prepare("INSERT INTO system_recovery_metadata_chunks(job_id,name,ordinal,chunk) VALUES(?,?,0,?)")
          .bind(job.id, name(input.requestId), stableJson(document)),
        database.prepare("INSERT INTO system_recovery_requests(request_id,actor,job_id,input_sha256,accepted_at) VALUES(?,?,?,?,?)")
          .bind('node_source_resume_auth:' + input.requestId, actor, job.id, digest(authenticationDocument), result.resumedAt),
        database.prepare("INSERT INTO system_recovery_metadata_chunks(job_id,name,ordinal,chunk) VALUES(?,?,0,?)")
          .bind(job.id, 'node-source-resume-auth/' + input.requestId, stableJson(authenticationDocument)),
      ], batchAdmission);
      current();
    } catch (error) { const previous = await accepted(input); if (previous) return previous; throw error; }
    const previous = await accepted(input); ensure(previous); return previous;
  }
  current(); return Object.freeze({ receipt, accepted, assertCurrent, backup, commit, login });
}

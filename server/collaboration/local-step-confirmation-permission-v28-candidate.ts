import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import type { RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { captureTargets, createStepConfirmationService } from "../../worker/execution/confirmation-service";
import type { StepConfirmationDatabase, StepConfirmationStatement } from "../../worker/execution/confirmation-sql";
import { configurationSqlCell, configurationSqlRow } from "../../worker/runtime/configuration-sql";
import type { RunStepTarget } from "../../shared/types";
import type { ReadSqlCell } from "../../worker/runtime/read-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement } from "../sqlite";

declare const confirmationPermissionBrand: unique symbol;
export interface StepConfirmationPermissionRequest {
  readonly kind: "unmounted-current-step-confirmation-permission-v28/1";
  readonly [confirmationPermissionBrand]: true;
}
type Captured = Readonly<{
  request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  actor: string; tokenHash: string; credentialRevision: bigint; sessionCreatedAt: bigint;
}>;
const unavailable = () => new HTTPException(503, { message: "Current step confirmation collaboration permissions are unavailable" });
const denied = () => new HTTPException(403, { message: "Current explicit Sample operate permission is required for every target" });
const memberWhere = "i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";

/** Unmounted confirmation owner only. Every exact Step->Run->Sample target
 * requires the current member's explicit Sample operate/edit/manage. No first
 * visible root, workspace read, Template grant, administrator, actor or creator
 * shortcut. Original neutral target parser and complete atomic SQL remain shared.
 * Mature pending/in_progress and updated_at predicates remain in original SQL;
 * this adapter adds no inferred run-kind, plan-status or Template eligibility.
 * The host retains the full original operation in its genuine physical lease. */
export function createLocalStepConfirmationPermissionV28Candidate(options: {
  database: SqliteCapability; nativeDatabase: DatabaseSync; admission: ReviewedInstallationAdmission;
  writerLease: LinuxWriterLease; authentication: object;
}) {
  const { database, nativeDatabase, admission, writerLease, authentication } = options;
  const auth = localAuthenticationIdentityAuthority(authentication);
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  const policy = assertInstalledLocalIdentityOwner(auth.identity, database, nativeDatabase, admission);
  const installation = Object.freeze({ ...assertInstallationAdmission(nativeDatabase, admission) });
  if (installation.checkpointId !== "portable-runtime/v28") throw unavailable();
  const control = nativeDatabase.prepare("SELECT schema_version,enforcement,revision FROM collaboration_control WHERE singleton=1").get();
  if (control?.schema_version !== 2 || !["disabled", "enabled"].includes(control.enforcement as string)
    || typeof control.revision !== "number" || !Number.isSafeInteger(control.revision) || control.revision < 1) throw unavailable();
  const sentinel = nativeDatabase.prepare("SELECT bootstrap_principal_id,initialized_at FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'").get();
  if (typeof sentinel?.bootstrap_principal_id !== "string" || typeof sentinel.initialized_at !== "number"
    || !Number.isSafeInteger(sentinel.initialized_at) || sentinel.initialized_at < 0) throw unavailable();
  const bootstrapPrincipalId = sentinel.bootstrap_principal_id, initializedAt = sentinel.initialized_at;
  const localIssuer = `node-installation:${installation.installationId}`;
  const issuer = createLocalRequestSubjectIssuer({ database, nativeDatabase, admission, writerLease, authentication });
  const requests = new WeakMap<StepConfirmationPermissionRequest, Captured>(), consumed = new WeakSet<StepConfirmationPermissionRequest>();
  let active = true;
  function selected(request: Request, token: StepConfirmationPermissionRequest): Captured {
    const owner = requests.get(token);
    if (!active || !owner || owner.request !== request || localAuthenticationIdentityAuthority(authentication) !== auth) throw denied();
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    const facts = issuer.read(request, owner.subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer || facts.subject !== owner.facts.subject
      || auth.currentSessionPredicate(request, owner.actor).tokenHash !== owner.tokenHash) throw denied();
    return owner;
  }
  function checks(owner: Captured, targets?: readonly Readonly<RunStepTarget>[]) {
    const guards = [
      { statement: database.prepare(`SELECT 1 admitted FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id
        CROSS JOIN (WITH observed AS MATERIALIZED (SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) now) SELECT now FROM observed) clock
        WHERE s.token_hash=? AND a.principal_id=? AND a.enabled=1 AND s.credential_revision=a.credential_revision
          AND a.credential_revision=? AND s.created_at=? AND s.revoked_at IS NULL
          AND typeof(clock.now)='integer' AND clock.now BETWEEN 0 AND 9007199254740991
          AND clock.now>=s.last_seen_at AND clock.now<s.absolute_expires_at AND clock.now<s.last_seen_at+? LIMIT 1`)
        .bind(owner.tokenHash, owner.facts.subject, owner.credentialRevision, owner.sessionCreatedAt, policy.idleLifetimeMs),
        rejection: new HTTPException(401, { message: "Current local authentication is required" }) },
      { statement: database.prepare(`SELECT 1 admitted WHERE
        EXISTS(SELECT 1 FROM node_installation WHERE singleton=1 AND installation_id=? AND catalog_id=? AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)
        AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1' AND bootstrap_principal_id=? AND initialized_at=?)
        AND EXISTS(SELECT 1 FROM collaboration_control WHERE singleton=1 AND schema_version=2 AND enforcement='enabled')`)
        .bind(installation.installationId, installation.catalogId, installation.checkpointId, installation.schemaSha256, installation.createdAt, bootstrapPrincipalId, initializedAt), rejection: unavailable() },
      { statement: database.prepare(`SELECT 1 admitted FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id WHERE ${memberWhere} LIMIT 1`)
        .bind(localIssuer, owner.facts.subject), rejection: denied() },
      { statement: database.prepare(`SELECT 1 admitted FROM system_recovery_maintenance WHERE singleton=1 AND state='open'
        AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
        AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='legacy')`), rejection: unavailable() },
    ];
    if (targets) guards.push({ statement: database.prepare(`
      SELECT 1 admitted WHERE json_array_length(?)=? AND NOT EXISTS(
        SELECT 1 FROM json_each(?) q WHERE NOT EXISTS(
          SELECT 1 FROM run_steps step JOIN runs run ON run.id=step.run_id
          JOIN samples sample ON sample.id=run.sample_id
          JOIN collaboration_resources r ON r.root_kind='sample' AND r.root_id=sample.id
          JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id
          JOIN collaboration_identities i ON i.member_id=g.member_id
          JOIN collaboration_members m ON m.member_id=i.member_id
          WHERE step.id=json_extract(q.value,'$.stepId') AND run.id=json_extract(q.value,'$.runId')
            AND sample.id=json_extract(q.value,'$.sampleId')
            AND step.deleted_at IS NULL AND run.deleted_at IS NULL AND sample.deleted_at IS NULL
            AND ${memberWhere} AND g.enabled=1 AND g.capability IN('operate','edit','manage')
        )
      )`).bind(JSON.stringify(targets), targets.length, JSON.stringify(targets), localIssuer, owner.facts.subject), rejection: denied() });
    return guards; // Four current authority checks + one all-target root guard, core bound8 unchanged.
  }
  async function capture(request: Request): Promise<StepConfirmationPermissionRequest> {
    if (!active || request.method !== "POST" || request.bodyUsed) throw denied();
    const url = new URL(request.url);
    if (url.pathname !== "/api/run-steps/confirm" || [...url.searchParams.keys()].length) throw denied();
    const tokenHash = auth.captureSessionDigest(request), subject = await issuer.issue(request), facts = issuer.read(request, subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer) throw denied();
    const actor = `local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(request, actor).tokenHash !== tokenHash) throw denied();
    const statement = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true); const row = statement.get(tokenHash, facts.subject); issuer.read(request, subject);
    if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const token = Object.freeze({ kind: "unmounted-current-step-confirmation-permission-v28/1" as const }) as StepConfirmationPermissionRequest;
    requests.set(token, Object.freeze({ request, subject, facts, actor, tokenHash,
      credentialRevision: row.credential_revision, sessionCreatedAt: row.created_at })); return token;
  }
  async function confirm(request: Request, token: StepConfirmationPermissionRequest, readInput: () => Promise<unknown>) {
    const owner = selected(request, token);
    if (consumed.has(token)) throw denied();
    consumed.add(token);
    const selectAdmission = (targets?: readonly Readonly<RunStepTarget>[]) => {
      selected(request, token); return createSqliteBatchAdmission(database, checks(owner, targets));
    };
    // No body or domain SQL before genuine current Request/member/control checks.
    await runSqliteAdmittedBatch(database, [], selectAdmission());
    const value = await readInput(); selected(request, token);
    const targets = captureTargets(value), input = Object.freeze({ targets });
    const currentAdmission = () => selectAdmission(targets);
    await runSqliteAdmittedBatch(database, [], currentAdmission());
    const statements = new WeakMap<StepConfirmationStatement, SqliteStatement>();
    let mutationAccepted = false;
    const wrap = (native: SqliteStatement): StepConfirmationStatement => {
      const statement: StepConfirmationStatement = Object.freeze({
        bind(...values: ReadSqlCell[]) { return wrap(native.bind(...values.map(configurationSqlCell))); },
      });
      statements.set(statement, native); return statement;
    };
    const port: StepConfirmationDatabase = Object.freeze({
      prepare(sql: string) { return wrap(database.prepare(sql)); },
      async atomicBatch(items: readonly StepConfirmationStatement[]) {
        if (mutationAccepted || !items.length) throw denied();
        const original = [...items].map(item => {
          const native = statements.get(item); if (!native) throw denied(); return native;
        });
        // Original WITH/UPDATE/RETURNING, per-Sample audits and timestamps execute
        // only after all current owned guards inside this same native BEGIN.
        const results = await runSqliteAdmittedBatch(database, original, currentAdmission());
        mutationAccepted = true;
        if (results.length !== original.length) throw unavailable();
        return results.map(result => ({ results: result.results.map(configurationSqlRow) }));
      },
    });
    const service = createStepConfirmationService({ database: () => port,
      async admit(actor) {
        if (actor !== owner.actor) throw denied();
        await runSqliteAdmittedBatch(database, [], currentAdmission()); selected(request, token);
      }, now: Date.now, randomId: () => crypto.randomUUID() });
    const result = await service.confirm(input, owner.actor);
    // Accepted SQL remains accepted if any one current root grant is revoked.
    await runSqliteAdmittedBatch(database, [], currentAdmission()); selected(request, token); return result;
  }
  return Object.freeze({ capture, confirm, discard() { active = false; } });
}

import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { createRunFinishService } from "../../worker/execution/run-finish-service";
import type { RunFinishDatabase, RunFinishStatement } from "../../worker/execution/run-finish-sql";
import { configurationSqlCell, configurationSqlInteger, configurationSqlRow } from "../../worker/runtime/configuration-sql";
import type { ReadSqlCell } from "../../worker/runtime/read-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement } from "../sqlite";

declare const runFinishPermissionBrand: unique symbol;
export interface RunFinishPermissionRequest {
  readonly kind: "unmounted-current-run-finish-permission-v28/1";
  readonly [runFinishPermissionBrand]: true;
}
export type RunFinishPermissionScope = Readonly<{ sampleId: string; runId: string }>;
type Captured = Readonly<{
  request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  scope: RunFinishPermissionScope; actor: string; tokenHash: string;
  credentialRevision: bigint; sessionCreatedAt: bigint;
}>;
type Snapshot = Readonly<{ sample: string; run: string; steps: string }>;
const unavailable = () => new HTTPException(503, { message: "Current Run collaboration permissions are unavailable" });
const denied = () => new HTTPException(403, { message: "Current explicit Sample operate permission is required" });
const changed = () => new HTTPException(409, { message: "This process run changed. Reload before continuing." });
const memberWhere = "i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";

// Operation-local derivation, never a cached grant or imported authority. The
// accepted Run's immutable Template snapshot is Sample history; finishing it
// does not grant navigation to or authoring of a live recipe-family root.
const SAMPLE_STATE = "SELECT json_array(id,updated_at,deleted_at) state FROM samples WHERE id=?";
const RUN_STATE = `SELECT json_array(id,sample_id,recipe_family_id,template_version_id,current_plan_revision_id,
  predecessor_run_id,anchor_step_id,sequence_no,run_group_id,template_name_snapshot,template_type_snapshot,
  template_version_snapshot,status,completed_at,run_kind,deleted_at) state FROM runs WHERE id=? AND sample_id=?`;
const STEPS_STATE = `SELECT json_group_array(json_array(id,run_id,previous_step_id,position,origin,plan_status,
  template_step_id,logical_step_key,definition_hash,expected_state_hash,status,entry_kind,deleted_at)) state FROM
  (SELECT * FROM run_steps WHERE run_id=? AND entry_kind='fabrication' ORDER BY position,id)`;

/** Unmounted existing process-Run finish owner only. Actual current mapping and
 * explicit Sample operate/edit/manage are distinct from Sample metadata edit,
 * administrator, creator, creation flag or workspace visibility. New Run/plan,
 * lifecycle, Template navigation, File/media and other Execution methods are
 * unavailable. The host retains the whole original promise in its writer lease.
 * Current OPV26/defaults and all historical catalogs/formats remain unchanged. */
export function createLocalRunFinishPermissionV28Candidate(options: {
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
  const requests = new WeakMap<RunFinishPermissionRequest, Captured>(), consumed = new WeakSet<RunFinishPermissionRequest>();
  let active = true;
  function selected(request: Request, token: RunFinishPermissionRequest): Captured {
    const owner = requests.get(token);
    if (!active || !owner || owner.request !== request || localAuthenticationIdentityAuthority(authentication) !== auth) throw denied();
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    const facts = issuer.read(request, owner.subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer || facts.subject !== owner.facts.subject
      || auth.currentSessionPredicate(request, owner.actor).tokenHash !== owner.tokenHash) throw denied();
    return owner;
  }
  function checks(owner: Captured, snapshot?: Snapshot) {
    const { sampleId, runId } = owner.scope;
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
      { statement: database.prepare(`SELECT 1 admitted FROM runs run JOIN samples sample ON sample.id=run.sample_id
        JOIN collaboration_resources r ON r.root_kind='sample' AND r.root_id=sample.id
        JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id
        JOIN collaboration_identities i ON i.member_id=g.member_id JOIN collaboration_members m ON m.member_id=i.member_id
        WHERE run.id=? AND run.sample_id=? AND run.run_kind='process' AND run.deleted_at IS NULL AND sample.deleted_at IS NULL
          AND ${memberWhere} AND g.enabled=1 AND g.capability IN('operate','edit','manage') LIMIT 1`)
        .bind(runId, sampleId, localIssuer, owner.facts.subject), rejection: denied() },
    ];
    if (snapshot) guards.push(
      { statement: database.prepare(`SELECT 1 admitted WHERE (${SAMPLE_STATE}) IS ?`).bind(sampleId, snapshot.sample), rejection: changed() },
      { statement: database.prepare(`SELECT 1 admitted WHERE (${RUN_STATE}) IS ?`).bind(runId, sampleId, snapshot.run), rejection: changed() },
      { statement: database.prepare(`SELECT 1 admitted WHERE (${STEPS_STATE}) IS ?`).bind(runId, snapshot.steps), rejection: changed() },
    );
    return guards; // Five current authority checks + three operation-local guards, core bound8 unchanged.
  }
  async function capture(request: Request, scopeInput: RunFinishPermissionScope): Promise<RunFinishPermissionRequest> {
    const { sampleId, runId } = scopeInput;
    if (!active || request.method !== "POST" || request.bodyUsed || !canonicalIdentityText(sampleId, 256) || !canonicalIdentityText(runId, 256)) throw denied();
    const url = new URL(request.url);
    if (url.pathname !== `/api/samples/${encodeURIComponent(sampleId)}/runs/${encodeURIComponent(runId)}/finish` || [...url.searchParams.keys()].length) throw denied();
    const tokenHash = auth.captureSessionDigest(request), subject = await issuer.issue(request), facts = issuer.read(request, subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer) throw denied();
    const actor = `local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(request, actor).tokenHash !== tokenHash) throw denied();
    const statement = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true); const row = statement.get(tokenHash, facts.subject); issuer.read(request, subject);
    if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const token = Object.freeze({ kind: "unmounted-current-run-finish-permission-v28/1" as const }) as RunFinishPermissionRequest;
    requests.set(token, Object.freeze({ request, subject, facts, scope: Object.freeze({ sampleId, runId }), actor, tokenHash,
      credentialRevision: row.credential_revision, sessionCreatedAt: row.created_at })); return token;
  }
  async function finish(request: Request, token: RunFinishPermissionRequest, readInput: () => Promise<unknown>) {
    const owner = selected(request, token); if (consumed.has(token)) throw denied(); consumed.add(token);
    const selectAdmission = (snapshot?: Snapshot) => { selected(request, token); return createSqliteBatchAdmission(database, checks(owner, snapshot)); };
    const rows = await runSqliteAdmittedBatch(database, [database.prepare(SAMPLE_STATE).bind(owner.scope.sampleId),
      database.prepare(RUN_STATE).bind(owner.scope.runId, owner.scope.sampleId), database.prepare(STEPS_STATE).bind(owner.scope.runId)], selectAdmission());
    const state = (index: number) => {
      const row = rows[index]; if (row?.results.length !== 1 || typeof row.results[0]?.state !== "string") throw changed();
      const value = row.results[0].state; if (Buffer.byteLength(value) > 1024 * 1024) throw new HTTPException(413, { message: "Run state exceeds this candidate's limit" });
      return value;
    };
    const snapshot = Object.freeze({ sample: state(0), run: state(1), steps: state(2) });
    const input = await readInput(); selected(request, token);
    const statements = new WeakMap<RunFinishStatement, SqliteStatement>(); let mutationAccepted = false;
    const currentAdmission = () => selectAdmission(mutationAccepted ? undefined : snapshot);
    const wrap = (native: SqliteStatement): RunFinishStatement => {
      const statement: RunFinishStatement = Object.freeze({
        bind(...values: ReadSqlCell[]) { return wrap(native.bind(...values.map(configurationSqlCell))); },
        async first() { const result = await runSqliteAdmittedBatch(database, [native], currentAdmission());
          if (result.length !== 1 || result[0]!.results.length > 1) throw unavailable();
          const row = result[0]!.results[0]; return row === undefined ? null : configurationSqlRow(row); },
        async all() { const result = await runSqliteAdmittedBatch(database, [native], currentAdmission());
          if (result.length !== 1) throw unavailable(); return { results: result[0]!.results.map(configurationSqlRow) }; },
      });
      statements.set(statement, native); return statement;
    };
    const port: RunFinishDatabase = Object.freeze({
      prepare(sql: string) { return wrap(database.prepare(sql)); },
      async atomicBatch(items: readonly RunFinishStatement[]) {
        if (mutationAccepted || !items.length) throw denied();
        const original = [...items].map(item => { const native = statements.get(item); if (!native) throw denied(); return native; });
        const results = await runSqliteAdmittedBatch(database, original, currentAdmission());
        mutationAccepted = true;
        if (results.length !== original.length) throw unavailable();
        return results.map(result => ({ directChanges: configurationSqlInteger(result.meta.directChanges, "Run finish native direct changes"),
          results: result.results.map(configurationSqlRow) }));
      },
    });
    const service = createRunFinishService({ database: () => port,
      async admit(actor) { if (actor !== owner.actor) throw denied(); await runSqliteAdmittedBatch(database, [], currentAdmission()); selected(request, token); },
      now: Date.now, randomId: () => crypto.randomUUID() });
    const value = await service.finish(owner.scope.sampleId, owner.scope.runId, input, owner.actor);
    await runSqliteAdmittedBatch(database, [], selectAdmission()); selected(request, token); return value;
  }
  return Object.freeze({ capture, finish, discard() { active = false; } });
}

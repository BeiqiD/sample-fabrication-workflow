import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { createTemplateStepDeleteService } from "../../worker/process-definition/template-step-delete-service";
import { TEMPLATE_STEP_DELETE_FIRST_SQL, TEMPLATE_STEP_DELETE_REMAINING_SQL, TEMPLATE_STEP_DELETE_MUTATION_SQL,
  templateStepDeleteSql, type TemplateStepDeleteDatabase, type TemplateStepDeleteStatement } from "../../worker/process-definition/template-step-delete-sql";
import { configurationSqlInteger, configurationSqlRow } from "../../worker/runtime/configuration-sql";
import type { ReadSqlCell } from "../../worker/runtime/read-sql";
import { publishedTemplateVersionSql } from "../../worker/template-publication";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, LocalRequestSubjectError, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement } from "../sqlite";

declare const stepDeleteBrand: unique symbol;
export interface TemplateStepDeleteRequest {
  readonly kind: "current-template-step-delete-v28/1";
  readonly [stepDeleteBrand]: true;
}
type Captured = Readonly<{
  request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  templateId: string; stepId: string; actor: string; tokenHash: string;
  credentialRevision: bigint; sessionCreatedAt: bigint;
}>;
type Snapshot = Readonly<{ version: string; steps: string }>;
const unavailable = () => new HTTPException(503, { message: "Current Template Step deletion is unavailable" });
const denied = () => new HTTPException(403, { message: "Current explicit Template family edit permission is required" });
const changed = () => new HTTPException(409, { message: "This Template changed. Reload before continuing." });
const memberWhere = "i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";
// Native JSON encodes integer values losslessly, before the application reads
// a string. The publication decision is part of the complete version witness.
const VERSION_STATE = `SELECT json_array(tv.id,tv.recipe_family_id,tv.name,tv.template_type,tv.template_kind,tv.version,
  tv.manifest_hash,tv.initial_state_hash,tv.source_filename,tv.source_asset_key,tv.source_file_id,tv.content_json,
  tv.created_by,tv.created_at,tv.locked_at,tv.locked_by,tv.archived_at,tv.archived_by,tv.deleted_at,tv.deleted_by,
  tv.metrology_notes,(${publishedTemplateVersionSql("tv")})) state FROM template_versions tv WHERE tv.id=?`;
const STEPS_STATE = `SELECT json_group_array(json_array(id,template_version_id,logical_step_key,position,source_row,
  step_number,section_name,definition_hash,expected_state_hash,raw_json)) state FROM
  (SELECT * FROM template_steps WHERE template_version_id=? ORDER BY position,id)`;

/** Metadata-only pointer deletion. No File read, import, publication, retirement
 * or creator/admin authority is issued. The mature service owns the original
 * complete hash and both original SQL/result ordinals. Whole HTTP/body/native
 * and physical writer lifetime remains with the genuine application parent. */
export function createLocalTemplateStepDeleteV28Candidate(options: {
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
  const requests = new WeakMap<TemplateStepDeleteRequest, Captured>(), consumed = new WeakSet<TemplateStepDeleteRequest>();
  let active = true;
  function selected(request: Request, token: TemplateStepDeleteRequest): Captured {
    const owner = requests.get(token);
    if (!active || !owner || owner.request !== request || localAuthenticationIdentityAuthority(authentication) !== auth) throw denied();
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    const facts = issuer.read(request, owner.subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer || facts.subject !== owner.facts.subject
      || auth.currentSessionPredicate(request, owner.actor).tokenHash !== owner.tokenHash) throw denied();
    return owner;
  }
  function checks(owner: Captured, snapshot?: Snapshot) {
    const result = [
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
        AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode IN('legacy','active'))`), rejection: unavailable() },
      // A genuinely missing version reaches the original404. For an existing
      // version, the actual family must have an explicit live edit/manage grant.
      // Step presence/publication/locked state is deliberately the mature
      // algorithm's decision, rather than a permission reclassification.
      { statement: database.prepare(`SELECT 1 admitted WHERE NOT EXISTS(SELECT 1 FROM template_versions WHERE id=?) OR EXISTS(
        SELECT 1 FROM template_versions tv JOIN recipe_families rf ON rf.id=tv.recipe_family_id
        JOIN collaboration_resources r ON r.root_kind='template' AND r.root_id=rf.id
        JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id
        JOIN collaboration_identities i ON i.member_id=g.member_id JOIN collaboration_members m ON m.member_id=i.member_id
        WHERE tv.id=? AND rf.archived_at IS NULL AND ${memberWhere} AND g.enabled=1 AND g.capability IN('edit','manage'))`)
        .bind(owner.templateId, owner.templateId, localIssuer, owner.facts.subject), rejection: denied() },
    ];
    if (snapshot) result.push(
      { statement: database.prepare(`SELECT 1 admitted WHERE (${VERSION_STATE}) IS ?`).bind(owner.templateId, snapshot.version), rejection: changed() },
      { statement: database.prepare(`SELECT 1 admitted WHERE (${STEPS_STATE}) IS ?`).bind(owner.templateId, snapshot.steps), rejection: changed() },
    );
    return result; // Five real authority checks + two complete witnesses <=8.
  }
  async function capture(request: Request, input: Readonly<{ templateId: string; stepId: string }>): Promise<TemplateStepDeleteRequest> {
    const { templateId, stepId } = input; // Fixed selector values before the first await.
    const url = new URL(request.url);
    if (!active || request.method !== "DELETE" || request.bodyUsed || !canonicalIdentityText(templateId, 256)
      || !canonicalIdentityText(stepId, 256) || url.pathname !== `/api/templates/${encodeURIComponent(templateId)}/steps/${encodeURIComponent(stepId)}`
      || url.search || url.hash) throw denied();
    const tokenHash = auth.captureSessionDigest(request), subject = await issuer.issue(request), facts = issuer.read(request, subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer) throw denied();
    const actor = `local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(request, actor).tokenHash !== tokenHash) throw denied();
    const statement = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true); const row = statement.get(tokenHash, facts.subject); issuer.read(request, subject);
    if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const token = Object.freeze({ kind: "current-template-step-delete-v28/1" as const }) as TemplateStepDeleteRequest;
    requests.set(token, Object.freeze({ request, subject, facts, templateId, stepId, actor, tokenHash,
      credentialRevision: row.credential_revision, sessionCreatedAt: row.created_at })); return token;
  }
  async function perform(request: Request, token: TemplateStepDeleteRequest) {
    const owner = selected(request, token); if (consumed.has(token)) throw denied(); consumed.add(token);
    const admissionFor = (snapshot?: Snapshot) => {
      selected(request, token); return createSqliteBatchAdmission(database, checks(owner, snapshot));
    };
    const captured = await runSqliteAdmittedBatch(database, [database.prepare(VERSION_STATE).bind(owner.templateId),
      database.prepare(STEPS_STATE).bind(owner.templateId)], admissionFor());
    if (captured.length !== 2) throw unavailable();
    if (captured[0]?.results.length !== 1) throw new HTTPException(404, { message: "Template version not found" });
    const state = (index: number) => {
      const result = captured[index]; if (result?.results.length !== 1 || typeof result.results[0]?.state !== "string") throw unavailable();
      const value = result.results[0].state;
      if (Buffer.byteLength(value) > 1024 * 1024) throw new HTTPException(413, { message: "Template state exceeds this candidate's limit" });
      return value;
    };
    const snapshot: Snapshot = Object.freeze({ version: state(0), steps: state(1) });
    let mutationAccepted = false;
    const currentAdmission = () => admissionFor(mutationAccepted ? undefined : snapshot);
    const statements = new WeakMap<TemplateStepDeleteStatement, Readonly<{ native: SqliteStatement; sql: string }>>();
    const wrap = (native: SqliteStatement, sql: string): TemplateStepDeleteStatement => {
      const wrapped: TemplateStepDeleteStatement = Object.freeze({
        bind(...values: ReadSqlCell[]) { return wrap(native.bind(...values), sql); },
        async first() {
          if (!TEMPLATE_STEP_DELETE_FIRST_SQL.includes(sql)) throw denied();
          const result = await runSqliteAdmittedBatch(database, [native], currentAdmission());
          if (result.length !== 1 || result[0]!.results.length > 1) throw unavailable();
          const row = result[0]!.results[0]; return row === undefined ? null : configurationSqlRow(row);
        },
        async all() {
          if (sql !== TEMPLATE_STEP_DELETE_REMAINING_SQL) throw denied();
          const result = await runSqliteAdmittedBatch(database, [native], currentAdmission());
          if (result.length !== 1) throw unavailable();
          return { results: result[0]!.results.map(row => configurationSqlRow(row)) };
        },
      });
      statements.set(wrapped, Object.freeze({ native, sql })); return wrapped;
    };
    const port: TemplateStepDeleteDatabase = Object.freeze({
      prepare(sql: string) { return wrap(database.prepare(templateStepDeleteSql(sql)), sql); },
      async batch(items: readonly TemplateStepDeleteStatement[]) {
        if (mutationAccepted || items.length !== 2) throw denied();
        const original = items.map((item, index) => {
          const value = statements.get(item);
          if (!value || value.sql !== TEMPLATE_STEP_DELETE_MUTATION_SQL[index]) throw denied(); return value.native;
        });
        const result = await runSqliteAdmittedBatch(database, original, currentAdmission());
        if (result.length !== 2) throw unavailable(); mutationAccepted = true;
        return result.map(row => ({ changes: configurationSqlInteger(row.meta.directChanges, "Template Step deletion direct changes", 0) }));
      },
    });
    const service = createTemplateStepDeleteService({ database: () => port,
      async admit(actor: string) { if (actor !== owner.actor) throw denied();
        await runSqliteAdmittedBatch(database, [], currentAdmission()); selected(request, token); },
    });
    let workFailed = false, workError: unknown, value!: Awaited<ReturnType<typeof service.remove>>;
    try { value = await service.remove(owner.templateId, owner.stepId, owner.actor); }
    catch (error) { workFailed = true; workError = error; }
    try { await runSqliteAdmittedBatch(database, [], admissionFor()); selected(request, token); }
    catch (lateError) {
      if (!workFailed) throw lateError;
      const status = lateError instanceof HTTPException ? lateError.status
        : lateError instanceof LocalRequestSubjectError && lateError.code === "authentication_required" ? 401 : 503;
      throw new HTTPException(status, { message: "Current Template Step deletion acknowledgement is unavailable",
        cause: new AggregateError([workError, lateError], "Original Template Step deletion and current acknowledgement both failed") });
    }
    if (workFailed) throw workError;
    return value;
  }
  return Object.freeze({ capture, perform, discard() { active = false; } });
}

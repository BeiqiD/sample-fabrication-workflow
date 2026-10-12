import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { createRunPlanService, capturePlanInput } from "../../worker/execution/run-plan-service";
import { createExecutionPreviewService, templateInput } from "../../worker/execution/preview-service";
import type { RunPlanDatabase, RunPlanStatement } from "../../worker/execution/run-plan-sql";
import type { ReadSqlCell } from "../../worker/runtime/read-sql";
import { publishedTemplateVersionSql } from "../../worker/template-publication";
import { configurationSqlCell, configurationSqlInteger, configurationSqlRow } from "../../worker/runtime/configuration-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement } from "../sqlite";

declare const runPlanUpdatePermissionBrand: unique symbol;
export interface RunPlanUpdatePermissionRequest {
  readonly kind: "unmounted-current-run-plan-update-permission-v28/1";
  readonly [runPlanUpdatePermissionBrand]: true;
}
export type RunPlanUpdatePermissionScope = Readonly<{ sampleId: string; runId: string; operation: "preview" | "apply" }>;
type Captured = Readonly<{
  request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  scope: RunPlanUpdatePermissionScope; actor: string; tokenHash: string;
  credentialRevision: bigint; sessionCreatedAt: bigint;
}>;
type Snapshot = Readonly<{ sample: string; template: string }>;
const unavailable = () => new HTTPException(503, { message: "Current process Run plan update/preview collaboration permissions are unavailable" });
const denied = () => new HTTPException(403, { message: "Current Sample edit and live recipe-family read permission are required" });
const changed = () => new HTTPException(409, { message: "The Sample or process Template changed. Review the structures again." });
const memberWhere = "i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";

// These complete operation-local derivations are never cached grants.
const SAMPLE_STATE = `SELECT json_array(s.id,s.code,s.status,s.updated_at,s.deleted_at,s.inherited_state_hash,
  (SELECT json_group_array(json_array(id,sample_id,run_kind,status,sequence_no,initial_state_hash,created_at,deleted_at,
      current_plan_revision_id,template_version_id,recipe_family_id,predecessor_run_id,anchor_step_id,completed_at))
    FROM (SELECT * FROM runs WHERE sample_id=s.id ORDER BY id)),
  (SELECT json_group_array(json_array(id,run_id,position,previous_step_id,title,
      definition_hash,definition_name,expected_state_hash,status,entry_kind,plan_status,actualized_at,deleted_at,
      origin,logical_step_key,template_step_id,updated_at))
    FROM (SELECT rs.*,sd.name definition_name FROM run_steps rs
      LEFT JOIN step_definitions sd ON sd.hash=rs.definition_hash
      WHERE rs.run_id IN(SELECT id FROM runs WHERE sample_id=s.id) ORDER BY rs.id)),
  (SELECT json_group_array(json_array(id,run_id,revision_no,template_version_id,effective_after_step_id,reason,created_at,current_version))
    FROM (SELECT rpr.*,tv.version current_version FROM run_plan_revisions rpr
      JOIN runs r ON r.id=rpr.run_id JOIN template_versions tv ON tv.id=rpr.template_version_id
      WHERE r.sample_id=s.id ORDER BY rpr.id)),
  (SELECT json_group_array(json_array(run_plan_revision_id,template_step_id,run_step_id,relation,source_position))
    FROM (SELECT l.*,ts.position source_position FROM run_step_plan_links l
      JOIN run_plan_revisions rpr ON rpr.id=l.run_plan_revision_id JOIN runs r ON r.id=rpr.run_id
      JOIN template_steps ts ON ts.id=l.template_step_id WHERE r.sample_id=s.id
      ORDER BY l.run_plan_revision_id,l.template_step_id,l.run_step_id))) state FROM samples s WHERE s.id=?`;
const TEMPLATE_STATE = `SELECT json_array(tv.id,tv.recipe_family_id,tv.name,tv.template_type,tv.template_kind,tv.version,
  tv.initial_state_hash,tv.content_json,tv.archived_at,tv.deleted_at,
  (SELECT json_group_array(json_array(id,position,logical_step_key,definition_hash,expected_state_hash))
    FROM (SELECT * FROM template_steps WHERE template_version_id=tv.id ORDER BY position,id)),
  (SELECT json_group_array(json_array(id,status))
    FROM (SELECT id,status FROM imports WHERE template_version_id=tv.id ORDER BY id))) state
  FROM template_versions tv WHERE tv.id=?`;
const MEDIA_FREE = `SELECT 1 admitted WHERE
  NOT EXISTS(SELECT 1 FROM run_step_assets rsa JOIN run_steps rs ON rs.id=rsa.run_step_id JOIN runs r ON r.id=rs.run_id
    WHERE r.sample_id=? AND rsa.role='execution' AND rsa.deleted_at IS NULL)
  AND NOT EXISTS(SELECT 1 FROM state_representation_assets sra WHERE sra.state_hash IN(
    SELECT inherited_state_hash FROM samples WHERE id=?
    UNION SELECT initial_state_hash FROM runs WHERE sample_id=?
    UNION SELECT rs.expected_state_hash FROM run_steps rs JOIN runs r ON r.id=rs.run_id WHERE r.sample_id=?
    UNION SELECT initial_state_hash FROM template_versions WHERE id=?
    UNION SELECT expected_state_hash FROM template_steps WHERE template_version_id=?))`;

/** Unmounted media-free original process plan-update preview/apply only.
 * Current Sample edit/manage and selected live recipe-family read are independent
 * same-BEGIN permissions. Existing accepted snapshots remain Sample history. */
export function createLocalRunPlanUpdatePermissionV28Candidate(options: {
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
  const requests = new WeakMap<RunPlanUpdatePermissionRequest, Captured>(), consumed = new WeakSet<RunPlanUpdatePermissionRequest>();
  let active = true;
  function selected(request: Request, token: RunPlanUpdatePermissionRequest): Captured {
    const owner = requests.get(token);
    if (!active || !owner || owner.request !== request || localAuthenticationIdentityAuthority(authentication) !== auth) throw denied();
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    const facts = issuer.read(request, owner.subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer || facts.subject !== owner.facts.subject
      || auth.currentSessionPredicate(request, owner.actor).tokenHash !== owner.tokenHash) throw denied();
    return owner;
  }
  function checks(owner: Captured, templateId?: string | number, snapshot?: Snapshot) {
    const { sampleId, runId } = owner.scope;
    const sampleRight = `EXISTS(SELECT 1 FROM runs selected_run JOIN samples sample ON sample.id=selected_run.sample_id
      JOIN collaboration_resources r ON r.root_kind='sample' AND r.root_id=sample.id
      JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id
      JOIN collaboration_identities i ON i.member_id=g.member_id JOIN collaboration_members m ON m.member_id=i.member_id
      WHERE selected_run.id=? AND selected_run.sample_id=? AND selected_run.run_kind='process'
        AND selected_run.deleted_at IS NULL AND sample.deleted_at IS NULL AND ${memberWhere}
        AND g.enabled=1 AND g.capability IN('edit','manage'))`;
    const templateRight = `EXISTS(SELECT 1 FROM template_versions tv JOIN recipe_families rf ON rf.id=tv.recipe_family_id
      JOIN collaboration_resources r ON r.root_kind='template' AND r.root_id=rf.id
      JOIN collaboration_identities i ON i.provider='local' AND i.issuer=? AND i.subject=?
      JOIN collaboration_members m ON m.member_id=i.member_id
      WHERE tv.id=? AND tv.template_kind='process' AND tv.archived_at IS NULL AND tv.deleted_at IS NULL
        AND rf.archived_at IS NULL AND ${publishedTemplateVersionSql("tv")} AND i.enabled=1 AND m.state='active'
        AND (r.visibility='workspace' OR EXISTS(SELECT 1 FROM collaboration_grants g
          WHERE g.root_kind=r.root_kind AND g.root_id=r.root_id AND g.member_id=i.member_id
            AND g.enabled=1 AND g.capability IN('read','edit','manage'))))`;
    const permissions = templateId === undefined
      ? database.prepare(`SELECT 1 admitted WHERE ${sampleRight}`).bind(runId,sampleId,localIssuer,owner.facts.subject)
      : database.prepare(`SELECT 1 admitted WHERE ${sampleRight} AND ${templateRight}`)
        .bind(runId,sampleId,localIssuer,owner.facts.subject,localIssuer,owner.facts.subject,templateId);
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
      { statement: permissions, rejection: denied() },
    ];
    if (templateId !== undefined) guards.push({ statement: database.prepare(MEDIA_FREE)
      .bind(sampleId,sampleId,sampleId,sampleId,templateId,templateId), rejection: unavailable() });
    if (snapshot) guards.push(
      { statement: database.prepare(`SELECT 1 admitted WHERE (${SAMPLE_STATE}) IS ?`).bind(sampleId,snapshot.sample), rejection: changed() },
      { statement: database.prepare(`SELECT 1 admitted WHERE (${TEMPLATE_STATE}) IS ?`).bind(templateId!,snapshot.template), rejection: changed() },
    );
    return guards; // Five fresh authority + media-free + two immutable source checks: bound8 unchanged.
  }
  async function capture(request: Request, scopeInput: RunPlanUpdatePermissionScope): Promise<RunPlanUpdatePermissionRequest> {
    const { sampleId, runId, operation } = scopeInput;
    if (!active || (operation !== "preview" && operation !== "apply") || request.method !== "POST" || request.bodyUsed
      || (!canonicalIdentityText(sampleId,256) || !canonicalIdentityText(runId,256))) throw denied();
    const url = new URL(request.url);
    if (url.pathname !== `/api/samples/${encodeURIComponent(sampleId)}/runs/${encodeURIComponent(runId)}/plan-update${operation === "preview" ? "/preview" : ""}` || [...url.searchParams.keys()].length) throw denied();
    const tokenHash = auth.captureSessionDigest(request), subject = await issuer.issue(request), facts = issuer.read(request,subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer) throw denied();
    const actor = `local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(request,actor).tokenHash !== tokenHash) throw denied();
    const statement = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true); const row = statement.get(tokenHash,facts.subject); issuer.read(request,subject);
    if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const token = Object.freeze({ kind: "unmounted-current-run-plan-update-permission-v28/1" as const }) as RunPlanUpdatePermissionRequest;
    requests.set(token,Object.freeze({ request,subject,facts,scope:Object.freeze({sampleId,runId,operation}),actor,tokenHash,
      credentialRevision:row.credential_revision,sessionCreatedAt:row.created_at })); return token;
  }
  async function perform(request: Request, token: RunPlanUpdatePermissionRequest, readInput: () => Promise<unknown>) {
    const owner = selected(request,token); if (consumed.has(token)) throw denied(); consumed.add(token);
    const selectAdmission = (templateId?: string | number, snapshot?: Snapshot) => {
      selected(request,token); return createSqliteBatchAdmission(database,checks(owner,templateId,snapshot));
    };
    // Denied Sample plan editors cannot consume JSON or inspect a selected source.
    await runSqliteAdmittedBatch(database,[],selectAdmission());
    const raw = await readInput(); selected(request,token);
    const input = owner.scope.operation === "apply" ? capturePlanInput(raw)
      : Object.freeze({ templateVersionId: templateInput(raw,"A template version is required") });
    // The original pure plan-input capture freezes selectors and confirmation.
    // Full original parser, lifecycle/alignment and substrate CAS stay in service.
    if (owner.scope.operation === "apply" && (!input || typeof input.templateVersionId !== "string" || !input.templateVersionId))
      throw new HTTPException(400,{message:"A process-template version, substrate confirmation, and optional reason are required"});
    const templateId = input?.templateVersionId;
    if (typeof templateId !== "string" && typeof templateId !== "number") throw denied();
    const rows = await runSqliteAdmittedBatch(database,[database.prepare(SAMPLE_STATE).bind(owner.scope.sampleId),
      database.prepare(TEMPLATE_STATE).bind(templateId)],selectAdmission(templateId));
    const state = (index:number) => {
      const row = rows[index]; if (row?.results.length !== 1 || typeof row.results[0]?.state !== "string") throw changed();
      const value = row.results[0].state;
      if (Buffer.byteLength(value)>1024*1024) throw new HTTPException(413,{message:"Process source state exceeds this candidate's limit"});
      return value;
    };
    const snapshot = Object.freeze({sample:state(0),template:state(1)});
    const statements = new WeakMap<RunPlanStatement,SqliteStatement>(); let mutationAccepted=false;
    const currentAdmission = () => selectAdmission(templateId,mutationAccepted ? undefined : snapshot);
    const wrap = (native:SqliteStatement):RunPlanStatement => {
      const statement:RunPlanStatement = Object.freeze({
        bind(...values:ReadSqlCell[]) { return wrap(native.bind(...values.map(configurationSqlCell))); },
        async first() { const result=await runSqliteAdmittedBatch(database,[native],currentAdmission());
          if(result.length!==1 || result[0]!.results.length>1) throw unavailable();
          const row=result[0]!.results[0];return row===undefined ? null : configurationSqlRow(row); },
        async all() { const result=await runSqliteAdmittedBatch(database,[native],currentAdmission());
          if(result.length!==1) throw unavailable();return {results:result[0]!.results.map(configurationSqlRow)}; },
      }); statements.set(statement,native);return statement;
    };
    const port:RunPlanDatabase=Object.freeze({
      prepare(sql:string) {return wrap(database.prepare(sql));},
      async atomicBatch(items:readonly RunPlanStatement[]) {
        if(owner.scope.operation!=="apply" || mutationAccepted || !items.length || items.length>49) throw denied();
        const original=[...items].map(item=>{const native=statements.get(item);if(!native)throw denied();return native;});
        const result=await runSqliteAdmittedBatch(database,original,currentAdmission()); mutationAccepted=true;
        if(result.length!==original.length)throw unavailable();
        return result.map(row=>({changes:configurationSqlInteger(row.meta.totalChanges,"Run plan native changes")}));
      },
    });
    const capabilities={database:()=>port,authorityDatabase:()=>port,
      async admit(actor:string) {if(actor!==owner.actor)throw denied();
        await runSqliteAdmittedBatch(database,[],currentAdmission());selected(request,token);},
      now:Date.now,randomId:()=>crypto.randomUUID()};
    const value=owner.scope.operation==="preview"
      ? await createExecutionPreviewService(capabilities).planUpdate(owner.scope.sampleId,owner.scope.runId,input,owner.actor)
      : await createRunPlanService(capabilities).apply(owner.scope.sampleId,owner.scope.runId,input,owner.actor);
    // Preview retains its source comparisons; accepted plan update does not compare
    // its own newly changed Run/plan/step set. Current dual-root/session ACK stays fresh.
    await runSqliteAdmittedBatch(database,[],currentAdmission());selected(request,token);return value;
  }
  return Object.freeze({capture,perform,discard(){active=false;}});
}

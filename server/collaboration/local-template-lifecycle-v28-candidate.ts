import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { createTemplateLifecycleService } from "../../worker/process-definition/template-lifecycle-service";
import { TEMPLATE_LIFECYCLE_PUBLISHED_SQL, TEMPLATE_LIFECYCLE_EDIT_STATE_SQL, TEMPLATE_LIFECYCLE_DELETE_STATE_SQL, TEMPLATE_LIFECYCLE_RESTORE_STATE_SQL, TEMPLATE_LIFECYCLE_RENAME_SQL, TEMPLATE_LIFECYCLE_REMOVE_SQL, TEMPLATE_LIFECYCLE_RESTORE_SQL, type TemplateLifecycleDatabase, type TemplateLifecycleStatement } from "../../worker/process-definition/template-lifecycle-sql";
import type { ReadSqlCell } from "../../worker/runtime/read-sql";
import { publishedTemplateVersionSql } from "../../worker/template-publication";
import { configurationSqlInteger, configurationSqlRow } from "../../worker/runtime/configuration-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement } from "../sqlite";

declare const lifecyclePermissionBrand: unique symbol;
export interface TemplateLifecycleRequest {
  readonly kind: "unmounted-current-template-lifecycle-v28/1";
  readonly [lifecyclePermissionBrand]: true;
}
export type TemplateLifecycleScope = Readonly<{ operation: "rename" | "remove" | "restore"; templateId: string }>;
type Captured = Readonly<{
  request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  scope: TemplateLifecycleScope; actor: string; tokenHash: string; credentialRevision: bigint; sessionCreatedAt: bigint;
}>;
type Snapshot = Readonly<{ version: string; references: string }>;
const unavailable = () => new HTTPException(503, { message: "Current Template lifecycle permissions are unavailable" });
const denied = () => new HTTPException(403, { message: "Current explicit Template family edit permission is required" });
const changed = () => new HTTPException(409, { message: "This Template changed. Reload before continuing." });
const memberWhere = "i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";
const VERSION_STATE = `SELECT json_array(tv.id,tv.recipe_family_id,tv.name,tv.template_type,tv.template_kind,tv.version,
  tv.manifest_hash,tv.initial_state_hash,tv.source_filename,tv.source_asset_key,tv.source_file_id,tv.content_json,
  tv.created_by,tv.created_at,tv.locked_at,tv.locked_by,tv.archived_at,tv.archived_by,tv.deleted_at,tv.deleted_by,
  tv.metrology_notes) state FROM template_versions tv WHERE tv.id=?`;
// Complete exact scalar decisions of the original remove algorithm, including
// all four actual referencing-owner families. No target body/label is exposed.
const REFERENCES_STATE = `SELECT json_array(recipe_family_id,locked_at,archived_at,deleted_at,referenced) state
  FROM (${TEMPLATE_LIFECYCLE_DELETE_STATE_SQL})`;

/** Pure metadata lifecycle only. Retained family edit grants remain actual
 * grants after a version's own trash/archive; no creator/admin/Sample/byte
 * authority is inferred. Original lifecycle lookup/CAS/disposition messages and
 * own-delete versus independently archived restore decisions are unchanged.
 * The composer retains whole original work before original first physical ACK. */
export function createLocalTemplateLifecycleV28Candidate(options: {
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
  const requests = new WeakMap<TemplateLifecycleRequest, Captured>(), consumed = new WeakSet<TemplateLifecycleRequest>();
  let active = true;
  function selected(request: Request, token: TemplateLifecycleRequest): Captured {
    const owner = requests.get(token);
    if (!active || !owner || owner.request !== request || localAuthenticationIdentityAuthority(authentication) !== auth) throw denied();
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    const facts = issuer.read(request, owner.subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer || facts.subject !== owner.facts.subject
      || auth.currentSessionPredicate(request, owner.actor).tokenHash !== owner.tokenHash) throw denied();
    return owner;
  }
  function checks(owner: Captured) {
    return [
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
  }
  function editCheck(owner: Captured) {
    return { statement: database.prepare(`SELECT 1 admitted FROM template_versions tv JOIN recipe_families rf ON rf.id=tv.recipe_family_id
      JOIN collaboration_resources r ON r.root_kind='template' AND r.root_id=rf.id
      JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id
      JOIN collaboration_identities i ON i.member_id=g.member_id JOIN collaboration_members m ON m.member_id=i.member_id
      WHERE tv.id=? AND rf.archived_at IS NULL AND ${publishedTemplateVersionSql("tv")}
        AND ${memberWhere} AND g.enabled=1 AND g.capability IN('edit','manage') LIMIT 1`)
      .bind(owner.scope.templateId,localIssuer,owner.facts.subject), rejection: denied() };
  }
  async function capture(request: Request, scopeInput: TemplateLifecycleScope): Promise<TemplateLifecycleRequest> {
    // Capture immutable selectors before the first authentication await.
    const { operation, templateId } = scopeInput;
    const scope = Object.freeze({ operation, templateId });
    const method = operation === "rename" ? "PATCH" : operation === "remove" ? "DELETE" : operation === "restore" ? "POST" : undefined;
    const url = new URL(request.url);
    if (!active || !method || request.method !== method || request.bodyUsed || !canonicalIdentityText(templateId,256)
      || url.pathname !== `/api/templates/${encodeURIComponent(templateId)}${operation === "restore" ? "/restore" : ""}`
      || url.search || url.hash) throw denied();
    const tokenHash = auth.captureSessionDigest(request), subject = await issuer.issue(request), facts = issuer.read(request, subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer) throw denied();
    const actor = `local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(request, actor).tokenHash !== tokenHash) throw denied();
    const statement = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true); const row = statement.get(tokenHash, facts.subject); issuer.read(request, subject);
    if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const token = Object.freeze({ kind: "unmounted-current-template-lifecycle-v28/1" as const }) as TemplateLifecycleRequest;
    requests.set(token,Object.freeze({ request,subject,facts,scope,actor,tokenHash,
      credentialRevision:row.credential_revision,sessionCreatedAt:row.created_at })); return token;
  }
  async function perform(request: Request, token: TemplateLifecycleRequest, readInput?: () => Promise<unknown>) {
    const owner = selected(request,token), { operation,templateId } = owner.scope;
    if (consumed.has(token)) throw denied(); consumed.add(token);
    const guard = (snapshot?: Snapshot) => {
      selected(request,token); const guards = [...checks(owner),editCheck(owner)];
      if (snapshot) guards.push(
        { statement:database.prepare(`SELECT 1 admitted WHERE (${VERSION_STATE}) IS ?`).bind(templateId,snapshot.version), rejection:changed() },
        { statement:database.prepare(`SELECT 1 admitted WHERE (${REFERENCES_STATE}) IS ?`).bind(templateId,snapshot.references), rejection:changed() },
      );
      return createSqliteBatchAdmission(database,guards); // Five authority plus two complete decision-state guards.
    };
    const rows = await runSqliteAdmittedBatch(database,[database.prepare(VERSION_STATE).bind(templateId),database.prepare(REFERENCES_STATE).bind(templateId)],guard());
    const state = (index:number) => {
      const result=rows[index];if(result?.results.length!==1 || typeof result.results[0]?.state!=="string") throw changed();
      const value=result.results[0].state;if(Buffer.byteLength(value)>1024*1024) throw new HTTPException(413,{message:"Template state exceeds this candidate's limit"});return value;
    };
    const snapshot:Snapshot=Object.freeze({version:state(0),references:state(1)});
    let mutationAccepted=false;
    const currentAdmission=()=>guard(mutationAccepted?undefined:snapshot);
    const firstSql = operation === "rename" ? TEMPLATE_LIFECYCLE_EDIT_STATE_SQL
      : operation === "remove" ? TEMPLATE_LIFECYCLE_DELETE_STATE_SQL : TEMPLATE_LIFECYCLE_RESTORE_STATE_SQL;
    const mutationSql = operation === "rename" ? TEMPLATE_LIFECYCLE_RENAME_SQL
      : operation === "remove" ? TEMPLATE_LIFECYCLE_REMOVE_SQL : TEMPLATE_LIFECYCLE_RESTORE_SQL;
    const wrap=(native:SqliteStatement,sql:string):TemplateLifecycleStatement=>Object.freeze({
      bind(...values:ReadSqlCell[]){return wrap(native.bind(...values),sql);},
      async first(){
        if(sql!==TEMPLATE_LIFECYCLE_PUBLISHED_SQL && sql!==firstSql) throw denied();
        const result=await runSqliteAdmittedBatch(database,[native],currentAdmission());
        if(result.length!==1 || result[0]!.results.length>1) throw unavailable();
        const row=result[0]!.results[0];return row===undefined?null:configurationSqlRow(row);
      },
      async run(){
        if(mutationAccepted || sql!==mutationSql) throw denied();
        const result=await runSqliteAdmittedBatch(database,[native],currentAdmission());
        if(result.length!==1) throw unavailable();mutationAccepted=true;
        return {changes:configurationSqlInteger(result[0]!.meta.directChanges,"Template lifecycle direct changes",0)};
      },
    });
    const port:TemplateLifecycleDatabase=Object.freeze({prepare(sql:string){
      if(sql!==TEMPLATE_LIFECYCLE_PUBLISHED_SQL && sql!==firstSql && sql!==mutationSql) throw denied();
      return wrap(database.prepare(sql),sql);
    }});
    const service=createTemplateLifecycleService({database:()=>port,now:Date.now,
      async admit(actor:string){if(actor!==owner.actor) throw denied();await runSqliteAdmittedBatch(database,[],currentAdmission());selected(request,token);},
    });
    if(operation==="rename"){
      if(!readInput) throw denied();return service.rename(templateId,readInput,owner.actor);
    }
    return operation==="remove"?service.remove(templateId,owner.actor):service.restore(templateId,owner.actor);
  }
  return Object.freeze({capture,perform,discard(){active=false;}});
}

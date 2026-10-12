import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { createMetrologyWriteService, entryInput, startInput } from "../../worker/execution/metrology-write-service";
import { configurationSqlCell, configurationSqlRow,
  type ConfigurationSqlCell, type ConfigurationSqlDatabase, type ConfigurationSqlStatement } from "../../worker/runtime/configuration-sql";
import { publishedTemplateVersionSql } from "../../worker/template-publication";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement } from "../sqlite";
import { METROLOGY_SAMPLE_STATE_SQL, METROLOGY_TEMPLATE_STATE_SQL,
  METROLOGY_TEMPLATE_MEDIA_FREE_SQL, METROLOGY_ENTRY_SOURCE_SQL } from "./metrology-metadata-source-sql";

declare const metrologyPermissionBrand: unique symbol;
export interface MetrologyMetadataPermissionRequest {
  readonly kind: "unmounted-current-metrology-metadata-permission-v28/1";
  readonly [metrologyPermissionBrand]: true;
}
export type MetrologyMetadataPermissionScope = Readonly<
  { operation: "startRun"; sampleId: string } | { operation: "addEntry"; sampleId: string; runId: string }
>;
type Captured = Readonly<{
  request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>;
  scope: MetrologyMetadataPermissionScope; actor: string; tokenHash: string;
  credentialRevision: bigint; sessionCreatedAt: bigint;
}>;
type Snapshot = Readonly<{ sample: string; template: string }>;
const unavailable = () => new HTTPException(503, { message: "Current Metrology metadata collaboration permissions are unavailable" });
const denied = () => new HTTPException(403, { message: "Current Sample operate and live Metrology family read permission are required" });
const changed = () => new HTTPException(409, { message: "The Sample, Run steps or Metrology template changed. Review the current state again." });
const memberWhere = "i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";

/** Unmounted metadata-only original addEntry/startRun. The future host owns
 * the complete original operation and actual physical writer lease/first ACK. */
export function createLocalMetrologyMetadataPermissionV28Candidate(options: {
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
  const requests = new WeakMap<MetrologyMetadataPermissionRequest, Captured>();
  const consumed = new WeakSet<MetrologyMetadataPermissionRequest>();
  let active = true;
  function selected(request: Request, token: MetrologyMetadataPermissionRequest): Captured {
    const owner = requests.get(token);
    if (!active || !owner || owner.request !== request || localAuthenticationIdentityAuthority(authentication) !== auth) throw denied();
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    const facts = issuer.read(request, owner.subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer || facts.subject !== owner.facts.subject
      || auth.currentSessionPredicate(request, owner.actor).tokenHash !== owner.tokenHash) throw denied();
    return owner;
  }
  function checks(owner: Captured, templateId?: string, snapshot?: Snapshot, accepted = false) {
    const sampleRight = `EXISTS(SELECT 1 FROM samples sample
      JOIN collaboration_resources r ON r.root_kind='sample' AND r.root_id=sample.id
      JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id
      JOIN collaboration_identities i ON i.member_id=g.member_id JOIN collaboration_members m ON m.member_id=i.member_id
      WHERE sample.id=? AND sample.deleted_at IS NULL AND ${memberWhere}
        AND g.enabled=1 AND g.capability IN('operate','edit','manage')
        ${owner.scope.operation === "addEntry" ? "AND EXISTS(SELECT 1 FROM runs actual WHERE actual.id=? AND actual.sample_id=sample.id)" : ""})`;
    const templateRight = `EXISTS(SELECT 1 FROM template_versions tv JOIN recipe_families rf ON rf.id=tv.recipe_family_id
      JOIN collaboration_resources r ON r.root_kind='template' AND r.root_id=rf.id
      JOIN collaboration_identities i ON i.provider='local' AND i.issuer=? AND i.subject=?
      JOIN collaboration_members m ON m.member_id=i.member_id
      WHERE tv.id=? AND tv.template_kind='metrology' AND tv.archived_at IS NULL AND tv.deleted_at IS NULL
        AND rf.archived_at IS NULL AND ${publishedTemplateVersionSql("tv")} AND i.enabled=1 AND m.state='active'
        AND (r.visibility='workspace' OR EXISTS(SELECT 1 FROM collaboration_grants g
          WHERE g.root_kind=r.root_kind AND g.root_id=r.root_id AND g.member_id=i.member_id
            AND g.enabled=1 AND g.capability IN('read','edit','manage'))))`;
    const sampleBindings = [owner.scope.sampleId, localIssuer, owner.facts.subject,
      ...(owner.scope.operation === "addEntry" ? [owner.scope.runId] : [])];
    const permission = database.prepare(`SELECT 1 admitted WHERE ${sampleRight}${templateId === undefined ? "" : ` AND ${templateRight}`}`)
      .bind(...sampleBindings, ...(templateId === undefined ? [] : [localIssuer, owner.facts.subject, templateId]));
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
      { statement: permission, rejection: denied() },
    ];
    if (templateId !== undefined) guards.push({ statement: database.prepare(`SELECT 1 admitted WHERE
      (${METROLOGY_TEMPLATE_MEDIA_FREE_SQL}) IS 1 AND (SELECT count(*) FROM template_steps WHERE template_version_id=?)=1
      ${owner.scope.operation === "addEntry" ? `AND (${METROLOGY_ENTRY_SOURCE_SQL}) IS 1` : ""}`)
      .bind(templateId,templateId,templateId,templateId,templateId,templateId,
        ...(owner.scope.operation === "addEntry" ? [owner.scope.runId,owner.scope.sampleId] : [])), rejection: unavailable() });
    if (snapshot) {
      if (!accepted) guards.push({ statement: database.prepare(`SELECT 1 admitted WHERE (${METROLOGY_SAMPLE_STATE_SQL}) IS ?`)
        .bind(owner.scope.sampleId,snapshot.sample), rejection: changed() });
      guards.push({ statement: database.prepare(`SELECT 1 admitted WHERE (${METROLOGY_TEMPLATE_STATE_SQL}) IS ?`)
        .bind(templateId!,snapshot.template), rejection: changed() });
    }
    return guards; // Five current guards, one eligibility guard, at most two DATA guards: <=8.
  }
  async function capture(request: Request, scopeInput: MetrologyMetadataPermissionScope): Promise<MetrologyMetadataPermissionRequest> {
    const { sampleId, operation } = scopeInput;
    if (!active || (operation !== "addEntry" && operation !== "startRun") || request.method !== "POST" || request.bodyUsed
      || !canonicalIdentityText(sampleId,256)
      || operation === "addEntry" && !canonicalIdentityText(scopeInput.runId,256)) throw denied();
    const scope: MetrologyMetadataPermissionScope = operation === "addEntry"
      ? Object.freeze({sampleId,operation,runId:scopeInput.runId}) : Object.freeze({sampleId,operation});
    const url = new URL(request.url), path = scope.operation === "addEntry"
      ? `/api/samples/${encodeURIComponent(sampleId)}/runs/${encodeURIComponent(scope.runId)}/metrology`
      : `/api/samples/${encodeURIComponent(sampleId)}/metrology-runs`;
    if (url.pathname !== path || [...url.searchParams.keys()].length) throw denied();
    const tokenHash = auth.captureSessionDigest(request), subject = await issuer.issue(request), facts = issuer.read(request,subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer) throw denied();
    const actor = `local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(request,actor).tokenHash !== tokenHash) throw denied();
    const statement = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true); const row = statement.get(tokenHash,facts.subject); issuer.read(request,subject);
    if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const token = Object.freeze({kind:"unmounted-current-metrology-metadata-permission-v28/1" as const}) as MetrologyMetadataPermissionRequest;
    requests.set(token,Object.freeze({request,subject,facts,scope,actor,tokenHash,
      credentialRevision:row.credential_revision,sessionCreatedAt:row.created_at})); return token;
  }
  async function perform(request: Request, token: MetrologyMetadataPermissionRequest, readInput: () => Promise<unknown>) {
    const owner=selected(request,token); if(consumed.has(token))throw denied(); consumed.add(token);
    const selectAdmission=(templateId?:string,snapshot?:Snapshot,accepted=false)=>{
      selected(request,token);return createSqliteBatchAdmission(database,checks(owner,templateId,snapshot,accepted));
    };
    await runSqliteAdmittedBatch(database,[],selectAdmission());
    const raw=await readInput();selected(request,token);
    const input=owner.scope.operation==="addEntry" ? entryInput(raw) : startInput(raw), templateId=input.templateVersionId;
    const observed=await runSqliteAdmittedBatch(database,[database.prepare(METROLOGY_SAMPLE_STATE_SQL).bind(owner.scope.sampleId),
      database.prepare(METROLOGY_TEMPLATE_STATE_SQL).bind(templateId)],selectAdmission(templateId));
    const state=(index:number)=>{
      const row=observed[index];if(row?.results.length!==1 || typeof row.results[0]?.state!=="string")throw changed();
      if(Buffer.byteLength(row.results[0].state)>1024*1024)throw new HTTPException(413,{message:"Metrology source state exceeds this candidate's limit"});
      return row.results[0].state;
    };
    const snapshot=Object.freeze({sample:state(0),template:state(1)});
    const statements=new WeakMap<ConfigurationSqlStatement,SqliteStatement>();let mutationAccepted=false;
    const currentAdmission=()=>selectAdmission(templateId,snapshot,mutationAccepted);
    const wrap=(native:SqliteStatement):ConfigurationSqlStatement=>{
      const statement:ConfigurationSqlStatement=Object.freeze({
        bind(...values:ConfigurationSqlCell[]){return wrap(native.bind(...values.map(configurationSqlCell)));},
        async first(){const result=await runSqliteAdmittedBatch(database,[native],currentAdmission());
          if(result.length!==1 || result[0]!.results.length>1)throw unavailable();
          const row=result[0]!.results[0];return row===undefined ? null : configurationSqlRow(row);},
        async all(){const result=await runSqliteAdmittedBatch(database,[native],currentAdmission());
          if(result.length!==1)throw unavailable();return {results:result[0]!.results.map(configurationSqlRow)};},
      });statements.set(statement,native);return statement;
    };
    const port:ConfigurationSqlDatabase=Object.freeze({
      prepare(sql:string){return wrap(database.prepare(sql));},
      primary(){return port;},
      async batch(items:readonly ConfigurationSqlStatement[]){
        if(mutationAccepted || (owner.scope.operation==="startRun" ? items.length!==4 : items.length!==4 && items.length!==5))throw denied();
        const originals=[...items].map(item=>{const native=statements.get(item);if(!native)throw denied();return native;});
        const results=await runSqliteAdmittedBatch(database,originals,currentAdmission());mutationAccepted=true;
        if(results.length!==originals.length)throw unavailable();return results.map(result=>({directChanges:result.meta.directChanges}));
      },
    });
    const service=createMetrologyWriteService({database:()=>port,
      async admit(actor){if(actor!==owner.actor)throw denied();await runSqliteAdmittedBatch(database,[],currentAdmission());selected(request,token);},
      now:Date.now,randomId:()=>crypto.randomUUID()});
    const result=owner.scope.operation==="addEntry"
      ? await service.addEntry(owner.scope.sampleId,owner.scope.runId,input,owner.actor)
      : await service.startRun(owner.scope.sampleId,input,owner.actor);
    await runSqliteAdmittedBatch(database,[],currentAdmission());selected(request,token);return result;
  }
  return Object.freeze({capture,perform,discard(){active=false;}});
}

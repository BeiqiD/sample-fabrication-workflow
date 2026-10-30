import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { removeRunStepCommentsWithDatabase, restoreRunStepCommentsWithDatabase } from "../../worker/evidence/comment-lifecycle-service";
import type { CommentLifecycleDatabase, CommentLifecycleStatement } from "../../worker/evidence/comment-lifecycle-sql";
import type { ReadSqlCell, ReadSqlRow } from "../../worker/runtime/read-sql";
import { configurationSqlCell, configurationSqlRow } from "../../worker/runtime/configuration-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement } from "../sqlite";

declare const commentLifecyclePermissionBrand: unique symbol;
export interface CommentLifecyclePermissionRequest {
  readonly kind:"unmounted-current-comment-lifecycle-permission-v28/1";
  readonly [commentLifecyclePermissionBrand]:true;
}
export type CommentLifecycleScope = Readonly<{commentId:string;operation:"remove"|"restore"}>;
type Captured=Readonly<{commentId:string;operation:"remove"|"restore";request:Request;subject:LocalRequestSubject;facts:Readonly<RequestSubjectFacts>;
  actor:string;tokenHash:string;credentialRevision:bigint;sessionCreatedAt:bigint}>;
const unavailable=()=>new HTTPException(503,{message:"Current text Comment lifecycle permissions are unavailable"});
const denied=()=>new HTTPException(403,{message:"Current edit permission for every affected Comment target is required"});
const memberWhere="i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";

/** Unmounted COMPLETE mature legacy text Comment remove/restore only. Every
 * actual common operation_group occurrence follows its current Step→Run→Sample;
 * addressed IDs, accepted authors and one permitted target never grant the rest.
 * Text-only source eligibility is separate from parent lifecycle/rights, which
 * stay current in every same-BEGIN read/mutation/ACK. File/escrow remain denied. */
export function createLocalCommentLifecyclePermissionV28Candidate(options:{
  database:SqliteCapability;nativeDatabase:DatabaseSync;admission:ReviewedInstallationAdmission;
  writerLease:LinuxWriterLease;authentication:object;
}) {
  const {database,nativeDatabase,admission,writerLease,authentication}=options;
  const auth=localAuthenticationIdentityAuthority(authentication);
  assertLinuxWriterLeaseBinding(writerLease,database,nativeDatabase);
  const policy=assertInstalledLocalIdentityOwner(auth.identity,database,nativeDatabase,admission);
  const installation=Object.freeze({...assertInstallationAdmission(nativeDatabase,admission)});
  if(installation.checkpointId!=="portable-runtime/v28")throw unavailable();
  const control=nativeDatabase.prepare("SELECT schema_version,enforcement,revision FROM collaboration_control WHERE singleton=1").get();
  if(control?.schema_version!==2 || !["disabled","enabled"].includes(control.enforcement as string)
    || typeof control.revision!=="number" || !Number.isSafeInteger(control.revision) || control.revision<1)throw unavailable();
  const sentinel=nativeDatabase.prepare("SELECT bootstrap_principal_id,initialized_at FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'").get();
  if(typeof sentinel?.bootstrap_principal_id!=="string" || typeof sentinel.initialized_at!=="number"
    || !Number.isSafeInteger(sentinel.initialized_at) || sentinel.initialized_at<0)throw unavailable();
  const bootstrapPrincipalId=sentinel.bootstrap_principal_id,initializedAt=sentinel.initialized_at;
  const localIssuer=`node-installation:${installation.installationId}`;
  const issuer=createLocalRequestSubjectIssuer({database,nativeDatabase,admission,writerLease,authentication});
  const requests=new WeakMap<CommentLifecyclePermissionRequest,Captured>(),consumed=new WeakSet<CommentLifecyclePermissionRequest>();
  let active=true;
  function selected(request:Request,token:CommentLifecyclePermissionRequest):Captured {
    const owner=requests.get(token);
    if(!active || !owner || owner.request!==request || localAuthenticationIdentityAuthority(authentication)!==auth)throw denied();
    assertLinuxWriterLeaseBinding(writerLease,database,nativeDatabase);
    const facts=issuer.read(request,owner.subject);
    if(facts.provider!=="local" || facts.issuer!==localIssuer || facts.subject!==owner.facts.subject
      || auth.currentSessionPredicate(request,owner.actor).tokenHash!==owner.tokenHash)throw denied();
    return owner;
  }
  function actualTargetSql() {
    return `WITH selected AS (
      SELECT id,scope,operation_group_id FROM run_step_comments WHERE id=?
    ), targets AS (
      SELECT c.* FROM run_step_comments c CROSS JOIN selected q
      WHERE c.id=q.id OR(q.operation_group_id IS NOT NULL AND c.operation_group_id=q.operation_group_id)
    ), group_events AS (
      SELECT e.* FROM events e CROSS JOIN selected q
      WHERE q.operation_group_id IS NOT NULL AND e.kind='step' AND json_valid(e.metadata_json)
        AND json_extract(CASE WHEN json_valid(e.metadata_json) THEN e.metadata_json ELSE '{}' END,'$.action')='step_comment'
        AND json_extract(CASE WHEN json_valid(e.metadata_json) THEN e.metadata_json ELSE '{}' END,'$.operationGroupId')=q.operation_group_id
    )`;
  }
  const sourceColumns=["source_kind","id","run_step_id","scope","operation_group_id","submission_id","asset_id","file_id","run_id","sample_id"] as const;
  const sourceReadSql=`SELECT 'comment' AS source_kind,t.id,t.run_step_id,t.scope,t.operation_group_id,t.submission_id,t.asset_id,t.file_id,rs.run_id,r.sample_id
    FROM targets t LEFT JOIN run_steps rs ON rs.id=t.run_step_id LEFT JOIN runs r ON r.id=rs.run_id
    UNION ALL SELECT 'event',e.id,NULL,NULL,json_extract(e.metadata_json,'$.operationGroupId'),NULL,NULL,NULL,NULL,e.sample_id
    FROM group_events e`;
  function checks(owner:Captured,source?:readonly ReadSqlRow[]) {
    const targetSql=actualTargetSql();
    const permissions=database.prepare(`SELECT 1 admitted WHERE EXISTS (${targetSql}
      SELECT 1 WHERE EXISTS(SELECT 1 FROM targets)
      AND NOT EXISTS(SELECT 1 FROM targets target
        LEFT JOIN run_steps rs ON rs.id=target.run_step_id
        LEFT JOIN runs r ON r.id=rs.run_id LEFT JOIN samples s ON s.id=r.sample_id
        WHERE rs.id IS NULL OR rs.deleted_at IS NOT NULL OR r.id IS NULL OR r.deleted_at IS NOT NULL
          OR s.id IS NULL OR s.deleted_at IS NOT NULL OR NOT EXISTS(
            SELECT 1 FROM collaboration_resources resource JOIN collaboration_grants g
              ON g.root_kind=resource.root_kind AND g.root_id=resource.root_id
            JOIN collaboration_identities i ON i.member_id=g.member_id JOIN collaboration_members m ON m.member_id=i.member_id
            WHERE resource.root_kind='sample' AND resource.root_id=s.id AND ${memberWhere}
              AND g.enabled=1 AND g.capability IN('edit','manage')))
      AND NOT EXISTS(SELECT 1 FROM group_events event LEFT JOIN samples s ON s.id=event.sample_id
        WHERE s.id IS NULL OR s.deleted_at IS NOT NULL OR NOT EXISTS(
          SELECT 1 FROM collaboration_resources resource JOIN collaboration_grants g
            ON g.root_kind=resource.root_kind AND g.root_id=resource.root_id
          JOIN collaboration_identities i ON i.member_id=g.member_id JOIN collaboration_members m ON m.member_id=i.member_id
          WHERE resource.root_kind='sample' AND resource.root_id=s.id AND ${memberWhere}
            AND g.enabled=1 AND g.capability IN('edit','manage')))
      )`)
      .bind(owner.commentId,localIssuer,owner.facts.subject,localIssuer,owner.facts.subject);
    const textOnly=database.prepare(`SELECT 1 admitted WHERE EXISTS (${targetSql}
      SELECT 1 WHERE EXISTS(SELECT 1 FROM targets)
      AND NOT EXISTS(SELECT 1 FROM targets target WHERE target.asset_id IS NOT NULL OR target.file_id IS NOT NULL
        OR target.submission_id IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM group_events event WHERE event.asset_key IS NOT NULL
        OR event.asset_file_id IS NOT NULL OR event.thumbnail_file_id IS NOT NULL)
      )` )
      .bind(owner.commentId);
    return [
      {statement:database.prepare(`SELECT 1 admitted FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id
        CROSS JOIN (WITH observed AS MATERIALIZED (SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) now) SELECT now FROM observed) clock
        WHERE s.token_hash=? AND a.principal_id=? AND a.enabled=1 AND s.credential_revision=a.credential_revision
          AND a.credential_revision=? AND s.created_at=? AND s.revoked_at IS NULL
          AND typeof(clock.now)='integer' AND clock.now BETWEEN 0 AND 9007199254740991
          AND clock.now>=s.last_seen_at AND clock.now<s.absolute_expires_at AND clock.now<s.last_seen_at+? LIMIT 1`)
        .bind(owner.tokenHash,owner.facts.subject,owner.credentialRevision,owner.sessionCreatedAt,policy.idleLifetimeMs),
        rejection:new HTTPException(401,{message:"Current local authentication is required"})},
      {statement:database.prepare(`SELECT 1 admitted WHERE
        EXISTS(SELECT 1 FROM node_installation WHERE singleton=1 AND installation_id=? AND catalog_id=? AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)
        AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1' AND bootstrap_principal_id=? AND initialized_at=?)
        AND EXISTS(SELECT 1 FROM collaboration_control WHERE singleton=1 AND schema_version=2 AND enforcement='enabled')`)
        .bind(installation.installationId,installation.catalogId,installation.checkpointId,installation.schemaSha256,installation.createdAt,bootstrapPrincipalId,initializedAt),rejection:unavailable()},
      {statement:database.prepare(`SELECT 1 admitted FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id WHERE ${memberWhere} LIMIT 1`)
        .bind(localIssuer,owner.facts.subject),rejection:denied()},
      {statement:database.prepare(`SELECT 1 admitted FROM system_recovery_maintenance WHERE singleton=1 AND state='open'
        AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
        AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='legacy')`),rejection:unavailable()},
      {statement:permissions,rejection:denied()},
      {statement:textOnly,rejection:unavailable()},
      ...(source===undefined?[]:[{statement:database.prepare(`SELECT 1 admitted WHERE EXISTS (${targetSql},
        actual(${sourceColumns.join(",")}) AS (${sourceReadSql}),
        expected(${sourceColumns.join(",")}) AS (VALUES ${source.map(()=>"("+sourceColumns.map(()=>"?").join(",")+")").join(",")})
        SELECT 1 WHERE
          NOT EXISTS(SELECT 1 FROM actual a WHERE NOT EXISTS(SELECT 1 FROM expected e WHERE ${sourceColumns.map(column=>`a.${column} IS e.${column}`).join(" AND ")}))
          AND NOT EXISTS(SELECT 1 FROM expected e WHERE NOT EXISTS(SELECT 1 FROM actual a WHERE ${sourceColumns.map(column=>`a.${column} IS e.${column}`).join(" AND ")}))
      )`)
        .bind(owner.commentId,...source.flatMap(row=>sourceColumns.map(column=>configurationSqlCell(row[column])))),
        rejection:new HTTPException(409,{message:"The Comment target group changed. Reload before continuing."})}]),
    ];
  }
  async function capture(request:Request,scope:CommentLifecycleScope):Promise<CommentLifecyclePermissionRequest> {
    const {commentId,operation}=scope;
    if(!active || !canonicalIdentityText(commentId,256) || !["remove","restore"].includes(operation)
      || request.method!==(operation==="remove"?"DELETE":"POST") || request.bodyUsed)throw denied();
    const url=new URL(request.url),path=`/api/run-step-comments/${encodeURIComponent(commentId)}${operation==="restore"?"/restore":""}`;
    if(url.pathname!==path || [...url.searchParams.keys()].length)throw denied();
    const tokenHash=auth.captureSessionDigest(request),subject=await issuer.issue(request),facts=issuer.read(request,subject);
    if(facts.provider!=="local" || facts.issuer!==localIssuer)throw denied();
    const actor=`local-account:${facts.subject}`;if(auth.currentSessionPredicate(request,actor).tokenHash!==tokenHash)throw denied();
    const statement=nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true);const row=statement.get(tokenHash,facts.subject);issuer.read(request,subject);
    if(typeof row?.credential_revision!=="bigint" || typeof row.created_at!=="bigint")throw denied();
    const token=Object.freeze({kind:"unmounted-current-comment-lifecycle-permission-v28/1" as const}) as CommentLifecyclePermissionRequest;
    requests.set(token,Object.freeze({commentId,operation,request,subject,facts,actor,tokenHash,credentialRevision:row.credential_revision,sessionCreatedAt:row.created_at}));return token;
  }
  async function perform(request:Request,token:CommentLifecyclePermissionRequest) {
    const owner=selected(request,token);if(consumed.has(token))throw denied();consumed.add(token);
    let source:readonly ReadSqlRow[]|undefined;
    const admit=()=>{selected(request,token);return createSqliteBatchAdmission(database,checks(owner,source));};
    // Current actual identity/topology snapshot, captured in the SAME guarded
    // transaction. No body/key content and no permissions/authority are cached.
    // This prevents a competing group shrink/reparent from authorizing only a
    // subset while original statements still name the previous full target set.
    const result=await runSqliteAdmittedBatch(database,[database.prepare(`${actualTargetSql()}
      ${sourceReadSql} ORDER BY source_kind,id`).bind(owner.commentId)],admit());
    if(result.length!==1 || !result[0]!.results.length)throw denied();
    source=Object.freeze(result[0]!.results.map(row=>Object.freeze(configurationSqlRow(row))));
    const statements=new WeakMap<CommentLifecycleStatement,SqliteStatement>();let accepted=false;
    const wrap=(native:SqliteStatement):CommentLifecycleStatement=>{
      const statement:CommentLifecycleStatement=Object.freeze({
        bind(...values:ReadSqlCell[]){return wrap(native.bind(...values.map(configurationSqlCell)));},
        async first<T extends object=ReadSqlRow>(){const result=await runSqliteAdmittedBatch(database,[native],admit());
          if(result.length!==1 || result[0]!.results.length>1)throw unavailable();const row=result[0]!.results[0];return row===undefined?null:configurationSqlRow(row) as T;},
        async all<T extends object=ReadSqlRow>(){const result=await runSqliteAdmittedBatch(database,[native],admit());
          if(result.length!==1)throw unavailable();return {results:result[0]!.results.map(row=>configurationSqlRow(row) as T)};},
      });statements.set(statement,native);return statement;
    };
    const port:CommentLifecycleDatabase=Object.freeze({prepare(sql:string){return wrap(database.prepare(sql));},
      async atomicBatch(items:readonly CommentLifecycleStatement[]){
        if(accepted || !items.length || items.length>49)throw denied();
        const originals=[...items].map(item=>{const native=statements.get(item);if(!native)throw denied();return native;});
        const result=await runSqliteAdmittedBatch(database,originals,admit());accepted=true;
        if(result.length!==originals.length)throw unavailable();return result.map(row=>({results:row.results}));
      },
    });
    const capabilities={database:()=>port,
      async admit(actor:string){if(actor!==owner.actor)throw denied();await runSqliteAdmittedBatch(database,[],admit());selected(request,token);},
      now:Date.now,randomId:()=>crypto.randomUUID(),
      async deletedEventAssetSql(){await runSqliteAdmittedBatch(database,[],admit());return "NULL" as const;},
      async prepareFileRestoration(kind:"legacy_comment",ids:string[]){
        if(kind!=="legacy_comment" || !ids.length)throw unavailable();
        await runSqliteAdmittedBatch(database,[],admit());
        // Actual current Filelegacy makes the original routine return no fences.
        // The separate textOnly guard proves no media occurrences. No File
        // restoration grant or replacement publication is issued here.
        return [] as CommentLifecycleStatement[];
      },
    };
    const value=owner.operation==="remove"
      ? await removeRunStepCommentsWithDatabase(capabilities,owner.commentId,owner.actor)
      : await restoreRunStepCommentsWithDatabase(capabilities,owner.commentId,owner.actor);
    await runSqliteAdmittedBatch(database,[],admit());selected(request,token);return value;
  }
  return Object.freeze({capture,perform,discard(){active=false;}});
}

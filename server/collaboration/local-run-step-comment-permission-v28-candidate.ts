import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import type { RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { captureRunStepCommentInput, createRunStepCommentsWithDatabase, type CapturedRunStepCommentInput } from "../../worker/evidence/comment-creation-service";
import type { RunStepCommentDatabase, RunStepCommentStatement } from "../../worker/evidence/comment-creation-sql";
import type { ReadSqlCell } from "../../worker/runtime/read-sql";
import { configurationSqlCell, configurationSqlRow } from "../../worker/runtime/configuration-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement } from "../sqlite";

declare const commentPermissionBrand: unique symbol;
export interface RunStepCommentPermissionRequest {
  readonly kind:"unmounted-current-run-step-comment-permission-v28/1";
  readonly [commentPermissionBrand]:true;
}
type Captured=Readonly<{request:Request;subject:LocalRequestSubject;facts:Readonly<RequestSubjectFacts>;
  actor:string;tokenHash:string;credentialRevision:bigint;sessionCreatedAt:bigint}>;
const unavailable=()=>new HTTPException(503,{message:"Current text Comment collaboration permissions are unavailable"});
const denied=()=>new HTTPException(403,{message:"Current operate permission for every Comment target is required"});
const memberWhere="i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";

/** Unmounted text-only common/individual creation. Every actual target follows
 * its Step→Run→Sample root; neither one readable occurrence nor the first target
 * authorizes other roots. File/escrow/canonical submission and lifecycle remain unavailable. */
export function createLocalRunStepCommentPermissionV28Candidate(options:{
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
  const requests=new WeakMap<RunStepCommentPermissionRequest,Captured>(),consumed=new WeakSet<RunStepCommentPermissionRequest>();
  let active=true;
  function selected(request:Request,token:RunStepCommentPermissionRequest):Captured {
    const owner=requests.get(token);
    if(!active || !owner || owner.request!==request || localAuthenticationIdentityAuthority(authentication)!==auth)throw denied();
    assertLinuxWriterLeaseBinding(writerLease,database,nativeDatabase);
    const facts=issuer.read(request,owner.subject);
    if(facts.provider!=="local" || facts.issuer!==localIssuer || facts.subject!==owner.facts.subject
      || auth.currentSessionPredicate(request,owner.actor).tokenHash!==owner.tokenHash)throw denied();
    return owner;
  }
  function checks(owner:Captured,input?:CapturedRunStepCommentInput) {
    // Body IDs select candidates only. All actual joins and positive capabilities
    // are reevaluated inside this same native BEGIN, before original SQL/ACK.
    const permissions=input===undefined ? database.prepare("SELECT 1 admitted")
      :database.prepare(`SELECT 1 admitted WHERE EXISTS (WITH requested(sample_id,run_id,step_id) AS (VALUES ${input.targets.map(()=>"(?,?,?)").join(",")})
        SELECT 1 WHERE EXISTS(SELECT 1 FROM requested)
        AND NOT EXISTS(SELECT 1 FROM requested q
          LEFT JOIN runs r ON r.id=q.run_id AND r.sample_id=q.sample_id
          LEFT JOIN run_steps rs ON rs.id=q.step_id AND rs.run_id=q.run_id
          LEFT JOIN samples s ON s.id=q.sample_id
          WHERE r.id IS NULL OR r.deleted_at IS NOT NULL OR rs.id IS NULL OR rs.deleted_at IS NOT NULL
            OR s.id IS NULL OR s.deleted_at IS NOT NULL OR NOT EXISTS(
              SELECT 1 FROM collaboration_resources resource JOIN collaboration_grants g
                ON g.root_kind=resource.root_kind AND g.root_id=resource.root_id
              JOIN collaboration_identities i ON i.member_id=g.member_id JOIN collaboration_members m ON m.member_id=i.member_id
              WHERE resource.root_kind='sample' AND resource.root_id=s.id AND ${memberWhere}
                AND g.enabled=1 AND g.capability IN('operate','edit','manage')))
      )`)
        .bind(...input.targets.flatMap(target=>[target.sampleId,target.runId,target.stepId]),localIssuer,owner.facts.subject);
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
    ];
  }
  async function capture(request:Request):Promise<RunStepCommentPermissionRequest> {
    if(!active || request.method!=="POST" || request.bodyUsed)throw denied();
    const url=new URL(request.url);if(url.pathname!=="/api/run-step-comments" || [...url.searchParams.keys()].length)throw denied();
    const tokenHash=auth.captureSessionDigest(request),subject=await issuer.issue(request),facts=issuer.read(request,subject);
    if(facts.provider!=="local" || facts.issuer!==localIssuer)throw denied();
    const actor=`local-account:${facts.subject}`;if(auth.currentSessionPredicate(request,actor).tokenHash!==tokenHash)throw denied();
    const statement=nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true);const row=statement.get(tokenHash,facts.subject);issuer.read(request,subject);
    if(typeof row?.credential_revision!=="bigint" || typeof row.created_at!=="bigint")throw denied();
    const token=Object.freeze({kind:"unmounted-current-run-step-comment-permission-v28/1" as const}) as RunStepCommentPermissionRequest;
    requests.set(token,Object.freeze({request,subject,facts,actor,tokenHash,credentialRevision:row.credential_revision,sessionCreatedAt:row.created_at}));return token;
  }
  async function perform(request:Request,token:RunStepCommentPermissionRequest,readInput:()=>Promise<unknown>) {
    const owner=selected(request,token);if(consumed.has(token))throw denied();consumed.add(token);
    const admit=(input?:CapturedRunStepCommentInput)=>{selected(request,token);return createSqliteBatchAdmission(database,checks(owner,input));};
    await runSqliteAdmittedBatch(database,[],admit());
    const raw=await readInput();selected(request,token);const input=captureRunStepCommentInput(raw);
    // Preserve original validation, then deny media without metadata/provider reads.
    if(input.assetKey?.trim())throw unavailable();
    await runSqliteAdmittedBatch(database,[],admit(input));
    const statements=new WeakMap<RunStepCommentStatement,SqliteStatement>();let accepted=false;
    const wrap=(native:SqliteStatement):RunStepCommentStatement=>{
      const statement:RunStepCommentStatement=Object.freeze({
        bind(...values:ReadSqlCell[]){return wrap(native.bind(...values.map(configurationSqlCell)));},
        async first(){const result=await runSqliteAdmittedBatch(database,[native],admit(input));
          if(result.length!==1 || result[0]!.results.length>1)throw unavailable();const row=result[0]!.results[0];return row===undefined?null:configurationSqlRow(row);},
        async all(){const result=await runSqliteAdmittedBatch(database,[native],admit(input));
          if(result.length!==1)throw unavailable();return {results:result[0]!.results.map(configurationSqlRow)};},
      });statements.set(statement,native);return statement;
    };
    const port:RunStepCommentDatabase=Object.freeze({prepare(sql:string){return wrap(database.prepare(sql));},
      async atomicBatch(items:readonly RunStepCommentStatement[]){
        if(accepted || !items.length || items.length>49)throw denied();
        const originals=[...items].map(item=>{const native=statements.get(item);if(!native)throw denied();return native;});
        const result=await runSqliteAdmittedBatch(database,originals,admit(input));accepted=true;
        if(result.length!==originals.length)throw unavailable();return result.map(row=>({results:row.results}));
      },
    });
    const value=await createRunStepCommentsWithDatabase({database:()=>port,
      async admit(actor:string){if(actor!==owner.actor)throw denied();await runSqliteAdmittedBatch(database,[],admit(input));selected(request,token);},
      now:Date.now,randomId:()=>crypto.randomUUID(),async fileAuthorityActiveSql(){throw unavailable();},
      async resolveConsumerFileId(){throw unavailable();},consumerFileBindingFence(){throw unavailable();},
    },input,owner.actor);
    await runSqliteAdmittedBatch(database,[],admit(input));selected(request,token);return value;
  }
  return Object.freeze({capture,perform,discard(){active=false;}});
}

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { createSampleMetadataService } from "../../worker/samples/metadata-service";
import { configurationSqlInteger, configurationSqlMutation, configurationSqlRow,
  type ConfigurationSqlDatabase, type ConfigurationSqlStatement } from "../../worker/runtime/configuration-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteCapability, type SqliteStatement } from "../sqlite";
import { ownedLocalVolumeProfileContextV28Candidate, type LocalVolumeProfileOpeningV28Candidate } from "../storage/local-volume-profile-opening-v28-candidate";

declare const brand:unique symbol;
export interface ActiveFileEmptySampleCreateRequest {readonly [brand]:true}
type Captured=Readonly<{request:Request;url:string;subject:LocalRequestSubject;facts:Readonly<RequestSubjectFacts>;
  actor:string;tokenHash:string;createdAt:bigint;credentialRevision:bigint}>;
const memberWhere="i.provider=? AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";
const unavailable=()=>new HTTPException(503,{message:"Current active File Sample creation is unavailable"});
const denied=()=>new HTTPException(403,{message:"Current Sample creation permission is required"});

/** Separate opt-in owner for the original empty-Sample DTO and four creation
 * statements. No selected Template/state/File exists in that original body:
 * its media fences belong to subsequent actual preview/RunStart. The genuine
 * opening identifies this Native/core/lease and captured active incarnation;
 * no profile/body/provider permission or caller flag is accepted or issued. */
export function createLocalActiveFileEmptySampleCreatePermissionV28Candidate(options:{
  database:SqliteCapability;nativeDatabase:DatabaseSync;admission:ReviewedInstallationAdmission;
  writerLease:LinuxWriterLease;authentication:object;opening:LocalVolumeProfileOpeningV28Candidate;
}){
  if(Object.keys(options).sort().join(',')!=='admission,authentication,database,nativeDatabase,opening,writerLease')throw unavailable();
  const {database,nativeDatabase,admission,writerLease,authentication,opening}=options;
  const physical=ownedLocalVolumeProfileContextV28Candidate(opening);physical.assertCurrent();
  if(physical.database!==database || physical.nativeDatabase!==nativeDatabase || physical.writerLease!==writerLease)throw unavailable();
  const auth=localAuthenticationIdentityAuthority(authentication);
  assertLinuxWriterLeaseBinding(writerLease,database,nativeDatabase);
  const policy=assertInstalledLocalIdentityOwner(auth.identity,database,nativeDatabase,admission);
  const installation=Object.freeze({...assertInstallationAdmission(nativeDatabase,admission)});
  if(installation.checkpointId!=="portable-runtime/v28" || physical.installationId!==installation.installationId
    || physical.installationCheckpointId!==installation.checkpointId)throw unavailable();
  const control=nativeDatabase.prepare("SELECT schema_version,enforcement,revision FROM collaboration_control WHERE singleton=1").get();
  if(control?.schema_version!==2 || !["disabled","enabled"].includes(control.enforcement as string)
    || typeof control.revision!=="number" || !Number.isSafeInteger(control.revision) || control.revision<1)throw unavailable();
  const sentinel=nativeDatabase.prepare("SELECT bootstrap_principal_id,initialized_at FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'").get();
  if(typeof sentinel?.bootstrap_principal_id!=="string" || typeof sentinel.initialized_at!=="number"
    || !Number.isSafeInteger(sentinel.initialized_at) || sentinel.initialized_at<0)throw unavailable();
  const bootstrapPrincipalId=sentinel.bootstrap_principal_id,initializedAt=sentinel.initialized_at;
  const runtime=nativeDatabase.prepare(`SELECT g.incarnation FROM file_authority_control a JOIN file_authority_runtime_guard g
    ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active'`).get();
  if(typeof runtime?.incarnation!=="string" || !runtime.incarnation)throw unavailable();
  const incarnation=runtime.incarnation,localIssuer=`node-installation:${installation.installationId}`;
  const issuer=createLocalRequestSubjectIssuer({database,nativeDatabase,admission,writerLease,authentication});
  const requests=new WeakMap<ActiveFileEmptySampleCreateRequest,Captured>();
  const created=new WeakMap<ActiveFileEmptySampleCreateRequest,Promise<{id:string}>>();
  const pending=new Set<Promise<unknown>>();let accepting=true,active=true,closing:Promise<void>|undefined;
  function selected(request:Request,token:ActiveFileEmptySampleCreateRequest):Captured{
    const owner=requests.get(token);
    if(!active || !owner || owner.request!==request || request.url!==owner.url || request.method!=="POST"
      || localAuthenticationIdentityAuthority(authentication)!==auth)throw denied();
    physical.assertCurrent();assertLinuxWriterLeaseBinding(writerLease,database,nativeDatabase);
    const facts=issuer.read(request,owner.subject);
    if(facts.provider!==owner.facts.provider || facts.issuer!==owner.facts.issuer || facts.subject!==owner.facts.subject
      || auth.currentSessionPredicate(request,owner.actor).tokenHash!==owner.tokenHash)throw denied();
    return owner;
  }
  function guards(owner:Captured){
    physical.assertCurrent();assertLinuxWriterLeaseBinding(writerLease,database,nativeDatabase);
    const {provider,issuer:verifiedIssuer,subject}=owner.facts;
    const authenticationCheck=database.prepare(`SELECT 1 admitted FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id
      CROSS JOIN (WITH observed AS MATERIALIZED (SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) now) SELECT now FROM observed) clock
      WHERE s.token_hash=? AND a.principal_id=? AND a.enabled=1 AND s.credential_revision=a.credential_revision
        AND a.credential_revision=? AND s.created_at=? AND s.revoked_at IS NULL
        AND typeof(clock.now)='integer' AND clock.now BETWEEN 0 AND 9007199254740991
        AND clock.now>=s.last_seen_at AND clock.now<s.absolute_expires_at AND clock.now<s.last_seen_at+? LIMIT 1`)
      .bind(owner.tokenHash,subject,owner.credentialRevision,owner.createdAt,policy.idleLifetimeMs);
    const installed=database.prepare(`SELECT 1 admitted WHERE
      EXISTS(SELECT 1 FROM node_installation WHERE singleton=1 AND installation_id=? AND catalog_id=?
        AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)
      AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'
        AND bootstrap_principal_id=? AND initialized_at=?)`)
      .bind(installation.installationId,installation.catalogId,installation.checkpointId,installation.schemaSha256,
        installation.createdAt,bootstrapPrincipalId,initializedAt);
    const enabled=database.prepare("SELECT 1 admitted FROM collaboration_control WHERE singleton=1 AND schema_version=? AND enforcement='enabled'").bind(2);
    const membership=database.prepare(`SELECT 1 admitted FROM collaboration_identities i
      JOIN collaboration_members m ON m.member_id=i.member_id WHERE ${memberWhere}
        AND m.can_create_samples=1 LIMIT 1`).bind(provider,verifiedIssuer,subject);
    const activation=database.prepare(`SELECT 1 admitted FROM system_recovery_maintenance m
      WHERE m.singleton=1 AND m.state='open'
        AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
        AND EXISTS(SELECT 1 FROM file_authority_control a JOIN file_authority_runtime_guard g
          ON g.singleton=a.singleton AND g.enabled=1 WHERE a.singleton=1 AND a.mode='active' AND g.incarnation=?)`).bind(incarnation);
    return createSqliteBatchAdmission(database,[
      {statement:authenticationCheck,rejection:new HTTPException(401,{message:"Current local authentication is required"})},
      {statement:installed,rejection:unavailable()},{statement:enabled,rejection:unavailable()},
      {statement:membership,rejection:denied()},{statement:activation,rejection:unavailable()},
    ]); // Five genuine raising admission checks in each original BEGIN; no ordinary no-row prefix.
  }
  function track<T>(original:Promise<T>):Promise<T>{
    pending.add(original);void original.then(()=>pending.delete(original),()=>pending.delete(original));return original;
  }
  function capture(request:Request):Promise<ActiveFileEmptySampleCreateRequest>{
    if(!accepting || !(request instanceof Request) || request.method!=="POST" || request.bodyUsed || request.body?.locked)throw denied();
    const url=new URL(request.url);
    if(url.pathname!=="/api/samples")throw denied();
    const capturedUrl=request.url,tokenHash=auth.captureSessionDigest(request);
    return track(Promise.resolve().then(async()=>{
      const subject=await issuer.issue(request),facts=issuer.read(request,subject);
      if(facts.provider!=="local" || facts.issuer!==localIssuer)throw denied();
      const actor=`local-account:${facts.subject}`;
      if(auth.currentSessionPredicate(request,actor).tokenHash!==tokenHash)throw denied();
      const statement=nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
      statement.setReadBigInts(true);const row=statement.get(tokenHash,facts.subject);issuer.read(request,subject);
      if(typeof row?.credential_revision!=="bigint" || typeof row.created_at!=="bigint")throw denied();
      if(request.url!==capturedUrl || request.method!=="POST" || request.bodyUsed || request.body?.locked)throw denied();
      const owner:Captured=Object.freeze({request,url:capturedUrl,subject,facts,actor,tokenHash,
        credentialRevision:row.credential_revision,createdAt:row.created_at});
      await runSqliteAdmittedBatch(database,[],guards(owner));issuer.read(request,subject);
      const token=Object.freeze({})as ActiveFileEmptySampleCreateRequest;requests.set(token,owner);return token;
    }));
  }
  function create(request:Request,token:ActiveFileEmptySampleCreateRequest,value:unknown):Promise<{id:string}>{
    if(closing)throw denied();
    const owner=selected(request,token),previous=created.get(token);if(previous)return previous;
    const original=Promise.resolve().then(async()=>{
      const statements=new WeakMap<ConfigurationSqlStatement,{native:SqliteStatement;mutation:boolean}>();
      const guard=()=>{selected(request,token);return guards(owner);};
      const wrap=(native:SqliteStatement,mutation:boolean):ConfigurationSqlStatement=>{
        const statement:ConfigurationSqlStatement=Object.freeze({
          bind(...values:unknown[]){return wrap(native.bind(...values),mutation);},
          async first(){if(mutation)throw denied();const rows=(await runSqliteAdmittedBatch(database,[native],guard()))[0]!.results;
            return rows[0]===undefined?null:configurationSqlRow(rows[0]);},
          async all(){if(mutation)throw denied();return {results:(await runSqliteAdmittedBatch(database,[native],guard()))[0]!.results.map(configurationSqlRow)};},
        });statements.set(statement,{native,mutation});return statement;
      };
      const originals=(items:readonly ConfigurationSqlStatement[])=>items.map(item=>{
        const actual=statements.get(item);if(!actual || !actual.mutation)throw denied();return actual.native;
      });
      const db:ConfigurationSqlDatabase=Object.freeze({
        prepare(sql:string){return wrap(database.prepare(sql),configurationSqlMutation(sql));},
        async batch(items:readonly ConfigurationSqlStatement[]){
          const results=await runSqliteAdmittedBatch(database,originals(items),guard());
          return results.map(result=>({directChanges:configurationSqlInteger(result.meta.directChanges,"Sample direct changes")}));
        },primary(){selected(request,token);return db;},
      });
      const admit=async(actor:string)=>{if(actor!==owner.actor)throw denied();await runSqliteAdmittedBatch(database,[],guard());selected(request,token);};
      const service=createSampleMetadataService({database:()=>db,admit,now:Date.now,randomId:randomUUID,
        async commitCreation(createdId:string,items:readonly ConfigurationSqlStatement[]){
          if(!canonicalIdentityText(createdId,256) || items.length!==2)throw denied();
          const root=database.prepare("INSERT INTO collaboration_resources(root_kind,root_id,visibility,revision) VALUES('sample',?,'restricted',1)").bind(createdId);
          const manager=database.prepare(`INSERT INTO collaboration_grants(root_kind,root_id,member_id,capability,enabled,revision)
          VALUES('sample',?,(SELECT m.member_id FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id
            WHERE ${memberWhere} AND m.can_create_samples=1),'manage',1,1)`)
            .bind(createdId,owner.facts.provider,owner.facts.issuer,owner.facts.subject);
          await runSqliteAdmittedBatch(database,[...originals(items),root,manager],guard());
        },
      });
      const accepted=await service.create(value,owner.actor);await admit(owner.actor);return accepted;
    });created.set(token,original);return track(original);
  }
  return Object.freeze({capture,create,
    close():Promise<void>{
      if(closing)return closing;accepting=false;
      closing=Promise.resolve().then(async()=>{await Promise.allSettled([...pending]);active=false;});
      void closing.catch(()=>undefined);return closing;
    },
  });
}

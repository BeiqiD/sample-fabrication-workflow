import type { DatabaseSync } from "node:sqlite";
import { StorageProfileCleanupError } from "../../worker/files/storage-profile-opening";
import { assertLocalCommentSampleAttachmentReadPortV28Candidate, probeLocalCommentSampleAttachmentV28Candidate,
  createLocalCommentSampleAttachmentFinalAdmissionV28Candidate, MAX_LOCAL_COMMENT_SAMPLE_ATTACHMENT_PROOFS_V28_CANDIDATE,
  type LocalCommentSampleAttachmentReadPortV28Candidate, type LocalCommentSampleAttachmentProofV28Candidate } from "../files/local-comment-read-v28-candidate";
import { HTTPException } from "hono/http-exception";
import { canonicalIdentityText, type RequestSubjectFacts } from "../../shared/contracts/request-subject";
import { createSampleReadService, type SampleDetailProjection, type SampleReadQuery } from "../../worker/samples/read-service";
import type { ReadSqlCell, ReadSqlDatabase, ReadSqlStatement } from "../../worker/runtime/read-sql";
import { configurationSqlRow } from "../../worker/runtime/configuration-sql";
import { assertInstalledLocalIdentityOwner } from "../auth/identity";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, joinSqliteBatchAdmissions, runSqliteAdmittedBatch, type SqliteCapability, type SqliteRow, type SqliteStatement } from "../sqlite";
import { originalSampleDetailSql, sampleDetailFilteredSql, sampleProcessingMetadataSql } from "./sample-detail-filtered-read-sql";

declare const sampleReadRequestBrand: unique symbol;
export interface SampleProjectedDetailReadV28Request {
  readonly kind: "current-sample-metadata-read-v28/1";
  readonly [sampleReadRequestBrand]: true;
}
type Scope = Readonly<{ operation: "detail"; sampleId: string } | { operation: "processing"; sampleId?: never }>;
type Captured = Readonly<{ request: Request; subject: LocalRequestSubject; facts: Readonly<RequestSubjectFacts>; scope: Scope;
  actor: string; tokenHash: string; credentialRevision: bigint; createdAt: bigint; processingView: boolean }>;
const unavailable = () => new HTTPException(503, { message: "Current Sample metadata read is unavailable" });
const denied = () => new HTTPException(403, { message: "Current Sample read permission is required" });
const changed = () => new HTTPException(409, { message: "Sample detail sources changed. Reload before continuing." });
const memberWhere = "i.provider=? AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";
const PROJECTIONS: readonly SampleDetailProjection[] = Object.freeze(["overview","children","events","runs","step_assets","initial_assets",
  "step_comments","verifications","verification_steps","submissions","submission_items","submission_targets"]);
const SCHEMA_SQL = "\n    SELECT\n      (SELECT COUNT(*) FROM sqlite_schema\n       WHERE type = 'table' AND name = 'file_authority_control') AS authority_tables,\n      (SELECT COUNT(*) FROM pragma_table_info('run_step_assets') WHERE name = 'file_id')\n        + (SELECT COUNT(*) FROM pragma_table_info('state_representation_assets') WHERE name = 'file_id')\n        + (SELECT COUNT(*) FROM pragma_table_info('run_step_comments') WHERE name = 'file_id')\n        + (SELECT COUNT(*) FROM pragma_table_info('events') WHERE name IN ('asset_file_id', 'thumbnail_file_id')) AS file_columns\n  ";
function equalRows(left: readonly SqliteRow[],right: readonly SqliteRow[]): boolean {
  return left.length === right.length && left.every((row,index) => {
    const other=right[index]!,keys=Object.keys(row).sort();
    return keys.join("\0")===Object.keys(other).sort().join("\0") && keys.every(key => {
      const a=row[key],b=other[key];return a instanceof Uint8Array ? b instanceof Uint8Array
        && a.length===b.length && a.every((cell,n)=>cell===b[n]) : Object.is(a,b);
    });
  });
}
function cleanupUnproven(error:unknown,seen=new Set<unknown>()):boolean {
  if(error instanceof StorageProfileCleanupError) return true;
  if(!error || typeof error!=="object" || seen.has(error)) return false;
  seen.add(error);
  if(error instanceof AggregateError && error.errors.some(cause=>cleanupUnproven(cause,seen))) return true;
  return "cause" in error && cleanupUnproven(error.cause,seen);
}
/** One genuine Request-bound reader. Metadata remains safe in either File mode;
 * plain Sample GET may additionally select an actual opaque attachment port.
 * All twelve original detail
 * projections use one native BEGIN and a complete fresh comparison before ACK.
 * Parent/child, current Template and canonical all-root Comment predicates run
 * before source row aggregation/order/limits. An issued original-Request File
 * attachment probe must finish its own availability/disposal/current checks
 * before any admitted item can reach the neutral serializer. Query/processing,
 * images and all other media keep their original null/empty projection. The
 * enclosing composer owns original work until drain, then discards this issuer. */
export function createLocalSampleProjectedDetailReadV28Candidate(options: {
  database: SqliteCapability; nativeDatabase: DatabaseSync; admission: ReviewedInstallationAdmission;
  writerLease: LinuxWriterLease; authentication: object;
  sampleCanonicalAttachmentReadPort?:LocalCommentSampleAttachmentReadPortV28Candidate;
}) {
  const { database,nativeDatabase,admission,writerLease,authentication }=options;
  const attachmentPort=options.sampleCanonicalAttachmentReadPort;
  const attachmentBindings=Object.freeze({database,nativeDatabase,admission,writerLease,authentication});
  if(attachmentPort) assertLocalCommentSampleAttachmentReadPortV28Candidate(attachmentPort,attachmentBindings);
  const auth=localAuthenticationIdentityAuthority(authentication);
  assertLinuxWriterLeaseBinding(writerLease,database,nativeDatabase);
  const policy=assertInstalledLocalIdentityOwner(auth.identity,database,nativeDatabase,admission);
  const installation=Object.freeze({...assertInstallationAdmission(nativeDatabase,admission)});
  if(installation.checkpointId!=="portable-runtime/v28") throw unavailable();
  const control=nativeDatabase.prepare("SELECT schema_version,enforcement,revision FROM collaboration_control WHERE singleton=1").get();
  if(control?.schema_version!==2 || !["disabled","enabled"].includes(control.enforcement as string)
    || typeof control.revision!=="number" || !Number.isSafeInteger(control.revision) || control.revision<1) throw unavailable();
  const sentinel=nativeDatabase.prepare("SELECT bootstrap_principal_id,initialized_at FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'").get();
  if(typeof sentinel?.bootstrap_principal_id!=="string" || typeof sentinel.initialized_at!=="number"
    || !Number.isSafeInteger(sentinel.initialized_at) || sentinel.initialized_at<0) throw unavailable();
  const bootstrapPrincipalId=sentinel.bootstrap_principal_id,initializedAt=sentinel.initialized_at;
  const localIssuer=`node-installation:${installation.installationId}`;
  const issuer=createLocalRequestSubjectIssuer({database,nativeDatabase,admission,writerLease,authentication});
  const requests=new WeakMap<SampleProjectedDetailReadV28Request,Captured>(),consumed=new WeakSet<SampleProjectedDetailReadV28Request>();
  let active=true;
  function selected(request: Request,token: SampleProjectedDetailReadV28Request): Captured {
    const owner=requests.get(token);
    if(!active || !owner || owner.request!==request || localAuthenticationIdentityAuthority(authentication)!==auth) throw denied();
    assertLinuxWriterLeaseBinding(writerLease,database,nativeDatabase);
    const facts=issuer.read(request,owner.subject);
    if(facts.provider!=="local" || facts.issuer!==localIssuer || facts.subject!==owner.facts.subject
      || auth.currentSessionPredicate(request,owner.actor).tokenHash!==owner.tokenHash) throw denied();
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
        .bind(owner.tokenHash, owner.facts.subject, owner.credentialRevision, owner.createdAt, policy.idleLifetimeMs),
        rejection: new HTTPException(401, { message: "Current local authentication is required" }) },
      { statement: database.prepare(`SELECT 1 admitted WHERE
        EXISTS(SELECT 1 FROM node_installation WHERE singleton=1 AND installation_id=? AND catalog_id=? AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)
        AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1' AND bootstrap_principal_id=? AND initialized_at=?)
        AND EXISTS(SELECT 1 FROM collaboration_control WHERE singleton=1 AND schema_version=2 AND enforcement='enabled')`)
        .bind(installation.installationId, installation.catalogId, installation.checkpointId, installation.schemaSha256, installation.createdAt, bootstrapPrincipalId, initializedAt), rejection: unavailable() },
      { statement: database.prepare(`SELECT 1 admitted FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id WHERE ${memberWhere} LIMIT 1`)
        .bind(owner.facts.provider, owner.facts.issuer, owner.facts.subject), rejection: denied() },
      ...([{ statement: database.prepare(`SELECT 1 admitted FROM system_recovery_maintenance WHERE singleton=1 AND state='open'
        AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)`), rejection: unavailable() }]),
    ];
  }
  function admissionFor(owner: Captured) {
    const list=checks(owner);
    if(owner.scope.operation==="detail") list.push({ statement:database.prepare(`SELECT 1 admitted FROM samples s
      JOIN collaboration_resources resource ON resource.root_kind='sample' AND resource.root_id=s.id
      CROSS JOIN collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id
      LEFT JOIN collaboration_grants grant ON grant.root_kind=resource.root_kind AND grant.root_id=resource.root_id AND grant.member_id=m.member_id
      WHERE s.id=? AND s.deleted_at IS NULL AND ${memberWhere}
        AND (resource.visibility='workspace' OR(grant.enabled=1 AND grant.capability IN('read','operate','edit','manage'))) LIMIT 1`)
      .bind(owner.scope.sampleId,owner.facts.provider,owner.facts.issuer,owner.facts.subject), rejection:denied() });
    return createSqliteBatchAdmission(database,list); // FIVE detail / FOUR directory live guards.
  }
  async function capture(request: Request,scope: Scope): Promise<SampleProjectedDetailReadV28Request> {
    scope=Object.freeze({...scope}); // Capture original route selectors before the first await.
    if(!active || request.method!=="GET" || request.bodyUsed || scope.operation!=="detail" && scope.operation!=="processing") throw denied();
    const url=new URL(request.url);
    if(scope.operation==="detail" ? !canonicalIdentityText(scope.sampleId,256)
      || url.pathname!==`/api/samples/${encodeURIComponent(scope.sampleId)}` : url.pathname!=="/api/samples" || url.searchParams.get("view")!=="processing") throw denied();
    const tokenHash=auth.captureSessionDigest(request),subject=await issuer.issue(request),facts=issuer.read(request,subject);
    if(facts.provider!=="local" || facts.issuer!==localIssuer) throw denied();
    const actor=`local-account:${facts.subject}`;
    if(auth.currentSessionPredicate(request,actor).tokenHash!==tokenHash) throw denied();
    const rows=(await runSqliteAdmittedBatch(database,[database.prepare(`SELECT a.credential_revision,s.created_at
      FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=?
        AND a.principal_id=? AND s.credential_revision=a.credential_revision AND s.revoked_at IS NULL`).bind(tokenHash,facts.subject)],
      createSqliteBatchAdmission(database,[{statement:database.prepare("SELECT 1 admitted FROM collaboration_control WHERE singleton=1 AND schema_version=2 AND enforcement='enabled'"),rejection:unavailable()}])))[0]!.results;
    issuer.read(request,subject);const row=rows[0];
    if(rows.length!==1 || typeof row?.credential_revision!=="bigint" || typeof row.created_at!=="bigint") throw denied();
    const token=Object.freeze({kind:"current-sample-metadata-read-v28/1" as const}) as SampleProjectedDetailReadV28Request;
    requests.set(token,Object.freeze({request,subject,facts,scope:Object.freeze({...scope}),actor,tokenHash,
      credentialRevision:row.credential_revision,createdAt:row.created_at,processingView:url.searchParams.get("view")==="processing"}));
    selected(request,token);return token;
  }
  async function perform(request: Request,token: SampleProjectedDetailReadV28Request) {
    const owner=selected(request,token);if(consumed.has(token)) throw denied();consumed.add(token);
    const member=[owner.facts.provider,owner.facts.issuer,owner.facts.subject];
    const wrappers=new WeakMap<ReadSqlStatement,SqliteStatement>();
    const selectedDetail=new Map<SampleDetailProjection,{native:SqliteStatement;resolve(rows:SqliteRow[]):void;reject(error:unknown):void}>();
    let originalBatch:Promise<void>|undefined,firstStatements:readonly SqliteStatement[]|undefined,
      firstRows:readonly (readonly SqliteRow[])[]|undefined;
    // The genuine opaque facade port is a fixed consumer provenance check,
    // never a readSample/admin flag or structural callback granting File access.
    const canonicalAttachments=attachmentPort!==undefined && owner.scope.operation==="detail" && new URL(request.url).search==="";
    const attachmentProofs:LocalCommentSampleAttachmentProofV28Candidate[]=[];
    const guard=()=>{
      selected(request,token);
      if(attachmentPort) assertLocalCommentSampleAttachmentReadPortV28Candidate(attachmentPort,attachmentBindings);
      return admissionFor(owner);
    };
    async function projectAttachmentItems(rows:readonly SqliteRow[]):Promise<SqliteRow[]> {
      if(!canonicalAttachments || !attachmentPort) return [...rows];
      const candidates=rows.filter(row=>row.kind==="attachment" && row.status==="ready" && typeof row.id==="string" && typeof row.file_id==="string");
      if(candidates.length>MAX_LOCAL_COMMENT_SAMPLE_ATTACHMENT_PROOFS_V28_CANDIDATE)
        throw new HTTPException(413,{message:"This Sample has too many attachments for the current media projection."});
      const delivered:SqliteRow[]=[];
      for(const row of rows){
        if(row.kind==="link"){delivered.push(row);continue;}
        if(row.kind!=="attachment" || row.status!=="ready" || typeof row.id!=="string" || typeof row.file_id!=="string") continue;
        let probe:Awaited<ReturnType<typeof probeLocalCommentSampleAttachmentV28Candidate>>;
        try{probe=await probeLocalCommentSampleAttachmentV28Candidate(request,attachmentPort,Object.freeze({itemId:row.id}));}
        catch(error){
          if(cleanupUnproven(error)) throw error;
          // A File-purpose/source denial supplies no item metadata or URL.
          // Current Sample session/root authority is still rechecked by the full
          // original12 native snapshot before any remaining metadata is exposed.
          if(error instanceof HTTPException && (error.status===403 || error.status===503)) continue;
          throw error;
        }
        // Only an actual available read can contribute a genuine final proof.
        // Unavailable or denied File rows release no filename/URL descriptor.
        if(!probe.available) continue;
        if(!probe.proof) throw unavailable();
        const current=probe.description;
        if(current.fileId!==row.file_id || current.purpose!=="research_source"
          || current.filename!==(row.filename??"attachment") || current.mimeType!==row.mime_type) throw changed();
        // The original actual read and its first ACK have completed. The
        // retained genuine proof must still pass the joined final native batch.
        // Unsupported/unavailable File rows were omitted without upgrading
        // a caller boolean or the original publication status into availability.
        attachmentProofs.push(probe.proof);
        delivered.push({...row,file_id:row.file_id,asset_id:null,asset_key:null,storage_object_id:null});
      }
      return delivered;
    }
    async function read(items: readonly SqliteStatement[]) {
      const sampleAdmission=guard();
      // Proofs come only from completed actual consumer reads and their original
      // first ACKs. Their closed File guard joins the original Sample5 guards in
      // THIS same native BEGIN before the full12 final snapshot/reply; no pair of
      // separate await checks or caller metadata substitutes for joint authority.
      const admission=attachmentPort && attachmentProofs.length
        ? joinSqliteBatchAdmissions(database,[sampleAdmission,
          createLocalCommentSampleAttachmentFinalAdmissionV28Candidate(request,attachmentPort,attachmentProofs)])
        : sampleAdmission;
      const original=runSqliteAdmittedBatch(database,items,admission);
      const result=await original;if(result.length!==items.length) throw unavailable();selected(request,token);return result.map(row=>row.results);
    }
    function startDetailBatch() {
      if(originalBatch || owner.scope.operation!=="detail") throw denied();
      const id=owner.scope.sampleId;
      const items=PROJECTIONS.map(projection => {
        const delivered=selectedDetail.get(projection);if(delivered) return delivered.native;
        if(owner.processingView && (projection==="children" || projection==="events"))
          return database.prepare(sampleDetailFilteredSql(projection,originalSampleDetailSql(projection),owner.facts,true)).bind(...member,id);
        throw new Error("Incomplete original twelve-projection selection");
      });
      firstStatements=Object.freeze(items);
      // Own the original native work before it can begin; its one result settles
      // every original first/all promise at the unchanged original positions.
      originalBatch=Promise.resolve().then(async()=>{
        try {
          const rows=await read(items);firstRows=Object.freeze(rows.map(value=>Object.freeze(value)));
          // Internal typed candidate rows were already all-root filtered in
          // the same original native12 batch. Perform the fixed actual File
          // consumer probe before resolving any item to the neutral serializer.
          const itemRows=canonicalAttachments?await projectAttachmentItems(rows[PROJECTIONS.indexOf("submission_items")]!):undefined;
          for(const [projection,delivery] of selectedDetail) delivery.resolve(projection==="submission_items" && itemRows
            ? itemRows : rows[PROJECTIONS.indexOf(projection)]!);
        } catch(error) { for(const delivery of selectedDetail.values()) delivery.reject(error);throw error; }
      });
      void originalBatch.catch(()=>undefined);
    }
    function enqueue(projection: SampleDetailProjection,native: SqliteStatement):Promise<SqliteRow[]> {
      if(selectedDetail.has(projection) || originalBatch) return Promise.reject(denied());
      let resolve!:(rows:SqliteRow[])=>void,reject!:(error:unknown)=>void;
      const original=new Promise<SqliteRow[]>((yes,no)=>{resolve=yes;reject=no;});void original.catch(()=>undefined);
      selectedDetail.set(projection,{native,resolve,reject});
      const expected=owner.processingView?10:12;
      if(selectedDetail.size===expected) startDetailBatch();
      return original;
    }
    function wrap(native:SqliteStatement,projection?:SampleDetailProjection):ReadSqlStatement {
      const statement:ReadSqlStatement=Object.freeze({
        bind(...values:ReadSqlCell[]) {
          if(projection && (owner.scope.operation!=="detail" || !values.length || !values.every(value=>value===owner.scope.sampleId))) throw denied();
          // Core bind replaces cells. The original service supplies only
          // Sample IDs; retain the privately captured member prefix here.
          return wrap(native.bind(...(projection ? member : []),...values),projection);
        },
        async first() {const rows=projection?await enqueue(projection,native):(await read([native]))[0]!;return rows[0]?configurationSqlRow(rows[0]):null;},
        async all() {const rows=projection?await enqueue(projection,native):(await read([native]))[0]!;return {results:rows.map(configurationSqlRow)};},
      });wrappers.set(statement,native);return statement;
    }
    const db:ReadSqlDatabase=Object.freeze({prepare(sql:string) {
      if(sql!==SCHEMA_SQL) throw new Error("Only the original immutable File-column metadata preflight may use the plain port");
      return wrap(database.prepare(sql));
    }});
    const service=createSampleReadService(Object.freeze({database:()=>db,visibility:owner.facts,visibilitySchemaVersion:2 as const,
      async admit(actor:string) {
        if(actor!==owner.actor) throw denied();
        if(firstRows && firstStatements) {
          const current=await read(firstStatements);
          if(current.length!==firstRows.length || current.some((rows,index)=>!equalRows(firstRows![index]!,rows))) throw changed();
        } else await runSqliteAdmittedBatch(database,[],guard());
        selected(request,token);
      },
      detailStatementProjection(projection:SampleDetailProjection,sql:string) {
        if(owner.scope.operation!=="detail") throw denied();
        return wrap(database.prepare(sampleDetailFilteredSql(projection,sql,owner.facts,false,canonicalAttachments)),projection);
      },
      processingProjection(projection:"page"|"count",sql:string) {
        if(owner.scope.operation!=="processing") throw denied();
        // The original service binds its privately captured visibility facts.
        // They are query cells, while this same-BEGIN Request guard is authority.
        return wrap(database.prepare(sampleProcessingMetadataSql(projection,sql,owner.facts)));
      },
      async readMany(items:readonly ReadSqlStatement[]) {
        if(owner.scope.operation!=="processing" || items.length!==2 || firstRows) throw denied();
        const native=items.map(statement=>{const row=wrappers.get(statement);if(!row) throw denied();return row;});
        const rows=await read(native);firstStatements=Object.freeze(native);firstRows=Object.freeze(rows.map(row=>Object.freeze(row)));
        return rows.map(row=>row.map(configurationSqlRow));
      },
    }));
    const query:SampleReadQuery=key=>new URL(owner.request.url).searchParams.get(key)??undefined;
    let failed=false,failure:unknown,result:unknown;
    try {const original=owner.scope.operation==="detail"?service.detail(owner.scope.sampleId,query,owner.actor):service.directory(query,owner.actor);result=await original;}
    catch(error){failed=true;failure=error;}
    // If synchronous original statement selection failed before the full batch,
    // every reservation is explicitly rejected. No native work was started and
    // no unresolved delivery is silently abandoned outside the original work.
    if(!originalBatch && owner.scope.operation==="detail") for(const delivery of selectedDetail.values()) delivery.reject(failed?failure:unavailable());
    if(originalBatch) {
      try {await originalBatch;}catch(error){if(!failed){failed=true;failure=error;}else if(!Object.is(error,failure)) failure=new AggregateError([failure,error],"Original Sample work and batch acknowledgement both failed");}
    }
    if(failed) throw failure;selected(request,token);return result;
  }
  return Object.freeze({capture,perform,metadataOnly:attachmentPort===undefined,
    mediaPurpose:attachmentPort?"original-sample-get-canonical-attachment-only" as const:"unavailable-until-genuine-v28-consumer-read-issuer" as const,
    discard(){active=false;}});
}

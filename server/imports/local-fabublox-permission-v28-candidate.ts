import { registerGroupV28MultipartBody } from "../collaboration/group-v28-request-body-custody";
import { HTTPException } from "hono/http-exception";
import { FABUBLOX_IMPORT_REQUEST_HEADER, normalizeFabubloxImportRequestId } from "../../shared/contracts/fabublox-import";
import type { FilePurpose } from "../../shared/contracts/files";
import { configurationSqlCell, configurationSqlInteger, configurationSqlRow, type ConfigurationSqlRow,
  type ConfigurationSqlCell } from "../../worker/runtime/configuration-sql";
import { acceptFabubloxImportWithDatabase, readAcceptedImportWithDatabase,
  FabubloxImportRequestConflictError,
  type AcceptFabubloxImportInput, type AcceptedFabubloxImportRow, type AcceptedImportFileTarget,
  type FabubloxAcceptanceDatabase, type FabubloxAcceptanceStatement } from "../../worker/imports/fabublox-acceptance-core";
import type { PreparedFabubloxPayload } from "../../worker/imports/fabublox-payload";
import type { FileAuthoritySqlStatement, FileAuthoritySqlDatabase } from "../../worker/runtime/file-authority-sql";
import { StorageProfileCleanupError } from "../../worker/files/storage-profile-opening";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { captureInstalledIdentityExecutionOwnerV28Candidate } from "../auth/installed-identity-execution-owner-v28-candidate";
import { createLocalRequestSubjectIssuer, type LocalRequestSubject } from "../auth/local-request-subject";
import type { ReviewedInstallationAdmission } from "../migrations";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteBatchAdmissionCheck } from "../sqlite";
import { assertLocalUploadExecutionRequestOwner, assertLocalUploadExecutionPhysicalRequestOwner,
  type LocalUploadExecution } from "../files/local-upload-execution";
import { ownedLocalVolumeProfileContextV28Candidate, type LocalVolumeProfileOpeningV28Candidate } from "../storage/local-volume-profile-opening-v28-candidate";
import { captureLocalVolumeProfileAuthority, type LocalVolumeProfileAuthority } from "../storage/local-volume-profile-opening";
import { createRetainedFabubloxMultipartBody } from "./retained-fabublox-multipart-body";

declare const permissionBrand: unique symbol;
declare const acceptedBrand: unique symbol;
export interface LocalFabubloxPermissionV28Candidate { readonly [permissionBrand]: true }
export interface LocalFabubloxAcceptedV28Candidate { readonly [acceptedBrand]: true }
/** Captured by the closed metadata owner before its one possible dispatch.
 * Supplying values cannot mark a receipt ready: the issuer verifies all actual
 * same-operation Native facts before narrowing its final-only phase. */
export interface LocalFabubloxFinalizationV28Candidate {
  readonly finalizationId: string; readonly templateVersionId: string; readonly version: number;
  readonly resultJson: string; readonly workbookFileId: string; readonly manifestFileId: string;
  readonly manifestHash: string; readonly initialStateHash: string | null; readonly templateContentJson: string;
  readonly stateAssetRowsJson: string; readonly aliasesJson: string;
}
type Payload = PreparedFabubloxPayload & { requestId: string };
type SelectedFamily = Readonly<{ id: string; name: string; templateType: "process" | "module" | "recipe"; fresh: boolean }>;
type RoleSelection = Readonly<{ revision: number; snapshot: string; authorities: readonly LocalVolumeProfileAuthority[];
  targets: readonly AcceptedImportFileTarget[] }>;
type Session = Readonly<{ request: Request; subject: LocalRequestSubject; actor: string; principalId: string;
  tokenHash: string; credentialRevision: bigint; createdAt: bigint; method: string; url: string }>;
type PermissionOwner = Readonly<{ opening: LocalVolumeProfileOpeningV28Candidate; request: Request; actor: string;
  kind: "fabublox"; access: "write"; assertCurrent(): void;
  preflight(): readonly SqliteBatchAdmissionCheck[]; final(): readonly SqliteBatchAdmissionCheck[];
  business(file?: Readonly<{ fileId: string; purpose: FilePurpose }>): readonly SqliteBatchAdmissionCheck[];
  preparePayload(execution:LocalUploadExecution): Promise<Payload> }>;
type AcceptedOwner = Readonly<{ permission: LocalFabubloxPermissionV28Candidate; execution: LocalUploadExecution;
  request: Request; opening: LocalVolumeProfileOpeningV28Candidate; payload: Payload; family: SelectedFamily;
  input: AcceptFabubloxImportInput; authorities: readonly LocalVolumeProfileAuthority[]; assertCurrent(): void;
  reserveFinalization(value:LocalFabubloxFinalizationV28Candidate):void;
  acknowledgeFinalization():void; inspectOriginalFinalization():ConfigurationSqlRow|null;
  acknowledgeRecovery(recoveryOperationId:string):void }>;
const permissions = new WeakMap<LocalFabubloxPermissionV28Candidate, PermissionOwner>();
const consumed = new WeakSet<LocalFabubloxPermissionV28Candidate>();
const acceptedOwners = new WeakMap<LocalFabubloxAcceptedV28Candidate, AcceptedOwner>();
const denied = () => new HTTPException(403, { message: "Current explicit Template family import permission is required." });
const unavailable = () => new HTTPException(503, { message: "Current local FabuBlox import authority is unavailable." });
const memberWhere = "i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'";
function freezePreparedMetadata(value:unknown):void {
  if(!value || typeof value!=="object" || value instanceof ArrayBuffer || value instanceof Blob)return;
  if(!Array.isArray(value) && Object.getPrototypeOf(value)!==Object.prototype)return;
  for(const child of Object.values(value))freezePreparedMetadata(child);
  Object.freeze(value);
}
const ROLE_SNAPSHOT = `SELECT json_group_array(json(tuple)) snapshot FROM
  (SELECT json_array(d.role,d.storage_profile_id,d.storage_profile_revision,d.policy_revision,d.created_at,
    h.policy_revision,h.role,h.storage_profile_id,h.storage_profile_revision,h.operation_id,h.actor,h.created_at,
    p.id,p.adapter_type,p.namespace_identity,p.configuration_source,p.credential_reference,p.configuration_revision,p.state,
    runtime.state) tuple FROM storage_role_defaults d
    JOIN storage_role_policy_revisions h ON h.policy_revision=d.policy_revision AND h.role=d.role
      AND h.storage_profile_id=d.storage_profile_id AND h.storage_profile_revision=d.storage_profile_revision AND h.created_at=d.created_at
    JOIN storage_profiles p ON p.id=d.storage_profile_id AND p.configuration_revision=d.storage_profile_revision
    JOIN storage_profile_runtime runtime ON runtime.storage_profile_id=p.id ORDER BY d.role)`;

/** Closed genuine registries. Neither a copied token nor a body-derived actor,
 * profile, receipt or purpose can issue shared execution authority. */
export function ownedLocalFabubloxPermissionV28Candidate(token: LocalFabubloxPermissionV28Candidate,
  opening: LocalVolumeProfileOpeningV28Candidate, request: Request, actor: string): PermissionOwner {
  const owner = permissions.get(token);
  if (!owner || owner.opening !== opening || owner.request !== request || owner.actor !== actor) throw denied();
  owner.assertCurrent(); return owner;
}
export function consumeLocalFabubloxExecutionPermissionV28Candidate(token: LocalFabubloxPermissionV28Candidate,
  opening: LocalVolumeProfileOpeningV28Candidate, request: Request, actor: string): PermissionOwner {
  const owner = ownedLocalFabubloxPermissionV28Candidate(token, opening, request, actor);
  if (consumed.has(token)) throw denied(); consumed.add(token); return owner;
}
export function ownedLocalFabubloxAcceptedV28Candidate(token: LocalFabubloxAcceptedV28Candidate,
  execution: LocalUploadExecution, request: Request): AcceptedOwner {
  const owner = acceptedOwners.get(token);
  if (!owner || owner.execution !== execution || owner.request !== request) throw denied();
  assertLocalUploadExecutionRequestOwner(execution, owner.opening, request, owner.input.actorEmail);
  owner.assertCurrent(); return owner;
}

/** Request/purpose and durable acceptance boundary only. No route, metadata
 * version, final File publication or recovery scheduler is activated here.
 * A future closed Node finalizer must keep this original execution until its
 * complete original metadata and one publication/business batch have settled. */
export function createLocalFabubloxPermissionV28Candidate(options: {
  opening: LocalVolumeProfileOpeningV28Candidate; authentication: object; admission: ReviewedInstallationAdmission;
}) {
  if (Object.keys(options).sort().join(",") !== "admission,authentication,opening") throw unavailable();
  const { opening, authentication, admission } = options;
  const physical = ownedLocalVolumeProfileContextV28Candidate(opening);
  const { database, nativeDatabase, writerLease } = physical;
  const auth = localAuthenticationIdentityAuthority(authentication);
  const identity = captureInstalledIdentityExecutionOwnerV28Candidate(auth.identity, database, nativeDatabase, admission);
  const issuer = createLocalRequestSubjectIssuer({ database, nativeDatabase, writerLease, authentication, admission });
  const installation = identity.installation, localIssuer = `node-installation:${installation.installationId}`;
  type State = { session: Session; payload?: Payload; payloadOperation?: Promise<Payload>; family?: SelectedFamily;
    roles?: RoleSelection; input?: AcceptFabubloxImportInput; accepted?: LocalFabubloxAcceptedV28Candidate;
    replay?: AcceptedFabubloxImportRow; accepting: boolean; ownReceipt: boolean; recoveryOperationId?:string;
    finalization?:Readonly<LocalFabubloxFinalizationV28Candidate>; finalized?:boolean };
  const states = new WeakMap<LocalFabubloxPermissionV28Candidate, State>();
  const bodies = new Set<ReturnType<typeof createRetainedFabubloxMultipartBody>>();
  const work = new Set<Promise<unknown>>();
  let active = true, closure: Promise<void> | undefined;
  function current(session: Session): void {
    if (!active || localAuthenticationIdentityAuthority(authentication) !== auth
      || session.request.method !== session.method || session.request.url !== session.url) throw denied();
    physical.assertCurrent(); identity.assertCurrent();
    const facts = issuer.read(session.request, session.subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer || facts.subject !== session.principalId
      || auth.currentSessionPredicate(session.request, session.actor).tokenHash !== session.tokenHash) throw denied();
  }
  function selected(request: Request, token: LocalFabubloxPermissionV28Candidate): State {
    const state = states.get(token); if (!state || state.session.request !== request) throw denied();
    current(state.session); return state;
  }
  function track<T>(operation: Promise<T>): Promise<T> {
    work.add(operation); operation.then(() => work.delete(operation), () => work.delete(operation)); return operation;
  }
  function finalizationWitness(state:State):Readonly<{sql:string;values:ConfigurationSqlCell[]}> {
    const input=state.input,roles=state.roles,value=state.finalization;
    if(!input || !roles || !value || !state.ownReceipt || state.recoveryOperationId)throw denied();
    // This one receipt check remains the fourth purpose check (shared source
    // checks plus these four still equal eight). It verifies actual complete
    // typed File/state/template publication, not a caller finalization flag.
    const sql=`SELECT 1 admitted FROM imports imported JOIN template_versions tv ON tv.id=imported.template_version_id
      WHERE imported.id=? AND imported.operation_id=? AND imported.actor_email=? AND imported.client_request_id=?
        AND imported.request_sha256=? AND imported.request_input_json=? AND imported.recipe_family_id=?
        AND imported.request_scope='system' AND imported.file_targets_protocol=1 AND imported.role_policy_revision=?
        AND imported.storage_profile_id IS NULL AND imported.storage_profile_revision IS NULL AND imported.storage_policy_revision IS NULL
        AND imported.status='ready' AND imported.finalization_id=? AND imported.recovery_operation_id IS NULL
        AND imported.lease_expires_at IS NULL AND imported.completed_at IS NOT NULL AND imported.accepted_result_json=?
        AND imported.workbook_asset_key IS NULL AND imported.manifest_asset_key IS NULL
        AND imported.workbook_file_id=? AND imported.manifest_file_id=?
        AND tv.id=? AND tv.recipe_family_id=imported.recipe_family_id AND tv.version=? AND tv.manifest_hash=?
        AND tv.initial_state_hash IS ? AND tv.content_json=? AND tv.source_file_id=imported.workbook_file_id
        AND tv.source_asset_key IS NULL AND tv.archived_at IS NULL AND tv.deleted_at IS NULL
        AND (${ROLE_SNAPSHOT}) IS ?
        AND (SELECT count(*) FROM import_file_acceptances actual WHERE actual.import_id=imported.id)=json_array_length(?)
        AND json_array_length(?)=json_array_length(?)
        AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(
          SELECT 1 FROM import_file_acceptances actual
          JOIN json_each(?) alias ON json_extract(alias.value,'$.itemId')=actual.item_id
          JOIN assets a ON a.id=json_extract(alias.value,'$.assetId') AND a.file_id=actual.result_file_id
          JOIN file_usable_publications fp ON fp.file_id=actual.result_file_id AND fp.purpose=actual.purpose AND fp.access_scope='system'
          JOIN file_location_publications flp ON flp.file_id=fp.file_id AND flp.location_id=actual.result_location_id
            AND fp.active_location_id=actual.result_location_id AND flp.storage_profile_id=actual.storage_profile_id
          WHERE actual.import_id=imported.id AND actual.item_id=json_extract(expected.value,'$.itemId')
            AND actual.purpose=json_extract(expected.value,'$.purpose') AND actual.role_policy_revision=imported.role_policy_revision
            AND actual.storage_profile_id=json_extract(expected.value,'$.profileId') AND actual.storage_profile_revision=1
            AND actual.expected_sha256=json_extract(expected.value,'$.sha256') AND actual.expected_byte_size=json_extract(expected.value,'$.byteSize')
            AND actual.candidate_asset_id=json_extract(expected.value,'$.candidateAssetId')
            AND actual.candidate_object_key=json_extract(expected.value,'$.candidateObjectKey') AND actual.status='ready'
            AND actual.result_file_id=json_extract(alias.value,'$.fileId') AND a.r2_key IS NULL AND a.status='ready'
            AND a.storage_profile_id=actual.storage_profile_id AND a.storage_profile_revision=actual.storage_profile_revision
            AND a.object_key=json_extract(alias.value,'$.objectKey') AND flp.object_key=a.object_key
            AND a.sha256=actual.expected_sha256 AND a.byte_size=actual.expected_byte_size
            AND fp.verified_sha256=actual.expected_sha256 AND fp.verified_byte_size=actual.expected_byte_size
            AND flp.verified_sha256=actual.expected_sha256 AND flp.verified_byte_size=actual.expected_byte_size))
        AND EXISTS(SELECT 1 FROM json_each(?) alias WHERE json_extract(alias.value,'$.itemId')='workbook'
          AND json_extract(alias.value,'$.fileId')=imported.workbook_file_id)
        AND EXISTS(SELECT 1 FROM json_each(?) alias WHERE json_extract(alias.value,'$.itemId')='manifest'
          AND json_extract(alias.value,'$.fileId')=imported.manifest_file_id)
        AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(
          SELECT 1 FROM state_representation_assets actual JOIN state_representations state ON state.hash=actual.state_hash
            JOIN assets a ON a.id=actual.asset_id
          WHERE actual.state_hash=json_extract(expected.value,'$[0]') AND actual.asset_id=json_extract(expected.value,'$[1]')
            AND actual.position=json_extract(expected.value,'$[2]') AND actual.file_id=json_extract(expected.value,'$[3]')
            AND a.file_id=actual.file_id AND a.r2_key IS NULL AND a.status='ready')) LIMIT 1`;
    const targets=JSON.stringify(roles.targets);
    return {sql,values:[input.importId,input.operationId,input.actorEmail,input.requestId,input.requestSha256,input.requestInputJson,
      input.recipeFamilyId,roles.revision,value.finalizationId,value.resultJson,value.workbookFileId,value.manifestFileId,
      value.templateVersionId,value.version,value.manifestHash,value.initialStateHash,value.templateContentJson,roles.snapshot,
      targets,targets,value.aliasesJson,targets,value.aliasesJson,value.aliasesJson,value.aliasesJson,value.stateAssetRowsJson]};
  }
  function policy(state: State, boundary: "preflight" | "final" | "business",
    file?: Readonly<{ fileId: string; purpose: FilePurpose }>): SqliteBatchAdmissionCheck[] {
    const s = state.session; current(s);
    const control = {statement:database.prepare(`SELECT 1 admitted FROM collaboration_control
      WHERE singleton=1 AND schema_version=2 AND enforcement='enabled'`),rejection:unavailable()};
    const controlMember = { statement: database.prepare(`SELECT 1 admitted FROM collaboration_identities i
      JOIN collaboration_members m ON m.member_id=i.member_id WHERE ${memberWhere}
        AND EXISTS(SELECT 1 FROM local_sessions session JOIN local_accounts account ON account.principal_id=session.principal_id
          WHERE session.token_hash=? AND account.principal_id=? AND account.enabled=1 AND session.revoked_at IS NULL
            AND account.credential_revision=session.credential_revision AND account.credential_revision=? AND session.created_at=?) LIMIT 1`)
      .bind(localIssuer,s.principalId,s.tokenHash,s.principalId,s.credentialRevision,s.createdAt), rejection: denied() };
    const family = state.family;
    let familyCheck: SqliteBatchAdmissionCheck;
    if (family && (!family.fresh || state.ownReceipt || state.replay)) {
      familyCheck = { statement: database.prepare(`SELECT 1 admitted FROM recipe_families rf
        JOIN collaboration_resources r ON r.root_kind='template' AND r.root_id=rf.id
        JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id
        JOIN collaboration_identities i ON i.member_id=g.member_id JOIN collaboration_members m ON m.member_id=i.member_id
        WHERE rf.id=? AND rf.name=? AND rf.template_type=? AND rf.archived_at IS NULL AND ${memberWhere}
          AND g.enabled=1 AND g.capability IN('edit','manage') LIMIT 1`)
        .bind(family.id,family.name,family.templateType,localIssuer,s.principalId), rejection: denied() };
    } else if (family) {
      const input=state.input;
      familyCheck = { statement: database.prepare(`SELECT 1 admitted FROM collaboration_identities i
        JOIN collaboration_members m ON m.member_id=i.member_id WHERE ${memberWhere} AND (
          (m.can_create_templates=1 AND NOT EXISTS(SELECT 1 FROM recipe_families WHERE id=?)
            AND NOT EXISTS(SELECT 1 FROM collaboration_resources WHERE root_kind='template' AND root_id=?))
          OR EXISTS(SELECT 1 FROM recipe_families rf
            JOIN collaboration_resources r ON r.root_kind='template' AND r.root_id=rf.id
            JOIN collaboration_grants g ON g.root_kind=r.root_kind AND g.root_id=r.root_id AND g.member_id=m.member_id
            JOIN imports imported ON imported.recipe_family_id=rf.id
            WHERE rf.id=? AND rf.name=? AND rf.template_type=? AND rf.archived_at IS NULL
              AND r.visibility='restricted' AND g.enabled=1 AND g.capability='manage'
              AND imported.id=? AND imported.operation_id=? AND imported.actor_email=? AND imported.client_request_id=?
              AND imported.request_sha256=? AND imported.request_input_json=? AND imported.status='pending'
              AND imported.file_targets_protocol=1 AND imported.role_policy_revision=?
              AND imported.storage_profile_id IS NULL AND imported.storage_profile_revision IS NULL AND imported.storage_policy_revision IS NULL)) LIMIT 1`)
        .bind(localIssuer,s.principalId,family.id,family.id,
          family.id,family.name,family.templateType,input?.importId??null,input?.operationId??null,s.actor,input?.requestId??null,
          input?.requestSha256??null,input?.requestInputJson??null,input?.rolePolicyRevision??null), rejection: denied() };
    } else {
      familyCheck = { statement: database.prepare(`SELECT 1 admitted FROM collaboration_identities i
        JOIN collaboration_members m ON m.member_id=i.member_id WHERE ${memberWhere} AND
        (m.can_create_templates=1 OR EXISTS(SELECT 1 FROM collaboration_grants g
          JOIN collaboration_resources r ON r.root_kind=g.root_kind AND r.root_id=g.root_id
          JOIN recipe_families rf ON rf.id=r.root_id AND rf.archived_at IS NULL
          WHERE g.root_kind='template' AND g.member_id=m.member_id AND g.enabled=1 AND g.capability IN('edit','manage'))) LIMIT 1`)
        .bind(localIssuer,s.principalId), rejection: denied() };
    }
    if (boundary === "preflight") return [control,controlMember,familyCheck];
    if (state.finalized) {
      if(boundary!=="final" || file)throw denied();
      const selected=finalizationWitness(state);
      return [control,controlMember,familyCheck,{statement:database.prepare(selected.sql).bind(...selected.values),rejection:denied()}];
    }
    if (boundary === "business" && (!state.ownReceipt || !state.input || !state.roles || state.recoveryOperationId)) throw denied();
    const roles = state.roles, input = state.input;
    if (!roles || !input || !state.ownReceipt) return [control,controlMember,familyCheck,
      ...(roles ? [{ statement:database.prepare(`SELECT 1 admitted WHERE (${ROLE_SNAPSHOT}) IS ?`).bind(roles.snapshot), rejection:unavailable() }] : [])];
    if (file && file.purpose !== "provenance" && file.purpose !== "embedded_content") throw denied();
    const encoded = JSON.stringify(roles.targets);
    const receipt = database.prepare(`SELECT 1 admitted FROM imports imported WHERE imported.id=? AND imported.operation_id=?
      AND imported.actor_email=? AND imported.client_request_id=? AND imported.request_sha256=? AND imported.request_input_json=?
      AND imported.recipe_family_id=? AND imported.request_scope='system' AND imported.file_targets_protocol=1
      AND imported.role_policy_revision=? AND imported.storage_profile_id IS NULL AND imported.storage_profile_revision IS NULL
      AND imported.storage_policy_revision IS NULL AND imported.finalization_id IS NULL
      AND ((imported.status='pending' AND imported.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        OR(imported.status='failed' AND imported.recovery_operation_id=? AND imported.lease_expires_at IS NULL
          AND imported.accepted_result_json IS NULL AND imported.workbook_file_id IS NULL AND imported.manifest_file_id IS NULL))
      AND (${ROLE_SNAPSHOT}) IS ? AND (SELECT count(*) FROM import_file_acceptances WHERE import_id=imported.id)=json_array_length(?)
      AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM import_file_acceptances actual
        WHERE actual.import_id=imported.id AND actual.item_id=json_extract(expected.value,'$.itemId')
          AND actual.purpose=json_extract(expected.value,'$.purpose') AND actual.role_policy_revision=imported.role_policy_revision
          AND actual.storage_profile_id=json_extract(expected.value,'$.profileId') AND actual.storage_profile_revision=1
          AND actual.expected_sha256=json_extract(expected.value,'$.sha256') AND actual.expected_byte_size=json_extract(expected.value,'$.byteSize')
          AND actual.candidate_asset_id=json_extract(expected.value,'$.candidateAssetId')
          AND actual.candidate_object_key=json_extract(expected.value,'$.candidateObjectKey') AND actual.status='pending'))
      AND (? IS NULL OR EXISTS(SELECT 1 FROM file_acceptance_candidates c WHERE c.acceptance_kind='import_file'
        AND c.acceptance_id=imported.id AND c.purpose=? AND (c.candidate_file_id=? OR c.result_file_id=?))) LIMIT 1`)
      .bind(input.importId,input.operationId,s.actor,input.requestId,input.requestSha256,input.requestInputJson,input.recipeFamilyId,
        roles.revision,state.recoveryOperationId??null,roles.snapshot,encoded,encoded,file?.fileId??null,file?.purpose??null,file?.fileId??null,file?.fileId??null);
    return [control,controlMember,familyCheck,{statement:receipt,rejection:denied()}]; // Shared source four + these four = original eight.
  }
  async function captureOriginal(request: Request): Promise<LocalFabubloxPermissionV28Candidate> {
    if(!(request instanceof Request))throw denied();
    const url = new URL(request.url);
    if (!active || request.method!=="POST" || request.bodyUsed || url.pathname!=="/api/imports/fabublox" || url.search || url.hash) throw denied();
    const raw=request.headers.get(FABUBLOX_IMPORT_REQUEST_HEADER);
    if (!raw) throw new HTTPException(428,{message:"Refresh this page before importing a workbook."});
    if (!normalizeFabubloxImportRequestId(raw)) throw new HTTPException(400,{message:"Invalid import request identity"});
    const tokenHash=auth.captureSessionDigest(request), subject=await issuer.issue(request), facts=issuer.read(request,subject);
    if (facts.provider!=="local" || facts.issuer!==localIssuer) throw denied();
    const actor=`local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(request,actor).tokenHash!==tokenHash) throw denied();
    const statement=nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true);const row=statement.get(tokenHash,facts.subject);issuer.read(request,subject);
    if(typeof row?.credential_revision!=="bigint" || typeof row.created_at!=="bigint") throw denied();
    const session:Session=Object.freeze({request,subject,actor,principalId:facts.subject,tokenHash,
      credentialRevision:row.credential_revision,createdAt:row.created_at,method:request.method,url:request.url});
    const state:State={session,accepting:false,ownReceipt:false};
    await runSqliteAdmittedBatch(database,[],createSqliteBatchAdmission(database,policy(state,"preflight")));
    const token=Object.freeze({}) as LocalFabubloxPermissionV28Candidate;
    const owner:PermissionOwner=Object.freeze({opening,request,actor,kind:"fabublox",access:"write",
      assertCurrent:()=>current(session),preflight:()=>policy(state,"preflight"),final:()=>policy(state,"final"),
      business:(file?:Readonly<{fileId:string;purpose:FilePurpose}>)=>policy(state,"business",file),
      preparePayload(execution:LocalUploadExecution):Promise<Payload>{
        current(session);
        if(!consumed.has(token))throw denied();
        assertLocalUploadExecutionRequestOwner(execution,opening,request,actor);
        if(state.payloadOperation)return state.payloadOperation;
        // Creation follows shared execution capture/acquisition. This exact
        // body starts no preparation while authentication is still awaiting.
        const body=createRetainedFabubloxMultipartBody(request);bodies.add(body);
        registerGroupV28MultipartBody(request,body);
        state.payloadOperation=track((async()=>{
          let value:Payload|undefined,cause:unknown,failed=false;
          try{value=await body.prepared;}catch(error){failed=true;cause=error;}
          try{await body.close();bodies.delete(body);}catch(cleanup){
            throw new StorageProfileCleanupError(cause,cleanup,{owner:Object.freeze({body,request,opening}),dispose:()=>body.close()});
          }
          if(failed)throw cause;current(session);freezePreparedMetadata(value!);state.payload=value!;return value!;
        })());return state.payloadOperation;
      }});
    states.set(token,state);permissions.set(token,owner);return token;
  }
  function actor(request:Request,token:LocalFabubloxPermissionV28Candidate){return selected(request,token).session.actor;}
  async function acceptOriginal(request:Request,token:LocalFabubloxPermissionV28Candidate,execution:LocalUploadExecution) {
    const state=selected(request,token),payload=state.payload;
    assertLocalUploadExecutionRequestOwner(execution,opening,request,state.session.actor);
    if(typeof execution.assertFabubloxRequestCurrent!=="function" || typeof execution.fabubloxAcceptanceDatabase!=="function"
      || typeof execution.readFabubloxImportPayload!=="function")throw denied();
    const assertCurrentRequest=execution.assertFabubloxRequestCurrent.bind(execution);
    const acceptanceDatabase=execution.fabubloxAcceptanceDatabase.bind(execution);
    if(!consumed.has(token) || !payload || state.accepting || state.accepted || state.replay)throw denied();
    state.accepting=true;
    // Original statements are private descriptors. A fresh genuine native
    // admission is issued at each actual execution, after the selected family,
    // roles or owned receipt changes. Reusing the pre-selection view would
    // accidentally keep its older weaker SELECT guards.
    const descriptors=new WeakMap<FileAuthoritySqlStatement,Readonly<{sql:string;values:readonly unknown[]}>>();
    const currentDatabase=()=>state.roles
      ? acceptanceDatabase(state.roles.authorities) : execution.historyDatabase();
    const descriptor=(sql:string,values:readonly unknown[]):FileAuthoritySqlStatement=>{
      const observed=Object.freeze([...values]);
      const original=()=>currentDatabase().prepare(sql).bind(...observed.map(configurationSqlCell));
      const value:FileAuthoritySqlStatement=Object.freeze({bind(...input:ConfigurationSqlCell[]){return descriptor(sql,input);},
        first:()=>original().first(),all:()=>original().all(),run:()=>original().run()});
      descriptors.set(value,Object.freeze({sql,values:observed}));return value;
    };
    const db:FileAuthoritySqlDatabase=Object.freeze({prepare(sql:string){return descriptor(sql,[]);},primary(){return db;},
      batch(items:readonly FileAuthoritySqlStatement[]){const current=currentDatabase();return current.batch(items.map(item=>{
        const selected=descriptors.get(item);if(!selected)throw denied();return current.prepare(selected.sql).bind(...selected.values.map(configurationSqlCell));
      }));}});
    const statements=new WeakMap<AcceptanceStatement,FileAuthoritySqlStatement>();
    interface AcceptanceStatement extends FabubloxAcceptanceStatement<AcceptanceStatement>{}
    const integerFields=new Map<string,number>([["file_targets_protocol",1],["role_policy_revision",1],
      ["storage_profile_revision",1],["storage_policy_revision",1],["expected_byte_size",0]]);
    const acceptanceRow=(row:ConfigurationSqlRow):ConfigurationSqlRow=>Object.fromEntries(Object.entries(row).map(([key,value])=>{
      const minimum=integerFields.get(key);
      return [key,minimum===undefined || value===null?value:configurationSqlInteger(value,`FabuBlox accepted ${key}`,minimum)];
    }));
    function wrap(native:FileAuthoritySqlStatement):AcceptanceStatement{
      const value:AcceptanceStatement=Object.freeze({
        bind(...values:unknown[]){return wrap(native.bind(...values.map(configurationSqlCell)));},
        // The original SQL core owns every generic row declaration. This
        // adapter changes no cell; domain consumers still check their fields.
        async first<Row>(){const value=await native.first();return (value===null?null:acceptanceRow(value)) as Row|null;},
        async all<Row>(){const value=await native.all();return {success:value.success,results:value.results.map(acceptanceRow) as Row[]};},
        run:()=>native.run(),
      });statements.set(value,native);return value;
    }
    const port:FabubloxAcceptanceDatabase<AcceptanceStatement>=Object.freeze({prepare(sql:string){return wrap(db.prepare(sql));},
      primary(){db.primary();return port;},batch(items:AcceptanceStatement[]){return db.batch(items.map(item=>{
        const native=statements.get(item);if(!native)throw denied();return native;}));}});
    const existing=await readAcceptedImportWithDatabase(port,state.session.actor,payload.requestId);
    if(existing){
      if(existing.request_sha256!==payload.requestSha256 || existing.request_input_json!==payload.requestInputJson)
        throw new FabubloxImportRequestConflictError();
      const row=await db.prepare("SELECT rf.id,rf.name,rf.template_type FROM imports imported JOIN recipe_families rf ON rf.id=imported.recipe_family_id WHERE imported.id=? AND imported.actor_email=? AND rf.archived_at IS NULL")
        .bind(existing.id,state.session.actor).first();
      state.family=family(row,false);state.replay=existing;
      await assertCurrentRequest();selected(request,token);
      return Object.freeze({owned:false as const,row:existing});
    }
    const manifest=payload.manifest;
    const observed=manifest.recipeFamilyId
      ? await db.prepare("SELECT id,name,template_type FROM recipe_families WHERE id=? AND archived_at IS NULL").bind(manifest.recipeFamilyId).first()
      : await db.prepare("SELECT id,name,template_type FROM recipe_families WHERE name=? AND template_type='process' AND archived_at IS NULL").bind(manifest.title.trim()).first();
    if(manifest.recipeFamilyId && !observed)throw new HTTPException(404,{message:"Process-template family not found"});
    state.family=observed?family(observed,false):Object.freeze({id:crypto.randomUUID(),name:manifest.title.trim(),templateType:"process",fresh:true});
    const familySelection=state.family;
    await assertCurrentRequest();
    const roles=await db.prepare(`SELECT d.role,d.storage_profile_id,d.policy_revision,d.storage_profile_revision,p.adapter_type,r.state
      FROM storage_role_defaults d JOIN storage_profiles p ON p.id=d.storage_profile_id AND p.configuration_revision=d.storage_profile_revision
      JOIN storage_role_policy_revisions h ON h.policy_revision=d.policy_revision AND h.role=d.role
        AND h.storage_profile_id=d.storage_profile_id AND h.storage_profile_revision=d.storage_profile_revision AND h.created_at=d.created_at
      JOIN storage_profile_runtime r ON r.storage_profile_id=p.id ORDER BY d.role`).all();
    if(!roles.success || roles.results.length!==2)throw unavailable();
    const internal=roles.results.find(row=>row.role==='internal'),originals=roles.results.find(row=>row.role==='originals');
    if(!internal || !originals)throw unavailable();
    const revision=configurationSqlInteger(internal.policy_revision,"FabuBlox role policy revision",3);
    if(configurationSqlInteger(originals.policy_revision,"FabuBlox originals policy revision",3)!==revision)throw unavailable();
    const roleProfile=(row:ConfigurationSqlRow)=>{
      if(typeof row.storage_profile_id!=="string" || row.adapter_type!=="local" || row.state!=="read_write"
        || configurationSqlInteger(row.storage_profile_revision,"FabuBlox profile revision",1)!==1)throw unavailable();
      return row.storage_profile_id;
    };
    if(typeof internal.storage_profile_id!=="string" || !internal.storage_profile_id)throw unavailable();
    const profiles=Object.freeze({internal:payload.imageInputs.length?roleProfile(internal):internal.storage_profile_id,originals:roleProfile(originals)});
    const authorities=Object.freeze([...new Set([profiles.originals,...(payload.imageInputs.length?[profiles.internal]:[])])]
      .map(profileId=>captureLocalVolumeProfileAuthority(opening,{profileId,configurationRevision:1},"write")));
    const snapshot=await db.prepare(ROLE_SNAPSHOT).first();if(typeof snapshot?.snapshot!=="string")throw unavailable();
    const snapshotRows:unknown=JSON.parse(snapshot.snapshot);
    if(!Array.isArray(snapshotRows) || snapshotRows.length!==2)throw unavailable();
    const targets:AcceptedImportFileTarget[]=[{itemId:"workbook",...payload.requestInput.workbook},
      {itemId:"manifest",...payload.requestInput.manifest},...payload.requestInput.images.map(image=>({itemId:`image:${image.localId}`,...image}))]
      .map(item=>{const candidateAssetId=crypto.randomUUID();return Object.freeze({itemId:item.itemId,purpose:item.purpose,
        profileId:item.purpose==='provenance'?profiles.originals:profiles.internal,profileRevision:1 as const,
        sha256:item.sha256,byteSize:item.byteSize,candidateAssetId,candidateObjectKey:`files/${candidateAssetId}`});});
    state.roles=Object.freeze({revision,snapshot:snapshot.snapshot,authorities,targets:Object.freeze(targets)});
    const started=new Date(),createdAt=started.toISOString();
    const input:AcceptFabubloxImportInput=Object.freeze({importId:crypto.randomUUID(),operationId:crypto.randomUUID(),
      requestId:payload.requestId,requestSha256:payload.requestSha256,requestInputJson:payload.requestInputJson,actorEmail:state.session.actor,
      profileId:null,profileRevision:null,policyRevision:null,rolePolicyRevision:revision,fileTargets:state.roles.targets,
      sourceFilename:payload.workbook.name,sourceSha256:payload.actualSha,sheetName:manifest.source.sheetName,
      templateType:familySelection.templateType,recipeFamilyId:familySelection.id,warningCount:manifest.warnings.length,
      createdAt,leaseExpiresAt:new Date(started.getTime()+24*60*60*1000).toISOString()});
    state.input=input;
    const prefix=familySelection.fresh?[
      port.prepare(`INSERT INTO recipe_families (id, name, template_type, created_by, created_at)
         VALUES (?, ?, ?, ?, ?)`).bind(familySelection.id,familySelection.name,familySelection.templateType,state.session.actor,createdAt),
      port.prepare("INSERT INTO collaboration_resources(root_kind,root_id,visibility,revision) VALUES('template',?,'restricted',1)").bind(familySelection.id),
      port.prepare(`INSERT INTO collaboration_grants(root_kind,root_id,member_id,capability,enabled,revision)
        VALUES('template',?,(SELECT m.member_id FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id
          WHERE ${memberWhere} AND m.can_create_templates=1),'manage',1,1)`).bind(familySelection.id,localIssuer,state.session.principalId),
    ]:[];
    const result=await acceptFabubloxImportWithDatabase(port,input,prefix);
    if(!result.owned){
      const row=await db.prepare("SELECT rf.id,rf.name,rf.template_type FROM imports imported JOIN recipe_families rf ON rf.id=imported.recipe_family_id WHERE imported.id=? AND imported.actor_email=? AND rf.archived_at IS NULL")
        .bind(result.row.id,state.session.actor).first();
      state.family=family(row,false);state.replay=result.row;state.roles=undefined;state.input=undefined;
      await assertCurrentRequest();selected(request,token);
      return Object.freeze({owned:false as const,row:result.row});
    }
    state.ownReceipt=true;
    await assertCurrentRequest();selected(request,token);
    const accepted=Object.freeze({}) as LocalFabubloxAcceptedV28Candidate;state.accepted=accepted;
    acceptedOwners.set(accepted,Object.freeze({permission:token,execution,request,opening,payload,family:familySelection,
      input,authorities,assertCurrent:()=>{selected(request,token);if(!state.ownReceipt || state.accepted!==accepted)throw denied();},
      reserveFinalization(value:LocalFabubloxFinalizationV28Candidate){
        selected(request,token);
        if(!state.ownReceipt || state.accepted!==accepted || state.finalization || state.recoveryOperationId
          || Object.keys(value).sort().join(',')!=='aliasesJson,finalizationId,initialStateHash,manifestFileId,manifestHash,resultJson,stateAssetRowsJson,templateContentJson,templateVersionId,version,workbookFileId')throw denied();
        for(const field of ['aliasesJson','finalizationId','manifestFileId','manifestHash','resultJson','stateAssetRowsJson',
          'templateContentJson','templateVersionId','workbookFileId'] as const)
          if(typeof value[field]!=='string' || !value[field] || value[field].includes('\0'))throw denied();
        if(!Number.isSafeInteger(value.version) || value.version<1
          || value.initialStateHash!==null && (typeof value.initialStateHash!=='string' || !value.initialStateHash))throw denied();
        if(value.resultJson!==JSON.stringify({id:input.importId,templateVersionId:value.templateVersionId,version:value.version}))throw denied();
        const aliases:unknown=JSON.parse(value.aliasesJson),rows:unknown=JSON.parse(value.stateAssetRowsJson);
        if(!Array.isArray(aliases) || aliases.length!==targets.length || !Array.isArray(rows))throw denied();
        state.finalization=Object.freeze({...value});
      },
      acknowledgeFinalization(){
        assertLocalUploadExecutionPhysicalRequestOwner(execution,opening,request,input.actorEmail);
        selected(request,token);
        if(!state.ownReceipt || state.accepted!==accepted)throw denied();
        if(state.finalized)return;
        const selectedFacts=finalizationWitness(state),statement=nativeDatabase.prepare(selectedFacts.sql);
        statement.setReadBigInts(true);
        if(statement.get(...selectedFacts.values)?.admitted!==1n)throw denied();
        // This permits only final scalar/live authority validation. business()
        // and every new provider opening remain denied after actual publication.
        state.finalized=true;
      },
      inspectOriginalFinalization(){
        assertLocalUploadExecutionPhysicalRequestOwner(execution,opening,request,input.actorEmail);
        physical.assertCurrent();identity.assertCurrent();
        if(!state.ownReceipt || state.accepted!==accepted)throw denied();
        // Closed own-operation readout after uncertain ACK; this raw physical
        // evidence does not issue a ready HTTP result or bypass current policy.
        const query=nativeDatabase.prepare(`SELECT status,operation_id,finalization_id,recovery_operation_id,
          template_version_id,client_request_id,actor_email,request_sha256,request_input_json,recipe_family_id,
          accepted_result_json,workbook_file_id,manifest_file_id,lease_expires_at,file_targets_protocol,role_policy_revision,
          storage_profile_id,storage_profile_revision,storage_policy_revision FROM imports
          WHERE id=? AND operation_id=? AND actor_email=? AND client_request_id=?`);
        query.setReadBigInts(true);const row=query.get(input.importId,input.operationId,input.actorEmail,input.requestId);
        return row===undefined?null:configurationSqlRow(row);
      },
      acknowledgeRecovery(recoveryOperationId:string){
        selected(request,token);
        if(!state.ownReceipt || state.accepted!==accepted || state.recoveryOperationId || !recoveryOperationId)throw denied();
        // Narrow only this original accepted operation after its actual five
        // statements' ACK. Receipt facts never confer a new member/root grant.
        const row=nativeDatabase.prepare(`SELECT 1 recovered FROM imports WHERE id=? AND operation_id=? AND actor_email=?
          AND client_request_id=? AND request_sha256=? AND request_input_json=? AND recipe_family_id=? AND status='failed'
          AND recovery_operation_id=? AND finalization_id IS NULL AND lease_expires_at IS NULL AND file_targets_protocol=1
          AND accepted_result_json IS NULL AND workbook_file_id IS NULL AND manifest_file_id IS NULL`).get(
          input.importId,input.operationId,input.actorEmail,input.requestId,input.requestSha256,input.requestInputJson,input.recipeFamilyId,recoveryOperationId);
        if(row?.recovered!==1)throw denied();state.recoveryOperationId=recoveryOperationId;
      }}));
    return Object.freeze({owned:true as const,row:result.row,accepted});
  }
  function family(row:ConfigurationSqlRow|null,fresh:boolean):SelectedFamily {
    if(!row || typeof row.id!=="string" || typeof row.name!=="string"
      || row.template_type!=="process" && row.template_type!=="module" && row.template_type!=="recipe")throw denied();
    return Object.freeze({id:row.id,name:row.name,templateType:row.template_type,fresh});
  }
  return Object.freeze({capture:(request:Request)=>track(Promise.resolve().then(()=>captureOriginal(request))),actor,
    accept:(request:Request,token:LocalFabubloxPermissionV28Candidate,execution:LocalUploadExecution)=>
      track(Promise.resolve().then(()=>acceptOriginal(request,token,execution))),
    close():Promise<void>{
      if(closure)return closure;
      // The enclosing host must settle whole executions before this factory;
      // this first cached close independently retains body/acceptance work.
      active=false;closure=Promise.resolve().then(async()=>{
        await Promise.allSettled([...work]);
        const results=await Promise.allSettled([...bodies].map(body=>body.close()));
        const failures=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
        if(failures.length)throw new StorageProfileCleanupError(undefined,new AggregateError(failures,"Original FabuBlox body ownership remains incomplete"),
          {owner:Object.freeze({bodies,work,opening}),dispose:()=>closure!});
      });closure.then(()=>undefined,()=>undefined);return closure;
    }});
}

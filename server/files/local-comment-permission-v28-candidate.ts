import { HTTPException } from "hono/http-exception";
import type { FilePurpose } from "../../shared/contracts/files";
import { validSubmissionId } from "../../shared/contracts/comment-submissions";
import { validateCommentAcceptanceInput, MAX_COMMENT_ACCEPTANCE_INPUT_BYTES, type AcceptedCommentSubmissionInput } from "../../shared/contracts/comment-acceptance";
import type { ReviewedInstallationAdmission } from "../migrations";
import { localAuthenticationIdentityAuthority } from "../auth/local-auth-http";
import { ownedLocalVolumeIdentityV28Candidate } from "../storage/local-volume-profile-opening";
import { createLocalVolumeRequestSubjectIssuerV28Candidate, type LocalRequestSubject } from "../auth/local-request-subject";
import { createSqliteBatchAdmission, runSqliteAdmittedBatch, type SqliteBatchAdmissionCheck } from "../sqlite";
import { ownedLocalVolumeProfileContextV28Candidate, type LocalVolumeProfileOpeningV28Candidate } from "../storage/local-volume-profile-opening-v28-candidate";
import { canonicalCommentReadCheckSql } from "../collaboration/canonical-comment-read-roots";
import { readOwnedCommentAcceptanceBody } from "./owned-comment-acceptance-body";
import { visibleCommentTargetsSql } from "../../worker/uploads/comment-acceptance-service";

declare const commentPermissionBrand: unique symbol;
declare const commentReadBrand: unique symbol;
declare const sampleProjectionSnapshotBrand: unique symbol;
export interface LocalCommentPermissionV28Candidate { readonly [commentPermissionBrand]: true }
export interface LocalCommentReadV28Candidate { readonly [commentReadBrand]: true }
export interface LocalCommentSampleProjectionSnapshotV28Candidate { readonly [sampleProjectionSnapshotBrand]: true }
export const MAX_LOCAL_COMMENT_SAMPLE_ATTACHMENT_PROOFS_V28_CANDIDATE = 256;
export const MAX_LOCAL_COMMENT_SAMPLE_ATTACHMENT_GUARD_BYTES_V28_CANDIDATE = 2 * 1024 * 1024;
export type LocalCommentReadDescriptionV28Candidate = Readonly<{ fileId: string; purpose: FilePurpose;
  filename: string; mimeType: string | null }>;
export type LocalCommentReadConsumerV28Candidate = Readonly<{ kind: "canonical-comment-attachment" | "canonical-comment-image"; itemId: string }>;
type Operation = "create" | "state" | "uploadItem" | "finalize" | "cancel" | "removeItem";
type Scope = Readonly<{ operation: Operation; submissionId?: string; itemId?: string }>;
type Session = Readonly<{ request: Request; subject: LocalRequestSubject; principalId: string; actor: string;
  tokenHash: string; credentialRevision: bigint; createdAt: bigint; method: string; url: string }>;
type PermissionOwner = Readonly<{ opening: LocalVolumeProfileOpeningV28Candidate; request: Request; actor: string; scope: Scope;
  access: "read" | "write";
  assertCurrent(): void; preflight(): readonly SqliteBatchAdmissionCheck[];
  final(): readonly SqliteBatchAdmissionCheck[];
  business(file?: Readonly<{ fileId: string; purpose: FilePurpose }>): readonly SqliteBatchAdmissionCheck[];
  boundedBody(maximum: number): Promise<ArrayBuffer> }>;
const permissions = new WeakMap<LocalCommentPermissionV28Candidate, PermissionOwner>();
const executionPermissionsConsumed = new WeakSet<LocalCommentPermissionV28Candidate>();
const denied = () => new HTTPException(403, { message: "Current permission for every Comment target is required." });
const unavailable = () => new HTTPException(503, { message: "Current local Comment File authority is unavailable." });

/** Only an actual issuer below registers this exact Request/opening/actor tuple.
 * The returned original checks are narrowed again by the shared native execution;
 * a structurally copied token, actor flag or fabricated provider cannot issue it. */
export function ownedLocalCommentPermissionV28Candidate(token: LocalCommentPermissionV28Candidate,
  opening: LocalVolumeProfileOpeningV28Candidate, request: Request, actor: string): PermissionOwner {
  const owner = permissions.get(token);
  if (!owner || owner.opening !== opening || owner.request !== request || owner.actor !== actor) throw denied();
  owner.assertCurrent(); return owner;
}
export function consumeLocalCommentExecutionPermissionV28Candidate(token: LocalCommentPermissionV28Candidate,
  opening: LocalVolumeProfileOpeningV28Candidate, request: Request, actor: string): PermissionOwner {
  const owner = ownedLocalCommentPermissionV28Candidate(token, opening, request, actor);
  if (executionPermissionsConsumed.has(token)) throw denied();
  executionPermissionsConsumed.add(token); return owner;
}
function id(raw: string): string {
  let value: string; try { value = decodeURIComponent(raw); } catch { throw new HTTPException(400, { message: "Invalid upload identifier" }); }
  if (!validSubmissionId(value)) throw new HTTPException(400, { message: "Invalid upload identifier" });
  return value;
}
function captureOperation(request: Request): Scope {
  const url = new URL(request.url); if ([...url.searchParams.keys()].length) throw denied();
  const collection = url.pathname === "/api/comment-submissions";
  const state = /^\/api\/comment-submissions\/([^/]+)\/acceptance$/.exec(url.pathname);
  const content = /^\/api\/comment-submissions\/([^/]+)\/items\/([^/]+)\/content$/.exec(url.pathname);
  const item = /^\/api\/comment-submissions\/([^/]+)\/items\/([^/]+)$/.exec(url.pathname);
  const action = /^\/api\/comment-submissions\/([^/]+)\/(finalize|cancel)$/.exec(url.pathname);
  const operation = collection && request.method === "POST" ? "create" : state && request.method === "GET" ? "state"
    : content && request.method === "PUT" ? "uploadItem" : item && request.method === "DELETE" ? "removeItem"
      : action && request.method === "POST" ? action[2] as "finalize" | "cancel" : undefined;
  if (!operation || request.bodyUsed) throw denied();
  return Object.freeze({ operation, submissionId: collection ? undefined : id((state ?? content ?? item ?? action)![1]!),
    itemId: content || item ? id((content ?? item)![2]!) : undefined });
}
const typedCommentFile = `EXISTS(SELECT 1 FROM comment_submission_items item
  JOIN comment_submissions parent ON parent.id=item.submission_id
  JOIN comment_item_acceptances accepted ON accepted.item_id=item.id AND accepted.submission_id=parent.id
  JOIN assets asset ON asset.id=item.asset_id AND asset.file_id=item.file_id
  LEFT JOIN imports imported ON imported.id=asset.import_id
  JOIN file_usable_publications publication ON publication.file_id=item.file_id AND publication.purpose=accepted.purpose
  WHERE item.id=? AND parent.id=? AND item.file_id=? AND accepted.purpose=?
    AND item.status='ready' AND item.deleted_at IS NULL AND parent.status<>'cancelled' AND parent.deleted_at IS NULL
    AND ${visibleCommentTargetsSql("parent")}
    AND accepted.status='ready' AND asset.status='ready' AND asset.r2_key IS NULL
    AND item.kind IN('attachment','comment_image') AND accepted.purpose=CASE WHEN item.kind='attachment' THEN 'research_source'
      WHEN item.related_item_id IS NOT NULL THEN 'derived_preview' ELSE 'embedded_content' END
    AND (asset.import_id IS NULL OR imported.status='ready')
    AND item.sha256=accepted.expected_sha256 AND item.byte_size=accepted.expected_byte_size
    AND asset.sha256=accepted.expected_sha256 AND asset.byte_size=accepted.expected_byte_size
    AND publication.access_scope='system' AND publication.verified_sha256=accepted.expected_sha256
    AND publication.verified_byte_size=accepted.expected_byte_size
    AND json_valid(accepted.accepted_result_json)
    AND json_extract(accepted.accepted_result_json,'$.schema')='comment-upload/3'
    AND json_extract(accepted.accepted_result_json,'$.storeKind')='file'
    AND json_extract(accepted.accepted_result_json,'$.provider')='local'
    AND json_extract(accepted.accepted_result_json,'$.blobRecordId')=asset.id
    AND json_extract(accepted.accepted_result_json,'$.fileId')=item.file_id
    AND json_extract(accepted.accepted_result_json,'$.sha256')=accepted.expected_sha256
    AND json_extract(accepted.accepted_result_json,'$.byteSize')=accepted.expected_byte_size
    AND json_extract(accepted.accepted_result_json,'$.storageProfileId')=accepted.storage_profile_id
    AND json_extract(accepted.accepted_result_json,'$.storageProfileRevision')=accepted.storage_profile_revision
    AND asset.storage_profile_id=accepted.storage_profile_id AND asset.storage_profile_revision=accepted.storage_profile_revision
    AND asset.object_key=json_extract(accepted.accepted_result_json,'$.objectKey'))`;
function typedCommentReadFile(includeTrash: boolean): string {
  if (!includeTrash) return typedCommentFile;
  // Original attachment export keeps ready published canonical items in Trash;
  // download/Sample detail and acceptance verification retain live predicates.
  return typedCommentFile.replace(" AND item.deleted_at IS NULL", "")
    .replace(" AND parent.deleted_at IS NULL", "").replace(`    AND ${visibleCommentTargetsSql("parent")}\n`, "");
}

// Closed internal SQL only. The same lossless SQLite JSON tuple is captured
// before actual I/O, compared after its first ACK, and compared in the final
// joined native BEGIN. No row, SQL, provider or mutable snapshot escapes.
const sampleAttachmentSnapshotSql = `SELECT json_array(
  source.id,source.submission_id,source.asset_id,source.file_id,source.kind,source.related_item_id,
  source.status,source.deleted_at,source.sha256,source.byte_size,source.filename,source.mime_type,
  accepted.status,accepted.expected_sha256,accepted.expected_byte_size,accepted.storage_profile_id,
  accepted.storage_profile_revision,accepted.purpose,accepted.accepted_result_json,
  asset.id,asset.import_id,asset.status,asset.r2_key,asset.sha256,asset.byte_size,
  asset.storage_profile_id,asset.storage_profile_revision,asset.object_key,
  file.id,file.purpose,file.access_scope,file.expected_byte_size,file.expected_sha256,
  file.verified_sha256,file.state,file.active_location_id,file.created_at,
  publication.file_id,publication.purpose,publication.access_scope,publication.verified_byte_size,
  publication.verified_sha256,publication.active_location_id,publication.state,publication.published_at,publication.retired_at,
  location.location_id,location.file_id,location.storage_profile_id,location.object_key,
  location.verified_byte_size,location.verified_sha256,location.verification_method,
  location.verification_operation_id,location.verified_at,location.published_at,
  profile.id,profile.adapter_type,profile.namespace_identity,profile.configuration_source,
  profile.credential_reference,profile.configuration_revision,profile.state,profile.created_at,
  runtime.state,runtime.registered_at,runtime.activated_at,runtime.retired_at,
  binding.installation_id,binding.root_binding_id,binding.binding_id,binding.binding_revision,
  binding.admission_operation_id,binding.namespace_sha256,binding.binding_fingerprint_sha256,
  binding.access,binding.state,binding.created_at,binding.updated_at,
  authority.mode,authority.revision,authority.updated_at,authority.activated_at,execution.enabled,execution.incarnation,
  (SELECT json_array(catalog_id,bootstrap_principal_id,initialized_at) FROM local_identity_installation WHERE singleton=1),
  (SELECT json_group_array(json(role_tuple)) FROM (SELECT json_array(role,storage_profile_id,
    storage_profile_revision,policy_revision,created_at) role_tuple FROM storage_role_defaults ORDER BY role)),
  (SELECT json_group_array(json(role_tuple)) FROM (SELECT json_array(history.policy_revision,history.role,
    history.storage_profile_id,history.storage_profile_revision,history.operation_id,history.actor,history.created_at) role_tuple
    FROM storage_role_policy_revisions history JOIN storage_role_defaults selected
      ON selected.role=history.role AND selected.policy_revision=history.policy_revision ORDER BY history.role))
  ) AS projection_snapshot,COALESCE(source.filename,'attachment') AS filename,source.mime_type
  FROM comment_submission_items source
  JOIN comment_item_acceptances accepted ON accepted.item_id=source.id AND accepted.submission_id=source.submission_id
  JOIN assets asset ON asset.id=source.asset_id AND asset.file_id=source.file_id
  JOIN files file ON file.id=source.file_id
  JOIN file_usable_publications publication ON publication.file_id=source.file_id AND publication.purpose=accepted.purpose
  JOIN file_location_publications location ON location.location_id=publication.active_location_id AND location.file_id=source.file_id
  JOIN storage_profiles profile ON profile.id=location.storage_profile_id AND profile.adapter_type='local' AND profile.configuration_revision=1
  JOIN storage_profile_runtime runtime ON runtime.storage_profile_id=profile.id AND runtime.state IN('read_only','read_write')
  JOIN local_storage_profile_bindings binding ON binding.storage_profile_id=profile.id AND binding.state='available'
  JOIN file_authority_control authority ON authority.singleton=1 AND authority.mode='active'
  JOIN file_authority_runtime_guard execution ON execution.singleton=authority.singleton AND execution.enabled=1
  WHERE source.id=? AND source.submission_id=? AND source.file_id=? AND accepted.purpose=?`;

const projectionInputNames = Object.freeze(["itemId", "submissionId", "fileId", "purpose"] as const);
function projectionCorrelated(sql: string): string {
  let ordinal = 0;
  const result = sql.replace(/\?/g, () => {
    const name = projectionInputNames[ordinal++];
    if (!name) throw unavailable();
    return `json_extract(proof.value,'$.${name}')`;
  });
  if (ordinal !== 4) throw unavailable();
  return result;
}

/** Unmounted genuine V28 canonical Comment authority. The fixed live Request
 * path selects the consumer and operation. Current local session/member and
 * every declared/actual occurrence/audit Sample root are checked in each original
 * native BEGIN. Existing Comment author/replay/CAS/publication algorithms remain
 * authoritative. A File receipt identifies bytes; it is never a Group grant.
 * This owner neither installs/activates profiles nor enables Group/File/runtime. */
export function createLocalCommentPermissionV28Candidate(options: {
  opening: LocalVolumeProfileOpeningV28Candidate; authentication: object; admission: ReviewedInstallationAdmission;
}) {
  if (Object.keys(options).sort().join(",") !== "admission,authentication,opening") throw unavailable();
  const { opening, authentication, admission } = options;
  const physical = ownedLocalVolumeProfileContextV28Candidate(opening);
  const { database, nativeDatabase } = physical;
  const auth = localAuthenticationIdentityAuthority(authentication);
  const identity = ownedLocalVolumeIdentityV28Candidate(opening, authentication, admission);
  const issuer = createLocalVolumeRequestSubjectIssuerV28Candidate({ opening, authentication, admission });
  const installation = identity.installation, localIssuer = `node-installation:${installation.installationId}`;
  let active = true;
  const captures = new WeakMap<LocalCommentPermissionV28Candidate, Session>();
  type ReadOwner = Readonly<{ session: Session; itemId: string; submissionId: string;
    fileId: string; purpose: FilePurpose; sampleId?: string; kind: string;
    assertCurrent(): void; checks(): readonly SqliteBatchAdmissionCheck[] }>;
  const readOwners = new WeakMap<LocalCommentReadV28Candidate, ReadOwner>();
  const projectionSnapshots = new WeakMap<LocalCommentSampleProjectionSnapshotV28Candidate,
    Readonly<{ owner: ReadOwner; snapshot: string; description: LocalCommentReadDescriptionV28Candidate }>>();
  function current(session: Session) {
    if (!active || localAuthenticationIdentityAuthority(authentication) !== auth
      || session.request.method !== session.method || session.request.url !== session.url) throw denied();
    // This opening-bound issuer performs one fresh full original identity
    // proof plus the same private opening/physical checks synchronously.
    const facts = issuer.read(session.request, session.subject);
    if (facts.provider !== "local" || facts.issuer !== localIssuer || facts.subject !== session.principalId
      || auth.currentSessionPredicate(session.request, session.actor).tokenHash !== session.tokenHash) throw denied();
  }
  function base(session: Session): SqliteBatchAdmissionCheck[] {
    current(session);
    return [
      { statement: database.prepare(`SELECT 1 admitted FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id
        CROSS JOIN (WITH observed AS MATERIALIZED (SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) now) SELECT now FROM observed) clock
        WHERE s.token_hash=? AND a.principal_id=? AND a.enabled=1 AND s.credential_revision=a.credential_revision
          AND a.credential_revision=? AND s.created_at=? AND s.revoked_at IS NULL
          AND typeof(clock.now)='integer' AND clock.now BETWEEN 0 AND 9007199254740991
          AND clock.now>=s.last_seen_at AND clock.now<s.absolute_expires_at AND clock.now<s.last_seen_at+? LIMIT 1`)
        .bind(session.tokenHash, session.principalId, session.credentialRevision, session.createdAt, identity.policy.idleLifetimeMs),
        rejection: new HTTPException(401, { message: "Current local authentication is required." }) },
      { statement: database.prepare(`SELECT 1 admitted WHERE
        EXISTS(SELECT 1 FROM node_installation WHERE singleton=1 AND installation_id=? AND catalog_id=? AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)
        AND EXISTS(SELECT 1 FROM collaboration_control WHERE singleton=1 AND schema_version=2 AND enforcement='enabled')`)
        .bind(installation.installationId, installation.catalogId, installation.checkpointId, installation.schemaSha256, installation.createdAt), rejection: unavailable() },
      { statement: database.prepare(`SELECT 1 admitted FROM collaboration_identities i JOIN collaboration_members m ON m.member_id=i.member_id
        WHERE i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active' LIMIT 1`)
        .bind(localIssuer, session.principalId), rejection: denied() },
    ];
  }
  async function session(request: Request): Promise<Session> {
    if (!(request instanceof Request)) throw denied();
    physical.assertCurrent(); identity.assertCurrent();
    const tokenHash = auth.captureSessionDigest(request), subject = await issuer.issue(request), facts = issuer.read(request, subject);
    if (!active || facts.provider !== "local" || facts.issuer !== localIssuer) throw denied();
    const actor = `local-account:${facts.subject}`;
    if (auth.currentSessionPredicate(request, actor).tokenHash !== tokenHash) throw denied();
    const statement = nativeDatabase.prepare("SELECT a.credential_revision,s.created_at FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id WHERE s.token_hash=? AND a.principal_id=?");
    statement.setReadBigInts(true); const row = statement.get(tokenHash, facts.subject); issuer.read(request, subject);
    if (typeof row?.credential_revision !== "bigint" || typeof row.created_at !== "bigint") throw denied();
    const value = Object.freeze({ request, subject, principalId: facts.subject, actor, tokenHash,
      credentialRevision: row.credential_revision, createdAt: row.created_at, method: request.method, url: request.url });
    await runSqliteAdmittedBatch(database, [], createSqliteBatchAdmission(database, base(value))); return value;
  }
  async function captureAcceptance(request: Request): Promise<LocalCommentPermissionV28Candidate> {
    const scope = captureOperation(request), selected = await session(request);
    let input: AcceptedCommentSubmissionInput | undefined, inputJson: string | undefined;
    let body: Promise<ArrayBuffer> | undefined;
    if (scope.operation !== "create") {
      const saved = await runSqliteAdmittedBatch(database, [database.prepare(`SELECT request_input_json FROM comment_submission_acceptances
        WHERE submission_id=? AND actor_email=?`).bind(scope.submissionId!, selected.actor)], createSqliteBatchAdmission(database, base(selected)));
      const json = saved[0]?.results[0]?.request_input_json;
      if (typeof json !== "string") throw new HTTPException(404, { message: "Comment submission not found" });
      try { input = validateCommentAcceptanceInput(JSON.parse(json)); } catch { throw unavailable(); }
      if (input.id !== scope.submissionId) throw unavailable(); inputJson = json;
    }
    function business(file?: Readonly<{ fileId: string; purpose: FilePurpose }>): readonly SqliteBatchAdmissionCheck[] {
      const checks = base(selected); if (!input) throw denied();
      const targets = input.context.kind === "sample" ? [{ sampleId: input.context.sampleId, runId: null, stepId: null }]
        : input.context.targets.map(target => ({ sampleId: target.sampleId, runId: target.runId, stepId: target.stepId }));
      const capability = scope.operation === "state" ? "read" : scope.operation === "removeItem" ? "edit" : "operate";
      const grant = capability === "read" ? "(resource.visibility='workspace' OR(grant.enabled=1 AND grant.capability IN('read','operate','edit','manage')))"
        : capability === "edit" ? "grant.enabled=1 AND grant.capability IN('edit','manage')" : "grant.enabled=1 AND grant.capability IN('operate','edit','manage')";
      const persisted = `actual_paths(root_id,invalid) AS (
        SELECT parent.sample_id,(parent.sample_id IS NULL) FROM comment_submissions parent WHERE parent.id=? AND parent.context_kind='sample'
        UNION ALL SELECT run.sample_id,(step.id IS NULL OR run.id IS NULL OR run.sample_id IS NOT target.sample_id)
          FROM comment_submission_targets target LEFT JOIN run_steps step ON step.id=target.run_step_id AND step.run_id=target.run_id
          LEFT JOIN runs run ON run.id=target.run_id WHERE target.submission_id=?
        UNION ALL SELECT run.sample_id,(step.id IS NULL OR run.id IS NULL) FROM run_step_comments occurrence
          LEFT JOIN run_steps step ON step.id=occurrence.run_step_id LEFT JOIN runs run ON run.id=step.run_id WHERE occurrence.submission_id=?
        UNION ALL SELECT audit.sample_id,(audit.sample_id IS NULL) FROM events audit WHERE audit.kind='comment'
          AND json_extract(CASE WHEN json_valid(audit.metadata_json) THEN audit.metadata_json ELSE '{}' END,'$.submissionId')=?)`;
      const typed = file ? ` AND ${typedCommentFile.replace('item.id=?', 'item.submission_id=?')}` : "";
      checks.push({ statement: database.prepare(`SELECT 1 admitted WHERE EXISTS(WITH member AS (SELECT member_id FROM collaboration_identities i JOIN collaboration_members m USING(member_id)
          WHERE i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'),
        declared(sample_id,run_id,step_id) AS (SELECT json_extract(value,'$.sampleId'),json_extract(value,'$.runId'),json_extract(value,'$.stepId') FROM json_each(?)),
        ${persisted}, all_paths(root_id,invalid) AS (
          SELECT d.sample_id,(s.id IS NULL OR s.deleted_at IS NOT NULL OR(d.run_id IS NOT NULL AND
            (r.id IS NULL OR r.deleted_at IS NOT NULL OR rs.id IS NULL OR rs.deleted_at IS NOT NULL)))
          FROM declared d LEFT JOIN samples s ON s.id=d.sample_id LEFT JOIN runs r ON r.id=d.run_id AND r.sample_id=d.sample_id
          LEFT JOIN run_steps rs ON rs.id=d.step_id AND rs.run_id=d.run_id UNION ALL SELECT root_id,invalid FROM actual_paths)
        SELECT 1 admitted WHERE (SELECT count(*) FROM declared) BETWEEN 1 AND 12
          AND NOT EXISTS(SELECT 1 FROM all_paths path LEFT JOIN samples sample ON sample.id=path.root_id
            WHERE path.invalid IS NOT 0 OR sample.id IS NULL OR sample.deleted_at IS NOT NULL OR NOT EXISTS(
              SELECT 1 FROM member m JOIN collaboration_resources resource ON resource.root_kind='sample' AND resource.root_id=sample.id
              LEFT JOIN collaboration_grants grant ON grant.root_kind=resource.root_kind AND grant.root_id=resource.root_id AND grant.member_id=m.member_id
              WHERE ${grant}))
          AND NOT EXISTS(SELECT 1 FROM comment_submission_acceptances WHERE submission_id=? AND
            (actor_email IS NOT ? ${inputJson === undefined ? "" : "OR request_input_json IS NOT ?"}))${typed})`)
        .bind(localIssuer, selected.principalId, JSON.stringify(targets), input.id, input.id, input.id, input.id,
          input.id, selected.actor, ...(inputJson === undefined ? [] : [inputJson]),
          ...(file ? [input.id, input.id, file.fileId, file.purpose] : [])), rejection: denied() });
      return checks;
    }
    const token = Object.freeze({}) as LocalCommentPermissionV28Candidate;
    const owner: PermissionOwner = Object.freeze({ opening, request, actor: selected.actor, scope,
      access: scope.operation === "state" ? "read" : "write",
      assertCurrent() { current(selected); }, preflight: () => base(selected), business,
      final: () => input === undefined ? base(selected) : business(),
      boundedBody(maximum: number) {
        current(selected);
        if (scope.operation !== "create") return readOwnedCommentAcceptanceBody(request, maximum);
        if (maximum !== MAX_COMMENT_ACCEPTANCE_INPUT_BYTES) throw denied();
        return body ??= (async () => {
          const buffer = await readOwnedCommentAcceptanceBody(request, maximum); current(selected);
          let raw: unknown; try { raw = JSON.parse(new TextDecoder().decode(buffer)); } catch { return buffer; }
          // The complete original service owns validation/error status. Invalid
          // bodies cannot issue target authority or reach any business SQL.
          try { input = validateCommentAcceptanceInput(raw); } catch { return buffer; }
          await runSqliteAdmittedBatch(database, [], createSqliteBatchAdmission(database, business())); return buffer;
        })();
      },
    });
    permissions.set(token, owner); captures.set(token, selected);
    if (input) await runSqliteAdmittedBatch(database, [], createSqliteBatchAdmission(database, business()));
    return token;
  }
  async function captureConsumerRead(request: Request, consumer: LocalCommentReadConsumerV28Candidate): Promise<LocalCommentReadV28Candidate> {
    const url = new URL(request.url);
    const match = /^\/api\/(?:attachments\/([^/]+)\/download|exports\/attachments\/([^/]+))$/.exec(url.pathname);
    const detail = /^\/api\/samples\/([^/]+)$/.exec(url.pathname);
    if (request.method !== "GET" || request.bodyUsed || !consumer || Object.keys(consumer).sort().join(",") !== "itemId,kind"
      || !["canonical-comment-attachment", "canonical-comment-image"].includes(consumer.kind) || !validSubmissionId(consumer.itemId)
      || (!match && !detail) || [...url.searchParams.keys()].length) throw denied();
    const itemId = consumer.itemId;
    if (match && (consumer.kind !== "canonical-comment-attachment" || id((match[1] ?? match[2])!) !== itemId)) throw denied();
    const kind = consumer.kind === "canonical-comment-attachment" ? "attachment" : "comment_image";
    const fileSql = typedCommentReadFile(match?.[2] !== undefined);
    let sampleId: string | undefined;
    try { sampleId = detail ? decodeURIComponent(detail[1]!) : undefined; }
    catch { throw new HTTPException(400, { message: "Invalid Sample consumer identifier" }); }
    if (sampleId !== undefined && (!sampleId || sampleId.length > 256 || sampleId.includes("\0"))) throw denied();
    const selected = await session(request);
    // A Sample detail selector must be an actual canonical occurrence of that
    // addressed Sample; caller-selected IDs cannot import unrelated content.
    const addressed = sampleId === undefined ? "" : ` AND EXISTS(SELECT 1 FROM comment_submissions parent WHERE parent.id=source.submission_id AND
      ((parent.context_kind='sample' AND parent.sample_id=?) OR EXISTS(
        SELECT 1 FROM comment_submission_targets target WHERE target.submission_id=parent.id AND target.sample_id=?)))`;
    const addressedValues = sampleId === undefined ? [] : [sampleId, sampleId];
    const sql = `WITH member AS (SELECT member_id FROM collaboration_identities i JOIN collaboration_members m USING(member_id)
      WHERE i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active')
      SELECT source.submission_id,source.file_id,accepted.purpose FROM comment_submission_items source
      JOIN comment_item_acceptances accepted ON accepted.item_id=source.id AND accepted.submission_id=source.submission_id
      WHERE source.id=? AND source.kind=? AND ${canonicalCommentReadCheckSql("comment_attachment", "source.id")}${addressed}`;
    const initial = await runSqliteAdmittedBatch(database, [database.prepare(sql).bind(localIssuer, selected.principalId, itemId, kind, ...addressedValues)],
      createSqliteBatchAdmission(database, base(selected)));
    const row = initial[0]?.results[0];
    if (!row || typeof row.submission_id !== "string" || typeof row.file_id !== "string"
      || !["research_source", "embedded_content", "derived_preview"].includes(row.purpose as string)) throw denied();
    const submissionId = row.submission_id, fileId = row.file_id, purpose = row.purpose as FilePurpose;
    function checks(): readonly SqliteBatchAdmissionCheck[] {
      return [...base(selected), { statement: database.prepare(`SELECT 1 admitted WHERE EXISTS(${sql}) AND ${fileSql}`)
        .bind(localIssuer, selected.principalId, itemId, kind, ...addressedValues, itemId, submissionId, fileId, purpose), rejection: denied() }];
    }
    await runSqliteAdmittedBatch(database, [], createSqliteBatchAdmission(database, checks()));
    const token = Object.freeze({}) as LocalCommentReadV28Candidate;
    readOwners.set(token, Object.freeze({ session: selected, itemId, submissionId, fileId, purpose, sampleId, kind,
      assertCurrent: () => current(selected), checks })); return token;
  }
  function captureCommentRead(request: Request): Promise<LocalCommentReadV28Candidate> {
    const match = /^\/api\/(?:attachments\/([^/]+)\/download|exports\/attachments\/([^/]+))$/.exec(new URL(request.url).pathname);
    if (!match) throw denied();
    return captureConsumerRead(request, Object.freeze({ kind: "canonical-comment-attachment", itemId: id((match[1] ?? match[2])!) }));
  }
  return Object.freeze({ captureAcceptance, captureCommentRead, captureConsumerRead,
    actor(request: Request, token: LocalCommentPermissionV28Candidate) {
      const selected = captures.get(token); if (!selected || selected.request !== request) throw denied(); current(selected); return selected.actor;
    },
    readSelection(request: Request, token: LocalCommentReadV28Candidate) {
      const owner = readOwners.get(token); if (!owner || owner.session.request !== request) throw denied(); owner.assertCurrent();
      return Object.freeze({ fileId: owner.fileId, purpose: owner.purpose });
    },
    async describeRead(request: Request, token: LocalCommentReadV28Candidate) {
      const owner = readOwners.get(token); if (!owner || owner.session.request !== request) throw denied(); owner.assertCurrent();
      // Original attachment route metadata is selected only in the same
      // native transaction as every current root/member/typed publication check.
      // These fields identify presentation, never availability or a File grant.
      const selected = await runSqliteAdmittedBatch(database, [database.prepare(`SELECT
        COALESCE(filename,'attachment') AS filename,mime_type FROM comment_submission_items
        WHERE id=? AND submission_id=? AND file_id=?`).bind(owner.itemId, owner.submissionId, owner.fileId)],
        createSqliteBatchAdmission(database, owner.checks()));
      const row = selected[0]?.results[0];
      if (!row || typeof row.filename !== "string" || (row.mime_type !== null && typeof row.mime_type !== "string")) throw denied();
      const description: LocalCommentReadDescriptionV28Candidate = Object.freeze({ fileId: owner.fileId, purpose: owner.purpose,
        filename: row.filename, mimeType: row.mime_type });
      return description;
    },
    async captureSampleProjectionSnapshot(request: Request, token: LocalCommentReadV28Candidate) {
      const owner = readOwners.get(token);
      if (!owner || owner.session.request !== request || owner.sampleId === undefined || owner.kind !== "attachment") throw denied();
      owner.assertCurrent();
      const result = await runSqliteAdmittedBatch(database, [database.prepare(sampleAttachmentSnapshotSql)
        .bind(owner.itemId, owner.submissionId, owner.fileId, owner.purpose)], createSqliteBatchAdmission(database, owner.checks()));
      const row = result[0]?.results[0];
      if (!row || typeof row.projection_snapshot !== "string" || typeof row.filename !== "string"
        || row.mime_type !== null && typeof row.mime_type !== "string") throw denied();
      const description: LocalCommentReadDescriptionV28Candidate = Object.freeze({ fileId: owner.fileId,
        purpose: owner.purpose, filename: row.filename, mimeType: row.mime_type });
      const snapshot = Object.freeze({}) as LocalCommentSampleProjectionSnapshotV28Candidate;
      projectionSnapshots.set(snapshot, Object.freeze({ owner, snapshot: row.projection_snapshot, description }));
      return Object.freeze({ description, snapshot });
    },
    async confirmSampleProjectionSnapshot(request: Request, snapshot: LocalCommentSampleProjectionSnapshotV28Candidate) {
      const record = projectionSnapshots.get(snapshot);
      if (!record || record.owner.session.request !== request) throw denied();
      const owner = record.owner; owner.assertCurrent();
      const result = await runSqliteAdmittedBatch(database, [database.prepare(sampleAttachmentSnapshotSql)
        .bind(owner.itemId, owner.submissionId, owner.fileId, owner.purpose)], createSqliteBatchAdmission(database, owner.checks()));
      const row = result[0]?.results[0];
      if (!row || row.projection_snapshot !== record.snapshot || row.filename !== record.description.filename
        || row.mime_type !== record.description.mimeType) throw denied();
      return record.description;
    },
    sampleProjectionFinalAdmission(request: Request, snapshots: readonly LocalCommentSampleProjectionSnapshotV28Candidate[]) {
      if (!Array.isArray(snapshots) || !snapshots.length) throw denied();
      if (snapshots.length > MAX_LOCAL_COMMENT_SAMPLE_ATTACHMENT_PROOFS_V28_CANDIDATE)
        throw new HTTPException(413, { message: "Canonical attachment projection exceeds the supported bound." });
      const selected = snapshots.map(snapshot => projectionSnapshots.get(snapshot));
      if (selected.some(record => !record || record.owner.session.request !== request)) throw denied();
      const records = selected.map(record => record!);
      const first = records[0]!.owner, session = first.session;
      first.assertCurrent();
      if (first.sampleId === undefined || first.kind !== "attachment") throw denied();
      const seen = new Set<string>();
      const values = records.map(record => {
        const owner = record.owner; owner.assertCurrent();
        if (owner.kind !== "attachment" || owner.sampleId !== first.sampleId
          || owner.session.principalId !== session.principalId || owner.session.tokenHash !== session.tokenHash
          || owner.session.credentialRevision !== session.credentialRevision || owner.session.createdAt !== session.createdAt
          || seen.has(owner.itemId)) throw denied();
        seen.add(owner.itemId);
        return Object.freeze({ itemId: owner.itemId, submissionId: owner.submissionId, fileId: owner.fileId,
          purpose: owner.purpose, snapshot: record.snapshot });
      });
      const encoded = JSON.stringify(values);
      if (new TextEncoder().encode(encoded).byteLength > MAX_LOCAL_COMMENT_SAMPLE_ATTACHMENT_GUARD_BYTES_V28_CANDIDATE)
        throw new HTTPException(413, { message: "Canonical attachment projection exceeds the supported bound." });
      // SQLite constructs each snapshot without converting native integers to
      // JavaScript Number. Session BigInts stay canonical decimal text until
      // this same native BEGIN compares them with the original integer fields.
      const snapshotSql = projectionCorrelated(sampleAttachmentSnapshotSql.replace(
        " AS projection_snapshot,COALESCE(source.filename,'attachment') AS filename,source.mime_type", ""));
      const fileSql = projectionCorrelated(typedCommentFile);
      const sql = `SELECT 1 admitted WHERE EXISTS(WITH member AS (SELECT member_id FROM collaboration_identities i JOIN collaboration_members m USING(member_id)
        WHERE i.provider='local' AND i.issuer=? AND i.subject=? AND i.enabled=1 AND m.state='active'),
        proofs AS (SELECT value FROM json_each(?))
        SELECT 1 WHERE
        EXISTS(SELECT 1 FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id
          CROSS JOIN (WITH observed AS MATERIALIZED (SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) now) SELECT now FROM observed) clock
          WHERE s.token_hash=? AND a.principal_id=? AND a.enabled=1 AND s.credential_revision=a.credential_revision
            AND CAST(a.credential_revision AS TEXT)=? AND CAST(s.created_at AS TEXT)=? AND s.revoked_at IS NULL
            AND typeof(clock.now)='integer' AND clock.now BETWEEN 0 AND 9007199254740991
            AND clock.now>=s.last_seen_at AND clock.now<s.absolute_expires_at AND clock.now<s.last_seen_at+?)
        AND EXISTS(SELECT 1 FROM node_installation WHERE singleton=1 AND installation_id=? AND catalog_id=?
          AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)
        AND EXISTS(SELECT 1 FROM collaboration_control WHERE singleton=1 AND schema_version=2 AND enforcement='enabled')
        AND EXISTS(SELECT 1 FROM member)
        AND EXISTS(SELECT 1 FROM system_recovery_maintenance WHERE singleton=1 AND state='open')
        AND json_valid(?) AND json_type(?)='array' AND (SELECT count(*) FROM proofs)=?
        AND NOT EXISTS(SELECT 1 FROM proofs proof WHERE
          NOT EXISTS(SELECT 1 FROM comment_submission_items source
            WHERE source.id=json_extract(proof.value,'$.itemId') AND source.kind='attachment'
              AND source.submission_id=json_extract(proof.value,'$.submissionId') AND source.file_id=json_extract(proof.value,'$.fileId')
              AND ${canonicalCommentReadCheckSql("comment_attachment", "source.id")}
              AND EXISTS(SELECT 1 FROM comment_submissions parent WHERE parent.id=source.submission_id AND
                ((parent.context_kind='sample' AND parent.sample_id=?) OR EXISTS(SELECT 1 FROM comment_submission_targets target
                  WHERE target.submission_id=parent.id AND target.sample_id=?))))
          OR NOT (${fileSql})
          OR (${snapshotSql}) IS NOT json_extract(proof.value,'$.snapshot')))`;
      const statement = database.prepare(sql).bind(localIssuer, session.principalId, encoded,
        session.tokenHash, session.principalId, session.credentialRevision.toString(), session.createdAt.toString(), identity.policy.idleLifetimeMs,
        installation.installationId, installation.catalogId, installation.checkpointId, installation.schemaSha256, installation.createdAt,
        encoded, encoded, records.length, first.sampleId, first.sampleId);
      return createSqliteBatchAdmission(database, [{ statement, rejection: denied() }]);
    },
    readExecutionPermission(request: Request, token: LocalCommentReadV28Candidate): LocalCommentPermissionV28Candidate {
      const owner = readOwners.get(token); if (!owner || owner.session.request !== request) throw denied(); owner.assertCurrent();
      const permission = Object.freeze({}) as LocalCommentPermissionV28Candidate;
      permissions.set(permission, Object.freeze({ opening, request, actor: owner.session.actor,
        scope: Object.freeze({ operation: "state" as const, submissionId: owner.submissionId, itemId: owner.itemId }), access: "read" as const,
        assertCurrent: owner.assertCurrent, preflight: () => base(owner.session), final: owner.checks,
        business(file?: Readonly<{ fileId: string; purpose: FilePurpose }>) {
          if (file && (file.fileId !== owner.fileId || file.purpose !== owner.purpose)) throw denied(); return owner.checks();
        }, boundedBody() { throw denied(); },
      }));
      captures.set(permission, owner.session); return permission;
    }, discard() { active = false; },
  });
}

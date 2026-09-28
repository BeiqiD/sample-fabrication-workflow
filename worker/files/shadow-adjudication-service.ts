import { checkedShadowAdjudicationRequest, checkedShadowAdjudicationRevocationRequest,
  shadowAdjudicationRequestSha256, shadowAdjudicationRevocationRequestSha256,
  MAX_SHADOW_ADJUDICATION_REQUEST_BYTES, type ShadowAdjudicationRequest, type ShadowAdjudicationRevocationRequest } from "../../shared/contracts/file-shadow-adjudication";
import { stableJson } from "../../shared/domain/content-addressing";
import { primaryD1 } from "../d1-primary";
import { checkedFileShadowReviewKey } from "../../shared/contracts/file-shadow-evidence-review";
import { readShadowBaseline, canonicalShadowMetadata, type ShadowBaseline } from "./shadow-baseline";
import { ShadowConflictError, ShadowUnavailableError } from "./shadow-service";
import type { LiveConsumerKey } from "./live-consumer-baseline";

export interface ShadowAdjudicationContext {
  db: D1Database;
  actor: string;
  /** Checks the registered R2 profile against exact deployment binding metadata.
   * It must not register a profile or issue provider HEAD/GET/PUT requests. */
  assertProfile(profile: { profileId: string; configurationRevision: 1 }): Promise<unknown>;
  now?: () => string;
}
export interface ShadowAdjudicationResult {
  requestId: string;
  status: "accepted" | "revoked" | "withdrawn";
  request: ShadowAdjudicationRequest;
  requestSha256: string;
  createdBy: string;
  createdAt: string;
  revocation: { request: ShadowAdjudicationRevocationRequest; requestSha256: string; createdBy: string; createdAt: string } | null;
}
export interface ShadowAdjudicationPreparation {
  key: LiveConsumerKey;
  eligible: boolean;
  blockers: string[];
  preconditions: Pick<ShadowAdjudicationRequest, "occurrenceId" | "generation" | "sourceSha256" | "sourceLocator"
    | "expectedBaselineSha256" | "expectedEpoch" | "expectedIncarnation" | "supersedesId"> | null;
  profiles: { profileId: string; configurationRevision: 1 }[];
  activeAdjudication: ShadowAdjudicationResult | null;
  revocable: boolean;
  revocationBlockers: string[];
}
interface ReceiptRow { id: string; request_json: string; request_sha256: string; created_by: string; created_at: string;
  withdrawn: number; revocation_json: string | null }
const encoder = new TextEncoder();
export class ShadowAdjudicationUnavailableError extends ShadowUnavailableError {
  constructor(message = "The evidence request outcome is unavailable. Keep the original request for readback or withdrawal.") { super(); this.message = message; }
}
function snapshotContext(context: ShadowAdjudicationContext) {
  if (typeof context.actor !== "string" || !context.actor.trim() || context.actor.length > 256 || context.actor.includes("\0") || encoder.encode(context.actor).length > 1024)
    throw new ShadowConflictError("An authenticated evidence operator is required.");
  return { ...context };
}
function timestamp(context: ShadowAdjudicationContext) {
  const time = context.now?.() ?? new Date().toISOString();
  if (typeof time !== "string" || !Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time)
    throw new ShadowConflictError("Invalid evidence timestamp.");
  return time;
}
async function observed(database: D1Database, requestId: string): Promise<ShadowAdjudicationResult | null> {
  const row = await primaryD1(database).prepare(`SELECT a.id,a.request_json,a.request_sha256,a.created_by,a.created_at,0 withdrawn,
    (SELECT json_object('request_json',r.request_json,'request_sha256',r.request_sha256,'created_by',r.created_by,'created_at',r.created_at)
      FROM file_shadow_adjudication_revocations r WHERE r.adjudication_id=a.id) revocation_json
    FROM file_shadow_adjudications a WHERE a.id=?
    UNION ALL SELECT request_id,request_json,request_sha256,created_by,created_at,1,NULL
      FROM file_shadow_adjudication_withdrawals WHERE request_id=?`).bind(requestId, requestId).all<ReceiptRow>();
  if (!row.success || row.results.length > 1) throw new ShadowUnavailableError();
  if (!row.results.length) return null;
  const value = row.results[0];
  if (typeof value.request_json !== "string" || encoder.encode(value.request_json).length > MAX_SHADOW_ADJUDICATION_REQUEST_BYTES) throw new ShadowUnavailableError();
  const request = checkedShadowAdjudicationRequest(JSON.parse(value.request_json));
  if (request.requestId !== requestId || stableJson(request) !== value.request_json
    || await shadowAdjudicationRequestSha256(request) !== value.request_sha256) throw new ShadowUnavailableError();
  let revocation: ShadowAdjudicationResult["revocation"] = null;
  if (value.revocation_json !== null) {
    if (encoder.encode(value.revocation_json).length > 256 * 1024) throw new ShadowUnavailableError();
    const raw = JSON.parse(value.revocation_json) as Omit<ReceiptRow, "id" | "withdrawn" | "revocation_json">;
    const revoked = checkedShadowAdjudicationRevocationRequest(JSON.parse(raw.request_json));
    if (stableJson(revoked) !== raw.request_json || revoked.adjudicationId !== requestId
      || revoked.adjudicationRequestSha256 !== value.request_sha256
      || await shadowAdjudicationRevocationRequestSha256(revoked) !== raw.request_sha256) throw new ShadowUnavailableError();
    revocation = { request: revoked, requestSha256: raw.request_sha256, createdBy: raw.created_by, createdAt: raw.created_at };
  }
  return { requestId, status: value.withdrawn ? "withdrawn" : revocation ? "revoked" : "accepted", request,
    requestSha256: value.request_sha256, createdBy: value.created_by, createdAt: value.created_at, revocation };
}
function match(result: ShadowAdjudicationResult, request: ShadowAdjudicationRequest, actor: string) {
  if (result.createdBy !== actor) throw new ShadowConflictError("This evidence request belongs to another actor.");
  if (stableJson(result.request) !== stableJson(request)) throw new ShadowConflictError("This evidence request ID was used with different input.");
  return result;
}

/** Authoritative readback preserves the original immutable request and actor;
 * absence alone does not establish that a delayed request cannot be accepted. */
export async function readShadowAdjudication(context: ShadowAdjudicationContext, input: ShadowAdjudicationRequest) {
  context = snapshotContext(context);
  const request = checkedShadowAdjudicationRequest(input), result = await observed(context.db, request.requestId);
  return result ? match(result, request, context.actor) : null;
}

function qualificationBlockers(baseline: ShadowBaseline): string[] {
  const blockers = baseline.reasons.filter(reason => !["consumer_purpose_unresolved", "namespace_evidence_missing", "source_profile_unresolved"].includes(reason));
  if (baseline.authority.mode !== "overlap") blockers.push("overlap_required");
  if (baseline.runtime.enabled !== 0) blockers.push("conversions_must_be_paused");
  if (!baseline.head?.present || !baseline.record) blockers.push("current_occurrence_required");
  if (baseline.decision) blockers.push("occurrence_already_decided");
  if (baseline.adjudication) blockers.push("active_adjudication_exists");
  if (baseline.key.consumerKind !== "project_content_attachment" || baseline.key.fileSlot !== "primary"
    || baseline.sourceLocator?.storeKind !== "r2" || baseline.sourceLocator.provider !== "r2") blockers.push("unsupported_evidence_scope");
  if (baseline.purpose !== null && baseline.purpose !== "research_source") blockers.push("contradictory_purpose_evidence");
  const record = baseline.record;
  if (record && (record.receipts.length || record.mappings.length)) blockers.push("existing_historical_evidence_requires_separate_review");
  if (record?.registries.some(registry => registry.import_id != null)) blockers.push("imported_source_requires_separate_review");
  if (record && [...record.receipts, ...record.mappings].some(value => value.purpose != null && value.purpose !== "research_source"))
    blockers.push("contradictory_purpose_evidence");
  if (!baseline.reasons.includes("consumer_purpose_unresolved") && !baseline.reasons.includes("namespace_evidence_missing")) blockers.push("missing_evidence_required");
  if (!record || record.registries.length !== 1 || !Number.isSafeInteger(record.registries[0].byte_size)
    || Number(record.registries[0].byte_size) < 0 || typeof record.registries[0].sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(record.registries[0].sha256)) blockers.push("expected_byte_metadata_incomplete");
  return [...new Set(blockers)].sort();
}

async function restrictedScopeBlockers(db: D1Database, baseline: ShadowBaseline): Promise<string[]> {
  if (!baseline.head || !baseline.sourceLocator) return [];
  const row = await db.prepare(`SELECT
    EXISTS(SELECT 1 FROM file_shadow_operations o WHERE o.occurrence_id=?1 AND (o.status<>'cancelled'
      OR EXISTS(SELECT 1 FROM file_shadow_attempts t WHERE t.operation_id=o.id
        AND (t.state NOT IN('failed','cancelled') OR t.write_started_at IS NOT NULL OR t.verified_at IS NOT NULL))
      OR EXISTS(SELECT 1 FROM file_shadow_decisions d WHERE d.operation_id=o.id))) unsettled,
    (EXISTS(SELECT 1 FROM attachment_derivatives d JOIN assets a ON a.id=d.derived_asset_id WHERE a.r2_key=?2)
      OR EXISTS(SELECT 1 FROM file_shadow_legacy_deletion_claims WHERE store_kind='r2' AND provider='r2' AND object_key=?2)
      OR EXISTS(SELECT 1 FROM r2_upload_requests WHERE candidate_object_key=?2
        OR CASE WHEN json_valid(accepted_result_json) THEN json_extract(accepted_result_json,'$.key') END=?2)
      OR EXISTS(SELECT 1 FROM metrology_reference_upload_requests WHERE candidate_object_key=?2
        OR CASE WHEN json_valid(accepted_result_json) THEN json_extract(accepted_result_json,'$.reference.assetKey') END=?2)
      OR EXISTS(SELECT 1 FROM comment_item_acceptances WHERE candidate_object_key=?2
        OR CASE WHEN json_valid(accepted_result_json) THEN json_extract(accepted_result_json,'$.objectKey') END=?2)) unsupported`)
    .bind(baseline.head.occurrence_id, baseline.sourceLocator.objectKey).first<{ unsettled: number; unsupported: number }>();
  if (!row) throw new ShadowUnavailableError();
  return [...(row.unsettled ? ["occurrence_work_must_be_settled"] : []), ...(row.unsupported ? ["existing_historical_evidence_requires_separate_review"] : [])];
}

async function revocationBlockers(database: D1Database, adjudicationId: string): Promise<string[]> {
  const guard = await primaryD1(database).prepare(`SELECT r.enabled,c.mode,
    (SELECT count(*) FROM file_shadow_operation_adjudications binding JOIN file_shadow_operations o ON o.id=binding.operation_id
      WHERE binding.adjudication_id=? AND (o.status<>'cancelled' OR EXISTS(
        SELECT 1 FROM file_shadow_attempts t WHERE t.operation_id=o.id AND (t.state NOT IN('failed','cancelled')
          OR t.write_started_at IS NOT NULL OR t.verified_at IS NOT NULL))
        OR EXISTS(SELECT 1 FROM file_shadow_decisions d WHERE d.operation_id=o.id))) unsettled
    FROM file_shadow_runtime_guard r JOIN file_authority_control c ON c.singleton=r.singleton WHERE r.singleton=1`)
    .bind(adjudicationId).first<{ enabled: number; mode: string; unsettled: number }>();
  if (!guard) throw new ShadowUnavailableError();
  return [...(guard.mode !== "overlap" ? ["overlap_required"] : []), ...(guard.enabled !== 0 ? ["conversions_must_be_paused"] : []),
    ...(guard.unsettled !== 0 ? ["accepted_operations_require_recovery"] : [])];
}

/** Preparation is metadata only. Profile candidates are choices, never evidence
 * of original namespace ownership. Acceptance takes its own fresh snapshot. */
export async function prepareShadowAdjudication(context: ShadowAdjudicationContext, input: LiveConsumerKey): Promise<ShadowAdjudicationPreparation> {
  context = snapshotContext(context);
  const key = checkedFileShadowReviewKey(input), baseline = await readShadowBaseline(context.db, key), db = primaryD1(context.db);
  const profiles = await db.prepare(`SELECT p.id profileId,p.configuration_revision configurationRevision
    FROM storage_profiles p JOIN storage_profile_runtime r ON r.storage_profile_id=p.id
    WHERE p.adapter_type='r2' AND p.configuration_source='bootstrap' AND p.credential_reference IS NULL
      AND p.configuration_revision=1 AND p.state='historical' AND r.state IN('read_only','read_write') ORDER BY p.id LIMIT 101`)
    .all<{ profileId: string; configurationRevision: 1 }>();
  if (!profiles.success || profiles.results.length > 100 || encoder.encode(stableJson(profiles.results)).length > 64 * 1024) throw new ShadowUnavailableError();
  const history = baseline.head ? await db.prepare(`SELECT a.id FROM file_shadow_adjudications a WHERE a.occurrence_id=?
    AND NOT EXISTS(SELECT 1 FROM file_shadow_adjudications next WHERE next.supersedes_id=a.id) LIMIT 2`)
    .bind(baseline.head.occurrence_id).all<{ id: string }>() : { success: true, results: [] };
  if (!history.success || history.results.length > 1) throw new ShadowUnavailableError();
  const latest = history.results[0] ? await observed(db, history.results[0].id) : null;
  const blockers = qualificationBlockers(baseline);
  if (!profiles.results.length) blockers.push("registered_r2_profile_required");
  blockers.push(...await restrictedScopeBlockers(db, baseline));
  const locator = baseline.sourceLocator;
  const revocationReasons = latest?.status === "accepted" ? await revocationBlockers(db, latest.requestId) : ["active_adjudication_required"];
  return { key, eligible: blockers.length === 0, blockers: [...new Set(blockers)].sort(),
    preconditions: baseline.head?.present && locator?.storeKind === "r2" && locator.provider === "r2" ? {
      occurrenceId: baseline.head.occurrence_id, generation: baseline.head.generation, sourceSha256: baseline.head.source_sha256,
      sourceLocator: { storeKind: "r2", provider: "r2", objectKey: locator.objectKey }, expectedBaselineSha256: baseline.baselineSha256,
      expectedEpoch: baseline.epoch, expectedIncarnation: baseline.runtime.incarnation, supersedesId: latest?.status === "revoked" ? latest.requestId : null,
    } : null, profiles: profiles.results, activeAdjudication: latest?.status === "accepted" ? latest : null,
    revocable: revocationReasons.length === 0, revocationBlockers: revocationReasons };
}

export async function acceptShadowAdjudication(context: ShadowAdjudicationContext, input: ShadowAdjudicationRequest): Promise<ShadowAdjudicationResult> {
  context = snapshotContext(context);
  const request = checkedShadowAdjudicationRequest(input), existing = await observed(context.db, request.requestId);
  if (existing) return match(existing, request, context.actor);
  const baseline = await readShadowBaseline(context.db, request.key);
  if (qualificationBlockers(baseline).length || baseline.baselineSha256 !== request.expectedBaselineSha256
    || baseline.epoch !== request.expectedEpoch || baseline.runtime.incarnation !== request.expectedIncarnation
    || baseline.head?.occurrence_id !== request.occurrenceId || baseline.head.generation !== request.generation
    || baseline.head.source_sha256 !== request.sourceSha256
    || canonicalShadowMetadata(baseline.sourceLocator) !== canonicalShadowMetadata(request.sourceLocator))
    throw new ShadowConflictError("Evidence changed or remains blocked. Review the current occurrence before acceptance.");
  if ([...(baseline.record?.receipts ?? []), ...(baseline.record?.mappings ?? [])].some(evidence =>
    evidence.storage_profile_id != null && (evidence.storage_profile_id !== request.sourceProfile.profileId
      || evidence.storage_profile_revision != null && evidence.storage_profile_revision !== request.sourceProfile.configurationRevision)))
    throw new ShadowConflictError("The selected profile contradicts existing namespace evidence.");
  if ((await restrictedScopeBlockers(primaryD1(context.db), baseline)).length)
    throw new ShadowConflictError("Existing evidence or unfinished work requires separate review.");
  await context.assertProfile(request.sourceProfile);
  const db = primaryD1(context.db), requestJson = stableJson(request), requestSha256 = await shadowAdjudicationRequestSha256(request), now = timestamp(context);
  try {
    await db.prepare(`INSERT INTO file_shadow_adjudications
      (id,occurrence_id,supersedes_id,request_json,request_sha256,source_json,baseline_json,source_expected_byte_size,source_expected_sha256,created_by,created_at)
      SELECT ?,?,?,?,?,h.source_json,?,?,?,?,? FROM file_shadow_heads h
      JOIN file_shadow_control control ON control.singleton=1 JOIN file_shadow_runtime_guard runtime ON runtime.singleton=1
      WHERE h.occurrence_id=? AND h.present=1 AND h.generation=? AND control.epoch=? AND runtime.enabled=0 AND runtime.incarnation IS ?`)
      .bind(request.requestId, request.occurrenceId, request.supersedesId, requestJson, requestSha256, canonicalShadowMetadata(baseline),
        baseline.record!.registries[0].byte_size, baseline.record!.registries[0].sha256, context.actor, now,
        request.occurrenceId, request.generation, request.expectedEpoch, request.expectedIncarnation).run();
  } catch { /* Only the immutable primary receipt can resolve acknowledgement loss. */ }
  const result = await observed(db, request.requestId);
  if (!result) throw new ShadowAdjudicationUnavailableError("The evidence request outcome is unavailable. Keep the original request for readback or withdrawal.");
  return match(result, request, context.actor);
}

export async function withdrawShadowAdjudication(context: ShadowAdjudicationContext, input: ShadowAdjudicationRequest): Promise<ShadowAdjudicationResult> {
  context = snapshotContext(context);
  const request = checkedShadowAdjudicationRequest(input), existing = await observed(context.db, request.requestId);
  if (existing) return match(existing, request, context.actor);
  const db = primaryD1(context.db), requestJson = stableJson(request), sha = await shadowAdjudicationRequestSha256(request), now = timestamp(context);
  try {
    await db.prepare(`INSERT INTO file_shadow_adjudication_withdrawals(request_id,request_json,request_sha256,created_by,created_at)
      VALUES(?,?,?,?,?)`).bind(request.requestId, requestJson, sha, context.actor, now).run();
  } catch { /* A racing acceptance/withdrawal is resolved by authoritative readback. */ }
  const result = await observed(db, request.requestId);
  if (!result) throw new ShadowAdjudicationUnavailableError("The evidence request outcome is unavailable. Keep the original request for readback or withdrawal.");
  return match(result, request, context.actor);
}

export async function revokeShadowAdjudication(context: ShadowAdjudicationContext, input: ShadowAdjudicationRevocationRequest): Promise<ShadowAdjudicationResult> {
  context = snapshotContext(context);
  const request = checkedShadowAdjudicationRevocationRequest(input), before = await observed(context.db, request.adjudicationId);
  if (!before || before.status === "withdrawn" || before.requestSha256 !== request.adjudicationRequestSha256)
    throw new ShadowConflictError("The accepted evidence record does not match this revocation.");
  const matches = (result: ShadowAdjudicationResult) => {
    if (!result.revocation) return false;
    if (result.revocation.createdBy !== context.actor || stableJson(result.revocation.request) !== stableJson(request))
      throw new ShadowConflictError("This evidence record was revoked with a different request or actor.");
    return true;
  };
  if (matches(before)) return before;
  const db = primaryD1(context.db), now = timestamp(context);
  if ((await revocationBlockers(db, request.adjudicationId)).length)
    throw new ShadowConflictError("Pause conversions and resolve every accepted operation before revoking this evidence.");
  try {
    await db.prepare(`INSERT INTO file_shadow_adjudication_revocations(id,adjudication_id,request_json,request_sha256,created_by,created_at)
      VALUES(?,?,?,?,?,?)`).bind(request.requestId, request.adjudicationId, stableJson(request),
        await shadowAdjudicationRevocationRequestSha256(request), context.actor, now).run();
  } catch { /* No cancellation or hold mutation: inspect the durable revocation. */ }
  const result = await observed(db, request.adjudicationId);
  if (!result || !matches(result)) throw new ShadowAdjudicationUnavailableError("The evidence revocation outcome is unavailable. Keep the original revocation for readback or retry.");
  return result;
}

/** A revoking operator need not be the original accepting operator. Readback is
 * bound to the revocation actor and complete immutable revocation request. */
export async function readShadowAdjudicationRevocation(context: ShadowAdjudicationContext, input: ShadowAdjudicationRevocationRequest): Promise<ShadowAdjudicationResult | null> {
  context = snapshotContext(context);
  const request = checkedShadowAdjudicationRevocationRequest(input), result = await observed(context.db, request.adjudicationId);
  if (!result?.revocation) return null;
  if (result.revocation.createdBy !== context.actor || stableJson(result.revocation.request) !== stableJson(request))
    throw new ShadowConflictError("This evidence record was revoked with a different request or actor.");
  return result;
}

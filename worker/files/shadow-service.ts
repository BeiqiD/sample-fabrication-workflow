import { primaryD1 } from "../d1-primary";
import type { FilePurpose } from "../../shared/contracts/files";
import type { LiveConsumerKey } from "./live-consumer-baseline";
import type { ByteReader } from "./byte-reader";
import type { ByteWriter } from "./byte-writer";
import { MAX_VERIFIED_BYTES, type ByteExpectation, type Sha256Factory } from "./byte-verification";
import { copyShadowBytes, reconcileShadowDestination, verifyExistingShadowBytes,
  ShadowByteTransferError, type ShadowStorageIdentity } from "./shadow-byte-transfer";
import { checkedShadowKey, readShadowBaseline, type ShadowBaseline } from "./shadow-baseline";

export interface ShadowFrozenProfile { profileId: string; configurationRevision: number }
export interface ShadowOpenedProfile { storage: ShadowStorageIdentity; reader: ByteReader; writer?: ByteWriter; createHash: Sha256Factory }
export interface ShadowServiceContext {
  db: D1Database;
  actor: string;
  runtimeIncarnation: string;
  openProfile(profile: ShadowFrozenProfile, access: "read" | "write"): Promise<ShadowOpenedProfile>;
  /** Server-owned clock injection for tests; never a request body timestamp. */
  now?: () => string;
}
export interface ShadowConvertInput {
  operationId: string; key: LiveConsumerKey; expectedBaselineSha256: string;
  destinationProfile: ShadowFrozenProfile;
}
export type ShadowOperationStatus = "pending" | "resolved" | "admitted_unresolved" | "cancelled";
export type ShadowAttemptState = "staged" | "write_started" | "unknown" | "verified" | "published" | "failed" | "cancelled";
export interface ShadowOperationResult {
  operationId: string; occurrenceId: string; status: ShadowOperationStatus;
  attemptId: string | null; attemptState: ShadowAttemptState | null;
  fileId: string | null; locationId: string | null;
  /** A pending result grants no retry or publication ownership. */
  nextAction: "none" | "reconcile" | "inspect";
}
export class ShadowConflictError extends Error {
  constructor(message = "The File shadow baseline changed. Read the current state before continuing.") { super(message); this.name = "ShadowConflictError"; }
}
export class ShadowUnavailableError extends Error {
  constructor() { super("The File shadow operation outcome is unavailable. Inspect the same operation again."); this.name = "ShadowUnavailableError"; }
}
interface Operation {
  id: string; occurrence_id: string; captured_epoch: number; baseline_sha256: string;
  purpose: FilePurpose | null; access_scope: "system"; source_store_kind: string | null; source_provider: string | null;
  source_object_key: string | null; source_profile_id: string | null; source_profile_revision: number | null;
  source_expected_byte_size: number | null; source_expected_sha256: string | null;
  destination_profile_id: string | null; destination_profile_revision: number | null;
  status: ShadowOperationStatus; created_by: string; created_at: string; completed_at: string | null;
  consumer_kind: string; consumer_id: string; consumer_sub_id: string; file_slot: string;
}
interface Attempt {
  id: string; operation_id: string; attempt_number: number; owner_token: string; runtime_incarnation: string;
  candidate_file_id: string | null; candidate_location_id: string | null; candidate_object_key: string | null;
  verified_byte_size: number | null; verified_sha256: string | null; source_verified_at: string | null;
  state: ShadowAttemptState; lease_expires_at: string; created_at: string;
  write_started_at: string | null; verified_at: string | null; completed_at: string | null; last_error: string | null;
}
interface Observed { operation: Operation; attempt: Attempt | null; decision: { file_id: string | null; location_id: string | null; reason: string | null } | null }
const LEASE_MS = 15 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function snapshotContext(context: ShadowServiceContext): ShadowServiceContext {
  return { db: context.db, actor: context.actor, runtimeIncarnation: context.runtimeIncarnation,
    openProfile: context.openProfile.bind(context), now: context.now?.bind(context) };
}
async function openBoundProfile(context: ShadowServiceContext, frozen: ShadowFrozenProfile, access: "read" | "write") {
  const expected = { ...frozen }, opened = await context.openProfile({ ...expected }, access);
  if (opened.storage.profileId !== expected.profileId || opened.storage.configurationRevision !== expected.configurationRevision) throw new ShadowConflictError("The storage capability does not match the frozen profile.");
  return opened;
}
function requestIdentity(context: ShadowServiceContext, operationId: string) {
  if (!UUID.test(operationId) || typeof context.actor !== "string" || !context.actor.trim() || context.actor.length > 256 || context.actor.includes("\0")
    || typeof context.runtimeIncarnation !== "string" || !context.runtimeIncarnation || context.runtimeIncarnation.includes("\0")) throw new ShadowConflictError("Invalid File shadow operation identity.");
}
function now(context: ShadowServiceContext): string {
  const value = context.now?.() ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new ShadowUnavailableError();
  return value;
}
function expectation(operation: Operation): ByteExpectation {
  if (!Number.isSafeInteger(operation.source_expected_byte_size) || Number(operation.source_expected_byte_size) < 0
    || typeof operation.source_expected_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(operation.source_expected_sha256)) throw new ShadowConflictError("The source byte expectation is unresolved.");
  return { byteSize: operation.source_expected_byte_size as number, sha256: operation.source_expected_sha256 };
}
function publicResult(observed: Observed): ShadowOperationResult {
  return { operationId: observed.operation.id, occurrenceId: observed.operation.occurrence_id, status: observed.operation.status,
    attemptId: observed.attempt?.id ?? null, attemptState: observed.attempt?.state ?? null,
    fileId: observed.decision?.file_id ?? null, locationId: observed.decision?.location_id ?? null,
    nextAction: observed.operation.status !== "pending" ? "none"
      : observed.attempt && ["write_started", "unknown", "verified"].includes(observed.attempt.state) ? "reconcile" : "inspect" };
}
async function observedOperation(context: ShadowServiceContext, operationId: string): Promise<Observed | null> {
  try {
    // The receipt, attempt and decision are read atomically, so an ACK loss
    // cannot create a public resolved result from a stale attempt projection.
    const db = primaryD1(context.db);
    const result = await db.batch([
      db.prepare(`SELECT o.*,c.consumer_kind,c.consumer_id,c.consumer_sub_id,c.file_slot FROM file_shadow_operations o
        JOIN file_shadow_occurrences c ON c.id=o.occurrence_id WHERE o.id=?`).bind(operationId),
      db.prepare("SELECT * FROM file_shadow_attempts WHERE operation_id=? ORDER BY attempt_number DESC LIMIT 1").bind(operationId),
      db.prepare("SELECT file_id,location_id,reason FROM file_shadow_decisions WHERE operation_id=?").bind(operationId),
    ]);
    if (result.length !== 3 || result.some((r) => !r.success)) throw new Error();
    const operation = result[0].results[0] as unknown as Operation | undefined;
    if (!operation) return null;
    if (operation.created_by !== context.actor) throw new ShadowConflictError("The File shadow operation belongs to another actor.");
    return { operation, attempt: result[1].results[0] as unknown as Attempt ?? null,
      decision: result[2].results[0] as unknown as Observed["decision"] ?? null };
  } catch (error) { if (error instanceof ShadowConflictError) throw error; throw new ShadowUnavailableError(); }
}
export async function readShadowOperation(context: ShadowServiceContext, input: { operationId: string }): Promise<ShadowOperationResult | null> {
  context = snapshotContext(context); input = { operationId: input.operationId };
  requestIdentity(context, input.operationId);
  const observed = await observedOperation(context, input.operationId);
  return observed ? publicResult(observed) : null;
}
function guard(db: D1Database, operation: Pick<Operation, "id">, context: ShadowServiceContext, freshEpoch?: number, publication = false): D1PreparedStatement {
  const epoch = freshEpoch !== undefined ? "c.epoch=?" : publication ? `(c.epoch=o.captured_epoch OR EXISTS(
    SELECT 1 FROM file_shadow_reconciliations proof JOIN file_shadow_attempts attempt ON attempt.id=proof.attempt_id
    WHERE attempt.operation_id=o.id AND proof.runtime_incarnation=r.incarnation AND proof.verified_epoch=c.epoch
      AND proof.verified_sha256=attempt.verified_sha256 AND proof.verified_byte_size=attempt.verified_byte_size))` : "c.epoch=o.captured_epoch";
  return db.prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM file_shadow_operations o JOIN file_shadow_heads h ON h.occurrence_id=o.occurrence_id
    JOIN file_shadow_control c ON c.singleton=1 JOIN file_shadow_runtime_guard r ON r.singleton=1
    JOIN file_authority_control a ON a.singleton=1
    WHERE o.id=? AND o.status='pending' AND ${epoch} AND h.present=1
      AND r.enabled=1 AND r.incarnation=? AND a.mode='overlap'
  ) THEN 1 ELSE json('File shadow generation changed') END`).bind(operation.id, ...(freshEpoch === undefined ? [] : [freshEpoch]), context.runtimeIncarnation);
}
function eligibleBaseline(context: ShadowServiceContext, baseline: ShadowBaseline, expected: string) {
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected) || baseline.baselineSha256 !== expected
    || baseline.authority.mode !== "overlap" || baseline.runtime.enabled !== 1
    || baseline.runtime.incarnation !== context.runtimeIncarnation || !baseline.head?.present || baseline.decision) throw new ShadowConflictError();
}
function matchExisting(observed: Observed, input: ShadowConvertInput, baseline?: ShadowBaseline) {
  const op = observed.operation;
  if (op.consumer_kind !== input.key.consumerKind || op.consumer_id !== input.key.consumerId || op.consumer_sub_id !== input.key.consumerSubId || op.file_slot !== input.key.fileSlot
    || op.baseline_sha256 !== input.expectedBaselineSha256
    || op.destination_profile_id !== input.destinationProfile.profileId || op.destination_profile_revision !== input.destinationProfile.configurationRevision
    || baseline && op.occurrence_id !== baseline.head?.occurrence_id) throw new ShadowConflictError("The same File shadow operation was accepted with different input.");
}
async function recoverRequired(context: ShadowServiceContext, id: string): Promise<Observed> {
  const result = await observedOperation(context, id); if (!result) throw new ShadowUnavailableError(); return result;
}

/** A new operation owner alone may start provider writes. Retries of the same
 * request observe its existing immutable claim; they never regain that owner. */
export async function convertShadowConsumer(context: ShadowServiceContext, input: ShadowConvertInput): Promise<ShadowOperationResult> {
  context = snapshotContext(context);
  input = { operationId: input.operationId, key: checkedShadowKey(input.key), expectedBaselineSha256: input.expectedBaselineSha256,
    destinationProfile: { profileId: input.destinationProfile?.profileId, configurationRevision: input.destinationProfile?.configurationRevision } };
  requestIdentity(context, input.operationId);
  const key = checkedShadowKey(input.key);
  if (!input.destinationProfile || input.destinationProfile.configurationRevision !== 1 || !input.destinationProfile.profileId) throw new ShadowConflictError("Invalid destination profile.");
  const existing = await observedOperation(context, input.operationId);
  if (existing) { matchExisting(existing, input); return publicResult(existing); }
  const baseline = await readShadowBaseline(context.db, key);
  eligibleBaseline(context, baseline, input.expectedBaselineSha256);
  if (baseline.status !== "ready_to_verify" || !baseline.record?.locator || !baseline.purpose || !baseline.sourceProfile
    || baseline.record.registries.length !== 1) throw new ShadowConflictError("This consumer requires explicit resolution before copying.");
  const expected = { byteSize: Number(baseline.record.registries[0].byte_size), sha256: String(baseline.record.registries[0].sha256) };
  const created = now(context), attemptId = crypto.randomUUID(), ownerToken = crypto.randomUUID();
  const lease = new Date(Date.parse(created) + LEASE_MS).toISOString();
  const db = primaryD1(context.db);
  // Selecting profiles is read-only and must succeed before any durable claim.
  await openBoundProfile(context, input.destinationProfile, "write");
  await openBoundProfile(context, baseline.sourceProfile, "read");
  try { await db.batch([
    db.prepare(`INSERT INTO file_shadow_operations(id,occurrence_id,captured_epoch,baseline_sha256,purpose,access_scope,source_store_kind,source_provider,source_object_key,
      source_profile_id,source_profile_revision,source_expected_byte_size,source_expected_sha256,destination_profile_id,destination_profile_revision,status,created_by,created_at)
      SELECT ?,?,?,?,?, 'system',?,?,?,?,?,?,?,?,?,'pending',?,?
      WHERE (SELECT epoch FROM file_shadow_control WHERE singleton=1)=?
      AND EXISTS(SELECT 1 FROM file_shadow_heads WHERE occurrence_id=? AND present=1)
      AND EXISTS(SELECT 1 FROM file_shadow_runtime_guard WHERE singleton=1 AND enabled=1 AND incarnation=?)`)
      .bind(input.operationId, baseline.head!.occurrence_id, baseline.epoch, baseline.baselineSha256, baseline.purpose,
        baseline.record.locator.storeKind, baseline.record.locator.provider, baseline.record.locator.objectKey,
        baseline.sourceProfile.profileId, baseline.sourceProfile.configurationRevision, expected.byteSize, expected.sha256,
        input.destinationProfile.profileId, input.destinationProfile.configurationRevision, context.actor, created,
        baseline.epoch, baseline.head!.occurrence_id, context.runtimeIncarnation),
    db.prepare(`INSERT INTO file_shadow_attempts(id,operation_id,attempt_number,owner_token,runtime_incarnation,state,lease_expires_at,created_at)
      VALUES(?,?,1,?,?,'staged',?,?)`).bind(attemptId, input.operationId, ownerToken, context.runtimeIncarnation, lease, created),
    db.prepare(`INSERT INTO file_shadow_legacy_holds(id,operation_id,store_kind,provider,object_key,storage_profile_id,profile_revision,acquired_at)
      VALUES(?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), input.operationId, baseline.record.locator.storeKind, baseline.record.locator.provider,
        baseline.record.locator.objectKey, baseline.sourceProfile.profileId, baseline.sourceProfile.configurationRevision, created),
  ]); } catch { /* Primary readback distinguishes a committed claim from response loss. */ }
  let observed = await recoverRequired(context, input.operationId);
  matchExisting(observed, input, baseline);
  if (observed.attempt?.id !== attemptId || observed.attempt.owner_token !== ownerToken || observed.attempt.state !== "staged") return publicResult(observed);
  const source = await openBoundProfile(context, baseline.sourceProfile, "read");
  const destination = await openBoundProfile(context, input.destinationProfile, "write");
  if (!destination.writer) throw new ShadowUnavailableError();
  try { await guard(db, observed.operation, context).first(); } catch { throw new ShadowConflictError(); }
  try {
    await verifyExistingShadowBytes(source, { target: { storage: source.storage, objectKey: baseline.record.locator.objectKey }, expected });
  } catch {
    await markAttempt(context, observed, "failed", "source_unverified");
    return publicResult(await recoverRequired(context, input.operationId));
  }
  const fileId = crypto.randomUUID(), locationId = crypto.randomUUID(), objectKey = `file-shadow/${input.operationId}/${attemptId}`;
  const sourceVerified = now(context);
  try { await db.batch([
    guard(db, observed.operation, context),
    db.prepare("INSERT INTO files(id,purpose,access_scope,expected_byte_size,expected_sha256,state,created_at) VALUES(?,?,'system',?,?,'unresolved',?)")
      .bind(fileId, baseline.purpose, expected.byteSize, expected.sha256, sourceVerified),
    db.prepare("INSERT INTO file_locations(id,file_id,storage_profile_id,object_key,state,created_at) VALUES(?,?,?,?,'unresolved',?)")
      .bind(locationId, fileId, input.destinationProfile.profileId, objectKey, sourceVerified),
    db.prepare(`UPDATE file_shadow_attempts SET candidate_file_id=?,candidate_location_id=?,candidate_object_key=?,verified_byte_size=?,verified_sha256=?,source_verified_at=?
      WHERE id=? AND owner_token=? AND runtime_incarnation=? AND state='staged' AND candidate_file_id IS NULL AND lease_expires_at>?`)
      .bind(fileId, locationId, objectKey, expected.byteSize, expected.sha256, sourceVerified, attemptId, ownerToken, context.runtimeIncarnation, sourceVerified),
    db.prepare(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at)
      VALUES(?,?,'transition_destination',?,'File shadow conversion',?)`).bind(crypto.randomUUID(), locationId, input.operationId, sourceVerified),
    db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM file_shadow_attempts WHERE id=? AND candidate_file_id=? AND candidate_location_id=?) THEN 1 ELSE json('Shadow staging did not commit') END")
      .bind(attemptId, fileId, locationId),
  ]); } catch { /* No candidate is writable until the exact staged row is read back. */ }
  observed = await recoverRequired(context, input.operationId);
  if (observed.attempt?.id !== attemptId || observed.attempt.owner_token !== ownerToken || observed.attempt.candidate_file_id !== fileId
    || observed.attempt.candidate_location_id !== locationId || observed.attempt.state !== "staged") throw new ShadowConflictError();
  const writeStarted = now(context);
  try { await db.batch([guard(db, observed.operation, context), db.prepare(`UPDATE file_shadow_attempts SET state='write_started',write_started_at=?
    WHERE id=? AND owner_token=? AND runtime_incarnation=? AND state='staged' AND lease_expires_at>?`)
    .bind(writeStarted, attemptId, ownerToken, context.runtimeIncarnation, writeStarted)]); } catch { /* Reconcile before I/O. */ }
  observed = await recoverRequired(context, input.operationId);
  if (observed.attempt?.id !== attemptId || observed.attempt.owner_token !== ownerToken || observed.attempt.runtime_incarnation !== context.runtimeIncarnation
    || observed.attempt.state !== "write_started" || observed.attempt.write_started_at !== writeStarted) throw new ShadowConflictError();
  try {
    // The second source GET may wait. Recheck the durable writer fence at the
    // provider-write boundary, after that wait and before invoking PUT.
    const writer: ByteWriter = { accepts: destination.writer.accepts, write: async (value) => {
      await db.batch([guard(db, observed.operation, context), db.prepare(`SELECT CASE WHEN EXISTS(
        SELECT 1 FROM file_shadow_attempts a WHERE a.id=? AND a.owner_token=? AND a.runtime_incarnation=?
        AND a.state='write_started' AND julianday(a.lease_expires_at)>julianday('now')
        AND EXISTS(SELECT 1 FROM file_shadow_legacy_holds h WHERE h.operation_id=a.operation_id AND h.released_at IS NULL)
        AND EXISTS(SELECT 1 FROM file_location_holds h WHERE h.operation_id=a.operation_id AND h.location_id=a.candidate_location_id AND h.released_at IS NULL)
      ) THEN 1 ELSE json('Shadow writer fence changed') END`).bind(attemptId, ownerToken, context.runtimeIncarnation)]);
      await destination.writer!.write(value);
    } };
    await copyShadowBytes({ source, destination: { ...destination, writer }, createHash: source.createHash },
      { source: { storage: source.storage, objectKey: baseline.record.locator.objectKey }, destination: { storage: destination.storage, objectKey },
        expected, contentType: "application/octet-stream", filename: "file" });
  } catch (error) {
    // Once write_started is durable the attempt never returns to a retryable
    // staged state, even when this particular invocation reports no PUT call.
    await markAttempt(context, observed, "unknown", error instanceof ShadowByteTransferError ? `copy_${error.reason}` : "copy_unverified");
    return publicResult(await recoverRequired(context, input.operationId));
  }
  await recordVerified(context, observed);
  return publishVerified(context, await recoverRequired(context, input.operationId));
}

async function markAttempt(context: ShadowServiceContext, observed: Observed, state: "failed" | "unknown", code: string) {
  if (!observed.attempt) throw new ShadowUnavailableError();
  try { await primaryD1(context.db).prepare(`UPDATE file_shadow_attempts SET state=?,last_error=?,completed_at=? WHERE id=? AND owner_token=? AND state IN('staged','write_started','unknown')`)
    .bind(state, code, state === "failed" ? now(context) : null, observed.attempt.id, observed.attempt.owner_token).run(); } catch { /* Never infer a result from an UPDATE acknowledgement. */ }
}
async function recordVerified(context: ShadowServiceContext, observed: Observed) {
  if (!observed.attempt) throw new ShadowUnavailableError();
  try { await primaryD1(context.db).prepare(`UPDATE file_shadow_attempts SET state='verified',verified_at=?,last_error=NULL
    WHERE id=? AND owner_token=? AND state IN('write_started','unknown')`).bind(now(context), observed.attempt.id, observed.attempt.owner_token).run();
  } catch { /* Readback below is authoritative. */ }
  const result = await recoverRequired(context, observed.operation.id);
  if (result.attempt?.id !== observed.attempt.id || !["verified", "published"].includes(result.attempt.state)) throw new ShadowUnavailableError();
}
async function publishVerified(context: ShadowServiceContext, observed: Observed): Promise<ShadowOperationResult> {
  if (observed.operation.status !== "pending") return publicResult(observed);
  const { operation: op, attempt } = observed;
  if (!attempt || attempt.state !== "verified" || !attempt.candidate_file_id || !attempt.candidate_location_id || !attempt.candidate_object_key || !attempt.verified_at) throw new ShadowUnavailableError();
  const db = primaryD1(context.db), published = now(context);
  try { await db.batch([
    guard(db, op, context, undefined, true),
    db.prepare(`INSERT INTO file_location_publications(location_id,file_id,storage_profile_id,object_key,verified_byte_size,verified_sha256,verification_method,verification_operation_id,verified_at,published_at)
      VALUES(?,?,?,?,?,?,'full_read_sha256',?,?,?)`).bind(attempt.candidate_location_id, attempt.candidate_file_id, op.destination_profile_id, attempt.candidate_object_key,
        attempt.verified_byte_size, attempt.verified_sha256, op.id, attempt.verified_at, published),
    db.prepare(`INSERT INTO file_publications(file_id,purpose,access_scope,verified_byte_size,verified_sha256,active_location_id,state,published_at)
      VALUES(?,?,'system',?,?,?,'ready',?)`).bind(attempt.candidate_file_id, op.purpose, attempt.verified_byte_size, attempt.verified_sha256, attempt.candidate_location_id, published),
    db.prepare(`INSERT INTO file_shadow_decisions(occurrence_id,operation_id,decision,file_id,location_id,baseline_sha256,reason,decided_by,decided_at)
      VALUES(?,?,'resolved',?,?,?,NULL,?,?)`).bind(op.occurrence_id, op.id, attempt.candidate_file_id, attempt.candidate_location_id, op.baseline_sha256, context.actor, published),
    db.prepare("UPDATE file_shadow_attempts SET state='published',completed_at=? WHERE id=? AND state='verified'").bind(published, attempt.id),
    db.prepare("UPDATE file_shadow_operations SET status='resolved',completed_at=? WHERE id=? AND status='pending'").bind(published, op.id),
    db.prepare("UPDATE file_shadow_legacy_holds SET released_at=? WHERE operation_id=? AND released_at IS NULL").bind(published, op.id),
    db.prepare("UPDATE file_location_holds SET released_at=? WHERE operation_id=? AND released_at IS NULL").bind(published, op.id),
    db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM file_shadow_operations WHERE id=? AND status='resolved') THEN 1 ELSE json('Shadow publication did not commit') END").bind(op.id),
  ]); } catch { /* A lost publication acknowledgement is reconciled below. */ }
  const result = await recoverRequired(context, op.id);
  if (result.operation.status !== "resolved") throw new ShadowConflictError();
  return publicResult(result);
}

/** Explicit reconciliation is read-only at the provider. Even a new runtime
 * incarnation cannot replay an old PUT or acquire its original writer token. */
export async function reconcileShadowOperation(context: ShadowServiceContext, input: { operationId: string }): Promise<ShadowOperationResult> {
  context = snapshotContext(context); input = { operationId: input.operationId };
  requestIdentity(context, input.operationId);
  let observed = await recoverRequired(context, input.operationId);
  if (observed.operation.status !== "pending") return publicResult(observed);
  const { operation: op, attempt } = observed;
  if (!attempt || !["write_started", "unknown", "verified"].includes(attempt.state) || !attempt.candidate_object_key
    || !op.source_profile_id || !op.source_profile_revision || !op.source_object_key || !op.destination_profile_id || !op.destination_profile_revision) return publicResult(observed);
  const db = primaryD1(context.db);
  // Holds still belong to this operation; current generation/runtime eligibility
  // is proven before opening either provider, including after isolated restore.
  const fresh = await readShadowBaseline(context.db, { consumerKind: op.consumer_kind, consumerId: op.consumer_id,
    consumerSubId: op.consumer_sub_id, fileSlot: op.file_slot });
  if (fresh.authority.mode !== "overlap" || fresh.runtime.enabled !== 1 || fresh.runtime.incarnation !== context.runtimeIncarnation
    || fresh.head?.occurrence_id !== op.occurrence_id || !fresh.head.present || fresh.decision || fresh.status !== "ready_to_verify"
    || fresh.purpose !== op.purpose || fresh.sourceLocator?.storeKind !== op.source_store_kind || fresh.sourceLocator.provider !== op.source_provider
    || fresh.sourceLocator.objectKey !== op.source_object_key || fresh.sourceProfile?.profileId !== op.source_profile_id
    || fresh.sourceProfile.configurationRevision !== op.source_profile_revision || fresh.record?.registries.length !== 1
    || fresh.record.registries[0].byte_size !== op.source_expected_byte_size || fresh.record.registries[0].sha256 !== op.source_expected_sha256) throw new ShadowConflictError();
  try { await guard(db, op, context, fresh.epoch).first(); } catch { throw new ShadowConflictError(); }
  const source = await openBoundProfile(context, { profileId: op.source_profile_id, configurationRevision: op.source_profile_revision }, "read");
  const destination = await openBoundProfile(context, { profileId: op.destination_profile_id, configurationRevision: op.destination_profile_revision }, "read");
  const expected = expectation(op);
  let sourceVerified: string, destinationVerified: string;
  try {
    await verifyExistingShadowBytes(source, { target: { storage: source.storage, objectKey: op.source_object_key }, expected });
    sourceVerified = now(context);
    await reconcileShadowDestination(destination, { target: { storage: destination.storage, objectKey: attempt.candidate_object_key }, expected });
    destinationVerified = now(context);
  } catch { return publicResult(await recoverRequired(context, op.id)); }
  const proofId = crypto.randomUUID();
  try { await db.batch([guard(db, op, context, fresh.epoch), db.prepare(`INSERT INTO file_shadow_reconciliations
    (id,attempt_id,runtime_incarnation,verified_epoch,verified_byte_size,verified_sha256,source_verified_at,destination_verified_at,created_by,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM file_shadow_reconciliations WHERE attempt_id=? AND runtime_incarnation=? AND verified_epoch=?)`).bind(proofId, attempt.id, context.runtimeIncarnation, fresh.epoch, expected.byteSize, expected.sha256,
      sourceVerified, destinationVerified, context.actor, now(context), attempt.id, context.runtimeIncarnation, fresh.epoch)]); } catch { /* Read back the exact proof after a lost response. */ }
  const proof = await db.prepare(`SELECT id FROM file_shadow_reconciliations WHERE attempt_id=? AND runtime_incarnation=?
    AND verified_epoch=? AND verified_byte_size=? AND verified_sha256=? AND created_by=?`)
    .bind(attempt.id, context.runtimeIncarnation, fresh.epoch, expected.byteSize, expected.sha256, context.actor).first();
  if (!proof) throw new ShadowConflictError();
  if (attempt.state !== "verified") await recordVerified(context, observed);
  observed = await recoverRequired(context, op.id);
  return publishVerified(context, observed);
}

/** An explicit unresolved decision is an auditable blocker to activation. It
 * grants no File identity, byte ownership, source freeze or provider operation. */
export async function admitShadowUnresolved(context: ShadowServiceContext, input: {
  operationId: string; key: LiveConsumerKey; expectedBaselineSha256: string; reason: string;
}): Promise<ShadowOperationResult> {
  context = snapshotContext(context);
  input = { operationId: input.operationId, key: checkedShadowKey(input.key), expectedBaselineSha256: input.expectedBaselineSha256, reason: input.reason };
  requestIdentity(context, input.operationId);
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000 || input.reason.includes("\0")) throw new ShadowConflictError("An explicit unresolved reason is required.");
  function matchAdmission(existing: Observed) {
    const key = checkedShadowKey(input.key), op = existing.operation;
    if (op.consumer_kind !== key.consumerKind || op.consumer_id !== key.consumerId || op.consumer_sub_id !== key.consumerSubId || op.file_slot !== key.fileSlot
      || op.baseline_sha256 !== input.expectedBaselineSha256 || op.destination_profile_id !== null || existing.decision?.reason !== input.reason) throw new ShadowConflictError();
  }
  const existing = await observedOperation(context, input.operationId);
  if (existing) { matchAdmission(existing); return publicResult(existing); }
  const baseline = await readShadowBaseline(context.db, checkedShadowKey(input.key));
  eligibleBaseline(context, baseline, input.expectedBaselineSha256);
  const db = primaryD1(context.db), created = now(context);
  const locator = baseline.sourceLocator;
  const sourceProfile = locator ? baseline.sourceProfile : null;
  const registry = baseline.record?.registries.length === 1 ? baseline.record.registries[0] : null;
  const byteSize = registry && Number.isSafeInteger(registry.byte_size) && Number(registry.byte_size) >= 0 && Number(registry.byte_size) <= MAX_VERIFIED_BYTES ? registry.byte_size : null;
  const sha256 = registry && typeof registry.sha256 === "string" && /^[a-f0-9]{64}$/.test(registry.sha256) ? registry.sha256 : null;
  try { await db.batch([
    db.prepare(`INSERT INTO file_shadow_operations(id,occurrence_id,captured_epoch,baseline_sha256,purpose,access_scope,source_store_kind,source_provider,source_object_key,
      source_profile_id,source_profile_revision,source_expected_byte_size,source_expected_sha256,status,created_by,created_at)
      SELECT ?,?,?,?,?,'system',?,?,?,?,?,?,?,'pending',?,? WHERE (SELECT epoch FROM file_shadow_control WHERE singleton=1)=?`)
      .bind(input.operationId, baseline.head!.occurrence_id, baseline.epoch, baseline.baselineSha256, baseline.purpose,
        locator?.storeKind ?? null, locator?.provider ?? null, locator?.objectKey ?? null,
        sourceProfile?.profileId ?? null, sourceProfile?.configurationRevision ?? null,
        byteSize, sha256, context.actor, created, baseline.epoch),
    guard(db, { id: input.operationId }, context),
    db.prepare(`INSERT INTO file_shadow_decisions(occurrence_id,operation_id,decision,file_id,location_id,baseline_sha256,reason,decided_by,decided_at)
      VALUES(?,?,'admitted_unresolved',NULL,NULL,?,?,?,?)`).bind(baseline.head!.occurrence_id, input.operationId, baseline.baselineSha256, input.reason, context.actor, created),
    db.prepare("UPDATE file_shadow_operations SET status='admitted_unresolved',completed_at=? WHERE id=? AND status='pending'").bind(created, input.operationId),
  ]); } catch { /* Readback determines whether admission committed. */ }
  const observed = await recoverRequired(context, input.operationId);
  matchAdmission(observed);
  return publicResult(observed);
}

/** A never-started provider write can be abandoned across generations or a
 * restored runtime. Any evidence of a possible PUT requires reconciliation. */
export async function cancelShadowOperation(context: ShadowServiceContext, input: { operationId: string }): Promise<ShadowOperationResult> {
  context = snapshotContext(context); input = { operationId: input.operationId };
  requestIdentity(context, input.operationId);
  const observed = await recoverRequired(context, input.operationId);
  if (observed.operation.status === "cancelled") return publicResult(observed);
  if (observed.operation.status !== "pending" || !observed.attempt || !["staged", "failed", "cancelled"].includes(observed.attempt.state)
    || observed.attempt.write_started_at !== null || observed.attempt.verified_at !== null) throw new ShadowConflictError("This File shadow operation requires reconciliation before it can be abandoned.");
  const db = primaryD1(context.db), completed = now(context);
  try { await db.batch([
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM file_shadow_operations o
      JOIN file_shadow_runtime_guard r ON r.singleton=1 JOIN file_authority_control c ON c.singleton=1
      WHERE o.id=? AND o.status='pending' AND r.enabled=1 AND r.incarnation=? AND c.mode='overlap'
      AND NOT EXISTS(SELECT 1 FROM file_shadow_decisions d WHERE d.operation_id=o.id)
      AND EXISTS(SELECT 1 FROM file_shadow_attempts a WHERE a.operation_id=o.id)
      AND NOT EXISTS(SELECT 1 FROM file_shadow_attempts a WHERE a.operation_id=o.id
        AND(a.state NOT IN('staged','failed','cancelled') OR a.write_started_at IS NOT NULL OR a.verified_at IS NOT NULL))
    ) THEN 1 ELSE json('Shadow cancellation is not safe') END`).bind(input.operationId, context.runtimeIncarnation),
    db.prepare("UPDATE file_shadow_attempts SET state='cancelled',completed_at=?,last_error='cancelled_before_write' WHERE operation_id=? AND state='staged'").bind(completed, input.operationId),
    db.prepare("UPDATE file_shadow_operations SET status='cancelled',completed_at=? WHERE id=? AND status='pending'").bind(completed, input.operationId),
    db.prepare("UPDATE file_shadow_legacy_holds SET released_at=? WHERE operation_id=? AND released_at IS NULL").bind(completed, input.operationId),
    db.prepare("UPDATE file_location_holds SET released_at=? WHERE operation_id=? AND released_at IS NULL").bind(completed, input.operationId),
  ]); } catch { /* Read the committed terminal state after any lost response. */ }
  const result = await recoverRequired(context, input.operationId);
  if (result.operation.status !== "cancelled") throw new ShadowConflictError("This File shadow operation cannot be safely abandoned.");
  return publicResult(result);
}

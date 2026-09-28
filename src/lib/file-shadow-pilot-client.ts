import type { FilePurpose } from "../../shared/contracts/files";
import { checkedShadowWithdrawalRequest, shadowWithdrawalRequestSha256, type ShadowWithdrawalRequest } from "../../shared/contracts/file-shadow-withdrawal";
import { createUuid } from "./uuid";

export interface ShadowConsumerKey { consumerKind: string; consumerId: string; consumerSubId: string; fileSlot: string }
export interface PilotStatus {
  mode: "legacy" | "overlap"; epoch: number; enabled: boolean; incarnation: string | null;
  currentCount: number; resolvedCount: number; unresolvedCount: number; pendingCount: number; unfinishedAttempts: number;
}
export interface PilotConsumer { key: ShadowConsumerKey; generation: number; occurrenceId: string; state: "pending" | "resolved" | "admitted_unresolved" }
export interface PilotConsumerPage { records: PilotConsumer[]; nextCursor: ShadowConsumerKey | null }
export interface PilotProfile { profileId: string; configurationRevision: 1; runtimeState: "read_only" | "read_write" | "retired" }
export interface PilotBaseline {
  key: ShadowConsumerKey; epoch: number; mode: PilotStatus["mode"]; runtime: Pick<PilotStatus, "enabled" | "incarnation">;
  head: { generation: number; occurrenceId: string; present: boolean } | null;
  purpose: FilePurpose | null; expectedBytes: number | null; expectedSha256: string | null;
  sourceProfile: PilotProfile | null; provider: "r2" | "other" | null;
  status: "absent" | "resolved" | "admitted_unresolved" | "pending_no_locator" | "unavailable" | "ambiguous" | "ready_to_verify";
  reasons: string[]; baselineSha256: string; eligible: boolean;
}
export type PilotConvertRequest = ShadowWithdrawalRequest;
interface PilotAcceptedOperation {
  operationId: string; occurrenceId: string; status: "pending" | "resolved" | "admitted_unresolved" | "cancelled";
  attemptId: string | null; attemptState: "staged" | "write_started" | "unknown" | "verified" | "published" | "failed" | "cancelled" | null;
  fileId: string | null; locationId: string | null; nextAction: "none" | "reconcile" | "inspect";
}
interface PilotWithdrawnOperation {
  operationId: string; status: "withdrawn"; request: PilotConvertRequest; requestSha256: string;
  occurrenceId: null; attemptId: null; attemptState: null; fileId: null; locationId: null; nextAction: "none";
}
export type PilotOperation = PilotAcceptedOperation | PilotWithdrawnOperation;
export interface PilotJournal {
  version: 1;
  request: PilotConvertRequest;
  proof: { generation: number; occurrenceId: string; purpose: FilePurpose; expectedBytes: number; expectedSha256: string };
  receipt: PilotOperation | null;
}
export interface FileShadowPilotClient {
  getStatus(): Promise<PilotStatus>;
  listConsumers(cursor?: ShadowConsumerKey | null): Promise<PilotConsumerPage>;
  getBaseline(key: ShadowConsumerKey): Promise<PilotBaseline>;
  enable(status: PilotStatus): Promise<PilotStatus>;
  enableProfile(baseline: PilotBaseline): Promise<PilotStatus>;
  pause(status: PilotStatus): Promise<PilotStatus>;
  convert(baseline: PilotBaseline): Promise<PilotOperation>;
  inspectOperation(expectedOperationId: string): Promise<PilotOperation>;
  reconcileOperation(status: PilotStatus, expectedOperationId: string): Promise<PilotOperation>;
  cancelOperation(status: PilotStatus, expectedOperationId: string): Promise<PilotOperation>;
  withdrawOperation(expectedOperationId: string): Promise<PilotOperation>;
  loadJournal(): PilotJournal | null;
  clearTerminalReceipt(expectedOperationId: string): Promise<void>;
}
export const FILE_SHADOW_PILOT_JOURNAL_KEY = "file-shadow-pilot-operation-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
// A withdrawal receipt echoes the complete request, including its bounded key.
const MAX_JOURNAL_BYTES = 192 * 1024;
const purposes = ["research_source", "embedded_content", "derived_preview", "provenance", "job_output"] as const;
const baselineStates = ["absent", "resolved", "admitted_unresolved", "pending_no_locator", "unavailable", "ambiguous", "ready_to_verify"] as const;
const knownReasons = new Set([
  "event_locator_semantics_invalid", "consumer_unavailable_without_locator", "registry_record_missing", "consumer_has_no_locator",
  "consumer_generation_unfinished", "consumer_parent_missing", "unsupported_legacy_provider", "legacy_locator_requires_explicit_resolution",
  "conflicting_registry_bindings", "legacy_registry_not_ready", "legacy_lifecycle_blocks_verification", "unexpected_existing_file_binding",
  "expected_byte_metadata_incomplete", "expected_byte_metadata_conflict", "acceptance_unfinished", "accepted_result_invalid",
  "accepted_registry_identity_mismatch", "consumer_purpose_unresolved", "recorded_purpose_conflict", "derivation_not_assessed",
  "shared_locator_purpose_unresolved", "independent_verified_copies_required", "namespace_evidence_missing", "namespace_evidence_invalid",
  "namespace_conflict", "namespace_revision_mismatch", "source_exceeds_verified_byte_limit", "source_profile_unresolved",
]);
export class FileShadowPilotError extends Error {
  constructor(message: string) { super(message); this.name = "FileShadowPilotError"; }
}
function fail(message = "The File conversion response is incomplete. Refresh the current state."): never { throw new FileShadowPilotError(message); }
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
function string(value: unknown, max = 256, allowEmpty = false): string {
  return typeof value === "string" && (allowEmpty || value.length > 0) && value.length <= max ? value : fail();
}
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : fail();
const uuid = (value: unknown): string => typeof value === "string" && UUID.test(value) ? value : fail();
const sha = (value: unknown): string => typeof value === "string" && SHA.test(value) ? value : fail();
const nullableId = (value: unknown): string | null => value === null ? null : string(value);
const choice = <T extends string>(value: unknown, values: readonly T[]): T => values.includes(value as T) ? value as T : fail();
const flag = (value: unknown): boolean => value === 0 ? false : value === 1 ? true : fail();
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
function exact(value: Record<string, unknown>, names: string[]) {
  if (Object.keys(value).sort().join(",") !== [...names].sort().join(",")) fail();
}
function key(value: unknown): ShadowConsumerKey {
  const raw = object(value); exact(raw, ["consumerKind", "consumerId", "consumerSubId", "fileSlot"]);
  const result = { consumerKind: string(raw.consumerKind, 65536, true), consumerId: string(raw.consumerId, 65536, true),
    consumerSubId: string(raw.consumerSubId, 65536, true), fileSlot: string(raw.fileSlot, 65536, true) };
  if (bytes(result) > 64 * 1024) fail();
  return result;
}
const sameKey = (left: ShadowConsumerKey, right: ShadowConsumerKey) => JSON.stringify(left) === JSON.stringify(right);
function parseStatus(value: unknown): PilotStatus {
  const raw = object(value), mode = choice(raw.mode, ["legacy", "overlap"] as const), enabled = flag(raw.enabled);
  const incarnation = raw.incarnation === null ? null : uuid(raw.incarnation);
  if (enabled && (mode !== "overlap" || incarnation === null)) fail();
  const result = { mode, enabled, incarnation, epoch: integer(raw.epoch), currentCount: integer(raw.current_count),
    resolvedCount: integer(raw.resolved_count), unresolvedCount: integer(raw.unresolved_count), pendingCount: integer(raw.pending_count),
    unfinishedAttempts: integer(raw.unfinished_attempts) };
  if (result.currentCount !== result.resolvedCount + result.unresolvedCount + result.pendingCount) fail();
  return result;
}
export function canEnableProfile(baseline: PilotBaseline): boolean {
  return baseline.status === "ready_to_verify" && baseline.reasons.length === 0 && baseline.provider === "r2"
    && baseline.head?.present === true && baseline.purpose !== null && baseline.expectedBytes !== null
    && baseline.expectedSha256 !== null && baseline.sourceProfile?.runtimeState === "read_only"
    && baseline.mode === "overlap" && baseline.runtime.enabled && baseline.runtime.incarnation !== null;
}
export function canConvertBaseline(baseline: PilotBaseline): boolean {
  return baseline.status === "ready_to_verify" && baseline.reasons.length === 0 && baseline.provider === "r2"
    && baseline.head?.present === true && baseline.purpose !== null && baseline.expectedBytes !== null
    && baseline.expectedBytes <= MAX_BYTES && baseline.expectedSha256 !== null && baseline.sourceProfile?.runtimeState === "read_write"
    && baseline.mode === "overlap" && baseline.runtime.enabled && baseline.runtime.incarnation !== null;
}
export const isTerminalReceipt = (receipt: PilotOperation | null): boolean => receipt !== null && receipt.status !== "pending";
export const canCancelReceipt = (receipt: PilotOperation | null): boolean => receipt?.status === "pending"
  && (receipt.attemptState === "staged" || receipt.attemptState === "failed");

/** The baseline endpoint includes raw metadata. Only this reviewed projection is
 * exposed to the page or durable storage; namespace, locators and actors stay out. */
function parseBaseline(value: unknown, requested: ShadowConsumerKey): PilotBaseline {
  const raw = object(value);
  if (raw.version !== 1 || raw.kind !== "file-shadow-baseline" || raw.bytesVerified !== false) fail();
  const parsedKey = key(raw.key); if (!sameKey(parsedKey, requested)) fail();
  const authority = object(raw.authority), runtime = object(raw.runtime);
  if (authority.singleton !== 1 || authority.revision !== 1) fail();
  const mode = choice(authority.mode, ["legacy", "overlap"] as const), enabled = flag(runtime.enabled);
  const incarnation = runtime.incarnation === null ? null : uuid(runtime.incarnation);
  if (enabled && (incarnation === null || mode !== "overlap")) fail();
  let head: PilotBaseline["head"] = null;
  if (raw.head !== null) {
    const source = object(raw.head);
    if (!sameKey({ consumerKind: string(source.consumer_kind, 65536, true), consumerId: string(source.consumer_id, 65536, true),
      consumerSubId: string(source.consumer_sub_id, 65536, true), fileSlot: string(source.file_slot, 65536, true) }, parsedKey)) fail();
    head = { generation: integer(source.generation, 1), occurrenceId: string(source.occurrence_id), present: flag(source.present) };
  }
  const purpose = raw.purpose === null ? null : choice(raw.purpose, purposes);
  const status = choice(raw.status, baselineStates);
  if (!Array.isArray(raw.reasons) || raw.reasons.length > 100) fail();
  const reasons = [...new Set(raw.reasons.map((reason) => knownReasons.has(String(reason)) ? String(reason) : "metadata_reason_unrecognized"))];
  let expectedBytes: number | null = null, expectedSha256: string | null = null, sourceProfile: PilotProfile | null = null;
  let provider: PilotBaseline["provider"] = null;
  if (raw.record !== null) {
    const record = object(raw.record); if (!sameKey(key(record.key), parsedKey)) fail();
    if (!Array.isArray(record.registries) || !Array.isArray(record.profiles)) fail();
    if (record.registries.length === 1) {
      const registry = object(record.registries[0]);
      if (typeof registry.byte_size === "number" && Number.isSafeInteger(registry.byte_size) && registry.byte_size >= 0 && registry.byte_size <= MAX_BYTES) expectedBytes = registry.byte_size;
      if (typeof registry.sha256 === "string" && SHA.test(registry.sha256)) expectedSha256 = registry.sha256;
    }
    if (record.locator !== null) {
      const locator = object(record.locator), captured = raw.sourceLocator === null ? null : object(raw.sourceLocator);
      provider = locator.provider === "r2" && locator.storeKind === "r2" ? "r2" : "other";
      if (provider === "r2" && (!captured || captured.provider !== locator.provider || captured.storeKind !== locator.storeKind
        || captured.objectKey !== locator.objectKey || typeof locator.objectKey !== "string" || !locator.objectKey)) fail();
    }
    if (raw.sourceProfile !== null) {
      const frozen = object(raw.sourceProfile);
      const profileId = string(frozen.profileId);
      if (profileId.includes("\0") || frozen.configurationRevision !== 1) fail();
      const matches = record.profiles.map(object).filter((entry) => entry.id === profileId && entry.configuration_revision === 1);
      if (matches.length === 1) {
        const profile = matches[0];
        if (provider === "r2" && profile.adapter_type !== "r2") fail();
        sourceProfile = { profileId, configurationRevision: 1, runtimeState: choice(profile.runtime_state, ["read_only", "read_write", "retired"] as const) };
      } else {
        // V17 keeps legacy record.profiles unchanged. An occurrence-scoped
        // adjudication can establish the missing profile separately, with its
        // runtime state captured in that same primary baseline snapshot.
        if (matches.length !== 0 || record.profiles.length !== 0 || provider !== "r2" || !head?.present || raw.adjudication == null) fail();
        const evidence = object(raw.adjudication), profile = object(evidence.sourceProfile), source = object(raw.head);
        uuid(evidence.requestId); sha(evidence.requestSha256); sha(evidence.sourceSha256);
        if (evidence.sourceSha256 !== source.source_sha256 || evidence.purpose !== purpose
          || profile.profileId !== profileId || profile.configurationRevision !== 1) fail();
        sourceProfile = { profileId, configurationRevision: 1,
          runtimeState: choice(evidence.sourceProfileRuntimeState, ["read_only", "read_write", "retired"] as const) };
      }
    }
  }
  if (raw.decision !== null && status !== "resolved" && status !== "admitted_unresolved") fail();
  const result: PilotBaseline = { key: parsedKey, epoch: integer(raw.epoch), mode, runtime: { enabled, incarnation }, head, purpose,
    expectedBytes, expectedSha256, sourceProfile, provider, status, reasons, baselineSha256: sha(raw.baselineSha256), eligible: false };
  result.eligible = canConvertBaseline(result);
  return result;
}
function parseOperation(value: unknown, journal: Pick<PilotJournal, "request" | "proof">): PilotOperation {
  const raw = object(value);
  if (raw.status === "withdrawn") {
    exact(raw, ["operationId", "status", "request", "requestSha256", "occurrenceId", "attemptId", "attemptState", "fileId", "locationId", "nextAction"]);
    const request = parseRequest(raw.request), operationId = uuid(raw.operationId);
    if (operationId !== journal.request.operationId || JSON.stringify(request) !== JSON.stringify(journal.request)
      || raw.occurrenceId !== null || raw.attemptId !== null || raw.attemptState !== null
      || raw.fileId !== null || raw.locationId !== null || raw.nextAction !== "none") fail();
    return { operationId, status: "withdrawn", request, requestSha256: sha(raw.requestSha256),
      occurrenceId: null, attemptId: null, attemptState: null, fileId: null, locationId: null, nextAction: "none" };
  }
  const result: PilotAcceptedOperation = { operationId: uuid(raw.operationId), occurrenceId: string(raw.occurrenceId),
    status: choice(raw.status, ["pending", "resolved", "admitted_unresolved", "cancelled"] as const),
    attemptId: nullableId(raw.attemptId), attemptState: raw.attemptState === null ? null : choice(raw.attemptState, ["staged", "write_started", "unknown", "verified", "published", "failed", "cancelled"] as const),
    fileId: nullableId(raw.fileId), locationId: nullableId(raw.locationId), nextAction: choice(raw.nextAction, ["none", "reconcile", "inspect"] as const) };
  if (result.operationId !== journal.request.operationId || result.occurrenceId !== journal.proof.occurrenceId
    || (result.attemptId === null) !== (result.attemptState === null)
    || (result.status === "pending") === (result.nextAction === "none")
    || result.status === "resolved" && (!result.fileId || !result.locationId || result.attemptState !== "published")
    || result.status !== "resolved" && (result.fileId !== null || result.locationId !== null)
    || result.status === "admitted_unresolved") fail();
  return result;
}
async function parseResponseOperation(value: unknown, journal: Pick<PilotJournal, "request" | "proof">): Promise<PilotOperation> {
  const receipt = parseOperation(value, journal);
  if (receipt.status === "withdrawn" && receipt.requestSha256 !== await shadowWithdrawalRequestSha256(receipt.request)) fail();
  return receipt;
}
function parseRequest(value: unknown): PilotConvertRequest {
  try { return checkedShadowWithdrawalRequest(value); } catch { return fail(); }
}
function parseJournal(value: unknown): PilotJournal {
  const raw = object(value); exact(raw, ["version", "request", "proof", "receipt"]);
  if (raw.version !== 1 || bytes(raw) > MAX_JOURNAL_BYTES) fail();
  const request = parseRequest(raw.request), proof = object(raw.proof);
  exact(proof, ["generation", "occurrenceId", "purpose", "expectedBytes", "expectedSha256"]);
  const result: PilotJournal = { version: 1, request,
    proof: { generation: integer(proof.generation, 1), occurrenceId: string(proof.occurrenceId), purpose: choice(proof.purpose, purposes),
      expectedBytes: integer(proof.expectedBytes, 0, MAX_BYTES), expectedSha256: sha(proof.expectedSha256) }, receipt: null };
  result.receipt = raw.receipt === null ? null : parseOperation(raw.receipt, result);
  return result;
}

export function createFileShadowPilotClient(options: {
  storage?: Storage; fetch?: typeof fetch; withLock?: <T>(action: () => Promise<T>) => Promise<T>;
} = {}): FileShadowPilotClient {
  let baselines = new WeakMap<PilotBaseline, string>();
  const statuses = new WeakMap<PilotStatus, string>();
  const fetcher = options.fetch ?? ((...args) => fetch(...args));
  const storage = (): Storage => {
    try { return options.storage ?? localStorage; } catch { return fail("Persistent browser storage is unavailable. No command was sent."); }
  };
  function loadJournal(): PilotJournal | null {
    try {
      const text = storage().getItem(FILE_SHADOW_PILOT_JOURNAL_KEY);
      return text === null ? null : parseJournal(JSON.parse(text));
    } catch { return fail("The saved operation cannot be read. Keep browser storage intact; no new conversion can start."); }
  }
  function probeStorage() {
    try {
      // A separate random probe cannot overwrite another tab's operation.
      const probe = `${FILE_SHADOW_PILOT_JOURNAL_KEY}:probe:${createUuid()}`;
      storage().setItem(probe, "1");
      if (storage().getItem(probe) !== "1") fail();
      storage().removeItem(probe);
    } catch { fail("Persistent browser storage is unavailable. No command was sent."); }
  }
  function saveJournal(next: PilotJournal, expected: PilotJournal | null) {
    try {
      if (JSON.stringify(loadJournal()) !== JSON.stringify(expected)) fail();
      const text = JSON.stringify(parseJournal(next));
      storage().setItem(FILE_SHADOW_PILOT_JOURNAL_KEY, text);
      if (storage().getItem(FILE_SHADOW_PILOT_JOURNAL_KEY) !== text) fail();
    } catch { fail("The operation could not be saved. Keep its existing receipt and inspect it before continuing."); }
  }
  async function locked<T>(action: () => Promise<T>): Promise<T> {
    if (options.withLock) return options.withLock(action);
    if (typeof navigator === "undefined" || !navigator.locks) return fail("This browser cannot safely coordinate the pilot. Use a browser with Web Locks support.");
    return navigator.locks.request(FILE_SHADOW_PILOT_JOURNAL_KEY, { mode: "exclusive", ifAvailable: true }, (lock) => {
      if (!lock) return fail("Another tab is handling this File operation. Inspect its saved receipt after it finishes.");
      return action();
    });
  }
  async function request(path: string, payload?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(`/api/files/shadow/${path}`, { cache: "no-store", credentials: "same-origin", redirect: "error",
        ...(payload === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }) });
    } catch { return fail("The response was lost. Refresh the runtime state or inspect the same saved operation; do not start another conversion."); }
    if (!response.ok) {
      if (response.status === 404 && path === "operation") return fail("No receipt is visible yet. Keep this saved operation and inspect it again.");
      if (response.status === 401 || response.status === 403) return fail("Access is unavailable. Sign in again, then inspect the same saved operation.");
      return fail("The command was not confirmed. Refresh the current state and inspect the same saved operation.");
    }
    try {
      if (!response.body) fail();
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); fail(); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const all = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
    } catch { return fail(); }
  }
  function rememberStatus(raw: unknown) { const status = parseStatus(raw); statuses.set(status, JSON.stringify(status)); return status; }
  function checkedStatus(status: PilotStatus, enabled: boolean) {
    if (statuses.get(status) !== JSON.stringify(status) || enabled && (!status.enabled || status.mode !== "overlap" || !status.incarnation)) fail("Read the current runtime state before this command.");
    return status;
  }
  function checkedBaseline(baseline: PilotBaseline) {
    if (baselines.get(baseline) !== JSON.stringify(baseline)) fail("Inspect this consumer again before continuing.");
    return baseline;
  }
  const invalidateBaselines = () => { baselines = new WeakMap(); };
  async function statusCommand(path: string, payload: unknown): Promise<PilotStatus> {
    if (path !== "disable") { loadJournal(); probeStorage(); }
    invalidateBaselines();
    return rememberStatus(await request(path, payload));
  }
  async function observe(path: "operation" | "reconcile" | "cancel", expectedOperationId: string, status?: PilotStatus): Promise<PilotOperation> {
    return locked(async () => {
      const journal = loadJournal(); if (!journal) return fail("There is no saved File operation to inspect.");
      if (journal.request.operationId !== expectedOperationId) fail("The saved operation changed in another tab. Refresh and review it before continuing.");
      if (path !== "operation") {
        checkedStatus(status!, true); probeStorage();
        if (journal.receipt?.status !== "pending" || (path === "reconcile" ? journal.receipt.nextAction !== "reconcile" : !canCancelReceipt(journal.receipt))) fail("Inspect the saved operation before choosing its next action.");
        invalidateBaselines();
      }
      const receipt = await parseResponseOperation(await request(path, { operationId: journal.request.operationId,
        runtimeIncarnation: path === "operation" ? journal.request.runtimeIncarnation : status!.incarnation }), journal);
      // Never regress a stored terminal receipt, even if a stale read arrives.
      if (isTerminalReceipt(journal.receipt) && JSON.stringify(receipt) !== JSON.stringify(journal.receipt)) fail("The saved terminal receipt changed. Keep it and inspect the current state.");
      saveJournal({ ...journal, receipt }, journal);
      return receipt;
    });
  }
  return {
    getStatus: async () => rememberStatus(await request("status")),
    listConsumers: async (cursor) => {
      const raw = object(await request(`consumers?limit=20${cursor ? `&after=${encodeURIComponent(JSON.stringify(key(cursor)))}` : ""}`));
      if (!Array.isArray(raw.records) || raw.records.length > 20) fail();
      const records = raw.records.map((value): PilotConsumer => {
        const row = object(value);
        return { key: key({ consumerKind: row.consumer_kind, consumerId: row.consumer_id, consumerSubId: row.consumer_sub_id, fileSlot: row.file_slot }),
          generation: integer(row.generation, 1), occurrenceId: string(row.occurrence_id), state: choice(row.state, ["pending", "resolved", "admitted_unresolved"] as const) };
      });
      const nextCursor = raw.nextCursor === null ? null : key(raw.nextCursor);
      if (nextCursor && (records.length !== 20 || !sameKey(records[records.length - 1].key, nextCursor))) fail();
      return { records, nextCursor };
    },
    getBaseline: async (input) => {
      const parsed = key(input), result = parseBaseline(await request("baseline", { key: parsed }), parsed);
      baselines.set(result, JSON.stringify(result)); return result;
    },
    enable: async (status) => {
      checkedStatus(status, false); if (status.enabled) return fail("Pause or refresh the runtime before enabling it again.");
      return locked(() => statusCommand("enable", { requestId: createUuid(), expectedEpoch: status.epoch, expectedIncarnation: status.incarnation }));
    },
    enableProfile: async (baseline) => {
      checkedBaseline(baseline); if (!canEnableProfile(baseline)) return fail("This consumer does not qualify for admission of its recorded R2 profile.");
      return locked(() => statusCommand("profiles/enable", { profile: { profileId: baseline.sourceProfile!.profileId, configurationRevision: 1 },
        runtimeIncarnation: baseline.runtime.incarnation, expectedEpoch: baseline.epoch }));
    },
    pause: async (status) => {
      checkedStatus(status, true);
      return statusCommand("disable", { runtimeIncarnation: status.incarnation, expectedEpoch: status.epoch });
    },
    convert: async (baseline) => locked(async () => {
      checkedBaseline(baseline);
      if (!canConvertBaseline(baseline)) return fail("This current consumer is not ready for a verified R2 copy.");
      if (loadJournal()) return fail("Inspect and explicitly dismiss the saved terminal receipt before starting another conversion.");
      const journal: PilotJournal = { version: 1, request: { operationId: createUuid(), key: { ...baseline.key }, expectedBaselineSha256: baseline.baselineSha256,
        destinationProfile: { profileId: baseline.sourceProfile!.profileId, configurationRevision: 1 }, runtimeIncarnation: baseline.runtime.incarnation! },
        proof: { generation: baseline.head!.generation, occurrenceId: baseline.head!.occurrenceId, purpose: baseline.purpose!, expectedBytes: baseline.expectedBytes!, expectedSha256: baseline.expectedSha256! }, receipt: null };
      saveJournal(journal, null); invalidateBaselines();
      const receipt = await parseResponseOperation(await request("convert", journal.request), journal);
      saveJournal({ ...journal, receipt }, journal); return receipt;
    }),
    inspectOperation: (expectedOperationId) => observe("operation", expectedOperationId),
    reconcileOperation: (status, expectedOperationId) => observe("reconcile", expectedOperationId, status),
    cancelOperation: (status, expectedOperationId) => observe("cancel", expectedOperationId, status),
    withdrawOperation: (expectedOperationId) => locked(async () => {
      const journal = loadJournal(); if (!journal) return fail("There is no saved File operation to close.");
      if (journal.request.operationId !== expectedOperationId) fail("The saved operation changed in another tab. Refresh and review it before continuing.");
      if (journal.receipt !== null) fail("Inspect the saved operation before choosing its next action.");
      probeStorage(); invalidateBaselines();
      // The original request is the identity to withdraw, even after a pause or
      // runtime change. An existing accepted operation is only observed here.
      const receipt = await parseResponseOperation(await request("withdraw", journal.request), journal);
      saveJournal({ ...journal, receipt }, journal);
      return receipt;
    }),
    loadJournal,
    clearTerminalReceipt: (expectedOperationId) => locked(async () => {
      const journal = loadJournal();
      if (journal && journal.request.operationId !== expectedOperationId) fail("The saved operation changed in another tab. Refresh and review it before continuing.");
      if (!journal || !isTerminalReceipt(journal.receipt)) return fail("Only a confirmed terminal receipt can be dismissed.");
      if (journal.receipt?.status === "withdrawn"
        && journal.receipt.requestSha256 !== await shadowWithdrawalRequestSha256(journal.request)) fail();
      try {
        if (JSON.stringify(loadJournal()) !== JSON.stringify(journal)) fail();
        storage().removeItem(FILE_SHADOW_PILOT_JOURNAL_KEY);
        if (storage().getItem(FILE_SHADOW_PILOT_JOURNAL_KEY) !== null) fail();
      } catch { fail("The terminal receipt could not be dismissed. Keep it and inspect the saved operation."); }
      invalidateBaselines();
    }),
  };
}

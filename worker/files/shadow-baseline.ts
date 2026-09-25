import { sha256Hex } from "../../shared/domain/content-addressing";
import type { ExportSchemaObject } from "../../shared/contracts/export";
import type { FilePurpose } from "../../shared/contracts/files";
import { FILE_SHADOW_SCHEMA_FINGERPRINT_SHA256, fileShadowSchemaFingerprint } from "../../shared/contracts/export-file-shadow";
import { MAX_VERIFIED_BYTES } from "./byte-verification";
import { liveConsumerMetadataSql, projectLiveConsumerMetadata, MAX_LIVE_CONSUMER_PAGE_BYTES,
  MAX_LIVE_CONSUMER_EVIDENCE_ROWS, MAX_LIVE_CONSUMER_SOURCE_ROWS, MAX_LIVE_CONSUMER_SOURCE_KEY_BYTES,
  type ConsumerMetadata, type LiveConsumerDatabase, type LiveConsumerKey, type LiveConsumerRecord } from "./live-consumer-baseline";

export interface ShadowHead {
  consumer_kind: string; consumer_id: string; consumer_sub_id: string; file_slot: string;
  generation: number; occurrence_id: string; present: number; source_rowid: number | null;
  source_sha256: string; observed_epoch: number;
}
export interface ShadowDecision {
  occurrence_id: string; operation_id: string; decision: "resolved" | "admitted_unresolved";
  file_id: string | null; location_id: string | null; baseline_sha256: string; reason: string | null;
  decided_by: string; decided_at: string;
}
export interface ShadowRuntimeGuard { incarnation: string | null; enabled: number; enabled_by: string | null; updated_at: string }
export interface ShadowBaseline {
  version: 1; kind: "file-shadow-baseline"; bytesVerified: false;
  key: LiveConsumerKey; schemaSha256: string; authority: ConsumerMetadata; epoch: number;
  runtime: ShadowRuntimeGuard; head: ShadowHead | null; record: LiveConsumerRecord | null;
  decision: ShadowDecision | null; purpose: FilePurpose | null;
  sourceLocator: { storeKind: string; provider: string; objectKey: string } | null;
  sourceProfile: { profileId: string; configurationRevision: number } | null;
  status: "absent" | "resolved" | "admitted_unresolved" | "pending_no_locator" | "unavailable" | "ambiguous" | "ready_to_verify";
  reasons: string[]; baselineSha256: string;
}

const encoder = new TextEncoder();
export function canonicalShadowMetadata(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalShadowMetadata).join(",")}]`;
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, item]) => `${JSON.stringify(name)}:${canonicalShadowMetadata(item)}`).join(",") + "}";
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  throw new Error("Invalid shadow metadata");
}
export function checkedShadowKey(value: unknown): LiveConsumerKey {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "consumerId,consumerKind,consumerSubId,fileSlot"
    || Object.values(value).some((v) => typeof v !== "string") || encoder.encode(canonicalShadowMetadata(value)).length > 64 * 1024) throw new Error("Invalid shadow consumer key");
  return JSON.parse(canonicalShadowMetadata(value)) as LiveConsumerKey;
}
const keyMatch = (alias: string) => `${alias}.consumer_kind=?2 AND ${alias}.consumer_id=?3 AND ${alias}.consumer_sub_id=?4 AND ${alias}.file_slot=?5`;
const EXTRA = `(SELECT epoch FROM file_shadow_control WHERE singleton=1) shadow_epoch,
  (SELECT json_object('storeKind',o.legacy_store_kind,'provider',o.legacy_provider,'objectKey',o.legacy_object_key)
    FROM file_shadow_occurrences o JOIN file_shadow_heads h ON h.occurrence_id=o.id WHERE ${keyMatch("h")}) shadow_locator,
  (SELECT json_object('incarnation',incarnation,'enabled',enabled,'enabled_by',enabled_by,'updated_at',updated_at) FROM file_shadow_runtime_guard WHERE singleton=1) shadow_runtime,
  (SELECT CASE WHEN length(CAST(source_json AS BLOB))<=524288 THEN json_object('consumer_kind',consumer_kind,'consumer_id',consumer_id,'consumer_sub_id',consumer_sub_id,'file_slot',file_slot,'generation',generation,
    'occurrence_id',occurrence_id,'present',present,'source_rowid',source_rowid,'source_json',source_json,'observed_epoch',observed_epoch)
    END FROM file_shadow_heads h WHERE ${keyMatch("h")}) shadow_head,
  (SELECT length(CAST(source_json AS BLOB)) FROM file_shadow_heads h WHERE ${keyMatch("h")}) shadow_head_bytes,
  (SELECT json_object('occurrence_id',d.occurrence_id,'operation_id',d.operation_id,'decision',d.decision,'file_id',d.file_id,'location_id',d.location_id,
    'baseline_sha256',d.baseline_sha256,'reason',d.reason,'decided_by',d.decided_by,'decided_at',d.decided_at)
    FROM file_shadow_decisions d JOIN file_shadow_heads h ON h.occurrence_id=d.occurrence_id WHERE ${keyMatch("h")}) shadow_decision,`;

function qualifiedPurpose(record: LiveConsumerRecord): FilePurpose | null {
  if (record.purpose) return record.purpose;
  if (record.key.consumerKind === "metrology_template_reference" && record.receipts.some((r) =>
    r.table === "metrology_reference_upload_requests" && r.status === "ready" && r.result_valid === 1
    && r.result_reference_id === record.key.consumerId && r.result_blob_id === record.source.asset_id
    && r.template_version_id === record.source.template_version_id && r.purpose === "research_source")) return "research_source";
  // An exact accepted source result can establish intent; placement in a Project
  // alone cannot. An ordinary-image receipt does not create research-source intent.
  if (record.key.consumerKind === "project_content_attachment" && record.receipts.some((r) =>
    r.status === "ready" && r.result_valid === 1 && r.purpose === "research_source"
    && r.result_blob_id === (record.source.asset_id ?? record.source.storage_object_id)
    && r.result_object_key === record.locator?.objectKey && r.result_provider === record.locator?.provider)) return "research_source";
  return null;
}

/** A fresh V15 metadata read qualifies a conversion candidate, never a write
 * lease. The sidecar epoch and head are captured in the SAME primary SELECT as
 * every metadata dependency. The V14 preflight protocol remains frozen. */
export async function readShadowBaseline(database: LiveConsumerDatabase, inputKey: LiveConsumerKey): Promise<ShadowBaseline> {
  const key = checkedShadowKey(inputKey);
  const db = database.withSession ? database.withSession("first-primary") : database;
  const result = await db.prepare(liveConsumerMetadataSql(MAX_LIVE_CONSUMER_EVIDENCE_ROWS, "exact", EXTRA))
    .bind(1, key.consumerKind, key.consumerId, key.consumerSubId, key.fileSlot, 2, 1, MAX_LIVE_CONSUMER_PAGE_BYTES)
    .all<{ authority_json: string; schema_json: string | null; invalid_rowid_claims: number; source_row_count: number; source_key_bytes: number;
      page_count: number; record_count: number; payload_bytes: number; records_json: string | null;
      shadow_epoch: number | null; shadow_head: string | null; shadow_head_bytes: number | null; shadow_runtime: string | null; shadow_decision: string | null; shadow_locator: string | null }>();
  if (!result.success || result.results.length !== 1) throw new Error("Incomplete shadow baseline snapshot");
  const row = { ...result.results[0] };
  if (!Number.isSafeInteger(row.source_row_count) || row.source_row_count < 0 || row.source_row_count > MAX_LIVE_CONSUMER_SOURCE_ROWS
    || !Number.isSafeInteger(row.source_key_bytes) || row.source_key_bytes < 0 || row.source_key_bytes > MAX_LIVE_CONSUMER_SOURCE_KEY_BYTES) throw new Error("Shadow baseline source bound exceeded");
  if (row.invalid_rowid_claims !== 0 || typeof row.schema_json !== "string" || encoder.encode(row.schema_json).length > 2 * 1024 * 1024) throw new Error("Incomplete shadow schema snapshot");
  const schema = JSON.parse(row.schema_json) as ExportSchemaObject[];
  if (!Array.isArray(schema) || schema.length > 1000 || await fileShadowSchemaFingerprint(schema) !== FILE_SHADOW_SCHEMA_FINGERPRINT_SHA256) throw new Error("Unsupported shadow schema generation");
  if (!Number.isSafeInteger(row.shadow_epoch) || Number(row.shadow_epoch) < 0 || typeof row.shadow_runtime !== "string") throw new Error("Incomplete shadow runtime snapshot");
  if (row.page_count !== row.record_count || ![0, 1].includes(row.record_count) || !Number.isSafeInteger(row.payload_bytes)
    || row.payload_bytes < 0 || row.payload_bytes > MAX_LIVE_CONSUMER_PAGE_BYTES || typeof row.records_json !== "string"
    || encoder.encode(row.records_json).length > MAX_LIVE_CONSUMER_PAGE_BYTES) throw new Error("Incomplete or oversized shadow consumer snapshot");
  if (row.shadow_head_bytes !== null && (!Number.isSafeInteger(row.shadow_head_bytes) || row.shadow_head_bytes < 0 || row.shadow_head_bytes > MAX_LIVE_CONSUMER_PAGE_BYTES)
    || encoder.encode(row.shadow_head ?? "").length + encoder.encode(row.records_json).length > MAX_LIVE_CONSUMER_PAGE_BYTES) throw new Error("Shadow generation metadata bound exceeded");
  const authority = JSON.parse(row.authority_json) as ConsumerMetadata[];
  if (authority.length !== 1 || authority[0].singleton !== 1 || authority[0].revision !== 1
    || !["legacy", "overlap"].includes(String(authority[0].mode))) throw new Error("Unsupported shadow authority mode");
  const runtime = JSON.parse(row.shadow_runtime) as ShadowRuntimeGuard;
  if (![0, 1].includes(runtime.enabled) || runtime.enabled === 1 && (typeof runtime.incarnation !== "string" || !runtime.incarnation)) throw new Error("Invalid shadow runtime guard");
  const rawHead = row.shadow_head === null ? null : JSON.parse(row.shadow_head) as Omit<ShadowHead, "source_sha256"> & { source_json: string };
  let head: ShadowHead | null = null;
  if (rawHead) {
    const { source_json, ...safeHead } = rawHead;
    if (typeof source_json !== "string") throw new Error("Invalid shadow source metadata");
    head = { ...safeHead, source_sha256: await sha256Hex(source_json) };
  }
  const decision = row.shadow_decision === null ? null : JSON.parse(row.shadow_decision) as ShadowDecision;
  const rawLocator = row.shadow_locator === null ? null : JSON.parse(row.shadow_locator) as { storeKind: string | null; provider: string | null; objectKey: string | null };
  const sourceLocator = rawLocator && typeof rawLocator.storeKind === "string" && typeof rawLocator.provider === "string" && typeof rawLocator.objectKey === "string"
    ? { storeKind: rawLocator.storeKind, provider: rawLocator.provider, objectKey: rawLocator.objectKey } : null;
  const records = await projectLiveConsumerMetadata(row.records_json, authority[0], FILE_SHADOW_SCHEMA_FINGERPRINT_SHA256, MAX_LIVE_CONSUMER_EVIDENCE_ROWS);
  if (records.length !== row.record_count || head && (head.consumer_kind !== key.consumerKind || head.consumer_id !== key.consumerId
    || head.consumer_sub_id !== key.consumerSubId || head.file_slot !== key.fileSlot || !Number.isSafeInteger(head.generation)
    || head.generation < 1 || ![0, 1].includes(head.present))) throw new Error("Shadow generation identity mismatch");
  const record = records[0] ?? null;
  if (record && (!head || !head.present)) throw new Error("Live consumer is missing its shadow generation");
  if (decision && (!head || decision.occurrence_id !== head.occurrence_id)) throw new Error("Shadow decision generation mismatch");
  const purpose = record ? qualifiedPurpose(record) : null;
  const reasons = record ? [...record.reasons] : [];
  // Independent copies solve cross-purpose physical ownership. They do not
  // establish missing semantic intent, byte metadata or derivation trust.
  const copyResolvable = new Set(["independent_verified_copies_required", "shared_locator_purpose_unresolved", "recorded_purpose_conflict"]);
  if (purpose) { copyResolvable.add("consumer_purpose_unresolved"); }
  const blockers = reasons.filter((reason) => !copyResolvable.has(reason));
  if (record?.registries.some((r) => Number(r.byte_size) > MAX_VERIFIED_BYTES)) blockers.push("source_exceeds_verified_byte_limit");
  const sourceProfiles = record?.profiles.filter((p) => p.adapter_type === record.locator?.provider && p.runtime_state !== "retired") ?? [];
  const sourceProfile = sourceProfiles.length === 1 ? { profileId: String(sourceProfiles[0].id), configurationRevision: Number(sourceProfiles[0].configuration_revision) } : null;
  if (record?.locator && !sourceProfile && !blockers.includes("namespace_evidence_missing")) blockers.push("source_profile_unresolved");
  let status: ShadowBaseline["status"] = !head || !head.present || !record ? "absent" : record.status;
  if (record && purpose && sourceProfile && blockers.length === 0 && record.locator) status = "ready_to_verify";
  else if (status === "ready_to_verify") status = "ambiguous";
  if (decision) status = decision.decision;
  const baseline = { version: 1 as const, kind: "file-shadow-baseline" as const, bytesVerified: false as const, key,
    schemaSha256: FILE_SHADOW_SCHEMA_FINGERPRINT_SHA256, authority: authority[0], epoch: row.shadow_epoch as number,
    runtime, head, record, decision, purpose, sourceLocator, sourceProfile, status, reasons: [...new Set(blockers)].sort() };
  const baselineSha256 = await sha256Hex(canonicalShadowMetadata(baseline));
  const report = { ...baseline, baselineSha256 };
  if (encoder.encode(canonicalShadowMetadata(report)).length > MAX_LIVE_CONSUMER_PAGE_BYTES) throw new Error("Shadow baseline output byte bound exceeded");
  return report;
}

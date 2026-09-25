import { sha256Hex } from "../../shared/domain/content-addressing";
import type { FilePurpose } from "../../shared/contracts/files";
import type { ExportSchemaObject } from "../../shared/contracts/export";
import { FILE_AUTHORITY_SCHEMA_FINGERPRINT_SHA256, FILE_REGISTRY_ROWID_CLAIMS_INTEGRITY_SQL, fileAuthoritySchemaFingerprint } from "../../shared/contracts/export-file-authority";
import { validateCommentAcceptedItemResult } from "../../shared/contracts/comment-acceptance";
import { validateMetrologyReferenceUploadResult } from "../../shared/contracts/metrology-reference-upload";

/** Metadata capability only. D1 bindings select first-primary inside this reader.
 * An adapter without Sessions must be a local, transactionally consistent SQLite
 * connection, never an eventually consistent remote facade. Authorization of the
 * caller and of the resulting metadata report belongs to the caller. */
export interface LiveConsumerStatement {
  bind(...values: unknown[]): LiveConsumerStatement;
  all<T>(): Promise<{ success: boolean; results: T[] }>;
}
export interface LiveConsumerDatabase {
  prepare(sql: string): LiveConsumerStatement;
  withSession?(constraint: "first-primary"): LiveConsumerDatabase;
}
export const MAX_LIVE_CONSUMER_PAGE_SIZE = 20;
export const MAX_LIVE_CONSUMER_PAGE_BYTES = 512 * 1024;
export const MAX_LIVE_CONSUMER_EVIDENCE_ROWS = 100;
/** Qualification cap: this first reader intentionally fails on larger source
 * inventories until an indexed catch-up protocol is separately implemented. */
export const MAX_LIVE_CONSUMER_SOURCE_ROWS = 20_000;
export const MAX_LIVE_CONSUMER_SOURCE_KEY_BYTES = 8 * 1024 * 1024;
export interface LiveConsumerKey {
  consumerKind: string;
  consumerId: string;
  consumerSubId: string;
  fileSlot: string;
}
type Scalar = string | number | null;
type Metadata = Record<string, Scalar>;
export type LiveConsumerStatus = "pending_no_locator" | "unavailable" | "ambiguous" | "ready_to_verify";
export interface LiveConsumerRecord {
  key: LiveConsumerKey;
  source: Metadata;
  related: Record<string, Metadata | null>;
  fileId: string | null;
  locator: { storeKind: string; provider: string; objectKey: string } | null;
  registries: Metadata[];
  receipts: Metadata[];
  profiles: Metadata[];
  mappings: Metadata[];
  lifecycle: Metadata[];
  retention: Metadata[];
  peers: Metadata[];
  purpose: FilePurpose | null;
  status: LiveConsumerStatus;
  reasons: string[];
  baselineSha256: string;
}
export interface LiveConsumerBaseline {
  version: 1;
  kind: "file-consumer-live-baseline";
  executable: false;
  bytesVerified: false;
  authority: Metadata;
  schemaSha256: string;
  records: LiveConsumerRecord[];
  nextCursor: LiveConsumerKey | null;
  baselineSha256: string;
}
export interface LiveConsumerBaselineInput {
  limit?: number;
  after?: LiveConsumerKey;
  maxBytes?: number;
  maxEvidenceRows?: number;
}

const encoder = new TextEncoder();
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => compare(a, b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",") + "}";
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  throw new Error("Live consumer baseline contains invalid metadata");
}
const fields = (alias: string, columns: string) => columns.split(" ").map((name) => `'${name}',${alias}.${name}`).join(",");
const object = (alias: string, columns: string) => `json_object(${fields(alias, columns)})`;
const row = (table: string, alias: string, columns: string, where: string) =>
  `(SELECT ${object(alias, columns)} FROM ${table} ${alias} WHERE ${where})`;
const sample = (condition: string) => row("samples", "s", "id status deleted_at updated_at", condition);
const step = (condition: string) => row("run_steps", "rs", "id run_id status plan_status deleted_at updated_at last_mutation_id", condition);
const run = (condition: string) => row("runs", "r", "id sample_id status deleted_at completed_at last_mutation_id", condition);
const template = (condition: string) => row("template_versions", "t", "id recipe_family_id template_kind archived_at deleted_at locked_at source_asset_key source_file_id", condition);
const submission = (condition: string) => row("comment_submissions", "cs", "id context_kind sample_id scope status updated_at completed_at cancelled_at deleted_at deletion_operation_id retry_until retry_closed_at last_mutation_id", condition);
function related(entries: Record<string, string>) {
  return `json_object(${Object.entries(entries).map(([name, sql]) => `'${name}',json(${sql})`).join(",")})`;
}
interface Slot {
  table: string; kind: string; id?: string; sub?: string; slot: string; file: string;
  asset?: string; managed?: string; direct?: string; purpose: string; columns: string; related?: string; where?: string;
}
const slots: Slot[] = [
  { table: "state_representation_assets", kind: "state_representation_asset", id: "state_hash", sub: "asset_id", slot: "primary", file: "file_id", asset: "asset_id",
    columns: "state_hash asset_id position file_id", purpose: "CASE WHEN EXISTS(SELECT 1 FROM state_representations s WHERE s.hash=x.state_hash AND s.representation_type='diagram') THEN 'embedded_content' END",
    related: related({ state: row("state_representations", "s", "hash hash_scheme representation_type logical_state_key created_at", "s.hash=x.state_hash") }) },
  { table: "run_step_assets", kind: "run_step_asset", slot: "primary", file: "file_id", asset: "asset_id",
    columns: "id run_step_id asset_id role position file_id deleted_at superseded_by_occurrence_id superseded_at supersession_operation_id last_mutation_id byte_size",
    purpose: "CASE WHEN x.role IN ('execution','state_observation') THEN 'embedded_content' END",
    related: related({ step: step("rs.id=x.run_step_id"), run: run("r.id=(SELECT run_id FROM run_steps WHERE id=x.run_step_id)"), sample: sample("s.id=(SELECT sample_id FROM runs WHERE id=(SELECT run_id FROM run_steps WHERE id=x.run_step_id))") }) },
  { table: "metrology_template_references", kind: "metrology_template_reference", slot: "primary", file: "file_id", asset: "asset_id",
    columns: "id template_version_id asset_id file_id position deleted_at superseded_by_occurrence_id superseded_at supersession_operation_id", purpose: "NULL",
    related: related({ template: template("t.id=x.template_version_id") }) },
  { table: "run_step_comments", kind: "run_step_comment", slot: "primary", file: "file_id", asset: "asset_id", where: "x.asset_id IS NOT NULL OR x.file_id IS NOT NULL",
    columns: "id run_step_id submission_id asset_id file_id scope operation_group_id updated_at deleted_at asset_deleted_at deletion_operation_id asset_deletion_operation_id last_mutation_id", purpose: "'embedded_content'",
    related: related({ step: step("rs.id=x.run_step_id"), run: run("r.id=(SELECT run_id FROM run_steps WHERE id=x.run_step_id)"), submission: submission("cs.id=x.submission_id") }) },
  { table: "state_verifications", kind: "state_verification", slot: "evidence", file: "evidence_file_id", asset: "evidence_asset_id", where: "x.evidence_asset_id IS NOT NULL OR x.evidence_file_id IS NOT NULL",
    columns: "id sample_id after_run_step_id previous_verification_id expected_state_hash result status evidence_asset_id evidence_file_id created_at", purpose: "'embedded_content'",
    related: related({ sample: sample("s.id=x.sample_id"), step: step("rs.id=x.after_run_step_id") }) },
  { table: "comment_submission_items", kind: "comment_submission_item", slot: "primary", file: "file_id", asset: "asset_id", managed: "storage_object_id",
    where: "x.kind<>'link' OR x.asset_id IS NOT NULL OR x.storage_object_id IS NOT NULL OR x.file_id IS NOT NULL",
    columns: "id submission_id kind status position asset_id storage_object_id file_id sha256 byte_size related_item_id updated_at deleted_at",
    purpose: "CASE WHEN x.kind='attachment' THEN 'research_source' WHEN x.kind='comment_image' AND x.related_item_id IS NULL THEN 'embedded_content' WHEN x.kind='comment_image' AND EXISTS(SELECT 1 FROM comment_submission_items c WHERE c.id=x.related_item_id AND c.submission_id=x.submission_id AND c.related_item_id=x.id AND c.kind='attachment') THEN 'derived_preview' END",
    related: related({ submission: submission("cs.id=x.submission_id"), pairedItem: row("comment_submission_items", "c", "id submission_id kind status asset_id storage_object_id file_id sha256 byte_size related_item_id updated_at deleted_at", "c.id=x.related_item_id"), sample: sample("s.id=(SELECT sample_id FROM comment_submissions WHERE id=x.submission_id)") }) },
  { table: "project_content_attachments", kind: "project_content_attachment", id: "project_content_id", slot: "primary", file: "file_id", asset: "asset_id", managed: "storage_object_id",
    columns: "project_content_id asset_id storage_object_id file_id byte_size created_at creation_operation_id", purpose: "NULL",
    related: related({ content: row("project_contents", "c", "id project_id content_type revision last_mutation_id updated_at deleted_at deletion_operation_id", "c.id=x.project_content_id"), project: row("projects", "p", "id revision last_mutation_id updated_at deleted_at deletion_operation_id", "p.id=(SELECT project_id FROM project_contents WHERE id=x.project_content_id)") }) },
  { table: "attachment_derivatives", kind: "attachment_derivative", slot: "derived", file: "derived_file_id", asset: "derived_asset_id",
    columns: "id source_sha256 source_byte_size derivative_kind generator_version derived_asset_id derived_file_id status retain_until updated_at", purpose: "CASE WHEN x.derivative_kind='browser_preview' THEN 'derived_preview' END" },
  { table: "events", kind: "event", slot: "primary", file: "asset_file_id", direct: "x.asset_key", where: "x.asset_key IS NOT NULL OR x.asset_file_id IS NOT NULL",
    columns: "id sample_id kind asset_key asset_file_id thumbnail_file_id created_at", purpose: "CASE WHEN x.kind='image' AND CASE WHEN json_valid(x.metadata_json) THEN json_extract(x.metadata_json,'$.action') END='sample_record' THEN 'embedded_content' END",
    related: related({ sample: sample("s.id=x.sample_id"), eventMetadata: "json_object('action',CASE WHEN json_valid(x.metadata_json) THEN json_extract(x.metadata_json,'$.action') END,'thumbnailKey',CASE WHEN json_valid(x.metadata_json) THEN json_extract(x.metadata_json,'$.thumbnailKey') END,'valid',json_valid(x.metadata_json))" }) },
  { table: "events", kind: "event", slot: "thumbnail", file: "thumbnail_file_id", direct: "CASE WHEN json_valid(x.metadata_json) THEN CASE WHEN json_type(x.metadata_json,'$.thumbnailKey')='text' THEN json_extract(x.metadata_json,'$.thumbnailKey') END END",
    where: "(CASE WHEN json_valid(x.metadata_json) THEN json_type(x.metadata_json,'$.thumbnailKey')<>'null' END) OR x.thumbnail_file_id IS NOT NULL",
    columns: "id sample_id kind asset_key asset_file_id thumbnail_file_id created_at", purpose: "CASE WHEN x.asset_key IS NOT NULL AND x.asset_key<>CASE WHEN json_valid(x.metadata_json) THEN json_extract(x.metadata_json,'$.thumbnailKey') END THEN 'derived_preview' END",
    related: related({ sample: sample("s.id=x.sample_id"), eventMetadata: "json_object('action',CASE WHEN json_valid(x.metadata_json) THEN json_extract(x.metadata_json,'$.action') END,'thumbnailKey',CASE WHEN json_valid(x.metadata_json) THEN json_extract(x.metadata_json,'$.thumbnailKey') END,'valid',json_valid(x.metadata_json))" }) },
  ...(["workbook", "manifest"] as const).map((slot): Slot => ({ table: "imports", kind: "import", slot, file: `${slot}_file_id`, direct: `x.${slot}_asset_key`, where: `x.${slot}_asset_key IS NOT NULL OR x.${slot}_file_id IS NOT NULL OR x.client_request_id IS NOT NULL`,
    columns: "id status source_sha256 workbook_asset_key manifest_asset_key workbook_file_id manifest_file_id template_version_id operation_id lease_expires_at finalization_id recovery_operation_id completed_at client_request_id request_sha256 request_scope storage_profile_id storage_profile_revision storage_policy_revision", purpose: "'provenance'" })),
  { table: "template_versions", kind: "template_version", slot: "source", file: "source_file_id", direct: "x.source_asset_key", where: "x.source_asset_key IS NOT NULL OR x.source_file_id IS NOT NULL",
    columns: "id recipe_family_id template_kind manifest_hash source_asset_key source_file_id locked_at archived_at deleted_at", purpose: "'provenance'" },
];
const ENTRIES = slots.map((s) => `SELECT '${s.kind}' consumer_kind,x.${s.id ?? "id"} consumer_id,${s.sub ? `x.${s.sub}` : "''"} consumer_sub_id,'${s.slot}' file_slot,
  x.${s.file} file_id,${s.asset ? `x.${s.asset}` : "NULL"} asset_id,${s.managed ? `x.${s.managed}` : "NULL"} managed_id,${s.direct ?? "NULL"} direct_key,
  ${s.purpose} purpose FROM ${s.table} x WHERE (SELECT count<=${MAX_LIVE_CONSUMER_SOURCE_ROWS} AND key_bytes<=${MAX_LIVE_CONSUMER_SOURCE_KEY_BYTES} FROM source_scope) ${s.where ? `AND (${s.where})` : ""}`);
function hydrate(part: "source" | "related") {
  return "CASE " + slots.map((s) => `WHEN p.consumer_kind='${s.kind}' AND p.file_slot='${s.slot}' THEN
    (SELECT ${part === "source" ? object("x", s.columns) : s.related ?? "'{}'"} FROM ${s.table} x
      WHERE x.${s.id ?? "id"}=p.consumer_id ${s.sub ? `AND x.${s.sub}=p.consumer_sub_id` : ""})`).join(" ") + " END";
}

// Every dependency is read by this ONE SELECT. LIMIT+1 detects overflow before
// classification; SQL also withholds payloads larger than the whole page budget.
// No cursor encodes a concatenated or split relational identity.
function query(evidenceLimit: number) {
  const array = (select: string) => `(SELECT json_group_array(json(value)) FROM (${select} LIMIT ${evidenceLimit + 1}))`;
  const same = (alias: string) => `((${alias}.store_kind='r2' AND ${alias}.provider='r2' AND ${alias}.object_key=p.r2_key)
    OR (${alias}.store_kind='managed' AND ${alias}.provider=p.managed_provider AND ${alias}.object_key=p.managed_key))`;
  const receipts = array(`SELECT json_object('table','imports',${fields("i", "id status request_sha256 request_scope storage_profile_id storage_profile_revision storage_policy_revision accepted_result_json operation_id lease_expires_at recovery_operation_id finalization_id workbook_asset_key manifest_asset_key")}) value
    FROM imports i WHERE i.client_request_id IS NOT NULL AND (i.id=p.import_id OR (p.consumer_kind='import' AND i.id=p.consumer_id) OR i.workbook_asset_key=p.r2_key OR i.manifest_asset_key=p.r2_key)
    UNION ALL SELECT json_object('table','r2_upload_requests',${fields("r", "id status purpose request_scope request_sha256 storage_profile_id storage_profile_revision candidate_asset_id candidate_object_key accepted_result_json completed_at expires_at")})
    FROM r2_upload_requests r WHERE r.candidate_object_key=p.r2_key OR CASE WHEN json_valid(r.accepted_result_json) THEN json_extract(r.accepted_result_json,'$.key') END=p.r2_key
    UNION ALL SELECT json_object('table','metrology_reference_upload_requests',${fields("r", "id status purpose request_scope request_sha256 storage_profile_id storage_profile_revision candidate_asset_id candidate_reference_id candidate_object_key template_version_id accepted_result_json completed_at expires_at")})
    FROM metrology_reference_upload_requests r WHERE r.candidate_object_key=p.r2_key OR CASE WHEN json_valid(r.accepted_result_json) THEN json_extract(r.accepted_result_json,'$.reference.assetKey') END=p.r2_key OR (p.consumer_kind='metrology_template_reference' AND r.candidate_reference_id=p.consumer_id)
    UNION ALL SELECT json_object('table','comment_item_acceptances',${fields("r", "item_id submission_id status purpose expected_sha256 expected_byte_size storage_profile_id storage_profile_revision candidate_blob_id candidate_object_key accepted_result_json started_at")},'submission_status',cs.status,'submission_request_sha256',cs.request_sha256,'submission_completed_at',cs.completed_at,'submission_expires_at',cs.expires_at)
    FROM comment_item_acceptances r LEFT JOIN comment_submission_acceptances cs ON cs.submission_id=r.submission_id WHERE (p.consumer_kind='comment_submission_item' AND r.item_id=p.consumer_id)
    OR (r.candidate_object_key=COALESCE(p.r2_key,p.managed_key) AND ((r.purpose='research_source' AND p.managed_provider='switchdrive') OR (r.purpose<>'research_source' AND p.r2_key IS NOT NULL)))
    OR CASE WHEN json_valid(r.accepted_result_json) THEN json_extract(r.accepted_result_json,'$.objectKey')=COALESCE(p.r2_key,p.managed_key) AND json_extract(r.accepted_result_json,'$.provider')=CASE WHEN p.r2_key IS NOT NULL THEN 'r2' ELSE p.managed_provider END END`);
  const mappings = array(`SELECT json_object(${fields("m", "store_kind provider object_key file_id location_id classification observed_at")},'storage_profile_id',l.storage_profile_id,'location_object_key',l.object_key,'purpose',f.purpose,'access_scope',f.access_scope,'expected_byte_size',f.expected_byte_size,'expected_sha256',f.expected_sha256) value
    FROM legacy_file_mappings m LEFT JOIN file_locations l ON l.id=m.location_id LEFT JOIN files f ON f.id=m.file_id WHERE ${same("m")}`);
  const registries = array(`SELECT json_object('table','assets',${fields("a", "id import_id r2_key status sha256 byte_size created_at")}) value FROM assets a WHERE a.id=p.asset_id OR a.r2_key=p.r2_key
    UNION ALL SELECT json_object('table','managed_storage_objects',${fields("m", "id provider object_key status sha256 byte_size orphaned_at created_at")}) FROM managed_storage_objects m WHERE m.id=p.managed_id OR (m.provider=p.managed_provider AND m.object_key=p.managed_key)`);
  const lifecycle = array(`SELECT json_object('table','blob_gc_ledger',${fields("g", "store_kind provider object_key blob_record_id state operation_id orphaned_at deletion_started_at deleted_at attempt_count updated_at")}) value FROM blob_gc_ledger g WHERE ${same("g")}
    UNION ALL SELECT json_object('table','blob_integrity_quarantine',${fields("q", "store_kind provider object_key blob_record_id reason expected_byte_size observed_byte_size operation_id detected_at last_checked_at")}) FROM blob_integrity_quarantine q WHERE ${same("q")}`);
  const retention = array(`SELECT ${object("b", "store_kind provider object_key source_type source_id occurrence_type occurrence_id blob_record_id retention_reason retain_until")} value FROM blob_retention_edges b WHERE ${same("b")}`);
  const peers = array(`SELECT json_object(${fields("e", "consumer_kind consumer_id consumer_sub_id file_slot purpose file_id asset_id managed_id direct_key")}) value FROM located e WHERE (p.r2_key IS NOT NULL AND e.r2_key=p.r2_key) OR (p.managed_key IS NOT NULL AND e.managed_provider=p.managed_provider AND e.managed_key=p.managed_key)`);
  const profiles = array(`SELECT json_object(${fields("s", "id adapter_type namespace_identity configuration_source configuration_revision state created_at")},'runtime_state',r.state,'registered_at',r.registered_at,'activated_at',r.activated_at,'retired_at',r.retired_at) value FROM storage_profiles s LEFT JOIN storage_profile_runtime r ON r.storage_profile_id=s.id
    WHERE s.id IN (SELECT json_extract(value,'$.storage_profile_id') FROM json_each(p.receipts) UNION SELECT json_extract(value,'$.storage_profile_id') FROM json_each(p.mappings))`);
  const scope = [...new Set(slots.map((s) => s.table))].map((table) => `(SELECT count(*) FROM (SELECT 1 FROM ${table} LIMIT ${MAX_LIVE_CONSUMER_SOURCE_ROWS + 1}))`).join("+");
  const keyBytes = [...new Set(slots.map((s) => s.table))].map((table) => {
    const columns = [...new Set(slots.filter((s) => s.table === table).flatMap((s) => [s.id ?? "id", s.sub, s.file, s.asset, s.managed,
      ...(table === "events" ? ["asset_key", "metadata_json"] : table === "imports" ? ["workbook_asset_key", "manifest_asset_key"] : table === "template_versions" ? ["source_asset_key"] : [])].filter((v): v is string => Boolean(v))))];
    return `(SELECT COALESCE(sum(${columns.map((c) => `COALESCE(length(CAST(${c} AS BLOB)),0)`).join("+")}),0) FROM (SELECT ${columns.join(",")} FROM ${table} LIMIT ${MAX_LIVE_CONSUMER_SOURCE_ROWS + 1}))`;
  }).join("+");
  return `WITH source_scope AS MATERIALIZED (SELECT ${scope} count,${keyBytes} key_bytes), entries_relational AS MATERIALIZED (${ENTRIES.slice(0, 5).join(" UNION ALL ")}),
  entries_content AS MATERIALIZED (${ENTRIES.slice(5, 8).join(" UNION ALL ")}),
  entries_direct AS MATERIALIZED (${ENTRIES.slice(8).join(" UNION ALL ")}),
  entries AS (SELECT * FROM entries_relational UNION ALL SELECT * FROM entries_content UNION ALL SELECT * FROM entries_direct), located AS (
    SELECT e.*,COALESCE(e.direct_key,a.r2_key) r2_key,m.provider managed_provider,m.object_key managed_key,a.import_id
    FROM entries e LEFT JOIN assets a ON a.id=e.asset_id OR (e.asset_id IS NULL AND a.r2_key=e.direct_key) LEFT JOIN managed_storage_objects m ON m.id=e.managed_id
  ), page AS (SELECT * FROM located WHERE ?1=0 OR (consumer_kind,consumer_id,consumer_sub_id,file_slot)>(?2,?3,?4,?5)
    ORDER BY consumer_kind COLLATE BINARY,consumer_id COLLATE BINARY,consumer_sub_id COLLATE BINARY,file_slot COLLATE BINARY LIMIT ?6),
  evidence AS (SELECT p.*,${registries} registries,${receipts} receipts,${mappings} mappings,${lifecycle} lifecycle,${retention} retention,${peers} peers FROM page p LIMIT ?7),
  payloads AS (SELECT json_object('key',json_object('consumerKind',consumer_kind,'consumerId',consumer_id,'consumerSubId',consumer_sub_id,'fileSlot',file_slot),
    'source',json(${hydrate("source")}),'related',json(${hydrate("related")}),'fileId',file_id,'purpose',purpose,'r2Key',r2_key,'managedProvider',managed_provider,'managedKey',managed_key,
    'registries',json(registries),'receipts',json(receipts),'mappings',json(mappings),'lifecycle',json(lifecycle),'retention',json(retention),'peers',json(peers),'profiles',json(${profiles})) payload FROM evidence p),
  measured AS (SELECT payload,length(CAST(payload AS BLOB)) bytes FROM payloads),
  totals AS (SELECT count(*) count,COALESCE(sum(bytes),0) bytes FROM measured),
  schema_rows AS (SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name LIMIT 1001),
  schema_payload AS (SELECT json_group_array(json_object('type',type,'name',name,'tableName',tbl_name,'sql',sql)) payload,count(*) count FROM schema_rows)
  SELECT (SELECT json_group_array(json_object(${fields("c", "singleton mode revision updated_at activated_at")})) FROM file_authority_control c) authority_json,
    (SELECT CASE WHEN count<=1000 AND length(CAST(payload AS BLOB))<=2097152 THEN payload END FROM schema_payload) schema_json,
    (${FILE_REGISTRY_ROWID_CLAIMS_INTEGRITY_SQL}) invalid_rowid_claims,
    (SELECT count FROM source_scope) source_row_count,
    (SELECT key_bytes FROM source_scope) source_key_bytes,
    (SELECT count(*) FROM page) page_count,totals.count record_count,totals.bytes payload_bytes,
    CASE WHEN totals.bytes<=?8 THEN (SELECT json_group_array(json(payload)) FROM measured) END records_json FROM totals`;
}

function boundedInteger(value: number, maximum: number, label: string) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid live consumer ${label} bound`);
  return value;
}
function normalizedArray(value: unknown, maximum: number): Metadata[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error("Live consumer evidence row bound exceeded");
  for (const item of value) if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Live consumer snapshot evidence is incomplete");
  return (value as Metadata[]).sort((a, b) => compare(canonical(a), canonical(b)));
}
async function safeReceipts(receipts: Metadata[]): Promise<Metadata[]> {
  const result: Metadata[] = [];
  for (const receipt of receipts) {
    const { accepted_result_json: raw, ...safe } = receipt;
    safe.accepted_result_sha256 = typeof raw === "string" ? await sha256Hex(raw) : null;
    if (receipt.status === "ready") {
      try {
        if (typeof raw !== "string") throw new Error("Missing result");
        const parsed = JSON.parse(raw);
        if (receipt.table === "comment_item_acceptances") {
          const accepted = validateCommentAcceptedItemResult(parsed);
          Object.assign(safe, { result_store_kind: accepted.storeKind, result_provider: accepted.provider, result_object_key: accepted.objectKey,
            result_blob_id: accepted.blobRecordId, result_sha256: accepted.sha256, result_byte_size: accepted.byteSize });
        } else if (receipt.table === "metrology_reference_upload_requests") {
          validateMetrologyReferenceUploadResult(parsed);
          Object.assign(safe, { result_store_kind: "r2", result_provider: "r2", result_object_key: parsed.reference.assetKey,
            result_blob_id: parsed.assetId, result_reference_id: parsed.reference.id });
        } else if (receipt.table === "r2_upload_requests") {
          if (!parsed || Object.keys(parsed).sort().join(",") !== "deduplicated,id,key" || typeof parsed.deduplicated !== "boolean"
            || typeof parsed.id !== "string" || !parsed.id || typeof parsed.key !== "string" || !parsed.key) throw new Error("Invalid accepted upload");
          Object.assign(safe, { result_store_kind: "r2", result_provider: "r2", result_object_key: parsed.key, result_blob_id: parsed.id });
        } else if (receipt.table === "imports") {
          if (!parsed || Object.keys(parsed).sort().join(",") !== "id,templateVersionId,version" || parsed.id !== receipt.id
            || typeof parsed.templateVersionId !== "string" || !Number.isSafeInteger(parsed.version)) throw new Error("Invalid import result");
          Object.assign(safe, { result_import_id: parsed.id, result_template_version_id: parsed.templateVersionId, result_version: parsed.version });
        }
        safe.result_valid = 1;
      } catch { safe.result_valid = 0; }
    }
    result.push(safe);
  }
  return result.sort((a, b) => compare(canonical(a), canonical(b)));
}
function classify(record: Omit<LiveConsumerRecord, "status" | "reasons" | "baselineSha256">): { status: LiveConsumerStatus; reasons: string[] } {
  const reasons: string[] = [];
  const event = record.related.eventMetadata;
  const malformedEvent = event && (event.action_type !== "string" && event.action_type !== "null"
    || record.key.fileSlot === "thumbnail" && event.thumbnail_type !== "string");
  if (!record.locator) {
    const bound = record.source.asset_id != null || record.source.storage_object_id != null || record.source.derived_asset_id != null || record.source.evidence_asset_id != null;
    if (malformedEvent) return { status: "ambiguous", reasons: ["event_locator_semantics_invalid"] };
    if (["failed", "cancelled"].includes(String(record.source.status))) return { status: "unavailable", reasons: ["consumer_unavailable_without_locator"] };
    return { status: bound ? "unavailable" : "pending_no_locator", reasons: [bound ? "registry_record_missing" : "consumer_has_no_locator"] };
  }
  const locator = record.locator;
  if (malformedEvent) reasons.push("event_locator_semantics_invalid");
  if ([record.source, ...Object.values(record.related)].some((r) => r && ["pending", "uploading", "failed", "cancelled", "draft"].includes(String(r.status)))) reasons.push("consumer_generation_unfinished");
  const requiredParents: Record<string, string[]> = { state_representation_asset: ["state"], run_step_asset: ["step", "run", "sample"],
    metrology_template_reference: ["template"], run_step_comment: ["step", "run"], state_verification: ["sample", "step"],
    comment_submission_item: ["submission"], project_content_attachment: ["content", "project"], event: ["sample"] };
  if ((requiredParents[record.key.consumerKind] ?? []).some((name) => record.related[name] == null)) reasons.push("consumer_parent_missing");
  if (!(locator.storeKind === "r2" && locator.provider === "r2" || locator.storeKind === "managed" && locator.provider === "switchdrive")) reasons.push("unsupported_legacy_provider");
  if (!locator.objectKey.trim() || locator.objectKey.includes("\0") || encoder.encode(locator.objectKey).length > 4096) reasons.push("legacy_locator_requires_explicit_resolution");
  if (record.registries.length !== 1) reasons.push(record.registries.length ? "conflicting_registry_bindings" : "registry_record_missing");
  if (record.registries.some((r) => r.status !== "ready")) reasons.push("legacy_registry_not_ready");
  if (record.lifecycle.length) reasons.push("legacy_lifecycle_blocks_verification");
  if (record.fileId) reasons.push("unexpected_existing_file_binding");
  if (record.registries.some((r) => typeof r.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(r.sha256) || !Number.isSafeInteger(r.byte_size) || Number(r.byte_size) < 0)) reasons.push("expected_byte_metadata_incomplete");
  const evidence = [...record.registries, ...record.receipts, ...record.mappings, record.source];
  const hashes = evidence.flatMap((r) => [r.sha256, r.expected_sha256, r.result_sha256]).filter((v) => v != null);
  // The import's source hash identifies its workbook only. A derivative's
  // source hash and an import manifest hash describe different byte streams.
  if (record.key.consumerKind === "import" && record.key.fileSlot === "workbook" && record.source.source_sha256 != null) hashes.push(record.source.source_sha256);
  const sizes = evidence.flatMap((r) => [r.byte_size, r.expected_byte_size, r.result_byte_size]).filter((v) => v != null);
  if (new Set(hashes).size > 1 || new Set(sizes).size > 1) reasons.push("expected_byte_metadata_conflict");
  if (record.receipts.some((r) => r.status !== "ready")) reasons.push("acceptance_unfinished");
  if (record.receipts.some((r) => r.status === "ready" && r.result_valid !== 1)) reasons.push("accepted_result_invalid");
  if (record.receipts.some((r) => r.result_object_key === locator.objectKey && (r.result_provider !== locator.provider
    || !record.registries.some((registry) => registry.id === r.result_blob_id)))) reasons.push("accepted_registry_identity_mismatch");
  if (!record.purpose) reasons.push("consumer_purpose_unresolved");
  if (record.purpose && [...record.receipts, ...record.mappings].some((r) => r.purpose != null && r.purpose !== record.purpose)) reasons.push("recorded_purpose_conflict");
  if (record.purpose === "derived_preview") reasons.push("derivation_not_assessed");
  if (record.peers.some((p) => p.purpose === null)) reasons.push("shared_locator_purpose_unresolved");
  if (new Set(record.peers.map((p) => p.purpose)).size > 1) reasons.push("independent_verified_copies_required");
  const profileIds = new Set([...record.mappings, ...record.receipts].map((r) => r.storage_profile_id));
  if (!profileIds.size || record.profiles.length !== profileIds.size) reasons.push("namespace_evidence_missing");
  if (record.profiles.some((p) => p.adapter_type !== locator.provider || p.runtime_state == null || p.runtime_state === "retired"
    || typeof p.namespace_identity !== "string" || /[?#]/.test(p.namespace_identity) || /:\/\/[^/]*@/.test(p.namespace_identity))) reasons.push("namespace_evidence_invalid");
  if (new Set(record.profiles.map((p) => p.namespace_identity)).size > 1) reasons.push("namespace_conflict");
  if (record.receipts.some((r) => !record.profiles.some((p) => p.id === r.storage_profile_id && p.configuration_revision === r.storage_profile_revision))) reasons.push("namespace_revision_mismatch");
  const unavailable = reasons.some((r) => ["registry_record_missing", "legacy_registry_not_ready", "legacy_lifecycle_blocks_verification", "acceptance_unfinished", "consumer_generation_unfinished"].includes(r));
  return { status: unavailable ? "unavailable" : reasons.length ? "ambiguous" : "ready_to_verify", reasons: [...new Set(reasons)].sort(compare) };
}

/** One bounded live metadata snapshot, NOT a conversion admission, byte proof,
 * durable hold, CAS/fence, installation snapshot or permission for provider I/O.
 * Each next-page call is a new snapshot. Only the migration-owned legacy mode is
 * supported. Historical source keys (including NUL/long text) are preserved,
 * never narrowed to new operation-identifier rules or recovered by splitting. */
export async function readFileConsumerBaseline(database: LiveConsumerDatabase, input: LiveConsumerBaselineInput = {}): Promise<LiveConsumerBaseline> {
  const limit = boundedInteger(input.limit ?? MAX_LIVE_CONSUMER_PAGE_SIZE, MAX_LIVE_CONSUMER_PAGE_SIZE, "page");
  const maxBytes = boundedInteger(input.maxBytes ?? MAX_LIVE_CONSUMER_PAGE_BYTES, MAX_LIVE_CONSUMER_PAGE_BYTES, "byte");
  const evidenceLimit = boundedInteger(input.maxEvidenceRows ?? MAX_LIVE_CONSUMER_EVIDENCE_ROWS, MAX_LIVE_CONSUMER_EVIDENCE_ROWS, "evidence");
  // Clone all inputs before awaiting database work. The page digest binds its
  // exact typed boundary; changing a cursor during a read cannot change it.
  const after = input.after === undefined ? null : JSON.parse(canonical(input.after)) as LiveConsumerKey;
  if (input.after !== undefined && (!after || typeof after !== "object" || Array.isArray(after) || Object.keys(after).sort().join(",") !== "consumerId,consumerKind,consumerSubId,fileSlot"
    || Object.values(after).some((value) => typeof value !== "string") || encoder.encode(canonical(after)).length > maxBytes)) throw new Error("Invalid live consumer cursor");
  const db = database.withSession ? database.withSession("first-primary") : database;
  const result = await db.prepare(query(evidenceLimit)).bind(after ? 1 : 0, after?.consumerKind ?? "", after?.consumerId ?? "", after?.consumerSubId ?? "", after?.fileSlot ?? "", limit + 1, limit, maxBytes).all<{
    authority_json: string; schema_json: string | null; invalid_rowid_claims: number; source_row_count: number; source_key_bytes: number; page_count: number; record_count: number; payload_bytes: number; records_json: string | null;
  }>();
  if (!result.success || !Array.isArray(result.results) || result.results.length !== 1) throw new Error("Live consumer snapshot result is incomplete");
  const envelope = { ...result.results[0] };
  if (!Number.isSafeInteger(envelope.source_row_count) || envelope.source_row_count < 0 || envelope.source_row_count > MAX_LIVE_CONSUMER_SOURCE_ROWS) throw new Error("Live consumer source row bound exceeded");
  if (!Number.isSafeInteger(envelope.source_key_bytes) || envelope.source_key_bytes < 0 || envelope.source_key_bytes > MAX_LIVE_CONSUMER_SOURCE_KEY_BYTES) throw new Error("Live consumer source key byte bound exceeded");
  if (typeof envelope.schema_json !== "string" || encoder.encode(envelope.schema_json).length > 2097152 || envelope.invalid_rowid_claims !== 0) throw new Error("Live consumer schema snapshot is incomplete");
  const schemaObjects = JSON.parse(envelope.schema_json) as ExportSchemaObject[];
  if (!Array.isArray(schemaObjects) || schemaObjects.length > 1000
    || await fileAuthoritySchemaFingerprint(schemaObjects) !== FILE_AUTHORITY_SCHEMA_FINGERPRINT_SHA256) throw new Error("Unsupported live consumer schema generation");
  if (!Number.isSafeInteger(envelope.page_count) || envelope.page_count < 0 || envelope.page_count > limit + 1
    || envelope.record_count !== Math.min(envelope.page_count, limit) || !Number.isSafeInteger(envelope.payload_bytes)) throw new Error("Live consumer snapshot count mismatch");
  if (envelope.records_json === null || envelope.payload_bytes > maxBytes) throw new Error("Live consumer snapshot byte bound exceeded");
  if (typeof envelope.authority_json !== "string" || typeof envelope.records_json !== "string"
    || encoder.encode(envelope.authority_json).length + encoder.encode(envelope.records_json).length > maxBytes) throw new Error("Live consumer snapshot byte bound exceeded");
  const authority = JSON.parse(envelope.authority_json) as Metadata[];
  if (!Array.isArray(authority) || authority.length !== 1 || authority[0].singleton !== 1 || authority[0].mode !== "legacy" || authority[0].revision !== 1 || authority[0].activated_at !== null) throw new Error("Unsupported or missing live File authority snapshot");
  const raw = JSON.parse(envelope.records_json) as Array<Omit<LiveConsumerRecord, "locator" | "status" | "reasons" | "baselineSha256"> & { r2Key: string | null; managedProvider: string | null; managedKey: string | null }>;
  if (!Array.isArray(raw) || raw.length !== envelope.record_count) throw new Error("Live consumer snapshot record mismatch");
  const records: LiveConsumerRecord[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const { r2Key, managedKey, managedProvider, ...rest } = value;
    if (!rest.key || Object.keys(rest.key).sort().join(",") !== "consumerId,consumerKind,consumerSubId,fileSlot" || Object.values(rest.key).some((v) => typeof v !== "string")) throw new Error("Live consumer source cannot be addressed by a typed cursor");
    const key = canonical(rest.key);
    if (seen.has(key)) throw new Error("Live consumer snapshot duplicate source");
    seen.add(key);
    for (const name of ["registries", "receipts", "profiles", "mappings", "lifecycle", "retention", "peers"] as const) rest[name] = normalizedArray(rest[name], evidenceLimit);
    rest.receipts = await safeReceipts(rest.receipts);
    if (rest.related.eventMetadata) {
      const rawEvent = rest.related.eventMetadata;
      rest.related.eventMetadata = { semantics_sha256: await sha256Hex(canonical(rawEvent)),
        action_type: rawEvent.action === null ? "null" : typeof rawEvent.action,
        action: typeof rawEvent.action === "string" ? rawEvent.action : null,
        thumbnail_type: rawEvent.thumbnailKey === null ? "null" : typeof rawEvent.thumbnailKey,
        thumbnailKey: typeof rawEvent.thumbnailKey === "string" ? rawEvent.thumbnailKey : null, valid: rawEvent.valid };
    }
    const locator = r2Key !== null ? { storeKind: "r2", provider: "r2", objectKey: r2Key }
      : managedKey !== null && managedProvider !== null ? { storeKind: "managed", provider: managedProvider, objectKey: managedKey } : null;
    const record = { ...rest, locator };
    const classification = classify(record);
    if (r2Key !== null && managedKey !== null) { classification.reasons.push("conflicting_registry_bindings"); if (classification.status !== "unavailable") classification.status = "ambiguous"; }
    const detached = JSON.parse(canonical({ ...record, ...classification })) as Omit<LiveConsumerRecord, "baselineSha256">;
    records.push({ ...detached, baselineSha256: await sha256Hex(canonical({ version: 1, schemaSha256: FILE_AUTHORITY_SCHEMA_FINGERPRINT_SHA256, authority: authority[0], record: detached })) });
  }
  const nextCursor = envelope.page_count > limit ? records[records.length - 1].key : null;
  const page = { version: 1 as const, kind: "file-consumer-live-baseline" as const, executable: false as const, bytesVerified: false as const,
    authority: authority[0], schemaSha256: FILE_AUTHORITY_SCHEMA_FINGERPRINT_SHA256, records, nextCursor };
  const baselineSha256 = await sha256Hex(canonical({ ...page, boundary: { after, limit, maxEvidenceRows: evidenceLimit } }));
  const output = { ...page, baselineSha256 };
  if (encoder.encode(canonical(output)).length > maxBytes) throw new Error("Live consumer baseline output byte bound exceeded");
  return output;
}

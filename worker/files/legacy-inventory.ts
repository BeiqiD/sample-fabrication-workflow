import { sha256Hex } from "../../shared/content-addressing";
import type {
  FilePurpose, LegacyFileClassification, LegacyFileLocator,
  LegacyFileObservationReport, LegacyStorageProfile,
} from "../../shared/contracts/files";

/** Structural SQL capability: D1 can implement it directly, host SQLite via an
 * adapter. batch MUST execute atomically, with rollback on any failed statement.
 * There is intentionally no storage, Env, HTTP, scheduler or settings capability.
 */
export interface InventoryStatement {
  bind(...values: unknown[]): InventoryStatement;
  all<T>(): Promise<{ results: T[]; success: boolean }>;
}
export interface InventoryDatabase {
  prepare(sql: string): InventoryStatement;
  batch(statements: InventoryStatement[]): Promise<Array<{ success: boolean }>>;
}

export const MAX_INVENTORY_PAGE_SIZE = 20;
export const MAX_INVENTORY_EVIDENCE_ROWS = 100;
export const MAX_INVENTORY_EVIDENCE_BYTES = 64 * 1024;

type EvidenceValue = string | number | null;
export type LegacyEvidence = Record<string, EvidenceValue>;
export interface LegacyInventoryObservation extends LegacyFileLocator {
  records: LegacyEvidence[];
  consumers: LegacyEvidence[];
  lifecycle: LegacyEvidence[];
}
export interface LegacyInventorySnapshot {
  observedAt: string;
  observations: LegacyInventoryObservation[];
}
export interface LegacyInventoryPage extends LegacyInventorySnapshot {
  nextCursor: LegacyFileLocator | null;
}
export interface LegacyInventoryPlan {
  profiles: LegacyStorageProfile[];
  observedAt: string;
  entries: Array<LegacyFileObservationReport & {
    profileId: string;
    expectedByteSize: number | null;
    expectedSha256: string | null;
    evidenceJson: string;
  }>;
}

function boundedText(value: unknown, max: number, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || [...value].length > max) {
    throw new Error(`Invalid ${label}`);
  }
}
function validateLocator(locator: LegacyFileLocator) {
  if (!((locator.storeKind === "r2" && locator.provider === "r2")
    || (locator.storeKind === "managed" && locator.provider === "switchdrive"))) {
    throw new Error("Unsupported legacy storage provider; explicit resolution required");
  }
  boundedText(locator.objectKey, 4096, "legacy object key");
}
function validateTime(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error("Inventory requires an explicit ISO observation timestamp");
  }
}
function validateProfile(profile: LegacyStorageProfile) {
  boundedText(profile.id, 256, "profile identity");
  boundedText(profile.namespaceIdentity, 2048, "physical namespace identity");
  // The namespace is a non-secret identity, never a credential-bearing URL.
  if (/[?#]/.test(profile.namespaceIdentity) || /:\/\/[^/]*@/.test(profile.namespaceIdentity)) {
    throw new Error("Physical namespace identities cannot contain URL credentials, queries or fragments");
  }
  if (profile.configurationRevision !== 1 || !(
    (profile.adapterType === "r2" && profile.configurationSource === "bootstrap" && profile.credentialReference === null)
    || (profile.adapterType === "switchdrive" && profile.configurationSource === "environment"
      && profile.credentialReference === "environment:SWITCHDRIVE")
  )) throw new Error("Invalid frozen legacy profile");
}

// Enumerate registered, direct-only, orphaned, deleted and quarantined locators.
// LIMIT bounds each returned evidence list; overflow fails visibly, never classifies
// a truncated list. One SQL statement observes one coherent page. Pages do not
// constitute an installation-wide snapshot or a hold against legacy GC.
const LOCATORS_SQL = `
  SELECT 'r2' store_kind, 'r2' provider, r2_key object_key FROM assets
  UNION SELECT 'managed', provider, object_key FROM managed_storage_objects
  UNION SELECT store_kind, provider, object_key FROM blob_retention_edges
  UNION SELECT store_kind, provider, object_key FROM blob_gc_ledger
  UNION SELECT store_kind, provider, object_key FROM blob_integrity_quarantine`;

const CONSUMERS_SQL = `
  SELECT bre.store_kind, bre.provider, bre.object_key,
    bre.source_type, bre.source_id, bre.occurrence_type, bre.occurrence_id,
    CASE
      WHEN bre.occurrence_type IN ('import_workbook', 'import_manifest', 'template_source') THEN 'provenance'
      WHEN bre.occurrence_type IN ('event_thumbnail', 'attachment_derivative') THEN 'derived_preview'
      WHEN bre.occurrence_type = 'comment_submission_item' AND csi.kind = 'attachment' THEN 'research_source'
      WHEN bre.occurrence_type = 'comment_submission_item' AND csi.kind = 'comment_image'
        AND related.kind = 'attachment' AND related.related_item_id = csi.id THEN 'derived_preview'
      WHEN bre.occurrence_type = 'comment_submission_item' AND csi.kind = 'comment_image'
        AND csi.related_item_id IS NULL THEN 'embedded_content'
      ELSE NULL
    END purpose
  FROM blob_retention_edges bre
  LEFT JOIN comment_submission_items csi ON bre.occurrence_type = 'comment_submission_item' AND csi.id = bre.occurrence_id
  LEFT JOIN comment_submission_items related ON related.id = csi.related_item_id AND related.submission_id = csi.submission_id
  UNION
  SELECT 'r2', 'r2', a.r2_key, 'attachment_derivative', ad.id, 'attachment_derivative', ad.id, 'derived_preview'
  FROM attachment_derivatives ad JOIN assets a ON a.id = ad.derived_asset_id
  UNION
  SELECT 'r2', 'r2', a.r2_key, 'run_step', rsa.run_step_id, 'run_step_asset', rsa.id, NULL
  FROM run_step_assets rsa JOIN assets a ON a.id = rsa.asset_id
  UNION
  SELECT 'r2', 'r2', a.r2_key, 'template_version', mtr.template_version_id, 'metrology_template_reference', mtr.id, NULL
  FROM metrology_template_references mtr JOIN assets a ON a.id = mtr.asset_id
  UNION
  SELECT loc.store_kind, loc.provider, loc.object_key, 'comment_submission', csi.submission_id,
    'comment_submission_item', csi.id,
    CASE WHEN csi.kind = 'attachment' THEN 'research_source'
      WHEN csi.kind = 'comment_image' AND related.kind = 'attachment' AND related.related_item_id = csi.id THEN 'derived_preview'
      WHEN csi.kind = 'comment_image' AND csi.related_item_id IS NULL THEN 'embedded_content'
      ELSE NULL END
  FROM comment_submission_items csi
  JOIN (
    SELECT 'r2' store_kind, 'r2' provider, r2_key object_key, id record_id FROM assets
    UNION ALL SELECT 'managed', provider, object_key, id FROM managed_storage_objects
  ) loc ON (loc.store_kind = 'r2' AND loc.record_id = csi.asset_id)
    OR (loc.store_kind = 'managed' AND loc.record_id = csi.storage_object_id)
  LEFT JOIN comment_submission_items related ON related.id = csi.related_item_id AND related.submission_id = csi.submission_id`;

export async function readLegacyInventoryPage(
  database: InventoryDatabase,
  input: { observedAt: string; limit?: number; after?: LegacyFileLocator },
): Promise<LegacyInventoryPage> {
  validateTime(input.observedAt);
  const limit = input.limit ?? MAX_INVENTORY_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_INVENTORY_PAGE_SIZE) throw new Error("Invalid inventory page size");
  if (input.after) validateLocator(input.after);
  const query = `WITH locators AS (${LOCATORS_SQL}), consumers AS (${CONSUMERS_SQL}),
    page AS (SELECT * FROM locators
      WHERE (store_kind, provider, object_key) > (?, ?, ?)
      ORDER BY store_kind, provider, object_key LIMIT ?)
    SELECT p.*,
      (SELECT json_group_array(json_object('table', source_table, 'id', id, 'byte_size', byte_size,
        'sha256', sha256, 'status', status, 'import_id', import_id)) FROM (
        SELECT 'assets' source_table, a.id, a.byte_size, a.sha256, a.status, a.import_id
          FROM assets a WHERE p.store_kind = 'r2' AND p.provider = 'r2' AND a.r2_key = p.object_key
        UNION ALL
        SELECT 'managed_storage_objects', m.id, m.byte_size, m.sha256, m.status, NULL
          FROM managed_storage_objects m WHERE p.store_kind = 'managed' AND m.provider = p.provider AND m.object_key = p.object_key
      )) records_json,
      (SELECT json_group_array(json_object('source_type', source_type, 'source_id', source_id,
        'occurrence_type', occurrence_type, 'occurrence_id', occurrence_id, 'purpose', purpose)) FROM (
        SELECT c.* FROM consumers c WHERE c.store_kind = p.store_kind AND c.provider = p.provider AND c.object_key = p.object_key
        ORDER BY source_type, source_id, occurrence_type, occurrence_id, purpose LIMIT ${MAX_INVENTORY_EVIDENCE_ROWS + 1}
      )) consumers_json,
      (SELECT json_group_array(json_object('table', source_table, 'state', state, 'reason', reason,
        'expected_byte_size', expected_byte_size, 'observed_byte_size', observed_byte_size)) FROM (
        SELECT 'blob_gc_ledger' source_table, g.state, NULL reason, NULL expected_byte_size, NULL observed_byte_size
          FROM blob_gc_ledger g WHERE g.store_kind = p.store_kind AND g.provider = p.provider AND g.object_key = p.object_key
        UNION ALL
        SELECT 'blob_integrity_quarantine', NULL, q.reason, q.expected_byte_size, q.observed_byte_size
          FROM blob_integrity_quarantine q WHERE q.store_kind = p.store_kind AND q.provider = p.provider AND q.object_key = p.object_key
      )) lifecycle_json FROM page p ORDER BY store_kind, provider, object_key`;
  const result = await database.prepare(query).bind(
    input.after?.storeKind ?? "", input.after?.provider ?? "", input.after?.objectKey ?? "", limit + 1,
  ).all<{ store_kind: LegacyFileLocator["storeKind"]; provider: LegacyFileLocator["provider"]; object_key: string;
    records_json: string; consumers_json: string; lifecycle_json: string }>();
  if (!result.success) throw new Error("Legacy inventory snapshot failed");
  const observations = result.results.slice(0, limit).map((row): LegacyInventoryObservation => ({
    storeKind: row.store_kind, provider: row.provider, objectKey: row.object_key,
    records: JSON.parse(row.records_json), consumers: JSON.parse(row.consumers_json), lifecycle: JSON.parse(row.lifecycle_json),
  }));
  for (const observation of observations) validateObservation(observation);
  const last = observations.at(-1);
  return {
    observedAt: input.observedAt, observations,
    nextCursor: result.results.length > limit && last
      ? { storeKind: last.storeKind, provider: last.provider, objectKey: last.objectKey } : null,
  };
}

function validateObservation(observation: LegacyInventoryObservation) {
  validateLocator(observation);
  const allowlists = [
    new Set(["table", "id", "byte_size", "sha256", "status", "import_id"]),
    new Set(["source_type", "source_id", "occurrence_type", "occurrence_id", "purpose"]),
    new Set(["table", "state", "reason", "expected_byte_size", "observed_byte_size"]),
  ];
  for (const [index, rows] of [observation.records, observation.consumers, observation.lifecycle].entries()) {
    if (!Array.isArray(rows) || rows.length > MAX_INVENTORY_EVIDENCE_ROWS) {
      throw new Error("Legacy evidence exceeds the bounded inventory limit; explicit resolution required");
    }
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)
        || Object.keys(row).some((key) => !allowlists[index].has(key))
        || Object.values(row).some((v) => (v !== null && typeof v !== "string" && typeof v !== "number")
          || (typeof v === "number" && !Number.isFinite(v)))) {
        throw new Error("Invalid legacy evidence row");
      }
    }
  }
  if (new TextEncoder().encode(JSON.stringify(observation)).byteLength > MAX_INVENTORY_EVIDENCE_BYTES) {
    throw new Error("Legacy evidence exceeds the bounded inventory size");
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (value !== null && typeof value === "object") return "{" + Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",") + "}";
  return JSON.stringify(value);
}

const PURPOSES = new Set<FilePurpose>(["research_source", "embedded_content", "derived_preview", "provenance", "job_output"]);

/** This plan uses frozen SQL metadata only. Expected hashes are historical claims,
 * including claims on 'ready' rows; no existence, integrity or health is inferred.
 * Retain this exact snapshot/plan to retry. Changed evidence requires review.
 */
export async function planLegacyInventory(
  snapshot: LegacyInventorySnapshot,
  profiles: LegacyStorageProfile[],
): Promise<LegacyInventoryPlan> {
  validateTime(snapshot.observedAt);
  if (snapshot.observations.length > MAX_INVENTORY_PAGE_SIZE) throw new Error("Inventory batch is too large");
  if (profiles.length < 1 || profiles.length > 2) throw new Error("Supply the exact frozen profiles for this inventory");
  profiles.forEach(validateProfile);
  if (new Set(profiles.map((p) => p.id)).size !== profiles.length
    || new Set(profiles.map((p) => p.adapterType)).size !== profiles.length) {
    throw new Error("Only one frozen profile per legacy kind is supported");
  }
  const seen = new Set<string>();
  const entries = await Promise.all(snapshot.observations.map(async (observation) => {
    validateObservation(observation);
    const identity = JSON.stringify([observation.storeKind, observation.provider, observation.objectKey]);
    if (seen.has(identity)) throw new Error("Duplicate legacy locator in inventory batch");
    seen.add(identity);
    const profile = profiles.find((p) => p.adapterType === observation.provider);
    if (!profile) throw new Error("Physical namespace identity must be supplied for every legacy locator");
    const purposes = new Set(observation.consumers.map((c) => c.purpose)
      .filter((p): p is FilePurpose => PURPOSES.has(p as FilePurpose)));
    const unknown = observation.consumers.some((c) => !PURPOSES.has(c.purpose as FilePurpose));
    const classification: LegacyFileClassification = purposes.size > 1 || (purposes.size > 0 && unknown)
      ? "ambiguous" : purposes.size === 1 ? "classified" : "unclassified";
    const purpose = classification === "classified" ? [...purposes][0] : null;
    const issues: string[] = classification === "classified" ? [] : [`purpose_${classification}`];
    const sizes = [...new Set([...observation.records.map((r) => r.byte_size),
      ...observation.lifecycle.filter((r) => r.table === "blob_integrity_quarantine").map((r) => r.expected_byte_size)]
      .filter((v) => v !== null))];
    const hashes = [...new Set(observation.records.map((r) => r.sha256).filter((v) => v !== null))];
    const expectedByteSize = sizes.length === 1 && typeof sizes[0] === "number"
      && Number.isSafeInteger(sizes[0]) && sizes[0] >= 0 ? sizes[0] : null;
    const expectedSha256 = hashes.length === 1 && typeof hashes[0] === "string"
      && /^[0-9a-f]{64}$/.test(hashes[0]) ? hashes[0] : null;
    if (sizes.length && expectedByteSize === null) issues.push("invalid_or_conflicting_expected_size");
    if (hashes.length && expectedSha256 === null) issues.push("invalid_or_conflicting_expected_hash");
    if (!observation.records.length) issues.push("direct_locator_without_registry_record");
    if (observation.records.some((r) => r.status !== "ready")) issues.push("legacy_record_not_ready");
    if (observation.lifecycle.length) issues.push("legacy_gc_or_quarantine_evidence");
    const digest = await sha256Hex(new TextEncoder().encode(identity).buffer);
    return {
      storeKind: observation.storeKind, provider: observation.provider, objectKey: observation.objectKey,
      fileId: `legacy-file-${digest}`, locationId: `legacy-location-${digest}`, profileId: profile.id,
      classification, purpose, issues, expectedByteSize, expectedSha256,
      evidenceJson: canonical({ version: 1, records: observation.records, consumers: observation.consumers,
        lifecycle: observation.lifecycle, issues, verification: "not_performed" }),
    };
  }));
  // Explicit whitelist prevents excess caller properties (e.g. secret config) from
  // being propagated into a plan or the SQL observation registry.
  return { observedAt: snapshot.observedAt, profiles: profiles.map((p) => ({
    id: p.id, adapterType: p.adapterType, namespaceIdentity: p.namespaceIdentity,
    configurationSource: p.configurationSource, credentialReference: p.credentialReference,
    configurationRevision: p.configurationRevision,
  })), entries };
}

/** Register a frozen metadata page atomically. Idempotence is exact: existing
 * metadata and namespace must match. The deliberate invalid-row guard aborts
 * the transaction on stale/conflicting retries without UPDATE or IGNORE hiding it.
 */
export async function registerLegacyInventory(
  database: InventoryDatabase,
  snapshot: LegacyInventorySnapshot,
  profiles: LegacyStorageProfile[],
): Promise<LegacyInventoryPlan> {
  const plan = await planLegacyInventory(snapshot, profiles);
  const statements: InventoryStatement[] = [];
  const guard = (condition: string, values: unknown[]) => statements.push(database.prepare(`
    INSERT INTO files (id, access_scope, state, created_at)
    SELECT NULL, 'system', 'unresolved', ? WHERE ${condition}
  `).bind(plan.observedAt, ...values));
  for (const profile of plan.profiles) {
    guard(`EXISTS (SELECT 1 FROM storage_profiles WHERE adapter_type = ? AND
      (id IS NOT ? OR namespace_identity IS NOT ? OR configuration_source IS NOT ?
        OR credential_reference IS NOT ? OR configuration_revision IS NOT ? OR state IS NOT 'historical'))`,
    [profile.adapterType, profile.id, profile.namespaceIdentity, profile.configurationSource,
      profile.credentialReference, profile.configurationRevision]);
    statements.push(database.prepare(`INSERT INTO storage_profiles
      (id, adapter_type, namespace_identity, configuration_source, credential_reference,
        configuration_revision, state, created_at) SELECT ?, ?, ?, ?, ?, 1, 'historical', ?
      WHERE NOT EXISTS (SELECT 1 FROM storage_profiles WHERE id = ?)`)
      .bind(profile.id, profile.adapterType, profile.namespaceIdentity,
        profile.configurationSource, profile.credentialReference, plan.observedAt, profile.id));
    guard(`NOT EXISTS (SELECT 1 FROM storage_profiles WHERE id = ? AND adapter_type = ?
      AND namespace_identity = ? AND configuration_source = ? AND credential_reference IS ?
      AND configuration_revision = 1 AND state = 'historical')`,
    [profile.id, profile.adapterType, profile.namespaceIdentity, profile.configurationSource, profile.credentialReference]);
  }
  for (const entry of plan.entries) {
    statements.push(database.prepare(`INSERT INTO files
      (id, purpose, access_scope, expected_byte_size, expected_sha256, verified_sha256, state, active_location_id, created_at)
      VALUES (?, ?, 'system', ?, ?, NULL, 'unresolved', NULL, ?) ON CONFLICT(id) DO NOTHING`)
      .bind(entry.fileId, entry.purpose, entry.expectedByteSize, entry.expectedSha256, plan.observedAt));
    statements.push(database.prepare(`INSERT INTO file_locations
      (id, file_id, storage_profile_id, object_key, state, created_at)
      VALUES (?, ?, ?, ?, 'unresolved', ?) ON CONFLICT(id) DO NOTHING`)
      .bind(entry.locationId, entry.fileId, entry.profileId, entry.objectKey, plan.observedAt));
    statements.push(database.prepare(`INSERT INTO legacy_file_mappings
      (store_kind, provider, object_key, file_id, location_id, classification, evidence_json, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(store_kind, provider, object_key) DO NOTHING`)
      .bind(entry.storeKind, entry.provider, entry.objectKey, entry.fileId, entry.locationId,
        entry.classification, entry.evidenceJson, plan.observedAt));
    guard(`NOT EXISTS (SELECT 1 FROM legacy_file_mappings m
      JOIN files f ON f.id = m.file_id JOIN file_locations l ON l.id = m.location_id
      WHERE m.store_kind = ? AND m.provider = ? AND m.object_key = ?
        AND m.file_id = ? AND m.location_id = ? AND m.classification = ? AND m.evidence_json = ? AND m.observed_at = ?
        AND f.purpose IS ? AND f.expected_byte_size IS ? AND f.expected_sha256 IS ?
        AND f.verified_sha256 IS NULL AND f.active_location_id IS NULL AND f.state = 'unresolved'
        AND f.access_scope = 'system' AND f.created_at = ?
        AND l.file_id = f.id AND l.storage_profile_id = ? AND l.object_key = m.object_key
        AND l.state = 'unresolved' AND l.created_at = ?)`,
    [entry.storeKind, entry.provider, entry.objectKey, entry.fileId, entry.locationId,
      entry.classification, entry.evidenceJson, plan.observedAt, entry.purpose,
      entry.expectedByteSize, entry.expectedSha256, plan.observedAt, entry.profileId, plan.observedAt]);
  }
  const results = await database.batch(statements);
  if (results.length !== statements.length || results.some((result) => result.success !== true)) {
    throw new Error("Legacy inventory atomic batch did not acknowledge every statement");
  }
  return plan;
}

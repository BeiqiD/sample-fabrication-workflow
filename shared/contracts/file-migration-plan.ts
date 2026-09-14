import type { ExportRow, FullExportManifestV10, FullExportManifestV11, FullExportManifestV12 } from "./export";
import type { FilePurpose } from "./files";
import type { FileConsumerObservation, FileConsumerProjection, FileConsumerRegistryObservation } from "./file-consumers";
import { projectFileConsumers } from "./file-consumer-projection";
import { validateMetrologyReferenceUploadResult } from "./metrology-reference-upload";
import { sha256Hex } from "../domain/content-addressing";

export const MAX_FILE_MIGRATION_INPUT_ROWS = 20_000;
export const MAX_FILE_MIGRATION_INPUT_BYTES = 16 * 1024 * 1024;
export const MAX_FILE_MIGRATION_PLAN_BYTES = 8 * 1024 * 1024;

export type FileMigrationSnapshot = FullExportManifestV10 | FullExportManifestV11 | FullExportManifestV12;

export interface FileMigrationLocator {
  storeKind: "r2" | "managed";
  provider: string;
  objectKey: string;
}

export interface FileMigrationNamespaceEvidence {
  kind: "legacy_mapping" | "accepted_import" | "accepted_upload" | "accepted_metrology_reference";
  sourceId: string;
  profileId: string;
  configurationRevision: number;
  namespaceIdentity: string;
}

export interface FileMigrationGroup {
  locator: FileMigrationLocator;
  namespace: {
    status: "resolved" | "unresolved" | "conflicting";
    identity: string | null;
    evidence: FileMigrationNamespaceEvidence[];
  };
  registries: FileConsumerRegistryObservation[];
  lifecycle: Array<{
    table: "blob_gc_ledger" | "blob_integrity_quarantine";
    blobRecordId: string | null;
    state: string | null;
    reason: string | null;
    operationId: string | null;
    expectedByteSize: number | null;
    observedByteSize: number | null;
  }>;
  archiveObservations: Array<{
    locatorId: string;
    initialOutcome: string | null;
    expectedByteSize: number | null;
    expectedSha256: string | null;
  }>;
  legacyMappings: Array<{
    fileId: string;
    locationId: string;
    classification: string;
    purpose: string | null;
    observedAt: string;
    expectedByteSize: number | null;
    expectedSha256: string | null;
    evidenceSha256: string;
    purposeComparison: "consistent" | "different" | "not_comparable";
  }>;
  consumers: FileConsumerObservation[];
  expectedByteSize: number | null;
  expectedSha256: string | null;
  proposals: Array<{
    purpose: FilePurpose;
    accessScope: "system";
    proposedFileId: string | null;
    consumerIds: string[];
    requiresIndependentVerifiedCopy: boolean;
  }>;
  blockers: string[];
}

export interface FileMigrationPlan {
  version: 1;
  kind: "file-migration-observation";
  executable: false;
  bytesVerified: false;
  source: {
    basis: "archive-snapshot";
    schemaVersion: 10 | 11 | 12;
    archiveProfile: "fp1-import-acceptance" | "fp1-r2-upload-acceptance" | "fp1-metrology-reference-acceptance";
    exportedAt: string;
    inputSha256: string;
  };
  coverage: FileConsumerProjection["coverage"];
  groups: FileMigrationGroup[];
  unresolvedConsumers: FileConsumerObservation[];
  summary: {
    groups: number;
    consumers: number;
    proposals: number;
    multiPurposeGroups: number;
    namespaceUnresolvedGroups: number;
    blockedGroups: number;
  };
}

function compare(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
function text(value: unknown): string | null { return typeof value === "string" ? value : null; }
function number(value: unknown): number | null { return typeof value === "number" ? value : null; }
function locatorKey(locator: FileMigrationLocator) {
  return JSON.stringify([locator.storeKind, locator.provider, locator.objectKey]);
}

// Bound traversal before constructing the final canonical string. The caller's
// archive loader also bounds its file before JSON parsing. Arrays retain order;
// relational table rows and schema objects are normalized explicitly below.
function canonical(value: unknown, maximum: number): string {
  const chunks: string[] = [];
  let bytes = 0;
  const encoder = new TextEncoder();
  const append = (chunk: string) => {
    bytes += encoder.encode(chunk).byteLength;
    if (bytes > maximum) throw new Error("File migration observation exceeds its byte limit");
    chunks.push(chunk);
  };
  const visit = (entry: unknown, depth: number) => {
    if (depth > 64) throw new Error("File migration observation is too deeply nested");
    if (entry === null || typeof entry === "string" || typeof entry === "boolean"
      || typeof entry === "number" && Number.isFinite(entry)) { append(JSON.stringify(entry)); return; }
    if (Array.isArray(entry)) {
      append("[");
      entry.forEach((item, index) => { if (index) append(","); visit(item, depth + 1); });
      append("]");
      return;
    }
    if (entry && typeof entry === "object") {
      append("{");
      Object.keys(entry).sort(compare).forEach((key, index) => {
        if (index) append(",");
        append(JSON.stringify(key)); append(":");
        visit((entry as Record<string, unknown>)[key], depth + 1);
      });
      append("}");
      return;
    }
    throw new Error("File migration observation requires JSON values");
  };
  visit(value, 0);
  return chunks.join("");
}

function sorted<T>(values: T[]): T[] {
  return values.map((value) => ({ value, key: canonical(value, MAX_FILE_MIGRATION_INPUT_BYTES) }))
    .sort((a, b) => compare(a.key, b.key)).map(({ value }) => value);
}

function inputSnapshot(manifest: FileMigrationSnapshot) {
  if (manifest.archiveWriter !== 1
    || !(manifest.schemaVersion === 10 && manifest.archiveProfile === "fp1-import-acceptance"
      || manifest.schemaVersion === 11 && manifest.archiveProfile === "fp1-r2-upload-acceptance"
      || manifest.schemaVersion === 12 && manifest.archiveProfile === "fp1-metrology-reference-acceptance")) {
    throw new Error("File migration observation requires a validated schema 10, 11 or 12 archive");
  }
  let rowCount = 0;
  for (const rows of Object.values(manifest.tables)) {
    if (!Array.isArray(rows)) throw new Error("File migration observation requires archive table rows");
    rowCount += rows.length;
    if (rowCount > MAX_FILE_MIGRATION_INPUT_ROWS) throw new Error("File migration observation exceeds its row limit");
  }
  // This first pass bounds all fields, including source schema, bodies, error
  // payloads and unrelated tables, before allocating sorted row copies.
  canonical(manifest, MAX_FILE_MIGRATION_INPUT_BYTES);
  return {
    ...manifest,
    tables: Object.fromEntries(Object.entries(manifest.tables).map(([name, rows]) => [name, sorted(rows)])),
    blobs: sorted(manifest.blobs),
    artifacts: {
      ...manifest.artifacts,
      sourceSchema: {
        ...manifest.artifacts.sourceSchema,
        value: { ...manifest.artifacts.sourceSchema.value, objects: sorted(manifest.artifacts.sourceSchema.value.objects) },
      },
    },
  };
}

/** Accept only an archive already validated by the schema-10, schema-11 or schema-12 reader.
 * This module has no database/provider/settings capability and cannot execute a
 * migration. Expected metadata is historical evidence, never byte verification.
 */
export async function planFileMigration(manifest: FileMigrationSnapshot): Promise<FileMigrationPlan> {
  const snapshotJson = canonical(inputSnapshot(manifest), MAX_FILE_MIGRATION_INPUT_BYTES);
  // Detach before the first await. Caller mutations while hashing must not
  // produce a plan from rows different from those bound by inputSha256.
  const snapshot = JSON.parse(snapshotJson) as FileMigrationSnapshot;
  const inputSha256 = await sha256Hex(snapshotJson);
  const tables = snapshot.tables;
  const projection = projectFileConsumers(tables);
  const groups = new Map<string, FileMigrationGroup>();
  const ensure = (locator: FileMigrationLocator) => {
    const key = locatorKey(locator);
    let group = groups.get(key);
    if (!group) {
      group = {
        locator: { storeKind: locator.storeKind, provider: locator.provider, objectKey: locator.objectKey },
        namespace: { status: "unresolved", identity: null, evidence: [] },
        registries: [], lifecycle: [], archiveObservations: [], legacyMappings: [], consumers: [],
        expectedByteSize: null, expectedSha256: null, proposals: [], blockers: ["bytes_unverified"],
      };
      groups.set(key, group);
    }
    return group;
  };
  const legacyLocator = (row: ExportRow): FileMigrationLocator => ({
    storeKind: row.store_kind as "r2" | "managed", provider: String(row.provider), objectKey: String(row.object_key),
  });
  const profiles = new Map(tables.storage_profiles.map((row) => [String(row.id), row]));
  const imports = new Map(tables.imports.map((row) => [String(row.id), row]));
  const locations = new Map(tables.file_locations.map((row) => [String(row.id), row]));
  const files = new Map(tables.files.map((row) => [String(row.id), row]));
  const addNamespace = (group: FileMigrationGroup, kind: FileMigrationNamespaceEvidence["kind"],
    sourceId: string, profileId: string, revision: number) => {
    const profile = profiles.get(profileId);
    if (!profile || profile.adapter_type !== group.locator.provider
      || profile.configuration_revision !== revision || typeof profile.namespace_identity !== "string"
      || /[?#]/.test(profile.namespace_identity) || /:\/\/[^/]*@/.test(profile.namespace_identity)) {
      group.blockers.push("namespace_evidence_invalid");
      return;
    }
    group.namespace.evidence.push({ kind, sourceId, profileId, configurationRevision: revision,
      namespaceIdentity: profile.namespace_identity });
  };
  const acceptedNamespace = (group: FileMigrationGroup, row: ExportRow | undefined) => {
    if (row?.client_request_id && typeof row.storage_profile_id === "string"
      && typeof row.storage_profile_revision === "number") {
      addNamespace(group, "accepted_import", String(row.id), row.storage_profile_id, row.storage_profile_revision);
      if (row.status !== "ready") group.blockers.push("accepted_import_unfinished");
    }
  };

  for (const [table, rows] of [["assets", tables.assets], ["managed_storage_objects", tables.managed_storage_objects]] as const) {
    for (const row of rows) {
      const group = ensure(table === "assets"
        ? { storeKind: "r2", provider: "r2", objectKey: String(row.r2_key) }
        : { storeKind: "managed", provider: String(row.provider), objectKey: String(row.object_key) });
      group.registries.push({ table, id: String(row.id), status: text(row.status),
        expectedSha256: text(row.sha256), expectedByteSize: number(row.byte_size), importId: text(row.import_id) });
      if (table === "assets" && typeof row.import_id === "string") acceptedNamespace(group, imports.get(row.import_id));
    }
  }
  for (const consumer of projection.consumers) if (consumer.locator) ensure(consumer.locator).consumers.push(consumer);
  // A coverage failure can name a retained locator absent from every canonical
  // consumer. It still belongs in the plan; it must not disappear with the join.
  for (const issue of [...projection.coverage.unmatchedEdges, ...projection.coverage.ambiguousEdges]) {
    ensure(issue.edge.locator).blockers.push("retention_coverage_mismatch");
  }
  for (const [table, rows] of [["blob_gc_ledger", tables.blob_gc_ledger],
    ["blob_integrity_quarantine", tables.blob_integrity_quarantine]] as const) {
    for (const row of rows) ensure(legacyLocator(row)).lifecycle.push({ table,
      blobRecordId: text(row.blob_record_id), state: text(row.state), reason: text(row.reason),
      operationId: text(row.operation_id), expectedByteSize: number(row.expected_byte_size), observedByteSize: number(row.observed_byte_size) });
  }
  for (const blob of snapshot.blobs) ensure(blob).archiveObservations.push({
    locatorId: blob.locatorId, initialOutcome: blob.initialOutcome,
    expectedByteSize: blob.expectedByteSize, expectedSha256: blob.expectedSha256,
  });
  for (const row of tables.imports) {
    for (const column of ["workbook_asset_key", "manifest_asset_key"]) {
      if (typeof row[column] === "string" && row[column]) {
        acceptedNamespace(ensure({ storeKind: "r2", provider: "r2", objectKey: row[column] as string }), row);
      }
    }
  }
  // Acceptance freezes a destination independently of current settings. A
  // deduplicated result can use another key, so observe only that explicit
  // result in addition to the reserved candidate. Neither receipt is a typed
  // consumer or a new retention root, and equal hashes establish no ownership.
  if (snapshot.schemaVersion >= 11) {
    for (const row of tables.r2_upload_requests) {
      const candidate = ensure({ storeKind: "r2", provider: "r2", objectKey: String(row.candidate_object_key) });
      const observe = (group: FileMigrationGroup) => {
        if (typeof row.storage_profile_id !== "string" || typeof row.storage_profile_revision !== "number") {
          group.blockers.push("namespace_evidence_invalid");
        } else {
          addNamespace(group, "accepted_upload", String(row.id), row.storage_profile_id, row.storage_profile_revision);
        }
        if (row.status !== "ready") group.blockers.push("accepted_upload_unfinished");
      };
      observe(candidate);
      if (row.status === "ready") {
        let result: unknown;
        try { result = JSON.parse(String(row.accepted_result_json)); }
        catch { /* Keep invalid ready evidence visible on its candidate. */ }
        if (!result || typeof result !== "object" || Array.isArray(result)
          || Object.keys(result).sort(compare).join(",") !== "deduplicated,id,key"
          || typeof (result as Record<string, unknown>).id !== "string" || !(result as { id: string }).id
          || typeof (result as Record<string, unknown>).key !== "string" || !(result as { key: string }).key
          || typeof (result as Record<string, unknown>).deduplicated !== "boolean") {
          candidate.blockers.push("accepted_upload_result_invalid");
        } else {
          observe(ensure({ storeKind: "r2", provider: "r2", objectKey: (result as { key: string }).key }));
        }
      }
    }
  }
  if (snapshot.schemaVersion === 12) {
    for (const row of tables.metrology_reference_upload_requests) {
      const candidate = ensure({ storeKind: "r2", provider: "r2", objectKey: String(row.candidate_object_key) });
      const observe = (group: FileMigrationGroup) => {
        if (typeof row.storage_profile_id !== "string" || typeof row.storage_profile_revision !== "number") {
          group.blockers.push("namespace_evidence_invalid");
        } else {
          addNamespace(group, "accepted_metrology_reference", String(row.id), row.storage_profile_id, row.storage_profile_revision);
        }
        if (row.status !== "ready") group.blockers.push("accepted_metrology_reference_unfinished");
      };
      observe(candidate);
      if (row.status === "ready") {
        try {
          const result = JSON.parse(String(row.accepted_result_json));
          validateMetrologyReferenceUploadResult(result);
          observe(ensure({ storeKind: "r2", provider: "r2", objectKey: result.reference.assetKey }));
        } catch { candidate.blockers.push("accepted_metrology_reference_result_invalid"); }
      }
    }
  }
  for (const row of tables.legacy_file_mappings) {
    const group = ensure(legacyLocator(row));
    const location = locations.get(String(row.location_id));
    const file = files.get(String(row.file_id));
    if (location) addNamespace(group, "legacy_mapping", String(row.file_id), String(location.storage_profile_id), 1);
    group.legacyMappings.push({ fileId: String(row.file_id), locationId: String(row.location_id),
      classification: String(row.classification), purpose: text(file?.purpose), observedAt: String(row.observed_at),
      expectedByteSize: number(file?.expected_byte_size), expectedSha256: text(file?.expected_sha256),
      evidenceSha256: await sha256Hex(String(row.evidence_json)), purposeComparison: "not_comparable" });
  }

  const resultGroups = [...groups.values()].sort((a, b) => compare(locatorKey(a.locator), locatorKey(b.locator)));
  for (const group of resultGroups) {
    group.registries = sorted(group.registries);
    group.lifecycle = sorted(group.lifecycle);
    group.archiveObservations = sorted(group.archiveObservations);
    group.consumers.sort((a, b) => compare(a.id, b.id));
    group.namespace.evidence = sorted([...new Map(group.namespace.evidence.map((evidence) => [
      canonical(evidence, MAX_FILE_MIGRATION_INPUT_BYTES), evidence,
    ])).values()]);
    const namespaces = [...new Set(group.namespace.evidence.map((evidence) => evidence.namespaceIdentity))];
    if (namespaces.length === 1 && !group.blockers.includes("namespace_evidence_invalid")) {
      group.namespace.status = "resolved";
      group.namespace.identity = namespaces[0];
    } else {
      group.namespace.status = namespaces.length > 1 ? "conflicting" : "unresolved";
      group.blockers.push(namespaces.length > 1 ? "namespace_conflict" : "namespace_unresolved");
    }
    const purposes = [...new Set(group.consumers.flatMap((consumer) => consumer.purpose ? [consumer.purpose] : []))].sort(compare);
    const unclassified = group.consumers.some((consumer) => !consumer.purpose);
    if (!group.consumers.length) group.blockers.push("no_typed_consumer");
    if (!(group.locator.storeKind === "r2" && group.locator.provider === "r2"
      || group.locator.storeKind === "managed" && group.locator.provider === "switchdrive")) {
      group.blockers.push("unsupported_legacy_provider");
    }
    if (unclassified) group.blockers.push("consumer_purpose_unresolved");
    if (group.consumers.some((consumer) => consumer.classificationReasons.some((reason) =>
      reason.includes("missing") || reason.includes("invalid") || reason.includes("conflict")))) {
      group.blockers.push("consumer_evidence_requires_review");
    }
    if (purposes.length > 1) group.blockers.push("independent_verified_copies_required");
    if (!group.registries.length) group.blockers.push("no_legacy_registry_record");
    if (group.registries.some((registry) => registry.status !== "ready")) group.blockers.push("legacy_record_not_ready");
    if (group.lifecycle.some((entry) => entry.table === "blob_integrity_quarantine")) group.blockers.push("legacy_quarantine_present");
    if (group.lifecycle.some((entry) => entry.table === "blob_gc_ledger")) group.blockers.push("legacy_gc_state_present");
    if (group.archiveObservations.some((entry) => entry.initialOutcome !== null)) group.blockers.push("archive_bytes_unavailable");
    const metadata = [...group.registries, ...group.legacyMappings, ...group.archiveObservations];
    const sizes = [...metadata.map((entry) => entry.expectedByteSize),
      ...group.lifecycle.filter((entry) => entry.table === "blob_integrity_quarantine").map((entry) => entry.expectedByteSize)];
    const hashes = metadata.map((entry) => entry.expectedSha256);
    const validSizes = [...new Set(sizes.filter((value): value is number => value !== null
      && Number.isSafeInteger(value) && value >= 0))];
    const validHashes = [...new Set(hashes.filter((value): value is string => value !== null && /^[a-f0-9]{64}$/.test(value)))];
    group.expectedByteSize = validSizes.length === 1 ? validSizes[0] : null;
    group.expectedSha256 = validHashes.length === 1 ? validHashes[0] : null;
    if (!sizes.length || sizes.some((value) => value === null)) group.blockers.push("expected_size_incomplete");
    if (!hashes.length || hashes.some((value) => value === null)) group.blockers.push("expected_hash_incomplete");
    if (validSizes.length > 1 || sizes.some((value) => value !== null && (!Number.isSafeInteger(value) || value < 0))) {
      group.blockers.push("expected_size_conflict");
    }
    if (validHashes.length > 1 || hashes.some((value) => value !== null && !/^[a-f0-9]{64}$/.test(value))) {
      group.blockers.push("expected_hash_conflict");
    }
    for (const mapping of group.legacyMappings) {
      if (group.consumers.length) {
        const classification = purposes.length > 1 || purposes.length > 0 && unclassified ? "ambiguous"
          : purposes.length === 1 ? "classified" : "unclassified";
        mapping.purposeComparison = mapping.classification === classification
          && mapping.purpose === (classification === "classified" ? purposes[0] : null) ? "consistent" : "different";
        if (mapping.purposeComparison === "different") group.blockers.push("legacy_mapping_purpose_changed");
      }
    }
    group.legacyMappings = sorted(group.legacyMappings);
    for (const purpose of purposes) {
      const identity = group.namespace.status === "resolved" ? canonical({
        version: 1, namespace: group.namespace.identity, locator: group.locator, purpose, accessScope: "system",
      }, MAX_FILE_MIGRATION_INPUT_BYTES) : null;
      group.proposals.push({ purpose, accessScope: "system",
        proposedFileId: identity === null ? null : `proposed-file-${await sha256Hex(identity)}`,
        consumerIds: group.consumers.filter((consumer) => consumer.purpose === purpose).map((consumer) => consumer.id),
        requiresIndependentVerifiedCopy: purposes.length > 1 });
    }
    group.blockers = [...new Set(group.blockers)].sort(compare);
  }
  const plan: FileMigrationPlan = {
    version: 1, kind: "file-migration-observation", executable: false, bytesVerified: false,
    source: { basis: "archive-snapshot", schemaVersion: snapshot.schemaVersion, archiveProfile: snapshot.archiveProfile,
      exportedAt: snapshot.exportedAt, inputSha256 },
    coverage: projection.coverage, groups: resultGroups,
    unresolvedConsumers: projection.consumers.filter((consumer) => !consumer.locator),
    summary: {
      groups: resultGroups.length, consumers: projection.consumers.length,
      proposals: resultGroups.reduce((count, group) => count + group.proposals.length, 0),
      multiPurposeGroups: resultGroups.filter((group) => group.proposals.length > 1).length,
      namespaceUnresolvedGroups: resultGroups.filter((group) => group.namespace.status !== "resolved").length,
      blockedGroups: resultGroups.filter((group) => group.blockers.length > 0).length,
    },
  };
  canonical(plan, MAX_FILE_MIGRATION_PLAN_BYTES);
  return plan;
}

/** Canonical JSON for the bounded read-only report; contains no byte payloads. */
export function serializeFileMigrationPlan(plan: FileMigrationPlan): string {
  return canonical(plan, MAX_FILE_MIGRATION_PLAN_BYTES);
}

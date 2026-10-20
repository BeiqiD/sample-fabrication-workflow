import type { ExportRow, ExportTables } from "./export";

// This is a versioned archive profile, not a generic serializer for future
// storage schemas. Adding publication states, secret columns or jobs requires
// another reviewed archive profile and recovery contract.
export const FILE_FOUNDATION_EXPORT_COLUMNS = {
  storage_profiles: ["id", "adapter_type", "namespace_identity", "configuration_source", "credential_reference", "configuration_revision", "state", "created_at"],
  files: ["id", "purpose", "access_scope", "expected_byte_size", "expected_sha256", "verified_sha256", "state", "active_location_id", "created_at"],
  file_locations: ["id", "file_id", "storage_profile_id", "object_key", "state", "created_at"],
  legacy_file_mappings: ["store_kind", "provider", "object_key", "file_id", "location_id", "classification", "evidence_json", "observed_at"],
} as const;

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Full export rejected: invalid legacy overlap ${message}`);
}
function text(value: unknown, maximum: number) {
  return typeof value === "string" && value.length > 0 && [...value].length <= maximum && !value.includes("\0");
}
function byId(rows: ExportRow[], name: string) {
  const map = new Map<string, ExportRow>();
  for (const row of rows) {
    ensure(text(row.id, 256) && !map.has(row.id as string), `${name} identity`);
    map.set(row.id as string, row);
  }
  return map;
}

export function validateLegacyOverlap(tables: ExportTables) {
  for (const [name, columns] of Object.entries(FILE_FOUNDATION_EXPORT_COLUMNS)) {
    ensure(Array.isArray(tables[name]), `${name} inventory`);
    for (const row of tables[name]) ensure(JSON.stringify(Object.keys(row).sort()) === JSON.stringify([...columns].sort()), `${name} columns`);
  }
  const profiles = byId(tables.storage_profiles, "profile");
  const files = byId(tables.files, "file");
  const locations = byId(tables.file_locations, "location");
  const namespaces = new Set<string>();
  for (const profile of profiles.values()) {
    const identity = JSON.stringify([profile.adapter_type, profile.namespace_identity]);
    ensure(profile.state === "historical" && profile.configuration_revision === 1
      && text(profile.namespace_identity, 2048) && !namespaces.has(identity)
      && typeof profile.created_at === "string", "profile state");
    namespaces.add(identity);
    ensure(profile.adapter_type === "r2"
      ? profile.configuration_source === "bootstrap" && profile.credential_reference === null
      : profile.adapter_type === "switchdrive" && profile.configuration_source === "environment"
        && profile.credential_reference === "environment:SWITCHDRIVE", "profile configuration");
  }
  for (const file of files.values()) {
    ensure(file.state === "unresolved" && file.verified_sha256 === null && file.active_location_id === null
      && file.access_scope === "system" && typeof file.created_at === "string", "file publication state");
    ensure(file.purpose === null || ["research_source", "embedded_content", "derived_preview", "provenance", "job_output"].includes(String(file.purpose)), "file purpose");
    ensure(file.expected_byte_size === null || typeof file.expected_byte_size === "number"
      && Number.isSafeInteger(file.expected_byte_size) && file.expected_byte_size >= 0, "expected byte size");
    ensure(file.expected_sha256 === null || typeof file.expected_sha256 === "string" && /^[a-f0-9]{64}$/.test(file.expected_sha256), "expected hash");
  }
  const physicalLocations = new Set<string>();
  for (const location of locations.values()) {
    const identity = JSON.stringify([location.storage_profile_id, location.object_key]);
    ensure(location.state === "unresolved" && profiles.has(String(location.storage_profile_id))
      && files.has(String(location.file_id)) && text(location.object_key, 4096)
      && typeof location.created_at === "string" && !physicalLocations.has(identity), "location identity or state");
    physicalLocations.add(identity);
  }
  const mappedFiles = new Set<string>();
  const mappedLocations = new Set<string>();
  const legacyLocators = new Set<string>();
  for (const mapping of tables.legacy_file_mappings) {
    const fileId = String(mapping.file_id), locationId = String(mapping.location_id);
    const file = files.get(fileId), location = locations.get(locationId);
    const profile = location && profiles.get(String(location.storage_profile_id));
    const locator = JSON.stringify([mapping.store_kind, mapping.provider, mapping.object_key]);
    ensure(file && location && profile && location.file_id === fileId && location.object_key === mapping.object_key
      && profile.adapter_type === mapping.provider && !mappedFiles.has(fileId)
      && !mappedLocations.has(locationId) && !legacyLocators.has(locator), "mapping identity");
    ensure(mapping.store_kind === "r2" && mapping.provider === "r2"
      || mapping.store_kind === "managed" && mapping.provider === "switchdrive", "mapping provider");
    ensure(["classified", "ambiguous", "unclassified"].includes(String(mapping.classification))
      && (mapping.classification === "classified" ? file.purpose !== null : file.purpose === null), "mapping classification");
    let evidence: unknown;
    try { evidence = JSON.parse(String(mapping.evidence_json)); } catch { /* rejected below */ }
    ensure(evidence && typeof evidence === "object" && !Array.isArray(evidence)
      && typeof mapping.observed_at === "string", "mapping evidence");
    mappedFiles.add(fileId); mappedLocations.add(locationId); legacyLocators.add(locator);
  }
  ensure(mappedFiles.size === files.size && mappedLocations.size === locations.size,
    "files and locations must have legacy mappings; new-only bytes are unsupported");
  // Observations may survive collection of an old, unretained blob. They do not
  // add byte roots or change the authoritative legacy download/retention plan.
}

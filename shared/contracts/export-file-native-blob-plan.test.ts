import { describe, expect, it } from "vitest";
import type { ExportTables } from "./export";
import { buildFileNativeBlobExportPlan } from "./export-file-native-blob-plan";
import { buildFileShadowBlobExportPlan } from "./export-file-shadow";

function fixture(): ExportTables {
  return { storage_profiles: [
    { id: "first-native", adapter_type: "s3", configuration_revision: 1 },
    { id: "second-native", adapter_type: "s3", configuration_revision: 1 },
  ], files: [{ id: "first-file", expected_byte_size: 1, expected_sha256: "a".repeat(64) },
    { id: "second-file", expected_byte_size: 1, expected_sha256: "b".repeat(64) }],
  file_locations: [{ id: "first-location", file_id: "first-file", storage_profile_id: "first-native", object_key: "same/opaque/%2F/key" },
    { id: "second-location", file_id: "second-file", storage_profile_id: "second-native", object_key: "same/opaque/%2F/key" }],
  file_location_publications: [{ location_id: "first-location", verified_byte_size: 1, verified_sha256: "a".repeat(64) }],
  file_location_availability: [{ location_id: "first-location", availability: "available" }],
  file_location_retention_edges: [{ location_id: "first-location", source_type: "file_location", source_id: "first-location",
    occurrence_type: "file_location_hold", occurrence_id: "hold", retention_reason: "read", retain_until: null }],
  assets: [{ id: "native-alias", r2_key: null, file_id: "first-file", storage_profile_id: "first-native", object_key: "same/opaque/%2F/key" }],
  };
}
describe("V21 explicit native File byte inventory", () => {
  it("keeps same-key native namespaces separate and pending bytes metadata-only", () => {
    const tables = fixture(), entries = buildFileNativeBlobExportPlan(tables);
    expect(entries).toHaveLength(2); expect(new Set(entries.map(entry => entry.locatorId)).size).toBe(2);
    expect(entries.every(entry => entry.storeKind === "file" && entry.provider === "s3" && entry.byteAuthority === "file_location")).toBe(true);
    expect(entries[0]).toMatchObject({ storageProfileId: "first-native", storageProfileRevision: 1, locationId: "first-location",
      downloadUrl: "/exports/file-locations/first-location?profile=first-native&revision=1", initialOutcome: null });
    expect(entries[1]).toMatchObject({ downloadUrl: null, initialOutcome: "metadata_not_ready" });
    expect(entries[0].sourceOccurrences).toHaveLength(1);
    expect(() => buildFileShadowBlobExportPlan(tables)).toThrow("location byte address");
  });
  it("records known deletion and retirement without guessing a legacy route", () => {
    const tables = fixture(); tables.file_location_availability[0].availability = "deleted";
    expect(buildFileNativeBlobExportPlan(tables)[0]).toMatchObject({ downloadUrl: null, initialOutcome: "missing" });
    tables.file_location_availability[0].availability = "profile_retired";
    expect(buildFileNativeBlobExportPlan(tables)[0]).toMatchObject({ downloadUrl: null, initialOutcome: "provider_unavailable" });
  });
});

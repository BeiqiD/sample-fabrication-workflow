import { describe, expect, it } from "vitest";
import type { ExportTables } from "./export";
import { buildResearchPackageBlobExportPlan } from "./export-research-packages";

function fixture(): ExportTables {
  return {
    storage_profiles: [{ id: "profile", adapter_type: "s3", configuration_revision: 1 }],
    files: [{ id: "archive", purpose: "job_output", expected_byte_size: 8, expected_sha256: "a".repeat(64) }],
    file_locations: [{ id: "location", file_id: "archive", storage_profile_id: "profile", object_key: "opaque/output" }],
    file_location_publications: [], file_location_availability: [], file_location_retention_edges: [],
    research_package_jobs: [{ id: "job", kind: "data_package", state: "completed" }],
    research_package_files: [{ job_id: "job", logical_file_id: "@archive", entry_kind: "artifact", purpose: "job_output", candidate_file_id: "archive" }],
  };
}

describe("V23 explicit temporary package-output byte policy", () => {
  it("omits recursive output bytes while retaining their exact metadata tables", () => {
    const tables = fixture(), original = structuredClone(tables);
    expect(buildResearchPackageBlobExportPlan(tables)).toEqual({ blobs: [], excludedOutputs: [{
      locationId: "location", fileId: "archive", jobId: "job", reason: "disposable_job_output",
    }] });
    expect(tables).toEqual(original);
  });
  it.each(["s3", "r2"])("keeps unrelated %s File locations", adapter => {
    const tables = fixture(); tables.storage_profiles[0].adapter_type = adapter;
    tables.file_locations.push({ ...tables.file_locations[0], id: "other", file_id: "other-file", object_key: "opaque/research" });
    tables.files.push({ id: "other-file", purpose: "research_source", expected_byte_size: 8, expected_sha256: "b".repeat(64) });
    expect(buildResearchPackageBlobExportPlan(tables).blobs.map(row => row.locationId)).toEqual(["other"]);
  });
  it.each(["business", "derivation", "manual-location", "manual-file", "migration", "pending-export", "pending-import", "upload-preview"])(
    "preserves bytes required by %s", dependency => {
      const tables = fixture();
      if (dependency === "business") tables.file_consumer_projection = [{ file_id: "archive" }];
      if (dependency === "derivation") tables.file_derivations = [{ source_file_id: "archive", derived_file_id: "other-file" }];
      if (dependency === "manual-location") tables.file_location_holds = [{ location_id: "location", hold_kind: "manual", released_at: null }];
      if (dependency === "manual-file") tables.file_holds = [{ file_id: "archive", hold_kind: "manual", released_at: null }];
      if (dependency === "migration") tables.file_migration_items = [{ file_id: "archive", cleanup_released_at: null }];
      if (dependency === "pending-export") {
        tables.research_package_jobs.push({ id: "pending", kind: "data_package", state: "queued" });
        tables.research_package_files.push({ job_id: "pending", entry_kind: "source", source_file_id: "archive" });
      }
      if (dependency === "pending-import") {
        tables.research_package_jobs[0].kind = "upload";
        tables.research_package_jobs.push({ id: "copy", kind: "import", state: "paused", source_upload_job_id: "job" });
      }
      if (dependency === "upload-preview") Object.assign(tables.research_package_jobs[0], { kind: "upload", state: "preview" });
      const result = buildResearchPackageBlobExportPlan(tables);
      expect(result.excludedOutputs).toEqual([]);
      expect(result.blobs.map(row => row.locationId)).toEqual(["location"]);
    },
  );
  it("never classifies a payload File as disposable merely because its purpose is job_output", () => {
    const tables = fixture(); tables.research_package_files[0].entry_kind = "payload";
    expect(buildResearchPackageBlobExportPlan(tables).excludedOutputs).toEqual([]);
  });
  it("classifies expired previews at the observed source clock, while retaining accepted import inputs", () => {
    const tables = fixture(); Object.assign(tables.research_package_jobs[0], { kind: "upload", state: "preview", expires_at: "2026-10-06T00:00:00.000Z" });
    expect(buildResearchPackageBlobExportPlan(tables, "2026-10-05T23:59:59.999Z").excludedOutputs).toEqual([]);
    expect(buildResearchPackageBlobExportPlan(tables, "2026-10-06T00:00:00.000Z").excludedOutputs).toHaveLength(1);
    tables.research_package_jobs.push({ id: "accepted-copy", kind: "import", state: "paused", source_upload_job_id: "job" });
    expect(buildResearchPackageBlobExportPlan(tables, "2026-10-07T00:00:00.000Z").excludedOutputs).toEqual([]);
  });
  it("keeps SQLite offsetless expiry and fractional rounding independent of the restoring host timezone", () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      const tables = fixture(); Object.assign(tables.research_package_jobs[0], { kind: "upload", state: "preview", expires_at: "2026-10-06 10:00:00.0006" });
      expect(buildResearchPackageBlobExportPlan(tables, "2026-10-06T10:00:00.000Z").excludedOutputs).toEqual([]);
      expect(buildResearchPackageBlobExportPlan(tables, "2026-10-06T10:00:00.001Z").excludedOutputs).toHaveLength(1);
      process.env.TZ = "Asia/Shanghai";
      expect(buildResearchPackageBlobExportPlan(tables, "2026-10-06 10:00:00.001").excludedOutputs).toHaveLength(1);
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
});

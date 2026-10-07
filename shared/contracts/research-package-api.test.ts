import { describe, expect, it } from "vitest";
import {
  checkedResearchExecutorStatus, checkedResearchExportInput, checkedResearchExportPlanInput,
  checkedResearchImportInput, checkedResearchJobControl, checkedResearchJobStatus,
  checkedResearchPackagePreview, checkedResearchPreflightError, checkedResearchRequestReceipt, checkedResearchRoot, checkedResearchUploadInput,
  RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES, RESEARCH_PACKAGE_MAX_FILES, RESEARCH_PACKAGE_MAX_FILE_BYTES,
  RESEARCH_PACKAGE_MAX_METADATA_BYTES, RESEARCH_PACKAGE_MAX_RECORDS, RESEARCH_PACKAGE_MAX_ROOTS,
  ResearchPackageInputError, type ResearchJobStatus, type ResearchPackagePreview,
} from "./research-package-api";

const at = "2026-10-06T09:00:00.000Z", sha256 = "a".repeat(64);
const roots = [{ kind: "sample" as const, id: "sample:1" }, { kind: "project" as const, id: "project:1" }];
const job = (): ResearchJobStatus => ({ id: "job:1", requestId: "request:1", kind: "data_package", state: "queued", phase: "snapshot",
  acceptedAt: at, updatedAt: at, reason: null, progress: { completedFiles: 0, totalFiles: 2, bytesDone: 0, bytesTotal: 12 }, output: null, result: null });
const preview = (): ResearchPackagePreview => ({ schema: "research-package-preview/1", kind: "data_package", roots: structuredClone(roots),
  counts: { records: 14, files: 2, bytes: 12 }, archiveBytes: 2048, metadataBytes: 512, warnings: [], complete: true,
  capabilities: { dataPackage: { available: true, reasons: [] }, report: { available: true, reasons: [] } },
  dependencies: [{ targetType: "sample", id: "sample:1", outcome: "included", reason: null }],
  source: { installationId: "installation:1", packageId: "package:1", payloadSha256: sha256 },
  rolePolicyRevision: 3, naming: { suffix: " (copy)", conflicts: [{ kind: "sample", sourceId: "sample:1", sourceName: "S-1", destinationName: "S-1 (copy)" }] },
  targets: [{ purpose: "research_source", role: "originals", profileId: "profile:s3", configurationRevision: 2, available: true },
    { purpose: "embedded_content", role: "internal", profileId: "profile:r2", configurationRevision: 1, available: true }], existingImportJobId: null });
const executor = () => ({ supported: true, enabled: true, stale: false, canManage: false, lastHeartbeatAt: at,
  cadenceSeconds: 120, maxStepMs: 60000, reason: null });

describe("research operation inputs", () => {
  it("preserves root namespaces, explicit output intent and explicit copy/naming choices", () => {
    const selected = [{ kind: "sample" as const, id: "same/opaque-id" }, { kind: "project" as const, id: "same/opaque-id" }];
    for (const kind of ["data_package", "report"] as const) {
      expect(checkedResearchExportPlanInput({ kind, roots: selected })).toEqual({ kind, roots: selected });
      expect(checkedResearchExportInput({ requestId: "request:1", kind, roots: selected })).toEqual({ requestId: "request:1", kind, roots: selected });
    }
    expect(checkedResearchImportInput({ requestId: "copy:1", uploadJobId: "upload:1", anotherCopy: false, expectedRolePolicyRevision: 3 }))
      .toEqual({ requestId: "copy:1", uploadJobId: "upload:1", anotherCopy: false, expectedRolePolicyRevision: 3 });
    const copy = { requestId: "copy:2", uploadJobId: "upload:1", anotherCopy: true, expectedRolePolicyRevision: 3, naming: { suffix: "（副本）" } };
    expect(checkedResearchImportInput(copy)).toEqual(copy);
    expect(checkedResearchImportInput({ ...copy, naming: { suffix: "" } }).naming).toEqual({ suffix: "" });
  });

  it("bounds root closure selections and rejects duplicate roots within one namespace", () => {
    const selected = Array.from({ length: RESEARCH_PACKAGE_MAX_ROOTS }, (_, index) => ({ kind: "sample", id: `sample:${index}` }));
    expect(checkedResearchExportPlanInput({ kind: "data_package", roots: selected }).roots).toHaveLength(RESEARCH_PACKAGE_MAX_ROOTS);
    for (const invalidRoots of [[], [...roots, roots[0]], [...selected, { kind: "project", id: "too-many" }]]) {
      expect(() => checkedResearchExportPlanInput({ kind: "data_package", roots: invalidRoots })).toThrow(ResearchPackageInputError);
    }
  });

  it.each([
    { kind: "run", id: "run:1" }, { kind: "sample", id: "" }, { kind: "sample", id: "a".repeat(257) },
    { kind: "sample", id: "bad id" }, { kind: "sample", id: "bad\u0000id" }, { kind: "sample", id: "\ud800" },
    { kind: "sample", id: "sample:1", objectKey: "PRIVATE_KEY" }, null, [],
  ])("rejects malformed or privately extended root %j", value => {
    expect(() => checkedResearchRoot(value)).toThrow(ResearchPackageInputError);
  });

  it.each([".", "..", "../private", "request/private", "request\\private", "bad id", "bad\nrequest"])(
    "rejects unsafe operation identity %j before it becomes durable work", requestId => {
      expect(() => checkedResearchExportInput({ requestId, kind: "data_package", roots })).toThrow(ResearchPackageInputError);
      expect(() => checkedResearchUploadInput({ requestId, byteSize: 12, sha256 })).toThrow(ResearchPackageInputError);
      expect(() => checkedResearchImportInput({ requestId, uploadJobId: "upload:1", anotherCopy: false, expectedRolePolicyRevision: 3 })).toThrow(ResearchPackageInputError);
      expect(() => checkedResearchImportInput({ requestId: "request:1", uploadJobId: requestId, anotherCopy: false, expectedRolePolicyRevision: 3 })).toThrow(ResearchPackageInputError);
    },
  );

  it("validates declared upload size/hash without admitting zero, fractional, oversized or noncanonical claims", () => {
    expect(checkedResearchUploadInput({ requestId: "upload:1", byteSize: RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES, sha256 })).toEqual({
      requestId: "upload:1", byteSize: RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES, sha256,
    });
    for (const patch of [{ byteSize: 0 }, { byteSize: -1 }, { byteSize: 1.2 }, { byteSize: RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES + 1 },
      { byteSize: Number.NaN }, { sha256: "A".repeat(64) }, { sha256: "a".repeat(63) }, { sha256: "g".repeat(64) }]) {
      expect(() => checkedResearchUploadInput({ requestId: "upload:1", byteSize: 12, sha256, ...patch })).toThrow(ResearchPackageInputError);
    }
  });

  it("rejects unknown input fields, provider locators and unsupported copy policies", () => {
    expect(() => checkedResearchExportPlanInput({ kind: "data_package", roots, storageProfileId: "private" })).toThrow(ResearchPackageInputError);
    expect(() => checkedResearchExportInput({ requestId: "request:1", kind: "system_backup", roots })).toThrow(ResearchPackageInputError);
    expect(() => checkedResearchUploadInput({ requestId: "upload:1", byteSize: 12, sha256, objectKey: "PRIVATE_KEY" })).toThrow(ResearchPackageInputError);
    for (const patch of [{ anotherCopy: "false" }, { mergeExisting: true }, { naming: { suffix: "copy", overwrite: true } },
      { naming: { suffix: "x".repeat(33) } }, { naming: { suffix: "bad\nname" } }, { naming: null }]) {
      expect(() => checkedResearchImportInput({ requestId: "request:1", uploadJobId: "upload:1", anotherCopy: false, expectedRolePolicyRevision: 3, ...patch })).toThrow(ResearchPackageInputError);
    }
  });

  it("requires an explicit observed policy revision and preserves null without admitting malformed CAS values", () => {
    const input = { requestId: "copy:1", uploadJobId: "upload:1", anotherCopy: false, expectedRolePolicyRevision: 3 };
    expect(checkedResearchImportInput({ ...input, expectedRolePolicyRevision: null }).expectedRolePolicyRevision).toBeNull();
    for (const expectedRolePolicyRevision of [undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => checkedResearchImportInput({ ...input, expectedRolePolicyRevision })).toThrow(ResearchPackageInputError);
    }
    const { expectedRolePolicyRevision: _revision, ...missing } = input;
    expect(() => checkedResearchImportInput(missing)).toThrow(ResearchPackageInputError);
  });
});

describe("public bounded package preflight error DTO", () => {
  const error = "Package copy preflight is unsupported or conflicts with existing immutable content.";
  it.each(["definition_media_destination_conflict", "canonical_definition_conflict", "import_plan_budget", "publication_row_size_limit",
    "publication_statement_limit", "destination_name_preflight_limit", "destination_name_limit", "destination_name_conflict", "unsupported_source_import_state"])(
    "admits only the static public envelope for %s", reason => {
      expect(checkedResearchPreflightError({ error, reason })).toEqual({ error, reason });
    },
  );
  it.each([{ reason: "destination_name_conflict" }, { error }, { error: "PRIVATE_PROVIDER_DETAIL", reason: "destination_name_conflict" },
    { error, reason: "unknown_private_failure" }, { error, reason: null }, { error, reason: 1 },
    { error, reason: "destination_name_conflict", endpoint: "https://private.example" }, [error, "destination_name_conflict"]])(
    "rejects incomplete, privately extended or unrecognized preflight errors", value => {
      expect(() => checkedResearchPreflightError(value)).toThrow(ResearchPackageInputError);
    },
  );
});

describe("strict research package previews", () => {
  const blockedSourcePreview = (kind: ResearchPackagePreview["kind"] = "data_package"): ResearchPackagePreview => ({
    ...preview(), kind, counts: { records: 2400, files: 121, bytes: 128 * 1024 * 1024 }, archiveBytes: null, complete: false,
    warnings: ["package_budget_exceeded"], source: null, naming: null, targets: [],
    capabilities: { dataPackage: { available: false, reasons: ["package_budget_exceeded"] },
      report: { available: false, reasons: ["package_budget_exceeded"] } },
  });

  it("preserves declared dependencies, naming conflicts and destinations without inferring byte verification", () => {
    const value = preview(); expect(checkedResearchPackagePreview(value)).toEqual(value);
    value.complete = false; value.warnings = ["file_unavailable"];
    value.capabilities.dataPackage = { available: false, reasons: ["missing_required_file"] };
    value.targets[0].available = false; value.dependencies[0].outcome = "unavailable"; value.dependencies[0].reason = "file_unavailable";
    value.existingImportJobId = "existing:1"; value.archiveBytes = null;
    expect(checkedResearchPackagePreview(value)).toEqual(value);
  });

  it.each(["data_package", "report"] as const)("preserves exact over-budget source counts in a blocked %s advisory preview", kind => {
    const value = blockedSourcePreview(kind), checked = checkedResearchPackagePreview(value);
    expect(checked).toEqual(value);
    expect(checked.counts).toEqual({ records: 2400, files: 121, bytes: 134217728 });
    expect(checked.capabilities.dataPackage).toEqual({ available: false, reasons: ["package_budget_exceeded"] });
    expect(checked.capabilities.report).toEqual({ available: false, reasons: ["package_budget_exceeded"] });
  });

  it("keeps over-budget advisory counts bounded by safe integers while retaining the dependency array budget", () => {
    const value = blockedSourcePreview();
    value.counts = { records: Number.MAX_SAFE_INTEGER, files: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER };
    value.dependencies = Array.from({ length: RESEARCH_PACKAGE_MAX_RECORDS }, (_, index) => ({
      targetType: "sample", id: `sample:${index}`, outcome: "included", reason: null,
    }));
    expect(checkedResearchPackagePreview(value)).toEqual(value);
  });

  it.each([
    ["an imported archive source", (value: ResearchPackagePreview) => { value.source = preview().source; }],
    ["an available data package", (value: ResearchPackagePreview) => { value.capabilities.dataPackage = { available: true, reasons: [] }; }],
    ["an available report", (value: ResearchPackagePreview) => { value.capabilities.report = { available: true, reasons: [] }; }],
    ["no data-package budget reason", (value: ResearchPackagePreview) => { value.capabilities.dataPackage.reasons = ["file_unavailable"]; }],
    ["no report budget reason", (value: ResearchPackagePreview) => { value.capabilities.report.reasons = ["file_unavailable"]; }],
    ["an unsafe record count", (value: ResearchPackagePreview) => { value.counts.records = Number.MAX_SAFE_INTEGER + 1; }],
    ["an unsafe file count", (value: ResearchPackagePreview) => { value.counts.files = Number.MAX_SAFE_INTEGER + 1; }],
    ["an unsafe byte count", (value: ResearchPackagePreview) => { value.counts.bytes = Number.MAX_SAFE_INTEGER + 1; }],
    ["a negative count", (value: ResearchPackagePreview) => { value.counts.bytes = -1; }],
    ["a fractional count", (value: ResearchPackagePreview) => { value.counts.files = 121.5; }],
    ["an oversized dependency array", (value: ResearchPackagePreview) => { value.dependencies = Array.from({ length: RESEARCH_PACKAGE_MAX_RECORDS + 1 },
      (_, index) => ({ targetType: "sample", id: `sample:${index}`, outcome: "included", reason: null })); }],
  ])("rejects an over-budget preview with %s for both output kinds", (_description, mutate) => {
    for (const kind of ["data_package", "report"] as const) {
      const value = blockedSourcePreview(kind); mutate(value);
      expect(() => checkedResearchPackagePreview(value)).toThrow(ResearchPackageInputError);
    }
  });

  it("preserves untrusted presentation text as data without treating it as an identity or provider address", () => {
    const value = preview(); value.naming!.conflicts[0].sourceName = '<img src=x onerror="alert(1)">';
    value.naming!.conflicts[0].destinationName = "研究（副本）";
    expect(checkedResearchPackagePreview(value).naming).toEqual(value.naming);
  });

  it("preserves absent and null context labels and admits exactly 1000 Unicode scalars", () => {
    const absent = checkedResearchPackagePreview(preview()).dependencies[0];
    expect(Object.hasOwn(absent, "label")).toBe(false);
    for (const label of [null, "", "🧪".repeat(1000)]) {
      const value = preview(); value.dependencies[0].label = label;
      expect(checkedResearchPackagePreview(value).dependencies[0]).toEqual(value.dependencies[0]);
    }
  });

  it.each([
    ["1001 Unicode scalars", "🧪".repeat(1001)],
    ["line feed", "Run\nprivate"], ["NUL", "Step\u0000private"], ["DEL", "Sample\u007fprivate"],
    ["unpaired high surrogate", "Run\ud800"], ["unpaired low surrogate", "Step\udfff"],
    ["explicit undefined", undefined], ["non-string label", 12],
  ])("rejects %s in a context label", (_description, label) => {
    const value = preview(); Object.assign(value.dependencies[0], { label });
    expect(() => checkedResearchPackagePreview(value)).toThrow(ResearchPackageInputError);
  });

  it("rejects private fields even when a dependency has a valid human label", () => {
    const value = preview(); Object.assign(value.dependencies[0], { label: "Sample S-17", objectKey: "PRIVATE_CONTEXT_KEY" });
    expect(() => checkedResearchPackagePreview(value)).toThrow(ResearchPackageInputError);
  });

  it("preserves an unavailable policy as null and rejects missing or malformed preview policy revisions", () => {
    expect(checkedResearchPackagePreview({ ...preview(), rolePolicyRevision: null }).rolePolicyRevision).toBeNull();
    for (const rolePolicyRevision of [undefined, 0, -1, 1.5, "3", Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => checkedResearchPackagePreview({ ...preview(), rolePolicyRevision })).toThrow(ResearchPackageInputError);
    }
    const { rolePolicyRevision: _revision, ...missing } = preview();
    expect(() => checkedResearchPackagePreview(missing)).toThrow(ResearchPackageInputError);
  });

  it.each([
    ["unknown top-level field", (value: ResearchPackagePreview) => Object.assign(value, { credentials: "PRIVATE_SECRET" })],
    ["private target locator", (value: ResearchPackagePreview) => Object.assign(value.targets[0], { objectKey: "PRIVATE_KEY" })],
    ["private source field", (value: ResearchPackagePreview) => Object.assign(value.source!, { endpoint: "https://private.example" })],
    ["private count field", (value: ResearchPackagePreview) => Object.assign(value.counts, { credentialRef: "private" })],
    ["duplicate root", (value: ResearchPackagePreview) => { value.roots.push(value.roots[0]); }],
    ["fractional record count", (value: ResearchPackagePreview) => { value.counts.records = 1.5; }],
    ["too many records", (value: ResearchPackagePreview) => { value.counts.records = RESEARCH_PACKAGE_MAX_RECORDS + 1; }],
    ["too many files", (value: ResearchPackagePreview) => { value.counts.files = RESEARCH_PACKAGE_MAX_FILES + 1; }],
    ["too many file bytes", (value: ResearchPackagePreview) => { value.counts.bytes = RESEARCH_PACKAGE_MAX_FILE_BYTES + 1; }],
    ["oversized archive", (value: ResearchPackagePreview) => { value.archiveBytes = RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES + 1; }],
    ["oversized metadata", (value: ResearchPackagePreview) => { value.metadataBytes = RESEARCH_PACKAGE_MAX_METADATA_BYTES + 1; }],
    ["negative byte count", (value: ResearchPackagePreview) => { value.counts.bytes = -1; }],
    ["nonboolean completeness", (value: ResearchPackagePreview) => { value.complete = "true" as never; }],
    ["provider warning body", (value: ResearchPackagePreview) => { value.warnings = ["AccessDenied: PRIVATE_SECRET"]; }],
    ["contradictory available capability", (value: ResearchPackagePreview) => { value.capabilities.dataPackage.reasons = ["missing_file"]; }],
    ["unknown dependency outcome", (value: ResearchPackagePreview) => { value.dependencies[0].outcome = "healthy" as never; }],
    ["private dependency field", (value: ResearchPackagePreview) => Object.assign(value.dependencies[0], { providerUrl: "https://private.example" })],
    ["unknown file purpose", (value: ResearchPackagePreview) => { value.targets[0].purpose = "private_purpose" as never; }],
    ["duplicate target purpose", (value: ResearchPackagePreview) => { value.targets.push({ ...value.targets[0] }); }],
    ["wrong originals role", (value: ResearchPackagePreview) => { value.targets[0].role = "internal"; }],
    ["wrong internal role", (value: ResearchPackagePreview) => { value.targets[1].role = "originals"; }],
    ["invalid target revision", (value: ResearchPackagePreview) => { value.targets[0].configurationRevision = 0; }],
    ["invalid source hash", (value: ResearchPackagePreview) => { value.source!.payloadSha256 = "a"; }],
    ["unknown naming conflict policy", (value: ResearchPackagePreview) => { value.naming!.conflicts[0].kind = "overwrite" as never; }],
  ])("rejects %s before exposing preview metadata", (_label, mutate) => {
    const value = preview(); mutate(value);
    expect(() => checkedResearchPackagePreview(value)).toThrow(ResearchPackageInputError);
  });

  it("requires the canonical role for all five File purposes", () => {
    const value = preview();
    value.targets = ["research_source", "embedded_content", "derived_preview", "provenance", "job_output"].map(purpose => ({
      purpose: purpose as ResearchPackagePreview["targets"][number]["purpose"],
      role: purpose === "research_source" || purpose === "provenance" ? "originals" : "internal",
      profileId: `profile:${purpose}`, configurationRevision: 1, available: true,
    }));
    expect(checkedResearchPackagePreview(value).targets).toEqual(value.targets);
    for (const index of [2, 3, 4]) {
      const changed = structuredClone(value); changed.targets[index].role = changed.targets[index].role === "internal" ? "originals" : "internal";
      expect(() => checkedResearchPackagePreview(changed)).toThrow(ResearchPackageInputError);
    }
  });
});

describe("durable status and request receipt DTOs", () => {
  it("admits a new request receipt pointing to a completed existing import without rewriting its original job identity", () => {
    const existing = job(); Object.assign(existing, { id: "existing:1", requestId: "old-request", kind: "import", state: "completed", phase: "done",
      result: { roots: [{ kind: "sample", id: "destination:1" }], reused: false } });
    const value = { requestId: "new-request", job: existing, reused: true };
    expect(checkedResearchRequestReceipt(value)).toEqual(value);
    expect(checkedResearchRequestReceipt(value).job.requestId).toBe("old-request");
    expect(checkedResearchRequestReceipt(value).reused).toBe(true);
    expect(checkedResearchRequestReceipt(value).job.result!.reused).toBe(false);
  });

  it("keeps expired output metadata distinct from availability and preserves completed destination roots", () => {
    const value = job(); value.state = "completed"; value.phase = "done";
    value.progress = { completedFiles: 2, totalFiles: 2, bytesDone: 12, bytesTotal: 12 };
    value.output = { available: false, byteSize: 2048, sha256, expiresAt: at };
    value.result = { roots: structuredClone(roots), reused: false };
    expect(checkedResearchJobStatus(value)).toEqual(value);
  });

  it.each([
    ["private actor", (value: ResearchJobStatus) => Object.assign(value, { actorEmail: "PRIVATE_ACTOR" })],
    ["private provider error", (value: ResearchJobStatus) => { value.reason = "AccessDenied PRIVATE_SECRET"; }],
    ["unknown state", (value: ResearchJobStatus) => { value.state = "deployed" as never; }],
    ["unknown phase", (value: ResearchJobStatus) => { value.phase = "provider_delete" as never; }],
    ["nonfinite progress", (value: ResearchJobStatus) => { value.progress.bytesDone = Number.POSITIVE_INFINITY; }],
    ["completed count exceeds total", (value: ResearchJobStatus) => { value.progress.completedFiles = 3; }],
    ["byte count exceeds total", (value: ResearchJobStatus) => { value.progress.bytesDone = 13; }],
    ["total files exceeds bound", (value: ResearchJobStatus) => { value.progress.totalFiles = RESEARCH_PACKAGE_MAX_FILES + 1; }],
    ["fractional progress", (value: ResearchJobStatus) => { value.progress.bytesDone = 0.5; }],
    ["invalid timestamp", (value: ResearchJobStatus) => { value.acceptedAt = "2026-10-06"; }],
    ["private nested progress", (value: ResearchJobStatus) => Object.assign(value.progress, { bucket: "PRIVATE_BUCKET" })],
    ["private output URL", (value: ResearchJobStatus) => { value.output = { available: true, byteSize: 2048, sha256, expiresAt: at };
      Object.assign(value.output, { providerUrl: "https://private.example" }); }],
    ["invalid output hash", (value: ResearchJobStatus) => { value.output = { available: true, byteSize: 2048, sha256: "a", expiresAt: at }; }],
    ["duplicate result roots", (value: ResearchJobStatus) => { value.result = { roots: [roots[0], roots[0]], reused: false }; }],
  ])("rejects %s before saved work is shown", (_label, mutate) => {
    const value = job(); mutate(value); expect(() => checkedResearchJobStatus(value)).toThrow(ResearchPackageInputError);
  });

  it("rejects private receipt extensions and malformed nested job status", () => {
    expect(() => checkedResearchRequestReceipt({ requestId: "request:1", job: job(), reused: false, credentials: "PRIVATE_SECRET" })).toThrow(ResearchPackageInputError);
    expect(() => checkedResearchRequestReceipt({ requestId: "request:1", job: { ...job(), objectKey: "PRIVATE_KEY" }, reused: false })).toThrow(ResearchPackageInputError);
    expect(() => checkedResearchRequestReceipt({ requestId: "request:1", job: job() })).toThrow(ResearchPackageInputError);
    for (const reused of [undefined, null, 0, 1, "false", "true"]) {
      expect(() => checkedResearchRequestReceipt({ requestId: "request:1", job: job(), reused })).toThrow(ResearchPackageInputError);
    }
    expect(checkedResearchRequestReceipt({ requestId: "request:1", job: job(), reused: false }).reused).toBe(false);
    expect(() => checkedResearchRequestReceipt({ requestId: "request:1", job: job(), reused: true })).toThrow(ResearchPackageInputError);
  });

  it.each([".", "..", "../private", "job/private", "job\\private"])(
    "rejects response operation identity %j before it is used for a later request", id => {
      expect(() => checkedResearchJobStatus({ ...job(), id })).toThrow(ResearchPackageInputError);
      expect(() => checkedResearchJobStatus({ ...job(), requestId: id })).toThrow(ResearchPackageInputError);
      expect(() => checkedResearchRequestReceipt({ requestId: id, job: job(), reused: false })).toThrow(ResearchPackageInputError);
      expect(() => checkedResearchPackagePreview({ ...preview(), existingImportJobId: id })).toThrow(ResearchPackageInputError);
    },
  );

  it("preserves disabled/stale executor status without converting it into an enabled runner", () => {
    const value = { ...executor(), enabled: false, stale: true, canManage: true, lastHeartbeatAt: null, reason: "executor_disabled" };
    expect(checkedResearchExecutorStatus(value)).toEqual(value);
    for (const patch of [{ cadenceSeconds: 60 }, { maxStepMs: 120000 }, { enabled: "true" }, { lastHeartbeatAt: "yesterday" },
      { credentials: "PRIVATE_SECRET" }, { reason: "provider https://private.example" }]) {
      expect(() => checkedResearchExecutorStatus({ ...value, ...patch })).toThrow(ResearchPackageInputError);
    }
  });

  it("accepts only explicit bounded job control actions", () => {
    for (const action of ["pause", "resume", "cancel", "retry", "cleanup"]) expect(checkedResearchJobControl({ action })).toEqual({ action });
    for (const value of [{ action: "delete_provider" }, { action: "resume", force: true }, { enabled: true }, null]) {
      expect(() => checkedResearchJobControl(value)).toThrow(ResearchPackageInputError);
    }
  });
});

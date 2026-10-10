import { afterEach, describe, expect, it, vi } from "vitest";
import { RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES, RESEARCH_PACKAGE_MAX_RECORDS, RESEARCH_PACKAGE_MAX_ROOTS,
  type ResearchImportInput, type ResearchJobStatus, type ResearchPackagePreview } from "../../shared/contracts/research-package-api";
import { researchPackageErrorMessage, ResearchPackageRequestError, researchPackagesClient } from "./research-package-client";

const base = "/api/packages", at = "2026-10-06T09:00:00.000Z", sha256 = "a".repeat(64);
const exportInput = { requestId: "export:1", kind: "data_package" as const,
  roots: [{ kind: "sample" as const, id: "sample:1" }, { kind: "project" as const, id: "project:1" }] };
const importInput: ResearchImportInput = { requestId: "import:1", uploadJobId: "upload:1", anotherCopy: false, expectedRolePolicyRevision: 3, naming: { suffix: "（副本）" } };
const uploadInput = { requestId: "upload-request:1", byteSize: 12, sha256 };
const job = (kind: ResearchJobStatus["kind"] = "data_package"): ResearchJobStatus => ({ id: "job:1", requestId: exportInput.requestId,
  kind, state: "queued", phase: "snapshot", acceptedAt: at, updatedAt: at, reason: null,
  progress: { completedFiles: 0, totalFiles: 2, bytesDone: 0, bytesTotal: 12 }, output: null, result: null });
const receipt = (requestId: string, kind: ResearchJobStatus["kind"] = "data_package") => ({ requestId, job: { ...job(kind), requestId }, reused: false });
const preview = (): ResearchPackagePreview => ({ schema: "research-package-preview/1", kind: "data_package", roots: structuredClone(exportInput.roots),
  counts: { records: 14, files: 2, bytes: 12 }, archiveBytes: 2048, metadataBytes: 512, warnings: [], complete: true,
  capabilities: { dataPackage: { available: true, reasons: [] }, report: { available: true, reasons: [] } }, dependencies: [],
  source: { installationId: "installation:1", packageId: "package:1", payloadSha256: sha256 },
  rolePolicyRevision: 3, naming: { suffix: "（副本）", conflicts: [] },
  targets: [{ purpose: "research_source", role: "originals", profileId: "profile:s3", configurationRevision: 1, available: true }], existingImportJobId: null });
const executor = { supported: true, enabled: false, stale: true, canManage: false, lastHeartbeatAt: null, cadenceSeconds: 120,
  maxStepMs: 60000, reason: "executor_disabled" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const network = vi.fn<typeof fetch>();
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); network.mockReset(); });
const mockNetwork = () => { vi.stubGlobal("fetch", network); return network; };

describe("private research package operations", () => {
  it("uses checked plan/acceptance inputs and keeps raw upload distinct from import publication", async () => {
    mockNetwork().mockResolvedValueOnce(json(preview())).mockResolvedValueOnce(json(receipt(exportInput.requestId), 202))
      .mockResolvedValueOnce(json(receipt(uploadInput.requestId, "upload"), 202)).mockResolvedValueOnce(json(receipt(importInput.requestId, "import"), 202));
    const controller = new AbortController();
    const planInput = { kind: exportInput.kind, roots: exportInput.roots };
    expect(await researchPackagesClient.plan(planInput, controller.signal)).toEqual(preview());
    expect(await researchPackagesClient.export(exportInput, controller.signal)).toEqual(receipt(exportInput.requestId));
    expect(await researchPackagesClient.acceptUpload(uploadInput, controller.signal)).toEqual(receipt(uploadInput.requestId, "upload"));
    expect(await researchPackagesClient.import(importInput, controller.signal)).toEqual(receipt(importInput.requestId, "import"));
    expect(network.mock.calls.map(([path]) => path)).toEqual([`${base}/plans`, `${base}/jobs`, `${base}/uploads`, `${base}/imports`]);
    for (const [index, input] of [planInput, exportInput, uploadInput, importInput].entries()) {
      expect(network.mock.calls[index][1]).toEqual({ method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: controller.signal, headers: { "content-type": "application/json" }, body: expect.any(String) });
      expect(JSON.parse(String(network.mock.calls[index][1]?.body))).toEqual(input);
    }
  });

  it("sends the original File body without buffering or hashing it inside the upload client", async () => {
    const file = new File(["archive bytes"], "研究.zip", { type: "application/zip" });
    const arrayBuffer = vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("Whole-file buffering is forbidden"));
    const stream = vi.spyOn(file, "stream"), uploaded = { ...job("upload"), state: "queued" as const, phase: "validate" as const };
    mockNetwork().mockResolvedValue(json(uploaded)); const controller = new AbortController();
    expect(await researchPackagesClient.upload("job:1", file, controller.signal)).toEqual(uploaded);
    expect(network).toHaveBeenCalledExactlyOnceWith(`${base}/jobs/job%3A1/upload`, { method: "PUT", credentials: "same-origin",
      cache: "no-store", redirect: "error", signal: controller.signal, headers: { "content-type": "application/zip" }, body: file });
    expect(network.mock.calls[0][1]?.body).toBe(file);
    expect(arrayBuffer).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled();
  });

  it("reads saved receipts, job progress, validated preview and executor status using GET only", async () => {
    mockNetwork().mockResolvedValueOnce(json(receipt(exportInput.requestId))).mockResolvedValueOnce(json(job()))
      .mockResolvedValueOnce(json({ jobs: [job()] })).mockResolvedValueOnce(json(preview())).mockResolvedValueOnce(json(executor));
    const controller = new AbortController();
    expect(await researchPackagesClient.readRequest(exportInput.requestId, controller.signal)).toEqual(receipt(exportInput.requestId));
    expect(await researchPackagesClient.status("job:1", controller.signal)).toEqual(job());
    expect(await researchPackagesClient.list(controller.signal)).toEqual([job()]);
    expect(await researchPackagesClient.preview("job:1", "（副本）", controller.signal)).toEqual(preview());
    expect(await researchPackagesClient.executor(controller.signal)).toEqual(executor);
    expect(network.mock.calls.map(([path]) => path)).toEqual([`${base}/requests/export%3A1`, `${base}/jobs/job%3A1`, `${base}/jobs`,
      `${base}/jobs/job%3A1/preview?suffix=${encodeURIComponent("（副本）")}`, `${base}/executor`]);
    for (const [, options] of network.mock.calls) expect(options).toEqual({ method: "GET", credentials: "same-origin", cache: "no-store",
      redirect: "error", signal: controller.signal });
    expect(researchPackagesClient.downloadUrl("job:1")).toBe(`${base}/jobs/job%3A1/download`);
    expect(network).toHaveBeenCalledTimes(5);
  });

  it("reconciles a lost acceptance ACK by the original receipt without replaying the mutation", async () => {
    mockNetwork().mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_DETAIL"))
      .mockResolvedValueOnce(json(receipt(exportInput.requestId)));
    await expect(researchPackagesClient.export(exportInput)).rejects.toMatchObject({ status: null });
    expect(network).toHaveBeenCalledOnce();
    expect(await researchPackagesClient.readRequest(exportInput.requestId)).toEqual(receipt(exportInput.requestId));
    expect(network.mock.calls.map(([, options]) => options?.method)).toEqual(["POST", "GET"]);
    expect(JSON.parse(String(network.mock.calls[0][1]?.body))).toEqual(exportInput);
    expect(network.mock.calls[1][1]?.body).toBeUndefined();
  });

  it("reads a checked upload intent with GET only and rejects private extensions, invalid hashes and unsafe paths", async () => {
    mockNetwork().mockResolvedValueOnce(json(uploadInput)).mockResolvedValueOnce(json({ ...uploadInput, objectKey: "PRIVATE_KEY" }))
      .mockResolvedValueOnce(json({ ...uploadInput, sha256: "A".repeat(64) }));
    const controller = new AbortController();
    expect(await researchPackagesClient.uploadIntent("upload:1", controller.signal)).toEqual(uploadInput);
    expect(network.mock.calls[0]).toEqual([`${base}/jobs/upload%3A1/upload-intent`, { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal }]);
    await expect(researchPackagesClient.uploadIntent("upload:1")).rejects.toThrow();
    await expect(researchPackagesClient.uploadIntent("upload:1")).rejects.toThrow();
    for (const id of [".", "..", "upload/private", "upload\\private"]) await expect(researchPackagesClient.uploadIntent(id)).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(3); expect(network.mock.calls.every(([, options]) => options?.method === "GET" && options.body === undefined)).toBe(true);
  });

  it("accepts a new receipt that reuses an existing import job with its original request ID", async () => {
    const existing = { ...job("import"), id: "existing:1", requestId: "original-import-request", state: "completed" as const, phase: "done" as const,
      result: { roots: [{ kind: "sample" as const, id: "destination:1" }], reused: false } };
    const newReceipt = { requestId: importInput.requestId, job: existing, reused: true };
    mockNetwork().mockImplementation(async () => json(newReceipt));
    expect(await researchPackagesClient.import(importInput)).toEqual(newReceipt);
    expect(await researchPackagesClient.readRequest(importInput.requestId)).toEqual(newReceipt);
    expect(network.mock.calls[1][1]?.method).toBe("GET");
    expect(network.mock.calls[1][1]?.body).toBeUndefined();
  });

  it("keeps explicit another-copy intent and each control action separate from status polling", async () => {
    const copy = { ...importInput, requestId: "another-copy:1", anotherCopy: true };
    mockNetwork().mockResolvedValueOnce(json(receipt(copy.requestId, "import"))).mockImplementation(async () => json(job()));
    await researchPackagesClient.import(copy);
    expect(JSON.parse(String(network.mock.calls[0][1]?.body))).toEqual(copy);
    for (const action of ["pause", "resume", "cancel", "retry", "cleanup"] as const) {
      await researchPackagesClient.control("job:1", action);
      expect(network.mock.calls.at(-1)).toEqual([`${base}/jobs/job%3A1/control`, expect.objectContaining({ method: "POST", body: JSON.stringify({ action }) })]);
    }
    await researchPackagesClient.status("job:1");
    expect(network.mock.calls.at(-1)?.[1]?.method).toBe("GET"); expect(network).toHaveBeenCalledTimes(7);
  });

  it.each([400, 401, 403, 409, 410, 413, 422, 503, 500])("keeps private HTTP %i errors generic without using Response.json", async status => {
    const response = json({ error: "PRIVATE_CREDENTIAL", endpoint: "https://private.example" }, status);
    const parse = vi.spyOn(response, "json"); mockNetwork().mockResolvedValue(response);
    const error = await researchPackagesClient.export(exportInput).catch(error => error);
    expect(error).toBeInstanceOf(ResearchPackageRequestError); expect(error.status).toBe(status);
    expect(error.reason).toBeNull();
    expect(parse).not.toHaveBeenCalled(); expect(researchPackageErrorMessage(error)).not.toMatch(/PRIVATE|private\.example/);
    expect(network).toHaveBeenCalledOnce();
  });

  it.each([
    ["definition_media_destination_conflict", "Keep its original file destination"],
    ["canonical_definition_conflict", "Resolve that definition conflict"],
    ["import_plan_budget", "Choose a smaller package"],
    ["publication_row_size_limit", "Shorten that record"],
    ["publication_statement_limit", "fewer records"],
    ["destination_name_preflight_limit", "another naming suffix"],
    ["destination_name_limit", "shorter naming suffix"],
    ["destination_name_conflict", "refresh the preview"],
    ["unsupported_source_import_state", "unfinished foreign import workflow"],
  ])("maps the bounded public %s error to a fixed actionable message", async (reason, message) => {
    mockNetwork().mockResolvedValue(json({ error: "Package copy preflight is unsupported or conflicts with existing immutable content.", reason }, 409));
    const error = await researchPackagesClient.import(importInput).catch(error => error);
    expect(error).toBeInstanceOf(ResearchPackageRequestError); expect(error.status).toBe(409); expect(error.reason).toBe(reason);
    expect(researchPackageErrorMessage(error)).toContain(message); expect(network).toHaveBeenCalledOnce();
  });

  it.each([
    { error: "Package copy preflight is unsupported or conflicts with existing immutable content.", reason: "unknown_provider_reason" },
    { error: "Package copy preflight is unsupported or conflicts with existing immutable content.", reason: "destination_name_conflict", credential: "PRIVATE_SECRET" },
    { error: "PRIVATE_PROVIDER_DETAIL", reason: "destination_name_conflict" },
    { error: "Package copy preflight is unsupported or conflicts with existing immutable content.", reason: null },
    { error: "Package copy preflight is unsupported or conflicts with existing immutable content." },
  ])("keeps unrecognized or privately extended preflight bodies generic", async value => {
    mockNetwork().mockResolvedValue(json(value, 409));
    const error = await researchPackagesClient.import(importInput).catch(error => error);
    expect(error.reason).toBeNull(); expect(researchPackageErrorMessage(error)).toBe(new ResearchPackageRequestError(409).message);
    expect(researchPackageErrorMessage(error)).not.toMatch(/PRIVATE|unknown_provider|credential/);
  });

  it("accepts a complete public body at the byte limit and cancels an oversized stream before later private chunks", async () => {
    const value = { error: "Package copy preflight is unsupported or conflicts with existing immutable content.", reason: "destination_name_conflict" };
    const cancel = vi.fn(); let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++;
      controller.enqueue(new TextEncoder().encode(pulls === 1 ? " ".repeat(1025) : "PRIVATE_LATER_CHUNK")); }, cancel }, { highWaterMark: 0 });
    mockNetwork().mockResolvedValueOnce(new Response(JSON.stringify(value).padEnd(1024, " "), { status: 409, headers: { "content-type": "application/json; charset=utf-8" } }))
      .mockResolvedValueOnce(new Response(body, { status: 409, headers: { "content-type": "application/json" } }));
    const admitted = await researchPackagesClient.import(importInput).catch(error => error);
    expect(admitted.reason).toBe("destination_name_conflict");
    const rejected = await researchPackagesClient.import(importInput).catch(error => error);
    expect(rejected.reason).toBeNull(); expect(researchPackageErrorMessage(rejected)).not.toContain("PRIVATE");
    expect(pulls).toBe(1); expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
  });

  it("does not admit a public reason from the wrong content type, malformed UTF-8 or another HTTP status", async () => {
    const value = { error: "Package copy preflight is unsupported or conflicts with existing immutable content.", reason: "destination_name_conflict" };
    const wrongType = new Response(JSON.stringify(value), { status: 409, headers: { "content-type": "text/html" } });
    mockNetwork().mockResolvedValueOnce(wrongType)
      .mockResolvedValueOnce(new Response(new Uint8Array([0xff]), { status: 409, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(json(value, 403));
    for (let index = 0; index < 3; index++) {
      const error = await researchPackagesClient.import(importInput).catch(error => error); expect(error.reason).toBeNull();
      expect(researchPackageErrorMessage(error)).not.toContain("destination_name_conflict");
    }
    expect(wrongType.bodyUsed).toBe(false);
  });

  it("sanitizes network and malformed-success diagnostics without exposing provider details", async () => {
    mockNetwork().mockRejectedValueOnce(new Error("PRIVATE_PROVIDER"))
      .mockResolvedValueOnce(new Response("PRIVATE_CREDENTIAL", { status: 200 }));
    const first = await researchPackagesClient.export(exportInput).catch(error => error);
    const second = await researchPackagesClient.status("job:1").catch(error => error);
    expect(researchPackageErrorMessage(first)).not.toContain("PRIVATE");
    expect(researchPackageErrorMessage(second)).not.toContain("PRIVATE");
    expect(researchPackageErrorMessage(new Error("PRIVATE_PROVIDER"))).not.toContain("PRIVATE");
    expect(researchPackageErrorMessage(new ResearchPackageRequestError(410))).toContain("expired");
  });
});

describe("research package client admission and response binding", () => {
  const blockedSourcePreview = (kind: ResearchPackagePreview["kind"] = "data_package"): ResearchPackagePreview => ({
    ...preview(), kind, counts: { records: 2400, files: 121, bytes: 128 * 1024 * 1024 }, archiveBytes: null, complete: false,
    warnings: ["package_budget_exceeded"], source: null, naming: null, targets: [],
    capabilities: { dataPackage: { available: false, reasons: ["package_budget_exceeded"] },
      report: { available: false, reasons: ["package_budget_exceeded"] } },
  });

  it.each(["data_package", "report"] as const)("returns exact blocked source counts for a %s plan without accepting saved work", async kind => {
    const value = blockedSourcePreview(kind); mockNetwork().mockResolvedValueOnce(json(value));
    const checked = await researchPackagesClient.plan({ kind, roots: exportInput.roots });
    expect(checked).toEqual(value); expect(checked.counts).toEqual({ records: 2400, files: 121, bytes: 134217728 });
    expect(checked.capabilities.dataPackage.available).toBe(false); expect(checked.capabilities.report.available).toBe(false);
    expect(network).toHaveBeenCalledOnce();
    expect(network.mock.calls[0]).toEqual([`${base}/plans`, expect.objectContaining({ method: "POST", body: JSON.stringify({ kind, roots: exportInput.roots }) })]);
    expect(network.mock.calls.some(([path]) => String(path) === `${base}/jobs` || String(path) === `${base}/imports`)).toBe(false);
  });

  it.each([
    ["an archive-backed preview", (value: ResearchPackagePreview) => { value.source = preview().source; }],
    ["data-package acceptance available", (value: ResearchPackagePreview) => { value.capabilities.dataPackage = { available: true, reasons: [] }; }],
    ["report acceptance available", (value: ResearchPackagePreview) => { value.capabilities.report = { available: true, reasons: [] }; }],
    ["missing data-package budget reason", (value: ResearchPackagePreview) => { value.capabilities.dataPackage.reasons = ["file_unavailable"]; }],
    ["missing report budget reason", (value: ResearchPackagePreview) => { value.capabilities.report.reasons = ["file_unavailable"]; }],
    ["an unsafe integer count", (value: ResearchPackagePreview) => { value.counts.records = Number.MAX_SAFE_INTEGER + 1; }],
    ["a negative count", (value: ResearchPackagePreview) => { value.counts.files = -1; }],
    ["a fractional count", (value: ResearchPackagePreview) => { value.counts.bytes = 1.5; }],
    ["more than 1200 dependencies", (value: ResearchPackagePreview) => { value.dependencies = Array.from({ length: RESEARCH_PACKAGE_MAX_RECORDS + 1 },
      (_, index) => ({ targetType: "sample", id: `sample:${index}`, outcome: "included", reason: null })); }],
  ])("rejects over-budget plans with %s without creating a job", async (_description, mutate) => {
    mockNetwork();
    for (const kind of ["data_package", "report"] as const) {
      const value = blockedSourcePreview(kind); mutate(value); network.mockResolvedValueOnce(json(value));
      await expect(researchPackagesClient.plan({ kind, roots: exportInput.roots })).rejects.toThrow();
    }
    expect(network).toHaveBeenCalledTimes(2);
    expect(network.mock.calls.every(([path, options]) => String(path) === `${base}/plans` && options?.method === "POST")).toBe(true);
  });

  it.each([
    ["different output kind", (value: ResearchPackagePreview) => { value.kind = "report"; }],
    ["different root", (value: ResearchPackagePreview) => { value.roots[0].id = "unselected"; }],
    ["missing root", (value: ResearchPackagePreview) => { value.roots.pop(); }],
    ["duplicate root", (value: ResearchPackagePreview) => { value.roots[1] = value.roots[0]; }],
    ["private metadata", (value: ResearchPackagePreview) => Object.assign(value, { credentials: "PRIVATE_SECRET" })],
    ["private target", (value: ResearchPackagePreview) => Object.assign(value.targets[0], { objectKey: "PRIVATE_KEY" })],
    ["wrong destination role", (value: ResearchPackagePreview) => { value.targets[0].role = "internal"; }],
    ["fractional count", (value: ResearchPackagePreview) => { value.counts.files = 0.5; }],
  ])("rejects %s before accepting a preview", async (_label, mutate) => {
    const value = preview(); mutate(value); mockNetwork().mockResolvedValue(json(value));
    await expect(researchPackagesClient.plan({ kind: exportInput.kind, roots: exportInput.roots })).rejects.toThrow();
    expect(network).toHaveBeenCalledOnce();
  });

  it("allows a server to reorder the same root set without changing output intent", async () => {
    const value = preview(); value.roots.reverse(); mockNetwork().mockResolvedValue(json(value));
    expect(await researchPackagesClient.plan({ kind: exportInput.kind, roots: exportInput.roots })).toEqual(value);
  });

  it("rejects wrong receipts, upload identity/kind and status/control identities", async () => {
    mockNetwork().mockResolvedValueOnce(json(receipt("different-request"))).mockResolvedValueOnce(json(receipt(exportInput.requestId, "report")))
      .mockResolvedValueOnce(json({ ...job("upload"), id: "wrong-job" })).mockResolvedValueOnce(json(job("import")))
      .mockResolvedValueOnce(json({ ...job(), id: "wrong-job" })).mockResolvedValueOnce(json({ ...job(), id: "wrong-job" }));
    await expect(researchPackagesClient.export(exportInput)).rejects.toThrow();
    await expect(researchPackagesClient.export(exportInput)).rejects.toThrow();
    await expect(researchPackagesClient.upload("job:1", new Blob(["zip"]))).rejects.toThrow();
    await expect(researchPackagesClient.upload("job:1", new Blob(["zip"]))).rejects.toThrow();
    await expect(researchPackagesClient.status("job:1")).rejects.toThrow();
    await expect(researchPackagesClient.control("job:1", "pause")).rejects.toThrow();
  });

  it("rejects missing and nonboolean receipt reuse flags while binding the outer request identity", async () => {
    const valid = receipt(importInput.requestId, "import"); const { reused: _reused, ...missing } = valid;
    for (const value of [missing, ...[undefined, null, 0, 1, "true"].map(reused => ({ ...valid, reused })),
      { ...valid, requestId: "different:request", reused: true }]) {
      mockNetwork().mockResolvedValueOnce(json(value));
      await expect(researchPackagesClient.import(importInput)).rejects.toThrow();
    }
    expect(network.mock.calls.every(([, options]) => options?.method === "POST")).toBe(true);
    mockNetwork().mockResolvedValueOnce(json({ ...receipt(exportInput.requestId), reused: true }));
    await expect(researchPackagesClient.export(exportInput)).rejects.toThrow();
  });

  it.each([
    { jobs: [job(), job()] }, { jobs: [job()], credentials: "PRIVATE_SECRET" },
    { jobs: [{ ...job(), objectKey: "PRIVATE_KEY" }] }, { jobs: "not-an-array" }, [],
    { jobs: Array.from({ length: 101 }, (_, index) => ({ ...job(), id: `job:${index}` })) },
  ])("rejects malformed, duplicate or privately extended job lists", async value => {
    mockNetwork().mockResolvedValue(json(value)); await expect(researchPackagesClient.list()).rejects.toThrow();
  });

  it.each([".", "..", "../private", "job/private", "job\\private", "bad id", "bad\njob"])(
    "rejects unsafe path identity %j before fetching or making a download URL", async id => {
      mockNetwork();
      await expect(researchPackagesClient.status(id)).rejects.toThrow();
      await expect(researchPackagesClient.readRequest(id)).rejects.toThrow();
      await expect(researchPackagesClient.preview(id)).rejects.toThrow();
      await expect(researchPackagesClient.control(id, "pause")).rejects.toThrow();
      await expect(researchPackagesClient.upload(id, new Blob(["zip"]))).rejects.toThrow();
      expect(() => researchPackagesClient.downloadUrl(id)).toThrow(); expect(network).not.toHaveBeenCalled();
    },
  );

  it("rejects oversized or empty raw files and invalid metadata before any provider request", async () => {
    mockNetwork(); const oversized = new Blob(["zip"]); Object.defineProperty(oversized, "size", { value: RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES + 1 });
    await expect(researchPackagesClient.upload("job:1", oversized)).rejects.toThrow(/size/);
    await expect(researchPackagesClient.upload("job:1", new Blob())).rejects.toThrow(/size/);
    await expect(researchPackagesClient.acceptUpload({ ...uploadInput, byteSize: RESEARCH_PACKAGE_MAX_ARCHIVE_BYTES + 1 })).rejects.toThrow();
    await expect(researchPackagesClient.acceptUpload({ ...uploadInput, sha256: "A".repeat(64) })).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });

  it("rejects unknown fields, duplicate selections, malformed naming and controls without a request", async () => {
    mockNetwork();
    await expect(researchPackagesClient.export({ ...exportInput, objectKey: "PRIVATE_KEY" } as never)).rejects.toThrow();
    await expect(researchPackagesClient.plan({ kind: "data_package", roots: [exportInput.roots[0], exportInput.roots[0]] })).rejects.toThrow();
    await expect(researchPackagesClient.plan({ kind: "data_package", roots: Array.from({ length: RESEARCH_PACKAGE_MAX_ROOTS + 1 }, (_, index) => ({ kind: "sample", id: `sample:${index}` })) })).rejects.toThrow();
    await expect(researchPackagesClient.import({ ...importInput, mergeExisting: true } as never)).rejects.toThrow();
    await expect(researchPackagesClient.import({ ...importInput, naming: { suffix: "x".repeat(33) } })).rejects.toThrow();
    await expect(researchPackagesClient.import({ ...importInput, expectedRolePolicyRevision: -1 })).rejects.toThrow();
    await expect(researchPackagesClient.import({ ...importInput, expectedRolePolicyRevision: null })).rejects.toThrow();
    const { expectedRolePolicyRevision: _revision, ...missingRevision } = importInput;
    await expect(researchPackagesClient.import(missingRevision as never)).rejects.toThrow();
    await expect(researchPackagesClient.preview("job:1", "bad\nname")).rejects.toThrow();
    await expect(researchPackagesClient.control("job:1", "execute_provider" as never)).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });
});

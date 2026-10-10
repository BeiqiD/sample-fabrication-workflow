import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_JOB_MAX_BYTES, type AcceptFileMigrationInput, type FileMigrationPlan, type FileJobStatus } from "../../shared/contracts/file-jobs";
import { fileJobsClient, FileMigrationRequestError, fileMigrationErrorMessage } from "./file-jobs-client";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const input: AcceptFileMigrationInput = { requestId: "acceptance-1", fileIds: ["file:2", "file:1"], target: { profileId: "destination", configurationRevision: 1 } };
const plan = (): FileMigrationPlan => ({ target: input.target, items: input.fileIds.map(fileId => ({ fileId, purpose: "research_source",
  sourceLocationId: `location:${fileId}`, sourceProfileId: "source", byteSize: 12, sha256: "a".repeat(64), status: "eligible" })),
  bytes: 24, retainedSourceBytes: 24, stagingBytes: 120, transferAndVerificationBytes: 72,
  maxTransferAndVerificationBytes: 360, maxAttemptsPerFile: 5, bytesVerified: false });
const job = (): FileJobStatus => ({ id: "job:1", actor: "admin@example.test", state: "queued", target: input.target,
  acceptedAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z", reason: null,
  moved: 0, remaining: 2, failed: 0, cleanupPending: 0 });
const executor = { enabled: true, stale: false, cadenceSeconds: 120, maxFilesPerStep: 1, maxStepMs: 60000, lastHeartbeatAt: "2026-10-05T00:00:00.000Z" };
const details = () => ({ items: [{ fileId: "file:1", purpose: "research_source", state: "copying", reason: "write_settlement_required",
  sourceLocationId: "location:1", sourceProfileId: "source", destinationLocationId: null, byteSize: 12, sha256: "a".repeat(64),
  attempt: { id: "attempt:1", state: "unknown", settled: false }, attemptState: "unknown", attemptCount: 1, maxAttempts: 5,
  artifactCleanupPending: 1, sourceCleanupPending: false, cleanupState: "not_requested",
  cleanup: { requestedAt: null, notBefore: null, releasedToGcAt: null, deleted: false } }], hasMore: false });
afterEach(() => vi.unstubAllGlobals());

describe("File migration client", () => {
  it("reads durable jobs, inventory, heartbeat and exact item details privately without executing them", async () => {
    const network = vi.fn().mockResolvedValueOnce(json({ jobs: [job()] })).mockResolvedValueOnce(json({ items: [{ fileId: "file:1", purpose: "research_source",
      byteSize: 12, sha256: "a".repeat(64), profileId: "source", locationId: "location:1" }], nextCursor: null }))
      .mockResolvedValueOnce(json(executor)).mockResolvedValueOnce(json(details()));
    vi.stubGlobal("fetch", network); const controller = new AbortController();
    expect(await fileJobsClient.list(controller.signal)).toEqual([job()]);
    expect(await fileJobsClient.inventory("file:0", controller.signal)).toMatchObject({ nextCursor: null });
    expect(await fileJobsClient.executor(controller.signal)).toEqual(executor);
    expect(await fileJobsClient.items("job:1", controller.signal)).toEqual(details());
    expect(network.mock.calls.map(([path]) => path)).toEqual(["/api/files/migrations", "/api/files/migrations/files?cursor=file%3A0",
      "/api/files/migrations/executor", "/api/files/migrations/job%3A1/items"]);
    for (const [, options] of network.mock.calls) expect(options).toEqual({ method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal });
  });

  it("submits canonical bounded selections and explicit controls with the caller's original request identity", async () => {
    const network = vi.fn().mockResolvedValueOnce(json(plan())).mockResolvedValueOnce(json(job(), 202))
      .mockResolvedValueOnce(json({ ...job(), state: "cancelled" })).mockResolvedValueOnce(json({ ...job(), state: "cancelled" }))
      .mockResolvedValueOnce(json({ ...executor, enabled: false }));
    vi.stubGlobal("fetch", network);
    expect(await fileJobsClient.plan(input)).toEqual(plan()); await fileJobsClient.accept(input);
    await fileJobsClient.control("job:1", "cancel"); await fileJobsClient.control("job:1", "cleanup"); await fileJobsClient.setExecutor(false);
    expect(network.mock.calls.map(([path]) => path)).toEqual(["/api/files/migrations/plans", "/api/files/migrations",
      "/api/files/migrations/job%3A1/cancel", "/api/files/migrations/job%3A1/cleanup", "/api/files/migrations/executor"]);
    expect(JSON.parse(network.mock.calls[1][1].body)).toEqual({ ...input, fileIds: ["file:1", "file:2"] });
    expect(network.mock.calls[2][1]).toMatchObject({ method: "POST", body: "{}", credentials: "same-origin", cache: "no-store", redirect: "error" });
    expect(network.mock.calls[4][1].body).toBe('{"enabled":false}');
  });

  it.each([
    ["duplicate selected File", (value: FileMigrationPlan) => { value.items[1] = value.items[0]; }],
    ["another File", (value: FileMigrationPlan) => { value.items[1].fileId = "unselected"; }],
    ["another target revision", (value: FileMigrationPlan) => { value.target = { ...value.target, configurationRevision: 2 }; }],
    ["invalid hash", (value: FileMigrationPlan) => { value.items[0].sha256 = "a"; }],
    ["invalid purpose", (value: FileMigrationPlan) => { value.items[0].purpose = "private-purpose" as never; }],
    ["missing source", (value: FileMigrationPlan) => { value.items[0].sourceLocationId = ""; }],
    ["fractional size", (value: FileMigrationPlan) => { value.items[0].byteSize = 1.2; }],
    ["incorrect total", (value: FileMigrationPlan) => { value.bytes = 25; }],
    ["incorrect transfer estimate", (value: FileMigrationPlan) => { value.transferAndVerificationBytes = 24; }],
    ["incorrect retry bound", (value: FileMigrationPlan) => { value.maxTransferAndVerificationBytes = 72; }],
    ["already verified metadata", (value: FileMigrationPlan) => { value.bytesVerified = true as never; }],
    ["same destination labelled eligible", (value: FileMigrationPlan) => { value.items[0].sourceProfileId = "destination"; }],
    ["private response field", (value: FileMigrationPlan) => { Object.assign(value.items[0], { objectKey: "private-key" }); }],
  ])("rejects %s before a plan can be accepted", async (_label, mutate) => {
    const value = plan(); mutate(value); const network = vi.fn().mockResolvedValue(json(value)); vi.stubGlobal("fetch", network);
    await expect(fileJobsClient.plan(input)).rejects.toThrow(); expect(network).toHaveBeenCalledOnce();
  });

  it("accurately accepts blocked same-profile and size plans without treating metadata as verified bytes", async () => {
    const value = plan(); value.items[0].sourceProfileId = "destination"; value.items[0].status = "same_profile";
    value.items[1].byteSize = FILE_JOB_MAX_BYTES + 1; value.items[1].status = "unsupported_size";
    value.bytes = value.retainedSourceBytes = value.items[0].byteSize + value.items[1].byteSize;
    value.stagingBytes = value.bytes * 5; value.maxTransferAndVerificationBytes = value.bytes * 15;
    value.transferAndVerificationBytes = value.bytes * 3;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(value))); expect(await fileJobsClient.plan(input)).toEqual(value);
  });

  it("rejects private fields, impossible counts and inconsistent details instead of rendering untrusted state", async () => {
    const invalidDetails = details(); invalidDetails.items[0].attemptState = "published";
    const network = vi.fn().mockResolvedValueOnce(json({ jobs: [{ ...job(), moved: 99, remaining: 2 }] }))
      .mockResolvedValueOnce(json({ ...executor, credentialEnvelope: "private" })).mockResolvedValueOnce(json(invalidDetails))
      .mockResolvedValueOnce(json({ items: [details().items[0], details().items[0]], hasMore: false }))
      .mockResolvedValueOnce(json({ items: [{ fileId: "file:1", purpose: "research_source", byteSize: 12, sha256: "a".repeat(64),
        profileId: "source", locationId: "location:1", objectKey: "private" }], nextCursor: null }));
    vi.stubGlobal("fetch", network);
    await expect(fileJobsClient.list()).rejects.toThrow(); await expect(fileJobsClient.executor()).rejects.toThrow();
    await expect(fileJobsClient.items("job:1")).rejects.toThrow(); await expect(fileJobsClient.items("job:1")).rejects.toThrow();
    await expect(fileJobsClient.inventory()).rejects.toThrow();
  });

  it("rejects an acceptance or control response bound to a different target or job", async () => {
    const network = vi.fn().mockResolvedValueOnce(json({ ...job(), target: { ...input.target, profileId: "other" } }))
      .mockResolvedValueOnce(json({ ...job(), id: "other" })); vi.stubGlobal("fetch", network);
    await expect(fileJobsClient.accept(input)).rejects.toThrow("Invalid File migration acceptance.");
    await expect(fileJobsClient.control("job:1", "pause")).rejects.toThrow("Invalid File job control response.");
  });

  it("keeps physical artifact cleanup distinct from retained or already deleted source copies", async () => {
    const pending = details(); Object.assign(pending.items[0], { sourceCleanupPending: false, cleanupState: "pending",
      cleanup: { requestedAt: job().acceptedAt, notBefore: job().acceptedAt, releasedToGcAt: null, deleted: true } });
    const completed = details(); Object.assign(completed.items[0], { artifactCleanupPending: 0, cleanupState: "complete",
      cleanup: { requestedAt: job().acceptedAt, notBefore: job().acceptedAt, releasedToGcAt: null, deleted: false } });
    const network = vi.fn().mockResolvedValueOnce(json(pending)).mockResolvedValueOnce(json(completed)); vi.stubGlobal("fetch", network);
    expect(await fileJobsClient.items("job:1")).toEqual(pending); expect(await fileJobsClient.items("job:1")).toEqual(completed);
  });

  it("rejects cleanup counts beyond registered attempts and contradictory completed cleanup", async () => {
    const impossible = details(); impossible.items[0].artifactCleanupPending = 2;
    const unfinished = details(); unfinished.items[0].cleanupState = "complete";
    const network = vi.fn().mockResolvedValueOnce(json(impossible)).mockResolvedValueOnce(json(unfinished)); vi.stubGlobal("fetch", network);
    await expect(fileJobsClient.items("job:1")).rejects.toThrow(); await expect(fileJobsClient.items("job:1")).rejects.toThrow();
  });

  it("does not parse private server errors or automatically replay an uncertain acceptance", async () => {
    const response = json({ error: "private-provider-error" }, 503), parse = vi.spyOn(response, "json");
    const network = vi.fn().mockResolvedValueOnce(response).mockRejectedValueOnce(new Error("private-credential-detail")); vi.stubGlobal("fetch", network);
    await expect(fileJobsClient.accept(input)).rejects.toMatchObject({ status: 503 }); expect(parse).not.toHaveBeenCalled();
    await expect(fileJobsClient.accept(input)).rejects.toMatchObject({ status: null }); expect(network).toHaveBeenCalledTimes(2);
    expect(fileMigrationErrorMessage(new Error("private-provider-error"))).not.toContain("private");
    expect(fileMigrationErrorMessage(new FileMigrationRequestError(403))).toContain("System administrator access");
  });

  it("rejects invalid selection, control and pagination inputs without a request", async () => {
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    await expect(fileJobsClient.accept({ ...input, fileIds: ["duplicate", "duplicate"] })).rejects.toThrow();
    await expect(fileJobsClient.plan({ ...input, fileIds: Array.from({ length: 101 }, (_, i) => `file:${i}`) })).rejects.toThrow();
    await expect(fileJobsClient.inventory("bad\n" )).rejects.toThrow(); await expect(fileJobsClient.control("", "pause")).rejects.toThrow();
    await expect(fileJobsClient.setExecutor("true" as never)).rejects.toThrow(); expect(network).not.toHaveBeenCalled();
  });
});

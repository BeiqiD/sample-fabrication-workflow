import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalCommentAcceptanceInput, type AcceptedCommentSubmissionInput, type CommentAcceptanceState } from "../../shared/contracts/comment-acceptance";
import { cancelDurableCommentSubmission, createDurableCommentSubmission, discardLocalCommentSubmission, finalizeDurableCommentSubmission, finishCommentSubmission, getCommentAcceptance, prepareDurableCommentSubmission, removeDurableCommentItem, savedCommentSubmissions, uploadDurableCommentItem } from "./comment-submission-client";
function storage() { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size; } }; }
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
function input(binary = false): AcceptedCommentSubmissionInput { return { protocol: "comment-submission/1", id: crypto.randomUUID(), body: "Frozen comment", context: { kind: "sample", sampleId: "sample-a", expectedUpdatedAt: "2026-09-14T00:00:00.000Z" }, items: binary ? [{ id: crypto.randomUUID(), kind: "attachment", filename: "manual.bin", mimeType: "application/octet-stream", byteSize: 4, sha256: createHash("sha256").update("data").digest("hex") }] : [] }; }
async function state(input: AcceptedCommentSubmissionInput, status: CommentAcceptanceState["status"] = "pending", itemStatus: CommentAcceptanceState["items"][number]["status"] = "pending") {
  const canonical = await canonicalCommentAcceptanceInput(input);
  return { request: { submissionId: input.id, inputSha256: canonical.sha256, input: canonical.input, expiresAt: "2099-01-01T00:00:00.000Z", status,
    items: input.items.map((item) => ({ id: item.id, kind: item.kind, sha256: item.kind === "link" ? null : item.sha256!, status: itemStatus })),
    ...(status === "ready" ? { result: { submissionId: input.id, completedAt: "2026-09-14T00:00:00.000Z", occurrenceIds: [], eventIds: ["11111111-1111-4111-8111-111111111111"], itemIds: input.items.map((item) => item.id) } } : {}),
  } };
}
let saved: ReturnType<typeof storage>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let xhrs: FakeXHR[];
let uploadResponse: { payload?: unknown; lost?: boolean };
class FakeXHR extends EventTarget {
  upload = new EventTarget(); status = 200; responseText = ""; headers: Record<string, string> = {}; body: unknown; path = "";
  open(_method: string, path: string) { this.path = path; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(body: unknown) { this.body = body; xhrs.push(this); queueMicrotask(() => { if (uploadResponse.lost) this.dispatchEvent(new Event("error")); else { this.responseText = JSON.stringify(uploadResponse.payload); this.dispatchEvent(new Event("load")); } }); }
  abort() { this.dispatchEvent(new Event("abort")); }
}
beforeEach(() => { saved = storage(); fetchMock = vi.fn<typeof fetch>(); xhrs = []; uploadResponse = {}; vi.stubGlobal("sessionStorage", saved); vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("XMLHttpRequest", FakeXHR); });
afterEach(() => vi.unstubAllGlobals());
describe("durable Comment client", () => {
  it("freezes protocol, text, item SHA and target revision in durable storage before create", async () => {
    const source = input(true); let observed: unknown;
    const prepared = await prepareDurableCommentSubmission(source, "source-a");
    source.body = "Edited later"; source.context.expectedUpdatedAt = "changed";
    fetchMock.mockImplementationOnce(async (_path, init) => { observed = JSON.parse(saved.getItem(saved.key(0)!)!); return json(await state(JSON.parse(String(init?.body)))); });
    await createDurableCommentSubmission(prepared);
    expect(observed).toMatchObject({ sourceKey: "source-a", attempted: true, observedReady: false, input: { body: "Frozen comment", protocol: "comment-submission/1", items: [{ sha256: createHash("sha256").update("data").digest("hex") }], context: { expectedUpdatedAt: "2026-09-14T00:00:00.000Z" } } });
    expect(savedCommentSubmissions("source-a")).toEqual([prepared]); expect(savedCommentSubmissions("source-b")).toEqual([]);
    await expect(createDurableCommentSubmission(source)).rejects.toThrow("cannot be changed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("checks a lost create response without creating again and permits only exact input after a missing receipt", async () => {
    const source = input(); fetchMock.mockRejectedValueOnce(new Error("lost"));
    await expect(createDurableCommentSubmission(source)).rejects.toThrow("response was lost");
    fetchMock.mockResolvedValueOnce(json(await state(source)));
    await createDurableCommentSubmission(source);
    expect(fetchMock.mock.calls[1]).toEqual([`/api/comment-submissions/${source.id}/acceptance`, { cache: "no-store" }]);
    fetchMock.mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(json(await state(source)));
    await createDurableCommentSubmission(source);
    expect(fetchMock.mock.calls[3][1]?.body).toBe(fetchMock.mock.calls[0][1]?.body);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });
  it("never recreates a ready comment after reload or a missing status", async () => {
    const source = input(); fetchMock.mockResolvedValueOnce(json(await state(source, "ready")));
    await createDurableCommentSubmission(source);
    expect(JSON.parse(saved.getItem(saved.key(0)!)!).observedReady).toBe(true);
    fetchMock.mockResolvedValueOnce(json({}, 404));
    await expect(createDurableCommentSubmission(JSON.parse(JSON.stringify(source)))).rejects.toThrow("will not be submitted again");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("uploads only pending bytes, then reconciles a lost PUT using GET without claiming a second owner", async () => {
    const source = input(true); const item = source.items[0]; const file = new File(["data"], "manual.bin", { type: "application/octet-stream" });
    fetchMock.mockResolvedValueOnce(json(await state(source))); uploadResponse = { lost: true };
    await expect(uploadDurableCommentItem(source.id, item.id, file, item.sha256!, vi.fn())).rejects.toThrow("response was lost");
    fetchMock.mockResolvedValueOnce(json(await state(source, "pending", "uploading")));
    await expect(uploadDurableCommentItem(source.id, item.id, file, item.sha256!, vi.fn())).rejects.toThrow("still processing");
    fetchMock.mockResolvedValueOnce(json(await state(source, "pending", "ready")));
    await expect(uploadDurableCommentItem(source.id, item.id, file, item.sha256!, vi.fn())).resolves.toEqual({ ok: true, deduplicated: true });
    expect(xhrs).toHaveLength(1); expect(xhrs[0].body).toBe(file); expect(xhrs[0].headers["x-content-sha256"]).toBe(item.sha256);
  });
  it("rejects altered prepared bytes before PUT and blocks upload after an unresolved remove", async () => {
    const source = input(true); const item = source.items[0]; const file = new File(["data"], "manual.bin", { type: "application/octet-stream" });
    await prepareDurableCommentSubmission(source);
    await expect(uploadDurableCommentItem(source.id, item.id, file, "b".repeat(64), vi.fn())).rejects.toThrow("same unchanged file");
    fetchMock.mockResolvedValueOnce(json(await state(source))).mockRejectedValueOnce(new Error("lost remove"));
    await expect(removeDurableCommentItem(source.id, item.id)).rejects.toThrow("response was lost");
    fetchMock.mockResolvedValueOnce(json(await state(source)));
    await expect(uploadDurableCommentItem(source.id, item.id, file, item.sha256!, vi.fn())).rejects.toThrow("Removal or cancellation");
    fetchMock.mockResolvedValueOnce(json(await state(source, "pending", "cancelled")));
    await removeDurableCommentItem(source.id, item.id);
    expect(xhrs).toHaveLength(0); expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });
  it("recovers lost finalization with GET and retains tracking until the parent refresh succeeds", async () => {
    const source = input(); await prepareDurableCommentSubmission(source);
    fetchMock.mockResolvedValueOnce(json(await state(source))).mockRejectedValueOnce(new Error("lost finalize"));
    await expect(finalizeDurableCommentSubmission(source.id)).rejects.toThrow("response was lost");
    fetchMock.mockResolvedValueOnce(json(await state(source, "ready")));
    await expect(finalizeDurableCommentSubmission(source.id)).resolves.toEqual({ ok: true, status: "ready" });
    expect(saved.length).toBe(1); expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    finishCommentSubmission(source.id); expect(saved.length).toBe(0);
  });
  it("retains cancel intent after a lost response and checks the cancelled result without cancelling twice", async () => {
    const source = input(); await prepareDurableCommentSubmission(source);
    fetchMock.mockResolvedValueOnce(json(await state(source))).mockRejectedValueOnce(new Error("lost cancel"));
    await expect(cancelDurableCommentSubmission(source.id)).rejects.toThrow("response was lost");
    fetchMock.mockResolvedValueOnce(json(await state(source)));
    await expect(createDurableCommentSubmission(source)).rejects.toThrow("Cancellation is unresolved");
    fetchMock.mockResolvedValueOnce(json(await state(source, "cancelled")));
    await expect(cancelDurableCommentSubmission(source.id)).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("confirms the original create identity before fencing cancellation of an unknown create", async () => {
    const source = input(); await prepareDurableCommentSubmission(source);
    fetchMock.mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(json(await state(source))).mockResolvedValueOnce(json(await state(source, "cancelled")));
    await cancelDurableCommentSubmission(source.id);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([`/api/comment-submissions/${source.id}/acceptance`, "/api/comment-submissions", `/api/comment-submissions/${source.id}/cancel`]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual(source);
  });
  it("blocks legacy upload while permitting explicit cancellation", async () => {
    const source = input(true); const legacy = { request: { submissionId: source.id, inputSha256: null, input: null, expiresAt: null, items: [], status: "legacy" } };
    fetchMock.mockResolvedValueOnce(json(legacy));
    await expect(uploadDurableCommentItem(source.id, source.items[0].id, new File(["data"], "manual.bin"), createHash("sha256").update("data").digest("hex"), vi.fn())).rejects.toThrow("older unfinished comment");
    const cancelled = { request: { ...legacy.request, status: "cancelled" } };
    fetchMock.mockResolvedValueOnce(json(legacy)).mockRejectedValueOnce(new Error("lost legacy cancel"));
    await expect(cancelDurableCommentSubmission(source.id)).rejects.toThrow("response was lost");
    fetchMock.mockResolvedValueOnce(json(cancelled));
    await expect(cancelDurableCommentSubmission(source.id)).resolves.toEqual({ ok: true }); expect(xhrs).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("fences finalization behind unresolved removal and cancellation intent", async () => {
    for (const intent of ["remove", "cancel"]) {
      const source = input(true); await prepareDurableCommentSubmission(source);
      fetchMock.mockResolvedValueOnce(json(await state(source, "pending", "ready"))).mockRejectedValueOnce(new Error("lost action"));
      await expect(intent === "remove" ? removeDurableCommentItem(source.id, source.items[0].id) : cancelDurableCommentSubmission(source.id)).rejects.toThrow();
      fetchMock.mockResolvedValueOnce(json(await state(source, "pending", "ready")));
      await expect(finalizeDurableCommentSubmission(source.id)).rejects.toThrow("Removal or cancellation is unresolved");
    }
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith("/finalize"))).toBe(false);
  });
  it("rejects a regressed pending state after publication without mutating", async () => {
    const source = input(true); fetchMock.mockResolvedValueOnce(json(await state(source, "ready", "ready")));
    await createDurableCommentSubmission(source);
    fetchMock.mockResolvedValueOnce(json(await state(source)));
    await expect(finalizeDurableCommentSubmission(source.id)).rejects.toThrow("already published");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("rejects a concurrent changed File even when it claims the original checksum", async () => {
    const source = input(true); const sha = source.items[0].sha256!;
    fetchMock.mockResolvedValueOnce(json(await state(source, "pending", "ready")));
    const outcomes = await Promise.allSettled([
      uploadDurableCommentItem(source.id, source.items[0].id, new File(["data"], "manual.bin", { type: "application/octet-stream" }), sha, vi.fn()),
      uploadDurableCommentItem(source.id, source.items[0].id, new File(["evil"], "manual.bin", { type: "application/octet-stream" }), sha, vi.fn()),
    ]);
    expect(outcomes.map((value) => value.status)).toEqual(["fulfilled", "rejected"]); expect(xhrs).toHaveLength(0);
  });
  it("fails closed on unverifiable status, unavailable storage, and missing browser cryptography", async () => {
    const source = input(); const wrong = await state(source); wrong.request.inputSha256 = "f".repeat(64);
    fetchMock.mockResolvedValueOnce(json(wrong)); await expect(getCommentAcceptance(source.id)).rejects.toThrow("could not be verified");
    fetchMock.mockClear(); vi.stubGlobal("sessionStorage", { ...saved, setItem: () => { throw new Error("full"); } });
    await expect(createDurableCommentSubmission(source)).rejects.toThrow("could not be saved"); expect(fetchMock).not.toHaveBeenCalled();
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    await expect(createDurableCommentSubmission(source)).rejects.toThrow("secure HTTPS connection");
  });
  it("does not silently coalesce different concurrent requests sharing an ID", async () => {
    const source = input(); fetchMock.mockImplementation(async () => json(await state(source)));
    const outcomes = await Promise.allSettled([createDurableCommentSubmission(source), createDurableCommentSubmission({ ...source, body: "different" })]);
    expect(outcomes.map((value) => value.status)).toEqual(["fulfilled", "rejected"]); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("keeps an old identity fenced after explicit local discard", async () => {
    const source = input(); await prepareDurableCommentSubmission(source);
    fetchMock.mockResolvedValueOnce(json(await state(source))).mockRejectedValueOnce(new Error("cancel lost"));
    await expect(cancelDurableCommentSubmission(source.id)).rejects.toThrow();
    discardLocalCommentSubmission(source.id); expect(saved.length).toBe(0);
    const calls = fetchMock.mock.calls.length;
    await expect(createDurableCommentSubmission(source)).rejects.toThrow("was discarded");
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

});

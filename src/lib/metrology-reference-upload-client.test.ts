import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discardMetrologyReferenceUpload, finishMetrologyReferenceUpload, uploadMetrologyReference } from "./metrology-reference-upload-client";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size; } };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const file = (contents = "reference bytes", name = "参考手册 α.pdf") => new File([contents], name, { type: "application/pdf" });
const reference = (selected: File) => ({ id: "reference-id", assetKey: "references/asset.pdf", filename: selected.name, mimeType: selected.type, byteSize: selected.size, createdAt: "2026-09-14T00:00:00.000Z" });
let saved: ReturnType<typeof storage>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let sequence = 0;
const template = () => `metrology-${++sequence}`;
const requestId = (index = 0) => new Headers(fetchMock.mock.calls[index][1]?.headers).get("X-Upload-Request-Id")!;
const state = (templateId: string, id: string, selected: File, status = "ready") => ({ request: {
  requestId: id, templateId, expiresAt: "2099-01-01T00:00:00.000Z", status,
  ...(status === "ready" ? { result: { assetId: "asset-id", deduplicated: false, reference: reference(selected) } } : {}),
} });
const readyPost = (templateId: string, selected: File) => fetchMock.mockImplementationOnce(async (_path, init) => json(state(templateId, new Headers(init?.headers).get("X-Upload-Request-Id")!, selected), 201));
beforeEach(() => { saved = storage(); fetchMock = vi.fn<typeof fetch>(); vi.stubGlobal("sessionStorage", saved); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("durable metrology reference upload client", () => {
  it("persists metadata before POST, transports Unicode safely, and retains ready tracking until the page refresh finishes", async () => {
    const id = template(); const selected = file(); let savedBeforePost: unknown;
    fetchMock.mockImplementationOnce(async (_path, init) => {
      savedBeforePost = JSON.parse(saved.getItem(saved.key(0)!)!);
      return json(state(id, new Headers(init?.headers).get("X-Upload-Request-Id")!, selected), 201);
    });
    const result = await uploadMetrologyReference(id, selected);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/metrology-templates/${id}/references`);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", body: selected, headers: { "X-Filename-Uri": encodeURIComponent(selected.name), "content-type": selected.type } });
    expect(savedBeforePost).toMatchObject({ version: 1, templateId: id, requestId: result.requestId, observedReady: false, filename: selected.name, byteSize: selected.size, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(Object.keys(savedBeforePost as object).sort()).toEqual(["byteSize", "filename", "mimeType", "observedReady", "requestId", "sha256", "templateId", "version"]);
    expect(JSON.parse(saved.getItem(saved.key(0)!)!).observedReady).toBe(true);
    finishMetrologyReferenceUpload(id, "an-older-request");
    expect(saved.length).toBe(1);
    finishMetrologyReferenceUpload(id, result.requestId);
    expect(saved.length).toBe(0);
  });

  it("accepts the frozen filename and MIME type of a reused reference with identical bytes", async () => {
    const id = template(); const selected = file();
    const reused = { ...reference(selected), filename: "earlier-manual.bin", mimeType: "application/octet-stream" };
    fetchMock.mockImplementationOnce(async (_path, init) => {
      const payload = state(id, new Headers(init?.headers).get("X-Upload-Request-Id")!, selected);
      payload.request.result!.deduplicated = true; payload.request.result!.reference = reused;
      return json(payload, 200);
    });
    await expect(uploadMetrologyReference(id, selected)).resolves.toMatchObject({ reference: reused });
  });

  it("reconciles a lost POST through GET and preserves exact UUID and bytes when status is absent", async () => {
    const id = template(); const selected = file();
    fetchMock.mockRejectedValueOnce(new Error("lost acknowledgement"));
    await expect(uploadMetrologyReference(id, selected)).rejects.toThrow("response was lost");
    const uuid = requestId();
    fetchMock.mockResolvedValueOnce(json({}, 404)); readyPost(id, selected);
    await expect(uploadMetrologyReference(id, selected)).resolves.toEqual({ requestId: uuid, reference: reference(selected) });
    expect(fetchMock.mock.calls[1]).toEqual([`/api/metrology-templates/${id}/reference-upload-requests/${uuid}`, { cache: "no-store" }]);
    expect(requestId(2)).toBe(uuid);
    expect(fetchMock.mock.calls[2][1]?.body).toBe(selected);
  });

  it("restores a request after file re-selection and never uploads pending work again", async () => {
    const id = template(); const selected = file();
    fetchMock.mockImplementationOnce(async (_path, init) => json(state(id, new Headers(init?.headers).get("X-Upload-Request-Id")!, selected, "pending"), 202));
    await expect(uploadMetrologyReference(id, selected)).rejects.toThrow("still processing");
    const uuid = requestId();
    fetchMock.mockResolvedValueOnce(json(state(id, uuid, selected, "pending")));
    await expect(uploadMetrologyReference(id, file())).rejects.toThrow("still processing");
    fetchMock.mockResolvedValueOnce(json(state(id, uuid, selected)));
    await expect(uploadMetrologyReference(id, file())).resolves.toMatchObject({ requestId: uuid });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("does not re-publish an observed ready receipt after refresh failure, reload, and a missing status", async () => {
    const id = template(); const selected = file(); readyPost(id, selected);
    await uploadMetrologyReference(id, selected);
    fetchMock.mockResolvedValueOnce(json({}, 404));
    await expect(uploadMetrologyReference(id, selected)).rejects.toThrow("will not be uploaded again");
    fetchMock.mockResolvedValueOnce(json({}, 404));
    await expect(uploadMetrologyReference(id, file())).rejects.toThrow("will not be uploaded again");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(JSON.parse(saved.getItem(saved.key(0)!)!).observedReady).toBe(true);
  });

  it.each([file("changed bytes"), file("reference bytes", "renamed.pdf")])("refuses replacement input until explicit discard", async (replacement) => {
    const id = template(); const selected = file(); fetchMock.mockRejectedValueOnce(new Error("lost"));
    await expect(uploadMetrologyReference(id, selected)).rejects.toThrow();
    const oldId = requestId();
    await expect(uploadMetrologyReference(id, replacement)).rejects.toThrow("Reselect its original file");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    discardMetrologyReferenceUpload(id); readyPost(id, replacement);
    await uploadMetrologyReference(id, replacement);
    expect(requestId(1)).not.toBe(oldId);
  });

  it.each(["failed", "expired", "unavailable"])("keeps a terminal %s receipt until discard", async (status) => {
    const id = template(); const selected = file();
    fetchMock.mockImplementationOnce(async (_path, init) => json(state(id, new Headers(init?.headers).get("X-Upload-Request-Id")!, selected, status), 409));
    await expect(uploadMetrologyReference(id, selected)).rejects.toMatchObject({ terminal: true });
    expect(saved.length).toBe(1);
    await expect(uploadMetrologyReference(id, selected)).rejects.toMatchObject({ terminal: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["wrong-request", "wrong-template", "bad-reference", "bad-expiry"])("rejects %s status without losing tracking", async (fault) => {
    const id = template(); const selected = file(); fetchMock.mockRejectedValueOnce(new Error("lost"));
    await expect(uploadMetrologyReference(id, selected)).rejects.toThrow();
    const invalid = state(id, requestId(), selected);
    if (fault === "wrong-request") invalid.request.requestId = "another-request";
    if (fault === "wrong-template") invalid.request.templateId = "another-template";
    if (fault === "bad-reference") invalid.request.result!.reference.byteSize += 1;
    if (fault === "bad-expiry") invalid.request.expiresAt = "invalid-date";
    fetchMock.mockResolvedValueOnce(json(invalid));
    await expect(uploadMetrologyReference(id, selected)).rejects.toThrow("could not be verified");
    expect(saved.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps transport and authorization failures uncertain without POST", async () => {
    const id = template(); const selected = file(); fetchMock.mockRejectedValueOnce(new Error("lost"));
    await expect(uploadMetrologyReference(id, selected)).rejects.toThrow();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(uploadMetrologyReference(id, selected)).rejects.toThrow("could not be checked");
    fetchMock.mockResolvedValueOnce(json({ error: "not authenticated" }, 403));
    await expect(uploadMetrologyReference(id, selected)).rejects.toThrow("could not be checked");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("accepts the 25 MiB boundary and rejects empty or oversized files before fetching", async () => {
    const id = template(); const selected = new File([new Uint8Array(25 * 1024 * 1024)], "large.pdf", { type: "application/pdf" });
    readyPost(id, selected); await uploadMetrologyReference(id, selected);
    expect(fetchMock.mock.calls[0][1]?.body).toBe(selected);
    fetchMock.mockClear();
    for (const size of [0, 25 * 1024 * 1024 + 1]) {
      const invalid = new File([new Uint8Array(size)], "invalid.pdf", { type: "application/pdf" });
      await expect(uploadMetrologyReference(template(), invalid)).rejects.toThrow("no larger than 25 MB");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires durable browser storage before sending bytes", async () => {
    vi.stubGlobal("sessionStorage", { ...saved, setItem: () => { throw new Error("full"); } });
    await expect(uploadMetrologyReference(template(), file())).rejects.toThrow("could not save");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shares concurrent same-file submissions and blocks replacement of an uncertain request", async () => {
    const id = template(); const selected = file(); readyPost(id, selected);
    const answers = await Promise.all([uploadMetrologyReference(id, selected), uploadMetrologyReference(id, selected)]);
    expect(answers[0]).toEqual(answers[1]); expect(fetchMock).toHaveBeenCalledTimes(1);
    const otherId = template(); fetchMock.mockRejectedValueOnce(new Error("lost"));
    const outcomes = await Promise.allSettled([uploadMetrologyReference(otherId, selected), uploadMetrologyReference(otherId, file("replacement"))]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

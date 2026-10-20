import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discardR2Upload, prepareR2UploadFile, R2UploadRequestError, uploadR2Asset } from "./r2-upload-client";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size; } };
}
const result = { id: "asset-result", key: "uploads/result", deduplicated: false };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const image = (value = "image", name = "image.png") => new File([value], name, { type: "image/png" });
let saved: ReturnType<typeof storage>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let contextSequence = 0;
const context = () => ({ context: `test-${++contextSequence}` });
const requestId = (index = 0) => (fetchMock.mock.calls[index][1]?.headers as Record<string, string>)["X-Upload-Request-Id"];
const state = (id: string, status = "ready", ingress = "ordinary_image") => ({ requestId: id, ingress, expiresAt: "2099-01-01T00:00:00.000Z", status, ...(status === "ready" ? { result } : {}) });
beforeEach(() => { saved = storage(); fetchMock = vi.fn<typeof fetch>(); vi.stubGlobal("sessionStorage", saved); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("durable R2 upload client", () => {
  it("persists only bounded metadata before POST and sends the exact original body", async () => {
    const file = image();
    fetchMock.mockImplementation(async (_url, init) => {
      expect(saved.length).toBe(1);
      const checkpoint = JSON.parse(saved.getItem(saved.key(0)!)!);
      expect(checkpoint).toMatchObject({ filename: file.name, mimeType: file.type, byteSize: file.size });
      expect(checkpoint.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.keys(checkpoint).sort()).toEqual(["byteSize", "filename", "ingress", "mimeType", "observedReady", "requestId", "sha256", "version"]);
      expect(init?.body).toBe(file);
      return json(result, 201);
    });
    expect(await uploadR2Asset(file, file.name, "ordinary_image", context())).toEqual(result);
    expect(requestId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.length).toBe(0);
  });

  it("reconciles a lost successful POST through GET without uploading again", async () => {
    const file = image(); const options = context();
    fetchMock.mockRejectedValueOnce(new Error("response lost"));
    await expect(uploadR2Asset(file, file.name, "ordinary_image", options)).rejects.toThrow("response was lost");
    const id = requestId();
    fetchMock.mockResolvedValueOnce(json(state(id)));
    expect(await uploadR2Asset(file, file.name, "ordinary_image", options)).toEqual(result);
    expect(fetchMock.mock.calls[1]).toEqual([`/api/r2-upload-requests/${id}`, { cache: "no-store" }]);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(saved.length).toBe(0);
  });

  it("keeps the same UUID and body when a 404 races the original POST", async () => {
    const file = image(); const options = context();
    fetchMock.mockRejectedValueOnce(new Error("lost"));
    await expect(uploadR2Asset(file, file.name, "ordinary_image", options)).rejects.toThrow();
    const id = requestId();
    fetchMock.mockResolvedValueOnce(json({ error: "absent" }, 404)).mockResolvedValueOnce(json(result));
    await uploadR2Asset(file, file.name, "ordinary_image", options);
    expect(requestId(2)).toBe(id);
    expect(fetchMock.mock.calls[2][1]?.body).toBe(file);
  });

  it("observes pending POST and GET responses without replaying unfinished work", async () => {
    const file = image(); const options = context();
    fetchMock.mockImplementationOnce(async (_url, init) => json(state((init?.headers as Record<string, string>)["X-Upload-Request-Id"], "pending"), 202));
    await expect(uploadR2Asset(file, file.name, "ordinary_image", options)).rejects.toThrow("still processing");
    fetchMock.mockResolvedValueOnce(json(state(requestId(), "pending")));
    await expect(uploadR2Asset(file, file.name, "ordinary_image", options)).rejects.toThrow("still processing");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(saved.length).toBe(1);
  });

  it("restores the request ID when the original file is reselected after reload", async () => {
    const options = context(); const first = image();
    fetchMock.mockRejectedValueOnce(new Error("lost"));
    await expect(uploadR2Asset(first, first.name, "ordinary_image", options)).rejects.toThrow();
    const id = requestId();
    const reselected = image();
    fetchMock.mockResolvedValueOnce(json(state(id)));
    await expect(uploadR2Asset(reselected, reselected.name, "ordinary_image", options)).resolves.toEqual(result);
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/r2-upload-requests/${id}`);
  });

  it.each([image("changed"), image("image", "renamed.png")])("refuses changed reselected input while the earlier request is unresolved", async (changed) => {
    const options = context(); const file = image();
    fetchMock.mockRejectedValueOnce(new Error("lost"));
    await expect(uploadR2Asset(file, file.name, "ordinary_image", options)).rejects.toThrow();
    await expect(uploadR2Asset(changed, changed.name, "ordinary_image", options)).rejects.toThrow("Reselect its original file");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(saved.length).toBe(1);
  });

  it.each(["wrong-id", "wrong-ingress", "bad-result", "bad-expiry"])("rejects unverified %s status responses and preserves the checkpoint", async (failure) => {
    const options = context(); const file = image();
    fetchMock.mockRejectedValueOnce(new Error("lost"));
    await expect(uploadR2Asset(file, file.name, "ordinary_image", options)).rejects.toThrow();
    const invalid: Record<string, unknown> = state(requestId());
    if (failure === "wrong-id") invalid.requestId = "someone-elses-request";
    if (failure === "wrong-ingress") invalid.ingress = "project_attachment";
    if (failure === "bad-result") invalid.result = { id: "asset" };
    if (failure === "bad-expiry") invalid.expiresAt = "not a date";
    fetchMock.mockResolvedValueOnce(json(invalid));
    await expect(uploadR2Asset(file, file.name, "ordinary_image", options)).rejects.toThrow("could not be verified");
    expect(saved.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps status transport errors uncertain without POSTing", async () => {
    const options = context(); const file = image();
    fetchMock.mockRejectedValueOnce(new Error("lost"));
    await expect(uploadR2Asset(file, file.name, "ordinary_image", options)).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(json({ error: "not authenticated" }, 403));
    await expect(uploadR2Asset(file, file.name, "ordinary_image", options)).rejects.toThrow("status could not be checked");
    expect(saved.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows an explicit new file selection after a terminal outcome", async () => {
    const options = context(); const file = image();
    fetchMock.mockRejectedValueOnce(new Error("lost"));
    await expect(uploadR2Asset(file, file.name, "ordinary_image", options)).rejects.toThrow();
    const oldId = requestId();
    fetchMock.mockResolvedValueOnce(json(state(oldId, "expired")));
    await expect(uploadR2Asset(file, file.name, "ordinary_image", options)).rejects.toMatchObject({ terminal: true });
    expect(saved.length).toBe(0);
    await expect(uploadR2Asset(file, file.name, "ordinary_image", options)).rejects.toBeInstanceOf(R2UploadRequestError);
    fetchMock.mockResolvedValueOnce(json(result));
    await uploadR2Asset(image(), file.name, "ordinary_image", options);
    expect(requestId(2)).not.toBe(oldId);
  });

  it("requires a readable and durable checkpoint before any network request", async () => {
    vi.stubGlobal("sessionStorage", { ...saved, setItem: () => { throw new Error("disabled"); } });
    const file = image();
    await expect(uploadR2Asset(file, file.name, "ordinary_image", context())).rejects.toThrow("could not save");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serializes simultaneous submissions from the same form and File", async () => {
    const file = image(); const options = context();
    fetchMock.mockResolvedValue(json(result));
    const answers = await Promise.all([uploadR2Asset(file, file.name, "ordinary_image", options), uploadR2Asset(file, file.name, "ordinary_image", options)]);
    expect(answers).toEqual([result, result]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not let a different concurrent File replace an uncertain form checkpoint", async () => {
    const first = image(); const second = image("changed"); const options = context();
    fetchMock.mockRejectedValue(new Error("lost"));
    const outcomes = await Promise.allSettled([uploadR2Asset(first, first.name, "ordinary_image", options), uploadR2Asset(second, second.name, "ordinary_image", options)]);
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(saved.length).toBe(1);
  });

  it("revalidates a cached ready upload without POST and preserves it if status is uncertain", async () => {
    const file = image(); const options = context();
    fetchMock.mockResolvedValueOnce(json(result));
    await uploadR2Asset(file, file.name, "ordinary_image", options);
    const id = requestId();
    fetchMock.mockRejectedValueOnce(new Error("status unavailable"));
    await expect(uploadR2Asset(file, file.name, "ordinary_image", options)).rejects.toThrow("status could not be checked");
    expect(saved.length).toBe(1);
    expect(JSON.parse(saved.getItem(saved.key(0)!)!).observedReady).toBe(true);
    fetchMock.mockResolvedValueOnce(json(state(id)));
    await expect(uploadR2Asset(image(), file.name, "ordinary_image", options)).resolves.toEqual(result);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("does not POST again when an acknowledged ready receipt disappears", async () => {
    const file = image(); const options = context();
    fetchMock.mockResolvedValueOnce(json(result));
    await uploadR2Asset(file, file.name, "ordinary_image", options);
    fetchMock.mockResolvedValueOnce(json({}, 404));
    await expect(uploadR2Asset(file, file.name, "ordinary_image", options)).rejects.toThrow("previously completed upload could not be found");
    fetchMock.mockResolvedValueOnce(json({}, 404));
    await expect(uploadR2Asset(image(), file.name, "ordinary_image", options)).rejects.toThrow("previously completed upload could not be found");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("does not overwrite a newer unresolved request while rechecking an older ready File", async () => {
    const first = image(); const second = image("second"); const options = context();
    fetchMock.mockResolvedValueOnce(json(result));
    await uploadR2Asset(first, first.name, "ordinary_image", options);
    fetchMock.mockRejectedValueOnce(new Error("lost"));
    await expect(uploadR2Asset(second, second.name, "ordinary_image", options)).rejects.toThrow();
    const savedRequest = saved.getItem(saved.key(0)!);
    await expect(uploadR2Asset(first, first.name, "ordinary_image", options)).rejects.toThrow("Another upload");
    expect(saved.getItem(saved.key(0)!)).toBe(savedRequest);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([["expired", 410], ["failed", 409], ["unavailable", 503]] as const)("recognizes a direct terminal POST %s state", async (status, code) => {
    const file = image(); const options = context();
    fetchMock.mockImplementationOnce(async (_url, init) => json(state((init?.headers as Record<string, string>)["X-Upload-Request-Id"], status), code));
    await expect(uploadR2Asset(file, file.name, "ordinary_image", options)).rejects.toMatchObject({ terminal: true });
    expect(saved.length).toBe(0);
  });

  it("permits a new UUID for the same File only after explicit discard", async () => {
    const file = image(); const options = context();
    fetchMock.mockRejectedValueOnce(new Error("lost"));
    await expect(uploadR2Asset(file, file.name, "ordinary_image", options)).rejects.toThrow();
    const oldId = requestId();
    discardR2Upload("ordinary_image", options.context);
    fetchMock.mockResolvedValueOnce(json(result));
    await uploadR2Asset(file, file.name, "ordinary_image", options);
    expect(requestId(1)).not.toBe(oldId);
    expect(fetchMock.mock.calls[1][1]?.method).toBe("POST");
  });

  it("encodes Unicode filenames into a transport-safe header", async () => {
    const file = image("pixels", "晶圆图 α.png");
    fetchMock.mockResolvedValueOnce(json(result));
    await uploadR2Asset(file, file.name, "ordinary_image", context());
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ "X-Filename-Uri": encodeURIComponent(file.name) });
  });

  it("prepares compressed bytes once across a failed upload and form retry", async () => {
    const source = image("original"); const options = context(); const compressed = image("compressed", "image.webp");
    const compression = vi.fn(async () => compressed);
    fetchMock.mockRejectedValueOnce(new Error("lost"));
    const first = await prepareR2UploadFile(source, options.context, compression);
    await expect(uploadR2Asset(first, first.name, "ordinary_image", options)).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(json({ error: "absent" }, 404)).mockResolvedValueOnce(json(result));
    const retry = await prepareR2UploadFile(source, options.context, compression);
    await uploadR2Asset(retry, retry.name, "ordinary_image", options);
    expect(compression).toHaveBeenCalledTimes(1);
    expect(retry).toBe(first);
    expect(requestId(2)).toBe(requestId());
  });
});

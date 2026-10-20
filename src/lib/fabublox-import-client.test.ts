import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FabubloxImportPreview } from "../../shared/types";
import { FABUBLOX_IMPORT_REQUEST_HEADER } from "../../shared/contracts/fabublox-import";
import { compressLayerStackImage } from "./images";
import {
  FABUBLOX_IMPORT_SESSION_KEY, FabubloxImportRequestError, getFabubloxImportRequest,
  loadSavedFabubloxImport, prepareFabubloxImport, saveFabubloxImport, submitFabubloxImport,
} from "./fabublox-import-client";

vi.mock("./images", () => ({ compressLayerStackImage: vi.fn(async (file: File) => file) }));

const requestId = "c822fd4b-cb7f-4e9e-922b-243ac71d5ad4";
const result = { id: "import-one", templateVersionId: "template-one", version: 2 };
const preview: FabubloxImportPreview = {
  schemaVersion: 2, title: " Import title ", source: { fileName: "input.xlsx", fileSha256: "a".repeat(64), sheetName: "Recipe" },
  detected: { headerRow: 1, layerStackColumn: null }, sections: [], initialSubstrateStep: null, steps: [],
  images: [{ localId: "image-one", sourcePart: "drawings/image.png", mimeType: "image/png", data: new Uint8Array([1, 2, 3]),
    widthPx: 1, heightPx: 1, anchor: { row: 1, col: 2 }, assignedStepLocalId: null }],
  initialStateImageIds: [], unassignedImageIds: ["image-one"], warnings: [],
};

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  });
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("durable FabuBlox import client", () => {
  it("prepares images once and reuses the exact multipart body and identity for retries", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(result), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const prepared = await prepareFabubloxImport(new File(["workbook"], "input.xlsx"), preview, "family-one");
    expect(prepared.title).toBe("Import title");
    expect(vi.mocked(compressLayerStackImage)).toHaveBeenCalledTimes(1);
    const manifest = JSON.parse(await (prepared.form.get("manifest") as Blob).text());
    expect(manifest.recipeFamilyId).toBe("family-one");
    expect(manifest.images[0].data).toBeUndefined();
    expect([...prepared.form.keys()]).toEqual(["workbook", "manifest", "image:image-one"]);
    await submitFabubloxImport(prepared);
    await submitFabubloxImport(prepared);
    expect(fetchMock.mock.calls.map((call) => call[1].body)).toEqual([prepared.form, prepared.form]);
    expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ [FABUBLOX_IMPORT_REQUEST_HEADER]: prepared.requestId });
    expect(fetchMock.mock.calls[1][1].headers).toEqual(fetchMock.mock.calls[0][1].headers);
    expect(vi.mocked(compressLayerStackImage)).toHaveBeenCalledTimes(1);
  });

  it("reuses a normalized saved identity when file bytes must be reselected", async () => {
    const prepared = await prepareFabubloxImport(new File(["workbook"], "input.xlsx"), preview, undefined, requestId.toUpperCase());
    expect(prepared.requestId).toBe(requestId);
    await expect(prepareFabubloxImport(new File(["workbook"], "input.xlsx"), preview, undefined, "invalid-id"))
      .rejects.toThrow("saved import request identity is invalid");
    expect(compressLayerStackImage).toHaveBeenCalledTimes(1);
  });

  it("preserves actor-bound pending and failed conflict states", async () => {
    const pending = { requestId, importId: "import-one", status: "pending", leaseExpiresAt: null };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Import in progress", request: pending }), { status: 409 })));
    await expect(submitFabubloxImport({ requestId, title: "title", form: new FormData() })).rejects.toMatchObject({
      name: "FabubloxImportRequestError", request: pending,
    });
  });

  it("treats an unrelated state and malformed success as unknown outcomes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Conflict", request: { requestId: "another-request", importId: "import-one", status: "failed" } }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...result, version: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const prepared = { requestId, title: "title", form: new FormData() };
    await expect(submitFabubloxImport(prepared)).rejects.toMatchObject({ request: undefined });
    await expect(submitFabubloxImport(prepared)).rejects.toBeInstanceOf(FabubloxImportRequestError);
  });

  it("gets a saved request without a body and distinguishes 404 from unavailable status", async () => {
    const ready = { requestId, importId: "import-one", status: "ready", result };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ready)))
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getFabubloxImportRequest(requestId)).toEqual(ready);
    expect(await getFabubloxImportRequest(requestId)).toBeNull();
    await expect(getFabubloxImportRequest(requestId)).rejects.toThrow("could not be checked");
    expect(fetchMock.mock.calls[0]).toEqual([`/api/imports/fabublox/requests/${requestId}`, { cache: "no-store" }]);
  });

  it("rejects status results for a different request identity", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ requestId: "wrong", importId: "import-one", status: "ready", result }))));
    await expect(getFabubloxImportRequest(requestId)).rejects.toThrow("could not be checked");
  });

  it("stores only a bounded request identity and title, not workbook data", () => {
    saveFabubloxImport({ requestId, title: "a".repeat(1000) });
    expect(loadSavedFabubloxImport()).toEqual({ requestId, title: "a".repeat(256) });
    expect(JSON.parse(sessionStorage.getItem(FABUBLOX_IMPORT_SESSION_KEY)!)).toEqual({ requestId, title: "a".repeat(256) });
    sessionStorage.setItem(FABUBLOX_IMPORT_SESSION_KEY, "x".repeat(3000));
    expect(loadSavedFabubloxImport()).toBeNull();
    sessionStorage.setItem(FABUBLOX_IMPORT_SESSION_KEY, JSON.stringify({ requestId: "bad", title: "title" }));
    expect(loadSavedFabubloxImport()).toBeNull();
  });

  it("fails before a request can be sent when its recovery checkpoint cannot be written", () => {
    vi.mocked(sessionStorage.setItem).mockImplementation(() => { throw new Error("Quota exceeded"); });
    expect(() => saveFabubloxImport({ requestId, title: "title" })).toThrow("Enable session storage");
  });
});

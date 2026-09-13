import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FabubloxImportPreview } from "../shared/types";
import { FabubloxImporter } from "./components/FabubloxImporter";
import { api } from "./lib/api";
import { parseFabuBloxWorkbook } from "./lib/fabublox";
import { compressLayerStackImage } from "./lib/images";
import { FABUBLOX_IMPORT_SESSION_KEY } from "./lib/fabublox-import-client";
import { FABUBLOX_IMPORT_REQUEST_HEADER } from "../shared/contracts/fabublox-import";

// Exercise import request ownership, not workbook/ZIP parsing or image encoding.
vi.mock("./lib/fabublox", () => ({ parseFabuBloxWorkbook: vi.fn() }));
vi.mock("./lib/images", () => ({ compressLayerStackImage: vi.fn(async (file: File) => file) }));

const result = { id: "import-one", templateVersionId: "template-one", version: 2 };
const preview: FabubloxImportPreview = {
  schemaVersion: 2, title: "Imported process", source: { fileName: "input.xlsx", fileSha256: "a".repeat(64), sheetName: "Recipe" },
  detected: { headerRow: 1, layerStackColumn: null }, sections: [], initialSubstrateStep: null,
  steps: [{ localId: "step-one", sourceRow: 2, position: 0, stepNumber: "1", sectionName: null, name: "Etch", toolName: null,
    parametersText: null, commentsText: null, imageIds: [], rawCells: {} }],
  images: [{ localId: "image-one", sourcePart: "drawings/image.png", mimeType: "image/png", data: new Uint8Array([1, 2, 3]),
    widthPx: 1, heightPx: 1, anchor: { row: 1, col: 2 }, assignedStepLocalId: null }],
  initialStateImageIds: [], unassignedImageIds: ["image-one"], warnings: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
function saved() { return JSON.parse(sessionStorage.getItem(FABUBLOX_IMPORT_SESSION_KEY)!); }
async function choose(container: HTMLElement) {
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(["fixture"], "input.xlsx")] } });
  return screen.findByRole("button", { name: "Confirm process-template import" });
}
function frozen(container: HTMLElement) {
  expect((screen.getByRole("textbox", { name: "Process template title" }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("combobox", { name: /^Version relationship/ }) as HTMLSelectElement).disabled).toBe(true);
  expect((container.querySelector('input[type="file"]') as HTMLInputElement).disabled).toBe(true);
}

beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(parseFabuBloxWorkbook).mockResolvedValue(structuredClone(preview));
  vi.spyOn(api, "listTemplateFamilyOptions").mockResolvedValue({ families: [] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe("durable FabuBlox import interaction", () => {
  it("saves before POST, freezes inputs, and retries a failed completed-result navigation without importing again", async () => {
    const sent = deferred<Response>();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      expect(saved()).toEqual({ requestId: (init?.headers as Record<string, string>)[FABUBLOX_IMPORT_REQUEST_HEADER], title: "Imported process" });
      return sent.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const onImported = vi.fn().mockRejectedValueOnce(new Error("Navigation unavailable")).mockResolvedValue(undefined);
    const { container } = render(<FabubloxImporter onImported={onImported} />);
    const confirm = await choose(container);
    fireEvent.click(confirm); fireEvent.click(confirm);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    frozen(container);
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(["other"], "other.xlsx")] } });
    expect(parseFabuBloxWorkbook).toHaveBeenCalledTimes(1);
    await act(async () => { sent.resolve(response(result, 201)); });
    await screen.findByText(/import completed, but its process template could not be opened/);
    fireEvent.click(screen.getByRole("button", { name: "Open completed process template" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(compressLayerStackImage).toHaveBeenCalledTimes(1);
  });

  it("checks an unknown outcome through pending to ready without replaying a POST", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("Connection lost"))
      .mockImplementationOnce(async () => response({ ...saved(), importId: "import-one", status: "pending", leaseExpiresAt: null }))
      .mockImplementationOnce(async () => response({ ...saved(), importId: "import-one", status: "ready", result }));
    vi.stubGlobal("fetch", fetchMock);
    const onImported = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<FabubloxImporter onImported={onImported} />);
    fireEvent.click(await choose(container));
    await screen.findByText("Connection lost");
    frozen(container);
    expect(screen.queryByRole("button", { name: "Start a new import" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check import status" }));
    await screen.findByText(/still in progress/);
    expect(screen.queryByRole("button", { name: "Retry original import" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check import status" }));
    await screen.findByText(/Import completed: Imported process/);
    expect(onImported).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open completed process template" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith({ templateVersionId: "template-one", version: 2, name: "Imported process" }));
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a missing-provider request only after GET 404 using the original identity and body", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ error: "Storage unavailable" }, 503))
      .mockResolvedValueOnce(response({ error: "Import request not found" }, 404))
      .mockResolvedValueOnce(response(result, 201));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<FabubloxImporter onImported={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(await choose(container));
    await screen.findByText("Storage unavailable");
    expect(screen.queryByRole("button", { name: "Retry original import" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check import status" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry original import" }));
    await screen.findByText(/Import completed: Imported process/);
    expect(fetchMock.mock.calls[2][1].body).toBe(fetchMock.mock.calls[0][1].body);
    expect(fetchMock.mock.calls[2][1].headers).toEqual(fetchMock.mock.calls[0][1].headers);
    expect(compressLayerStackImage).toHaveBeenCalledTimes(1);
  });

  it("restores after refresh with GET and opens the existing result without file bytes", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("Connection lost"))
      .mockImplementationOnce(async () => response({ ...saved(), importId: "import-one", status: "ready", result }));
    vi.stubGlobal("fetch", fetchMock);
    const initial = render(<FabubloxImporter onImported={vi.fn()} />);
    fireEvent.click(await choose(initial.container));
    await screen.findByText("Connection lost");
    expect(Object.keys(saved()).sort()).toEqual(["requestId", "title"]);
    initial.unmount();
    const onImported = vi.fn().mockResolvedValue(undefined);
    const refreshed = render(<FabubloxImporter onImported={onImported} />);
    await screen.findByText(/Import completed: Imported process/);
    expect(refreshed.container.textContent).not.toContain("input.xlsx");
    expect(fetchMock.mock.calls[1][0]).toContain(`/requests/${saved().requestId}`);
    expect(fetchMock.mock.calls[1][1]?.body).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Open completed process template" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(parseFabuBloxWorkbook).toHaveBeenCalledTimes(1);
  });

  it("requires an explicit new import after a terminal failure and allocates a fresh identity", async () => {
    const fetchMock = vi.fn().mockImplementationOnce(async () => response({ error: "Import failed", request: { ...saved(), importId: "import-one", status: "failed" } }, 409))
      .mockResolvedValueOnce(response(result, 201));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<FabubloxImporter onImported={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(await choose(container));
    await screen.findByText(/This import failed/);
    const originalId = saved().requestId;
    expect(screen.queryByRole("button", { name: "Confirm process-template import" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry original import" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start a new import" }));
    expect(sessionStorage.getItem(FABUBLOX_IMPORT_SESSION_KEY)).toBeNull();
    fireEvent.click(await choose(container));
    await screen.findByText(/Import completed: Imported process/);
    expect(saved().requestId).not.toBe(originalId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves a restored missing request through reselection and refresh, including an original-input conflict", async () => {
    const originalId = "c822fd4b-cb7f-4e9e-922b-243ac71d5ad4";
    sessionStorage.setItem(FABUBLOX_IMPORT_SESSION_KEY, JSON.stringify({ requestId: originalId, title: "Previous import" }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ error: "Import request not found" }, 404))
      .mockResolvedValueOnce(response({ error: "Import request not found" }, 404))
      .mockResolvedValueOnce(response({ error: "This import request was already accepted with different input." }, 409))
      .mockResolvedValueOnce(response({ requestId: originalId, importId: "import-one", status: "ready", result }));
    vi.stubGlobal("fetch", fetchMock);
    const initial = render(<FabubloxImporter onImported={vi.fn()} />);
    await screen.findByText(/not currently visible/);
    expect(screen.queryByRole("button", { name: "Start a new import" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry original import" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reselect workbook for this request" }));
    expect((initial.container.querySelector('input[type="file"]') as HTMLInputElement).disabled).toBe(false);
    expect(saved().requestId).toBe(originalId);
    initial.unmount();
    const onImported = vi.fn().mockResolvedValue(undefined);
    const refreshed = render(<FabubloxImporter onImported={onImported} />);
    await screen.findByText(/not currently visible/);
    expect(saved().requestId).toBe(originalId);
    fireEvent.click(screen.getByRole("button", { name: "Reselect workbook for this request" }));
    fireEvent.click(await choose(refreshed.container));
    await screen.findByText(/already accepted with different input/);
    expect(fetchMock.mock.calls[2][1].headers).toEqual({ [FABUBLOX_IMPORT_REQUEST_HEADER]: originalId });
    expect(saved().requestId).toBe(originalId);
    expect(screen.queryByRole("button", { name: "Start a new import" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check import status" }));
    await screen.findByRole("button", { name: "Open completed process template" });
    fireEvent.click(screen.getByRole("button", { name: "Open completed process template" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ templateVersionId: result.templateVersionId })));
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  });

  it("cannot replace the identity when GET 404 races with a lost-response POST still awaiting acceptance", async () => {
    const acceptance = deferred<void>();
    const acceptedRequestIds = new Set<string>();
    let originalRequestId = "";
    let postCount = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return response({ error: "Import request not found" }, 404);
      const requestId = (init.headers as Record<string, string>)[FABUBLOX_IMPORT_REQUEST_HEADER];
      postCount += 1;
      if (postCount === 1) {
        originalRequestId = requestId;
        // The response connection disappears while the server still parses the
        // original request. A later GET can observe absence before it accepts.
        void acceptance.promise.then(() => { acceptedRequestIds.add(requestId); });
        throw new Error("Response connection lost");
      }
      await acceptance.promise;
      acceptedRequestIds.add(requestId);
      return response(result);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<FabubloxImporter onImported={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(await choose(container));
    await screen.findByText("Response connection lost");
    fireEvent.click(screen.getByRole("button", { name: "Check import status" }));
    await screen.findByText(/not currently visible/);
    expect(acceptedRequestIds.size).toBe(0);
    expect(screen.queryByRole("button", { name: "Start a new import" })).toBeNull();
    expect(saved().requestId).toBe(originalRequestId);
    fireEvent.click(screen.getByRole("button", { name: "Retry original import" }));
    await waitFor(() => expect(postCount).toBe(2));
    await act(async () => { acceptance.resolve(); });
    await screen.findByText(/Import completed: Imported process/);
    expect([...acceptedRequestIds]).toEqual([originalRequestId]);
    expect(fetchMock.mock.calls[2][1]?.body).toBe(fetchMock.mock.calls[0][1]?.body);
    expect(compressLayerStackImage).toHaveBeenCalledTimes(1);
  });

  it("does not POST when the session recovery checkpoint cannot be saved", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    const { container } = render(<FabubloxImporter onImported={vi.fn()} />);
    fireEvent.click(await choose(container));
    await screen.findByText(/Enable session storage before importing/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((container.querySelector('input[type="file"]') as HTMLInputElement).disabled).toBe(false);
  });

  it("ignores a parse completing after the importer unmounts", async () => {
    const parsing = deferred<FabubloxImportPreview>();
    vi.mocked(parseFabuBloxWorkbook).mockReturnValueOnce(parsing.promise);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const initial = render(<FabubloxImporter onImported={vi.fn()} />);
    fireEvent.change(initial.container.querySelector('input[type="file"]')!, { target: { files: [new File(["fixture"], "input.xlsx")] } });
    initial.unmount();
    render(<FabubloxImporter onImported={vi.fn()} />);
    await act(async () => { parsing.resolve(preview); });
    expect(screen.queryByRole("button", { name: "Confirm process-template import" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

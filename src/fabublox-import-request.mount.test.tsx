import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FabubloxImportPreview } from "../shared/types";
import { FabubloxImporter } from "./components/FabubloxImporter";
import { api } from "./lib/api";
import { parseFabuBloxWorkbook } from "./lib/fabublox";
import { convertFabuBloxWorkbook } from "./lib/fabublox-convert";
import { compressLayerStackImage } from "./lib/images";
import { FABUBLOX_IMPORT_SESSION_KEY } from "./lib/fabublox-import-client";
import { FABUBLOX_IMPORT_REQUEST_HEADER } from "../shared/contracts/fabublox-import";
import * as authenticationClient from "./lib/authentication-client";

// Exercise import request ownership, not workbook/ZIP parsing or image encoding.
vi.mock("./lib/fabublox", () => ({ parseFabuBloxWorkbook: vi.fn() }));
vi.mock("./lib/fabublox-convert", () => ({ convertFabuBloxWorkbook: vi.fn() }));
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
    expect(saved().title).toBe("Imported process");
    fireEvent.click(screen.getByRole("button", { name: "Open completed process template" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(sessionStorage.getItem(FABUBLOX_IMPORT_SESSION_KEY)).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(compressLayerStackImage).toHaveBeenCalledTimes(1);
  });

  it("retires the completed notice after navigation unmounts the importer and does not restore it on return", async () => {
    const opened = deferred<void>();
    const fetchMock = vi.fn().mockResolvedValue(response(result, 201));
    vi.stubGlobal("fetch", fetchMock);
    const onImported = vi.fn(() => opened.promise);
    const initial = render(<FabubloxImporter onImported={onImported} />);
    fireEvent.click(await choose(initial.container));
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(saved().title).toBe("Imported process");
    initial.unmount();
    await act(async () => { opened.resolve(); });
    expect(sessionStorage.getItem(FABUBLOX_IMPORT_SESSION_KEY)).toBeNull();

    render(<FabubloxImporter onImported={vi.fn()} />);
    await waitFor(() => expect(api.listTemplateFamilyOptions).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Import completed:/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Import request" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps an unresolved import when leaving and recovers its accepted result without a second POST", async () => {
    const responseDelivery = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(responseDelivery.promise)
      .mockImplementationOnce(async () => response({ ...saved(), importId: "import-one", status: "ready", result }));
    vi.stubGlobal("fetch", fetchMock);
    const onImported = vi.fn();
    const initial = render(<FabubloxImporter onImported={onImported} />);
    fireEvent.click(await choose(initial.container));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const original = saved();
    initial.unmount();
    await act(async () => { responseDelivery.resolve(response(result, 201)); });
    expect(saved()).toEqual(original);
    expect(onImported).not.toHaveBeenCalled();

    const recovered = vi.fn().mockResolvedValue(undefined);
    render(<FabubloxImporter onImported={recovered} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open completed process template" }));
    await waitFor(() => expect(recovered).toHaveBeenCalledWith(expect.objectContaining({ templateVersionId: result.templateVersionId })));
    await waitFor(() => expect(sessionStorage.getItem(FABUBLOX_IMPORT_SESSION_KEY)).toBeNull());
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not discard another request saved while completed-template navigation is pending", async () => {
    const opened = deferred<void>();
    const fetchMock = vi.fn().mockResolvedValue(response(result, 201));
    vi.stubGlobal("fetch", fetchMock);
    const onImported = vi.fn(() => opened.promise);
    const { container } = render(<FabubloxImporter onImported={onImported} />);
    fireEvent.click(await choose(container));
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    const next = { requestId: "c822fd4b-cb7f-4e9e-922b-243ac71d5ad4", title: "Another import" };
    sessionStorage.setItem(FABUBLOX_IMPORT_SESSION_KEY, JSON.stringify(next));
    await act(async () => { opened.resolve(); });
    expect(saved()).toEqual(next);
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
    expect(fetchMock.mock.calls[1][1].headers[FABUBLOX_IMPORT_REQUEST_HEADER]).not.toBe(originalId);
    await waitFor(() => expect(sessionStorage.getItem(FABUBLOX_IMPORT_SESSION_KEY)).toBeNull());
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

describe("local workbook layout conversion", () => {
  async function openConversion(container: HTMLElement) {
    await choose(container);
    fireEvent.click(screen.getByText("Convert workbook layout"));
    return screen.getByRole("button", { name: "Download converted workbook" });
  }

  function conversionDownload() {
    const converted = new File(["converted fixture"], "input-classic.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const createUrl = vi.spyOn(URL, "createObjectURL").mockImplementation(blob => blob === converted ? "blob:converted-workbook" : "blob:diagram");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    return { converted, createUrl, revokeUrl, click };
  }

  it("shows the detected layout and original substrate name without changing canonical Step 0", async () => {
    const source = structuredClone(preview);
    source.detected.formatId = "capability-flow";
    source.initialSubstrateStep = { ...source.steps[0], localId: "initial", stepNumber: "0", name: "Substrate Stack",
      rawCells: { "Source substrate name": "InP layer wafer" } };
    vi.mocked(parseFabuBloxWorkbook).mockResolvedValueOnce(source);
    const { container } = render(<FabubloxImporter onImported={vi.fn()} />);
    await choose(container);
    expect(screen.getByText("Capability flow", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("InP layer wafer", { selector: "p.card-value" })).toBeTruthy();
    expect(screen.getByText("Step 0")).toBeTruthy();
    fireEvent.click(screen.getByText("Convert workbook layout"));
    expect((screen.getByRole("combobox", { name: "Converted workbook layout" }) as HTMLSelectElement).value).toBe("classic-layer-stack");
  });

  it("downloads the selected layout locally, presents conversion notes and releases the prepared URL on leaving", async () => {
    const download = conversionDownload();
    vi.mocked(convertFabuBloxWorkbook).mockResolvedValueOnce({ file: download.converted,
      warnings: [{ code: "CONTENT_ONLY", message: "Workbook styling and formulas are not preserved." }] });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container, unmount } = render(<FabubloxImporter onImported={vi.fn()} />);
    const button = await openConversion(container);
    fireEvent.change(screen.getByRole("combobox", { name: "Converted workbook layout" }), { target: { value: "capability-flow" } });
    fireEvent.click(button);
    const prepared = await screen.findByRole("link", { name: "Download prepared workbook" });
    expect(prepared.getAttribute("href")).toBe("blob:converted-workbook");
    expect(prepared.getAttribute("download")).toBe("input-classic.xlsx");
    expect(convertFabuBloxWorkbook).toHaveBeenCalledWith(expect.objectContaining({ name: "input.xlsx" }), "capability-flow");
    expect(screen.getByText("Workbook styling and formulas are not preserved.")).toBeTruthy();
    expect(download.click).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(FABUBLOX_IMPORT_SESSION_KEY)).toBeNull();
    expect((screen.getByRole("button", { name: "Confirm process-template import" }) as HTMLButtonElement).disabled).toBe(false);
    unmount();
    expect(download.revokeUrl).toHaveBeenCalledWith("blob:converted-workbook");
  });

  it("reports a conversion refusal while keeping the original workbook available for import", async () => {
    const download = conversionDownload();
    vi.mocked(convertFabuBloxWorkbook).mockRejectedValueOnce(new Error("The initial substrate is ambiguous."));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<FabubloxImporter onImported={vi.fn()} />);
    fireEvent.click(await openConversion(container));
    await screen.findByRole("alert");
    expect(screen.getByText("Could not convert workbook: The initial substrate is ambiguous.")).toBeTruthy();
    expect(download.click).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Confirm process-template import" }) as HTMLButtonElement).disabled).toBe(false);
    expect((container.querySelector('input[type="file"]') as HTMLInputElement).disabled).toBe(false);
  });

  it("does not start a download when the application owner changes during conversion", async () => {
    const download = conversionDownload();
    const converted = deferred<{ file: File; warnings: [] }>();
    vi.mocked(convertFabuBloxWorkbook).mockReturnValueOnce(converted.promise);
    let sameOwner = true;
    const owner = authenticationClient.captureApplicationOwner();
    vi.spyOn(authenticationClient, "captureApplicationOwner").mockReturnValue({ ...owner, isCurrent: () => sameOwner });
    const { container } = render(<FabubloxImporter onImported={vi.fn()} />);
    fireEvent.click(await openConversion(container));
    await waitFor(() => expect(convertFabuBloxWorkbook).toHaveBeenCalledTimes(1));
    sameOwner = false;
    await act(async () => { converted.resolve({ file: download.converted, warnings: [] }); });
    expect(download.createUrl).not.toHaveBeenCalledWith(download.converted);
    expect(download.click).not.toHaveBeenCalled();
  });

  it.each(["replacement", "leaving", "confirming import"])("does not download a stale conversion after %s", async reason => {
    const download = conversionDownload();
    const converted = deferred<{ file: File; warnings: [] }>();
    vi.mocked(convertFabuBloxWorkbook).mockReturnValueOnce(converted.promise);
    const importDelivery = deferred<Response>();
    const fetchMock = vi.fn(() => importDelivery.promise);
    vi.stubGlobal("fetch", fetchMock);
    const { container, unmount } = render(<FabubloxImporter onImported={vi.fn()} />);
    fireEvent.click(await openConversion(container));
    await waitFor(() => expect(convertFabuBloxWorkbook).toHaveBeenCalledTimes(1));
    expect((screen.getByRole("button", { name: "Confirm process-template import" }) as HTMLButtonElement).disabled).toBe(false);
    if (reason === "replacement") {
      fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(["replacement"], "other.xlsx")] } });
      await screen.findByRole("button", { name: "Confirm process-template import" });
    } else if (reason === "leaving") unmount();
    else {
      fireEvent.click(screen.getByRole("button", { name: "Confirm process-template import" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect((screen.getByRole("button", { name: "Download converted workbook" }) as HTMLButtonElement).disabled).toBe(true);
    }
    await act(async () => { converted.resolve({ file: download.converted, warnings: [] }); });
    expect(download.createUrl).not.toHaveBeenCalledWith(download.converted);
    expect(download.click).not.toHaveBeenCalled();
    if (reason === "confirming import") await act(async () => { importDelivery.resolve(response(result, 201)); });
    else expect(fetchMock).not.toHaveBeenCalled();
  });
});

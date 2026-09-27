import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlobExportOutcome } from "../shared/types";
import { exportAll } from "./lib/exportAll";
import { ExportPage } from "./pages/ExportPage";

vi.mock("./lib/exportAll", () => ({ exportAll: vi.fn() }));

type ExportResult = Awaited<ReturnType<typeof exportAll>>;

function archiveResult(outcomes: BlobExportOutcome[] = ["packaged"]): ExportResult {
  const results = outcomes.map((outcome, index) => ({
    locatorId: `asset-${index}`, storeKind: "r2" as const, provider: "r2",
    objectKey: `key-${index}`, blobRecordIds: [`record-${index}`], filename: `asset-${index}.txt`,
    expectedByteSize: 4, expectedSha256: null, sourceOccurrences: [], outcome,
    path: outcome === "packaged" ? `blobs/r2/${index}.txt` : null,
  }));
  return {
    archive: new Blob(["test"], { type: "application/zip" }),
    filename: "sample-log-2026-09-27.zip", results,
    warnings: results.flatMap((entry) => entry.outcome === "packaged" ? [] : [{
      code: entry.outcome, locatorId: entry.locatorId, blobRecordIds: entry.blobRecordIds,
      sourceOccurrences: entry.sourceOccurrences, message: "Asset was unavailable.",
    }]),
  };
}

function pendingExport() {
  let resolve!: (result: ExportResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ExportResult>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

const build = vi.mocked(exportAll);
const createUrl = vi.fn();
const revokeUrl = vi.fn();
const automaticDownloads: Array<{ href: string; filename: string; connected: boolean }> = [];

beforeEach(() => {
  build.mockReset(); createUrl.mockReset(); revokeUrl.mockReset(); automaticDownloads.length = 0;
  createUrl.mockReturnValue("blob:prepared-archive");
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = createUrl;
    static revokeObjectURL = revokeUrl;
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    automaticDownloads.push({ href: this.href, filename: this.download, connected: this.isConnected });
  });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("complete export download feedback", () => {
  it("keeps one prepared download available without rebuilding or claiming it was saved", async () => {
    const result = archiveResult();
    build.mockResolvedValue(result);
    render(<StrictMode><ExportPage /></StrictMode>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Download full ZIP" })); });
    const link = screen.getByRole("link", { name: "Download prepared ZIP" });
    expect(link.getAttribute("href")).toBe("blob:prepared-archive");
    expect(link.getAttribute("download")).toBe(result.filename);
    expect(screen.getByRole("status").textContent).toBe("Archive ready. Assets included: 1 / 1.");
    expect(createUrl).toHaveBeenCalledWith(result.archive);
    expect(automaticDownloads).toEqual([{ href: "blob:prepared-archive", filename: result.filename, connected: true }]);
    // Suppress jsdom navigation; the native link must not invoke another export.
    link.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link); fireEvent.click(link);
    expect(build).toHaveBeenCalledTimes(1);
    expect(revokeUrl).not.toHaveBeenCalled();
    expect(screen.queryByText(/downloaded|saved successfully/i)).toBeNull();
  });

  it("distinguishes fully processed assets from packaged assets and warns before the ZIP is opened", async () => {
    const pending = pendingExport();
    build.mockImplementation((onProgress) => { onProgress?.(3, 3); return pending.promise; });
    render(<ExportPage />);
    fireEvent.click(screen.getByRole("button", { name: "Download full ZIP" }));
    expect(screen.getByRole("status").textContent).toBe("Assets processed: 3 / 3. Building archive…");
    expect(screen.queryByRole("link", { name: "Download prepared ZIP" })).toBeNull();
    await act(async () => { pending.resolve(archiveResult(["packaged", "missing", "hash_mismatch"])); });
    expect(screen.getByText("Archive ready. Assets included: 1 / 3.")).toBeTruthy();
    expect(screen.getByText(/2 assets were not included/).textContent).toContain("export-warnings.json");
    expect(screen.queryByText(/Assets processed/)).toBeNull();
  });

  it("retires the old archive when rebuilding, recovers from a failed build, and releases the replacement on leaving", async () => {
    const failed = pendingExport();
    build.mockResolvedValueOnce(archiveResult()).mockReturnValueOnce(failed.promise).mockResolvedValueOnce(archiveResult([]));
    createUrl.mockReturnValueOnce("blob:first").mockReturnValueOnce("blob:replacement");
    const view = render(<ExportPage />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Download full ZIP" })); });
    fireEvent.click(screen.getByRole("button", { name: "Download full ZIP" }));
    expect(revokeUrl.mock.calls).toEqual([["blob:first"]]);
    expect(screen.queryByRole("link", { name: "Download prepared ZIP" })).toBeNull();
    await act(async () => { failed.reject(new Error("Snapshot unavailable")); });
    expect(screen.getByRole("alert").textContent).toBe("Snapshot unavailable");
    expect(screen.queryByText(/Archive ready/)).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Download full ZIP" })); });
    expect(screen.getByRole("link", { name: "Download prepared ZIP" }).getAttribute("href")).toBe("blob:replacement");
    expect(screen.getByRole("status").textContent).toBe("Archive ready. Assets included: 0 / 0.");
    expect(screen.queryByRole("alert")).toBeNull();
    view.unmount();
    expect(revokeUrl.mock.calls).toEqual([["blob:first"], ["blob:replacement"]]);
  });

  it("ignores progress and completion after leaving without creating a download or object URL", async () => {
    const pending = pendingExport();
    build.mockReturnValue(pending.promise);
    const view = render(<ExportPage />);
    fireEvent.click(screen.getByRole("button", { name: "Download full ZIP" }));
    const progress = build.mock.calls[0][0];
    view.unmount();
    await act(async () => { progress?.(1, 1); pending.resolve(archiveResult()); });
    expect(createUrl).not.toHaveBeenCalled();
    expect(automaticDownloads).toEqual([]);
    expect(revokeUrl).not.toHaveBeenCalled();
  });

  it("retains the prepared link if automatic download throws", async () => {
    build.mockResolvedValue(archiveResult());
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementationOnce(() => { throw new Error("Download blocked"); });
    render(<ExportPage />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Download full ZIP" })); });
    expect(screen.getByRole("alert").textContent).toContain("Use the download link below");
    expect(screen.getByRole("link", { name: "Download prepared ZIP" }).getAttribute("href")).toBe("blob:prepared-archive");
    expect(screen.getAllByRole("link", { name: "Download prepared ZIP" })).toHaveLength(1);
    expect(revokeUrl).not.toHaveBeenCalled();
  });
});

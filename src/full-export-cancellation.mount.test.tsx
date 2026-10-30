import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportAll } from "./lib/exportAll";
import { ExportPage } from "./pages/ExportPage";

vi.mock("./lib/exportAll", () => ({ exportAll: vi.fn() }));
type ExportResult = Awaited<ReturnType<typeof exportAll>>;

function result(): ExportResult {
  return { archive: new Blob(["archive"]), filename: "full.zip", results: [], warnings: [] };
}
function pending() {
  let resolve!: (value: ExportResult) => void;
  const promise = new Promise<ExportResult>(accept => { resolve = accept; });
  return { promise, resolve };
}

const build = vi.mocked(exportAll);
const createUrl = vi.fn();
const revokeUrl = vi.fn();
const download = vi.fn();

beforeEach(() => {
  build.mockReset(); createUrl.mockReset(); revokeUrl.mockReset(); download.mockReset();
  createUrl.mockReturnValue("blob:current-export");
  vi.stubGlobal("URL", class extends URL { static createObjectURL = createUrl; static revokeObjectURL = revokeUrl; });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(download);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("full export cancellation ownership", () => {
  it("aborts cancellation immediately, ignores the previous build, and allows a fresh download", async () => {
    const first = pending(), second = pending();
    build.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<StrictMode><ExportPage /></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: "Download full ZIP" }));
    expect(build).toHaveBeenCalledTimes(1);
    const previous = build.mock.calls[0];
    const signal = previous[1]?.signal;
    expect(signal?.aborted).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(/cancelled/i);
    expect(screen.queryByRole("link", { name: "Download prepared ZIP" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Download full ZIP" }));
    expect(build).toHaveBeenCalledTimes(2);
    expect(build.mock.calls[1][1]?.signal).not.toBe(signal);
    await act(async () => {
      previous[0]?.(99, 99);
      previous[1]?.onStageProgress?.({ stage: "compressing", completed: 99, total: 99, bytesRead: 999, percent: 99 });
      first.resolve(result());
    });
    expect(createUrl).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(screen.queryByText(/99/)).toBeNull();
    await act(async () => { second.resolve(result()); });
    expect(download).toHaveBeenCalledTimes(1);
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Download prepared ZIP" }).getAttribute("href")).toBe("blob:current-export");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("aborts the active build on unmount and never admits its late URL or download", async () => {
    const active = pending();
    build.mockReturnValue(active.promise);
    const view = render(<ExportPage />);
    fireEvent.click(screen.getByRole("button", { name: "Download full ZIP" }));
    const [progress, options] = build.mock.calls[0];
    view.unmount();
    expect(options?.signal?.aborted).toBe(true);
    await act(async () => {
      progress?.(1, 1);
      options?.onStageProgress?.({ stage: "compressing", completed: 1, total: 1, bytesRead: 3, percent: 100 });
      active.resolve(result());
    });
    expect(createUrl).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("displays phase progress and keeps only one export active", async () => {
    const active = pending();
    build.mockReturnValue(active.promise);
    const view = render(<ExportPage />);
    const start = screen.getByRole("button", { name: "Download full ZIP" });
    fireEvent.click(start); fireEvent.click(start);
    expect(build).toHaveBeenCalledTimes(1);
    const options = build.mock.calls[0][1];
    act(() => { options?.onStageProgress?.({ stage: "reading", completed: 1, total: 3, bytesRead: 512 }); });
    expect(screen.getByRole("status").textContent).toMatch(/reading/i);
    act(() => { options?.onStageProgress?.({ stage: "compressing", completed: 3, total: 3, bytesRead: 4096, percent: 42 }); });
    expect(screen.getByRole("status").textContent).toMatch(/compress|42/i);
    view.unmount();
    await act(async () => { active.resolve(result()); });
  });
});

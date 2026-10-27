import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SampleDetail } from "../shared/types";
import { ResearchPackageExport, ResearchReportLink } from "./components/ResearchPackageExport";
import { api } from "./lib/api";
import { exportSample } from "./lib/exportSample";
import { SamplePage } from "./pages/SamplePage";

vi.mock("./lib/exportSample", () => ({ exportSample: vi.fn() }));

const sample: SampleDetail = {
  id: "sample:visual", code: "VISUAL-001", title: "Shared visual sample", status: "stored", location: "Lab",
  description: "A readable sample description.", parentId: null, inheritedStateHash: null, pinned: false,
  createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z",
  latestWorkflowName: null, latestWorkflowVersion: null, latestRunStatus: null,
  currentStepTitle: null, currentStateStepTitle: null, currentStateThumbnailKey: null,
  parent: null, children: [], runs: [], events: [], stateVerifications: [], comments: [],
};
const network = vi.fn<typeof fetch>();

function DataDestination() {
  const location = useLocation();
  return <output aria-label="Review export context">{location.pathname}{location.search}</output>;
}

async function mountSample() {
  const mounted = render(<MemoryRouter initialEntries={[`/samples/${sample.id}`]}><Routes>
    <Route path="/samples/:sampleId" element={<SamplePage />} />
    <Route path="/settings/data" element={<DataDestination />} />
  </Routes></MemoryRouter>);
  const heading = await screen.findByRole("heading", { name: sample.title, level: 1 });
  return { ...mounted, header: within(heading.closest(".sample-header") as HTMLElement) };
}

beforeEach(() => {
  vi.spyOn(api, "getSample").mockResolvedValue(sample);
  vi.mocked(exportSample).mockReset().mockResolvedValue(undefined);
  network.mockReset().mockImplementation(async (path, options) => {
    if (String(path) === "/api/storage/status" && (options?.method ?? "GET") === "GET") return Response.json({
      provider: null, available: false, authentication: "not_configured", message: "File storage is not configured.",
    });
    throw new Error(`Unexpected request: ${options?.method ?? "GET"} ${path}`);
  });
  vi.stubGlobal("fetch", network);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Sample icon actions", () => {
  it("keeps all six action names and opens the original source context without starting an export", async () => {
    const { header } = await mountSample();
    const actions = [
      header.getByRole("link", { name: "Start first process" }),
      header.getByRole("button", { name: "Start metrology" }),
      header.getByRole("button", { name: "Split sample" }),
      header.getByRole("button", { name: "Export sample ZIP" }),
      header.getByRole("link", { name: "Data package" }),
      header.getByRole("link", { name: "Offline report" }),
    ];
    for (const action of actions) {
      expect(action.getAttribute("title")).toBeTruthy();
      expect(action.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
    expect(actions[0].getAttribute("href")).toBe(`/processing/${sample.id}?action=start`);
    expect(exportSample).not.toHaveBeenCalled();
    fireEvent.click(actions[4]);
    const destination = await screen.findByLabelText("Review export context");
    const url = new URL(destination.textContent!, "https://app.test");
    expect(url.pathname).toBe("/settings/data");
    expect(url.searchParams.get("rootType")).toBe("sample");
    expect(url.searchParams.get("rootId")).toBe(sample.id);
    expect(url.searchParams.get("sourceLabel")).toBe(`${sample.code} · ${sample.title}`);
    expect(url.searchParams.get("kind")).toBe("data_package");
    expect(exportSample).not.toHaveBeenCalled();
    expect(network.mock.calls.every(([, options]) => (options?.method ?? "GET") === "GET")).toBe(true);
  });

  it("keeps the package and report unavailable while the existing ZIP export is busy", async () => {
    let finishExport!: () => void;
    vi.mocked(exportSample).mockImplementation(() => new Promise<void>(resolve => { finishExport = resolve; }));
    const { header } = await mountSample();
    fireEvent.click(header.getByRole("button", { name: "Export sample ZIP" }));
    const busy = header.getByRole("button", { name: "Exporting sample ZIP" });
    expect(busy.matches(":disabled")).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    for (const name of ["Data package", "Offline report"]) {
      const action = header.getByRole("link", { name });
      expect(action.getAttribute("aria-disabled")).toBe("true");
      expect(action.hasAttribute("href")).toBe(false);
      fireEvent.click(action);
    }
    expect(exportSample).toHaveBeenCalledTimes(1);
    expect(exportSample).toHaveBeenCalledWith(sample);
    await act(async () => finishExport());
    await waitFor(() => expect(header.getByRole("link", { name: "Data package" }).hasAttribute("href")).toBe(true));
    expect(header.getByRole("link", { name: "Offline report" }).hasAttribute("href")).toBe(true);
  });

  it("keeps compact Project labels separate from the explicit mobile icon option and preserves Processing provenance", () => {
    const mounted = render(<MemoryRouter><ResearchPackageExport root={{ type: "project", id: "project:1", label: "Notebook" }} compact /></MemoryRouter>);
    expect(mounted.container.querySelector(".research-export-mobile-icon")).toBeNull();
    expect(screen.getByRole("link", { name: "Data package" }).textContent).toBe("Data package");
    expect(screen.getByRole("link", { name: "Offline report" }).textContent).toBe("Offline report");

    mounted.rerender(<MemoryRouter><ResearchReportLink root={{ type: "sample", id: sample.id, label: sample.code }}
      origin={{ type: "processing", sampleId: sample.id, runId: "run:older", additionalSampleIds: ["sample:extra"] }}
      compact mobileIconOnly /></MemoryRouter>);
    const report = screen.getByRole("link", { name: "Offline report" });
    expect(report.classList.contains("research-export-mobile-icon")).toBe(true);
    expect(report.getAttribute("title")).toContain("across its runs");
    const query = new URL(report.getAttribute("href")!, "https://app.test").searchParams;
    expect(query.get("rootId")).toBe(sample.id);
    expect(query.get("kind")).toBe("report");
    expect(query.get("from")).toBe("processing");
    expect(query.get("runId")).toBe("run:older");
    expect(query.getAll("sourceWith")).toEqual(["sample:extra"]);
    expect(exportSample).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
});

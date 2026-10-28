import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SampleDetail } from "../shared/types";
import { api } from "./lib/api";
import { SamplePage } from "./pages/SamplePage";

const sample: SampleDetail = {
  id: "sample:visual", code: "VISUAL-001", title: "Shared visual sample", status: "stored", location: "Lab",
  description: "A readable sample description.", parentId: null, inheritedStateHash: null, pinned: false,
  createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z",
  latestWorkflowName: null, latestWorkflowVersion: null, latestRunStatus: null,
  currentStepTitle: null, currentStateStepTitle: null, currentStateThumbnailKey: null,
  parent: null, children: [], runs: [], events: [], stateVerifications: [], comments: [],
};
const network = vi.fn<typeof fetch>();

function ProcessingDestination() {
  const location = useLocation();
  return <output aria-label="Processing destination">{location.pathname}{location.search}</output>;
}

async function mountSample() {
  const mounted = render(<MemoryRouter initialEntries={[`/samples/${sample.id}`]}><Routes>
    <Route path="/samples/:sampleId" element={<SamplePage />} />
    <Route path="/processing/:sampleId" element={<ProcessingDestination />} />
  </Routes></MemoryRouter>);
  const heading = await screen.findByRole("heading", { name: sample.title, level: 1 });
  return { ...mounted, header: within(heading.closest(".sample-header") as HTMLElement) };
}

beforeEach(() => {
  vi.spyOn(api, "getSample").mockResolvedValue(sample);
  vi.spyOn(api, "listMetrologyTemplates").mockResolvedValue({ templates: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 } });
  vi.spyOn(api, "startMetrologyRun").mockRejectedValue(new Error("Unexpected metrology mutation"));
  vi.spyOn(api, "splitSample").mockRejectedValue(new Error("Unexpected split mutation"));
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

function noWrites() {
  expect(api.startMetrologyRun).not.toHaveBeenCalled();
  expect(api.splitSample).not.toHaveBeenCalled();
  expect(network.mock.calls.every(([, options]) => (options?.method ?? "GET") === "GET")).toBe(true);
}

describe("Sample core work actions", () => {
  it("names the three work actions and opens Processing directly without transfer controls", async () => {
    const { header } = await mountSample();
    const actions = [
      header.getByRole("link", { name: "Start first process" }),
      header.getByRole("button", { name: "Start metrology" }),
      header.getByRole("button", { name: "Split sample" }),
    ];
    for (const action of actions) {
      expect(action.getAttribute("title")).toBeTruthy();
      expect(action.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
    expect(header.getAllByRole("link")).toHaveLength(1);
    expect(header.getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByRole("link", { name: /export|report|package/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /export|report|package/i })).toBeNull();
    fireEvent.click(actions[0]);
    expect((await screen.findByLabelText("Processing destination")).textContent).toBe(`/processing/${sample.id}?action=start`);
    noWrites();
  });

  it("opens and cancels split preparation in the page without saving", async () => {
    const { header } = await mountSample();
    fireEvent.click(header.getByRole("button", { name: "Split sample" }));
    expect(await screen.findByRole("dialog", { name: `${sample.code} · ${sample.title}` })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: /^Initial location for new pieces/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close split dialog" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    noWrites();
  });

  it("opens metrology selection in the page and requires a deliberate start", async () => {
    const { header } = await mountSample();
    fireEvent.click(header.getByRole("button", { name: "Start metrology" }));
    expect(await screen.findByRole("dialog", { name: "Choose a metrology template" })).toBeTruthy();
    await waitFor(() => expect(api.listMetrologyTemplates).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    noWrites();
  });
});

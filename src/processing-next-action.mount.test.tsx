import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SampleSummary } from "../shared/types";
import { api } from "./lib/api";
import { ProcessingPage } from "./pages/ProcessingPage";

const at = "2026-10-27T10:00:00.000Z";
const network = vi.fn<typeof fetch>();

function sample(overrides: Partial<SampleSummary>): SampleSummary {
  return {
    id: "sample-next", code: "NEXT-001", title: "Next action sample", status: "active",
    location: "Lab", parentId: null, inheritedStateHash: null, pinned: false,
    createdAt: at, updatedAt: at, latestWorkflowName: "Coating", latestWorkflowVersion: 1,
    latestRunStatus: null, currentStepTitle: null, currentStateStepTitle: null, currentStateThumbnailKey: null,
    ...overrides,
  };
}

beforeEach(() => {
  network.mockReset(); network.mockRejectedValue(new Error("Unexpected network request"));
  vi.stubGlobal("fetch", network);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Processing directory next action", () => {
  it.each([
    { name: "continues the actual next step of an active run", status: "active", step: "Strip resist", expected: "Next · Strip resist" },
    { name: "asks for review when an active run has no next-step information", status: "active", step: null, expected: "Review active process" },
    { name: "offers completed results despite a retained step title", status: "complete", step: "Old step", expected: "View completed results" },
    { name: "offers cancelled history despite a retained step title", status: "cancelled", step: "Old step", expected: "Review history or choose a new process" },
    { name: "offers superseded history despite a retained step title", status: "superseded", step: "Old step", expected: "Review history or choose a new process" },
    { name: "starts the first process when there is no run", status: null, step: null, expected: "Open to start the first process" },
    { name: "does not advertise a leftover step without a process run", status: null, step: "Old step", expected: "Open to start the first process" },
  ] as const)("$name", async ({ status, step, expected }) => {
    // The sample's metadata status is independent of its process-run status.
    const value = sample({ latestRunStatus: status, currentStepTitle: step, status: status === "active" ? "stored" : "active" });
    const read = vi.spyOn(api, "listSamples").mockResolvedValue({ samples: [value],
      pagination: { page: 2, pageSize: 50, total: 51, totalPages: 2 },
      facets: { active: 1, complete: 1, cancelled: 1, all: 51 } });
    render(<MemoryRouter initialEntries={["/processing?status=all&q=retained&page=2"]}><ProcessingPage /></MemoryRouter>);
    const row = (await screen.findByText(value.code)).closest<HTMLAnchorElement>("a")!;
    expect(within(row).getByText(expected)).toBeTruthy();
    expect(row.getAttribute("href")).toBe("/processing/sample-next");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0]).toMatchObject({ view: "processing", status: "all", query: "retained", page: 2, pageSize: 50 });
    expect(network).not.toHaveBeenCalled();
    if (status !== "active") expect(within(row).queryByText(/^Next ·/)).toBeNull();
    if (status === "active" && step === null) expect(within(row).queryByText(/start.*process/i)).toBeNull();
  });
});

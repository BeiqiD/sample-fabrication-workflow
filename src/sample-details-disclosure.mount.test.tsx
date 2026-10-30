import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SampleDetail } from "../shared/types";
import { api } from "./lib/api";
import { SamplePage } from "./pages/SamplePage";

const sample: SampleDetail = {
  id: "sample-details", code: "DETAILS-001", title: "Sample identity stays visible", status: "stored", location: "Lab B",
  description: "Purpose and structure\nA second line of sample context.", parentId: null, inheritedStateHash: null, pinned: false,
  createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z",
  latestWorkflowName: null, latestWorkflowVersion: null, latestRunStatus: null,
  currentStepTitle: null, currentStateStepTitle: null, currentStateThumbnailKey: null,
  parent: null, children: [], runs: [], events: [], stateVerifications: [], comments: [],
};
const mediaListeners = new Set<() => void>();
const mobileMedia = {
  matches: true,
  addEventListener: (_event: string, listener: () => void) => mediaListeners.add(listener),
  removeEventListener: (_event: string, listener: () => void) => mediaListeners.delete(listener),
};

async function mountSample() {
  const mounted = render(<MemoryRouter initialEntries={[`/samples/${sample.id}`]}><Routes>
    <Route path="/samples/:sampleId" element={<SamplePage />} />
  </Routes></MemoryRouter>);
  await screen.findByRole("heading", { name: sample.title, level: 1 });
  return mounted;
}

function detailsPanel() {
  return document.getElementById("sample-details-panel")!;
}

function openDetails() {
  fireEvent.click(screen.getByRole("button", { name: "Show full sample details" }));
  return within(detailsPanel());
}

beforeEach(() => {
  mobileMedia.matches = true;
  mediaListeners.clear();
  vi.stubGlobal("matchMedia", vi.fn((query: string) => query === "(max-width: 720px)"
    ? mobileMedia
    : { matches: false }));
  vi.spyOn(api, "getSample").mockResolvedValue(sample);
  vi.spyOn(api, "updateSample").mockRejectedValue(new Error("Unexpected sample update"));
  vi.spyOn(api, "deleteSample").mockRejectedValue(new Error("Unexpected sample deletion"));
  vi.stubGlobal("fetch", vi.fn(async (path) => {
    if (String(path) === "/api/storage/status") return Response.json({
      provider: null, available: false, authentication: "not_configured", message: "File storage is not configured.",
    });
    throw new Error(`Unexpected request: ${path}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Sample details disclosure", () => {
  it("keeps mobile identity and daily work available before progressively revealed metadata", async () => {
    await mountSample();
    const header = within(screen.getByRole("heading", { name: sample.title }).closest(".sample-header") as HTMLElement);
    expect(header.getByText(sample.code)).toBeTruthy();
    expect(header.getByText(sample.location!)).toBeTruthy();
    expect(header.getByText("stored")).toBeTruthy();
    expect(detailsPanel().hidden).toBe(true);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Current structure" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Notes & observations" })).toBeTruthy();
    const priority = document.querySelector(".sample-priority-grid")!;
    expect(priority.children[0].matches(".sample-current-structure")).toBe(true);
    expect(priority.children[1].matches(".sample-notes-slot")).toBe(true);
    expect(priority.children[2].matches(".sample-details-card")).toBe(true);

    const details = openDetails();
    expect(detailsPanel().hidden).toBe(false);
    expect([...detailsPanel().querySelectorAll("dt")].map((element) => element.textContent)).toEqual([
      "Sample code", "Sample name", "Status", "Location", "Description", "Pinned", "Parent", "Children", "Created",
    ]);
    expect(details.getByText(/Purpose and structure/).textContent).toBe(sample.description);
    expect(screen.getByRole("button", { name: "Hide full sample details" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("blocks collapsing an edit, then cancels locally without changing the saved values", async () => {
    await mountSample();
    const details = openDetails();
    fireEvent.click(details.getByRole("button", { name: "Edit" }));
    fireEvent.change(details.getByRole("textbox", { name: "Sample name" }), { target: { value: "Unsaved name" } });
    fireEvent.change(details.getByRole("textbox", { name: "Description" }), { target: { value: "Unsaved context" } });
    const collapse = screen.getByRole("button", { name: "Hide full sample details" }) as HTMLButtonElement;
    expect(collapse.disabled).toBe(true);
    fireEvent.click(collapse);
    expect(detailsPanel().hidden).toBe(false);
    expect((details.getByRole("textbox", { name: "Sample name" }) as HTMLInputElement).value).toBe("Unsaved name");
    expect(detailsPanel().querySelector(".sample-details-view")?.getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(details.getByRole("button", { name: "Cancel" }));
    expect(collapse.disabled).toBe(false);
    expect(detailsPanel().hidden).toBe(false);
    expect(details.getByText(sample.title)).toBeTruthy();
    fireEvent.click(details.getByRole("button", { name: "Edit" }));
    expect((details.getByRole("textbox", { name: "Sample name" }) as HTMLInputElement).value).toBe(sample.title);
    expect((details.getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement).value).toBe(sample.description);
    expect(api.updateSample).not.toHaveBeenCalled();
  });

  it("keeps the panel and draft available through a pending and failed save", async () => {
    let rejectSave!: (error: Error) => void;
    vi.mocked(api.updateSample).mockReturnValue(new Promise((_resolve, reject) => { rejectSave = reject; }));
    await mountSample();
    const details = openDetails();
    fireEvent.click(details.getByRole("button", { name: "Edit" }));
    fireEvent.change(details.getByRole("textbox", { name: "Sample name" }), { target: { value: "Draft name" } });
    fireEvent.submit(detailsPanel().querySelector("form")!);

    expect((details.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Hide full sample details" }) as HTMLButtonElement).disabled).toBe(true);
    expect(details.getByRole("button", { name: "Saving…" })).toBeTruthy();
    await act(async () => { rejectSave(new Error("Sample changed elsewhere. Reload before saving.")); });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Sample changed elsewhere. Reload before saving.");
    expect(detailsPanel().hidden).toBe(false);
    expect((details.getByRole("textbox", { name: "Sample name" }) as HTMLInputElement).value).toBe("Draft name");
    expect((details.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(false);
    expect(api.getSample).toHaveBeenCalledTimes(1);
  });

  it("saves the original payload contract, refreshes identity, and keeps details open", async () => {
    const updated = { ...sample, title: "Saved name", location: "Box 8", description: "Saved context", pinned: true };
    vi.mocked(api.updateSample).mockResolvedValue({ ok: true, updatedAt: sample.updatedAt });
    vi.mocked(api.getSample).mockResolvedValueOnce(sample).mockResolvedValue(updated);
    await mountSample();
    const details = openDetails();
    fireEvent.click(details.getByRole("button", { name: "Edit" }));
    fireEvent.change(details.getByRole("textbox", { name: "Sample name" }), { target: { value: updated.title } });
    fireEvent.change(details.getByRole("textbox", { name: "Location" }), { target: { value: updated.location } });
    fireEvent.change(details.getByRole("textbox", { name: "Description" }), { target: { value: updated.description } });
    fireEvent.click(details.getByRole("checkbox", { name: "Pinned" }));
    fireEvent.submit(detailsPanel().querySelector("form")!);
    await screen.findByRole("heading", { name: updated.title, level: 1 });
    expect(api.updateSample).toHaveBeenCalledWith(sample.id, {
      title: updated.title, status: sample.status, location: updated.location, description: updated.description,
      pinned: true, expectedUpdatedAt: sample.updatedAt,
    });
    expect(detailsPanel().hidden).toBe(false);
    expect(details.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("blocks sample deletion while editing and throughout a deferred save and refresh, then restores it", async () => {
    let resolveSave!: (result: { ok: true; updatedAt: string }) => void;
    let resolveRefresh!: (result: SampleDetail) => void;
    vi.mocked(api.updateSample).mockReturnValue(new Promise((resolve) => { resolveSave = resolve; }));
    vi.mocked(api.getSample).mockResolvedValueOnce(sample).mockReturnValueOnce(new Promise((resolve) => { resolveRefresh = resolve; }));
    await mountSample();
    const details = openDetails();
    const deleteButton = screen.getByRole("button", { name: "Delete sample" }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(false);

    fireEvent.click(details.getByRole("button", { name: "Edit" }));
    expect(deleteButton.disabled).toBe(true);
    fireEvent.click(deleteButton);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(details.getByRole("button", { name: "Cancel" }));
    expect(deleteButton.disabled).toBe(false);

    fireEvent.click(details.getByRole("button", { name: "Edit" }));
    fireEvent.submit(detailsPanel().querySelector("form")!);
    await waitFor(() => expect(api.updateSample).toHaveBeenCalledTimes(1));
    expect(deleteButton.disabled).toBe(true);
    fireEvent.click(deleteButton);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.deleteSample).not.toHaveBeenCalled();

    await act(async () => { resolveSave({ ok: true, updatedAt: sample.updatedAt }); });
    expect(details.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(detailsPanel().querySelector("form")).toBeNull();
    expect(deleteButton.disabled).toBe(true);
    fireEvent.click(deleteButton);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.deleteSample).not.toHaveBeenCalled();

    await act(async () => { resolveRefresh(sample); });
    await waitFor(() => expect(deleteButton.disabled).toBe(false));
    fireEvent.click(deleteButton);
    const dialog = await screen.findByRole("alertdialog", { name: `Delete ${sample.code}?` });
    expect(within(dialog).getByRole("textbox", { name: `Type ${sample.code} to confirm` })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.deleteSample).not.toHaveBeenCalled();
  });

  it("shows details immediately on desktop and reveals a collapsed mobile panel on resize", async () => {
    mobileMedia.matches = false;
    const mounted = await mountSample();
    expect(detailsPanel().hidden).toBe(false);
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    mounted.unmount();

    mobileMedia.matches = true;
    await mountSample();
    expect(detailsPanel().hidden).toBe(true);
    act(() => {
      mobileMedia.matches = false;
      for (const listener of mediaListeners) listener();
    });
    expect(detailsPanel().hidden).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Sample name" }), { target: { value: "Still editing" } });
    act(() => {
      mobileMedia.matches = true;
      for (const listener of mediaListeners) listener();
    });
    expect(detailsPanel().hidden).toBe(false);
    expect((screen.getByRole("textbox", { name: "Sample name" }) as HTMLInputElement).value).toBe("Still editing");
  });

  it("keeps sample deletion after history with its existing confirmation and cancel behavior", async () => {
    await mountSample();
    const danger = screen.getByRole("region", { name: "Delete sample" });
    expect(danger.previousElementSibling?.className).toBe("sample-secondary-grid");
    const deleteButton = within(danger).getByRole("button", { name: "Delete sample" });
    deleteButton.focus();
    fireEvent.click(deleteButton);
    const dialog = await screen.findByRole("alertdialog", { name: `Delete ${sample.code}?` });
    expect(within(dialog).getByRole("textbox", { name: `Type ${sample.code} to confirm` })).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Permanently delete" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(deleteButton);
    expect(api.deleteSample).not.toHaveBeenCalled();
  });
});

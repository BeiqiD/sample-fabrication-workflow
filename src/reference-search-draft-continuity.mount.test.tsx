// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReferenceSearchSurface } from "./components/ReferenceSearchSurface";
import { defaultReferenceSearchUiState, type ReferenceSearchUiState } from "./lib/reference-search-ui";

function PanelHarness({ initialQuery = "", onCommit }: {
  initialQuery?: string;
  onCommit: (value: ReferenceSearchUiState) => void;
}) {
  const [value, setValue] = useState<ReferenceSearchUiState>(() => ({ ...defaultReferenceSearchUiState(), query: initialQuery }));
  const [draft, setDraft] = useState<ReferenceSearchUiState>(() => ({ ...defaultReferenceSearchUiState(), query: initialQuery }));
  const [open, setOpen] = useState(true);
  return <>
    <button type="button" onClick={() => setOpen((current) => !current)}>{open ? "Close panel" : "Reopen panel"}</button>
    {open && <ReferenceSearchSurface
      mode="place"
      value={value}
      onChange={(next) => { onCommit(next); setValue(next); }}
      draftState={{ value: draft, onChange: setDraft }}
      onPlaceAtCenter={() => undefined}
    />}
  </>;
}

function editFilters({ sampleId, from, to }: { sampleId: string; from: string; to: string }) {
  fireEvent.click(screen.getByRole("button", { name: /^More filters/ }));
  fireEvent.change(screen.getByLabelText(/Sample stable ID/), { target: { value: sampleId } });
  fireEvent.change(screen.getByLabelText(/Updated from/), { target: { value: from } });
  fireEvent.change(screen.getByLabelText(/Updated to/), { target: { value: to } });
}

function remountPanel() {
  fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
  expect(screen.queryByRole("searchbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reopen panel" }));
}

describe("real ReferenceSearchSurface draft continuity", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((_path, init) => {
      const input = JSON.parse(String(init?.body));
      return Promise.resolve(new Response(JSON.stringify({ query: input.query, results: [], truncated: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("retains unsubmitted query and advanced filters across a panel remount without searching until Apply", async () => {
    const onCommit = vi.fn();
    render(<MemoryRouter><PanelHarness onCommit={onCommit} /></MemoryRouter>);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "  GeSn draft  " } });
    editFilters({ sampleId: "sample-draft", from: "2026-09-01", to: "2026-09-11" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    remountPanel();
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("  GeSn draft  ");
    fireEvent.click(screen.getByRole("button", { name: /^More filters/ }));
    expect((screen.getByLabelText(/Sample stable ID/) as HTMLInputElement).value).toBe("sample-draft");
    expect((screen.getByLabelText(/Updated from/) as HTMLInputElement).value).toBe("2026-09-01");
    expect((screen.getByLabelText(/Updated to/) as HTMLInputElement).value).toBe("2026-09-11");
    expect(onCommit).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByRole("heading", { name: "No matching references" });
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith({ ...defaultReferenceSearchUiState(), query: "GeSn draft", sampleId: "sample-draft", from: "2026-09-01", to: "2026-09-11" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/references/search");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "GeSn draft",
      sampleId: "sample-draft", from: "2026-09-01T00:00:00.000Z", to: "2026-09-11T23:59:59.999Z",
    });
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("GeSn draft");
  });

  it("keeps a newer draft separate from the existing committed search when remounting", async () => {
    const onCommit = vi.fn();
    render(<MemoryRouter><PanelHarness initialQuery="committed query" onCommit={onCommit} /></MemoryRouter>);
    await screen.findByRole("heading", { name: "No matching references" });
    expect(fetchMock).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "next draft" } });
    editFilters({ sampleId: "sample-next", from: "2026-09-02", to: "2026-09-10" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();

    remountPanel();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("next draft");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ query: "committed query" });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).not.toHaveProperty("sampleId");
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(onCommit).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
      query: "next draft", sampleId: "sample-next", from: "2026-09-02T00:00:00.000Z", to: "2026-09-10T23:59:59.999Z",
    });
    await screen.findByRole("heading", { name: "No matching references" });
  });
});

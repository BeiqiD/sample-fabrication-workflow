// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSnapshot } from "../shared/project-api";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshotWithAttachment } from "./project-test-fixture";

vi.mock("./components/ReferenceSearchSurface", () => ({ ReferenceSearchSurface: () => null }));
vi.mock("./components/project/ProjectMapSurface", async () => {
  const React = await import("react");
  return {
    ProjectMapSurface: React.forwardRef((props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 400, y: 300 }) }));
      return <div
        data-testid="inspector-session-map"
        data-selected-item={props.selectedItemId ?? ""}
        data-selected-edge={props.selectedEdgeId ?? ""}
        data-has-markdown-editor={Boolean(props.markdownEditor)}
        data-has-edge-editor={Boolean(props.edgeEditor)}
      >
        <button onClick={() => props.onEdgeSelect("edge-a")}>Select fixture edge</button>
        <button onClick={() => props.contextCommands.openReferences()}>Open fixture References command</button>
        <output aria-label="Map note preview">{props.nodes.find((node: any) => node.itemId === "item-note")?.markdownSource}</output>
        <output aria-label="Map edge markers">{props.edges.map((edge: any) => `${edge.markerStart}/${edge.markerEnd}`).join(",")}</output>
      </div>;
    }),
  };
});

function fixture(): ProjectSnapshot {
  const snapshot = projectTestSnapshotWithAttachment();
  snapshot.edges = [{
    id: "edge-a", projectId: snapshot.project.id,
    sourceItemId: "item-note", targetItemId: "item-reference",
    sourceHandle: "right", targetHandle: "left",
    markerStart: "none", markerEnd: "arrow", label: "Feeds", revision: 4,
    createdBy: "user@example.com", updatedBy: "user@example.com",
    createdAt: "2026-09-12T10:00:00.000Z", updatedAt: "2026-09-12T10:00:00.000Z",
    deletedAt: null, deletedBy: null,
  }];
  return snapshot;
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function page(itemId = "item-note") {
  const router = createMemoryRouter([
    { path: "/projects/:projectId", element: <ProjectPage /> },
  ], { initialEntries: [`/projects/project-a?focus=${itemId}`] });
  render(<RouterProvider router={router} />);
}

async function inspector(itemId = "item-note") {
  page(itemId);
  await screen.findByTestId("inspector-session-map");
  fireEvent.click(screen.getByRole("button", { name: "Inspector" }));
  return screen.getByRole("complementary", { name: "Project Inspector" });
}

function clickEdit(panel: HTMLElement, label: string) {
  const trigger = within(panel).getByRole("button", { name: label });
  trigger.focus();
  fireEvent.click(trigger);
}

const fetchMock = vi.fn<typeof fetch>();
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");

beforeAll(async () => {
  await Promise.all([
    import("./components/project/ProjectMarkdownEditor"),
    import("./components/project/ProjectReadingSurface"),
  ]);
});
beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 860px)", media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async () => response(fixture()));
});
afterEach(() => { cleanup(); fetchMock.mockReset(); vi.unstubAllGlobals(); });

describe("Inspector edit sessions through ProjectPage", () => {
  it.each([
    ["Markdown", "item-note", "Edit Markdown", "Inspector Markdown editor"],
    ["attachment", "item-attachment", "Edit metadata", "Caption"],
    ["edge", "item-note", "Edit edge", "Label"],
  ])("exits an untouched %s edit with Escape while preserving the panel, selection and Edit focus", async (kind, itemId, editLabel, fieldLabel) => {
    const panel = await inspector(itemId);
    if (kind === "edge") fireEvent.click(screen.getByRole("button", { name: "Select fixture edge" }));
    const trigger = within(panel).getByRole("button", { name: editLabel });
    trigger.focus();
    fireEvent.click(trigger);
    const field = await within(panel).findByLabelText(fieldLabel);
    const map = screen.getByTestId("inspector-session-map");
    expect(map.getAttribute("data-has-markdown-editor")).toBe("false");
    expect(map.getAttribute("data-has-edge-editor")).toBe("false");
    expect(within(panel).getByRole("button", { name: "Cancel" }).getAttribute("aria-keyshortcuts")).toBe("Escape");
    expect(within(panel).getByRole("button", { name: "Cancel" }).textContent).toBe("Cancel");
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(within(panel).queryByLabelText(fieldLabel)).toBeNull());
    expect(screen.getByRole("complementary", { name: "Project Inspector" })).toBe(panel);
    expect(map.getAttribute(kind === "edge" ? "data-selected-edge" : "data-selected-item"))
      .toBe(kind === "edge" ? "edge-a" : itemId);
    await waitFor(() => expect(document.activeElement).toBe(within(panel).getByRole("button", { name: editLabel })));
    expect(writes()).toHaveLength(0);
  });

  it("saves Markdown in the Inspector, updates both previews and returns focus locally", async () => {
    const snapshot = fixture();
    fetchMock.mockImplementation(async (_path, init) => {
      if (!init?.method) return response(snapshot);
      const input = JSON.parse(String(init.body));
      return response({ value: { ...snapshot.contents[0], markdownSource: input.markdownSource, revision: 2 }, replayed: false });
    });
    const panel = await inspector();
    clickEdit(panel, "Edit Markdown");
    const field = await within(panel).findByLabelText("Inspector Markdown editor");
    fireEvent.change(field, { target: { value: "# Revised locally\n\nUpdated evidence." } });
    const helpTrigger = screen.getByRole("button", { name: "Keyboard shortcuts" });
    helpTrigger.focus();
    fireEvent.click(helpTrigger);
    const help = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    fireEvent.keyDown(help, { key: "s", ctrlKey: true });
    expect(writes()).toHaveLength(0);
    expect((field as HTMLTextAreaElement).value).toBe("# Revised locally\n\nUpdated evidence.");
    fireEvent.keyDown(help, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull());
    expect(document.activeElement).toBe(helpTrigger);
    expect(within(panel).getByLabelText("Inspector Markdown editor")).toBe(field);
    fireEvent.keyDown(field, { key: "s", ctrlKey: true });
    await within(panel).findByRole("heading", { name: "Revised locally" });
    expect(screen.getByLabelText("Map note preview").textContent).toContain("Updated evidence.");
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe("/api/projects/project-a/contents/content-note/markdown");
    expect(JSON.parse(String(writes()[0][1]?.body))).toMatchObject({ expectedRevision: 1, markdownSource: "# Revised locally\n\nUpdated evidence." });
    await waitFor(() => expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Edit Markdown" })));
    expect(screen.getByRole("status", { name: "Project save status" }).textContent).toBe("Saved");
  });

  it("keeps attachment fields and Save together, then uses the panel close icon to cancel a later edit", async () => {
    const snapshot = fixture();
    const content = snapshot.contents.find((value) => value.id === "content-attachment")!;
    fetchMock.mockImplementation(async (_path, init) => {
      if (!init?.method) return response(snapshot);
      const input = JSON.parse(String(init.body));
      return response({ value: { ...content, attachmentCaption: input.caption, attachmentSourceUrl: input.sourceUrl, revision: 2 }, replayed: false });
    });
    const panel = await inspector("item-attachment");
    clickEdit(panel, "Edit metadata");
    fireEvent.change(within(panel).getByLabelText("Caption"), { target: { value: "Updated attachment evidence" } });
    fireEvent.change(within(panel).getByLabelText("Source URL"), { target: { value: "https://example.com/evidence" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save metadata" }));
    await within(panel).findByText("Updated attachment evidence");
    expect(within(panel).getByRole("link", { name: "Open source URL" }).getAttribute("href")).toBe("https://example.com/evidence");
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(String(writes()[0][1]?.body))).toMatchObject({ expectedRevision: 1, caption: "Updated attachment evidence", sourceUrl: "https://example.com/evidence" });
    await waitFor(() => expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Edit metadata" })));

    clickEdit(panel, "Edit metadata");
    fireEvent.change(within(panel).getByLabelText("Caption"), { target: { value: "Discard this edit" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Cancel editing" }));
    expect(within(panel).queryByLabelText("Caption")).toBeNull();
    expect(within(panel).getByRole("region", { name: "Inspector content preview" }).textContent).toBe("Updated attachment evidence");
    expect(screen.getByRole("complementary", { name: "Project Inspector" })).toBe(panel);
    expect(writes()).toHaveLength(1);
  });

  it("saves an icon direction choice with the matching edge markers and retains edge selection", async () => {
    const snapshot = fixture();
    fetchMock.mockImplementation(async (_path, init) => {
      if (!init?.method) return response(snapshot);
      const input = JSON.parse(String(init.body));
      return response({ value: { ...snapshot.edges[0], markerStart: input.markerStart, markerEnd: input.markerEnd, label: input.label, revision: 5 }, replayed: false });
    });
    const panel = await inspector();
    fireEvent.click(screen.getByRole("button", { name: "Select fixture edge" }));
    clickEdit(panel, "Edit edge");
    const directions = within(panel).getByRole("radiogroup", { name: "Edge direction" });
    expect(within(directions).getAllByRole("radio")).toHaveLength(4);
    expect(within(panel).queryByRole("combobox")).toBeNull();
    fireEvent.click(within(directions).getByRole("radio", { name: "Target to source" }));
    fireEvent.change(within(panel).getByLabelText("Label"), { target: { value: "Returns" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save edge" }));
    await within(panel).findByRole("heading", { name: "Returns" });
    await waitFor(() => expect(within(panel).queryByLabelText("Label")).toBeNull());
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe("/api/projects/project-a/edges/edge-a");
    expect(JSON.parse(String(writes()[0][1]?.body))).toMatchObject({ expectedRevision: 4, markerStart: "arrow", markerEnd: "none", label: "Returns" });
    expect(screen.getByLabelText("Map edge markers").textContent).toBe("arrow/none");
    expect(screen.getByTestId("inspector-session-map").getAttribute("data-selected-edge")).toBe("edge-a");
    await waitFor(() => expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Edit edge" })));
  });

  it("keeps saving and uncertain Markdown guarded against Escape and retries the exact request", async () => {
    const snapshot = fixture();
    let rejectSave: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation(async (_path, init) => {
      if (!init?.method) return response(snapshot);
      if (writes().length === 1) return new Promise<Response>((resolve) => { rejectSave = resolve; });
      const input = JSON.parse(String(init.body));
      return response({ value: { ...snapshot.contents[0], markdownSource: input.markdownSource, revision: 2 }, replayed: true });
    });
    const panel = await inspector();
    clickEdit(panel, "Edit Markdown");
    const field = await within(panel).findByLabelText("Inspector Markdown editor") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "# Confirm my save" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save Markdown" }));
    await waitFor(() => expect(rejectSave).toBeTypeOf("function"));
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(field.disabled).toBe(true);
    expect((within(panel).getByRole("button", { name: "Cancel editing" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(panel).queryByRole("button", { name: "Cancel" })).toBeNull();
    await act(async () => { rejectSave!(response({ error: "Response unavailable" }, 503)); });
    await within(panel).findByText("Response unavailable");
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(within(panel).getByLabelText("Inspector Markdown editor")).toBe(field);
    expect(field.value).toBe("# Confirm my save");
    expect(field.disabled).toBe(true);
    fireEvent.click(within(panel).getByRole("button", { name: "Retry exact save" }));
    await within(panel).findByRole("heading", { name: "Confirm my save" });
    expect(writes()).toHaveLength(2);
    expect(JSON.parse(String(writes()[1][1]?.body))).toEqual(JSON.parse(String(writes()[0][1]?.body)));
  });

  it("keeps a conflicted edge draft available for explicit reload when Escape is pressed", async () => {
    const snapshot = fixture();
    fetchMock.mockImplementation(async (_path, init) => init?.method
      ? response({ error: "Edge revision changed" }, 409)
      : response(snapshot));
    const panel = await inspector();
    fireEvent.click(screen.getByRole("button", { name: "Select fixture edge" }));
    clickEdit(panel, "Edit edge");
    const field = within(panel).getByLabelText("Label") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "My stale relationship" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save edge" }));
    await within(panel).findByText("Edge revision changed");
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(within(panel).getByLabelText("Label")).toBe(field);
    expect(field.value).toBe("My stale relationship");
    expect(field.disabled).toBe(true);
    expect((within(panel).getByRole("button", { name: "Cancel editing" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(panel).getByRole("button", { name: "Reload Project" })).toBeTruthy();
    expect(writes()).toHaveLength(1);
  });

  it("hosts attachment edits opened from Reading details entirely inside the Inspector", async () => {
    page("item-attachment");
    fireEvent.click(await screen.findByRole("button", { name: "Reading" }));
    fireEvent.click(await screen.findByRole("button", { name: "Details for evidence.pdf" }));
    const panel = screen.getByRole("complementary", { name: "Project Inspector" });
    clickEdit(panel, "Edit metadata");
    const caption = within(panel).getByLabelText("Caption");
    expect(screen.queryByLabelText("Reading attachment caption")).toBeNull();
    expect(within(panel).getByRole("button", { name: "Save metadata" })).toBeTruthy();
    expect(within(panel).queryByRole("link", { name: "Open attachment" })).toBeNull();
    expect(within(panel).queryByText("Details", { selector: "summary" })).toBeNull();
    fireEvent.keyDown(caption, { key: "Escape" });
    await waitFor(() => expect(within(panel).queryByLabelText("Caption")).toBeNull());
    expect(within(panel).getByRole("link", { name: "Open attachment" })).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });

  it("cancels an editable Inspector draft from the toolbar toggle without hiding the panel", async () => {
    const panel = await inspector();
    clickEdit(panel, "Edit Markdown");
    const field = await within(panel).findByLabelText("Inspector Markdown editor");
    fireEvent.change(field, { target: { value: "Discard locally through toolbar" } });
    fireEvent.click(screen.getByRole("button", { name: "Inspector" }));
    await waitFor(() => expect(within(panel).queryByLabelText("Inspector Markdown editor")).toBeNull());
    expect(screen.getByRole("complementary", { name: "Project Inspector" })).toBe(panel);
    expect(screen.getByTestId("inspector-session-map").getAttribute("data-selected-item")).toBe("item-note");
    expect(screen.getByLabelText("Map note preview").textContent).toContain("Preserve the occurrence identity.");
    expect(writes()).toHaveLength(0);
  });

  it("cannot replace a narrow-screen Inspector draft with References or hide an in-flight save", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(min-width: 860px)" || query === "(max-width: 1180px)",
      media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    const snapshot = fixture();
    let acknowledge: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation(async (_path, init) => !init?.method
      ? response(snapshot)
      : new Promise<Response>((resolve) => { acknowledge = resolve; }));
    const panel = await inspector();
    clickEdit(panel, "Edit Markdown");
    const field = await within(panel).findByLabelText("Inspector Markdown editor");
    const references = screen.getByRole("button", { name: "References" }) as HTMLButtonElement;
    expect(references.disabled).toBe(true);
    fireEvent.click(references);
    fireEvent.click(screen.getByRole("button", { name: "Open fixture References command" }));
    expect(screen.queryByRole("complementary", { name: "References" })).toBeNull();
    expect(within(panel).getByLabelText("Inspector Markdown editor")).toBe(field);
    fireEvent.change(field, { target: { value: "# Keep the in-flight editor" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save Markdown" }));
    await waitFor(() => expect(acknowledge).toBeTypeOf("function"));
    const toggle = screen.getByRole("button", { name: "Inspector" }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    fireEvent.click(toggle);
    fireEvent.click(references);
    fireEvent.click(screen.getByRole("button", { name: "Open fixture References command" }));
    expect(screen.getByRole("complementary", { name: "Project Inspector" })).toBe(panel);
    expect(within(panel).getByLabelText("Inspector Markdown editor")).toBe(field);
    expect(screen.queryByRole("complementary", { name: "References" })).toBeNull();
    await act(async () => { acknowledge!(response({ value: { ...snapshot.contents[0], markdownSource: "# Keep the in-flight editor", revision: 2 }, replayed: false })); });
    await within(panel).findByRole("heading", { name: "Keep the in-flight editor" });
    expect(writes()).toHaveLength(1);
  });

  it("cancels a mobile Inspector draft on Escape before closing its modal sheet", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Details for Design note" }));
    const sheet = await screen.findByRole("dialog", { name: "Project Inspector" });
    const panel = within(sheet).getByRole("complementary", { name: "Project Inspector" });
    clickEdit(panel, "Edit Markdown");
    const field = await within(panel).findByLabelText("Inspector Markdown editor");
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(within(panel).queryByLabelText("Inspector Markdown editor")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Project Inspector" })).toBe(sheet);
    await waitFor(() => expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Edit Markdown" })));
    expect(writes()).toHaveLength(0);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Project Inspector" })).toBeNull());
    expect(screen.queryByTestId("inspector-session-map")).toBeNull();
  });
});

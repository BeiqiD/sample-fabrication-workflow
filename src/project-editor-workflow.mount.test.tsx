// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSnapshot } from "../shared/project-api";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/ReferenceSearchSurface", () => ({ ReferenceSearchSurface: () => null }));
vi.mock("./components/project/ProjectMapSurface", async () => {
  const React = await import("react");
  const { default: Editor } = await import("./components/project/ProjectMarkdownEditor");
  return { ProjectMapSurface: React.forwardRef((props: any, ref: any) => {
    React.useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 400, y: 300 }) }));
    return <div>
      <button onClick={() => props.onMarkdownEditRequest("item-note")}>Edit test note</button>
      <button onClick={() => {
        const node = props.nodes.find((value: any) => value.itemId === "item-note");
        props.onGeometryCommit({ placementId: node.placementId, before: node.geometry, after: { ...node.geometry, x: 123 } });
      }}>Move test note</button>
      {props.markdownEditor && <Editor editor={props.markdownEditor} ariaLabel="Map draft" compact onChange={props.onMarkdownChange} onSave={props.onMarkdownSave} onCancel={props.onMarkdownCancel} />}
    </div>;
  }) };
});

function snapshotWithAttachment(): ProjectSnapshot {
  const snapshot = projectTestSnapshot();
  const actor = "user@example.com";
  const createdAt = "2026-08-11T08:00:00.000Z";
  const caption = "Full attachment caption ".repeat(14).trim();
  snapshot.contents.push({
    id: "content-attachment",
    projectId: "project-a",
    contentType: "attachment",
    markdownSource: null,
    attachmentCaption: caption,
    attachmentSourceUrl: "https://example.com/source",
    formatVersion: 1,
    revision: 1,
    createdBy: actor,
    updatedBy: actor,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    deletedBy: null,
  });
  snapshot.attachments.push({
    projectContentId: "content-attachment",
    originalName: "result.pdf",
    mimeType: "application/pdf",
    byteSize: 12,
    createdBy: actor,
    createdAt: createdAt,
    fileUrl: "/api/projects/project-a/contents/content-attachment/file",
  });
  snapshot.items.push({
    id: "item-attachment",
    projectId: "project-a",
    itemType: "content",
    projectContentId: "content-attachment",
    referenceTargetId: null,
    createdSequence: 3,
    revision: 1,
    createdBy: actor,
    updatedBy: actor,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    deletedBy: null,
  });
  snapshot.placements.push({
    id: "placement-attachment",
    projectItemId: "item-attachment",
    x: 600,
    y: 40,
    width: 360,
    height: 260,
    zIndex: 2,
    revision: 1,
    createdBy: actor,
    updatedBy: actor,
    createdAt,
    updatedAt: createdAt,
  });
  return snapshot;
}


function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}
function page() {
  const router = createMemoryRouter([
    { path: "/projects/:projectId", element: <ProjectPage /> },
    { path: "/projects", element: <p>Project list destination</p> },
  ], { initialEntries: ["/projects/project-a"] });
  render(<RouterProvider router={router} />);
  return router;
}

const fetchMock = vi.fn<typeof fetch>();
// Keep cold module transformation outside the user-interaction assertions while
// retaining the actual lazy-loaded Reading component and its editing workflow.
beforeAll(async () => { await import("./components/project/ProjectReadingSurface"); });
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => { cleanup(); fetchMock.mockReset(); vi.unstubAllGlobals(); });

describe("Project editor save workflow", () => {
  it("validates source URLs locally and preserves fields after an authoritative rejection", async () => {
    const snapshot = snapshotWithAttachment();
    const content = snapshot.contents.find((value) => value.id === "content-attachment")!;
    const inputs: any[] = [];
    fetchMock.mockImplementation(async (_path, init) => {
      if (!init?.method) return response(snapshot);
      const input = JSON.parse(String(init.body));
      inputs.push(input);
      if (inputs.length === 1) return response({ error: "Metadata rejected" }, 400);
      return response({ value: { ...content, attachmentCaption: input.caption, attachmentSourceUrl: input.sourceUrl, revision: 2 }, replayed: false });
    });
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Reading" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit attachment metadata" }));
    const caption = screen.getByLabelText("Reading attachment caption") as HTMLTextAreaElement;
    const url = screen.getByLabelText("Reading attachment source URL") as HTMLInputElement;
    fireEvent.change(caption, { target: { value: "Keep my caption" } });
    fireEvent.change(url, { target: { value: "bad-url" } });
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
    expect(inputs).toHaveLength(0);
    expect(url.getAttribute("aria-invalid")).toBe("true");
    expect(url.disabled).toBe(false);
    expect(caption.value).toBe("Keep my caption");
    fireEvent.change(url, { target: { value: "https://example.com/first" } });
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
    await screen.findByText("Metadata rejected");
    expect(url.disabled).toBe(false);
    expect(caption.value).toBe("Keep my caption");
    fireEvent.change(url, { target: { value: "https://example.com/corrected" } });
    fireEvent.keyDown(url, { key: "s", ctrlKey: true });
    await waitFor(() => expect(screen.queryByLabelText("Reading attachment caption")).toBeNull());
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toMatchObject({ caption: "Keep my caption", sourceUrl: "https://example.com/corrected" });
    expect(inputs[1].operationId).not.toBe(inputs[0].operationId);
  });

  it("keeps uncertain metadata immutable and routes Save to an exact retry", async () => {
    const snapshot = snapshotWithAttachment();
    const content = snapshot.contents.find((value) => value.id === "content-attachment")!;
    const inputs: any[] = [];
    fetchMock.mockImplementation(async (_path, init) => {
      if (!init?.method) return response(snapshot);
      const input = JSON.parse(String(init.body));
      inputs.push(input);
      if (inputs.length === 1) return response({ error: "Response unavailable" }, 503);
      if (inputs.length === 2) return response({ error: "Permission expired before retry" }, 403);
      return response({ value: { ...content, attachmentCaption: input.caption, revision: 2 }, replayed: true });
    });
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Reading" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit attachment metadata" }));
    const caption = screen.getByLabelText("Reading attachment caption") as HTMLTextAreaElement;
    fireEvent.change(caption, { target: { value: "Frozen draft" } });
    expect(screen.getByRole("status", { name: "Project save status" }).textContent).toBe("Unsaved metadata");
    fireEvent.keyDown(caption, { key: "s", metaKey: true });
    await screen.findByText("Response unavailable");
    expect(caption.disabled).toBe(true);
    fireEvent.change(caption, { target: { value: "Must not alter request" } });
    expect(caption.value).toBe("Frozen draft");
    expect(screen.getByRole("status", { name: "Project save status" }).textContent).toBe("Confirm metadata save");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Permission expired before retry");
    expect(caption.disabled).toBe(true);
    expect(screen.getByRole("status", { name: "Project save status" }).textContent).toBe("Confirm metadata save");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByLabelText("Reading attachment caption")).toBeNull());
    expect(inputs).toHaveLength(3);
    expect(inputs[1]).toEqual(inputs[0]);
    expect(inputs[2]).toEqual(inputs[0]);
  });

  it("saves a Map text draft with Ctrl+S and allows a corrected request after rejection", async () => {
    const snapshot = projectTestSnapshot();
    const inputs: any[] = [];
    fetchMock.mockImplementation(async (_path, init) => {
      if (!init?.method) return response(snapshot);
      const input = JSON.parse(String(init.body));
      inputs.push(input);
      if (inputs.length === 1) return response({ error: "Markdown rejected" }, 400);
      return response({ value: { ...snapshot.contents[0], markdownSource: input.markdownSource, revision: 2 }, replayed: false });
    });
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Edit test note" }));
    const editor = screen.getByLabelText("Map draft") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "First draft" } });
    expect(screen.getByRole("status", { name: "Project save status" }).textContent).toBe("Unsaved Markdown");
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    await screen.findByText("Markdown rejected");
    expect(editor.disabled).toBe(false);
    fireEvent.change(editor, { target: { value: "Corrected draft" } });
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    await waitFor(() => expect(screen.queryByLabelText("Map draft")).toBeNull());
    expect(inputs).toHaveLength(2);
    expect(inputs[1].operationId).not.toBe(inputs[0].operationId);
    expect(inputs[1].markdownSource).toBe("Corrected draft");
    expect(screen.getByRole("status", { name: "Project save status" }).textContent).toBe("Saved");
  });

  it("only leaves after the chosen Markdown save is acknowledged", async () => {
    const snapshot = projectTestSnapshot();
    let acknowledge: ((response: Response) => void) | undefined;
    let input: any;
    fetchMock.mockImplementation(async (_path, init) => {
      if (!init?.method) return response(snapshot);
      input = JSON.parse(String(init.body));
      return new Promise<Response>((resolve) => { acknowledge = resolve; });
    });
    const router = page();
    fireEvent.click(await screen.findByRole("button", { name: "Reading" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
    fireEvent.change(await screen.findByLabelText("Reading Markdown editor"), { target: { value: "Save before leaving" } });
    fireEvent.click(screen.getByRole("link", { name: "Projects" }));
    const prompt = await screen.findByRole("alertdialog", { name: "Unsaved Project changes" });
    fireEvent.click(within(prompt).getByRole("button", { name: "Save Markdown and leave" }));
    await waitFor(() => expect(acknowledge).toBeTypeOf("function"));
    expect(router.state.location.pathname).toBe("/projects/project-a");
    acknowledge!(response({ value: { ...snapshot.contents[0], markdownSource: input.markdownSource, revision: 2 }, replayed: false }));
    await screen.findByText("Project list destination");
    expect(router.state.location.pathname).toBe("/projects");
  });

  it("reloads a conflicted note before reopening with its current revision", async () => {
    const snapshot = projectTestSnapshot();
    const latest = { ...snapshot, contents: [{ ...snapshot.contents[0], markdownSource: "Current server note", revision: 2 }] };
    let reads = 0;
    const inputs: any[] = [];
    fetchMock.mockImplementation(async (_path, init) => {
      if (!init?.method) return response(++reads === 1 ? snapshot : latest);
      const input = JSON.parse(String(init.body));
      inputs.push(input);
      if (inputs.length === 1) return response({ error: "Content revision changed" }, 409);
      return response({ value: { ...latest.contents[0], markdownSource: input.markdownSource, revision: 3 }, replayed: false });
    });
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Edit test note" }));
    fireEvent.change(screen.getByLabelText("Map draft"), { target: { value: "My stale draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Markdown" }));
    await screen.findByText("Content revision changed");
    fireEvent.click(screen.getByRole("button", { name: "Discard draft and reload" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit test note" }));
    const editor = screen.getByLabelText("Map draft") as HTMLTextAreaElement;
    expect(editor.value).toBe("Current server note");
    fireEvent.change(editor, { target: { value: "Edit current revision" } });
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    await waitFor(() => expect(inputs).toHaveLength(2));
    expect(inputs[1].expectedRevision).toBe(2);
    expect(inputs[1].operationId).not.toBe(inputs[0].operationId);
  });

  it("preserves pending layout changes before reloading a discarded conflict", async () => {
    const snapshot = projectTestSnapshot();
    const latest = { ...snapshot, contents: [{ ...snapshot.contents[0], markdownSource: "Current server note", revision: 2 }] };
    let reads = 0;
    let acknowledge: (() => void) | undefined;
    fetchMock.mockImplementation(async (path, init) => {
      if (!init?.method) return response(++reads === 1 ? snapshot : latest);
      if (String(path).endsWith("/markdown")) return response({ error: "Content revision changed" }, 409);
      const input = JSON.parse(String(init.body));
      expect(input.geometry.x).toBe(123);
      const placement = { ...snapshot.placements.find((value) => value.id === "placement-note")!, ...input.geometry, revision: 2 };
      return new Promise<Response>((resolve) => { acknowledge = () => {
        latest.placements = latest.placements.map((value) => value.id === placement.id ? placement : value);
        resolve(response({ value: placement, replayed: false }));
      }; });
    });
    page();
    fireEvent.click(await screen.findByRole("button", { name: "Move test note" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit test note" }));
    fireEvent.change(screen.getByLabelText("Map draft"), { target: { value: "My stale draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Markdown" }));
    await screen.findByText("Content revision changed");
    fireEvent.click(screen.getByRole("button", { name: "Discard draft and reload" }));
    expect(reads).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(acknowledge).toBeTypeOf("function"));
    expect(reads).toBe(1);
    acknowledge!();
    await waitFor(() => expect(reads).toBe(2));
    fireEvent.click(await screen.findByRole("button", { name: "Edit test note" }));
    expect((screen.getByLabelText("Map draft") as HTMLTextAreaElement).value).toBe("Current server note");
  });
});

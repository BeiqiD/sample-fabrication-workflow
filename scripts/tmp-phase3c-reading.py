from pathlib import Path
from textwrap import dedent


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one anchor in {path}, found {count}: {old[:120]!r}")
    target.write_text(text.replace(old, new, 1))


Path("src/components/project/ProjectReadingSurface.tsx").write_text(dedent(r'''\
import { useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState } from "../EmptyState";
import type { ProjectNodeDescriptor } from "../../lib/project-map-model";
import { projectAttachmentCanPreviewImage, type ProjectMapMarkdownEditorState } from "../../lib/project-owned-content";

export type ProjectReadingAttachmentEditorState = {
  itemId: string;
  contentId: string;
  caption: string;
  sourceUrl: string;
  status: "editing" | "saving" | "error" | "conflict" | "uncertain";
  message: string | null;
};

export interface ProjectReadingSurfaceProps {
  nodes: ProjectNodeDescriptor[];
  mobile?: boolean;
  markdownEditor?: ProjectMapMarkdownEditorState | null;
  attachmentEditor?: ProjectReadingAttachmentEditorState | null;
  interactionDisabled?: boolean;
  onMarkdownEditRequest?: (itemId: string) => void;
  onMarkdownChange?: (value: string) => void;
  onMarkdownSave?: () => void;
  onMarkdownCancel?: () => void;
  onAttachmentEditRequest?: (itemId: string) => void;
  onAttachmentChange?: (field: "caption" | "sourceUrl", value: string) => void;
  onAttachmentSave?: () => void;
  onAttachmentCancel?: () => void;
}

function ReadingAttachmentPreview({ fileUrl, mimeType, alt }: {
  fileUrl: string | null;
  mimeType: string | null;
  alt: string;
}) {
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null);
  if (!fileUrl || !projectAttachmentCanPreviewImage(mimeType) || failedPreviewUrl === fileUrl) return null;
  return <img
    className="project-reading-image"
    src={fileUrl}
    alt={alt}
    onError={() => setFailedPreviewUrl(fileUrl)}
  />;
}

export function ProjectReadingSurface({
  nodes,
  mobile = false,
  markdownEditor = null,
  attachmentEditor = null,
  interactionDisabled = false,
  onMarkdownEditRequest,
  onMarkdownChange,
  onMarkdownSave,
  onMarkdownCancel,
  onAttachmentEditRequest,
  onAttachmentChange,
  onAttachmentSave,
  onAttachmentCancel,
}: ProjectReadingSurfaceProps) {
  const editorBusy = markdownEditor !== null || attachmentEditor !== null;
  return <section className={`project-reading-surface${mobile ? " mobile" : " desktop"}`} aria-label="Project Reading">
    <div className="project-reading-heading">
      <p className="card-label">Reading</p>
      <p className="card-meta">Items follow immutable creation order. Reading never changes Map positions, edges, or occurrence order.</p>
    </div>
    {nodes.length ? nodes.map((node) => {
      const editingMarkdown = markdownEditor?.itemId === node.itemId;
      const editingAttachment = attachmentEditor?.itemId === node.itemId;
      return <article className="card project-reading-item" key={node.itemId} data-project-item-id={node.itemId}>
        <header><span className="meta-badge">{node.kind}</span><small>#{node.createdSequence}</small></header>
        <h2>{node.title}</h2>
        {node.subtitle && <p className="card-meta">{node.subtitle}</p>}

        {node.kind === "markdown" && (editingMarkdown ? <div className="project-reading-editor">
          <textarea
            aria-label="Reading Markdown editor"
            value={markdownEditor.value}
            disabled={markdownEditor.status !== "editing"}
            onChange={(event) => onMarkdownChange?.(event.currentTarget.value)}
          />
          {markdownEditor.message && <p className="error-banner">{markdownEditor.message}</p>}
          <div className="project-owned-content-pending-actions">
            {(markdownEditor.status === "editing" || markdownEditor.status === "saving" || markdownEditor.status === "uncertain") && <button
              type="button"
              className="button primary compact-button"
              disabled={markdownEditor.status === "saving" || !markdownEditor.value.trim()}
              onClick={onMarkdownSave}
            >{markdownEditor.status === "saving" ? "Saving…" : markdownEditor.status === "uncertain" ? "Retry exact save" : "Save Markdown"}</button>}
            {markdownEditor.status !== "saving" && markdownEditor.status !== "uncertain" && <button type="button" className="button compact-button" onClick={onMarkdownCancel}>Cancel</button>}
          </div>
        </div> : <>
          <div className="project-reading-markdown-source">{node.markdownSource || ""}</div>
          <button
            type="button"
            className="button reading-edit-button"
            disabled={interactionDisabled || editorBusy}
            onClick={() => onMarkdownEditRequest?.(node.itemId)}
          >Edit Markdown</button>
        </>)}

        {node.kind === "attachment" && <>
          <ReadingAttachmentPreview
            fileUrl={node.fileUrl}
            mimeType={node.mimeType}
            alt={node.attachmentCaption || node.title}
          />
          {node.attachmentCaption && <p className="project-reading-caption">{node.attachmentCaption}</p>}
          {editingAttachment ? <div className="project-attachment-meta-form project-reading-editor">
            <label>Caption
              <textarea
                aria-label="Reading attachment caption"
                value={attachmentEditor.caption}
                disabled={attachmentEditor.status !== "editing"}
                onChange={(event) => onAttachmentChange?.("caption", event.currentTarget.value)}
              />
            </label>
            <label>Source URL
              <input
                aria-label="Reading attachment source URL"
                type="url"
                placeholder="https://…"
                value={attachmentEditor.sourceUrl}
                disabled={attachmentEditor.status !== "editing"}
                onChange={(event) => onAttachmentChange?.("sourceUrl", event.currentTarget.value)}
              />
            </label>
            {attachmentEditor.message && <p className="error-banner">{attachmentEditor.message}</p>}
            <div className="project-owned-content-pending-actions">
              {(attachmentEditor.status === "editing" || attachmentEditor.status === "saving" || attachmentEditor.status === "uncertain") && <button
                type="button"
                className="button primary compact-button"
                disabled={attachmentEditor.status === "saving"}
                onClick={onAttachmentSave}
              >{attachmentEditor.status === "saving" ? "Saving…" : attachmentEditor.status === "uncertain" ? "Retry exact save" : "Save metadata"}</button>}
              {attachmentEditor.status !== "saving" && attachmentEditor.status !== "uncertain" && <button type="button" className="button compact-button" onClick={onAttachmentCancel}>Cancel</button>}
            </div>
          </div> : <button
            type="button"
            className="button reading-edit-button"
            disabled={interactionDisabled || editorBusy}
            onClick={() => onAttachmentEditRequest?.(node.itemId)}
          >Edit attachment metadata</button>}
          {node.attachmentSourceUrl && <a className="button wide" href={node.attachmentSourceUrl} target="_blank" rel="noreferrer">Open source URL</a>}
          {node.fileUrl && <a className="button wide" href={node.fileUrl}>Open attachment</a>}
        </>}

        {node.kind === "reference" && <>
          {node.excerpt && <p className="project-reading-excerpt">{node.excerpt}</p>}
          {node.openReferenceUrl && <Link className="button wide" to={node.openReferenceUrl}>Open reference</Link>}
        </>}
      </article>;
    }) : <EmptyState title="This Project is empty">
      Add references or Project-owned content from the desktop Map workspace.
    </EmptyState>}
  </section>;
}
'''))

page = "src/pages/ProjectPage.tsx"
replace_once(page, 'import { EmptyState } from "../components/EmptyState";\n', '')
replace_once(
    page,
    'import { ReferenceSearchSurface } from "../components/ReferenceSearchSurface";\n',
    'import { ReferenceSearchSurface } from "../components/ReferenceSearchSurface";\nimport { ProjectReadingSurface } from "../components/project/ProjectReadingSurface";\n',
)
replace_once(
    page,
    '''type AttachmentEditorState = {\n  itemId: string;\n  contentId: string;\n  caption: string;\n  sourceUrl: string;\n  status: "editing" | "saving" | "error" | "conflict" | "uncertain";\n  message: string | null;\n};''',
    '''type AttachmentEditorState = {\n  itemId: string;\n  contentId: string;\n  caption: string;\n  sourceUrl: string;\n  status: "editing" | "saving" | "error" | "conflict" | "uncertain";\n  message: string | null;\n};\n\ntype ProjectWorkspaceView = "map" | "reading";''',
)
replace_once(
    page,
    '''function ProjectReadingAttachmentPreview({\n  fileUrl,\n  mimeType,\n  alt,\n}: {\n  fileUrl: string | null;\n  mimeType: string | null;\n  alt: string;\n}) {\n  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null);\n  if (!fileUrl || !projectAttachmentCanPreviewImage(mimeType) || failedPreviewUrl === fileUrl) return null;\n  return <img\n    className="project-reading-image"\n    src={fileUrl}\n    alt={alt}\n    onError={() => setFailedPreviewUrl(fileUrl)}\n  />;\n}\n\n''',
    '',
)
replace_once(
    page,
    '''  const [attachmentEditor, setAttachmentEditorState] = useState<AttachmentEditorState | null>(null);\n  const [ownedContentActionError, setOwnedContentActionError] = useState("");''',
    '''  const [attachmentEditor, setAttachmentEditorState] = useState<AttachmentEditorState | null>(null);\n  const [ownedContentActionError, setOwnedContentActionError] = useState("");\n  const [desktopView, setDesktopView] = useState<ProjectWorkspaceView>("map");''',
)
replace_once(
    page,
    '''  projectAttachmentGeometryAtPoint,\n  projectAttachmentCanPreviewImage,\n  projectMarkdownGeometryAtPoint,''',
    '''  projectAttachmentGeometryAtPoint,\n  projectMarkdownGeometryAtPoint,''',
)
replace_once(
    page,
    '''  const redoDisabled = !redoCommand\n    || saveState === "saving"\n    || geometryInteractionDisabled\n    || (redoCommand.kind !== "geometry" && edgeController.interactionDisabled);''',
    '''  const redoDisabled = !redoCommand\n    || saveState === "saving"\n    || geometryInteractionDisabled\n    || (redoCommand.kind !== "geometry" && edgeController.interactionDisabled);\n  const viewSwitchDisabled = saveState !== "saved"\n    || pendingReference !== null\n    || pendingReferenceRemoval !== null\n    || markdownEditor !== null\n    || pendingAttachment !== null\n    || attachmentEditor !== null\n    || edgeController.unsafe;\n  const readingInteractionDisabled = saveState !== "saved"\n    || pendingReference !== null\n    || pendingReferenceRemoval !== null\n    || pendingAttachment !== null\n    || edgeController.unsafe;''',
)
replace_once(
    page,
    '''      {desktop && <div className="project-save-toolbar">\n        <span className={`project-save-state ${saveState}`}>{saveLabel(saveState)}</span>\n        <button type="button" className="button compact-button" disabled={undoDisabled} onClick={undo}>Undo</button>\n        <button type="button" className="button compact-button" disabled={redoDisabled} onClick={redo}>Redo</button>\n        <button\n          type="button"\n          className="button primary compact-button"\n          disabled={saveState === "saved" || saveState === "saving" || saveState === "conflict" || geometryInteractionDisabled}\n          onClick={() => {\n            if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);\n            autosaveTimerRef.current = null;\n            void flushSave();\n          }}\n        >Save</button>\n      </div>}''',
    '''      {desktop && <div className="project-workspace-header-actions">\n        <div className="project-view-toggle" role="group" aria-label="Project view">\n          <button type="button" className={`button compact-button${desktopView === "map" ? " active" : ""}`} aria-pressed={desktopView === "map"} disabled={viewSwitchDisabled} onClick={() => setDesktopView("map")}>Map</button>\n          <button type="button" className={`button compact-button${desktopView === "reading" ? " active" : ""}`} aria-pressed={desktopView === "reading"} disabled={viewSwitchDisabled} onClick={() => setDesktopView("reading")}>Reading</button>\n        </div>\n        {desktopView === "map" && <div className="project-save-toolbar">\n          <span className={`project-save-state ${saveState}`}>{saveLabel(saveState)}</span>\n          <button type="button" className="button compact-button" disabled={undoDisabled} onClick={undo}>Undo</button>\n          <button type="button" className="button compact-button" disabled={redoDisabled} onClick={redo}>Redo</button>\n          <button\n            type="button"\n            className="button primary compact-button"\n            disabled={saveState === "saved" || saveState === "saving" || saveState === "conflict" || geometryInteractionDisabled}\n            onClick={() => {\n              if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);\n              autosaveTimerRef.current = null;\n              void flushSave();\n            }}\n          >Save</button>\n        </div>}\n      </div>}''',
)
replace_once(
    page,
    '''    {desktop ? <div className="project-desktop-workspace with-reference-sidebar">\n      <aside className="project-reference-sidebar" aria-label="Reference search and placement">''',
    '''    {desktop ? <div className="project-desktop-workspace with-reference-sidebar">\n      {desktopView === "map" ? <>\n      <aside className="project-reference-sidebar" aria-label="Reference search and placement">''',
)
replace_once(
    page,
    '''        </div> : <p className="muted">Select a Map item or edge to inspect it.</p>}\n      </aside>\n    </div> : <section className="project-mobile-reading" aria-label="Project occurrences">\n      <div className="project-mobile-reading-heading">\n        <p className="card-label">Read-only occurrence view</p>\n        <p className="card-meta">Reference placement and Map editing are available on a larger screen. Items remain ordered by creation sequence.</p>\n      </div>\n      {readingNodes.length ? readingNodes.map((node) => <article className="card project-reading-item" key={node.itemId}>\n        <header><span className="meta-badge">{node.kind}</span><small>#{node.createdSequence}</small></header>\n        <h2>{node.title}</h2>\n        {node.subtitle && <p className="card-meta">{node.subtitle}</p>}\n        {node.kind === "attachment" && <ProjectReadingAttachmentPreview\n          fileUrl={node.fileUrl}\n          mimeType={node.mimeType}\n          alt={node.attachmentCaption || node.title}\n        />}\n        {node.excerpt && <p className="project-reading-excerpt">{node.excerpt}</p>}\n        {node.attachmentSourceUrl && <a className="button wide" href={node.attachmentSourceUrl} target="_blank" rel="noreferrer">Open source URL</a>}\n        {node.openReferenceUrl && <Link className="button wide" to={node.openReferenceUrl}>Open reference</Link>}\n        {node.fileUrl && <a className="button wide" href={node.fileUrl}>Open attachment</a>}\n      </article>) : <EmptyState title="This Project is empty">\n        Add references or Project-owned content from the desktop Project workspace.\n      </EmptyState>}\n    </section>}''',
    '''        </div> : <p className="muted">Select a Map item or edge to inspect it.</p>}\n      </aside>\n      </> : <ProjectReadingSurface\n        nodes={readingNodes}\n        markdownEditor={markdownEditor}\n        attachmentEditor={attachmentEditor}\n        interactionDisabled={readingInteractionDisabled}\n        onMarkdownEditRequest={startMarkdownEdit}\n        onMarkdownChange={changeMarkdown}\n        onMarkdownSave={() => void saveMarkdown()}\n        onMarkdownCancel={() => cancelMarkdown(false)}\n        onAttachmentEditRequest={startAttachmentEdit}\n        onAttachmentChange={updateAttachmentDraft}\n        onAttachmentSave={() => void saveAttachmentMetadata()}\n        onAttachmentCancel={() => cancelAttachmentEdit(false)}\n      />}\n    </div> : <ProjectReadingSurface\n      nodes={readingNodes}\n      mobile\n      markdownEditor={markdownEditor}\n      attachmentEditor={attachmentEditor}\n      interactionDisabled={readingInteractionDisabled}\n      onMarkdownEditRequest={startMarkdownEdit}\n      onMarkdownChange={changeMarkdown}\n      onMarkdownSave={() => void saveMarkdown()}\n      onMarkdownCancel={() => cancelMarkdown(false)}\n      onAttachmentEditRequest={startAttachmentEdit}\n      onAttachmentChange={updateAttachmentDraft}\n      onAttachmentSave={() => void saveAttachmentMetadata()}\n      onAttachmentCancel={() => cancelAttachmentEdit(false)}\n    />}''',
)

css = "src/project.css"
with Path(css).open("a") as handle:
    handle.write(dedent(r'''\

.project-workspace-header-actions { flex: 0 0 auto; display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 10px; }
.project-view-toggle { display: inline-flex; align-items: center; gap: 6px; }
.project-view-toggle .button.active { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.project-reading-surface { grid-column: 1 / -1; width: min(780px, calc(100% - 32px)); min-width: 0; margin: 0 auto; padding: 20px 0 36px; overflow-y: auto; display: grid; align-content: start; gap: 12px; }
.project-reading-surface.mobile { width: min(720px, 100%); padding-top: 0; overflow: visible; }
.project-reading-heading { display: grid; gap: 5px; margin-bottom: 4px; }
.project-reading-heading p { margin: 0; }
.project-reading-markdown-source,
.project-reading-caption { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; font-size: 13px; line-height: 1.6; }
.project-reading-editor { display: grid; gap: 10px; }
.project-reading-editor > textarea { width: 100%; min-height: 180px; padding: 10px 11px; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: var(--paper); font: inherit; resize: vertical; }
.project-reading-editor .error-banner { margin: 0; }
.reading-edit-button { justify-self: start; }
'''))

mobile_test = "src/project-page.mobile.mount.test.tsx"
replace_once(
    mobile_test,
    'it("renders a deterministic read-only occurrence projection without initializing the Map", async () => {',
    'it("defaults to the deterministic Reading projection without initializing the Map", async () => {',
)
replace_once(mobile_test, 'expect(screen.getByText("Read-only occurrence view")).toBeTruthy();', 'expect(screen.getByText("Reading")).toBeTruthy();')
replace_once(
    mobile_test,
    '''    expect(fetchMock).toHaveBeenCalledTimes(1);\n    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/project-a");''',
    '''    expect(screen.getByText("# Design note\\n\\nPreserve the occurrence identity.")).toBeTruthy();\n    expect(screen.getByRole("button", { name: "Edit Markdown" })).toBeTruthy();\n    expect(screen.queryByText("Add references")).toBeNull();\n    expect(screen.queryByText("Add attachment")).toBeNull();\n    expect(fetchMock).toHaveBeenCalledTimes(1);\n    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/project-a");''',
)

Path("src/project-reading.mount.test.tsx").write_text(dedent(r'''\
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSnapshot } from "../shared/project-api";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

vi.mock("./components/project/ProjectMapSurface", async () => {
  const React = await import("react");
  return {
    ProjectMapSurface: React.forwardRef((_props, ref: React.ForwardedRef<{ getViewportCenter: () => { x: number; y: number } }>) => {
      React.useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 400, y: 300 }) }));
      return <div data-testid="project-flow-canvas">Map fixture</div>;
    }),
  };
});

function desktopMatchMedia() {
  return vi.fn(() => ({
    matches: true,
    media: "(min-width: 860px)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

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

function jsonResponse(payload: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

function renderProjectPage() {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }], { initialEntries: ["/projects/project-a"] });
  return render(<RouterProvider router={router} />);
}

describe("mounted Phase 3C Reading projection", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("matchMedia", desktopMatchMedia());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("switches desktop from Map to complete insertion-order Reading without creation controls", async () => {
    const snapshot = snapshotWithAttachment();
    fetchMock.mockResolvedValueOnce(await jsonResponse(snapshot));
    renderProjectPage();

    await screen.findByText("Map fixture");
    fireEvent.click(screen.getByRole("button", { name: "Reading" }));

    expect(await screen.findByRole("region", { name: "Project Reading" })).toBeTruthy();
    expect(screen.queryByTestId("project-flow-canvas")).toBeNull();
    expect(screen.queryByText("Add references")).toBeNull();
    expect(screen.queryByText("Add attachment")).toBeNull();
    expect(screen.getByText("# Design note\n\nPreserve the occurrence identity.")).toBeTruthy();
    expect(screen.getByText(snapshot.contents.find((content) => content.id === "content-attachment")!.attachmentCaption!)).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent))
      .toEqual(["Design note", "Sample A", "result.pdf"]);
  });

  it("edits existing Markdown through Reading with the authoritative content update", async () => {
    const snapshot = snapshotWithAttachment();
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(snapshot);
      if (String(path) === "/api/projects/project-a/contents/content-note" && init?.method === "PATCH") {
        const input = JSON.parse(String(init.body));
        return jsonResponse({ value: { ...snapshot.contents[0], markdownSource: input.markdownSource, revision: 2 }, replayed: false });
      }
      return jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${String(path)}` }, 500);
    });

    renderProjectPage();
    await screen.findByText("Map fixture");
    fireEvent.click(screen.getByRole("button", { name: "Reading" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
    fireEvent.change(screen.getByLabelText("Reading Markdown editor"), { target: { value: "# Updated reading note\n\nFull body" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Markdown" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const request = fetchMock.mock.calls[1];
    expect(request[0]).toBe("/api/projects/project-a/contents/content-note");
    const body = JSON.parse(String(request[1]?.body));
    expect(body).toMatchObject({ markdownSource: "# Updated reading note\n\nFull body", expectedRevision: 1 });
    expect(await screen.findByText("# Updated reading note\n\nFull body")).toBeTruthy();
  });

  it("edits attachment caption and source URL without exposing byte replacement", async () => {
    const snapshot = snapshotWithAttachment();
    const content = snapshot.contents.find((candidate) => candidate.id === "content-attachment")!;
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(snapshot);
      if (String(path) === "/api/projects/project-a/contents/content-attachment" && init?.method === "PATCH") {
        const input = JSON.parse(String(init.body));
        return jsonResponse({ value: { ...content, attachmentCaption: input.caption, attachmentSourceUrl: input.sourceUrl, revision: 2 }, replayed: false });
      }
      return jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${String(path)}` }, 500);
    });

    renderProjectPage();
    await screen.findByText("Map fixture");
    fireEvent.click(screen.getByRole("button", { name: "Reading" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit attachment metadata" }));
    fireEvent.change(screen.getByLabelText("Reading attachment caption"), { target: { value: "Updated caption" } });
    fireEvent.change(screen.getByLabelText("Reading attachment source URL"), { target: { value: "https://example.com/updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body).toMatchObject({
      caption: "Updated caption",
      sourceUrl: "https://example.com/updated",
      expectedRevision: 1,
    });
    expect(body).not.toHaveProperty("assetId");
    expect(body).not.toHaveProperty("storageObjectId");
    expect(await screen.findByText("Updated caption")).toBeTruthy();
  });
});
'''))

Path("src/project-reading-contract.test.ts").write_text(dedent(r'''\
import fs from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => fs.readFileSync(path, "utf8");

describe("Phase 3C Reading contract", () => {
  it("projects the same occurrences in immutable creation order without a second persistence model", () => {
    const model = read("src/lib/project-map-model.ts");
    const reading = read("src/components/project/ProjectReadingSurface.tsx");
    expect(model).toContain("left.createdSequence - right.createdSequence || left.itemId.localeCompare(right.itemId)");
    expect(reading).toContain("Items follow immutable creation order");
    expect(reading).not.toContain("projectApi");
    expect(reading).not.toContain("created_sequence");
  });

  it("keeps Reading creation-free while allowing only existing owned-content edits", () => {
    const reading = read("src/components/project/ProjectReadingSurface.tsx");
    const page = read("src/pages/ProjectPage.tsx");
    expect(reading).toContain("Edit Markdown");
    expect(reading).toContain("Edit attachment metadata");
    expect(reading).toContain("Open reference");
    expect(reading).not.toContain("Add attachment");
    expect(reading).not.toContain("onMarkdownCreateRequest");
    expect(reading).not.toContain("Remove from Project");
    expect(page).toContain('desktopView === "map" ? <>');
    expect(page).toContain("<ProjectReadingSurface");
  });

  it("renders full owned content while leaving rich Markdown/TeX rendering to Phase 3D", () => {
    const reading = read("src/components/project/ProjectReadingSurface.tsx");
    const plan = read("docs/PROJECT_READING_IMPLEMENTATION_PLAN.md");
    expect(reading).toContain('className="project-reading-markdown-source"');
    expect(reading).toContain("node.markdownSource || \"\"");
    expect(reading).toContain("node.attachmentCaption");
    expect(plan).toContain("Rich CommonMark/GFM and TeX rendering remains Phase 3D");
  });

  it("keeps the Map double-click regression fix folded into the Phase 3C branch", () => {
    const map = read("src/components/project/ProjectMapSurface.tsx");
    const surfaceTest = read("src/project-map-surface.mount.test.tsx");
    expect(map).toContain("zoomOnDoubleClick={false}");
    expect(surfaceTest).toContain("reserves empty-pane double click for Markdown creation without zooming");
  });
});
'''))

owned_contract = "src/project-owned-content-contract.test.ts"
replace_once(
    owned_contract,
    '''    expect(page).toContain("<ProjectReadingAttachmentPreview");\n    expect(page).toContain("onError={() => setFailedPreviewUrl(fileUrl)}");''',
    '''    const reading = read("./components/project/ProjectReadingSurface.tsx");\n    expect(reading).toContain("<ReadingAttachmentPreview");\n    expect(reading).toContain("onError={() => setFailedPreviewUrl(fileUrl)}");''',
)
replace_once(
    owned_contract,
    '''  it("keeps Project-owned content creation desktop-only", () => {\n    const page = read("./pages/ProjectPage.tsx");\n    const desktopBranch = page.indexOf('{desktop ? <div className="project-desktop-workspace with-reference-sidebar">');\n    const mobileBranch = page.indexOf(': <section className="project-mobile-reading"', desktopBranch);\n    expect(desktopBranch).toBeGreaterThan(-1);\n    expect(mobileBranch).toBeGreaterThan(desktopBranch);\n    const mobile = page.slice(mobileBranch);\n    expect(mobile).not.toContain("Add attachment");\n    expect(mobile).not.toContain("New Project Markdown");\n  });''',
    '''  it("keeps Project-owned content creation Map-only while Reading edits existing content", () => {\n    const page = read("./pages/ProjectPage.tsx");\n    const reading = read("./components/project/ProjectReadingSurface.tsx");\n    expect(page).toContain('{desktop ? <div className="project-desktop-workspace with-reference-sidebar">');\n    expect(page).toContain('desktopView === "map" ? <>');\n    expect(reading).not.toContain("Add attachment");\n    expect(reading).not.toContain("New Project Markdown");\n    expect(reading).toContain("Edit Markdown");\n    expect(reading).toContain("Edit attachment metadata");\n  });''',
)

reference_contract = "src/project-reference-placement-contract.test.ts"
replace_once(
    reference_contract,
    '''    const mobileBranch = page.indexOf(": <section className=\\\"project-mobile-reading\\\"", searchSurface);\n    expect(desktopBranch).toBeGreaterThan(-1);\n    expect(searchSurface).toBeGreaterThan(desktopBranch);\n    expect(mobileBranch).toBeGreaterThan(searchSurface);\n    expect(page.slice(mobileBranch)).not.toContain("<ReferenceSearchSurface");\n    expect(page.slice(mobileBranch)).not.toContain("Remove from Project");''',
    '''    const readingBranch = page.indexOf(": <ProjectReadingSurface", searchSurface);\n    expect(desktopBranch).toBeGreaterThan(-1);\n    expect(searchSurface).toBeGreaterThan(desktopBranch);\n    expect(readingBranch).toBeGreaterThan(searchSurface);\n    expect(page.slice(readingBranch)).not.toContain("<ReferenceSearchSurface");\n    const reading = read("./components/project/ProjectReadingSurface.tsx");\n    expect(reading).not.toContain("Remove from Project");''',
)

Path("docs/PROJECT_READING_IMPLEMENTATION_PLAN.md").write_text(dedent(r'''\
# Project Reading implementation plan

Status: Phase 3C active implementation; Phase 3B4 is complete in squash-merged PR #136

Last reviewed: 2026-08-14 before implementing the shared desktop/mobile Reading projection

## Goal

Phase 3C turns the existing mobile read-only occurrence skeleton into the formal Reading projection of the same Project-local occurrences used by Map. It adds no Reading-specific persistence table, ordering field, copied content object, or source-record editor.

## Projection and ordering boundary

Reading derives from the authoritative Project snapshot through `projectReadingNodes()`. Every active occurrence is presented in exactly:

```text
created_sequence ascending
project_item.id ascending as deterministic tie-breaker
```

Map position, node size, edge direction, edge labels, viewport state, selection, and Inspector state do not influence Reading order. Switching between Map and Reading never writes Project state.

## Desktop and mobile behavior

Desktop keeps Map as the default creation/organization surface and adds one explicit Map / Reading view switch. The switch is disabled while placement state is unsaved or any Project mutation/editor is unresolved, so an in-progress Map or content operation cannot disappear behind another projection.

Mobile defaults directly to Reading and never initializes React Flow. Mobile does not expose Map placement, reference insertion, attachment upload, edge authoring, occurrence removal, or any other creation/structural mutation.

## Reading content behavior

Reading renders the same occurrence identity and current authoritative content:

- Project-owned Markdown: complete Markdown source, editable through the existing authoritative Markdown update state machine;
- Project-owned attachment: immutable file identity plus complete caption/source URL, with caption/source URL editable through the existing metadata update state machine;
- external reference: resolved read-only summary plus explicit `Open reference` navigation;
- image attachments: existing safe raster preview policy with decode fallback to the file action;
- non-image attachments: file card/action only.

Rich CommonMark/GFM and TeX rendering remains Phase 3D. Phase 3C deliberately renders the complete Markdown source as readable pre-wrapped text rather than introducing an editor/runtime dependency before the Reading contract is validated.

## Mutation and navigation safety

Reading reuses the Phase 3B3 owned-content mutation machinery rather than creating new APIs. Existing Markdown and attachment metadata edits therefore retain:

- current authoritative expected revisions;
- stable operation IDs;
- exact retry only for outcome-uncertain failures;
- explicit deterministic error/conflict handling;
- shared SPA and `beforeunload` protection;
- one active owned-content editor/mutation at a time.

Reading has no Save button for Map placements and no geometry/edge undo controls. Existing content edit buttons persist only their owned-content mutation.

## Frontend boundary

This phase is intentionally not the planned Project frontend redesign. Layout polish, Markdown rendering, TeX, richer typography, responsive composition, advanced Inspector behavior, and generalized component refactoring remain later work. The small React Flow `zoomOnDoubleClick={false}` fix from the superseded standalone bugfix branch is folded into Phase 3C so empty-Map double click remains reserved for Markdown creation.

## Verification boundary

Phase 3C adds a permanent `pre-pr/project-reading` gate covering:

- deterministic creation-order projection;
- desktop Map → Reading switching without creation controls;
- mobile default Reading without React Flow initialization;
- complete Markdown-source presentation;
- complete attachment-caption presentation;
- existing Markdown update through Reading;
- existing attachment caption/source URL update through Reading without byte retargeting;
- references remaining read-only;
- the folded Map double-click regression;
- full Project persistence/Map/reference/owned-content/edge regressions;
- production build and Project Map bundle boundary.

## Deliberately deferred

Phase 3C does not add:

- Reading creation controls;
- manual reorder or Reading placement rows;
- edge-derived ordering or cycle handling;
- Markdown/TeX rendering;
- attachment-byte replacement;
- source-record editing;
- mobile Map authoring;
- advanced Inspector or Canvas polish;
- schema migration, remote migration, or deployment.

Phase 3D remains the next implementation phase after Phase 3C is independently reviewed and squash-merged.
'''))

roadmap = "docs/PRODUCT_ROADMAP.md"
replace_once(
    roadmap,
    '''completed; Phase 3B4 basic Project-local edges are implemented in PR #136, with\nformal-review fixes awaiting clean re-review and squash merge before Phase 3C''',
    '''completed; Phase 3B4 basic Project-local edges are complete in squash-merged PR #136,\nand Phase 3C Reading projection is the active implementation target''',
)
replace_once(roadmap, '**Status:** implemented in PR #136; formal-review fixes addressed and awaiting clean re-review and squash merge.', '**Status:** complete; squash-merged in PR #136.')
replace_once(
    roadmap,
    '### Phase 3C — Reading projection\n\n**Goal:**',
    '### Phase 3C — Reading projection\n\n**Status:** active implementation.\n\n**Goal:**',
)
replace_once(
    roadmap,
    '''1. After PR #136 is squash-merged, add the no-creation **Reading projection** as Phase 3C.\n2. Harden **Markdown/TeX, mixed media, save/conflict UX, and export** as Phase 3D.\n3. Add advanced **Inspector/Canvas/previews/performance**.\n4. Run the dedicated Docker portability implementation after Project content''',
    '''1. Complete the no-creation **Reading projection** as Phase 3C.\n2. Harden **Markdown/TeX, mixed media, save/conflict UX, and export** as Phase 3D.\n3. Add advanced **Inspector/Canvas/previews/performance**.\n4. Run the dedicated Docker portability implementation after Project content''',
)

canvas = "docs/PROJECT_CANVAS_INTERACTION_CONTRACT.md"
replace_once(
    canvas,
    'Status: canonical product and architecture contract; Phase 3B4 is implemented in PR #136 and awaits clean formal re-review before merge',
    'Status: canonical product and architecture contract; Phase 3B4 is complete in PR #136 and Phase 3C Reading is the active implementation slice',
)
replace_once(
    canvas,
    '''PR #135 were completed; Phase 3B4 basic Project-local edges are implemented in\nPR #136, with formal-review fixes awaiting clean independent re-review before merge''',
    '''PR #135 were completed; Phase 3B4 basic Project-local edges are complete in\nsquash-merged PR #136 and Phase 3C Reading is now the active implementation slice''',
)
replace_once(
    canvas,
    '''3B3 Project-owned Markdown and generic attachment creation; PR #136 implements\nPhase 3B4 basic Project-local edges without widening the normalized graph model.''',
    '''3B3 Project-owned Markdown and generic attachment creation; merged PR #136 delivers\nPhase 3B4 basic Project-local edges without widening the normalized graph model.''',
)
replace_once(
    canvas,
    '''The Phase 3B4 edge mutation, retry, history, and verification boundary is in\n[PROJECT_EDGES_IMPLEMENTATION_PLAN.md](./PROJECT_EDGES_IMPLEMENTATION_PLAN.md).''',
    '''The Phase 3B4 edge mutation, retry, history, and verification boundary is in\n[PROJECT_EDGES_IMPLEMENTATION_PLAN.md](./PROJECT_EDGES_IMPLEMENTATION_PLAN.md).\nThe Phase 3C projection/editing boundary is in\n[PROJECT_READING_IMPLEMENTATION_PLAN.md](./PROJECT_READING_IMPLEMENTATION_PLAN.md).''',
)
replace_once(
    canvas,
    '''Phase 3A1/3A2 and Phase 3B1/3B2/3B3 are complete through PR #135. Phase 3B4\nis implemented in PR #136 and awaits clean re-review and squash merge. After\nthat merge, the remaining sequence starts with Phase 3C:''',
    '''Phase 3A1/3A2 and Phase 3B1/3B2/3B3 are complete through PR #135, and Phase 3B4\nis complete in squash-merged PR #136. Phase 3C is the active implementation slice,\nwith the remaining sequence:''',
)

pkg = "package.json"
replace_once(
    pkg,
    '''    "test:project-edges-mounted": "vitest run --config vitest.mounted.config.ts src/project-edges.mount.test.tsx src/project-edge-surface.mount.test.tsx",\n    "verify:d1-migrations":''',
    '''    "test:project-edges-mounted": "vitest run --config vitest.mounted.config.ts src/project-edges.mount.test.tsx src/project-edge-surface.mount.test.tsx",\n    "test:project-reading": "vitest run src/project-reading-contract.test.ts src/lib/project-map-model.test.ts src/project-owned-content-contract.test.ts src/project-reference-placement-contract.test.ts",\n    "test:project-reading-mounted": "vitest run --config vitest.mounted.config.ts src/project-reading.mount.test.tsx src/project-page.mobile.mount.test.tsx src/project-map-surface.mount.test.tsx",\n    "verify:d1-migrations":''',
)
replace_once(
    pkg,
    '''    "verify:project-edges": "npm run test:project-edges && npm run test:project-edges-mounted && npm run verify:project-worker && npm run build && node scripts/verify-project-map-bundle.mjs",\n    "verify:v3-deployment": "npm run test:blob-lifecycle && npm run test:reference-foundation && npm run test:project-foundation && npm run verify:project-persistence && npm run verify:project-map && npm run verify:project-reference-placement && npm run verify:project-owned-content && npm run verify:project-edges && npm run verify:d1-migrations && npm run verify:reference-worker && npm run verify:reference-search-worker && npm test && npm run build:deploy"''',
    '''    "verify:project-edges": "npm run test:project-edges && npm run test:project-edges-mounted && npm run verify:project-worker && npm run build && node scripts/verify-project-map-bundle.mjs",\n    "verify:project-reading": "npm run test:project-reading && npm run test:project-reading-mounted && npm run verify:project-worker && npm run build && node scripts/verify-project-map-bundle.mjs",\n    "verify:v3-deployment": "npm run test:blob-lifecycle && npm run test:reference-foundation && npm run test:project-foundation && npm run verify:project-persistence && npm run verify:project-map && npm run verify:project-reference-placement && npm run verify:project-owned-content && npm run verify:project-edges && npm run verify:project-reading && npm run verify:d1-migrations && npm run verify:reference-worker && npm run verify:reference-search-worker && npm test && npm run build:deploy"''',
)

deploy_test = "worker/deployment-routing.test.ts"
replace_once(
    deploy_test,
    'npm run verify:project-owned-content && npm run verify:project-edges && npm run verify:d1-migrations',
    'npm run verify:project-owned-content && npm run verify:project-edges && npm run verify:project-reading && npm run verify:d1-migrations',
)

workflow = ".github/workflows/verify.yml"
replace_once(
    workflow,
    '''      - name: Run tests\n        id: tests''',
    '''      - name: Run Project Reading contract\n        id: project_reading\n        shell: bash\n        run: |\n          set -o pipefail\n          npm run verify:project-reading 2>&1 | tee project-reading.log\n\n      - name: Record Project Reading status\n        if: ${{ always() && steps.project_reading.outcome != 'skipped' }}\n        uses: actions/github-script@v7\n        env:\n          STAGE_OUTCOME: ${{ steps.project_reading.outcome }}\n        with:\n          script: |\n            const fs = require("fs");\n            const outcome = process.env.STAGE_OUTCOME;\n            const log = fs.existsSync("project-reading.log") ? fs.readFileSync("project-reading.log", "utf8") : "";\n            const stripAnsi = (value) => value.replace(/\\u001B\\[[0-9;]*m/g, "");\n            const lines = log.split(/\\r?\\n/).map((line) => stripAnsi(line).trim()).filter(Boolean);\n            const detail = lines.find((line) => /FAIL|AssertionError|error TS|Error:|×|✗/.test(line)) || lines.at(-1) || "failure";\n            await github.rest.repos.createCommitStatus({\n              owner: context.repo.owner,\n              repo: context.repo.repo,\n              sha: context.sha,\n              state: outcome === "success" ? "success" : "failure",\n              context: "pre-pr/project-reading",\n              description: outcome === "success" ? "Project Reading passed" : detail.slice(0, 140),\n            });\n\n      - name: Run tests\n        id: tests''',
)

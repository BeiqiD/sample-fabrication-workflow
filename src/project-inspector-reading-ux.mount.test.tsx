// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectInspectorDetails } from "./components/project/ProjectInspectorDetails";
import { ProjectInspectorChildren } from "./components/project/ProjectInspectorChildren";
import { ProjectReadingSurface } from "./components/project/ProjectReadingSurface";
import { projectMapNodes } from "./lib/project-map-model";
import { projectTestSnapshot, projectTestSnapshotWithAttachment } from "./project-test-fixture";

afterEach(cleanup);

describe("compact Inspector and Reading interactions", () => {
  it("expands the complete note without cutting its math and resets the disclosure for another item", async () => {
    const snapshot = projectTestSnapshot();
    snapshot.contents[0].markdownSource = "# Long note\n\n" + "Observation. ".repeat(80)
      + String.raw`

\[
\begin{pmatrix}a&b\\c&d\end{pmatrix}
\]
`;
    const nodes = projectMapNodes(snapshot);
    const descriptor = nodes.find((node) => node.itemId === "item-note")!;
    const view = render(<MemoryRouter><ProjectInspectorDetails snapshot={snapshot} descriptor={descriptor} /></MemoryRouter>);
    await screen.findByRole("heading", { name: "Long note" });
    const preview = screen.getByRole("region", { name: "Inspector Markdown content" });
    expect(preview.querySelector("mtable")).not.toBeNull();
    expect(preview.classList.contains("expanded")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Expand note" }));
    expect(preview.classList.contains("expanded")).toBe(true);
    expect(preview.querySelector("mtable")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Collapse note" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Collapse note" }));
    expect(preview.classList.contains("expanded")).toBe(false);
    fireEvent.click(screen.getByText("Details", { selector: "summary" }));
    expect(view.container.querySelector("details")?.open).toBe(true);
    view.rerender(<MemoryRouter><ProjectInspectorDetails snapshot={snapshot} descriptor={nodes.find((node) => node.itemId === "item-reference")!} /></MemoryRouter>);
    expect(view.container.querySelector("details")?.open).toBe(false);
  });

  it("focuses the related card from a relationship instead of rendering a dead-end row", () => {
    const snapshot = projectTestSnapshot();
    snapshot.edges = [{
      id: "edge-a", projectId: snapshot.project.id, sourceItemId: "item-note", targetItemId: "item-reference",
      sourceHandle: "right", targetHandle: "left", markerStart: "none", markerEnd: "arrow", label: "supports",
      revision: 1, createdBy: "user@example.com", updatedBy: "user@example.com",
      createdAt: snapshot.project.createdAt, updatedAt: snapshot.project.createdAt, deletedAt: null, deletedBy: null,
    }];
    const onFocusItem = vi.fn();
    render(<MemoryRouter><ProjectInspectorDetails snapshot={snapshot} descriptor={projectMapNodes(snapshot).find((node) => node.itemId === "item-note")!} onFocusItem={onFocusItem} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "outgoing relationship: supports; Sample A" }));
    expect(onFocusItem).toHaveBeenCalledWith("item-reference");
  });

  it("hands the current related-record parent to References without loading a second result list", () => {
    const onBrowseRelated = vi.fn();
    const view = render(<ProjectInspectorChildren parent={{ type: "sample", id: "sample-a" }} onBrowseRelated={onBrowseRelated} />);
    fireEvent.click(screen.getByRole("button", { name: "Browse related records" }));
    expect(onBrowseRelated).toHaveBeenLastCalledWith({ type: "sample", id: "sample-a" });
    view.rerender(<ProjectInspectorChildren parent={{ type: "run", id: "run-b" }} onBrowseRelated={onBrowseRelated} />);
    fireEvent.click(screen.getByRole("button", { name: "Browse related records" }));
    expect(onBrowseRelated).toHaveBeenLastCalledWith({ type: "run", id: "run-b" });
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("keeps Reading edit actions above long content and trash/export behind More", () => {
    const snapshot = projectTestSnapshotWithAttachment();
    const onMarkdownDeleteRequest = vi.fn();
    const onMarkdownEditRequest = vi.fn();
    render(<MemoryRouter><ProjectReadingSurface nodes={projectMapNodes(snapshot)} onMarkdownEditRequest={onMarkdownEditRequest} onMarkdownDeleteRequest={onMarkdownDeleteRequest} /></MemoryRouter>);
    const edit = screen.getByRole("button", { name: "Edit Markdown" });
    expect(edit.closest("header")).not.toBeNull();
    fireEvent.click(edit);
    expect(onMarkdownEditRequest).toHaveBeenCalledWith("item-note");
    expect(screen.queryByRole("button", { name: "Move Markdown to trash" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Export readable ZIP" })).toBeNull();
    expect(screen.queryByText("#1")).toBeNull();
    fireEvent.click(screen.getByLabelText("More actions for Design note"));
    fireEvent.click(screen.getByRole("button", { name: "Move Markdown to trash" }));
    expect(onMarkdownDeleteRequest).toHaveBeenCalledWith("item-note");
    const options = screen.getByLabelText("Reading options");
    fireEvent.click(options);
    expect(screen.getByRole("button", { name: "Export readable ZIP" })).toBeTruthy();
    fireEvent.keyDown(options, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Export readable ZIP" })).toBeNull();
    expect(document.activeElement).toBe(options);
  });

  it("opens reference sources directly and falls back to the reference record when needed", () => {
    const snapshot = projectTestSnapshot();
    const nodes = projectMapNodes(snapshot);
    const view = render(<MemoryRouter><ProjectReadingSurface nodes={nodes} /></MemoryRouter>);
    const article = view.container.querySelector('[data-project-item-id="item-reference"]') as HTMLElement;
    expect(within(article).getByRole("link", { name: "Open source" }).getAttribute("href")).toBe("/samples/sample-a");
    view.rerender(<MemoryRouter><ProjectReadingSurface nodes={nodes.map((node) => ({ ...node, openSourceUrl: null }))} /></MemoryRouter>);
    expect(within(article).getByRole("link", { name: "Open reference" }).getAttribute("href")).toBe(nodes.find((node) => node.kind === "reference")!.openReferenceUrl);
  });

  it("keeps rejected attachment metadata editable while an uncertain write remains locked for exact retry", () => {
    const nodes = projectMapNodes(projectTestSnapshotWithAttachment());
    const editor = { itemId: "item-attachment", contentId: "content-attachment", caption: "Keep this caption", sourceUrl: "invalid", status: "error" as const, message: "Enter a valid URL." };
    const onAttachmentChange = vi.fn();
    const onAttachmentSave = vi.fn();
    const view = render(<MemoryRouter><ProjectReadingSurface nodes={nodes} attachmentEditor={editor} onAttachmentChange={onAttachmentChange} onAttachmentSave={onAttachmentSave} /></MemoryRouter>);
    const source = screen.getByLabelText("Reading attachment source URL") as HTMLInputElement;
    expect(source.disabled).toBe(false);
    expect((screen.getByLabelText("Reading attachment caption") as HTMLTextAreaElement).value).toBe("Keep this caption");
    fireEvent.change(source, { target: { value: "https://example.com/corrected" } });
    expect(onAttachmentChange).toHaveBeenCalledWith("sourceUrl", "https://example.com/corrected");
    fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
    expect(onAttachmentSave).toHaveBeenCalledOnce();
    view.rerender(<MemoryRouter><ProjectReadingSurface nodes={nodes} attachmentEditor={{ ...editor, status: "uncertain" }} /></MemoryRouter>);
    expect((screen.getByLabelText("Reading attachment source URL") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Retry exact save" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("renders and saves the shared new-note draft in an empty mobile Reading view", async () => {
    const onMarkdownSave = vi.fn();
    render(<MemoryRouter><ProjectReadingSurface mobile nodes={[]} markdownEditor={{ itemId: "draft-a", isNew: true, geometry: null, value: "# New mobile note", status: "editing", message: null }} onMarkdownSave={onMarkdownSave} /></MemoryRouter>);
    expect(await screen.findByLabelText("New Markdown editor")).toBeTruthy();
    expect(screen.queryByText("This Project is empty")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save Markdown" }));
    expect(onMarkdownSave).toHaveBeenCalledOnce();
  });
});

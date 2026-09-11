// @vitest-environment jsdom
import { forwardRef, useImperativeHandle } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectItemMutationResponse } from "../shared/project-api";
import type { ProjectMapMarkdownEditorState } from "./lib/project-owned-content";
import { ProjectPage } from "./pages/ProjectPage";
import { projectTestSnapshot } from "./project-test-fixture";

const mapViewport = vi.hoisted(() => ({ center: { x: 400, y: 300 } as { x: number; y: number } | null }));

vi.mock("./components/ReferenceSearchSurface", () => ({
  ReferenceSearchSurface: () => null,
}));

vi.mock("./components/project/ProjectMapSurface", async () => {
  const React = await import("react");
  return {
    ProjectMapSurface: React.forwardRef((props: {
      markdownEditor?: ProjectMapMarkdownEditorState | null;
      onMarkdownCreateRequest?: (point: { x: number; y: number }) => void;
      onMarkdownChange?: (value: string) => void;
      onMarkdownSave?: () => void;
      onMarkdownCancel?: () => void;
      onAttachmentRequest?: (point: { x: number; y: number }) => void;
    }, ref: React.ForwardedRef<{ getViewportCenter: () => { x: number; y: number } | null }>) => {
      React.useImperativeHandle(ref, () => ({ getViewportCenter: () => mapViewport.center }));
      return <div>
        <button type="button" onClick={() => props.onMarkdownCreateRequest?.({ x: 100, y: 200 })}>Simulate Markdown double click</button>
        <button type="button" onClick={() => props.onAttachmentRequest?.({ x: 300, y: 240 })}>Simulate attachment request</button>
        {props.markdownEditor && <div>
          <textarea aria-label="Mock Markdown editor" value={props.markdownEditor.value} disabled={props.markdownEditor.status !== "editing"} onChange={(event) => props.onMarkdownChange?.(event.currentTarget.value)} />
          <button type="button" onClick={props.onMarkdownSave}>{props.markdownEditor.status === "uncertain" ? "Retry exact Markdown save" : "Save Markdown"}</button>
          {props.markdownEditor.status !== "saving" && props.markdownEditor.status !== "uncertain" && <button type="button" onClick={props.onMarkdownCancel}>Cancel Markdown</button>}
          {props.markdownEditor.message && <p>{props.markdownEditor.message}</p>}
        </div>}
      </div>;
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

function renderProjectPage() {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }], { initialEntries: ["/projects/project-a"] });
  return render(<RouterProvider router={router} />);
}

function mutationResponse(input: Record<string, any>, kind: "markdown" | "attachment", file?: File): ProjectItemMutationResponse {
  const snapshot = projectTestSnapshot();
  const now = "2026-08-12T21:00:00.000Z";
  return {
    project: { ...snapshot.project, revision: snapshot.project.revision + 1, nextCreatedSequence: snapshot.project.nextCreatedSequence + 1, updatedAt: now },
    item: {
      id: input.itemId,
      projectId: "project-a",
      itemType: "content",
      projectContentId: input.contentId,
      referenceTargetId: null,
      createdSequence: snapshot.project.nextCreatedSequence,
      revision: 1,
      createdBy: "user@example.com",
      updatedBy: "user@example.com",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedBy: null,
    },
    content: {
      id: input.contentId,
      projectId: "project-a",
      contentType: kind,
      markdownSource: kind === "markdown" ? input.markdownSource : null,
      attachmentCaption: kind === "attachment" ? input.caption : null,
      attachmentSourceUrl: kind === "attachment" ? input.sourceUrl : null,
      formatVersion: 1,
      revision: 1,
      createdBy: "user@example.com",
      updatedBy: "user@example.com",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedBy: null,
    },
    attachment: kind === "attachment" ? {
      projectContentId: input.contentId,
      originalName: file?.name ?? "attachment.bin",
      mimeType: file?.type || "application/octet-stream",
      byteSize: file?.size ?? 1,
      createdBy: "user@example.com",
      createdAt: now,
      fileUrl: `/api/projects/project-a/contents/${input.contentId}/file`,
    } : null,
    placement: {
      id: input.placementId,
      projectItemId: input.itemId,
      ...input.geometry,
      revision: 1,
      createdBy: "user@example.com",
      updatedBy: "user@example.com",
      createdAt: now,
      updatedAt: now,
    },
    replayed: false,
  };
}

describe("mounted Phase 3B3 Project-owned content", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    mapViewport.center = { x: 400, y: 300 };
    vi.stubGlobal("matchMedia", desktopMatchMedia());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("adds Markdown at the current viewport, keeps the draft local, and exact-retries Save", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(projectTestSnapshot()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    renderProjectPage();
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    // The viewport can move after opening Add; read it when choosing the action.
    mapViewport.center = { x: 600, y: 500 };
    fireEvent.click(screen.getByRole("button", { name: "Note / Markdown" }));
    fireEvent.change(screen.getByLabelText("Mock Markdown editor"), { target: { value: "# New idea" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Temporary create failure" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }));
    fireEvent.click(screen.getByRole("button", { name: "Save Markdown" }));
    expect(await screen.findByText("Temporary create failure")).toBeTruthy();
    const firstBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/projects/project-a/items/markdown");
    expect(firstBody).toMatchObject({
      markdownSource: "# New idea", expectedProjectRevision: 2,
      geometry: { x: 420, y: 428, width: 360, height: 220 },
    });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(mutationResponse(firstBody, "markdown")), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    fireEvent.click(screen.getByRole("button", { name: "Retry exact Markdown save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual(firstBody);
    await waitFor(() => expect(screen.queryByLabelText("Mock Markdown editor")).toBeNull());
  });

  it("uploads a generic Unicode-named file before creating the attachment occurrence", async () => {
    const file = new File(["pdf"], "实验结果.pdf", { type: "application/pdf" });
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(projectTestSnapshot()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "asset-uploaded", key: "sha256/x", deduplicated: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockImplementationOnce((_path, init) => {
        const input = JSON.parse(String(init?.body));
        return Promise.resolve(new Response(JSON.stringify(mutationResponse(input, "attachment", file)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      });

    renderProjectPage();
    await screen.findByRole("button", { name: "Add" });
    fireEvent.click(screen.getByRole("button", { name: "Close References" }));
    const chooseFile = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Attachment" }));
    expect(chooseFile).toHaveBeenCalledOnce();
    expect(screen.queryByRole("group", { name: "Add to Project" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add" }));
    fireEvent.change(screen.getByLabelText("Choose Project attachment"), { target: { files: [file] } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/project-assets");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "POST",
      body: file,
      headers: {
        "content-type": "application/pdf",
        "x-project-filename-uri": encodeURIComponent(file.name),
      },
    });
    expect(fetchMock.mock.calls[2][0]).toBe("/api/projects/project-a/items/attachment");
    const createBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(createBody).toMatchObject({
      locator: { assetId: "asset-uploaded" },
      caption: null,
      sourceUrl: null,
      expectedProjectRevision: 2,
      geometry: { x: 230, y: 300 - 170 / 3, width: 340, height: 170 },
    });
  });

  it.each(["Note / Markdown", "Attachment"])("reports an unready viewport for %s without starting a write", async (action) => {
    mapViewport.center = null;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(projectTestSnapshot())));
    const chooseFile = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    renderProjectPage();
    const add = await screen.findByRole("button", { name: "Add" });
    fireEvent.click(add);
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(screen.getByText("The Map is still loading. Try adding content again in a moment.")).toBeTruthy();
    expect(screen.queryByLabelText("Mock Markdown editor")).toBeNull();
    expect(chooseFile).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(add);
  });

  it("keeps Reference discovery available while an existing Markdown draft blocks new content", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(projectTestSnapshot())));
    renderProjectPage();
    fireEvent.click(await screen.findByRole("button", { name: "Simulate Markdown double click" }));
    fireEvent.click(screen.getByRole("button", { name: "Close References" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const menu = screen.getByRole("group", { name: "Add to Project" });
    expect((within(menu).getByRole("button", { name: "Note / Markdown" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(menu).getByRole("button", { name: "Attachment" }) as HTMLButtonElement).disabled).toBe(true);
    const reference = within(menu).getByRole("button", { name: "Reference from research record" });
    expect((reference as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(reference);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("complementary", { name: "Reference search and placement" })));
    expect(screen.getByLabelText("Mock Markdown editor")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Add to Project" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

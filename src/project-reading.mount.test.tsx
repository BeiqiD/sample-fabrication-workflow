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
    expect(screen.getByRole("heading", { level: 1, name: "Design note" })).toBeTruthy();
    expect(screen.getByText("Preserve the occurrence identity.")).toBeTruthy();
    expect(document.querySelector(".project-reading-markdown-source")?.textContent).not.toContain("# Design note");
    expect(screen.getByText(snapshot.contents.find((content) => content.id === "content-attachment")!.attachmentCaption!)).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent))
      .toEqual(["Sample A", "result.pdf"]);
  });

  it("edits existing Markdown through Reading with the authoritative content update", async () => {
    const snapshot = snapshotWithAttachment();
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(snapshot);
      if (String(path) === "/api/projects/project-a/contents/content-note/markdown" && init?.method === "PATCH") {
        const input = JSON.parse(String(init.body));
        return jsonResponse({ value: { ...snapshot.contents[0], markdownSource: input.markdownSource, revision: 2 }, replayed: false });
      }
      return jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${String(path)}` }, 500);
    });

    renderProjectPage();
    await screen.findByText("Map fixture");
    fireEvent.click(screen.getByRole("button", { name: "Reading" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
    fireEvent.change(await screen.findByLabelText("Reading Markdown editor"), { target: { value: "# Updated reading note\n\nFull body" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Markdown" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const request = fetchMock.mock.calls[1];
    expect(request[0]).toBe("/api/projects/project-a/contents/content-note/markdown");
    const body = JSON.parse(String(request[1]?.body));
    expect(body).toMatchObject({ markdownSource: "# Updated reading note\n\nFull body", expectedRevision: 1 });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Updated reading note" })).toBeTruthy();
      expect(screen.getByText("Full body")).toBeTruthy();
      expect(document.querySelector(".project-reading-markdown-source")?.textContent).not.toContain("# Updated reading note");
    });
  });

  it("edits attachment caption and source URL without exposing byte replacement", async () => {
    const snapshot = snapshotWithAttachment();
    const content = snapshot.contents.find((candidate) => candidate.id === "content-attachment")!;
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(snapshot);
      if (String(path) === "/api/projects/project-a/contents/content-attachment/attachment" && init?.method === "PATCH") {
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
    expect(fetchMock.mock.calls[1][0]).toBe("/api/projects/project-a/contents/content-attachment/attachment");
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

  it("moves existing Markdown to trash with item and content revision guards", async () => {
    const snapshot = snapshotWithAttachment();
    const item = snapshot.items.find((candidate) => candidate.projectContentId === "content-note")!;
    const content = snapshot.contents.find((candidate) => candidate.id === "content-note")!;
    const placement = snapshot.placements.find((candidate) => candidate.projectItemId === item.id)!;
    const deletedAt = "2026-08-14T18:30:00.000Z";
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(snapshot);
      if (String(path) === `/api/projects/project-a/items/${item.id}` && init?.method === "DELETE") {
        return jsonResponse({
          project: { ...snapshot.project, revision: snapshot.project.revision + 1, updatedAt: deletedAt },
          item: { ...item, revision: item.revision + 1, deletedAt, deletedBy: "user@example.com", updatedAt: deletedAt },
          content: { ...content, revision: content.revision + 1, deletedAt, deletedBy: "user@example.com", updatedAt: deletedAt },
          attachment: null,
          placement,
          replayed: false,
        });
      }
      return jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${String(path)}` }, 500);
    });

    renderProjectPage();
    await screen.findByText("Map fixture");
    fireEvent.click(screen.getByRole("button", { name: "Reading" }));
    fireEvent.click(await screen.findByRole("button", { name: "Move Markdown to trash" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const request = fetchMock.mock.calls[1];
    expect(request[0]).toBe(`/api/projects/project-a/items/${item.id}`);
    expect(request[1]?.method).toBe("DELETE");
    const body = JSON.parse(String(request[1]?.body));
    expect(body).toMatchObject({
      expectedItemRevision: item.revision,
      expectedContentRevision: content.revision,
    });
    expect(body.operationId).toEqual(expect.any(String));
    await waitFor(() => {
      expect(document.querySelector(".project-reading-markdown-source")).toBeNull();
      expect(screen.queryByRole("button", { name: "Move Markdown to trash" })).toBeNull();
    });
  });
});

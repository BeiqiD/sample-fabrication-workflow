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
    ProjectMapSurface: React.forwardRef((props: {
      selectedItemId?: string | null;
      focusedItemId?: string | null;
    }, ref: React.ForwardedRef<{ getViewportCenter: () => { x: number; y: number } }>) => {
      React.useImperativeHandle(ref, () => ({ getViewportCenter: () => ({ x: 400, y: 300 }) }));
      return <div
        data-testid="project-flow-canvas"
        data-selected-item-id={props.selectedItemId ?? ""}
        data-focused-item-id={props.focusedItemId ?? ""}
      >Map fixture</div>;
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

function renderProjectPage(initialEntry = "/projects/project-a") {
  const router = createMemoryRouter([{
    path: "/projects/:projectId",
    element: <ProjectPage />,
  }], { initialEntries: [initialEntry] });
  return render(<RouterProvider router={router} />);
}

describe("mounted Phase 3C Reading projection", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const clipboardWriteText = vi.fn<(value: string) => Promise<void>>();

  beforeEach(() => {
    vi.stubGlobal("matchMedia", desktopMatchMedia());
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    clipboardWriteText.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    clipboardWriteText.mockReset();
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

  it("opens, copies, and projects one exact canonical occurrence focus", async () => {
    const snapshot = snapshotWithAttachment();
    fetchMock.mockResolvedValueOnce(await jsonResponse(snapshot));
    renderProjectPage("/projects/project-a?focus=item-note");

    const map = await screen.findByTestId("project-flow-canvas");
    await waitFor(() => {
      expect(map.getAttribute("data-selected-item-id")).toBe("item-note");
      expect(map.getAttribute("data-focused-item-id")).toBe("item-note");
    });
    expect(screen.getByRole("heading", { level: 2, name: "Design note" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy stable link" }));
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledWith(
      `${window.location.origin}/projects/project-a?focus=item-note`,
    ));
    expect(await screen.findByRole("button", { name: "Stable link copied" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reading" }));
    const focusedReadingItem = await waitFor(() => {
      const candidate = document.querySelector<HTMLElement>('[data-project-item-id="item-note"]');
      expect(candidate).toBeTruthy();
      return candidate!;
    });
    expect(focusedReadingItem.classList.contains("focused")).toBe(true);
    expect(focusedReadingItem.getAttribute("aria-current")).toBe("location");
  });

  it("fails malformed and unavailable occurrence focus links visibly", async () => {
    const snapshot = snapshotWithAttachment();
    fetchMock.mockResolvedValueOnce(await jsonResponse(snapshot));
    renderProjectPage("/projects/project-a?focus=item-note&focus=item-reference");
    expect(await screen.findByText("The Project occurrence focus link is malformed and was not applied.")).toBeTruthy();
    cleanup();

    fetchMock.mockResolvedValueOnce(await jsonResponse(snapshot));
    renderProjectPage("/projects/project-a?focus=item-missing");
    expect(await screen.findByText("The linked Project occurrence is no longer available in this active Project.")).toBeTruthy();
  });

  it("does not claim that a stable link was copied when clipboard access fails", async () => {
    const snapshot = snapshotWithAttachment();
    fetchMock.mockResolvedValueOnce(await jsonResponse(snapshot));
    clipboardWriteText.mockRejectedValueOnce(new Error("denied"));
    renderProjectPage("/projects/project-a?focus=item-note");

    await screen.findByRole("button", { name: "Copy stable link" });
    fireEvent.click(screen.getByRole("button", { name: "Copy stable link" }));
    expect(await screen.findByText("Clipboard access was unavailable; the link was not copied.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stable link copied" })).toBeNull();
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
  it("moves a standalone attachment to trash with item and content revision guards", async () => {
    const snapshot = snapshotWithAttachment();
    const item = snapshot.items.find((candidate) => candidate.projectContentId === "content-attachment")!;
    const content = snapshot.contents.find((candidate) => candidate.id === "content-attachment")!;
    const attachment = snapshot.attachments.find((candidate) => candidate.projectContentId === content.id)!;
    const placement = snapshot.placements.find((candidate) => candidate.projectItemId === item.id)!;
    const deletedAt = "2026-08-19T09:30:00.000Z";
    fetchMock.mockImplementation((path, init) => {
      if (String(path) === "/api/projects/project-a" && !init?.method) return jsonResponse(snapshot);
      if (String(path) === `/api/projects/project-a/items/${item.id}` && init?.method === "DELETE") {
        return jsonResponse({
          project: { ...snapshot.project, revision: snapshot.project.revision + 1, updatedAt: deletedAt },
          item: { ...item, revision: item.revision + 1, deletedAt, deletedBy: "user@example.com", updatedAt: deletedAt },
          content: { ...content, revision: content.revision + 1, deletedAt, deletedBy: "user@example.com", updatedAt: deletedAt },
          attachment,
          placement,
          replayed: false,
        });
      }
      return jsonResponse({ error: `Unexpected ${init?.method || "GET"} ${String(path)}` }, 500);
    });

    renderProjectPage();
    await screen.findByText("Map fixture");
    fireEvent.click(screen.getByRole("button", { name: "Reading" }));
    fireEvent.click(await screen.findByRole("button", { name: "Move attachment to trash" }));

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
      expect(screen.queryByRole("heading", { level: 2, name: "result.pdf" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Move attachment to trash" })).toBeNull();
      expect(screen.getByRole("heading", { level: 1, name: "Design note" })).toBeTruthy();
    });
  });
});

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeReferenceSourceFocus } from "../shared/reference-destinations";
import type { CommentSubmission, SampleDetail } from "../shared/types";
import { SamplePage } from "./pages/SamplePage";

function comment(id: string, body: string, hour: number): CommentSubmission {
  const createdAt = `2026-09-12T${hour}:00:00.000Z`;
  return {
    id, body, createdAt, updatedAt: createdAt,
    contextKind: "sample", scope: null, status: "ready", error: null,
    actorEmail: "researcher@example.com", images: [], attachments: [],
  };
}

const referencedComment = comment("older-source-note", "Referenced observation from an earlier measurement.", 10);
const unrelatedComment = comment("newest-note", "A separate recent observation.", 13);
const sample: SampleDetail = {
  id: "source-focus-sample", code: "SOURCE-001", title: "Reference source sample",
  status: "stored", location: "Lab", description: null,
  parentId: null, inheritedStateHash: null, pinned: false,
  createdAt: "2026-09-12T09:00:00.000Z", updatedAt: "2026-09-12T14:00:00.000Z",
  latestWorkflowName: null, latestWorkflowVersion: null, latestRunStatus: null,
  currentStepTitle: null, currentStateStepTitle: null, currentStateThumbnailKey: null,
  parent: null, children: [], runs: [], events: [], stateVerifications: [],
  comments: [
    unrelatedComment,
    comment("middle-note-a", "Intermediate observation A.", 12),
    comment("middle-note-b", "Intermediate observation B.", 11),
    referencedComment,
  ],
};

function sourceUrl(note: CommentSubmission) {
  const query = new URLSearchParams({ focus: encodeReferenceSourceFocus({ type: "comment", id: note.id }) });
  return `/samples/${sample.id}?${query}`;
}

function mountSourceNavigation() {
  return render(<MemoryRouter initialEntries={["/reference"]}>
    <nav>
      <Link to={sourceUrl(referencedComment)}>Open source</Link>
      <Link to={sourceUrl(unrelatedComment)}>Open another source</Link>
      <Link to={`/samples/${sample.id}`}>Clear reference focus</Link>
    </nav>
    <Routes>
      <Route path="/reference" element={<p>Comment reference</p>} />
      <Route path="/samples/:sampleId" element={<SamplePage />} />
    </Routes>
  </MemoryRouter>);
}

async function noteArticle(note: CommentSubmission) {
  const body = await screen.findByText(note.body);
  const article = body.closest("article");
  if (!article) throw new Error(`Note ${note.id} did not render in an article`);
  return article;
}

describe("Sample note Open source navigation", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

  beforeEach(() => {
    fetchMock.mockImplementation(async (path, init) => {
      if ((init?.method ?? "GET") !== "GET") throw new Error(`Unexpected mutation: ${init?.method} ${path}`);
      if (String(path) === `/api/samples/${sample.id}`) return Response.json(sample);
      if (String(path) === "/api/storage/status") return Response.json({
        provider: null, available: false, authentication: "not_configured", message: "File storage is not configured.",
      });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    vi.stubGlobal("scrollBy", vi.fn());
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("opens an older note, preserves its metadata, and moves or clears focus when the URL changes", async () => {
    mountSourceNavigation();
    fireEvent.click(screen.getByRole("link", { name: "Open source" }));
    const target = await noteArticle(referencedComment);
    const unrelated = await noteArticle(unrelatedComment);

    await waitFor(() => expect(target.getAttribute("data-reference-focused")).toBe("true"));
    expect(unrelated.hasAttribute("data-reference-focused")).toBe(false);
    expect(screen.getByRole("button", { name: "Show recent 3" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(target).getByText("Referenced")).toBeTruthy();
    expect(target.querySelector("time")?.getAttribute("datetime")).toBe(referencedComment.createdAt);
    expect(target.querySelector("time")?.textContent).toBe(new Date(referencedComment.createdAt).toLocaleString());

    fireEvent.click(screen.getByRole("link", { name: "Open another source" }));
    await waitFor(() => expect(unrelated.getAttribute("data-reference-focused")).toBe("true"));
    expect(target.hasAttribute("data-reference-focused")).toBe(false);
    expect(target.classList.contains("reference-source-focus")).toBe(false);

    fireEvent.click(screen.getByRole("link", { name: "Clear reference focus" }));
    await waitFor(() => expect(unrelated.hasAttribute("data-reference-focused")).toBe(false));
    expect(unrelated.classList.contains("reference-source-focus")).toBe(false);
    expect(target.isConnected).toBe(true);
  });

  it("opens deletion for the referenced note and cancels without mutating the sample", async () => {
    mountSourceNavigation();
    fireEvent.click(screen.getByRole("link", { name: "Open source" }));
    const target = await noteArticle(referencedComment);
    await waitFor(() => expect(target.getAttribute("data-reference-focused")).toBe("true"));
    const deleteButton = within(target).getByRole("button", { name: "Delete note" });
    deleteButton.focus();
    fireEvent.click(deleteButton);

    const dialog = await screen.findByRole("alertdialog", { name: "Delete this sample note?" });
    expect(within(dialog).getByText(referencedComment.body)).toBeTruthy();
    expect(within(dialog).queryByText(unrelatedComment.body)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(deleteButton);
    expect(target.getAttribute("data-reference-focused")).toBe("true");
    expect(target.isConnected).toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") !== "GET")).toEqual([]);
  });
});

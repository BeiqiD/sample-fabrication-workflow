// @vitest-environment jsdom
import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommentAttachment, CommentImage, SampleDetail, SampleEvent, SampleRun } from "../shared/types";
import { CommentAttachmentList } from "./components/CommentAttachmentList";
import { DiagramGallery, MultiSampleRunGrid } from "./components/MultiSampleRunGrid";
import { SampleTimeline } from "./components/SampleTimeline";
import { api } from "./lib/api";
import { useModalDialog } from "./lib/use-modal-dialog";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SamplePage } from "./pages/SamplePage";

function file(id = "file-a", patch: Partial<Extract<CommentAttachment, { kind: "file" }>> = {}): Extract<CommentAttachment, { kind: "file" }> {
  return { id, kind: "file", filename: `${id}.tiff`, title: "Surface measurement", description: "Unchanged original", mimeType: "image/tiff", byteSize: 2097152, sha256: null,
    downloadUrl: `/api/attachments/${id}/download`, status: "ready", error: null, relatedCommentImageId: null, ...patch };
}
function image(): CommentImage {
  return { id: "preview-a", filename: "preview.png", mimeType: "image/png", byteSize: 100, originalFilename: "original.tiff", originalMimeType: "image/tiff", originalByteSize: 200,
    assetKey: null, assetUrl: "/api/file-assets/preview-a", status: "ready", error: null, relatedAttachmentId: "file-a" };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.style.overflow = ""; });

describe("Comment attachment presentation and child lifecycle", () => {
  it("separates contextual title, original filename, MIME and size, and gates unsafe or incomplete reads", () => {
    render(<CommentAttachmentList attachments={[file(), file("waiting", { status: "uploading" }), file("unavailable", { downloadUrl: null }), file("failed", { status: "failed", error: "Upload interrupted" }),
      { id: "unsafe", kind: "link", title: "Unsafe source", description: null, url: "javascript:alert(1)", status: "ready", error: null }]} />);
    expect(screen.getAllByText("Surface measurement")).toHaveLength(4);
    expect(screen.getByText("file-a.tiff")).toBeTruthy();
    expect(screen.getAllByText("image/tiff")).toHaveLength(4);
    expect(screen.getAllByText("2.1 MB")).toHaveLength(4);
    expect(screen.getByRole("link", { name: "Download file: file-a.tiff" }).getAttribute("download")).toBe("file-a.tiff");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText("Uploading")).toBeTruthy();
    expect(screen.getByText("Upload interrupted")).toBeTruthy();
    expect(screen.getAllByText("Attachment unavailable")).toHaveLength(2);
  });

  it("cancels a ready-child confirmation without mutation and returns focus to its exact trigger", async () => {
    const mutation = vi.spyOn(api, "removeReadyCommentSubmissionItem");
    render(<><p>Comment body remains</p><CommentAttachmentList attachments={[file()]} submissionId="submission-a" onChanged={async () => {}} /></>);
    const trigger = screen.getByRole("button", { name: "Remove attachment: file-a.tiff" });
    trigger.focus(); fireEvent.click(trigger);
    const dialog = screen.getByRole("alertdialog", { name: "Remove this attachment?" });
    expect(within(dialog).getByText(/guaranteed 24-hour recovery window/)).toBeTruthy();
    expect(within(dialog).queryByText(/cannot be undone/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(trigger); expect(mutation).not.toHaveBeenCalled();
    expect(screen.getByText("Comment body remains")).toBeTruthy();
  });

  it("removes only the exact ready child, blocks dismissal in flight, and focuses the surviving attachment group", async () => {
    let complete!: (response: Response) => void;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    function Owner() {
      const [attachments, setAttachments] = useState<CommentAttachment[]>([file(), file("file-b")]);
      return <><p>Canonical Comment body</p><CommentAttachmentList attachments={attachments} submissionId="submission-a" onChanged={async () => setAttachments(current => current.filter(item => item.id !== "file-a"))} /></>;
    }
    render(<Owner />);
    const trigger = screen.getByRole("button", { name: "Remove attachment: file-a.tiff" }); trigger.focus(); fireEvent.click(trigger);
    let dialog = screen.getByRole("alertdialog"); fireEvent.click(within(dialog).getByRole("button", { name: "Remove attachment" }));
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/comment-submissions/submission-a/items/file-a", { method: "DELETE" });
    expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" }); expect(screen.getByRole("alertdialog")).toBeTruthy();
    complete(Response.json({ ok: true }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.queryByText("file-a.tiff")).toBeNull(); expect(screen.getByText("file-b.tiff")).toBeTruthy();
    expect(screen.getByText("Canonical Comment body")).toBeTruthy();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Comment attachments");
  });

  it("restores focus within a parent modal after the last child is removed", async () => {
    vi.spyOn(api, "removeReadyCommentSubmissionItem").mockResolvedValue({ ok: true });
    function Parent() {
      const parent = useRef<HTMLDivElement>(null);
      const [attachments, setAttachments] = useState<CommentAttachment[]>([file()]);
      useModalDialog({ dialogRef: parent, onClose: () => {} });
      return <div ref={parent} role="dialog" aria-modal="true" aria-label="Process-plan comments"><p>Parent Comment body</p>
        <CommentAttachmentList attachments={attachments} submissionId="submission-a" onChanged={async () => setAttachments([])} /><button>Close parent</button></div>;
    }
    render(<Parent />);
    const trigger = screen.getByRole("button", { name: "Remove attachment: file-a.tiff" }); trigger.focus(); fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove attachment" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByText("No attachments")).toBeTruthy();
    const parent = screen.getByRole("dialog", { name: "Process-plan comments" });
    expect(parent.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Comment attachments");
  });

  it("shows the TIFF original dependency and preserves a concurrent server rejection", async () => {
    const first = render(<CommentAttachmentList attachments={[file("file-a", { relatedCommentImageId: "preview-a" })]} images={[image()]} submissionId="submission-a" onChanged={async () => {}} />);
    expect((screen.getByRole("button", { name: "Remove attachment: file-a.tiff" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Required by the TIFF preview/)).toBeTruthy(); first.unmount();
    const mutation = vi.spyOn(api, "removeReadyCommentSubmissionItem").mockRejectedValue(new Error("A ready TIFF preview requires this original attachment"));
    render(<><p>Retained body</p><CommentAttachmentList attachments={[file()]} submissionId="submission-a" onChanged={async () => {}} /></>);
    fireEvent.click(screen.getByRole("button", { name: "Remove attachment: file-a.tiff" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove attachment" }));
    await screen.findByText(/A ready TIFF preview requires this original attachment/);
    expect(screen.getByRole("button", { name: "Reload attachment state" })).toBeTruthy();
    expect(screen.getByText("Retained body")).toBeTruthy(); expect(screen.getByText("file-a.tiff", { selector: "span" })).toBeTruthy();
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it("reconciles a committed removal with a lost response without replay, including cancel and reopen", async () => {
    const mutation = vi.spyOn(api, "removeReadyCommentSubmissionItem").mockRejectedValue(new TypeError("Response lost"));
    let reloadCount = 0;
    function Owner() {
      const [attachments, setAttachments] = useState<CommentAttachment[]>([file()]);
      return <><p>Owner text survives</p><CommentAttachmentList attachments={attachments} submissionId="submission-a" onChanged={async () => { reloadCount += 1; setAttachments([]); }} /></>;
    }
    render(<Owner />);
    fireEvent.click(screen.getByRole("button", { name: "Remove attachment: file-a.tiff" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove attachment" }));
    await screen.findByRole("button", { name: "Reload attachment state" });
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove attachment: file-a.tiff" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Reload attachment state" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(mutation).toHaveBeenCalledTimes(1); expect(reloadCount).toBe(1); expect(screen.getByText("Owner text survives")).toBeTruthy();
  });

  it("keeps a failed owner refresh reload-only after a confirmed removal", async () => {
    const mutation = vi.spyOn(api, "removeReadyCommentSubmissionItem").mockResolvedValue({ ok: true });
    const reload = vi.fn().mockRejectedValue(new Error("Owner read unavailable"));
    render(<CommentAttachmentList attachments={[file()]} submissionId="submission-a" onChanged={reload} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove attachment: file-a.tiff" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove attachment" }));
    const reloadButton = await screen.findByRole("button", { name: "Reload attachment state" }); fireEvent.click(reloadButton);
    await screen.findByText(/Could not reload attachment state/);
    expect(screen.getByRole("button", { name: "Reload attachment state" })).toBeTruthy(); expect(mutation).toHaveBeenCalledTimes(1); expect(reload).toHaveBeenCalledTimes(2);
  });

  it("distinguishes link removal from byte retention and identifies all common targets", () => {
    render(<CommentAttachmentList attachments={[{ id: "link-a", kind: "link", title: "External evidence", description: "Source context", url: "https://example.test/evidence", status: "ready", error: null }]} submissionId="submission-a" common onChanged={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove attachment: External evidence" }));
    const dialog = screen.getByRole("alertdialog"); expect(within(dialog).getByText(/every target of this common Comment/)).toBeTruthy();
    expect(within(dialog).getByText(/Only the link is removed; the external source is unchanged/)).toBeTruthy(); expect(within(dialog).queryByText(/24-hour/)).toBeNull();
  });
});

describe("image gallery failure and keyboard transitions", () => {
  it.each([0, 1, 3, 16])("keeps %i photo entries in their existing gallery density", count => {
    render(<DiagramGallery keys={[]} urls={Array.from({ length: count }, (_, index) => `/api/assets/photo-${index}`)} label="Photos" kind="photo" />);
    expect(screen.queryAllByRole("listitem")).toHaveLength(count);
    expect(screen.queryAllByRole("button")).toHaveLength(count);
  });
  it("contains Tab, preserves arrows and zoom, and restores the opening trigger on Escape", async () => {
    render(<><button>Outside</button><DiagramGallery keys={[]} urls={["/api/assets/a", "/api/assets/b", "/api/assets/c"]} label="Comment preview" kind="photo" /></>);
    const trigger = screen.getByRole("button", { name: "Open Comment preview 1 of 3" }); trigger.focus(); fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Comment preview" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close image viewer" }));
    const last = within(dialog).getByRole("button", { name: "Next image" }); last.focus(); fireEvent.keyDown(last, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true); expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Reset image zoom" }));
    fireEvent.keyDown(dialog, { key: "ArrowRight" }); expect(within(dialog).getByRole("img").getAttribute("src")).toBe("/api/assets/b");
    fireEvent.keyDown(dialog, { key: "+" }); expect(within(dialog).getByRole("button", { name: "Reset image zoom" }).textContent).toBe("125%");
    fireEvent.keyDown(dialog, { key: "0" }); expect(within(dialog).getByRole("button", { name: "Reset image zoom" }).textContent).toBe("100%");
    expect(within(dialog).queryByRole("link", { name: "Original" })).toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" }); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(document.activeElement).toBe(trigger);
  });

  it("uses current image order after a same-length reorder and preserves active identity", () => {
    const view = render(<DiagramGallery keys={[]} urls={["/api/assets/a", "/api/assets/b", "/api/assets/c"]} label="Evidence" kind="photo" />);
    fireEvent.click(screen.getByRole("button", { name: "Open Evidence 1 of 3" }));
    view.rerender(<DiagramGallery keys={[]} urls={["/api/assets/c", "/api/assets/a", "/api/assets/b"]} label="Evidence" kind="photo" />);
    const dialog = screen.getByRole("dialog"); expect(within(dialog).getByRole("img").getAttribute("src")).toBe("/api/assets/a");
    fireEvent.keyDown(dialog, { key: "ArrowRight" }); expect(within(dialog).getByRole("img").getAttribute("src")).toBe("/api/assets/b");
    fireEvent.keyDown(dialog, { key: "ArrowLeft" }); fireEvent.keyDown(dialog, { key: "ArrowLeft" }); expect(within(dialog).getByRole("img").getAttribute("src")).toBe("/api/assets/c");
  });

  it("falls back on failed images and keeps focus in the modal when retry replaces its button", () => {
    render(<DiagramGallery keys={[]} urls={["/api/assets/a"]} label="Photo" kind="photo" />);
    fireEvent.click(screen.getByRole("button", { name: "Open Photo 1 of 1" })); const dialog = screen.getByRole("dialog");
    fireEvent.error(within(dialog).getByRole("img")); expect(within(dialog).getByText("Preview unavailable")).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "+" }); expect(within(dialog).getByRole("button", { name: "Reset image zoom" }).textContent).toBe("100%");
    expect(within(dialog).getByRole("link", { name: "Open image: Photo" }).getAttribute("href")).toBe("/api/assets/a");
    const retry = within(dialog).getByRole("button", { name: "Retry image preview" }); retry.focus(); fireEvent.click(retry);
    expect(within(dialog).getByRole("img").getAttribute("src")).toBe("/api/assets/a");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close image viewer" }));
  });

  it("resets panning when keyboard zoom returns to 100 percent", () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    render(<DiagramGallery keys={[]} urls={["/api/assets/a"]} label="Photo" kind="photo" />);
    fireEvent.click(screen.getByRole("button", { name: "Open Photo 1 of 1" })); const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "+" });
    const stage = dialog.querySelector<HTMLElement>(".image-lightbox-stage")!; stage.setPointerCapture = vi.fn();
    fireEvent.pointerDown(stage, { clientX: 10, clientY: 10 }); fireEvent.pointerMove(stage, { clientX: 40, clientY: 25 }); fireEvent.pointerUp(stage);
    expect(within(dialog).getByRole("img").style.transform).toContain("translate3d(30px, 15px, 0)");
    fireEvent.keyDown(dialog, { key: "-" }); expect(within(dialog).getByRole("img").style.transform).toBe("translate3d(0px, 0px, 0) scale(1)");
  });

  it("closes a removed active image safely and focuses the persistent empty gallery", async () => {
    const view = render(<DiagramGallery keys={[]} urls={["/api/assets/a"]} label="Photo" kind="photo" />);
    fireEvent.click(screen.getByRole("button", { name: "Open Photo 1 of 1" })); view.rerender(<DiagramGallery keys={[]} urls={[]} label="Photo" kind="photo" />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(screen.getByText("No images available")).toBeTruthy(); expect(document.activeElement).toBe(screen.getByRole("list", { name: "Photo" }));
  });

  it("preserves exact native asset selectors while excluding substituted and unsafe URL entries", () => {
    const nativeDelete = vi.fn(); const legacyDelete = vi.fn();
    render(<DiagramGallery keys={["legacy-a"]} images={[{ assetId: "native-a", fileId: "file-a", url: "/api/file-assets/native-a" }, { assetId: "native-b", fileId: "file-b", url: "/api/file-assets/substituted" }]}
      urls={["https://example.test/external.png", "/api/assets/unsafe\\path", "/api/assets/a\u0000b"]} label="Execution evidence" onDelete={legacyDelete} onDeleteNative={nativeDelete} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Delete Execution evidence 2" })); expect(nativeDelete).toHaveBeenCalledExactlyOnceWith("native-a"); expect(legacyDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete Execution evidence 1" })); expect(legacyDelete).toHaveBeenCalledExactlyOnceWith("legacy-a");
  });

  it("preserves the Timeline thumbnail URL separately from the authorized full-image link", () => {
    const event: SampleEvent = { id: "event-a", sampleId: "sample-a", kind: "image", body: "TIFF observation", assetKey: null, assetUrl: "/api/file-assets/original-a", thumbnailUrl: "/api/file-assets/preview-a", metadata: {}, actorEmail: null, createdAt: "2026-10-08T10:00:00Z" };
    render(<SampleTimeline events={[event]} />);
    expect(screen.getByRole("img").getAttribute("src")).toBe("/api/file-assets/preview-a");
    fireEvent.click(screen.getByRole("button", { name: "Open TIFF observation 1 of 1" })); const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("img").getAttribute("src")).toBe("/api/file-assets/original-a");
    expect(within(dialog).getByRole("link", { name: "Open image" }).getAttribute("href")).toBe("/api/file-assets/original-a");
  });
});

function domainFixture(): { sample: SampleDetail; run: SampleRun } {
  const date = "2026-10-08T10:00:00Z";
  const run: SampleRun = { id: "run-a", recipeFamilyId: "family-a", templateVersionId: "template-a", templateName: "Etch process", templateType: "process", templateVersion: 1, runKind: "process", status: "active",
    currentPlanRevisionId: "revision-a", planRevisionNumber: 1, predecessorRunId: null, anchorStepId: null, sequenceNo: 1, runGroupId: "group-a", initialStateHash: null, initialStateImageKeys: [], createdAt: date, completedAt: null,
    steps: [{ id: "step-a", templateStepId: "template-step-a", logicalStepKey: "step-key-a", sectionName: null, definitionHash: null, expectedStateHash: null, position: 0, planPosition: 0, origin: "template", entryKind: "fabrication", planStatus: "current", title: "Etch", status: "done",
      notes: null, toolName: null, parametersText: null, commentsText: null, deviationNote: null, plannedTitle: "Etch", plannedToolName: null, plannedParametersText: null, plannedCommentsText: null, plannedImageKeys: [], executionImageKeys: [],
      comments: [{ id: "comment-a", scope: "individual", operationGroupId: null, body: "Ready Run Comment body", assetKey: null, submissionId: "submission-a", status: "ready", images: [image()], attachments: [file()], actorEmail: "researcher@example.test", createdAt: date }], actualizedAt: date, verificationIds: [], stateVerification: null, createdAt: date, updatedAt: date }] };
  const sample: SampleDetail = { id: "sample-a", code: "S-001", title: "Attachment sample", status: "active", location: null, parentId: null, inheritedStateHash: null, pinned: false, createdAt: date, updatedAt: date,
    latestWorkflowName: null, latestWorkflowVersion: null, latestRunStatus: null, currentStepTitle: null, currentStateStepTitle: null, currentStateThumbnailKey: null, description: null, parent: null, children: [], events: [], stateVerifications: [], runs: [run], comments: [] };
  return { sample, run };
}

describe("attachment domain adapters", () => {
  function gridGlobals() {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(api, "getManagedStorageStatus").mockResolvedValue({ provider: null, available: false, authentication: "not_configured", message: "Not configured in this test." });
  }
  it.each([true, false])("uses Dense ready cards and respects Run readOnly=%s", async readOnly => {
    gridGlobals(); const { sample, run } = domainFixture();
    render(<MultiSampleRunGrid primaryRun={run} columns={[{ sample, run }]} readOnly={readOnly} onSaved={async () => {}} onAttachmentChanged={async () => {}} />);
    const card = await screen.findByRole("group", { name: "Attachment: file-a.tiff" }); expect(card.getAttribute("data-density")).toBe("dense");
    expect(screen.queryAllByRole("button", { name: /^Remove attachment:/ })).toHaveLength(readOnly ? 0 : 2);
    expect(screen.getByText("Ready Run Comment body")).toBeTruthy();
  });
  it("uses Comfortable Sample cards and a separate canonical Comment Trash action", async () => {
    gridGlobals(); const { sample } = domainFixture(); sample.runs = []; sample.comments = [{ id: "sample-comment-a", contextKind: "sample", scope: null, body: "Sample canonical Comment body", status: "ready", error: null,
      images: [], attachments: [file()], actorEmail: null, createdAt: sample.createdAt, updatedAt: sample.updatedAt }];
    vi.spyOn(api, "getSample").mockResolvedValue(sample);
    render(<MemoryRouter initialEntries={["/samples/sample-a"]}><Routes><Route path="/samples/:sampleId" element={<SamplePage />} /></Routes></MemoryRouter>);
    const card = await screen.findByRole("group", { name: "Attachment: file-a.tiff" }); expect(card.getAttribute("data-density")).toBe("comfortable");
    const trash = screen.getByRole("button", { name: "Move Comment to trash" }); trash.focus(); fireEvent.click(trash);
    const dialog = screen.getByRole("alertdialog", { name: "Move this Comment to trash?" }); expect(within(dialog).getByText(/retained in Trash for 30 days/)).toBeTruthy(); expect(within(dialog).queryByText(/cannot be undone/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })); expect(screen.getByText("Sample canonical Comment body")).toBeTruthy(); expect(document.activeElement).toBe(trash);
  });
});

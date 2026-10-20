// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProjectAttachmentPresentation,
  type ProjectAttachmentPresentationProps,
} from "./components/project/ProjectAttachmentPresentation";
import { ProjectInspectorDetails } from "./components/project/ProjectInspectorDetails";
import { ProjectPanelSurface } from "./components/project/ProjectPanelSurface";
import { projectMapNodes } from "./lib/project-map-model";
import { projectTestSnapshotWithAttachment } from "./project-test-fixture";

const attachment: ProjectAttachmentPresentationProps = {
  title: "surface.png",
  fileUrl: "/api/projects/project-a/contents/surface/file",
  mimeType: "image/png",
  byteSize: 1_200,
  caption: "AFM surface",
  sourceUrl: "https://example.com/source",
};

afterEach(cleanup);

describe("Project attachment presentation", () => {
  it.each(["image/tiff", "image/svg+xml", "image/unknown", "application/pdf", null])(
    "keeps %s on the generic file path without attempting an image",
    (mimeType) => {
      const view = render(<ProjectAttachmentPresentation {...attachment} mimeType={mimeType} />);
      expect(view.container.querySelector("img")).toBeNull();
      expect(screen.queryByRole("button", { name: /Preview image/ })).toBeNull();
      expect(screen.getByText("No browser preview is available for this file.")).toBeTruthy();
      expect(screen.getByRole("link", { name: "Open attachment" }).getAttribute("href"))
        .toBe(attachment.fileUrl);
      expect(screen.getByText(/1.2 kB/)).toBeTruthy();
    },
  );

  it.each([null, "javascript:alert(1)"])(
    "exposes an unavailable file with no open or preview action for %s",
    (fileUrl) => {
      const view = render(<ProjectAttachmentPresentation {...attachment} fileUrl={fileUrl} />);
      expect(view.container.querySelector("img")).toBeNull();
      expect(screen.getByText("The attachment file is unavailable.")).toBeTruthy();
      expect(screen.queryByRole("link", { name: "Open attachment" })).toBeNull();
      expect(screen.queryByRole("button", { name: /Preview image|Retry image/ })).toBeNull();
      expect(screen.getByRole("link", { name: "Open source URL" }).getAttribute("href"))
        .toBe(attachment.sourceUrl);
    },
  );

  it("retains metadata and the original file when an image fails, then retries the same URL", () => {
    render(<ProjectAttachmentPresentation {...attachment} />);
    const image = screen.getByRole("img", { name: "AFM surface" });
    screen.getByRole("button", { name: "Preview image: AFM surface" }).focus();
    fireEvent.error(image);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Image preview unavailable")).toBeTruthy();
    expect(screen.getByText(/The image preview could not be loaded/)).toBeTruthy();
    expect(screen.getByText(/1.2 kB/)).toBeTruthy();
    expect(screen.getByText("AFM surface")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open attachment" }).getAttribute("href"))
      .toBe(attachment.fileUrl);
    const retry = screen.getByRole("button", { name: "Retry image preview" });
    expect(document.activeElement).toBe(retry);
    retry.focus();
    fireEvent.click(retry);
    expect(screen.queryByText("Image preview unavailable")).toBeNull();
    expect(screen.getByRole("img", { name: "AFM surface" }).getAttribute("src"))
      .toBe(attachment.fileUrl);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Preview image: AFM surface" }));
  });

  it("closes a failed full-size preview and returns focus to its retry action", () => {
    render(<ProjectAttachmentPresentation {...attachment} />);
    const trigger = screen.getByRole("button", { name: "Preview image: AFM surface" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Image preview: AFM surface" });
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.error(within(dialog).getByRole("img", { name: "AFM surface" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry image preview" }));
    expect(screen.getByRole("link", { name: "Open attachment" })).toBeTruthy();
  });

  it("resets failures for a changed source and closes the old preview rather than opening a new one", () => {
    const view = render(<ProjectAttachmentPresentation {...attachment} />);
    fireEvent.error(screen.getByRole("img", { name: "AFM surface" }));
    const changed = { ...attachment, fileUrl: "/api/projects/project-a/contents/second/file" };
    view.rerender(<ProjectAttachmentPresentation {...changed} />);
    expect(screen.queryByText("Image preview unavailable")).toBeNull();
    expect(screen.getByRole("img", { name: "AFM surface" }).getAttribute("src")).toBe(changed.fileUrl);
    const trigger = screen.getByRole("button", { name: "Preview image: AFM surface" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeTruthy();
    view.rerender(<ProjectAttachmentPresentation {...attachment} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(screen.getByRole("img", { name: "AFM surface" }).getAttribute("src"))
      .toBe(attachment.fileUrl);
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps unsupported and missing attachments understandable in Inspector", () => {
    const snapshot = projectTestSnapshotWithAttachment();
    snapshot.attachments[0].mimeType = "image/tiff";
    snapshot.attachments[0].byteSize = 1_200;
    snapshot.contents.find((content) => content.id === "content-attachment")!.attachmentSourceUrl = "https://example.com/evidence";
    const descriptor = projectMapNodes(snapshot).find((node) => node.itemId === "item-attachment")!;
    const view = render(<MemoryRouter><ProjectInspectorDetails snapshot={snapshot} descriptor={descriptor} /></MemoryRouter>);
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "Open attachment" }).getAttribute("href"))
      .toBe(snapshot.attachments[0].fileUrl);
    expect(view.container.querySelector(".project-attachment-presentation.compact")).not.toBeNull();
    expect(screen.getAllByRole("link", { name: "Open source URL" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Open source URL" }).getAttribute("href"))
      .toBe("https://example.com/evidence");
    const caption = screen.getByRole("region", { name: "Inspector content preview" });
    expect(caption.textContent).toBe("Evidence");
    expect(caption.tabIndex).toBe(0);
    snapshot.attachments = [];
    const missing = projectMapNodes(snapshot).find((node) => node.itemId === "item-attachment")!;
    view.rerender(<MemoryRouter><ProjectInspectorDetails snapshot={snapshot} descriptor={missing} /></MemoryRouter>);
    expect(screen.getByText("The attachment file is unavailable.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open attachment" })).toBeNull();
  });

  it.each([
    { mimeType: "image/tiff", fileUrl: attachment.fileUrl },
    { mimeType: "image/png", fileUrl: null },
  ])("returns focus to attachment details when an open image becomes $mimeType / $fileUrl", (changed) => {
    const view = render(<ProjectAttachmentPresentation {...attachment} />);
    const trigger = screen.getByRole("button", { name: "Preview image: AFM surface" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Image preview: AFM surface" })).toBeTruthy();
    view.rerender(<ProjectAttachmentPresentation {...attachment} {...changed} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Project attachment: surface.png" }));
  });

  it("returns focus inside an underlying Inspector sheet when its open image becomes unavailable", () => {
    const onClose = vi.fn();
    const sheet = (props: ProjectAttachmentPresentationProps) => <ProjectPanelSurface
      modal label="Project Inspector" onClose={onClose}
    ><ProjectAttachmentPresentation {...props} /></ProjectPanelSurface>;
    const view = render(sheet(attachment));
    const trigger = screen.getByRole("button", { name: "Preview image: AFM surface" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Image preview: AFM surface" })).toBeTruthy();
    view.rerender(sheet({ ...attachment, fileUrl: null }));
    expect(screen.queryByRole("dialog", { name: "Image preview: AFM surface" })).toBeNull();
    const parent = screen.getByRole("dialog", { name: "Project Inspector" });
    expect(parent.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(parent).getByRole("group", { name: "Project attachment: surface.png" }));
    expect(document.body.style.overflow).toBe("hidden");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("uses the same preview, fallback and retry actions in Inspector", () => {
    const snapshot = projectTestSnapshotWithAttachment();
    snapshot.attachments[0].mimeType = "image/png";
    const descriptor = projectMapNodes(snapshot).find((node) => node.itemId === "item-attachment")!;
    render(<MemoryRouter><ProjectInspectorDetails snapshot={snapshot} descriptor={descriptor} /></MemoryRouter>);
    const trigger = screen.getByRole("button", { name: "Preview image: Evidence" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Image preview: Evidence" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.error(screen.getByRole("img", { name: "Evidence" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry image preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry image preview" }));
    expect(screen.getByRole("img", { name: "Evidence" }).getAttribute("src"))
      .toBe(snapshot.attachments[0].fileUrl);
    expect(screen.getByRole("link", { name: "Open attachment" })).toBeTruthy();
  });
});

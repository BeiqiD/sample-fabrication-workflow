// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectNodeDescriptor } from "./lib/project-map-model";
import { ProjectReadingSurface } from "./components/project/ProjectReadingSurface";

const geometry = { x: 0, y: 0, width: 320, height: 180, zIndex: 0 };

function node(input: Partial<ProjectNodeDescriptor> & Pick<ProjectNodeDescriptor, "itemId" | "kind" | "title" | "createdSequence">): ProjectNodeDescriptor {
  return {
    placementId: `placement-${input.itemId}`,
    subtitle: null,
    excerpt: null,
    geometry,
    contentId: null,
    markdownSource: null,
    attachmentCaption: null,
    attachmentSourceUrl: null,
    mimeType: null,
    attachmentByteSize: null,
    fileUrl: null,
    openReferenceUrl: null,
    ...input,
  };
}

afterEach(cleanup);

describe("Phase 3D rich Reading projection", () => {
  it("renders Markdown and TeX instead of exposing raw source syntax", () => {
    render(<MemoryRouter><ProjectReadingSurface nodes={[node({
      itemId: "markdown-a",
      kind: "markdown",
      title: "Research note",
      createdSequence: 1,
      markdownSource: "# Research note\n\nThe state is $\\lvert \\psi \\rangle$.",
    })]} /></MemoryRouter>);

    expect(screen.getByRole("heading", { name: "Research note" })).toBeTruthy();
    expect(document.querySelector(".rich-text-math-inline math")).not.toBeNull();
    expect(document.querySelector(".project-reading-markdown-source")?.textContent)
      .not.toContain("# Research note");
  });

  it("does not mistake an indented code block for a leading heading", () => {
    render(<MemoryRouter><ProjectReadingSurface nodes={[node({
      itemId: "markdown-code",
      kind: "markdown",
      title: "Research note",
      createdSequence: 1,
      markdownSource: "    # shell comment",
    })]} /></MemoryRouter>);

    expect(screen.getByRole("heading", { level: 2, name: "Research note" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getByText("# shell comment")).toBeTruthy();
  });

  it("suppresses the generated title for a leading Setext heading", () => {
    render(<MemoryRouter><ProjectReadingSurface nodes={[node({
      itemId: "markdown-setext",
      kind: "markdown",
      title: "Generated title",
      createdSequence: 1,
      markdownSource: "Canonical title\n===============\n\nBody",
    })]} /></MemoryRouter>);

    expect(screen.getByRole("heading", { level: 1, name: "Canonical title" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Generated title" })).toBeNull();
  });


  it("uses the shared modal contract for image previews", () => {
    render(<MemoryRouter><ProjectReadingSurface nodes={[node({
      itemId: "image-a",
      kind: "attachment",
      title: "surface.png",
      createdSequence: 1,
      attachmentCaption: "AFM surface",
      mimeType: "image/png",
      fileUrl: "/api/projects/project-a/contents/image-a/file",
    })]} /></MemoryRouter>);

    const previewButton = screen.getByRole("button", { name: "Preview image: AFM surface" });
    previewButton.focus();
    fireEvent.click(previewButton);
    const dialog = screen.getByRole("dialog", { name: "Image preview: AFM surface" });
    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(dialog.closest(".project-reading-item")).toBeNull();
    expect(document.activeElement).toBe(closeButton);
    expect(document.body.style.overflow).toBe("hidden");
    screen.getByRole("button", { name: "Edit attachment metadata" }).focus();
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Image preview: AFM surface" })).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(previewButton);
  });

  it("uses a generic file card when an attachment has no image preview", () => {
    render(<MemoryRouter><ProjectReadingSurface nodes={[node({
      itemId: "file-a",
      kind: "attachment",
      title: "measurement.csv",
      createdSequence: 1,
      mimeType: "text/csv",
      fileUrl: "/api/projects/project-a/contents/file-a/file",
    })]} /></MemoryRouter>);

    expect(screen.getByRole("heading", { level: 2, name: "measurement.csv" })).toBeTruthy();
    expect(screen.getByText("text/csv")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open file" }).getAttribute("href"))
      .toBe("/api/projects/project-a/contents/file-a/file");
  });
  it("presents outcome-uncertain attachment metadata as warning in Reading", () => {
    render(<MemoryRouter><ProjectReadingSurface
      nodes={[node({
        itemId: "file-a",
        kind: "attachment",
        title: "measurement.csv",
        createdSequence: 1,
        mimeType: "text/csv",
        fileUrl: "/api/projects/project-a/contents/file-a/file",
      })]}
      attachmentEditor={{
        itemId: "file-a",
        contentId: "content-file-a",
        caption: "",
        sourceUrl: "",
        status: "uncertain",
        message: "The response was lost before confirmation.",
      }}
    /></MemoryRouter>);

    const feedback = screen.getByRole("status");
    expect(feedback.getAttribute("data-project-editor-status")).toBe("uncertain");
    expect(feedback.classList.contains("warning")).toBe(true);
    expect(feedback.classList.contains("danger")).toBe(false);
    expect(document.querySelector(".error-banner")).toBeNull();
  });


});

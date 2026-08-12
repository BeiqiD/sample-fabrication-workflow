import { describe, expect, it } from "vitest";
import {
  projectAttachmentGeometryAtPoint,
  projectAttachmentIsImage,
  projectMarkdownGeometryAtPoint,
  projectOwnedContentFailureStatus,
} from "./project-owned-content";
import { ProjectApiError } from "./project-client";

describe("Project owned content helpers", () => {
  it("creates valid centered Markdown and attachment geometry", () => {
    expect(projectMarkdownGeometryAtPoint({ x: 100, y: 200 }, 3)).toEqual({
      x: -80,
      y: 128,
      width: 360,
      height: 220,
      zIndex: 3,
    });
    expect(projectAttachmentGeometryAtPoint({ x: 100, y: 200 }, 4, "image/png")).toEqual({
      x: -80,
      y: 128,
      width: 360,
      height: 300,
      zIndex: 4,
    });
    expect(projectAttachmentGeometryAtPoint({ x: 100, y: 200 }, 5, "application/pdf")).toEqual({
      x: -70,
      y: 143.33333333333334,
      width: 340,
      height: 170,
      zIndex: 5,
    });
  });

  it("identifies image attachments without guessing from filenames", () => {
    expect(projectAttachmentIsImage("image/tiff")).toBe(true);
    expect(projectAttachmentIsImage("IMAGE/PNG")).toBe(true);
    expect(projectAttachmentIsImage("application/pdf")).toBe(false);
    expect(projectAttachmentIsImage("")).toBe(false);
  });

  it("keeps deterministic 4xx failures distinct from uncertain outcomes", () => {
    expect(projectOwnedContentFailureStatus(new ProjectApiError("conflict", 409))).toBe("conflict");
    expect(projectOwnedContentFailureStatus(new ProjectApiError("bad", 400))).toBe("error");
    expect(projectOwnedContentFailureStatus(new ProjectApiError("timeout", 408))).toBe("uncertain");
    expect(projectOwnedContentFailureStatus(new ProjectApiError("rate", 429))).toBe("uncertain");
    expect(projectOwnedContentFailureStatus(new ProjectApiError("server", 503))).toBe("uncertain");
    expect(projectOwnedContentFailureStatus(new TypeError("network"))).toBe("uncertain");
  });
});

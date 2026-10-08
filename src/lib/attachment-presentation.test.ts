import { describe, expect, it } from "vitest";
import { attachmentStatusLabel, formatAttachmentBytes, safeAttachmentHref } from "./attachment-presentation";

describe("attachment presentation metadata", () => {
  it.each([
    [0, "0 B"], [1, "1 byte"], [512, "512 bytes"], [1000, "1.0 kB"],
    [1200, "1.2 kB"], [2_097_152, "2.1 MB"], [1000 ** 3, "1.0 GB"],
  ])("presents %s bytes without treating an empty file as missing", (bytes, expected) => {
    expect(formatAttachmentBytes(bytes)).toBe(expected);
  });

  it.each([null, undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "does not invent a size for invalid metadata %s", (bytes) => {
      expect(formatAttachmentBytes(bytes)).toBeNull();
    },
  );

  it("labels known states without promoting missing or unknown state to ready", () => {
    expect(attachmentStatusLabel("ready")).toBe("Ready");
    expect(attachmentStatusLabel("pending")).toBe("Pending upload");
    expect(attachmentStatusLabel("hashing")).toBe("Checking file hash");
    expect(attachmentStatusLabel("failed")).toBe("Upload incomplete");
    expect(attachmentStatusLabel("cancelled")).toBe("Cancelled");
    expect(attachmentStatusLabel("future-state")).toBe("Status unknown");
    expect(attachmentStatusLabel("READY")).toBe("Status unknown");
    expect(attachmentStatusLabel(null)).toBe("Status unavailable");
  });
});

describe("attachment presentation URLs", () => {
  it.each([
    "/api/attachments/file%2Fone/download?version=1#download",
    "/api/file-assets/native%3Aid", "./original.csv", "../original.csv",
    "https://example.com/source?a=1&b=2", "http://example.com/source", "#attachment",
  ])("preserves the exact caller-authorized safe URL %s", (href) => {
    expect(safeAttachmentHref(href)).toBe(href);
  });

  it.each([
    "javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "blob:https://example.com/id",
    "//example.com/file", "/\\example.com/file", "https:\\example.com/file",
    "\njavascript:alert(1)", "java\tscript:alert(1)", "/api/\0attachment",
    "/api/\u007fattachment", "/api/\u0085attachment", " /api/attachment", "/api/attachment ",
    "https://[", "mailto:example@example.com", "", null, undefined,
  ])("rejects unsafe or unavailable link %s", (href) => {
    expect(safeAttachmentHref(href)).toBeNull();
  });
});

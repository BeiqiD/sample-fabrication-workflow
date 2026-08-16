import { describe, expect, it, vi } from "vitest";
import type { ProjectNodeDescriptor } from "./project-map-model";
import { buildProjectReadableArchive } from "./project-readable-export";

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

describe("Project readable export", () => {
  it("writes insertion-order Markdown, a manifest, and relative attachment paths", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "application/pdf" },
    }));
    const result = await buildProjectReadableArchive([
      node({
        itemId: "item-reference",
        kind: "reference",
        title: "Sample A",
        createdSequence: 2,
        excerpt: "Stable source record",
        openReferenceUrl: "/references/target-a",
      }),
      node({
        itemId: "item-markdown",
        kind: "markdown",
        title: "Design note",
        createdSequence: 1,
        contentId: "content-markdown",
        markdownSource: "# Design note\n\n$H\\lvert\\psi\\rangle=E\\lvert\\psi\\rangle$",
      }),
      node({
        itemId: "item-attachment",
        kind: "attachment",
        title: "report#final%.pdf",
        createdSequence: 3,
        contentId: "content-attachment",
        attachmentCaption: "Measured spectrum",
        attachmentSourceUrl: "https://example.com/source",
        mimeType: "application/pdf",
        attachmentByteSize: 3,
        fileUrl: "/api/projects/project-a/contents/content-attachment/file",
      }),
    ], {
      projectTitle: "Topological laser",
      generatedAt: "2026-08-16T12:00:00.000Z",
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/projects/project-a/contents/content-attachment/file",
      { credentials: "same-origin" },
    );
    expect(result.manifest.items.map((item) => item.itemId))
      .toEqual(["item-markdown", "item-reference", "item-attachment"]);
    const attachmentPath = result.manifest.items[2].relativeAttachmentPath;
    expect(attachmentPath).toMatch(/^attachments\/0003-report#final%\.pdf$/);
    expect(result.manifest.warnings).toEqual([]);

    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.archive);
    const reading = await zip.file("reading.md")!.async("string");
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    expect(reading.indexOf("## 1 — Design note")).toBeLessThan(reading.indexOf("## 2 — Sample A"));
    expect(reading).toContain("Measured spectrum\n\n[Open report\\#final%\\.pdf](attachments/0003-report%23final%25.pdf)");
    expect(reading).toContain("[Open reference](/references/target-a)");
    expect(zip.file(attachmentPath!)).not.toBeNull();
    expect(manifest).toMatchObject({
      format: "sample-fabrication-project-reading",
      version: 1,
      generatedAt: "2026-08-16T12:00:00.000Z",
      ordering: "created_sequence",
    });
  });

  it("keeps the readable archive usable when attachment download fails", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("missing", { status: 404 }));
    const result = await buildProjectReadableArchive([
      node({
        itemId: "item-attachment",
        kind: "attachment",
        title: "missing.tif",
        createdSequence: 1,
        mimeType: "image/tiff",
        attachmentByteSize: 7,
        fileUrl: "/missing",
      }),
    ], { fetcher, generatedAt: "2026-08-16T12:00:00.000Z" });

    expect(result.manifest.warnings).toEqual([{
      itemId: "item-attachment",
      title: "missing.tif",
      reason: "HTTP 404",
    }]);
    expect(result.manifest.items[0].relativeAttachmentPath).toBeNull();
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.archive);
    expect(zip.file("WARNINGS.md")).not.toBeNull();
    expect(await zip.file("reading.md")!.async("string"))
      .toContain("Attachment bytes were unavailable");
  });

  it("truncates long valid Unicode filenames by code point", async () => {
    const title = `${"a".repeat(119)}😀.pdf`;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1]), {
      status: 200,
    }));
    const result = await buildProjectReadableArchive([
      node({
        itemId: "unicode-attachment",
        kind: "attachment",
        title,
        createdSequence: 1,
        mimeType: "application/pdf",
        attachmentByteSize: 1,
        fileUrl: "/unicode",
      }),
    ], { fetcher, generatedAt: "2026-08-16T12:00:00.000Z" });

    expect(result.manifest.warnings).toEqual([]);
    const path = result.manifest.items[0].relativeAttachmentPath;
    expect(path).toBe(`attachments/0001-${"a".repeat(119)}😀`);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.archive);
    expect(zip.file(path!)).not.toBeNull();
    expect(await zip.file("reading.md")!.async("string")).toContain("%F0%9F%98%80");
  });

  it("skips attachments before fetch when the declared total would exceed the client limit", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(6), {
      status: 200,
    }));
    const result = await buildProjectReadableArchive([
      node({
        itemId: "first-attachment",
        kind: "attachment",
        title: "first.bin",
        createdSequence: 1,
        mimeType: "application/octet-stream",
        attachmentByteSize: 6,
        fileUrl: "/first",
      }),
      node({
        itemId: "second-attachment",
        kind: "attachment",
        title: "second.bin",
        createdSequence: 2,
        mimeType: "application/octet-stream",
        attachmentByteSize: 5,
        fileUrl: "/second",
      }),
    ], {
      fetcher,
      generatedAt: "2026-08-16T12:00:00.000Z",
      maxAttachmentBytes: 10,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/first", { credentials: "same-origin" });
    expect(result.manifest.items.map((item) => item.relativeAttachmentPath))
      .toEqual(["attachments/0001-first.bin", null]);
    expect(result.manifest.warnings).toEqual([{
      itemId: "second-attachment",
      title: "second.bin",
      reason: "Skipped because the 10-byte client-side attachment limit would be exceeded",
    }]);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.archive);
    expect(await zip.file("WARNINGS.md")!.async("string"))
      .toContain("attachment limit");
  });

  it("skips an attachment after fetch when the actual response exceeds the client limit", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(11), {
      status: 200,
    }));
    const result = await buildProjectReadableArchive([
      node({
        itemId: "actual-size-attachment",
        kind: "attachment",
        title: "actual.bin",
        createdSequence: 1,
        mimeType: "application/octet-stream",
        attachmentByteSize: 1,
        fileUrl: "/actual",
      }),
    ], {
      fetcher,
      generatedAt: "2026-08-16T12:00:00.000Z",
      maxAttachmentBytes: 10,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/actual", { credentials: "same-origin" });
    expect(result.manifest.items[0].relativeAttachmentPath).toBeNull();
    expect(result.manifest.warnings).toEqual([{
      itemId: "actual-size-attachment",
      title: "actual.bin",
      reason: "Skipped because the 10-byte client-side attachment limit would be exceeded",
    }]);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(result.archive);
    expect(zip.file("attachments/0001-actual.bin")).toBeNull();
    expect(await zip.file("WARNINGS.md")!.async("string"))
      .toContain("attachment limit");
  });
});

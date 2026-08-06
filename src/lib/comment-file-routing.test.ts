import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isCommentImageFile, partitionCommentFiles } from "./comment-file-routing";

const routingSource = readFileSync(new URL("./comment-file-routing.ts", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");

describe("comment file routing", () => {
  it("routes archives and documents to attachments instead of image preparation", () => {
    const zip = { name: "measurement-data.zip", type: "application/zip" };
    const pdf = { name: "report.pdf", type: "application/pdf" };

    expect(isCommentImageFile(zip)).toBe(false);
    expect(partitionCommentFiles([zip, pdf])).toEqual({ images: [], attachments: [zip, pdf] });
  });

  it("keeps normal images and instrument TIFF files in the image path", () => {
    const png = { name: "sem.png", type: "image/png" };
    const tiffWithoutMime = { name: "afm.TIF", type: "" };
    const zip = { name: "raw.zip", type: "application/zip" };

    expect(partitionCommentFiles([png, zip, tiffWithoutMime])).toEqual({
      images: [png, tiffWithoutMime],
      attachments: [zip],
    });
  });

  it("intercepts drop and paste before the image-only React handlers", () => {
    expect(routingSource).toMatch(/document\.addEventListener\("drop"[\s\S]*?, true\)/);
    expect(routingSource).toMatch(/document\.addEventListener\("paste"[\s\S]*?, true\)/);
    expect(routingSource).toContain("input.comment-file-input[accept]");
    expect(routingSource).toContain("input.comment-file-input:not([accept])");
    expect(mainSource).toContain("installCommentFileRouting();");
  });
});

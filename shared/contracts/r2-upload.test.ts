import { describe, expect, it } from "vitest";
import { canonicalR2UploadInput, MAX_R2_UPLOAD_BYTES, normalizeR2UploadRequestId,
  validateR2UploadInput } from "./r2-upload";

const file = { originalName: "diagram.png", mimeType: "image/png", byteSize: 100, sha256: "a".repeat(64) };

describe("accepted R2 upload input", () => {
  it("binds exact content, metadata, ingress, fixed purpose and scope in a canonical digest", async () => {
    const original = await canonicalR2UploadInput("ordinary_image", file);
    expect(original.input).toMatchObject({ ingress: "ordinary_image", purpose: "embedded_content", scope: "system" });
    expect(await canonicalR2UploadInput("ordinary_image", { ...file })).toEqual(original);
    for (const changed of [{ ...file, sha256: "b".repeat(64) }, { ...file, byteSize: 101 },
      { ...file, originalName: "other.png" }, { ...file, mimeType: "image/webp" }]) {
      expect((await canonicalR2UploadInput("ordinary_image", changed)).sha256).not.toBe(original.sha256);
    }
    const project = await canonicalR2UploadInput("project_attachment", file);
    expect(project.input.purpose).toBe("research_source");
    expect(project.sha256).not.toBe(original.sha256);
  });

  it("rejects client purpose overrides, extra members and invalid file metadata", async () => {
    const { input } = await canonicalR2UploadInput("ordinary_image", file);
    for (const changed of [{ ...input, purpose: "provenance" }, { ...input, scope: "another-user" },
      { ...input, ingress: "other" }, { ...input, extra: true }, { ...input, schema: "r2-upload-request/2" },
      { ...input, file: { ...file, url: "https://invalid.example/" } }]) {
      expect(() => validateR2UploadInput(changed)).toThrow(/Invalid R2 upload/);
    }
    for (const changed of [{ ...file, sha256: "A".repeat(64) }, { ...file, byteSize: -1 },
      { ...file, byteSize: 1.5 }, { ...file, byteSize: MAX_R2_UPLOAD_BYTES + 1 },
      { ...file, originalName: "x".repeat(256) }, { ...file, originalName: "bad\0name" },
      { ...file, originalName: " " }, { ...file, mimeType: "image/png\r\nprivate:value" },
      { ...file, mimeType: "image/png " }, { ...file, mimeType: "application/pdf" }]) {
      expect(() => validateR2UploadInput({ ...input, file: changed })).toThrow("Invalid R2 upload file metadata");
    }
  });

  it("detaches validated metadata and admits bounded unchanged Project originals", async () => {
    const { input } = await canonicalR2UploadInput("project_attachment", {
      originalName: "测量.csv", mimeType: "text/csv", byteSize: MAX_R2_UPLOAD_BYTES, sha256: "0".repeat(64),
    });
    const copy = validateR2UploadInput(input);
    input.file.originalName = "changed.csv";
    expect(copy.file.originalName).toBe("测量.csv");
    expect(copy.file.byteSize).toBe(MAX_R2_UPLOAD_BYTES);
  });

  it("normalizes only UUID-v4 request identities without permissive trimming or suffixes", () => {
    const id = "f2a7a5e4-6bc3-4e7a-84f8-bd98f19c0ae0";
    expect(normalizeR2UploadRequestId(id.toUpperCase())).toBe(id);
    for (const value of [null, 7, `${id} `, ` ${id}`, `${id}/other`, id.replace("4e7a", "3e7a")]) {
      expect(normalizeR2UploadRequestId(value)).toBeNull();
    }
  });
});

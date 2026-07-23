import { describe, expect, it } from "vitest";
import { managedObjectKey, managedStorageStatus } from "./managed-storage";

describe("managed storage configuration", () => {
  it("reports missing provider authentication without affecting external links", () => {
    expect(managedStorageStatus({} as never)).toEqual({
      provider: null,
      available: false,
      authentication: "not_configured",
      message: "Connect a file storage provider to enable file attachments. Attachment links remain available.",
    });
  });

  it("does not enable uploads from a provider name without a connected adapter", () => {
    expect(managedStorageStatus({ MANAGED_STORAGE_PROVIDER: "switchdrive" } as never)).toEqual({
      provider: "switchdrive",
      available: false,
      authentication: "oauth",
      message: "The configured file storage provider is not connected or authenticated. File attachments are disabled.",
    });
  });

  it("builds provider-neutral object keys without changing the original filename record", () => {
    expect(managedObjectKey("submission-1", "item-1", "surface scan (final).tiff"))
      .toBe("comment-attachments/submission-1/item-1-surface_scan__final_.tiff");
  });
});

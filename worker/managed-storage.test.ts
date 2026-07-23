import { afterEach, describe, expect, it, vi } from "vitest";
import { managedObjectKey, managedStorage, managedStorageStatus } from "./managed-storage";

afterEach(() => vi.unstubAllGlobals());

describe("managed storage configuration", () => {
  it("reports missing provider authentication without affecting external links", async () => {
    await expect(managedStorageStatus({} as never)).resolves.toEqual({
      provider: null,
      available: false,
      authentication: "not_configured",
      message: "Connect a file storage provider to enable file attachments. Attachment links remain available.",
    });
  });

  it("does not enable uploads from a provider name without complete credentials", async () => {
    await expect(managedStorageStatus({ MANAGED_STORAGE_PROVIDER: "switchdrive" } as never)).resolves.toEqual({
      provider: "switchdrive",
      available: false,
      authentication: "not_configured",
      message: "Complete the SWITCHdrive WebDAV address, username, and App Passcode to enable file attachments.",
    });
  });

  it("reports a non-SWITCHdrive WebDAV URL without exposing its value", async () => {
    const env = {
      MANAGED_STORAGE_PROVIDER: "switchdrive",
      SWITCHDRIVE_WEBDAV_URL: "https://example.com/remote.php/dav/files/user/",
      SWITCHDRIVE_USERNAME: "user@example.com",
      SWITCHDRIVE_APP_PASSWORD: "secret",
    } as never;
    expect(() => managedStorage(env)).toThrow("SWITCHdrive WebDAV URL is invalid");
    await expect(managedStorageStatus(env)).resolves.toEqual({
      provider: "switchdrive",
      available: false,
      authentication: "not_configured",
      message: "The configured SWITCHdrive WebDAV address or storage root is invalid. File attachments are disabled.",
    });
  });

  it("only reports SWITCHdrive as available after a successful credential check", async () => {
    const env = {
      MANAGED_STORAGE_PROVIDER: "switchdrive",
      SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/user/",
      SWITCHDRIVE_USERNAME: "user@example.com",
      SWITCHDRIVE_APP_PASSWORD: "secret",
    } as never;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    await expect(managedStorageStatus(env)).resolves.toEqual({
      provider: "switchdrive",
      available: false,
      authentication: "service_binding",
      message: "SWITCHdrive rejected the configured username or App Passcode. File attachments are disabled.",
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 207 })));
    await expect(managedStorageStatus(env)).resolves.toEqual({
      provider: "switchdrive",
      available: true,
      authentication: "service_binding",
      message: "SWITCHdrive is connected. Original files are stored there without modification.",
    });
  });

  it("builds provider-neutral object keys without changing the original filename record", () => {
    expect(managedObjectKey("submission-1", "item-1", "surface scan (final).tiff"))
      .toBe("shared-comment-attachments/submission-1/item-1-surface_scan__final_.tiff");
    expect(managedObjectKey(
      "submission-1",
      "item-1",
      "surface scan (final).tiff",
      { id: "sample-uuid", code: "GeSn 01" },
    )).toBe("samples/GeSn_01--sample-uuid/comment-attachments/submission-1/item-1-surface_scan__final_.tiff");
  });
});

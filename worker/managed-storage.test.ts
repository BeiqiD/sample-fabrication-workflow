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
      message: "SWITCHdrive requires authentication (HTTP 401). File attachments are disabled.",
      diagnostic: { httpStatus: 401, redirected: false, classification: "authentication_required", basicChallenge: false },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 207 })));
    await expect(managedStorageStatus(env)).resolves.toEqual({
      provider: "switchdrive",
      available: true,
      authentication: "service_binding",
      message: "SWITCHdrive is connected. Original files are stored there without modification.",
    });
  });

  it.each([
    [401, "authentication_required", "NotAuthenticated", "not_authenticated"],
    [403, "forbidden", "Forbidden", "forbidden"],
  ] as const)("distinguishes HTTP %s using only safe upstream diagnostics", async (status, classification, exception, providerReason) => {
    const env = {
      MANAGED_STORAGE_PROVIDER: "switchdrive",
      SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/private-path/",
      SWITCHDRIVE_USERNAME: "private-user@example.ch",
      SWITCHDRIVE_APP_PASSWORD: "private-password",
      SWITCHDRIVE_ROOT: "private-root",
    } as never;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `<d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns"><s:exception>Sabre\\DAV\\Exception\\${exception}</s:exception><s:message>private-provider-message</s:message></d:error>`,
      { status, headers: {
        "content-type": "application/xml; charset=utf-8",
        "www-authenticate": 'Basic realm="private-realm"',
        "location": "https://private-redirect.example/private-path",
      } },
    )));
    const result = await managedStorageStatus(env);
    expect(result.available).toBe(false);
    expect(result.message).toContain(`HTTP ${status}`);
    expect(result.message).not.toContain("username or App Passcode");
    expect(result.diagnostic).toEqual({ httpStatus: status, redirected: false, classification, basicChallenge: true, providerReason });
    expect(JSON.stringify(result)).not.toContain("private-");
  });

  it("reports a redirect without following it or exposing its destination", async () => {
    const fetchMock = vi.fn(async () => new Response("private-body", {
      status: 302,
      headers: { location: "https://private-host.example/private-login" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await managedStorageStatus({
      MANAGED_STORAGE_PROVIDER: "switchdrive",
      SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/user/",
      SWITCHDRIVE_USERNAME: "user",
      SWITCHDRIVE_APP_PASSWORD: "secret",
    } as never);
    expect(result.available).toBe(false);
    expect(result.diagnostic).toEqual({ httpStatus: 302, redirected: false, classification: "redirect", basicChallenge: false });
    expect(result.message).toContain("did not follow it");
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: "PROPFIND", redirect: "manual" }));
  });

  it("keeps transport failures generic without exposing exception messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("private-url-and-credential"); }));
    const result = await managedStorageStatus({
      MANAGED_STORAGE_PROVIDER: "switchdrive",
      SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/user/",
      SWITCHDRIVE_USERNAME: "user",
      SWITCHDRIVE_APP_PASSWORD: "secret",
    } as never);
    expect(result.available).toBe(false);
    expect(result.diagnostic).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("private-");
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

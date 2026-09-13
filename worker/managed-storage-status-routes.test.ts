import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import type { Env } from "./types";

const env = {
  MANAGED_STORAGE_PROVIDER: "switchdrive",
  SWITCHDRIVE_WEBDAV_URL: "https://drive.switch.ch/remote.php/dav/files/private-user/",
  SWITCHDRIVE_USERNAME: "private-user",
  SWITCHDRIVE_APP_PASSWORD: "private-passcode",
} as Env;

const request = () => new Request("https://app.test/api/storage/status");

afterEach(() => vi.unstubAllGlobals());

describe("managed storage status authentication boundary", () => {
  it("rejects unauthenticated requests before checking storage or revealing diagnostics", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await worker.fetch(request(), { ...env, AUTH_MODE: "access" }, {} as ExecutionContext);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Authentication required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the safe diagnostic through the existing status route after the identity gate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private-provider-body", {
      status: 403,
      headers: { "www-authenticate": 'Basic realm="private-realm"' },
    })));
    // The existing local-development identity mode exercises the real route
    // without introducing a test bypass into production authentication.
    const response = await worker.fetch(request(), { ...env, AUTH_MODE: "disabled" }, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: "switchdrive",
      available: false,
      authentication: "service_binding",
      message: "SWITCHdrive denied WebDAV access (HTTP 403). File attachments are disabled.",
      diagnostic: { httpStatus: 403, redirected: false, classification: "forbidden", basicChallenge: true },
    });
  });
});

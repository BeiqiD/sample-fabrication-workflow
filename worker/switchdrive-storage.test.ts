import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SwitchdriveStorage,
  SwitchdriveAuthenticationError,
  switchdriveConfiguration,
} from "./switchdrive-storage";

const configuration = {
  webdavUrl: "https://drive.switch.ch/remote.php/dav/files/user%40example.ch",
  username: "user@example.ch",
  appPassword: "app-password",
  root: "sample-fabrication-workflow",
};

afterEach(() => vi.unstubAllGlobals());

describe("SWITCHdrive managed storage", () => {
  it("requires the official HTTPS WebDAV endpoint and complete credentials", () => {
    expect(switchdriveConfiguration({})).toBeNull();
    expect(switchdriveConfiguration({
      SWITCHDRIVE_WEBDAV_URL: `${configuration.webdavUrl}/`,
      SWITCHDRIVE_USERNAME: configuration.username,
      SWITCHDRIVE_APP_PASSWORD: configuration.appPassword,
    })).toEqual(configuration);
  });

  it("checks credentials with a read-only PROPFIND request", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 207 }));
    vi.stubGlobal("fetch", fetchMock);
    await new SwitchdriveStorage(configuration).check();
    expect(fetchMock).toHaveBeenCalledWith(`${configuration.webdavUrl}/`, expect.objectContaining({
      method: "PROPFIND",
      headers: expect.any(Headers),
      redirect: "manual",
    }));
    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get("depth")).toBe("0");
    expect(headers.get("authorization")).toMatch(/^Basic /);
  });

  it.each([200, 207])("keeps successful HTTP %s checks unchanged and does not read their bodies", async (status) => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("not-read")); },
      cancel,
    });
    const response = new Response(body, { status });
    const getReader = vi.spyOn(body, "getReader");
    vi.stubGlobal("fetch", vi.fn(async () => response));
    await expect(new SwitchdriveStorage(configuration).check()).resolves.toBeUndefined();
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, "authentication_required"], [403, "forbidden"],
    [301, "redirect"], [302, "redirect"], [303, "redirect"], [307, "redirect"], [308, "redirect"],
    [304, "upstream_error"], [404, "upstream_error"], [503, "upstream_error"],
  ])("preserves HTTP %s as a connection-check diagnostic", async (status, classification) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: Number(status) })));
    await expect(new SwitchdriveStorage(configuration).check()).rejects.toMatchObject({
      name: "SwitchdriveConnectionCheckError",
      diagnostic: { httpStatus: status, redirected: false, classification, basicChallenge: false },
    });
  });

  it.each([302, 403, 503])("cancels unread non-XML HTTP %s bodies without parsing them", async (status) => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const getReader = vi.spyOn(body, "getReader");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status, headers: { "content-type": "text/html" } })));
    await expect(new SwitchdriveStorage(configuration).check()).rejects.toMatchObject({ diagnostic: { httpStatus: status } });
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("reads at most the bounded XML prefix and cancels the remaining response", async () => {
    const cancel = vi.fn();
    const bytes = new TextEncoder().encode("x".repeat(8 * 1024) + "<s:exception>Sabre\\DAV\\Exception\\NotAuthenticated</s:exception>");
    const body = new ReadableStream({
      start(controller) { controller.enqueue(bytes); },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status: 401, headers: { "content-type": "application/xml" },
    })));
    await expect(new SwitchdriveStorage(configuration).check()).rejects.toMatchObject({
      diagnostic: { httpStatus: 401, classification: "authentication_required" },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    // The exception exists only beyond the allowed prefix and must not be parsed.
    const closedBody = new Response(bytes, { status: 401, headers: { "content-type": "application/xml" } });
    vi.stubGlobal("fetch", vi.fn(async () => closedBody));
    const error = await new SwitchdriveStorage(configuration).check().catch((failure) => failure);
    expect(error).toMatchObject({ name: "SwitchdriveConnectionCheckError" });
    expect(error.diagnostic).not.toHaveProperty("providerReason");
  });

  it.each([
    ['<s:exception>private-exception</s:exception>', "application/xml"],
    ['<s:message>Sabre\\DAV\\Exception\\NotAuthenticated</s:message>', "application/xml"],
    ['<s:exception>Sabre\\DAV\\Exception\\NotAuthenticated</s:exception>', "text/html"],
  ])("omits unrecognized or non-XML provider detail", async (body, contentType) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 401, headers: { "content-type": contentType } })));
    const error = await new SwitchdriveStorage(configuration).check().catch((failure) => failure);
    expect(error).toMatchObject({ name: "SwitchdriveConnectionCheckError" });
    expect(error.diagnostic).not.toHaveProperty("providerReason");
    expect(JSON.stringify(error.diagnostic)).not.toContain("private-");
  });

  it.each([401, 403] as const)("retains HTTP %s on object authentication errors", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })));
    await expect(new SwitchdriveStorage(configuration).stat("file.bin")).rejects.toBeInstanceOf(SwitchdriveAuthenticationError);
    await expect(new SwitchdriveStorage(configuration).stat("file.bin")).rejects.toMatchObject({ status });
  });

  it("creates folders, uploads the unchanged stream, and verifies its size", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "MKCOL") return new Response("", { status: 201 });
      if (init?.method === "PUT") return new Response("", { status: 201 });
      if (init?.method === "HEAD") return new Response(null, {
        status: 200,
        headers: { "content-length": "4" },
      });
      throw new Error(`Unexpected ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const body = new Blob(["data"]).stream();
    await expect(new SwitchdriveStorage(configuration).put({
      key: "comment-attachments/submission/item-scan.tiff",
      body,
      contentType: "image/tiff",
      filename: "scan.tiff",
      sha256: "a".repeat(64),
      byteSize: 4,
    })).resolves.toEqual({ byteSize: 4 });
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "MKCOL")).toHaveLength(3);
    const put = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT");
    expect(put?.[0]).toBe(`${configuration.webdavUrl}/sample-fabrication-workflow/comment-attachments/submission/item-scan.tiff`);
    expect(put?.[1]?.body).toBe(body);
  });

  it("stats objects with HEAD without downloading their bytes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: {
          "content-length": "12",
          "content-type": "application/pdf",
          etag: '"stat-etag"',
        },
      }))
      .mockResolvedValueOnce(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const storage = new SwitchdriveStorage(configuration);

    await expect(storage.stat("comment-attachments/submission/file.pdf")).resolves.toEqual({
      byteSize: 12,
      contentType: "application/pdf",
      etag: '"stat-etag"',
    });
    await expect(storage.stat("comment-attachments/submission/missing.pdf")).resolves.toBeNull();
    expect(fetchMock.mock.calls.every((call) => call[1]?.method === "HEAD")).toBe(true);
  });

  it("does not reinterpret provider failures as missing objects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    await expect(new SwitchdriveStorage(configuration).stat("file.bin"))
      .rejects.toThrow("status 503");
  });

  it("streams downloads and treats a missing object as absent", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("file", {
        status: 200,
        headers: { "content-type": "application/octet-stream", etag: "\"etag\"" },
      }))
      .mockResolvedValueOnce(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const storage = new SwitchdriveStorage(configuration);
    const object = await storage.get("comment-attachments/submission/file.bin");
    expect(await new Response(object?.body).text()).toBe("file");
    expect(object?.etag).toBe("\"etag\"");
    await expect(storage.get("comment-attachments/submission/missing.bin")).resolves.toBeNull();
  });
});

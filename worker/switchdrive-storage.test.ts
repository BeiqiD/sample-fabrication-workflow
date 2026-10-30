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

const objectMethods = ["MKCOL", "PUT", "HEAD", "GET", "DELETE"] as const;
type ObjectMethod = typeof objectMethods[number];

function putInput() {
  return {
    key: "file.bin",
    body: new Blob(["data"]).stream(),
    contentType: "application/octet-stream",
    filename: "file.bin",
    sha256: "a".repeat(64),
    byteSize: 4,
  };
}

function invokeObjectMethod(storage: SwitchdriveStorage, method: ObjectMethod) {
  if (method === "HEAD") return storage.stat("file.bin");
  if (method === "GET") return storage.get("file.bin");
  if (method === "DELETE") return storage.delete("file.bin");
  return storage.put(putInput());
}

function unreadResponse(status: number, headers?: HeadersInit) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("private-provider-body"));
    },
    cancel,
  });
  return {
    response: new Response(body, { status, headers }),
    body,
    cancel,
    getReader: vi.spyOn(body, "getReader"),
  };
}

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

  it.each(objectMethods.flatMap((method) =>
    [301, 302, 303, 307, 308, 401, 403, 503].map((status) => ({ method, status })),
  ))("stops $method at HTTP $status and releases its private response", async ({ method, status }) => {
    const privateLocation = "https://unexpected.example/private-redirect";
    const unread = unreadResponse(status, { location: privateLocation });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === method) return unread.response;
      if (init?.method === "MKCOL") return new Response(null, { status: 201 });
      throw new Error(`Unexpected request: ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await invokeObjectMethod(new SwitchdriveStorage(configuration), method)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: `SWITCHdrive WebDAV request failed with status ${status}` });
    if (status === 401 || status === 403) {
      expect(error).toBeInstanceOf(SwitchdriveAuthenticationError);
      expect(error).toMatchObject({ status });
    }
    const serializedError = String(error) + JSON.stringify(error);
    for (const privateValue of [
      privateLocation,
      "private-provider-body",
      configuration.username,
      configuration.appPassword,
      btoa(`${configuration.username}:${configuration.appPassword}`),
    ]) {
      expect(serializedError).not.toContain(privateValue);
    }
    expect(fetchMock.mock.calls.map((call) => call[1]?.method))
      .toEqual(method === "PUT" ? ["MKCOL", "PUT"] : [method]);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url.startsWith(`${configuration.webdavUrl}/${configuration.root}`)).toBe(true);
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic /);
    }
    expect(unread.getReader).not.toHaveBeenCalled();
    expect(unread.cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["HEAD", "GET", "DELETE"] as const)(
    "releases an absent %s response without reading it",
    async (method) => {
      const unread = unreadResponse(404);
      const fetchMock = vi.fn(async () => unread.response);
      vi.stubGlobal("fetch", fetchMock);
      const result = await invokeObjectMethod(new SwitchdriveStorage(configuration), method);
      expect(result).toBe(method === "DELETE" ? undefined : null);
      expect(unread.getReader).not.toHaveBeenCalled();
      expect(unread.cancel).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("releases successful directory, upload, stat and delete bodies without consuming them", async () => {
    const createdDirectory = unreadResponse(201);
    const existingDirectory = unreadResponse(405);
    const uploaded = unreadResponse(201);
    const metadata = unreadResponse(200, {
      "content-length": "4", "content-type": "application/octet-stream", etag: '"opaque-etag"',
    });
    const deleted = unreadResponse(200);
    const responses = [createdDirectory, existingDirectory, uploaded, metadata, deleted];
    let responseIndex = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => responses[responseIndex++].response);
    vi.stubGlobal("fetch", fetchMock);
    const storage = new SwitchdriveStorage(configuration);
    await expect(storage.put({ ...putInput(), key: "folder/file.bin" }))
      .resolves.toEqual({ byteSize: 4 });
    await expect(storage.delete("folder/file.bin")).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map((call) => call[1]?.method))
      .toEqual(["MKCOL", "MKCOL", "PUT", "HEAD", "DELETE"]);
    for (const response of responses) {
      expect(response.getReader).not.toHaveBeenCalled();
      expect(response.cancel).toHaveBeenCalledTimes(1);
    }
  });

  it("gives a successful GET stream to its caller without pre-reading or cancelling it", async () => {
    const unread = unreadResponse(200, {
      "content-type": "application/pdf", etag: '"download-etag"',
    });
    vi.stubGlobal("fetch", vi.fn(async () => unread.response));
    const result = await new SwitchdriveStorage(configuration).get("file.bin");
    expect(result).toEqual({
      body: unread.body, contentType: "application/pdf", etag: '"download-etag"',
    });
    expect(unread.getReader).not.toHaveBeenCalled();
    expect(unread.cancel).not.toHaveBeenCalled();
    await result!.body.cancel();
    expect(unread.cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 404, size: null, message: "could not verify the attachment" },
    { status: 200, size: "5", message: "different attachment size" },
    { status: 503, size: null, message: "status 503" },
  ])("keeps candidate cleanup outside PUT after HEAD returns $status / $size", async ({ status, size, message }) => {
    const metadata = unreadResponse(status, size === null ? undefined : { "content-length": size });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "MKCOL" || init?.method === "PUT") return new Response(null, { status: 201 });
      if (init?.method === "HEAD") return metadata.response;
      throw new Error(`Unexpected request: ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(new SwitchdriveStorage(configuration).put(putInput())).rejects.toThrow(message);
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(["MKCOL", "PUT", "HEAD"]);
    expect(metadata.getReader).not.toHaveBeenCalled();
    expect(metadata.cancel).toHaveBeenCalledTimes(1);
  });

  it("does not retry or delete after a PUT response is lost", async () => {
    const transportError = new Error("Connection closed after write");
    const writes: string[] = [];
    const input = putInput();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "MKCOL") return new Response(null, { status: 201 });
      if (init?.method === "PUT") {
        writes.push(await new Response(init.body).text());
        throw transportError;
      }
      throw new Error(`Unexpected request: ${init?.method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(new SwitchdriveStorage(configuration).put(input)).rejects.toBe(transportError);
    expect(writes).toEqual(["data"]);
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(["MKCOL", "PUT"]);
  });

  it.each([200, 403])("keeps the original HTTP %s outcome if unused body cancellation fails", async (status) => {
    const cancel = vi.fn(() => Promise.reject(new Error("private-cancellation-error")));
    const body = new ReadableStream({ cancel });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      status, headers: { "content-length": "4" },
    })));
    const result = new SwitchdriveStorage(configuration).stat("file.bin");
    if (status === 200) {
      await expect(result).resolves.toMatchObject({ byteSize: 4 });
    } else {
      await expect(result).rejects.toMatchObject({ name: "SwitchdriveAuthenticationError", status: 403 });
    }
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

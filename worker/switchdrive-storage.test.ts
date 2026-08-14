import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SwitchdriveStorage,
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
    }));
    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get("depth")).toBe("0");
    expect(headers.get("authorization")).toMatch(/^Basic /);
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

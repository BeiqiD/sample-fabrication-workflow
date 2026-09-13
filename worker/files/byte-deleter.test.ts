import { afterEach, describe, expect, it, vi } from "vitest";
import { removeBlob } from "../blob-lifecycle/storage";
import type { BlobLocator } from "../blob-lifecycle/types";
import { SwitchdriveStorage } from "../switchdrive-storage";
import type { Env } from "../types";
import { ByteDeletionError } from "./byte-deleter";
import { managedByteDeleter } from "./storage-adapters/managed-deleter";
import { r2ByteDeleter } from "./storage-adapters/r2-deleter";

afterEach(() => vi.unstubAllGlobals());

const locator: BlobLocator = {
  storeKind: "r2", provider: "r2", objectKey: "literal/%2F/key//image.png", blobRecordId: "record",
};

function managed() {
  return new SwitchdriveStorage({
    webdavUrl: "https://drive.switch.ch/remote.php/dav/files/test-user",
    username: "test-user", appPassword: "fixture-password", root: "fixture-root",
  });
}

describe("bound deletion transport", () => {
  it("keeps equal opaque keys on two same-kind instances independent", async () => {
    for (const factory of [r2ByteDeleter, managedByteDeleter]) {
      const a = new Set([locator.objectKey]);
      const b = new Set([locator.objectKey]);
      const firstDelete = vi.fn(async (key: string) => { a.delete(key); });
      const secondDelete = vi.fn(async (key: string) => { b.delete(key); });
      const first = factory({ delete: firstDelete });
      const second = factory({ delete: secondDelete });
      expect(await first.delete(locator.objectKey)).toEqual({ outcome: "acknowledged" });
      expect(a.size).toBe(0);
      expect(b.has(locator.objectKey)).toBe(true);
      expect(firstDelete).toHaveBeenCalledExactlyOnceWith(locator.objectKey);
      expect(secondDelete).not.toHaveBeenCalled();
      expect(await second.delete(locator.objectKey)).toEqual({ outcome: "acknowledged" });
      expect(b.size).toBe(0);
    }
  });

  it.each(["r2", "managed"])("does not replay or probe an uncertain %s deletion", async (kind) => {
    let present = true;
    const remove = vi.fn(async () => {
      present = false;
      throw new Error("https://private.example/secret?password=do-not-persist");
    });
    const get = vi.fn();
    const stat = vi.fn();
    const transport = { delete: remove, get, stat };
    const adapter = kind === "r2" ? r2ByteDeleter(transport) : managedByteDeleter(transport);
    expect(await adapter.delete(locator.objectKey)).toEqual({ outcome: "unavailable" });
    expect(present).toBe(false);
    expect(remove).toHaveBeenCalledExactlyOnceWith(locator.objectKey);
    expect(get).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it.each([200, 204, 404])("acknowledges managed HTTP %i and releases response bodies", async (status) => {
    const cancel = vi.fn();
    const body = status === 204 ? null : new ReadableStream({ cancel }, { highWaterMark: 0 });
    const fetch = vi.fn(async () => new Response(body, { status }));
    vi.stubGlobal("fetch", fetch);
    expect(await managedByteDeleter(managed()).delete("folder/file name.bin"))
      .toEqual({ outcome: "acknowledged" });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://drive.switch.ch/remote.php/dav/files/test-user/fixture-root/folder/file%20name.bin",
      expect.objectContaining({ method: "DELETE", redirect: "manual" }),
    );
    if (body) expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([202, 207, 301, 302, 307, 308, 401, 403, 409, 423, 500])(
    "does not treat managed HTTP %i as completed deletion or follow its redirect", async (status) => {
      const cancel = vi.fn();
      const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), {
        status, headers: { location: "https://elsewhere.example/credentials-must-not-follow" },
      }));
      vi.stubGlobal("fetch", fetch);
      const expected = status === 401 || status === 403 ? { outcome: "denied", status } : { outcome: "unavailable" };
      expect(await managedByteDeleter(managed()).delete("file.bin")).toEqual(expected);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE", redirect: "manual" });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
});

describe("legacy deletion composition", () => {
  it.each([
    { storeKind: "r2", provider: "switchdrive" },
    { storeKind: "managed", provider: "r2" },
    { storeKind: "managed", provider: "unknown" },
    { storeKind: "unknown", provider: "r2" },
  ])("rejects invalid identity before touching any environment binding: %j", async (identity) => {
    const env = new Proxy({} as Env, { get() { throw new Error("No binding may be consulted"); } });
    await expect(removeBlob(env, { ...locator, ...identity } as BlobLocator))
      .rejects.toMatchObject({ name: "ByteDeletionError", reason: "invalid_locator", message: "File storage locator is invalid" });
  });

  it("does not fall back to R2 for unconfigured or invalid managed storage", async () => {
    const remove = vi.fn();
    for (const config of [{}, { MANAGED_STORAGE_PROVIDER: "switchdrive" }, {
      MANAGED_STORAGE_PROVIDER: "switchdrive", SWITCHDRIVE_WEBDAV_URL: "https://invalid.example/secret",
      SWITCHDRIVE_USERNAME: "private-user", SWITCHDRIVE_APP_PASSWORD: "private-password",
    }]) {
      await expect(removeBlob({ ASSETS: { delete: remove }, ...config } as unknown as Env,
        { ...locator, storeKind: "managed", provider: "switchdrive" }))
        .rejects.toMatchObject({ reason: "unavailable", message: "File storage deletion is unavailable" });
    }
    expect(remove).not.toHaveBeenCalled();
  });

  it("converts arbitrary provider errors into a safe compatibility error", async () => {
    const remove = vi.fn(async () => { throw new Error("secret provider URL and credentials"); });
    const env = { ASSETS: { delete: remove } } as unknown as Env;
    let failure: unknown;
    try { await removeBlob(env, locator); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ByteDeletionError);
    expect(failure).toMatchObject({ reason: "unavailable", message: "File storage deletion is unavailable" });
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain("secret");
    expect(remove).toHaveBeenCalledExactlyOnceWith(locator.objectKey);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { S3StorageNamespace } from "../../shared/contracts/storage-configuration";
import { ByteVerificationError } from "../files/byte-verification";
import { s3ByteAdapter, type S3ByteAdapter, type S3RequestOperation } from "./s3-byte-adapter";

const namespace: S3StorageNamespace = { kind: "s3", endpoint: "https://s3.us-east-1.amazonaws.com",
  bucket: "lifecycle-fixture", region: "us-east-1", root: "research", forcePathStyle: true,
  expectedBucketOwner: "111122223333" };
const credentials = { accessKeyId: "fixture-access", secretAccessKey: "fixture-secret", sessionToken: "fixture-token" };
const methods = ["GET", "HEAD", "PUT", "DELETE"] as const;
const key = "研究//literal%2F+?#/'!*().txt";
const url = "https://s3.us-east-1.amazonaws.com/lifecycle-fixture/research/%E7%A0%94%E7%A9%B6//literal%252F%2B%3F%23/%27%21%2A%28%29.txt";
const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function invoke(adapter: S3ByteAdapter, method: S3RequestOperation["method"]) {
  if (method === "GET") return adapter.reader.read(key);
  if (method === "HEAD") return adapter.reader.stat(key);
  if (method === "DELETE") return adapter.deleter.delete(key);
  return adapter.writer.write({ key, body: new ArrayBuffer(0), byteSize: 0, sha256: emptyHash,
    contentType: "application/octet-stream", filename: "fixture.bin" });
}

async function expectAllowed(operation: ReturnType<typeof invoke>, method: S3RequestOperation["method"]) {
  const result = await operation;
  if (method === "PUT") expect(result).toBeUndefined();
  else if (method === "DELETE") expect(result).toEqual({ outcome: "acknowledged" });
  else {
    expect(result).toMatchObject({ outcome: "available" });
    if (result && "body" in result) await result.body.cancel();
  }
}

async function expectBlocked(operation: ReturnType<typeof invoke>, method: S3RequestOperation["method"]) {
  if (method === "PUT") {
    await expect(operation).rejects.toEqual(new ByteVerificationError("destination", "unavailable"));
  } else await expect(operation).resolves.toEqual({ outcome: "unavailable" });
}

afterEach(() => vi.restoreAllMocks());

describe("S3 request lifecycle fence", () => {
  it.each(methods)("checks %s after signing with frozen operation metadata and an unchanged exact target", async method => {
    const events: string[] = [];
    const originalSign = crypto.subtle.sign.bind(crypto.subtle);
    const signing = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...input) => {
      events.push("sign-start");
      const result = await originalSign(...input);
      events.push("sign-complete");
      return result;
    });
    const beforeRequest = vi.fn(async (operation: S3RequestOperation) => {
      expect(signing).toHaveBeenCalled();
      expect(events.at(-1)).toBe("sign-complete");
      expect(Object.keys(operation).sort()).toEqual(["key", "method"]);
      expect(operation).toEqual({ method, key });
      expect(Object.isFrozen(operation)).toBe(true);
      expect(Reflect.set(operation, "key", "different-target")).toBe(false);
      expect(Reflect.set(operation, "method", "DELETE")).toBe(false);
      events.push("guard");
      return true;
    });
    const send = vi.fn(async (request: Request) => {
      events.push("fetch");
      expect(request.method).toBe(method);
      expect(request.url).toBe(url);
      expect(request.headers.get("authorization")).toContain("Signature=");
      expect(request.headers.get("authorization")).toContain("x-amz-expected-bucket-owner");
      expect(request.headers.get("x-amz-expected-bucket-owner")).toBe("111122223333");
      expect(request.redirect).toBe("manual");
      return new Response(method === "GET" ? "bytes" : null, { headers: { "content-length": "0" } });
    });
    const adapter = s3ByteAdapter(namespace, credentials, { beforeRequest, fetch: send });
    expect(beforeRequest).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    await expectAllowed(invoke(adapter, method), method);
    expect(events.slice(-2)).toEqual(["guard", "fetch"]);
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(methods)("does not send %s while its asynchronous fence is pending", async method => {
    const entered = deferred<void>(), allowed = deferred<boolean>();
    const beforeRequest = vi.fn(async () => {
      entered.resolve();
      return allowed.promise;
    });
    const send = vi.fn(async (_request: Request) => new Response(method === "GET" ? "bytes" : null,
      { headers: { "content-length": "0" } }));
    const adapter = s3ByteAdapter(namespace, credentials, { beforeRequest, fetch: send });
    const operation = invoke(adapter, method);
    await entered.promise;
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    allowed.resolve(true);
    await expectAllowed(operation, method);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(methods.flatMap(method => ["reject", "throw", "byte_error"].map(mode => ({ method, mode }))))(
    "blocks $method on a $mode fence without I/O, retry or private error details", async ({ method, mode }) => {
      const beforeRequest = vi.fn(async () => {
        if (mode === "throw") throw new Error("private lifecycle credential detail");
        if (mode === "byte_error") throw new ByteVerificationError("source", "hash_mismatch");
        return false;
      });
      const send = vi.fn(async (_request: Request) => new Response("unexpected"));
      const adapter = s3ByteAdapter(namespace, credentials, { beforeRequest, fetch: send });
      await expectBlocked(invoke(adapter, method), method);
      expect(beforeRequest).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 1, "true", {}])("requires literal true rather than a truthy fence result %j", async result => {
    const send = vi.fn(async (_request: Request) => new Response("unexpected"));
    const beforeRequest = vi.fn(async () => result as boolean);
    const adapter = s3ByteAdapter(namespace, credentials, { beforeRequest, fetch: send });
    await expectBlocked(invoke(adapter, "DELETE"), "DELETE");
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(methods)("rejects %s when caller ownership changes during cryptographic signing", async method => {
    let ownsLease = true;
    const originalSign = crypto.subtle.sign.bind(crypto.subtle);
    const signing = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...input) => {
      const result = await originalSign(...input);
      ownsLease = false;
      return result;
    });
    const beforeRequest = vi.fn(async () => ownsLease);
    const send = vi.fn(async (_request: Request) => new Response("unexpected"));
    const adapter = s3ByteAdapter(namespace, credentials, { beforeRequest, fetch: send });
    await expectBlocked(invoke(adapter, method), method);
    expect(signing).toHaveBeenCalled();
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(methods)("does not retroactively revoke or retry an already sent %s after caller ownership changes", async method => {
    let ownsLease = true;
    const sent = deferred<void>(), response = deferred<Response>();
    const beforeRequest = vi.fn(async () => ownsLease);
    const send = vi.fn(async (_request: Request) => {
      sent.resolve();
      return response.promise;
    });
    const adapter = s3ByteAdapter(namespace, credentials, { beforeRequest, fetch: send });
    const operation = invoke(adapter, method);
    await sent.promise;
    ownsLease = false;
    response.resolve(new Response(method === "GET" ? "bytes" : null, { headers: { "content-length": "0" } }));
    await expectAllowed(operation, method);
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

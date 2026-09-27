import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ByteReadResult } from "./byte-reader";
import type { ByteWriteInput } from "./byte-writer";
import { MAX_VERIFIED_BYTES, type Sha256Factory } from "./byte-verification";
import {
  copyShadowBytes, reconcileShadowDestination, ShadowByteTransferError, verifyExistingShadowBytes,
  type ShadowByteTarget, type ShadowCopyInput, type ShadowCopyStorage, type ShadowStorageIdentity,
} from "./shadow-byte-transfer";

const bytes = new TextEncoder().encode("shadow copy — 文件 contents");
const expected = (value = bytes) => ({ byteSize: value.byteLength,
  sha256: createHash("sha256").update(value).digest("hex") });
const hash: Sha256Factory = () => {
  const sink = createHash("sha256");
  return { async write(value) { sink.update(value); }, async finish() { return sink.digest("hex"); }, async abort() {} };
};
const sourceIdentity: ShadowStorageIdentity = { profileId: "source-profile", configurationRevision: 7,
  adapterType: "switchdrive", namespaceIdentity: "physical-source-instance" };
const destinationIdentity: ShadowStorageIdentity = { profileId: "destination-profile", configurationRevision: 2,
  adapterType: "r2", namespaceIdentity: "physical-destination-instance" };
const sourceTarget = (): ShadowByteTarget => ({ storage: { ...sourceIdentity }, objectKey: "literal/%2F/a//b" });
const destinationTarget = (): ShadowByteTarget => ({ storage: { ...destinationIdentity }, objectKey: "candidate/random-key" });
const request = (): ShadowCopyInput => ({ source: sourceTarget(), destination: destinationTarget(),
  expected: expected(), contentType: "application/octet-stream", filename: "test.bin" });

function stream(value: Uint8Array = bytes, options: { cancel?: () => void; extra?: Uint8Array; interrupt?: boolean } = {}) {
  let offset = 0;
  let ended = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < value.length) {
        const next = value.slice(offset, offset + 5);
        offset += next.length;
        controller.enqueue(next);
      } else if (!ended && options.extra) { ended = true; controller.enqueue(options.extra); }
      else if (options.interrupt) controller.error(new Error("private provider endpoint"));
      else controller.close();
    },
    cancel: options.cancel,
  }, { highWaterMark: 0 });
}
function available(body: ReadableStream<Uint8Array>): ByteReadResult {
  // Neither a plausible ETag nor any provider metadata is accepted as proof.
  return { outcome: "available", body, etag: expected().sha256,
    contentType: "application/octet-stream", httpMetadata: { "content-length": "1" } };
}
async function consume(input: ByteWriteInput): Promise<Uint8Array> {
  if (input.body instanceof ArrayBuffer) throw new Error("Expected streaming body");
  const reader = input.body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value.slice());
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
function fixture() {
  const objects = new Map<string, Uint8Array>();
  const sourceRead = vi.fn(async (_key: string): Promise<ByteReadResult> => available(stream()));
  const destinationRead = vi.fn(async (key: string): Promise<ByteReadResult> => {
    const value = objects.get(key);
    return value ? available(stream(value)) : { outcome: "missing" };
  });
  const write = vi.fn(async (input: ByteWriteInput) => { objects.set(input.key, await consume(input)); });
  const stat = vi.fn();
  const sourceReader = { read: sourceRead, stat };
  const destinationReader = { read: destinationRead, stat };
  const storage: ShadowCopyStorage = { source: { storage: { ...sourceIdentity }, reader: sourceReader },
    destination: { storage: { ...destinationIdentity }, reader: destinationReader,
      writer: { accepts: "stream", write } }, createHash: hash };
  return { storage, sourceRead, destinationRead, write, objects, stat,
    readonlyDestination: { ...storage.destination, createHash: hash } };
}

describe("shadow conversion byte transport", () => {
  it("binds both full-stream proofs to exact frozen profile revisions and opaque keys", async () => {
    const f = fixture();
    const input = request();
    const result = await copyShadowBytes(f.storage, input);
    expect(result).toEqual({ kind: "copied", source: { target: input.source, bytes: expected() },
      destination: { target: input.destination, bytes: expected() } });
    expect(f.sourceRead).toHaveBeenCalledExactlyOnceWith(input.source.objectKey);
    expect(f.destinationRead).toHaveBeenCalledExactlyOnceWith(input.destination.objectKey);
    expect(f.write).toHaveBeenCalledOnce();
    expect(f.write.mock.calls[0][0]).toMatchObject({ key: input.destination.objectKey,
      contentType: input.contentType, filename: input.filename, ...expected() });
    expect(Object.isFrozen(result.source.target.storage)).toBe(true);
    expect(Object.isFrozen(result.destination.bytes)).toBe(true);
    expect(f.stat).not.toHaveBeenCalled();
  });

  it.each(["profileId", "configurationRevision", "adapterType", "namespaceIdentity"] as const)(
    "rejects mismatched %s at either bound endpoint before source I/O", async field => {
      for (const side of ["source", "destination"] as const) {
        const f = fixture();
        const input = request();
        const storage = { ...input[side].storage, [field]: field === "configurationRevision" ? 999 : "different" };
        await expect(copyShadowBytes(f.storage, { ...input, [side]: { ...input[side], storage } }))
          .rejects.toMatchObject({ phase: "binding", reason: "invalid_binding", writeMayHaveCommitted: false });
        expect(f.sourceRead).not.toHaveBeenCalled();
        expect(f.write).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects buffer-only writers before opening the source", async () => {
    const f = fixture();
    const storage = { ...f.storage, destination: { ...f.storage.destination, writer: { accepts: "buffer" as const, write: f.write } } };
    await expect(copyShadowBytes(storage, request())).rejects.toMatchObject({ reason: "unsupported_writer", writeMayHaveCommitted: false });
    expect(f.sourceRead).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });

  it("refuses copying onto the physical source even under another profile ID or revision", async () => {
    const f = fixture();
    const destination = { storage: { ...destinationIdentity, namespaceIdentity: sourceIdentity.namespaceIdentity },
      objectKey: sourceTarget().objectKey };
    const storage = { ...f.storage, destination: { ...f.storage.destination, storage: destination.storage } };
    await expect(copyShadowBytes(storage, { ...request(), destination }))
      .rejects.toMatchObject({ reason: "same_location", writeMayHaveCommitted: false });
    expect(f.sourceRead).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });

  it("allows the same opaque key in a different physical namespace", async () => {
    const f = fixture();
    const destination = { ...destinationTarget(), objectKey: sourceTarget().objectKey };
    await expect(copyShadowBytes(f.storage, { ...request(), destination })).resolves.toMatchObject({ kind: "copied" });
  });

  it("adopts existing source bytes with a complete read and no write capability", async () => {
    const f = fixture();
    const result = await verifyExistingShadowBytes({ ...f.storage.source, createHash: hash }, { target: sourceTarget(), expected: expected() });
    expect(result).toEqual({ kind: "verified_existing", target: sourceTarget(), bytes: expected() });
    expect(f.sourceRead).toHaveBeenCalledOnce();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.destinationRead).not.toHaveBeenCalled();
  });

  it.each(["hash", "short", "extra"] as const)("rejects %s source mismatch without readback and conservatively retains uncertainty", async kind => {
    const f = fixture();
    const cancel = vi.fn();
    f.sourceRead.mockImplementation(async () => available(kind === "hash" ? stream(bytes.map(byte => byte ^ 1))
      : kind === "short" ? stream(bytes.slice(0, -1)) : stream(bytes, { extra: new Uint8Array([99]), cancel })));
    await expect(copyShadowBytes(f.storage, request())).rejects.toMatchObject({ phase: "source",
      reason: kind === "hash" ? "hash_mismatch" : "size_mismatch", writeMayHaveCommitted: true });
    expect(f.write).toHaveBeenCalledOnce();
    expect(f.destinationRead).not.toHaveBeenCalled();
    if (kind === "extra") expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not certify an acknowledged partial source and cancels its remaining stream", async () => {
    const f = fixture();
    const cancel = vi.fn();
    f.sourceRead.mockImplementation(async () => available(stream(bytes, { cancel })));
    f.write.mockImplementation(async input => {
      const reader = (input.body as ReadableStream<Uint8Array>).getReader();
      try { const first = await reader.read(); f.objects.set(input.key, first.value!); }
      finally { reader.releaseLock(); }
    });
    await expect(copyShadowBytes(f.storage, request())).rejects.toMatchObject({ phase: "source", reason: "incomplete", writeMayHaveCommitted: true });
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.destinationRead).not.toHaveBeenCalled();
    expect(f.write).toHaveBeenCalledOnce();
    await expect(reconcileShadowDestination(f.readonlyDestination, { target: destinationTarget(), expected: expected() }))
      .rejects.toMatchObject({ phase: "destination", reason: "size_mismatch", writeMayHaveCommitted: false });
    expect(f.write).toHaveBeenCalledOnce();
  });

  it("propagates provider cancellation to the source without proof or automatic cleanup", async () => {
    const f = fixture();
    const cancel = vi.fn();
    f.sourceRead.mockImplementation(async () => available(stream(bytes, { cancel })));
    f.write.mockImplementation(async input => { await (input.body as ReadableStream).cancel("provider stopped"); });
    await expect(copyShadowBytes(f.storage, request())).rejects.toMatchObject({ reason: "incomplete", writeMayHaveCommitted: true });
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.destinationRead).not.toHaveBeenCalled();
    expect(f.write).toHaveBeenCalledOnce();
  });

  it("never retries after a committed PUT loses its acknowledgement, then reconciles only the destination", async () => {
    const f = fixture();
    f.write.mockImplementation(async input => {
      f.objects.set(input.key, await consume(input));
      throw new Error("private authorization header");
    });
    await expect(copyShadowBytes(f.storage, request())).rejects.toEqual(new ShadowByteTransferError("destination", "unavailable", true));
    expect(f.write).toHaveBeenCalledOnce();
    expect(f.destinationRead).not.toHaveBeenCalled();
    const result = await reconcileShadowDestination(f.readonlyDestination, { target: destinationTarget(), expected: expected() });
    expect(result).toEqual({ kind: "reconciled_destination", target: destinationTarget(), bytes: expected() });
    expect(result).not.toHaveProperty("source");
    expect(f.sourceRead).toHaveBeenCalledOnce();
    expect(f.destinationRead).toHaveBeenCalledOnce();
    expect(f.write).toHaveBeenCalledOnce();
  });

  it("cannot reconcile a missing candidate and never turns reconciliation into another write", async () => {
    const f = fixture();
    f.write.mockRejectedValue(new Error("network connection closed"));
    await expect(copyShadowBytes(f.storage, request())).rejects.toMatchObject({ writeMayHaveCommitted: true });
    await expect(reconcileShadowDestination(f.readonlyDestination, { target: destinationTarget(), expected: expected() }))
      .rejects.toMatchObject({ phase: "destination", reason: "unavailable", writeMayHaveCommitted: false });
    expect(f.write).toHaveBeenCalledOnce();
  });

  it.each(["changed", "extra", "interrupted"] as const)("rejects %s destination readback despite matching provider metadata", async kind => {
    const f = fixture();
    const cancel = vi.fn();
    f.destinationRead.mockImplementation(async () => available(kind === "changed" ? stream(bytes.map(byte => byte ^ 1))
      : stream(bytes, kind === "extra" ? { extra: new Uint8Array([1]), cancel } : { interrupt: true })));
    await expect(copyShadowBytes(f.storage, request())).rejects.toMatchObject({ phase: "destination",
      reason: kind === "changed" ? "hash_mismatch" : kind === "extra" ? "size_mismatch" : "unavailable", writeMayHaveCommitted: true });
    expect(f.write).toHaveBeenCalledOnce();
    expect(f.destinationRead).toHaveBeenCalledOnce();
    if (kind === "extra") expect(cancel).toHaveBeenCalledOnce();
  });

  it("requires successful EOF on the source even after receiving the complete expected prefix", async () => {
    const f = fixture();
    f.sourceRead.mockImplementation(async () => available(stream(bytes, { interrupt: true })));
    await expect(copyShadowBytes(f.storage, request())).rejects.toMatchObject({ phase: "source", reason: "unavailable", writeMayHaveCommitted: true });
    expect(f.destinationRead).not.toHaveBeenCalled();
  });

  it.each(["missing", "denied", "unavailable", "throws"] as const)("rejects %s source before starting a write and hides provider errors", async outcome => {
    const f = fixture();
    f.sourceRead.mockImplementation(async () => {
      if (outcome === "throws") throw new Error("private credentials");
      return outcome === "denied" ? { outcome, status: 403 } : { outcome };
    });
    await expect(copyShadowBytes(f.storage, request())).rejects.toEqual(new ShadowByteTransferError("source", "unavailable", false));
    expect(f.write).not.toHaveBeenCalled();
    expect(f.destinationRead).not.toHaveBeenCalled();
  });

  it("freezes proof association, readback address and metadata before an async source open", async () => {
    const f = fixture();
    const input = { source: { ...sourceTarget(), storage: { ...sourceIdentity } },
      destination: { ...destinationTarget(), storage: { ...destinationIdentity } },
      expected: expected(), contentType: "application/octet-stream", filename: "initial.bin" };
    let release!: (value: ByteReadResult) => void;
    f.sourceRead.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const operation = copyShadowBytes(f.storage, input);
    input.source.objectKey = "changed-source";
    input.source.storage.profileId = "changed-profile";
    input.destination.objectKey = "changed-destination";
    input.destination.storage.configurationRevision++;
    input.expected.sha256 = "0".repeat(64);
    input.filename = "changed.bin";
    release(available(stream()));
    const result = await operation;
    expect(result.source).toEqual({ target: sourceTarget(), bytes: expected() });
    expect(result.destination).toEqual({ target: destinationTarget(), bytes: expected() });
    expect(f.write.mock.calls[0][0]).toMatchObject({ key: destinationTarget().objectKey, filename: "initial.bin" });
    expect(f.destinationRead).toHaveBeenCalledExactlyOnceWith(destinationTarget().objectKey);
  });

  it("handles zero-byte copies using two independently verified EOFs", async () => {
    const f = fixture();
    const empty = new Uint8Array();
    f.sourceRead.mockImplementation(async () => available(stream(empty)));
    const result = await copyShadowBytes(f.storage, { ...request(), expected: expected(empty) });
    expect(result.source.bytes).toEqual(expected(empty));
    expect(result.destination.bytes).toEqual(expected(empty));
    expect(f.destinationRead).toHaveBeenCalledOnce();
  });

  it.each([-1, NaN, Infinity, 0.5, MAX_VERIFIED_BYTES + 1])("rejects invalid expected size %s before I/O", async byteSize => {
    const f = fixture();
    await expect(copyShadowBytes(f.storage, { ...request(), expected: { ...expected(), byteSize } }))
      .rejects.toMatchObject({ reason: "invalid_expectation", writeMayHaveCommitted: false });
    expect(f.sourceRead).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });

  it("revalidates the exact destination identity for reconciliation without opening it on mismatch", async () => {
    const f = fixture();
    const target = { ...destinationTarget(), storage: { ...destinationIdentity, configurationRevision: 3 } };
    await expect(reconcileShadowDestination(f.readonlyDestination, { target, expected: expected() }))
      .rejects.toMatchObject({ reason: "invalid_binding", writeMayHaveCommitted: false });
    expect(f.destinationRead).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
});

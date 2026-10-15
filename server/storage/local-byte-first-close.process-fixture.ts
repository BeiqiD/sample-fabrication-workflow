import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { openLocalByteStorage, type LocalByteBinding } from "./local-byte-storage";
import { nodeSha256 } from "./node-sha256";
import { ByteVerificationError, verifyingStream, verifyByteStream, verifyStoredBytes } from "../../worker/files/byte-verification";
import { writeVerifiedBytes } from "../../worker/files/byte-writer";
import { StorageProfileCleanupError } from "../../worker/files/storage-profile-opening";

// This executable is a terminal-process fault control, never a public route or
// successful application/lease shutdown. Failed exact native owners remain
// strongly retained by the production module until this original process exits.
const [root, rawNamespace, mode] = process.argv.slice(2);
const modes = ["data-close-before", "data-close-after", "data-work-and-close", "metadata-work-and-close",
  "constructor-close", "read-close-after", "source-cancel", "readonly-write", "rename-after",
  "verifier-dispose", "verifier-constructor", "outer-write-cancel"] as const;
assert(root && rawNamespace && modes.includes(mode as typeof modes[number]));
const namespace: LocalByteBinding["namespace"] = JSON.parse(rawNamespace);
const binding = { root, namespace }, bytes = new TextEncoder().encode("fixed actual Local byte fault control");
const expected = { byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
const originalWork = new Error("Fixed original work fault"), originalClose = new Error("Fixed first native close fault");
const originalCancel = new Error("Fixed original body cancel fault"), originalRename = new Error("Fixed original rename acknowledgement fault");
const realOpen = fs.open.bind(fs), realRename = fs.rename.bind(fs);
const parents: { path: string; handle: FileHandle; closes: number }[] = [];
const injected: { handle: FileHandle; closes: number }[] = [];
let cancellations = 0, renames = 0, injectionArmed = mode !== "read-close-after";
function contains(error: unknown, exact: unknown, seen = new Set<unknown>()): boolean {
  if (error === exact) return true;
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  if (error instanceof AggregateError && error.errors.some(value => contains(value, exact, seen))) return true;
  return "cause" in error && contains(error.cause, exact, seen);
}
async function rejected(work: Promise<unknown>): Promise<unknown> {
  try { await work; } catch (error) { return error; }
  assert.fail("The fixed negative operation unexpectedly acknowledged");
}
function canceledBody() {
  return new ReadableStream<Uint8Array>({ cancel() { cancellations++; throw originalCancel; } }, { highWaterMark: 0 });
}
const namespaceBefore = await fs.readFile(join(root, "namespace.json"));
if (mode === "readonly-write") {
  // Root can bypass ordinary mode bits, so this one new child drops to a real
  // nonroot UID after loading its source, on only its dedicated private root.
  if (process.geteuid?.() === 0) {
    for (const path of [root, join(root, "objects"), join(root, "staging"), join(root, "namespace.json")]) await fs.chown(path, 65534, 65534);
    process.setgid!(65534); process.setuid!(65534);
  }
  await fs.chmod(join(root, "staging"), 0o500);
}
if (mode === "constructor-close") await fs.writeFile(join(root, "namespace.json"), "{");
fs.open = (async (...args: Parameters<typeof fs.open>) => {
  const handle = await realOpen(...args), path = String(args[0]), close = handle.close.bind(handle);
  const parent = [root, join(root, "objects"), join(root, "staging")].includes(path) && !parents.some(value => value.path === path)
    ? { path, handle, closes: 0 } : undefined;
  if (parent) parents.push(parent);
  const dataFault = injectionArmed && /\/staging\/attempt-[^/]+\/data$/.test(path)
    && ["data-close-before", "data-close-after", "data-work-and-close"].includes(mode);
  const metadataFault = injectionArmed && /\/staging\/attempt-[^/]+\/metadata\.json$/.test(path) && mode === "metadata-work-and-close";
  const readFault = injectionArmed && /\/objects\/[a-f0-9]{64}\/data$/.test(path) && mode === "read-close-after";
  const constructorFault = path === join(root, "namespace.json") && mode === "constructor-close";
  const fault = dataFault || metadataFault || readFault || constructorFault ? { handle, closes: 0 } : undefined;
  if (fault) injected.push(fault);
  handle.close = async () => {
    if (parent) parent.closes++;
    if (fault) {
      fault.closes++;
      if (mode === "data-close-before") throw originalClose;
      await close(); throw originalClose;
    }
    await close();
  };
  if (dataFault && mode === "data-work-and-close") {
    const write = handle.write.bind(handle);
    handle.write = (async (...values: Parameters<typeof write>) => { await write(...values); throw originalWork; }) as typeof handle.write;
  }
  if (metadataFault) {
    const sync = handle.sync.bind(handle);
    handle.sync = async () => { await sync(); throw originalWork; };
  }
  return handle;
}) as typeof fs.open;
fs.rename = async (from, to) => {
  renames++; await realRename(from, to);
  if (mode === "rename-after") throw originalRename;
};
syncBuiltinESMExports();
let backendAck = false, quarantined = false;
if (mode === "verifier-constructor") {
  const error = await rejected(verifyByteStream(canceledBody(), expected, () => { throw originalWork; }, "source"));
  assert(contains(error, originalWork)); assert(contains(error, originalCancel)); assert.equal(cancellations, 1);
} else if (mode === "verifier-dispose") {
  const source = verifyingStream(canceledBody(), expected, nodeSha256, "source");
  const first = source.dispose(), again = source.dispose(); assert.equal(first, again);
  assert.equal(await rejected(first), originalCancel); assert.equal(await rejected(again), originalCancel);
  assert.equal(cancellations, 1);
} else if (mode === "outer-write-cancel") {
  const error = await rejected(writeVerifiedBytes({ reader: { async read() { assert.fail("No destination read is permitted"); } },
    writer: { accepts: "both", async write() { assert.fail("No transport write is permitted"); } }, createHash: nodeSha256 },
  { key: "fixed", body: canceledBody(), byteSize: -1, sha256: expected.sha256, contentType: "application/octet-stream", filename: "fixed.bin" }));
  assert(error instanceof AggregateError); assert(error.errors[0] instanceof ByteVerificationError);
  assert.equal(error.errors[0].reason, "invalid_expectation"); assert.equal(error.errors[1], originalCancel); assert.equal(cancellations, 1);
} else if (mode === "constructor-close") {
  const error = await rejected(openLocalByteStorage(binding)); assert(error instanceof StorageProfileCleanupError);
  assert(contains(error.validationCause, originalClose)); assert(contains(error.cleanupCause, originalClose));
  const first = error.ownership.dispose(), again = error.ownership.dispose(); assert.equal(first, again);
  assert(contains(await rejected(first), originalClose)); quarantined = true;
} else {
  const storage = await openLocalByteStorage(binding);
  const input = { key: "fixed", body: Uint8Array.from(bytes).buffer, ...expected, contentType: "application/octet-stream", filename: "fixed.bin" };
  if (mode === "read-close-after") {
    await storage.writer.write(input); injectionArmed = true;
    const result = await storage.reader.read("fixed"); assert.equal(result.outcome, "available");
    if (result.outcome !== "available") assert.fail("Expected the actual immutable data body");
    const reader = result.body.getReader(); let readBytes = 0, work: unknown;
    try { for (;;) { const next = await reader.read(); if (next.done) break; readBytes += next.value.length; } }
    catch (error) { work = error; } finally { reader.releaseLock(); }
    assert.equal(readBytes, bytes.length); assert(contains(work, originalClose));
  } else if (mode === "source-cancel") {
    const work = await rejected(storage.writer.write({ ...input, body: canceledBody(), byteSize: -1 }));
    assert(work instanceof AggregateError); assert(work.errors[0] instanceof ByteVerificationError);
    assert.equal(work.errors[0].reason, "invalid_expectation"); assert.equal(work.errors[1], originalCancel); assert.equal(cancellations, 1);
  } else {
    const work = await rejected(storage.writer.write(input));
    if (mode === "readonly-write") {
      assert(work instanceof Error && "cause" in work && typeof work.cause === "object" && work.cause !== null && "code" in work.cause);
      assert.equal(work.cause.code, "EACCES"); assert.equal((await fs.readdir(join(root, "staging"))).length, 0);
    } else if (mode === "rename-after") assert(contains(work, originalRename));
    else {
      assert(contains(work, originalClose));
      if (mode === "data-work-and-close" || mode === "metadata-work-and-close") {
        assert(work instanceof AggregateError); assert(contains(work.errors[0], originalWork)); assert(contains(work, originalClose));
      } else assert.equal(work, originalClose);
      assert.equal((await fs.readdir(join(root, "objects"))).length, 0);
      assert.equal((await fs.readdir(join(root, "staging"))).length, 1);
    }
  }
  const first = storage.close(), again = storage.close(); assert.equal(first, again);
  if (["readonly-write", "rename-after"].includes(mode)) { await first; backendAck = true; }
  else {
    const failure = await rejected(first); assert(contains(failure, mode === "source-cancel" ? originalCancel : originalClose));
    assert.equal(await rejected(again), failure); quarantined = true;
  }
  if (mode === "rename-after") {
    const fresh = await openLocalByteStorage(binding);
    assert.deepEqual(await verifyStoredBytes(fresh.reader, "fixed", expected, nodeSha256), expected);
    await fresh.close(); assert.equal(renames, 1);
    assert.equal((await fs.readdir(join(root, "objects"))).length, 1); assert.equal((await fs.readdir(join(root, "staging"))).length, 0);
  }
}
for (const fault of injected) assert.equal(fault.closes, 1);
if (mode === "data-close-before") assert(injected[0].handle.fd >= 0);
if (quarantined) {
  assert.equal(parents.length, 3);
  for (const parent of parents) { assert.equal(parent.closes, 0); assert(parent.handle.fd >= 0); }
} else if (backendAck) for (const parent of parents) { assert.equal(parent.closes, 1); assert.equal(parent.handle.fd, -1); }
if (mode !== "constructor-close") assert.deepEqual(await fs.readFile(join(root, "namespace.json")), namespaceBefore);
process.stdout.write(JSON.stringify({ version: 1, mode, assertionsComplete: true, injectedCloseCalls: injected.map(value => value.closes),
  originalParentCloseCalls: parents.map(value => value.closes), originalBodyCancelCalls: cancellations, originalRenameCalls: renames,
  backendNormalCloseAck: backendAck, failedOriginalOwnerRetained: quarantined, terminalProcessClosureOnly: quarantined,
  appNativeLeaseAckClaimed: false, existingFoundationCasesRepeated: 0 }) + "\n");

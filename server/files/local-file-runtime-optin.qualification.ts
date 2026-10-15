import { createHash } from "node:crypto";
import { validateFileUploadResult } from "../../shared/contracts/r2-upload";
import { expect } from "vitest";
import { fixture, it } from "./local-file-runtime-optin.qualification-support";

const bytes = new TextEncoder().encode("Actual operational runtime original LocalFile bytes 🧪");
const digest = createHash("sha256").update(bytes).digest("hex");
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function upload(f: Fixture) {
  const requestId = crypto.randomUUID();
  const answer = await f.request("POST", "/api/assets", bytes, {
    "content-type": "image/png", "x-filename": "original-runtime.png", "x-upload-request-id": requestId,
  });
  expect(answer.status).toBe(201);
  const result = validateFileUploadResult(answer.value);
  expect(result).toMatchObject({ storageKind: "native", key: null, deduplicated: false });
  if (!answer.value || typeof answer.value !== "object" || !("id" in answer.value) || typeof answer.value.id !== "string")
    throw new Error("Original runtime upload result required");
  return { assetId: answer.value.id, requestId };
}

it("explicitly starts the real operational File runtime and restarts with the same published bytes and exact native cells", async () => {
  const f = await fixture(), accepted = await upload(f);
  const read = await f.request("GET", "/api/file-assets/" + accepted.assetId);
  expect(read.status).toBe(200); expect(read.value).toBe(new TextDecoder().decode(bytes));
  expect(read.headers.get("cache-control")).toBe("private, no-store");
  const assets = await f.stoppedRows("assets"), files = await f.stoppedRows("files"), publications = await f.stoppedRows("file_usable_publications");
  expect(assets).toEqual([expect.objectContaining({ id: accepted.assetId, sha256: digest, byte_size: BigInt(bytes.byteLength), r2_key: null })]);
  await f.restart();
  const restarted = await f.request("GET", "/api/file-assets/" + accepted.assetId);
  expect(restarted.status).toBe(200); expect(restarted.value).toBe(new TextDecoder().decode(bytes));
  expect(await f.stoppedRows("assets")).toEqual(assets);
  expect(await f.stoppedRows("files")).toEqual(files);
  expect(await f.stoppedRows("file_usable_publications")).toEqual(publications);
});

it("keeps existing active profiles unavailable to File HTTP when the explicit runtime opt-in is omitted", async () => {
  const f = await fixture({});
  const answer = await f.request("POST", "/api/assets", bytes, { "content-type": "image/png", "x-filename": "omitted.png", "x-upload-request-id": crypto.randomUUID() });
  expect(answer.status).toBe(503);
  expect((await f.request("GET", "/api/auth/session")).status).toBe(200);
  expect(await f.stoppedRows("assets")).toEqual([]);
});

it("keeps explicit false unavailable without inventing a default File role or publishing an asset", async () => {
  const f = await fixture({ enableLocalFile: false });
  const answer = await f.request("POST", "/api/assets", bytes, { "content-type": "image/png", "x-filename": "disabled.png", "x-upload-request-id": crypto.randomUUID() });
  expect(answer.status).toBe(503); expect(await f.stoppedRows("assets")).toEqual([]);
});

it("refuses nonboolean opt-in and enabled configurations without independently pinned volumes before starting a runtime", async () => {
  await expect(fixture({ enableLocalFile: "true" })).rejects.toThrow("Local runtime configuration is unavailable.");
  await expect(fixture({ enableLocalFile: true, omitVolumeDescriptors: true })).rejects.toThrow("Local runtime configuration is unavailable.");
});

it("retains the original operational runtime through an admitted held Request and commits only after original body EOF", async () => {
  const f = await fixture(); let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder(), value = { name: "Original runtime held definition", toolName: "SEM", parametersText: "Actual parameter", commentsText: "Actual notes" };
  const body = new ReadableStream<Uint8Array>({ start(stream) { controller = stream; stream.enqueue(encoder.encode("{")); } });
  const original = f.request("POST", "/api/templates/execution-template/steps", body);
  let closing: Promise<void> | undefined, settled = false;
  try {
    const observer = f.secondary();
    await expect.poll(() => observer.prepare("SELECT count(*) n FROM system_recovery_write_leases WHERE released_at IS NULL").get()?.n, { timeout: 1000 }).toBe(1);
    closing = f.stopAndDrainApplication(); closing.then(() => { settled = true; }, () => undefined);
    await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(false);
  } finally { controller.enqueue(encoder.encode(JSON.stringify(value).slice(1))); controller.close(); await original; }
  expect((await original).status).toBe(201); await closing; expect(settled).toBe(true);
  await f.restart(); expect((await f.request("GET", "/api/auth/session")).status).toBe(200);
});

it("requires the original current authenticated Request even with explicitly enabled stored File authority", async () => {
  const f = await fixture();
  const answer = await f.request("POST", "/api/assets", bytes, { cookie: "", "content-type": "image/png", "x-filename": "anonymous.png", "x-upload-request-id": crypto.randomUUID() });
  expect(answer.status).toBe(401); expect(await f.stoppedRows("assets")).toEqual([]);
});

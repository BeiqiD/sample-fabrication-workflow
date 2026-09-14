import { sha256Hex } from "../../shared/content-addressing";
import { createUuid } from "./uuid";
import { R2_UPLOAD_REQUEST_HEADER, validateR2UploadInput, type R2UploadIngress, type R2UploadResult } from "../../shared/contracts/r2-upload";
export type { R2UploadIngress, R2UploadResult } from "../../shared/contracts/r2-upload";

export interface R2UploadOptions { context: string }
interface Checkpoint {
  version: 1; requestId: string; ingress: R2UploadIngress; observedReady: boolean;
  filename: string; mimeType: string; byteSize: number; sha256: string;
}
interface Prepared { checkpoint: Checkpoint; file: Blob; attempted: boolean; result?: R2UploadResult; terminal?: string }
const PREFIX = "r2-upload-request-v1:";
const preparedFiles = new WeakMap<Blob, Map<string, Promise<Blob>>>();
const operations = new WeakMap<Blob, Map<string, Promise<Prepared>>>();
const generations = new Map<string, number>();
const active = new Map<string, { file: Blob; filename: string; promise: Promise<R2UploadResult> }>();

export class R2UploadRequestError extends Error {
  constructor(message: string, readonly terminal = false) { super(message); this.name = "R2UploadRequestError"; }
}

/** Preparation belongs to the selected file/form, so retry never recompresses it. */
export async function prepareR2UploadFile<T extends Blob>(file: T, context: string, prepare: () => Promise<T>): Promise<T> {
  let entries = preparedFiles.get(file);
  if (!entries) { entries = new Map(); preparedFiles.set(file, entries); }
  let pending = entries.get(context);
  if (!pending) {
    pending = prepare(); entries.set(context, pending);
    pending.catch(() => { if (entries?.get(context) === pending) entries.delete(context); });
  }
  return await pending as T;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validResult(value: unknown): value is R2UploadResult {
  return record(value) && typeof value.id === "string" && value.id.length > 0 && [...value.id].length <= 256 && !value.id.includes("\0")
    && typeof value.key === "string" && value.key.length > 0 && [...value.key].length <= 4096 && !value.key.includes("\0")
    && typeof value.deduplicated === "boolean";
}
function storageKey(ingress: R2UploadIngress, context: string) {
  if (!context || context.length > 1024 || context.includes("\0")) throw new Error("Invalid upload form identity");
  return `${PREFIX}${ingress}:${encodeURIComponent(context)}`;
}
function loadCheckpoint(key: string): Checkpoint | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    if (new TextEncoder().encode(raw).byteLength > 4096) throw new Error();
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 1 || typeof value.observedReady !== "boolean" || typeof value.requestId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.requestId)
      || !["ordinary_image", "project_attachment"].includes(String(value.ingress))
      || typeof value.filename !== "string" || value.filename.length > 1024
      || typeof value.mimeType !== "string" || value.mimeType.length > 200
      || !Number.isSafeInteger(value.byteSize) || Number(value.byteSize) < 0 || Number(value.byteSize) > 10 * 1024 * 1024
      || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error();
    return value as unknown as Checkpoint;
  } catch { throw new R2UploadRequestError("This browser could not read the saved upload request. Restore session storage before uploading."); }
}
function saveCheckpoint(key: string, value: Checkpoint) {
  try {
    const raw = JSON.stringify(value);
    if (new TextEncoder().encode(raw).byteLength > 4096) throw new Error();
    sessionStorage.setItem(key, raw);
    if (sessionStorage.getItem(key) !== raw) throw new Error();
  } catch { throw new R2UploadRequestError("The browser could not save this upload request. Free browser storage or discard an earlier upload, then retry."); }
}
function clearCheckpoint(key: string, requestId: string) {
  // Do not erase a newer form's checkpoint if it changed while awaiting I/O.
  try { if (loadCheckpoint(key)?.requestId === requestId) sessionStorage.removeItem(key); } catch { /* Retaining a settled checkpoint is safe. */ }
}
async function bytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The selected file could not be read."));
    reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error("The selected file could not be read."));
    reader.readAsArrayBuffer(file);
  });
}
async function prepare(file: Blob, filename: string, ingress: R2UploadIngress, key: string): Promise<Prepared> {
  const mimeType = file.type || "application/octet-stream";
  if (file.size > 10 * 1024 * 1024) throw new R2UploadRequestError("File uploads are limited to 10 MB.", true);
  const sha256 = await sha256Hex(await bytes(file));
  const prior = loadCheckpoint(key);
  validateR2UploadInput({ schema: "r2-upload-request/1", ingress, purpose: ingress === "ordinary_image" ? "embedded_content" : "research_source", scope: "system", file: { originalName: filename, mimeType, byteSize: file.size, sha256 } });
  const input = { filename, mimeType, byteSize: file.size, sha256, ingress };
  if (prior && Object.entries(input).some(([name, value]) => prior[name as keyof Checkpoint] !== value)) {
    throw new R2UploadRequestError("A previous upload is still unresolved. Reselect its original file to check the same request before starting another upload.");
  }
  const checkpoint: Checkpoint = prior ?? { version: 1, requestId: createUuid(), observedReady: false, ...input };
  saveCheckpoint(key, checkpoint);
  return { checkpoint, file, attempted: prior !== null };
}
function settleState(value: unknown, prepared: Prepared, key: string): R2UploadResult {
  const expected = prepared.checkpoint;
  if (!record(value) || value.requestId !== expected.requestId || value.ingress !== expected.ingress
    || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) {
    throw new R2UploadRequestError("The upload status could not be verified. Retry to check the same request.");
  }
  if (value.status === "ready" && validResult(value.result)) {
    prepared.result = value.result; prepared.checkpoint.observedReady = true; clearCheckpoint(key, expected.requestId); return value.result;
  }
  if (value.status === "pending") throw new R2UploadRequestError("The upload is still processing. Retry to check its status; the file will not be uploaded again.");
  if (["failed", "expired", "unavailable"].includes(String(value.status))) {
    prepared.terminal = value.status === "unavailable"
      ? "The completed upload is no longer available. Choose the file again to start a new upload."
      : "This upload did not complete. Choose the file again to start a new upload.";
    clearCheckpoint(key, expected.requestId);
    throw new R2UploadRequestError(prepared.terminal, true);
  }
  throw new R2UploadRequestError("The upload status could not be verified. Retry to check the same request.");
}
async function execute(prepared: Prepared, key: string): Promise<R2UploadResult> {
  if (prepared.terminal) throw new R2UploadRequestError(prepared.terminal, true);
  const { checkpoint } = prepared;
  if (prepared.result) {
    const current = loadCheckpoint(key);
    if (current && current.requestId !== checkpoint.requestId) {
      throw new R2UploadRequestError("Another upload in this form is unresolved. Reselect its original file before checking an earlier upload.");
    }
    // A failed revalidation must remain recoverable after reload as well.
    saveCheckpoint(key, checkpoint);
  }
  if (prepared.attempted) {
    let response: Response;
    try { response = await fetch(`/api/r2-upload-requests/${encodeURIComponent(checkpoint.requestId)}`, { cache: "no-store" }); }
    catch { throw new R2UploadRequestError("The upload status could not be checked. Retry to check the same request."); }
    if (response.status !== 404) {
      const payload: unknown = await response.json().catch(() => null);
      if (response.ok) return settleState(payload, prepared, key);
      throw new R2UploadRequestError("The upload status could not be checked. Retry to check the same request.");
    }
    if (checkpoint.observedReady) {
      throw new R2UploadRequestError("The previously completed upload could not be found. Check the same request again; it will not be uploaded again.");
    }
    // Absence can race a prior POST still reading its body. Keep the exact UUID.
  }
  saveCheckpoint(key, checkpoint);
  prepared.attempted = true;
  let response: Response;
  try {
    response = await fetch(checkpoint.ingress === "ordinary_image" ? "/api/assets" : "/api/project-assets", {
      method: "POST",
      headers: {
        "content-type": checkpoint.mimeType,
        [R2_UPLOAD_REQUEST_HEADER]: checkpoint.requestId,
        ...(checkpoint.ingress === "ordinary_image"
          ? { "X-Filename-Uri": encodeURIComponent(checkpoint.filename) }
          : { "x-project-filename-uri": encodeURIComponent(checkpoint.filename) }),
      },
      body: prepared.file,
    });
  } catch { throw new R2UploadRequestError("The upload response was lost. Retry to check the same request."); }
  const payload: unknown = await response.json().catch(() => null);
  if (response.ok && response.status !== 202 && validResult(payload)) {
    prepared.result = payload; checkpoint.observedReady = true; clearCheckpoint(key, checkpoint.requestId); return payload;
  }
  if (record(payload) && record(payload.request)) return settleState(payload.request, prepared, key);
  if (response.status === 202 || record(payload) && typeof payload.status === "string" && typeof payload.requestId === "string") return settleState(payload, prepared, key);
  throw new R2UploadRequestError(record(payload) && typeof payload.error === "string"
    ? `${payload.error} Retry to check the same upload request.`
    : "The upload response could not be verified. Retry to check the same request.");
}

/** Explicitly abandons client tracking; it does not cancel a server execution. */
export function discardR2Upload(ingress: R2UploadIngress, context: string): void {
  const key = storageKey(ingress, context);
  if (active.has(key)) throw new R2UploadRequestError("Wait for the current upload check before discarding it.");
  try {
    sessionStorage.removeItem(key);
    if (sessionStorage.getItem(key) !== null) throw new Error();
  } catch { throw new R2UploadRequestError("This browser could not discard the saved upload request. Restore session storage and try again."); }
  generations.set(key, (generations.get(key) ?? 0) + 1);
}

/** The checkpoint is persisted before POST; status checks never create new IDs. */
export async function uploadR2Asset(file: Blob, filename: string, ingress: R2UploadIngress, options: R2UploadOptions = { context: "upload" }): Promise<R2UploadResult> {
  const key = storageKey(ingress, options.context);
  const previous = active.get(key);
  if (previous?.file === file && previous.filename === filename) return previous.promise;
  const operation = (async () => {
    if (previous) { try { await previous.promise; } catch { /* Reconcile this caller's own operation. */ } }
    const operationKey = `${key}:${generations.get(key) ?? 0}:${filename}`;
    let entries = operations.get(file);
    if (!entries) { entries = new Map(); operations.set(file, entries); }
    let pending = entries.get(operationKey);
    if (!pending) {
      pending = prepare(file, filename, ingress, key); entries.set(operationKey, pending);
      pending.catch(() => { if (entries?.get(operationKey) === pending) entries.delete(operationKey); });
    }
    return execute(await pending, key);
  })();
  const current = { file, filename, promise: operation };
  active.set(key, current);
  try { return await operation; } finally { if (active.get(key) === current) active.delete(key); }
}

import { sha256Hex } from "../../shared/content-addressing";
import type { MetrologyTemplateReference } from "../../shared/contracts/template";
import {
  MAX_METROLOGY_REFERENCE_UPLOAD_BYTES, validateMetrologyReferenceUploadInput, validateMetrologyReferenceUploadResult,
} from "../../shared/contracts/metrology-reference-upload";
import { createUuid } from "./uuid";

const MAX_BYTES = MAX_METROLOGY_REFERENCE_UPLOAD_BYTES;
const PREFIX = "metrology-reference-upload-v1:";
interface Checkpoint {
  version: 1; requestId: string; templateId: string; observedReady: boolean;
  filename: string; mimeType: string; byteSize: number; sha256: string;
}
interface Prepared { checkpoint: Checkpoint; file: File; attempted: boolean; terminal?: string }
export interface MetrologyReferenceUploadResult { requestId: string; reference: MetrologyTemplateReference }
const operations = new WeakMap<File, Map<string, Promise<Prepared>>>();
const generations = new Map<string, number>();
const active = new Map<string, { file: File; promise: Promise<MetrologyReferenceUploadResult> }>();

export class MetrologyReferenceUploadError extends Error {
  constructor(message: string, readonly terminal = false) { super(message); this.name = "MetrologyReferenceUploadError"; }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0") && [...value].length <= maximum;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function keyFor(templateId: string) {
  if (!text(templateId, 256)) throw new Error("Invalid metrology template identity");
  return `${PREFIX}${encodeURIComponent(templateId)}`;
}
function readCheckpoint(key: string): Checkpoint | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    if (new TextEncoder().encode(raw).byteLength > 8192) throw new Error();
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 1 || typeof value.observedReady !== "boolean"
      || typeof value.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.requestId)
      || !text(value.templateId, 256) || keyFor(value.templateId) !== key
      || !text(value.filename, 255) || !text(value.mimeType, 200)
      || !/^[\x20-\x7e]+$/.test(value.mimeType) || value.mimeType.trim() !== value.mimeType
      || !Number.isSafeInteger(value.byteSize) || Number(value.byteSize) <= 0 || Number(value.byteSize) > MAX_BYTES
      || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error();
    return value as unknown as Checkpoint;
  } catch { throw new MetrologyReferenceUploadError("This browser could not read the saved reference upload. Restore session storage or discard the upload before continuing."); }
}
function saveCheckpoint(key: string, value: Checkpoint) {
  try {
    const raw = JSON.stringify(value);
    if (new TextEncoder().encode(raw).byteLength > 8192) throw new Error();
    sessionStorage.setItem(key, raw);
    if (sessionStorage.getItem(key) !== raw) throw new Error();
  } catch { throw new MetrologyReferenceUploadError("This browser could not save the reference upload request. Restore session storage before retrying."); }
}
async function bytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The selected reference file could not be read."));
    reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error("The selected reference file could not be read."));
    reader.readAsArrayBuffer(file);
  });
}
async function prepare(templateId: string, file: File, key: string): Promise<Prepared> {
  const prior = readCheckpoint(key);
  if (file.size <= 0 || file.size > MAX_BYTES) throw new MetrologyReferenceUploadError("Reference files must contain data and be no larger than 25 MB.", true);
  const mimeType = file.type || "application/octet-stream";
  if (!text(file.name, 255) || !text(mimeType, 200) || !/^[\x20-\x7e]+$/.test(mimeType) || mimeType.trim() !== mimeType) {
    throw new MetrologyReferenceUploadError("The reference filename or file type is invalid.", true);
  }
  const input = { templateId, filename: file.name, mimeType, byteSize: file.size, sha256: await sha256Hex(await bytes(file)) };
  validateMetrologyReferenceUploadInput({ schema: "metrology-reference-upload/1", ingress: "metrology_reference", purpose: "research_source", scope: "system", templateId,
    file: { originalName: input.filename, mimeType, byteSize: input.byteSize, sha256: input.sha256 } });
  if (prior && Object.entries(input).some(([name, value]) => prior[name as keyof Checkpoint] !== value)) {
    throw new MetrologyReferenceUploadError("A previous reference upload is unresolved. Reselect its original file to check it, or discard the upload before choosing another file.");
  }
  const checkpoint: Checkpoint = prior ?? { version: 1, requestId: createUuid(), observedReady: false, ...input };
  saveCheckpoint(key, checkpoint);
  return { checkpoint, file, attempted: prior !== null };
}
function settle(payload: unknown, prepared: Prepared, key: string): MetrologyReferenceUploadResult {
  const checkpoint = prepared.checkpoint;
  const state = record(payload) ? payload.request : null;
  if (!record(state) || state.requestId !== checkpoint.requestId || state.templateId !== checkpoint.templateId
    || !timestamp(state.expiresAt)) {
    throw new MetrologyReferenceUploadError("The reference upload status could not be verified. Retry to check the same request.");
  }
  if (state.status === "ready") {
    let result: ReturnType<typeof validateMetrologyReferenceUploadResult>;
    try { result = validateMetrologyReferenceUploadResult(state.result); }
    catch { throw new MetrologyReferenceUploadError("The reference upload status could not be verified. Retry to check the same request."); }
    if (result.reference.byteSize !== checkpoint.byteSize) throw new MetrologyReferenceUploadError("The reference upload status could not be verified. Retry to check the same request.");
    checkpoint.observedReady = true;
    // Keep the receipt until the page has visibly refreshed. A failed refresh or
    // reload can then recover the publication without creating another reference.
    saveCheckpoint(key, checkpoint);
    return { requestId: checkpoint.requestId, reference: result.reference };
  }
  if (state.status === "pending") throw new MetrologyReferenceUploadError("The reference upload is still processing. Check its status again; the file will not be uploaded again.");
  if (["failed", "expired", "unavailable"].includes(String(state.status))) {
    prepared.terminal = state.status === "unavailable"
      ? "The uploaded reference is no longer available. Discard this upload before starting another."
      : "This reference upload did not complete. Discard it before starting another upload.";
    throw new MetrologyReferenceUploadError(prepared.terminal, true);
  }
  throw new MetrologyReferenceUploadError("The reference upload status could not be verified. Retry to check the same request.");
}
async function execute(prepared: Prepared, key: string): Promise<MetrologyReferenceUploadResult> {
  if (prepared.terminal) throw new MetrologyReferenceUploadError(prepared.terminal, true);
  const { checkpoint } = prepared;
  const current = readCheckpoint(key);
  if (current && current.requestId !== checkpoint.requestId) {
    throw new MetrologyReferenceUploadError("Another reference upload is unresolved. Reselect its original file before checking an earlier upload.");
  }
  saveCheckpoint(key, checkpoint);
  if (prepared.attempted) {
    let response: Response;
    try {
      response = await fetch(`/api/metrology-templates/${encodeURIComponent(checkpoint.templateId)}/reference-upload-requests/${encodeURIComponent(checkpoint.requestId)}`, { cache: "no-store" });
    } catch { throw new MetrologyReferenceUploadError("The reference upload status could not be checked. Retry to check the same request."); }
    if (response.status !== 404) {
      if (response.ok) return settle(await response.json().catch(() => null), prepared, key);
      throw new MetrologyReferenceUploadError("The reference upload status could not be checked. Retry to check the same request.");
    }
    if (checkpoint.observedReady) throw new MetrologyReferenceUploadError("The completed reference upload could not be found. Check the same request again; it will not be uploaded again.");
    // The first POST may still be reading its body. Retry only its exact UUID.
  }
  prepared.attempted = true;
  let response: Response;
  try {
    response = await fetch(`/api/metrology-templates/${encodeURIComponent(checkpoint.templateId)}/references`, {
      method: "POST", headers: { "content-type": checkpoint.mimeType, "X-Upload-Request-Id": checkpoint.requestId, "X-Filename-Uri": encodeURIComponent(checkpoint.filename) },
      body: prepared.file,
    });
  } catch { throw new MetrologyReferenceUploadError("The reference upload response was lost. Retry to check the same request."); }
  const payload: unknown = await response.json().catch(() => null);
  if (record(payload) && record(payload.request)
    && (payload.request.status === "ready" && [200, 201].includes(response.status)
      || payload.request.status === "pending" && response.status === 202
      || ["failed", "expired", "unavailable"].includes(String(payload.request.status)) && response.status === 409)) {
    return settle(payload, prepared, key);
  }
  throw new MetrologyReferenceUploadError(record(payload) && typeof payload.error === "string"
    ? `${payload.error} Retry to check the same reference upload request.`
    : "The reference upload response could not be verified. Retry to check the same request.");
}

/** Reloads retain metadata only; the original file must be selected to retry. */
export function savedMetrologyReferenceUploadFilename(templateId: string): string | null {
  return readCheckpoint(keyFor(templateId))?.filename ?? null;
}
/** Forget tracking only after the published reference is visible in the page. */
export function finishMetrologyReferenceUpload(templateId: string, requestId: string): void {
  const key = keyFor(templateId);
  try { if (readCheckpoint(key)?.requestId === requestId) sessionStorage.removeItem(key); } catch { /* A retained ready receipt remains safe to recheck. */ }
}
/** Discarding tracking does not cancel a reference publication already in flight. */
export function discardMetrologyReferenceUpload(templateId: string): void {
  const key = keyFor(templateId);
  if (active.has(key)) throw new MetrologyReferenceUploadError("Wait for the current reference upload check before discarding it.");
  try {
    sessionStorage.removeItem(key);
    if (sessionStorage.getItem(key) !== null) throw new Error();
  } catch { throw new MetrologyReferenceUploadError("This browser could not discard the reference upload. Restore session storage and try again."); }
  generations.set(key, (generations.get(key) ?? 0) + 1);
}
export async function uploadMetrologyReference(templateId: string, file: File): Promise<MetrologyReferenceUploadResult> {
  const key = keyFor(templateId);
  const previous = active.get(key);
  if (previous?.file === file) return previous.promise;
  const operation = (async () => {
    if (previous) { try { await previous.promise; } catch { /* Check this caller's own file against the retained request. */ } }
    let entries = operations.get(file);
    if (!entries) { entries = new Map(); operations.set(file, entries); }
    const operationKey = `${key}:${generations.get(key) ?? 0}`;
    let pending = entries.get(operationKey);
    if (!pending) {
      pending = prepare(templateId, file, key); entries.set(operationKey, pending);
      pending.catch(() => { if (entries?.get(operationKey) === pending) entries.delete(operationKey); });
    }
    return execute(await pending, key);
  })();
  const current = { file, promise: operation }; active.set(key, current);
  try { return await operation; } finally { if (active.get(key) === current) active.delete(key); }
}

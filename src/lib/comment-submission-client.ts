import type { CreateCommentSubmissionInput } from "../../shared/types";
import { canonicalCommentAcceptanceInput, validateCommentAcceptanceInput, validateCommentPublicationResult, MAX_COMMENT_ACCEPTANCE_INPUT_BYTES, type AcceptedCommentSubmissionInput, type CommentAcceptanceState } from "../../shared/contracts/comment-acceptance";

const PREFIX = "comment-acceptance-v1:";
const MAX_CHECKPOINT_BYTES = MAX_COMMENT_ACCEPTANCE_INPUT_BYTES + 4096;
interface Checkpoint { version: 1; sourceKey: string; input: AcceptedCommentSubmissionInput; inputSha256: string; attempted: boolean; observedReady: boolean; cancelling?: boolean; removing?: string[] }
const known = new Map<string, Checkpoint>();
const actions = new Map<string, Promise<unknown>>();
const discarded = new Set<string>();
function requireTracked(id: string) { if (discarded.has(id)) throw new CommentAcceptanceError("This local comment request was discarded. Submit a new comment to start another request."); }
export class CommentAcceptanceError extends Error {
  constructor(message: string) { super(message); this.name = "CommentAcceptanceError"; }
}
function requireDigest() {
  if (!globalThis.crypto?.subtle) throw new CommentAcceptanceError("Comment submission requires a secure HTTPS connection with browser cryptography available.");
}
const fileHashes = new WeakMap<File, Promise<string>>();
export function commentFileSha256(file: File): Promise<string> {
  const existing = fileHashes.get(file); if (existing) return existing;
  const result = (async () => {
    requireDigest();
    if (file.size < 1 || file.size > 100 * 1024 * 1024) throw new CommentAcceptanceError("Comment files must contain data and be no larger than 100 MB.");
    const bytes = typeof file.arrayBuffer === "function" ? await file.arrayBuffer() : await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader(); reader.onerror = () => reject(new Error("The selected comment file could not be read."));
      reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error("The selected comment file could not be read."));
      reader.readAsArrayBuffer(file);
    });
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  })();
  fileHashes.set(file, result); void result.catch(() => { if (fileHashes.get(file) === result) fileHashes.delete(file); });
  return result;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function read(id: string): Checkpoint | null {
  try {
    const raw = sessionStorage.getItem(`${PREFIX}${id}`);
    if (!raw) return known.get(id) ?? null;
    if (new TextEncoder().encode(raw).byteLength > MAX_CHECKPOINT_BYTES) throw new Error();
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 1 || typeof value.sourceKey !== "string" || value.sourceKey.length > 2048 || typeof value.attempted !== "boolean" || typeof value.observedReady !== "boolean"
      || typeof value.inputSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.inputSha256)) throw new Error();
    const input = validateCommentAcceptanceInput(value.input);
    if (input.id !== id) throw new Error();
    if (value.cancelling !== undefined && typeof value.cancelling !== "boolean" || value.removing !== undefined && (!Array.isArray(value.removing) || value.removing.length > 24 || value.removing.some((id) => typeof id !== "string" || !input.items.some((item) => item.id === id)))) throw new Error();
    return { version: 1, sourceKey: value.sourceKey, input, inputSha256: value.inputSha256, attempted: value.attempted, observedReady: value.observedReady,
      cancelling: value.cancelling as boolean | undefined, removing: value.removing as string[] | undefined };
  } catch { throw new CommentAcceptanceError("The saved comment request could not be read. Restore browser session storage before retrying."); }
}
function save(checkpoint: Checkpoint) {
  if (discarded.has(checkpoint.input.id)) { known.set(checkpoint.input.id, checkpoint); return; }
  try {
    const raw = JSON.stringify(checkpoint);
    if (new TextEncoder().encode(raw).byteLength > MAX_CHECKPOINT_BYTES) throw new Error();
    sessionStorage.setItem(`${PREFIX}${checkpoint.input.id}`, raw);
    if (sessionStorage.getItem(`${PREFIX}${checkpoint.input.id}`) !== raw) throw new Error();
    known.set(checkpoint.input.id, checkpoint);
  } catch { throw new CommentAcceptanceError("The comment request could not be saved in this browser. Restore session storage before submitting."); }
}
export function savedCommentSubmissions(sourceKey?: string): AcceptedCommentSubmissionInput[] {
  const result: AcceptedCommentSubmissionInput[] = [];
  try {
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(PREFIX)) { const checkpoint = read(key.slice(PREFIX.length)); if (checkpoint && (sourceKey === undefined || checkpoint.sourceKey === sourceKey)) result.push(checkpoint.input); }
    }
  } catch { throw new CommentAcceptanceError("The saved comment requests could not be read. Restore browser session storage before retrying."); }
  return result;
}
export function commentComposerSource(context: CreateCommentSubmissionInput["context"]): string {
  return context.kind === "sample" ? `sample:${context.sampleId}` : `${context.scope}:${context.targets.map((target) => `${target.sampleId}/${target.runId}/${target.stepId}`).sort().join(",")}`;
}
export async function prepareDurableCommentSubmission(value: AcceptedCommentSubmissionInput, sourceKey = commentComposerSource(value.context)) {
  requireDigest();
  const canonical = await canonicalCommentAcceptanceInput(JSON.parse(JSON.stringify(value)));
  const prior = read(canonical.input.id);
  if (prior && prior.inputSha256 !== canonical.sha256) throw new CommentAcceptanceError("The accepted comment cannot be changed. Start a new comment for different content.");
  if (!sourceKey || sourceKey.length > 2048) throw new CommentAcceptanceError("The comment editing context is invalid.");
  const checkpoint: Checkpoint = prior ?? { version: 1, sourceKey, input: canonical.input, inputSha256: canonical.sha256, attempted: false, observedReady: false };
  save(checkpoint); return canonical.input;
}
export function commentCancellationPending(id: string): boolean { return read(id)?.cancelling === true; }
/** Clear local tracking without claiming the server execution was cancelled. */
export function discardLocalCommentSubmission(id: string): void {
  const checkpoint = read(id);
  if (!checkpoint?.cancelling) throw new CommentAcceptanceError("Try cancelling this comment before discarding local tracking.");
  try {
    sessionStorage.removeItem(`${PREFIX}${id}`);
    if (sessionStorage.getItem(`${PREFIX}${id}`) !== null) throw new Error();
  } catch { throw new CommentAcceptanceError("The local comment request could not be discarded. Restore browser session storage and try again."); }
  known.set(id, checkpoint); discarded.add(id);
}
export function finishCommentSubmission(id: string): void {
  try { sessionStorage.removeItem(`${PREFIX}${id}`); } catch { /* Keeping settled tracking is safe. */ }
}
function oneAction<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = actions.get(key); if (previous) return previous as Promise<T>;
  const promise = action(); actions.set(key, promise);
  void promise.finally(() => { if (actions.get(key) === promise) actions.delete(key); }).catch(() => undefined);
  return promise;
}
function stateError(state: CommentAcceptanceState): never {
  if (state.status === "legacy") throw new CommentAcceptanceError("This older unfinished comment cannot resume uploading. Cancel it and submit a new comment.");
  if (state.status === "cancelled") throw new CommentAcceptanceError("This comment was cancelled. Refresh the page before submitting a new comment.");
  if (state.status === "expired") throw new CommentAcceptanceError("This comment upload expired. Cancel it before submitting a new comment.");
  throw new CommentAcceptanceError("This comment is no longer available. Check its status before submitting a new comment.");
}
async function verifyState(value: unknown, id: string): Promise<CommentAcceptanceState> {
  const state = record(value) ? value.request : null;
  if (!record(state) || state.submissionId !== id || !["pending", "ready", "cancelled", "expired", "unavailable", "legacy"].includes(String(state.status)) || !Array.isArray(state.items)) {
    throw new CommentAcceptanceError("The comment request status could not be verified. Check the same request again.");
  }
  if (state.status === "legacy" || state.status === "cancelled" && state.input === null) {
    if (state.input !== null || state.inputSha256 !== null || state.expiresAt !== null || state.items.length !== 0) throw new CommentAcceptanceError("The comment request status could not be verified.");
    return state as unknown as CommentAcceptanceState;
  }
  let canonical: Awaited<ReturnType<typeof canonicalCommentAcceptanceInput>>;
  try { canonical = await canonicalCommentAcceptanceInput(state.input); }
  catch { throw new CommentAcceptanceError("The comment request status could not be verified. Check the same request again."); }
  if (canonical.input.id !== id || canonical.sha256 !== state.inputSha256 || typeof state.expiresAt !== "string" || !Number.isFinite(Date.parse(state.expiresAt))) {
    throw new CommentAcceptanceError("The comment request status could not be verified. Check the same request again.");
  }
  const checkpoint = read(id);
  if (checkpoint && checkpoint.inputSha256 !== canonical.sha256) throw new CommentAcceptanceError("The saved comment does not match this request. The accepted comment cannot be changed.");
  const seen = new Set<string>();
  for (const item of state.items) {
    if (!record(item) || typeof item.id !== "string" || seen.has(item.id) || !["pending", "uploading", "ready", "cancelled", "unavailable"].includes(String(item.status))) throw new CommentAcceptanceError("The comment item status could not be verified.");
    seen.add(item.id);
    const input = canonical.input.items.find((candidate) => candidate.id === item.id);
    if (!input || input.kind !== item.kind || item.sha256 !== (input.kind === "link" ? null : input.sha256)) throw new CommentAcceptanceError("The comment item status could not be verified.");
  }
  if (seen.size !== canonical.input.items.length) throw new CommentAcceptanceError("The comment item status could not be verified.");
  if (checkpoint?.observedReady && state.status === "pending") throw new CommentAcceptanceError("This comment was already published. Its status must be confirmed before any further action.");
  if (checkpoint?.removing?.length) {
    const items = state.items;
    checkpoint.removing = checkpoint.removing.filter((id) => !items.some((item) => record(item) && item.id === id && item.status === "cancelled"));
    save(checkpoint);
  }
  if (state.status === "ready") {
    let result: ReturnType<typeof validateCommentPublicationResult>;
    try { result = validateCommentPublicationResult(state.result); }
    catch { throw new CommentAcceptanceError("The published comment result could not be verified."); }
    if (result.submissionId !== id || result.itemIds.some((itemId) => !seen.has(itemId))) throw new CommentAcceptanceError("The published comment result could not be verified.");
    if (checkpoint) { checkpoint.observedReady = true; save(checkpoint); }
  }
  return state as unknown as CommentAcceptanceState;
}
export async function getCommentAcceptance(id: string): Promise<CommentAcceptanceState | null> {
  let response: Response;
  try { response = await fetch(`/api/comment-submissions/${encodeURIComponent(id)}/acceptance`, { cache: "no-store" }); }
  catch { throw new CommentAcceptanceError("The comment status could not be checked. Retry to check the same request."); }
  if (response.status === 404) return null;
  if (!response.ok) throw new CommentAcceptanceError("The comment status could not be checked. Retry to check the same request.");
  return verifyState(await response.json().catch(() => null), id);
}
async function mutation(path: string, id: string, init: RequestInit): Promise<CommentAcceptanceState> {
  requireTracked(id);
  let response: Response;
  try { response = await fetch(`/api/comment-submissions${path}`, init); }
  catch { throw new CommentAcceptanceError("The comment response was lost. Retry to check the same request."); }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new CommentAcceptanceError(record(payload) && typeof payload.error === "string" ? payload.error : "The comment operation did not complete. Retry to check its status.");
  const state = await verifyState(payload, id);
  requireTracked(id); return state;
}
export async function createDurableCommentSubmission(value: AcceptedCommentSubmissionInput): Promise<{ id: string; deduplicated: boolean }> {
  requireTracked(value.id); requireDigest();
  const canonical = await canonicalCommentAcceptanceInput(JSON.parse(JSON.stringify(value)));
  requireTracked(value.id);
  return oneAction(`create:${value.id}:${canonical.sha256}`, async () => {
    const prior = read(canonical.input.id);
    if (prior && prior.inputSha256 !== canonical.sha256) throw new CommentAcceptanceError("The accepted comment cannot be changed. Start a new comment for different content.");
    const checkpoint: Checkpoint = prior ?? { version: 1, sourceKey: commentComposerSource(canonical.input.context), input: canonical.input, inputSha256: canonical.sha256, attempted: false, observedReady: false };
    save(checkpoint);
    if (checkpoint.cancelling) {
      const state = await getCommentAcceptance(value.id);
      if (state?.status === "ready") return { id: value.id, deduplicated: true };
      throw new CommentAcceptanceError("Cancellation is unresolved. Use Cancel again to check the same request before uploading more files.");
    }
    if (checkpoint.attempted) {
      const state = await getCommentAcceptance(value.id);
      if (state) {
        if (state.status === "pending" || state.status === "ready") return { id: value.id, deduplicated: true };
        stateError(state);
      }
      if (checkpoint.observedReady) throw new CommentAcceptanceError("The completed comment could not be found. It will not be submitted again.");
    }
    checkpoint.attempted = true; save(checkpoint);
    const state = await mutation("", value.id, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(checkpoint.input) });
    if (state.status !== "pending" && state.status !== "ready") stateError(state);
    return { id: value.id, deduplicated: false };
  });
}
async function requireState(id: string) {
  requireTracked(id);
  const state = await getCommentAcceptance(id);
  requireTracked(id);
  if (!state) throw new CommentAcceptanceError("The comment request could not be found. Retry the original comment before uploading files.");
  return state;
}
export async function uploadDurableCommentItem(id: string, itemId: string, file: File, sha256: string | null, onProgress: (progress: number) => void, signal?: AbortSignal): Promise<{ ok: true; deduplicated: boolean }> {
  requireTracked(id);
  if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
  const actualSha256 = await commentFileSha256(file);
  if (actualSha256 !== sha256) throw new CommentAcceptanceError("Select the same unchanged file used for this comment. Its bytes and metadata must match the accepted request.");
  return oneAction(`item:${id}:${itemId}:${JSON.stringify([actualSha256, file.name, file.type, file.size])}`, async () => {
    if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
    const state = await requireState(id);
    const checkpoint = read(id);
    if (checkpoint?.cancelling || checkpoint?.removing?.includes(itemId)) throw new CommentAcceptanceError("Removal or cancellation is unresolved. Check that action again before uploading this file.");
    if (state.status !== "pending" && state.status !== "ready") stateError(state);
    const input = state.input?.items.find((item) => item.id === itemId);
    const item = state.items.find((item) => item.id === itemId);
    if (!input || input.kind === "link" || !item || typeof input.sha256 !== "string" || input.sha256 !== sha256 || input.byteSize !== file.size || input.filename !== file.name || input.mimeType !== (file.type || "application/octet-stream")) {
      throw new CommentAcceptanceError("Select the same unchanged file used for this comment. Its bytes and metadata must match the accepted request.");
    }
    if (item.status === "ready") { onProgress(100); return { ok: true, deduplicated: true }; }
    if (state.status === "ready" || item.status !== "pending") throw new CommentAcceptanceError(item.status === "uploading"
      ? "This file upload is still processing. Retry checks its status without uploading the file again."
      : "This file cannot be uploaded again. Remove it or cancel the comment before starting another request.");
    if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
    const payload = await new Promise<unknown>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      const clean = () => signal?.removeEventListener("abort", abort);
      xhr.open("PUT", `/api/comment-submissions/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/content`);
      xhr.setRequestHeader("content-type", input.mimeType); xhr.setRequestHeader("x-upload-size", String(file.size)); xhr.setRequestHeader("x-content-sha256", sha256!);
      xhr.upload.addEventListener("progress", (event) => { if (event.lengthComputable) onProgress(Math.max(0, Math.min(100, Math.round(event.loaded / event.total * 100)))); });
      xhr.addEventListener("load", () => {
        clean(); let value: unknown; try { value = JSON.parse(xhr.responseText); } catch { reject(new CommentAcceptanceError("The upload response could not be verified. Retry to check its status.")); return; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(value);
        else reject(new CommentAcceptanceError(record(value) && typeof value.error === "string" ? value.error : "The upload did not complete. Retry to check its status."));
      });
      xhr.addEventListener("error", () => { clean(); reject(new CommentAcceptanceError("The upload response was lost. Retry to check its status.")); });
      xhr.addEventListener("abort", () => { clean(); reject(new DOMException("Upload cancelled", "AbortError")); });
      signal?.addEventListener("abort", abort, { once: true });
      xhr.send(file); onProgress(0);
    });
    const latest = await verifyState(payload, id);
    requireTracked(id);
    if (latest.items.find((item) => item.id === itemId)?.status !== "ready") throw new CommentAcceptanceError("This file upload is still processing. Retry checks its status without uploading the file again.");
    onProgress(100); return { ok: true, deduplicated: false };
  });
}
export function finalizeDurableCommentSubmission(id: string): Promise<{ ok: true; status: "ready" }> {
  return oneAction(`finalize:${id}`, async () => {
    const state = await requireState(id);
    if (state.status === "ready") return { ok: true, status: "ready" };
    const checkpoint = read(id);
    if (checkpoint?.cancelling || checkpoint?.removing?.length) throw new CommentAcceptanceError("Removal or cancellation is unresolved. Check that action again before finishing this comment.");
    if (state.status !== "pending") stateError(state);
    if (state.items.some((item) => item.status !== "ready" && item.status !== "cancelled")) throw new CommentAcceptanceError("Some comment files are incomplete. Retry their status, remove them, or cancel this comment.");
    const result = await mutation(`/${encodeURIComponent(id)}/finalize`, id, { method: "POST" });
    if (result.status !== "ready") stateError(result);
    return { ok: true, status: "ready" };
  });
}
export function removeDurableCommentItem(id: string, itemId: string): Promise<{ ok: true }> {
  requireTracked(id);
  return oneAction(`remove:${id}:${itemId}`, async () => {
    const checkpoint = read(id);
    if (checkpoint) {
      if (checkpoint.cancelling) throw new CommentAcceptanceError("Cancellation is unresolved. Use Cancel again to check the same request.");
      checkpoint.removing = [...new Set([...(checkpoint.removing ?? []), itemId])]; save(checkpoint);
    }
    const state = await requireState(id);
    if (read(id)?.cancelling) throw new CommentAcceptanceError("Cancellation is unresolved. Use Cancel again to check the same request.");
    if (state.status !== "pending") stateError(state);
    if (state.items.find((item) => item.id === itemId)?.status === "cancelled") return { ok: true };
    await mutation(`/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`, id, { method: "DELETE" });
    return { ok: true };
  });
}
export function cancelDurableCommentSubmission(id: string): Promise<{ ok: true }> {
  requireTracked(id);
  return oneAction(`cancel:${id}`, async () => {
    const checkpoint = read(id);
    if (checkpoint) { checkpoint.cancelling = true; save(checkpoint); }
    let state = await getCommentAcceptance(id);
    if (!state) {
      if (!checkpoint) throw new CommentAcceptanceError("The comment could not be found. Refresh its status before cancelling.");
      if (checkpoint.observedReady) throw new CommentAcceptanceError("The completed comment could not be found. It will not be submitted again.");
      const canonical = await canonicalCommentAcceptanceInput(checkpoint.input);
      if (canonical.sha256 !== checkpoint.inputSha256) throw new CommentAcceptanceError("The saved comment request could not be verified.");
      checkpoint.attempted = true; save(checkpoint);
      state = await mutation("", id, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(checkpoint.input) });
    }
    if (state.status === "cancelled") return { ok: true };
    if (state.status === "ready") throw new CommentAcceptanceError("This comment has already been published. Refresh the page to view it.");
    await mutation(`/${encodeURIComponent(id)}/cancel`, id, { method: "POST" });
    return { ok: true };
  });
}

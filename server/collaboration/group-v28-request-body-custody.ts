import type { ReadableStreamReadResult } from "node:stream/web";
import { HTTPException } from "hono/http-exception";
import { assertRetainedFabubloxMultipartBodyOwner, type createRetainedFabubloxMultipartBody } from "../imports/retained-fabublox-multipart-body";
type MultipartBody=ReturnType<typeof createRetainedFabubloxMultipartBody>;

interface ReaderOwner {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly originalRead: () => Promise<ReadableStreamReadResult<Uint8Array>>;
  readonly originalCancel: () => Promise<void>;
  readonly originalRelease: () => void;
  readonly originalClosed: Promise<void>;
  readonly reads: Promise<ReadableStreamReadResult<Uint8Array>>[];
  cancellation?: Promise<void>;
  releaseAttempted: boolean;
  releaseFailed: boolean;
  releaseFailure?: unknown;
}
interface BodyOwner {
  readonly readers: Map<ReadableStreamDefaultReader<Uint8Array>, ReaderOwner>;
  readonly multipart:Set<MultipartBody>;
  unreadCancellation?:Promise<void>;
  closing?: Promise<void>;
}
const requests = new WeakMap<Request, BodyOwner>();
const retainedFailures = new Set<BodyOwner>();
const unavailable = () => new Error("Original Group request-body acknowledgement is unavailable");

/** Bind the exact native ingress Request before any authentication or parser.
 * The application parent retains this closure even after the route returns a
 * typed error. There is no second read, body clone or retry of a failed cancel. */
export function createGroupV28RequestBodyCustody(request: Request) {
  if (requests.has(request)) throw unavailable();
  const owner: BodyOwner = { readers: new Map(), multipart:new Set() };
  requests.set(request, owner);
  return Object.freeze({
    close(): Promise<void> {
      if (owner.closing) return owner.closing;
      owner.closing = Promise.resolve().then(async () => {
        try {
          // A genuine multipart facade owns its original parser/reader and
          // reserves its first close. Join that exact ACK before any parent.
          for(const body of owner.multipart)await body.close();
          if(request.method==="POST" && new URL(request.url).pathname==="/api/imports/fabublox"
            && !owner.multipart.size && !owner.readers.size && request.body){
            if(request.bodyUsed || request.body.locked)throw unavailable();
            // The application cached close is visible before this first call;
            // synchronous abort reentry cannot dispatch another cancellation.
            owner.unreadCancellation=Promise.resolve().then(()=>request.body!.cancel());
            void owner.unreadCancellation.catch(()=>undefined);
            await owner.unreadCancellation;
          }
          // The caller already awaited the complete original route promise.
          // An absent first-cancel outcome is unknown, never absent-body success.
          for (const reader of owner.readers.values()) {
            for (const read of reader.reads) await read;
            if (!reader.cancellation) throw unavailable();
            await reader.cancellation;
            await reader.originalClosed;
            if (!reader.releaseAttempted) throw unavailable();
            if (reader.releaseFailed) throw reader.releaseFailure;
          }
        } catch (error) { retainedFailures.add(owner); throw error; }
      });
      void owner.closing.catch(() => undefined);
      return owner.closing;
    },
  });
}

/** Mandatory adoption of this same Request's issued multipart owner. This
 * changes no body method and grants no SQL, File or provider authority. */
export function registerGroupV28MultipartBody(request:Request,body:MultipartBody):void {
  const owner=requests.get(request);
  if(!owner || owner.closing || owner.readers.size || owner.multipart.size)throw unavailable();
  assertRetainedFabubloxMultipartBodyOwner(request,body);
  owner.multipart.add(body);
}

/** Register the original reader and its methods BEFORE the first native read. */
export function registerGroupV28BodyReader(request: Request, reader: ReadableStreamDefaultReader<Uint8Array>): void {
  const owner = requests.get(request);
  if (!owner || owner.closing || owner.multipart.size || owner.readers.has(reader)) throw unavailable();
  const originalClosed = reader.closed;
  void originalClosed.catch(() => undefined);
  owner.readers.set(reader, {
    reader, originalRead: reader.read.bind(reader), originalCancel: reader.cancel.bind(reader),
    originalRelease: reader.releaseLock.bind(reader), originalClosed, reads: [], releaseAttempted: false, releaseFailed: false,
  });
}
function selected(request: Request, reader: ReadableStreamDefaultReader<Uint8Array>) {
  const owner = requests.get(request), entry = owner?.readers.get(reader);
  if (!owner || !entry || owner.closing) throw unavailable();
  return entry;
}
export function readGroupV28OriginalBody(request: Request, reader: ReadableStreamDefaultReader<Uint8Array>) {
  const owner = selected(request, reader);
  let original: Promise<ReadableStreamReadResult<Uint8Array>>;
  try { original = owner.originalRead(); }
  catch (error) { original = Promise.reject(error); }
  owner.reads.push(original);
  void original.catch(() => undefined);
  return original;
}
export function cancelGroupV28OriginalBody(request: Request, reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  const owner = selected(request, reader);
  if (owner.cancellation) return owner.cancellation;
  // Cache even a synchronous throw as its single attempted original outcome.
  try { owner.cancellation = owner.originalCancel(); }
  catch (error) { owner.cancellation = Promise.reject(error); }
  void owner.cancellation.catch(() => undefined);
  return owner.cancellation;
}
export function releaseGroupV28OriginalBody(request: Request, reader: ReadableStreamDefaultReader<Uint8Array>): void {
  const owner = selected(request, reader);
  if (owner.releaseAttempted) {
    if (owner.releaseFailed) throw owner.releaseFailure;
    return;
  }
  owner.releaseAttempted = true;
  try { owner.originalRelease(); }
  catch (error) { owner.releaseFailed = true; owner.releaseFailure = error; throw error; }
}

/** Keep ordered original work/cancel/release errors, including falsy throws. */
export async function readGroupV28Json(request: Request, maxBytes: number): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 3_000_000) throw unavailable();
  const reader = request.body?.getReader();
  if (!reader) return null;
  registerGroupV28BodyReader(request, reader);
  const bytes = new Uint8Array(maxBytes);
  let used = 0, failed = false, failure: unknown, value: unknown;
  try {
    while (true) {
      const part = await readGroupV28OriginalBody(request, reader);
      if (part.done) break;
      if (part.value.byteLength > bytes.byteLength - used)
        throw new HTTPException(413, { message: "Request body exceeds the supported limit." });
      bytes.set(part.value, used); used += part.value.byteLength;
    }
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used))); }
    catch { value = null; } // The original owner decides invalid DTO admission.
  } catch (error) { failed = true; failure = error; }
  bytes.fill(0);
  const cleanup: unknown[] = [];
  try { await cancelGroupV28OriginalBody(request, reader); } catch (error) { cleanup.push(error); }
  try { releaseGroupV28OriginalBody(request, reader); } catch (error) { cleanup.push(error); }
  if (failed) {
    if (cleanup.length) throw new AggregateError([failure, ...cleanup], "Group input and original body cleanup failed");
    throw failure;
  }
  if (cleanup.length === 1) throw cleanup[0];
  if (cleanup.length) throw new AggregateError(cleanup, "Group original body cleanup failed");
  return value;
}

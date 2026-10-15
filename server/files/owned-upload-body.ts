import { HTTPException } from "hono/http-exception";
import { MAX_R2_UPLOAD_BYTES } from "../../shared/contracts/r2-upload";
import { StorageProfileCleanupError } from "../../worker/files/storage-profile-opening";

/** Read the original admitted HTTP body. The caller owns this entire original
 * promise inside its execution; selected body/read/cancel failures never become
 * a detached cleanup or permission to retry an uncertain cancellation. */
export async function readOwnedUploadBody(request: Request): Promise<ArrayBuffer> {
  const body = request.body;
  if (!body) return new ArrayBuffer(0);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancellation: Promise<void> | undefined;
  let cause: unknown, failed = false, finished = false;
  const cancel = () => {
    if (!cancellation) {
      try { cancellation = reader ? reader.cancel(cause) : body.cancel(cause); }
      catch (error) { cancellation = Promise.reject(error); }
      cancellation.then(() => undefined, () => undefined);
    }
    return cancellation;
  };
  const bytes = new Uint8Array(MAX_R2_UPLOAD_BYTES);
  let length = 0;
  try {
    reader = body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) { finished = true; break; }
      if (!(next.value instanceof Uint8Array)) throw new HTTPException(400, { message: "The upload body is invalid." });
      if (next.value.byteLength > MAX_R2_UPLOAD_BYTES - length)
        throw new HTTPException(413, { message: "Asset uploads are limited to 10 MB" });
      bytes.set(next.value, length); length += next.value.byteLength;
    }
  } catch (error) { failed = true; cause = error; }
  const cleanup: unknown[] = [];
  if (!finished) { try { await cancel(); } catch (error) { cleanup.push(error); } }
  try { reader?.releaseLock(); } catch (error) { cleanup.push(error); }
  if (cleanup.length) {
    let failedCleanup!: Promise<void>;
    const failure = new StorageProfileCleanupError(cause,
      new AggregateError(cleanup, "Original upload body cleanup failed"), {
        owner: Object.freeze({ request, body, reader, cancellation }),
        // Retain the rejected original cleanup, including failed releaseLock;
        // a resolved cancellation never claims the remaining close succeeded.
        dispose: () => failedCleanup,
      });
    failedCleanup = Promise.reject(failure);
    failedCleanup.then(() => undefined, () => undefined);
    throw failure;
  }
  if (failed) throw cause;
  return bytes.slice(0, length).buffer;
}

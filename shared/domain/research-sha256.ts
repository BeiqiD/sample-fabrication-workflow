export const RESEARCH_HASH_CHUNK_BYTES = 64 * 1024;
export const DEFAULT_RESEARCH_HASH_MAX_BYTES = 100 * 1024 * 1024;

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export interface ResearchSha256 {
  update(bytes: Uint8Array): void;
  digestHex(): string;
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** FIPS 180-4 SHA-256 with a single 64-byte tail and a reusable message schedule.
 * Full blocks are read from the caller's view; neither chunks nor the complete
 * object are retained. The first digest finalizes the sink, and later digest
 * reads return the same value. Further updates are rejected.
 */
export function createResearchSha256(): ResearchSha256 {
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const tail = new Uint8Array(64), words = new Uint32Array(64);
  let tailBytes = 0, byteSize = 0, digest: string | undefined;

  function compress(bytes: Uint8Array, offset: number) {
    for (let index = 0; index < 16; index += 1) {
      const position = offset + index * 4;
      words[index] = (bytes[position] << 24) | (bytes[position + 1] << 16)
        | (bytes[position + 2] << 8) | bytes[position + 3];
    }
    for (let index = 16; index < 64; index += 1) {
      const previous = words[index - 15], recent = words[index - 2];
      const sigma0 = rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3);
      const sigma1 = rotateRight(recent, 17) ^ rotateRight(recent, 19) ^ (recent >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const first = (h + sigma1 + choose + ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (sigma0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + first) >>> 0;
      d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0;
  }

  function consume(bytes: Uint8Array) {
    let offset = 0;
    if (tailBytes) {
      const length = Math.min(64 - tailBytes, bytes.byteLength);
      tail.set(bytes.subarray(0, length), tailBytes);
      tailBytes += length; offset += length;
      if (tailBytes === 64) { compress(tail, 0); tailBytes = 0; }
    }
    while (offset + 64 <= bytes.byteLength) { compress(bytes, offset); offset += 64; }
    if (offset < bytes.byteLength) {
      tail.set(bytes.subarray(offset), tailBytes);
      tailBytes += bytes.byteLength - offset;
    }
  }

  return {
    update(bytes) {
      if (digest !== undefined) throw new Error("Research SHA-256 is already finalized.");
      if (!(bytes instanceof Uint8Array)) throw new TypeError("Research hashing requires byte chunks.");
      if (bytes.byteLength > Number.MAX_SAFE_INTEGER - byteSize) throw new RangeError("Research SHA-256 input is too large.");
      byteSize += bytes.byteLength;
      for (let offset = 0; offset < bytes.byteLength; offset += RESEARCH_HASH_CHUNK_BYTES) {
        consume(bytes.subarray(offset, offset + RESEARCH_HASH_CHUNK_BYTES));
      }
    },
    digestHex() {
      if (digest !== undefined) return digest;
      tail[tailBytes++] = 0x80;
      if (tailBytes > 56) { tail.fill(0, tailBytes); compress(tail, 0); tail.fill(0); }
      else tail.fill(0, tailBytes);
      // SHA-256's length field is a big-endian 64-bit bit count. The byte count
      // stays a safe integer; multiplying its low word retains exact multiples
      // of eight even above the safe-integer bit-count boundary.
      const high = Math.floor(byteSize / 0x20000000), low = (byteSize * 8) >>> 0;
      for (let index = 0; index < 4; index += 1) {
        tail[56 + index] = high >>> (24 - index * 8);
        tail[60 + index] = low >>> (24 - index * 8);
      }
      compress(tail, 0);
      digest = Array.from(state, value => value.toString(16).padStart(8, "0")).join("");
      return digest;
    },
  };
}

export interface ResearchStreamHashOptions {
  maxBytes: number;
  expectedByteSize?: number;
  signal?: AbortSignal;
}
export interface ResearchByteHash { byteSize: number; sha256: string }

function checkedLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("Invalid research byte limit.");
}
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** Consume exactly once with bounded hash writes and no tee or complete-buffer
 * copy. Failure requests upstream cancellation before releasing its reader.
 * An abort also closes a pending read; a provider's slow cancellation promise
 * cannot keep this hashing operation or its reader lock alive.
 */
export async function hashResearchStream(
  stream: ReadableStream<Uint8Array>, options: ResearchStreamHashOptions,
): Promise<ResearchByteHash> {
  const reader = stream.getReader(), hash = createResearchSha256();
  const { signal } = options;
  let byteSize = 0, cancellationRequested = false;
  const cancel = (reason: unknown) => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    void reader.cancel(reason).catch(() => undefined);
  };
  const onAbort = () => { if (signal) cancel(abortReason(signal)); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    checkedLimit(options.maxBytes);
    if (options.expectedByteSize !== undefined && (!Number.isSafeInteger(options.expectedByteSize)
      || options.expectedByteSize < 0 || options.expectedByteSize > options.maxBytes)) {
      throw new RangeError("Invalid expected research byte size.");
    }
    throwIfAborted(signal);
    while (true) {
      const next = await reader.read();
      throwIfAborted(signal);
      if (next.done) break;
      const bytes = next.value;
      if (!(bytes instanceof Uint8Array)) throw new TypeError("Research hashing requires byte chunks.");
      if (bytes.byteLength > options.maxBytes - byteSize) throw new RangeError("Research file exceeds its byte limit.");
      if (options.expectedByteSize !== undefined && bytes.byteLength > options.expectedByteSize - byteSize) {
        throw new Error("Research bytes do not match the expected size.");
      }
      byteSize += bytes.byteLength;
      for (let offset = 0; offset < bytes.byteLength; offset += RESEARCH_HASH_CHUNK_BYTES) {
        throwIfAborted(signal);
        hash.update(bytes.subarray(offset, offset + RESEARCH_HASH_CHUNK_BYTES));
      }
    }
    if (options.expectedByteSize !== undefined && byteSize !== options.expectedByteSize) {
      throw new Error("Research bytes do not match the expected size.");
    }
    return { byteSize, sha256: hash.digestHex() };
  } catch (error) {
    cancel(error);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** Blob/File uploads are streamed and checked against their declared size. */
export async function hashResearchFile(
  file: Blob | File, options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<ResearchByteHash> {
  const maxBytes = options.maxBytes ?? DEFAULT_RESEARCH_HASH_MAX_BYTES;
  checkedLimit(maxBytes);
  throwIfAborted(options.signal);
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxBytes) {
    throw new RangeError("Research file exceeds its byte limit.");
  }
  return hashResearchStream(file.stream(), { maxBytes, expectedByteSize: file.size, signal: options.signal });
}

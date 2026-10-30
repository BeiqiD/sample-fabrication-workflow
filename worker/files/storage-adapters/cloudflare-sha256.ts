import type { Sha256Factory } from "../byte-verification";

// Runtime-only implementation. Neutral services receive a hash capability;
// host tests use Node's incremental hash, while real Worker tests use this sink.
export const cloudflareSha256: Sha256Factory = () => {
  // The shared browser compilation also sees this runtime adapter. Declare
  // only the Worker extension here, without augmenting browser Crypto globally.
  const { DigestStream } = crypto as Crypto & {
    DigestStream: new (algorithm: "SHA-256") => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };
  };
  const stream = new DigestStream("SHA-256");
  const writer = stream.getWriter();
  const digest = stream.digest.then(value => [...new Uint8Array(value)]
    .map(byte => byte.toString(16).padStart(2, "0")).join(""));
  void digest.catch(() => undefined);
  let released = false;
  const release = () => { if (!released) { writer.releaseLock(); released = true; } };
  return {
    async write(bytes) { await writer.write(bytes); },
    async finish() {
      try { await writer.close(); return await digest; }
      finally { release(); }
    },
    async abort() {
      if (released) return;
      try { await writer.abort().catch(() => undefined); }
      finally { release(); }
    },
  };
};

import { createHash } from "node:crypto";

// Host-only parity capability. Real workerd tests use the native extension;
// production services have no whole-buffer fallback or Node dependency.
export function installWorkerCryptoForHostTests() {
  const previous = Object.getOwnPropertyDescriptor(crypto, "DigestStream");
  class HostDigestStream extends WritableStream {
    constructor(algorithm) {
      if (algorithm !== "SHA-256") throw new Error("Unsupported test digest");
      const hash = createHash("sha256");
      let resolve, reject;
      const digest = new Promise((yes, no) => { resolve = yes; reject = no; });
      super({
        write(bytes) { hash.update(bytes); },
        close() { resolve(Uint8Array.from(hash.digest()).buffer); },
        abort(reason) { reject(reason); },
      });
      this.digest = digest;
    }
  }
  Object.defineProperty(crypto, "DigestStream", { configurable: true, value: HostDigestStream });
  return () => {
    if (previous) Object.defineProperty(crypto, "DigestStream", previous);
    else delete crypto.DigestStream;
  };
}

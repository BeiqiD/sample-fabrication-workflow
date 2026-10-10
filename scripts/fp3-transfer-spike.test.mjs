import assert from "node:assert/strict";
import test from "node:test";
import { runTransferSpike } from "./fp3-transfer-spike.mjs";

test("bounded transfer independently hashes destination and rebuilds interrupted output under a new key", async () => {
  const result = await runTransferSpike({ bytes: 1024 * 1024 });
  assert.equal(result.sourceChunks, 16);
  assert.equal(result.maxSourceChunk, 65536);
  assert.equal(result.independentlyVerified, true);
  assert.equal(result.corruptionRejected, true);
  assert.equal(result.earlyAckRejected, true);
  assert.equal(result.rebuiltWithNewKey, true);
});

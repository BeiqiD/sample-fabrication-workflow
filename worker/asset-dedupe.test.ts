import { describe, expect, it } from "vitest";
import { resolveAssetReferences } from "./asset-dedupe";

describe("asset hash deduplication", () => {
  it("reuses a ready asset already stored under the same hash", () => {
    const result = resolveAssetReferences(
      [{ name: "copy.png", sha256: "hash-a" }],
      new Map([["hash-a", { assetId: "existing", key: "existing.png" }]]),
      () => ({ assetId: "new", key: "new.png" }),
    );
    expect(result[0]).toMatchObject({ assetId: "existing", key: "existing.png", isNew: false });
  });

  it("stores duplicate candidates in one request only once", () => {
    let created = 0;
    const result = resolveAssetReferences(
      [{ name: "one.png", sha256: "same" }, { name: "two.png", sha256: "same" }],
      new Map(),
      () => ({ assetId: `new-${++created}`, key: "one-object" }),
    );
    expect(created).toBe(1);
    expect(result.map(({ assetId, key, isNew }) => ({ assetId, key, isNew }))).toEqual([
      { assetId: "new-1", key: "one-object", isNew: true },
      { assetId: "new-1", key: "one-object", isNew: true },
    ]);
  });
});

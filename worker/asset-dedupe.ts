export interface AssetReference {
  assetId: string;
  key: string;
}

export function resolveAssetReferences<T extends { sha256: string }>(
  candidates: T[],
  existingByHash: Map<string, AssetReference>,
  create: (candidate: T) => AssetReference,
) {
  const resolvedByHash = new Map<string, AssetReference & { isNew: boolean }>(
    [...existingByHash].map(([hash, asset]) => [hash, { ...asset, isNew: false }]),
  );
  return candidates.map((candidate) => {
    let asset = resolvedByHash.get(candidate.sha256);
    if (!asset) {
      asset = { ...create(candidate), isNew: true };
      resolvedByHash.set(candidate.sha256, asset);
    }
    return { ...candidate, ...asset };
  });
}

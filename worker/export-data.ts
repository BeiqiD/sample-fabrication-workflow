export function collectExportAssetKeys(
  assets: Array<Record<string, unknown>>,
  imports: Array<Record<string, unknown>>,
) {
  const keys = new Set<string>();
  for (const asset of assets) if (typeof asset.r2_key === "string" && asset.r2_key) keys.add(asset.r2_key);
  for (const item of imports) {
    if (typeof item.workbook_asset_key === "string" && item.workbook_asset_key) keys.add(item.workbook_asset_key);
    if (typeof item.manifest_asset_key === "string" && item.manifest_asset_key) keys.add(item.manifest_asset_key);
  }
  return [...keys].sort();
}

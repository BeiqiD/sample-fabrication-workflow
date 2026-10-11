import { d1FileBusinessMetadataDatabase } from "./business-metadata-d1";
import { readReadyAssetInputWithDatabase } from "./asset-input-service";

export async function readReadyAssetInput(database: D1Database, input: { assetId?: unknown; assetKey?: unknown }) {
  return readReadyAssetInputWithDatabase(d1FileBusinessMetadataDatabase(database), input);
}

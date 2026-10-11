import { d1SampleFileMetadataDatabase } from "../samples/file-metadata-d1";
import { stateAssetsWithDatabase, loadCurrentSampleStructureWithDatabase, stateImageKeysWithDatabase } from "../samples/structure-service";
export type { SampleStructureState } from "../samples/structure-service";
import type { SampleStructureState } from "../samples/structure-service";

export async function stateAssets(db: D1Database, stateHash: string | null) {
  return stateAssetsWithDatabase(d1SampleFileMetadataDatabase(db), stateHash);
}

export async function loadCurrentSampleStructure(db: D1Database, sampleId: string): Promise<SampleStructureState> {
  return loadCurrentSampleStructureWithDatabase(d1SampleFileMetadataDatabase(db), sampleId);
}

export async function stateImageKeys(db: D1Database, stateHash: string | null) {
  return stateImageKeysWithDatabase(d1SampleFileMetadataDatabase(db), stateHash);
}

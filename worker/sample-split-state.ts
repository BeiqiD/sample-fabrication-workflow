import { d1SampleFileMetadataDatabase } from "./samples/file-metadata-d1";
import { prepareSplitInheritedStateWithDatabase, type SplitStructure } from "./samples/split-state-service";
export type { SplitExecutionAsset } from "./samples/split-state-service";

export async function prepareSplitInheritedState(
  db: D1Database,
  parentId: string,
  expectedUpdatedAt: string,
  structure: SplitStructure,
  now: string,
) {
  return prepareSplitInheritedStateWithDatabase(d1SampleFileMetadataDatabase(db), parentId, expectedUpdatedAt, structure, now);
}

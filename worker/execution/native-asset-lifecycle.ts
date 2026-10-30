import type { Env } from "../types";
import { d1ExecutionFileMetadataDatabase } from "./file-metadata-d1";
import { changeNativeExecutionAssetWithDatabase } from "./native-asset-lifecycle-service";

/** Genuine existing Worker binding, complete native occurrence behavior. */
export async function changeNativeExecutionAsset(env: Env, input: {
  sampleId: string; runId: string; stepId: string; assetId: string; actor: string; restore: boolean;
}) {
  return changeNativeExecutionAssetWithDatabase(d1ExecutionFileMetadataDatabase(env.DB), input);
}

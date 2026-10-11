import { d1FileBusinessMetadataDatabase } from "../files/business-metadata-d1";
import type { SampleFileMetadataDatabase } from "./file-metadata-sql";

/** Genuine existing Worker DB, original fresh-primary/mode behavior and whole
 * D1 batch ACKs. No synthetic Env, provider or native permission adapter. */
export function d1SampleFileMetadataDatabase(database: D1Database): SampleFileMetadataDatabase<D1PreparedStatement> {
  return {
    ...d1FileBusinessMetadataDatabase(database),
    atomicBatch(items) { return database.batch(items); },
  };
}

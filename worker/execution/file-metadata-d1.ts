import { primaryD1 } from "../d1-primary";
import { d1FileBusinessMetadataDatabase } from "../files/business-metadata-d1";
import type { ExecutionFileMetadataDatabase } from "./file-metadata-sql";

/** Actual Worker D1 owner: preserve genuine primary selection, full batch ACK
 * ordinals and original File-mode read. Never a fake Env/provider/native grant. */
export function d1ExecutionFileMetadataDatabase(database: D1Database): ExecutionFileMetadataDatabase<D1PreparedStatement> {
  return {
    ...d1FileBusinessMetadataDatabase(database),
    primary() { return d1ExecutionFileMetadataDatabase(primaryD1(database)); },
    atomicBatch(items) { return database.batch(items); },
  };
}

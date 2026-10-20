import { d1FileBusinessMetadataDatabase } from "../files/business-metadata-d1";
import type { CommentMetadataDatabase } from "./comment-metadata-sql";

/** Genuine current Worker owner and original primary/File-mode behavior. Preserve
 * full D1 batch acknowledgements and RETURNING row cardinality; no synthetic Env. */
export function d1CommentMetadataDatabase(database: D1Database): CommentMetadataDatabase<D1PreparedStatement> {
  return {
    ...d1FileBusinessMetadataDatabase(database),
    atomicBatch(items) { return database.batch(items); },
  };
}

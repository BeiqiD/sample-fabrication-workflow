import { d1FileBusinessMetadataDatabase } from "../files/business-metadata-d1";
import type { TemplateContentDatabase } from "./template-content-sql";

/** Genuine Worker binding, original primary/mode reads and batch ACKs. Native
 * composition requires its own issued statement and same-BEGIN policy adapter. */
export function d1TemplateContentDatabase(database: D1Database): TemplateContentDatabase<D1PreparedStatement> {
  return { ...d1FileBusinessMetadataDatabase(database),
    atomicBatch(items) { return database.batch(items); },
  };
}

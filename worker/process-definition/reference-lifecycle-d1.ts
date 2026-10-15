import { d1FileBusinessMetadataDatabase } from "../files/business-metadata-d1";
import type { TemplateReferenceLifecycleDatabase } from "./reference-lifecycle-sql";

/** Same genuine Worker DB statements and original run/batch acknowledgements. */
export function d1TemplateReferenceLifecycleDatabase(database: D1Database): TemplateReferenceLifecycleDatabase<D1PreparedStatement> {
  return {
    ...d1FileBusinessMetadataDatabase(database),
    async mutation(statement) { return { changes: (await statement.run()).meta.changes }; },
    async atomicBatch(statements) { return (await database.batch([...statements])).map(result => ({ changes: result.meta.changes })); },
  };
}

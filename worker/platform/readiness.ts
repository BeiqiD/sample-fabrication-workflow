import type { ReadinessDatabase } from "../runtime/sql";

/** Same current behavior: successful SELECT execution, no provider/schema test. */
export async function checkDatabaseReadiness(database: ReadinessDatabase): Promise<void> {
  await database.prepare("SELECT 1 AS ok").first();
}

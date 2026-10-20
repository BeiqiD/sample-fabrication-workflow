import type { ReadinessDatabase } from "./sql";

/** Native D1 execution/errors are retained; no mutation metadata is normalized. */
export function d1ReadinessDatabase(database: D1Database | D1DatabaseSession): ReadinessDatabase {
  return {
    prepare(sql) {
      const prepared = database.prepare(sql);
      return { first<T>() { return prepared.first<T>(); } };
    },
  };
}

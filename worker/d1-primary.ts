// Reads used for uncertain-outcome reconciliation must observe the primary D1
// database. Test adapters and older bindings do not expose Sessions, so the
// fallback intentionally preserves their small surface.
export function primaryD1(db: D1Database): D1Database {
  const candidate = db as D1Database & {
    withSession?: (constraint?: "first-primary") => unknown;
  };
  if (typeof candidate.withSession !== "function") return db;
  return candidate.withSession("first-primary") as unknown as D1Database;
}

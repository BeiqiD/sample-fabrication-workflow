import { unstable_splitSqlQuery as splitSql } from "wrangler";

// Cache only parsing by exact SQL text. Every caller still prepares and executes
// all statements against its own fresh database; no database state is reused.
export function createSqlSplitCache(parseSql, maxEntries = 32) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError("SQL split cache capacity must be a positive safe integer");
  }
  const statementsBySql = new Map();
  return (sql) => {
    const cached = statementsBySql.get(sql);
    if (cached !== undefined) {
      statementsBySql.delete(sql);
      statementsBySql.set(sql, cached);
      return cached;
    }

    // A failed parse leaves the cache unchanged. Copy before freezing so neither
    // the parser nor a caller can alter statements reused by another fixture.
    const statements = Object.freeze([...parseSql(sql)]);
    statementsBySql.set(sql, statements);
    if (statementsBySql.size > maxEntries) {
      statementsBySql.delete(statementsBySql.keys().next().value);
    }
    return statements;
  };
}

export const splitTestSql = createSqlSplitCache(splitSql);

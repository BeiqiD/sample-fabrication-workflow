import { primaryD1 } from "../../d1-primary";
import { SqlFileJobRepository, type JobSqlDatabase, type JobSqlStatement } from "./sql-repository";

export function d1FileJobDatabase(database: D1Database): JobSqlDatabase {
  const statements = new WeakMap<JobSqlStatement, D1PreparedStatement>();
  const wrap = (prepared: D1PreparedStatement): JobSqlStatement => {
    const result: JobSqlStatement = {
      bind(...values) { return wrap(prepared.bind(...values)); },
      first<T>() { return prepared.first<T>(); },
      async all<T>() { const rows = await prepared.all<T>(); return { results: rows.results }; },
      run() { return prepared.run(); },
    };
    statements.set(result, prepared); return result;
  };
  return {
    prepare(sql) { return wrap(database.prepare(sql)); },
    batch(batch) {
      return database.batch(batch.map(statement => {
        const prepared = statements.get(statement); if (!prepared) throw new Error("Foreign File job statement"); return prepared;
      }));
    },
    primary() { return d1FileJobDatabase(primaryD1(database)); },
  };
}
export function d1FileJobRepository(database: D1Database, now = () => new Date()) {
  return new SqlFileJobRepository(d1FileJobDatabase(database), now, () => crypto.randomUUID());
}

import type { ConfigurationSqlDatabase, ConfigurationSqlStatement } from "../worker/runtime/configuration-sql";
import { configurationSqlInteger, configurationSqlMutation, configurationSqlRow } from "../worker/runtime/configuration-sql";
import type { SqliteCapability, SqliteStatement } from "./sqlite";

/** Genuine exact Node SQLite capability, not a D1-shaped adapter. BigInt cells
 * remain exact until the storage domain checks a named integer field. */
export function asStorageConfigurationSqlDatabase(core: SqliteCapability): ConfigurationSqlDatabase {
  const statements = new WeakMap<ConfigurationSqlStatement, { native: SqliteStatement; mutation: boolean }>();
  const wrap = (native: SqliteStatement, mutation: boolean): ConfigurationSqlStatement => {
    const statement: ConfigurationSqlStatement = {
      bind(...values) { return wrap(native.bind(...values), mutation); },
      async first() { const row = await native.first(); return row === null ? null : configurationSqlRow(row); },
      async all() { return { results: (await native.all()).results.map(configurationSqlRow) }; },
    };
    statements.set(statement, { native, mutation }); return statement;
  };
  return {
    prepare(sql) { return wrap(core.prepare(sql), configurationSqlMutation(sql)); },
    async batch(items) {
      const result = await core.batch(items.map(item => {
        const selected = statements.get(item);
        if (!selected) throw new Error("Foreign storage configuration statement");
        if (!selected.mutation) throw new Error("Storage configuration batch only accepts top-level mutations");
        return selected.native;
      }));
      return result.map(item => ({ directChanges: configurationSqlInteger(item.meta.directChanges, "direct changes") }));
    },
    primary() { return asStorageConfigurationSqlDatabase(core.primary()); },
  };
}

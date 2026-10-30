import type { ConfigurationSqlDatabase, ConfigurationSqlStatement } from "../runtime/configuration-sql";
import { configurationSqlCell, configurationSqlInteger, configurationSqlMutation, configurationSqlRow } from "../runtime/configuration-sql";

/** Genuine Cloudflare adapter. The trusted Worker supplies its actual D1
 * binding; local runtimes never construct one or adapt local identity to Env. */
export function d1StorageConfigurationDatabase(database: D1Database): ConfigurationSqlDatabase {
  const view = (source: D1Database | D1DatabaseSession): ConfigurationSqlDatabase => {
    const statements = new WeakMap<ConfigurationSqlStatement, { native: D1PreparedStatement; mutation: boolean }>();
    const wrap = (native: D1PreparedStatement, mutation: boolean): ConfigurationSqlStatement => {
      const statement: ConfigurationSqlStatement = {
        bind(...values) {
          const bindings = values.map(value => {
            const checked = configurationSqlCell(value);
            return typeof checked === "bigint" ? configurationSqlInteger(checked, "D1 binding", Number.MIN_SAFE_INTEGER) : checked;
          });
          return wrap(native.bind(...bindings), mutation);
        },
        async first() {
          const row = await native.first<Record<string, unknown>>();
          return row === null ? null : configurationSqlRow(row);
        },
        async all() { return { results: (await native.all<Record<string, unknown>>()).results.map(configurationSqlRow) }; },
      };
      statements.set(statement, { native, mutation }); return statement;
    };
    return {
      prepare(sql) { return wrap(source.prepare(sql), configurationSqlMutation(sql)); },
      async batch(items) {
        const native = items.flatMap(item => {
          const selected = statements.get(item);
          if (!selected) throw new Error("Foreign storage configuration statement");
          if (!selected.mutation) throw new Error("Storage configuration batch only accepts top-level mutations");
          // D1 meta.changes includes trigger work. Observe SQLite changes()
          // immediately after each statement inside this same atomic batch.
          return [selected.native, source.prepare("SELECT changes() AS direct_changes")];
        });
        if (!native.length) return [];
        const results = await source.batch<Record<string, unknown>>(native);
        if (results.length !== native.length) throw new Error("Incomplete D1 storage configuration batch acknowledgement");
        return items.map((_item, index) => ({
          directChanges: configurationSqlInteger(results[index * 2 + 1].results[0]?.direct_changes, "D1 direct changes"),
        }));
      },
      primary() {
        // The fallback preserves existing small test/older binding surfaces.
        // Actual current D1 always selects a fresh first-primary session.
        return view(typeof database.withSession === "function" ? database.withSession("first-primary") : database);
      },
    };
  };
  return view(database);
}

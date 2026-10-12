import type { OfflineWriterFence } from "../auth/identity";
import type { SqliteCapability } from "../sqlite";
import { asStorageConfigurationSqlDatabase } from "../storage-configuration-sql.ts";
import type { ConfigurationSqlDatabase, ConfigurationSqlStatement } from "../../worker/runtime/configuration-sql";

/** Node-only metadata capability. Composition must supply the real held
 * installation/physical writer owner; an availability callback is not a lease.
 * The owner and connection are captured once, and disposal remains observable
 * through their held assertions. This adapter is not composed into an app. */
export function createOwnedLocalProfileRegistrationSql(core: SqliteCapability, owner: OfflineWriterFence): ConfigurationSqlDatabase {
  const assertion = owner?.assertHeld;
  if (typeof assertion !== "function") throw new TypeError("A held local registration owner is required");
  const held = assertion.bind(owner);
  const stableOwner = Object.freeze({ assertHeld: held });
  const assertHeld = () => {
    // OfflineWriterFence is synchronous. A Promise must never defer its check
    // beyond the native BEGIN; reject a miscomposed asynchronous assertion.
    const result: unknown = held();
    if (result !== undefined) {
      if (result instanceof Promise) void result.catch(() => { /* Already rejected as a capability. */ });
      throw new TypeError("Local registration owner assertion must be synchronous");
    }
  };
  assertHeld();
  const sql = asStorageConfigurationSqlDatabase(core), statements = new WeakMap<ConfigurationSqlStatement, ConfigurationSqlStatement>();
  const wrap = (native: ConfigurationSqlStatement): ConfigurationSqlStatement => {
    const statement: ConfigurationSqlStatement = {
      bind(...values) { assertHeld(); return wrap(native.bind(...values)); },
      async first() { assertHeld(); const result = await native.first(); assertHeld(); return result; },
      async all() { assertHeld(); const result = await native.all(); assertHeld(); return result; },
    };
    statements.set(statement, native); return statement;
  };
  return {
    prepare(text) { assertHeld(); return wrap(sql.prepare(text)); },
    async batch(items) {
      const selected = items.map(item => {
        const native = statements.get(item); if (!native) throw new Error("Foreign local registration statement"); return native;
      });
      // No await between this assertion and real SQLite BEGIN IMMEDIATE.
      // The existing Node SQL adapter/core execute the whole transaction
      // synchronously with no provider I/O inside it.
      assertHeld(); const result = await sql.batch(selected); assertHeld(); return result;
    },
    primary() { assertHeld(); return createOwnedLocalProfileRegistrationSql(core.primary(), stableOwner); },
  };
}

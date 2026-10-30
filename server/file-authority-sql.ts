import { configurationSqlCell, configurationSqlRow } from "../worker/runtime/configuration-sql.ts";
import type { FileAuthoritySqlDatabase, FileAuthoritySqlResult, FileAuthoritySqlStatement } from "../worker/runtime/file-authority-sql";
import { runSqliteAdmittedBatch, type SqliteBatchAdmission, type SqliteCapability, type SqliteResult, type SqliteStatement } from "./sqlite.ts";
import type { OfflineWriterFence } from "./auth/identity";
import type { LocalUploadExecution } from "./files/local-upload-execution";
import { ownedLocalUploadV28FileAuthorityScope, type LocalUploadV28FileAuthorityScope,
  type LocalVolumeProfileOpening } from "./storage/local-volume-profile-opening";

export interface NativeFileAuthoritySqlDatabase extends FileAuthoritySqlDatabase {
  nativeStatement(statement: FileAuthoritySqlStatement): SqliteStatement;
}
const databaseOwners = new WeakMap<NativeFileAuthoritySqlDatabase, SqliteCapability>();
const preparationOwners = new WeakMap<NativeFileAuthoritySqlDatabase,
  ReturnType<typeof ownedLocalUploadV28FileAuthorityScope>["preparation"]>();
/** This private opaque scope belongs to one original actual V28 execution and
 * opening. Preparation eligibility is fixed at new issuance; no generic-view
 * attachment/rebinding API or callback/owner option is accepted. */
export function asLocalUploadV28FileAuthoritySqlDatabase(scope: LocalUploadV28FileAuthorityScope,
  execution: LocalUploadExecution, opening: LocalVolumeProfileOpening,
  admission: SqliteBatchAdmission): NativeFileAuthoritySqlDatabase {
  const original = ownedLocalUploadV28FileAuthorityScope(scope, execution, opening);
  const view = fileAuthoritySqlDatabase(original.database, original.fullFence, admission);
  preparationOwners.set(view, original.preparation); return view;
}
export function assertNativeFileAuthoritySqlOwner(database: NativeFileAuthoritySqlDatabase, core: SqliteCapability): void {
  if (databaseOwners.get(database) !== core) throw new Error("Foreign File authority database");
}
const nativeBatchResults = new WeakMap<NativeFileAuthoritySqlDatabase,
  (statements: readonly FileAuthoritySqlStatement[]) => Promise<SqliteResult[]>>();
/** Internal same-BEGIN result bridge for complete original business algorithms.
 * Only the genuine issued Native view can supply its original result ordinal
 * and top-level change ACK. No second transaction, SELECT changes(), mutable
 * result bag or structural provider capability substitutes that result. */
export function runOwnedFileAuthorityBatchWithNativeResults(database: NativeFileAuthoritySqlDatabase,
  statements: readonly FileAuthoritySqlStatement[]): Promise<SqliteResult[]> {
  const run = nativeBatchResults.get(database);
  if (!run) throw new Error("Original native File result ownership is required");
  return run(statements);
}
/** View of the existing exact owned native core. Typed int64/BLOB cells stay
 * exact; named File fields check their domain bounds after SQL selection. */
export function asFileAuthoritySqlDatabase(core: SqliteCapability, owner?: OfflineWriterFence): NativeFileAuthoritySqlDatabase {
  return fileAuthoritySqlDatabase(core, owner);
}
/** The genuine issued checks run inside the same original native BEGIN as
 * each mutation/batch. This does not infer File/provider permission from a
 * storage administrator; callers retain their original domain/source fences. */
export function asAdmittedFileAuthoritySqlDatabase(core: SqliteCapability, admission: SqliteBatchAdmission,
  owner?: OfflineWriterFence): NativeFileAuthoritySqlDatabase {
  return fileAuthoritySqlDatabase(core, owner, admission);
}
function fileAuthoritySqlDatabase(core: SqliteCapability, owner?: OfflineWriterFence,
  admission?: SqliteBatchAdmission): NativeFileAuthoritySqlDatabase {
  const prepare = core.prepare.bind(core), batch = core.batch.bind(core), primary = core.primary.bind(core);
  const executeBatch = (selected: readonly SqliteStatement[]) => admission
    ? runSqliteAdmittedBatch(core, selected, admission) : batch(selected);
  const held = owner?.assertHeld.bind(owner);
  const assertHeld = () => {
    if (!held) return;
    const answer: unknown = held();
    if (answer !== undefined) {
      if (answer instanceof Promise) void answer.catch(() => undefined);
      throw new TypeError("File authority owner assertion must be synchronous");
    }
  };
  assertHeld();
  const assertPreparing = () => {
    const preparation = preparationOwners.get(view);
    if (preparation) { preparation.assertHeld(); primary(); }
    else assertHeld();
  };
  const statements = new WeakMap<FileAuthoritySqlStatement, SqliteStatement>();
  const nativeStatement = (statement: FileAuthoritySqlStatement) => {
    assertHeld();
    const native = statements.get(statement); if (!native) throw new Error("Foreign File authority statement"); return native;
  };
  // Private selection cannot escape the original batch wrapper. Public
  // nativeStatement retains its full original guard for direct Native users.
  const selectBatchStatement = (statement: FileAuthoritySqlStatement) => {
    if (!preparationOwners.has(view)) return nativeStatement(statement);
    assertPreparing();
    const native = statements.get(statement); if (!native) throw new Error("Foreign File authority statement"); return native;
  };
  const result = (value: Awaited<ReturnType<SqliteStatement["all"]>>): FileAuthoritySqlResult =>
    ({ success: true, results: value.results.map(configurationSqlRow) });
  const wrap = (native: SqliteStatement): FileAuthoritySqlStatement => {
    const bind = native.bind.bind(native), first = native.first.bind(native),
      all = native.all.bind(native), run = native.run.bind(native);
    const statement: FileAuthoritySqlStatement = {
      bind(...values) { assertPreparing(); return wrap(bind(...values.map(configurationSqlCell))); },
      async first() {
        assertHeld(); const row = admission ? (await executeBatch([native]))[0]!.results[0] ?? null : await first();
        assertHeld(); return row === null ? null : configurationSqlRow(row);
      },
      async all() {
        assertHeld(); const value = admission ? (await executeBatch([native]))[0]! : await all();
        assertHeld(); return result(value);
      },
      async run() {
        assertHeld(); const value = admission ? (await executeBatch([native]))[0]! : await run();
        assertHeld(); return result(value);
      },
    };
    statements.set(statement, native); return Object.freeze(statement);
  };
  const view: NativeFileAuthoritySqlDatabase = {
    prepare(sql) { assertPreparing(); return wrap(prepare(sql)); },
    async batch(items) {
      const selected = items.map(selectBatchStatement);
      // This assertion and the existing core's BEGIN IMMEDIATE have no await
      // between them. All selected SQL executes synchronously in that core.
      assertHeld(); const values = await executeBatch(selected); assertHeld(); return values.map(result);
    },
    primary() { assertHeld(); primary(); return view; },
    nativeStatement,
  };
  nativeBatchResults.set(view, async items => {
    const selected = items.map(selectBatchStatement);
    assertHeld(); const values = await executeBatch(selected); assertHeld(); return values;
  });
  databaseOwners.set(view, core);
  return Object.freeze(view);
}

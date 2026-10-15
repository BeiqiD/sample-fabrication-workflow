import { primaryD1 } from "../d1-primary";
import { SqlSystemRecoveryRepository } from "./sql-repository";

export { SystemRecoveryConflict } from "./sql-repository";
export type { RecoveryJob, RecoveryClaim, RecoveryAttempt, RecoveryRuntime } from "./sql-repository";

/** Original public Worker constructor and genuine first-primary D1 selection.
 * SQL, guards, receipts and attempt limits have one implementation. */
export class SystemRecoveryRepository extends SqlSystemRecoveryRepository<D1PreparedStatement, D1Database> {
  constructor(database: D1Database, now: () => Date = () => new Date()) {
    super(database, primaryD1, now);
  }
}

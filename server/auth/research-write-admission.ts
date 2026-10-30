import type { DatabaseSync } from "node:sqlite";
import { HTTPException } from "hono/http-exception";
import { assertInstallationAdmission, type ReviewedInstallationAdmission } from "../migrations";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../operations/writer-lease";
import { createSqliteBatchAdmission, type SqliteCapability } from "../sqlite";

/** Installation/Request-owned mutation predicate factory only. The issued
 * SELECT checks execute inside the SAME actual BEGIN as original SQL. */
export function createResearchWriteAdmission(options: {
  database: SqliteCapability; nativeDatabase: DatabaseSync; admission: ReviewedInstallationAdmission;
  writerLease: LinuxWriterLease; idleLifetimeMs: number;
  sessionPredicate(request: Request, actor: string): Readonly<{ tokenHash: string; actor: string }>;
}) {
  const { database, nativeDatabase, admission, writerLease, idleLifetimeMs, sessionPredicate } = options;
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  const installation = Object.freeze({ ...assertInstallationAdmission(nativeDatabase, admission) });
  if (!Number.isSafeInteger(idleLifetimeMs) || idleLifetimeMs < 1 || idleLifetimeMs > 86400_000) throw new Error("Local session policy is unavailable");
  const sentinel = nativeDatabase.prepare("SELECT bootstrap_principal_id,initialized_at FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'").get();
  if (typeof sentinel?.bootstrap_principal_id !== "string" || typeof sentinel.initialized_at !== "number" || !Number.isSafeInteger(sentinel.initialized_at)) {
    throw new Error("Local identity installation is unavailable");
  }
  const bootstrapPrincipalId = sentinel.bootstrap_principal_id, initializedAt = sentinel.initialized_at;
  return (request: Request, actor: string, controlsMessage: string) => {
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    const session = sessionPredicate(request, actor);
    const authentication = database.prepare(`SELECT 1 AS admitted FROM local_sessions s JOIN local_accounts a ON a.principal_id=s.principal_id
      CROSS JOIN (WITH observed AS MATERIALIZED (SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now)
        SELECT now FROM observed) clock
      WHERE s.token_hash=? AND ('local-account:' || a.principal_id)=? AND a.enabled=1
        AND a.credential_revision=s.credential_revision AND s.revoked_at IS NULL
        AND typeof(clock.now)='integer' AND clock.now BETWEEN 0 AND 9007199254740991
        AND clock.now >= s.last_seen_at AND clock.now < s.absolute_expires_at AND clock.now < s.last_seen_at + ?
        AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1') LIMIT 1`)
      .bind(session.tokenHash, session.actor, idleLifetimeMs);
    const currentInstallation = database.prepare(`SELECT 1 AS admitted WHERE
      EXISTS(SELECT 1 FROM node_installation WHERE singleton=1 AND installation_id=? AND catalog_id=?
        AND schema_checkpoint=? AND schema_sha256=? AND created_at=?)
      AND EXISTS(SELECT 1 FROM local_identity_installation WHERE singleton=1 AND catalog_id='local-identity-v1'
        AND bootstrap_principal_id=? AND initialized_at=?)`)
      .bind(installation.installationId, installation.catalogId, installation.checkpointId, installation.schemaSha256,
        installation.createdAt, bootstrapPrincipalId, initializedAt);
    const controls = database.prepare(`SELECT 1 AS admitted FROM system_recovery_maintenance m WHERE m.singleton=1 AND m.state='open'
      AND NOT EXISTS(SELECT 1 FROM system_recovery_write_leases WHERE released_at IS NULL)
      AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='legacy')`);
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    return createSqliteBatchAdmission(database, [
      { statement: authentication, rejection: new HTTPException(401, { message: "Authentication is required." }) },
      { statement: currentInstallation, rejection: new HTTPException(503, { message: "Installation write admission is unavailable." }) },
      { statement: controls, rejection: new HTTPException(503, { message: controlsMessage }) },
    ]);
  };
}

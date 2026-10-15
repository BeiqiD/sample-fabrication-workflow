import type { DatabaseSync } from "node:sqlite";
import { OPERATIONAL_NODE_INSTALLATION_CATALOG } from "../../operational-installation-catalog";
import { assertInstallationAdmission, type InstallationReceipt, type ReviewedInstallationAdmission } from "../../migrations";
import { assertSqliteConnectionOwner, type SqliteCapability } from "../../sqlite";
import { assertLinuxWriterLeaseBinding, type LinuxWriterLease } from "../../operations/writer-lease";

export interface InstalledJobPrincipalAuthority {
  authorizeAdministrator(actor: string): boolean;
  /** Host closes this only after its original job/provider owners drain. */
  close(): void;
}
export interface JobPrincipalOwner {
  readonly database: SqliteCapability;
  readonly nativeDatabase: DatabaseSync;
  readonly installation: Readonly<InstallationReceipt>;
  readonly identityInstallation: Readonly<{ bootstrapPrincipalId: string; initializedAt: bigint }>;
  assertCurrent(): void;
}
const issued = new WeakMap<InstalledJobPrincipalAuthority, JobPrincipalOwner>();
const ACTOR = /^local-account:(local_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
export function localJobPrincipalId(actor: string): string | null {
  return typeof actor === "string" ? ACTOR.exec(actor)?.[1] ?? null : null;
}
export function ownedJobPrincipalAuthority(authority: InstalledJobPrincipalAuthority): JobPrincipalOwner {
  const owner = issued.get(authority);
  if (!owner) throw new Error("Installed job principal authority is unavailable");
  owner.assertCurrent(); return owner;
}
/** This uncomposed Node-only owner admits the exact code-owned operational installation.
 * Generic injected catalogs, actor spelling and HTTP sessions are not grants.
 * Catalog/schema are immutable until stop/drain/close and fresh composition. */
export function createInstalledJobPrincipalAuthority(options: {
  database: SqliteCapability; nativeDatabase: DatabaseSync;
  admission: ReviewedInstallationAdmission; writerLease: LinuxWriterLease;
}): InstalledJobPrincipalAuthority {
  const { database, nativeDatabase, admission, writerLease } = options;
  assertSqliteConnectionOwner(database, nativeDatabase);
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  const installation = assertInstallationAdmission(nativeDatabase, admission);
  const catalog = OPERATIONAL_NODE_INSTALLATION_CATALOG, current = catalog.migrations.at(-1)?.checkpoint;
  if (!current || installation.catalogId !== catalog.id
    || installation.checkpointId !== current.id || installation.schemaSha256 !== current.schemaSha256
    || installation.appliedMigrations !== catalog.migrations.length) throw new Error("Current Node job installation is unavailable");
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  const identityStatement = nativeDatabase.prepare("SELECT bootstrap_principal_id,catalog_id,initialized_at FROM local_identity_installation WHERE singleton=1");
  identityStatement.setReadBigInts(true); const initialIdentity = identityStatement.get();
  if (!initialIdentity || typeof initialIdentity.bootstrap_principal_id !== "string"
    || !localJobPrincipalId(`local-account:${initialIdentity.bootstrap_principal_id}`)
    || initialIdentity.catalog_id !== "local-identity-v1" || typeof initialIdentity.initialized_at !== "bigint"
    || initialIdentity.initialized_at < 0n) throw new Error("Current local job identity installation is unavailable");
  const identityInstallation = Object.freeze({ bootstrapPrincipalId: initialIdentity.bootstrap_principal_id, initializedAt: initialIdentity.initialized_at });
  let closed = false;
  function assertCurrent(): void {
    if (closed) throw new Error("Installed job principal authority is closed");
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    const row = nativeDatabase.prepare("SELECT installation_id,catalog_id,schema_checkpoint,schema_sha256,created_at FROM node_installation WHERE singleton=1").get();
    if (!row || row.installation_id !== installation.installationId || row.catalog_id !== installation.catalogId
      || row.schema_checkpoint !== installation.checkpointId || row.schema_sha256 !== installation.schemaSha256
      || row.created_at !== installation.createdAt) throw new Error("Installed job principal authority changed");
    const identity = identityStatement.get();
    if (!identity || identity.bootstrap_principal_id !== identityInstallation.bootstrapPrincipalId
      || identity.catalog_id !== "local-identity-v1" || identity.initialized_at !== identityInstallation.initializedAt)
      throw new Error("Installed job identity authority changed");
  }
  const authority: InstalledJobPrincipalAuthority = Object.freeze({
    authorizeAdministrator(actor: string): boolean {
      try {
        assertCurrent(); const id = localJobPrincipalId(actor); if (!id) return false;
        const row = nativeDatabase.prepare(`SELECT 1 FROM local_accounts a JOIN local_admin_grants g ON g.principal_id=a.principal_id
          WHERE a.principal_id=? AND a.enabled=1 AND EXISTS(SELECT 1 FROM local_identity_installation
            WHERE singleton=1 AND catalog_id='local-identity-v1')`).get(id);
        assertCurrent(); return !!row;
      } catch { return false; }
    },
    close() { closed = true; },
  });
  issued.set(authority, Object.freeze({ database, nativeDatabase, installation, identityInstallation, assertCurrent }));
  return authority;
}

/** Fixed V28 administrator owner for the explicit combined host. Dynamic
 * imports keep the existing V26 startup graph unchanged. This owner enters
 * the same private registry as the original factory; no caller catalog,
 * asserted actor spelling, Group membership or Request is an admin grant.
 * Ordinary File/Package resource permission is issued separately. */
export async function createInstalledJobPrincipalAuthorityV28(options: {
  database: SqliteCapability; nativeDatabase: DatabaseSync;
  admission: ReviewedInstallationAdmission; writerLease: LinuxWriterLease; authentication: object;
}): Promise<InstalledJobPrincipalAuthority> {
  const { database, nativeDatabase, admission, writerLease, authentication } = Object.freeze({ ...options });
  assertSqliteConnectionOwner(database, nativeDatabase);
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  const [catalogModule, authModule, identityModule] = await Promise.all([
    import("../../installation-catalog-v28-candidate.ts"),
    import("../../auth/local-auth-http.ts"),
    import("../../auth/installed-identity-execution-owner-v28-candidate.ts"),
  ]);
  assertSqliteConnectionOwner(database, nativeDatabase);
  assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
  const installation = assertInstallationAdmission(nativeDatabase, admission);
  const catalog = catalogModule.V28_NODE_INSTALLATION_CATALOG_CANDIDATE, checkpoint = catalog.migrations.at(-1)?.checkpoint;
  if (!checkpoint || checkpoint.id !== "portable-runtime/v28" || installation.catalogId !== catalog.id
    || installation.checkpointId !== checkpoint.id || installation.schemaSha256 !== checkpoint.schemaSha256
    || installation.appliedMigrations !== catalog.migrations.length) throw new Error("Current V28 job installation is unavailable");
  const auth = authModule.localAuthenticationIdentityAuthority(authentication);
  const identity = identityModule.captureInstalledIdentityExecutionOwnerV28Candidate(auth.identity, database, nativeDatabase, admission);
  if (identity.installation.installationId !== installation.installationId
    || identity.installation.catalogId !== installation.catalogId || identity.installation.checkpointId !== installation.checkpointId
    || identity.installation.schemaSha256 !== installation.schemaSha256
    || identity.installation.appliedMigrations !== installation.appliedMigrations
    || identity.installation.createdAt !== installation.createdAt) throw new Error("Original V28 job identity installation changed");
  const identityStatement = nativeDatabase.prepare("SELECT bootstrap_principal_id,catalog_id,initialized_at FROM local_identity_installation WHERE singleton=1");
  identityStatement.setReadBigInts(true); const initialIdentity = identityStatement.get();
  if (!initialIdentity || typeof initialIdentity.bootstrap_principal_id !== "string"
    || !localJobPrincipalId(`local-account:${initialIdentity.bootstrap_principal_id}`)
    || initialIdentity.catalog_id !== "local-identity-v1" || typeof initialIdentity.initialized_at !== "bigint"
    || initialIdentity.initialized_at < 0n) throw new Error("Current V28 job identity installation is unavailable");
  const identityInstallation = Object.freeze({ bootstrapPrincipalId: initialIdentity.bootstrap_principal_id, initializedAt: initialIdentity.initialized_at });
  let closed = false;
  function assertCurrent(): void {
    if (closed) throw new Error("Installed V28 job principal authority is closed");
    assertSqliteConnectionOwner(database, nativeDatabase);
    assertLinuxWriterLeaseBinding(writerLease, database, nativeDatabase);
    identity.assertCurrent();
    if (authModule.localAuthenticationIdentityAuthority(authentication) !== auth) throw new Error("Original V28 job identity changed");
    const currentIdentity = identityStatement.get();
    if (!currentIdentity || currentIdentity.bootstrap_principal_id !== identityInstallation.bootstrapPrincipalId
      || currentIdentity.catalog_id !== "local-identity-v1" || currentIdentity.initialized_at !== identityInstallation.initializedAt)
      throw new Error("Installed V28 job identity authority changed");
  }
  assertCurrent();
  const authority: InstalledJobPrincipalAuthority = Object.freeze({
    authorizeAdministrator(actor: string): boolean {
      try {
        assertCurrent(); const id = localJobPrincipalId(actor); if (!id) return false;
        const row = nativeDatabase.prepare(`SELECT 1 FROM local_accounts a JOIN local_admin_grants g ON g.principal_id=a.principal_id
          WHERE a.principal_id=? AND a.enabled=1 AND EXISTS(SELECT 1 FROM local_identity_installation
            WHERE singleton=1 AND catalog_id='local-identity-v1')`).get(id);
        assertCurrent(); return !!row;
      } catch { return false; }
    },
    close() { closed = true; },
  });
  issued.set(authority, Object.freeze({ database, nativeDatabase, installation, identityInstallation, assertCurrent }));
  return authority;
}

import { readFile } from "node:fs/promises";
import { CURRENT_NODE_INSTALLATION_CATALOG } from "../installation-catalog";
import { installationSchemaDigest, installationSqlDigest, type ReviewedInstallationCatalog,
  type ReviewedInstallationCheckpoint } from "../migrations";
import { NODE_PLATFORM_OBJECTS } from "../../shared/contracts/node-installation-schema";
import { LOCAL_PROFILE_MIGRATION_SHA256, localProfileV26ExpectedObjects } from "./local-profile-v26-schema.fixture";

/** Test-only paired catalog, never selected by an installer or application
 * composition. Expected objects are authored before execution, not observed
 * from an uploaded image or the resulting SQLite schema. */
export async function privateLocalProfileV26Catalog(): Promise<ReviewedInstallationCatalog> {
  const sql = await readFile(new URL("../../migrations/0024_rt3_local_volume_profiles.sql", import.meta.url), "utf8");
  if (installationSqlDigest(sql) !== LOCAL_PROFILE_MIGRATION_SHA256) throw new Error("Private local migration source changed");
  const applicationObjects = localProfileV26ExpectedObjects(), id = "portable-runtime/v26";
  const schemaSha256 = installationSchemaDigest([...applicationObjects, ...NODE_PLATFORM_OBJECTS]);
  const checkpoint: ReviewedInstallationCheckpoint = Object.freeze({ id, applicationObjects, schemaSha256,
    recoveryAdmission: Object.freeze({ kind: "node-installation-recovery-admission/1", checkpointId: id, schemaSha256, platformObjects: NODE_PLATFORM_OBJECTS }) });
  return Object.freeze({ id: CURRENT_NODE_INSTALLATION_CATALOG.id, emptyCheckpoint: CURRENT_NODE_INSTALLATION_CATALOG.emptyCheckpoint,
    migrations: Object.freeze([...CURRENT_NODE_INSTALLATION_CATALOG.migrations,
      Object.freeze({ name: "0024_rt3_local_volume_profiles.sql", sql, rawSha256: LOCAL_PROFILE_MIGRATION_SHA256, checkpoint })]) });
}

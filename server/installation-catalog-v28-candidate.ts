// SOURCE-ONLY forward candidate. No current startup/offline selector imports this.
import { V27_INERT_NODE_INSTALLATION_CATALOG_CANDIDATE as previousCatalog } from "./installation-catalog-v27-candidate";
import { NODE_PLATFORM_OBJECTS } from "../shared/contracts/node-installation-schema";
import { COLLABORATION_REPLACEMENT_SCHEMA_OBJECTS_V28, COLLABORATION_MIGRATION_SQL_V28, COLLABORATION_MIGRATION_NAME_V28,
  COLLABORATION_MIGRATION_RAW_SHA256_V28 } from "../shared/contracts/collaboration-schema-v28";
import { PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256 } from "../shared/contracts/portable-runtime-v28-recovery-catalog";
import type { ReviewedInstallationCatalog } from "./migrations";
const replacements = new Map(COLLABORATION_REPLACEMENT_SCHEMA_OBJECTS_V28.map(object => [object.name, object]));
const applicationObjects = Object.freeze(previousCatalog.migrations.at(-1)!.checkpoint.applicationObjects.map(object => replacements.get(object.name) ?? object));
const schemaSha256 = PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256[PORTABLE_RUNTIME_CHECKPOINT_ID];
export const V28_NODE_INSTALLATION_CATALOG_CANDIDATE: ReviewedInstallationCatalog = Object.freeze({
  id: previousCatalog.id, emptyCheckpoint: previousCatalog.emptyCheckpoint,
  migrations: Object.freeze([...previousCatalog.migrations, Object.freeze({ name: COLLABORATION_MIGRATION_NAME_V28,
    sql: COLLABORATION_MIGRATION_SQL_V28, rawSha256: COLLABORATION_MIGRATION_RAW_SHA256_V28, checkpoint: Object.freeze({
      id: PORTABLE_RUNTIME_CHECKPOINT_ID, applicationObjects, schemaSha256, recoveryAdmission: Object.freeze({
        kind: "node-installation-recovery-admission/1" as const, checkpointId: PORTABLE_RUNTIME_CHECKPOINT_ID, schemaSha256, platformObjects: NODE_PLATFORM_OBJECTS }) }) })]),
});

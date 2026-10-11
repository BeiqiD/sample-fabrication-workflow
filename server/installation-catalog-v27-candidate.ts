// EXPLICIT inactive candidate only. Startup/offline default remains fixed V26.
import { V26_NODE_INSTALLATION_CATALOG } from "./installation-catalog-v26";
import { NODE_PLATFORM_OBJECTS } from "../shared/contracts/node-installation-schema";
import { COLLABORATION_SCHEMA_OBJECTS_V27, COLLABORATION_MIGRATION_SQL_V27, COLLABORATION_MIGRATION_NAME_V27,
  COLLABORATION_MIGRATION_RAW_SHA256_V27 } from "../shared/contracts/collaboration-schema-v27";
import { PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256 } from "../shared/contracts/portable-runtime-v27-recovery-catalog";
import type { ReviewedInstallationCatalog } from "./migrations";
const previous = V26_NODE_INSTALLATION_CATALOG.migrations.at(-1)!;
const applicationObjects = Object.freeze([...previous.checkpoint.applicationObjects, ...COLLABORATION_SCHEMA_OBJECTS_V27]
  .sort((left, right) => left.type < right.type ? -1 : left.type > right.type ? 1 : left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
const schemaSha256 = PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256[PORTABLE_RUNTIME_CHECKPOINT_ID];
export const V27_INERT_NODE_INSTALLATION_CATALOG_CANDIDATE: ReviewedInstallationCatalog = Object.freeze({
  id: V26_NODE_INSTALLATION_CATALOG.id, emptyCheckpoint: V26_NODE_INSTALLATION_CATALOG.emptyCheckpoint,
  migrations: Object.freeze([...V26_NODE_INSTALLATION_CATALOG.migrations, Object.freeze({ name: COLLABORATION_MIGRATION_NAME_V27,
    sql: COLLABORATION_MIGRATION_SQL_V27, rawSha256: COLLABORATION_MIGRATION_RAW_SHA256_V27, checkpoint: Object.freeze({
      id: PORTABLE_RUNTIME_CHECKPOINT_ID, applicationObjects, schemaSha256, recoveryAdmission: Object.freeze({
        kind: "node-installation-recovery-admission/1" as const, checkpointId: PORTABLE_RUNTIME_CHECKPOINT_ID, schemaSha256, platformObjects: NODE_PLATFORM_OBJECTS }) }) })]),
});

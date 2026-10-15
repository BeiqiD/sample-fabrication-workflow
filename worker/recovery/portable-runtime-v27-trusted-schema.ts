// Inactive candidate DDL. Source/archive SQL never chooses destination definitions.
import { PORTABLE_RUNTIME_SCHEMA_STATEMENTS as V26_OBJECTS, PORTABLE_RUNTIME_SEED_TABLE_ROWS as V26_SEEDS } from "./portable-runtime-v26-trusted-schema";
import { COLLABORATION_SCHEMA_OBJECTS_V27, COLLABORATION_SEED_TABLE_ROWS_V27 } from "../../shared/contracts/collaboration-schema-v27";
export { PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, PORTABLE_RUNTIME_RECOVERY_TABLES,
  PORTABLE_RUNTIME_RECOVERY_MIGRATIONS, PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256 } from "../../shared/contracts/portable-runtime-v27-recovery-catalog";
export const PORTABLE_RUNTIME_SCHEMA_STATEMENTS = Object.freeze([...V26_OBJECTS, ...COLLABORATION_SCHEMA_OBJECTS_V27]
  .sort((left, right) => left.type < right.type ? -1 : left.type > right.type ? 1 : left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
export const PORTABLE_RUNTIME_SEED_TABLE_ROWS = Object.freeze({ ...V26_SEEDS, ...COLLABORATION_SEED_TABLE_ROWS_V27 });

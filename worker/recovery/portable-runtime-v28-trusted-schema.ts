// SOURCE-ONLY trusted V28 definitions, never archive-selected destination SQL.
import { PORTABLE_RUNTIME_SCHEMA_STATEMENTS as V27_OBJECTS, PORTABLE_RUNTIME_SEED_TABLE_ROWS as V27_SEEDS } from "./portable-runtime-v27-trusted-schema";
import { COLLABORATION_REPLACEMENT_SCHEMA_OBJECTS_V28, COLLABORATION_SEED_TABLE_ROWS_V28 } from "../../shared/contracts/collaboration-schema-v28";
export { PORTABLE_RUNTIME_CHECKPOINT_ID, PORTABLE_RUNTIME_RECOVERY_SCHEMA_SHA256, PORTABLE_RUNTIME_RECOVERY_TABLES,
  PORTABLE_RUNTIME_RECOVERY_MIGRATIONS, PORTABLE_NODE_CHECKPOINT_SCHEMA_SHA256 } from "../../shared/contracts/portable-runtime-v28-recovery-catalog";
const replacements = new Map(COLLABORATION_REPLACEMENT_SCHEMA_OBJECTS_V28.map(object => [object.name, object]));
export const PORTABLE_RUNTIME_SCHEMA_STATEMENTS = Object.freeze(V27_OBJECTS.map(object => replacements.get(object.name) ?? object));
export const PORTABLE_RUNTIME_SEED_TABLE_ROWS = Object.freeze({ ...V27_SEEDS, ...COLLABORATION_SEED_TABLE_ROWS_V28 });

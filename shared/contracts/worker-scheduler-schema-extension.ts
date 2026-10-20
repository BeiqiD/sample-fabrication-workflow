/** One reviewed Worker-only source schema extension. Historical Node catalogs,
 * recovery target DDL and their published checkpoint digests stay unchanged.
 * The observed extended DDL remains in content provenance; cursor rows are
 * installation-local and never supply restored execution authority. */
export const WORKER_SCHEDULER_MIGRATION_NAME = "0025_scheduler_fair_turn.sql" as const;
export const WORKER_SCHEDULER_MIGRATION_SHA256 = "cbc1395de4ad21c1f06606eed804ed8936c073168fbcd8ffff89f77063692e78" as const;
export const WORKER_SCHEDULER_SOURCE_CHECKPOINT_ID = "portable-runtime/v26-worker-scheduler/1" as const;
export const WORKER_SCHEDULER_APPLICATION_SCHEMA_SHA256 = "9ea6ad16a96ccd612f5885bfbfbd4da8494163e91da93e4703f1ebed71356752" as const;
export const WORKER_SCHEDULER_APPLICATION_LEXICAL_SCHEMA_SHA256 = "541853c2d8d2e8a9304e97c1a367b2e0548b1d09295d6058b4c68e0a560647eb" as const;
export const WORKER_SCHEDULER_BUSINESS_SCHEMA_FINGERPRINT_SHA256 = "766858b6c9e76e094df9164786eb16ac9400177edd47c9cbce91edb6ed21d0c4" as const;
export const WORKER_SCHEDULER_RUNTIME_GUARD_DDL = "CREATE TABLE file_job_runtime_guard (\n  singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),\n  enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),\n  incarnation TEXT,\n  last_heartbeat_at TEXT, next_queue TEXT NOT NULL DEFAULT 'package'\n  CHECK(next_queue IN('package','migration')),\n  CHECK(enabled=0 OR (incarnation IS NOT NULL AND length(incarnation) BETWEEN 1 AND 128))\n) WITHOUT ROWID" as const;

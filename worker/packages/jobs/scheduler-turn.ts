import { primaryD1 } from "../../d1-primary";

type Queue = "package" | "migration";
export type ResearchSchedulerTurn =
  | { outcome: "selected"; queue: Queue; incarnation: string }
  | { outcome: "migration_only" | "unsupported" | "disabled" | "paused" | "reconfigured" };

/** Installation-local execution metadata. Claim the preference before running
 * work so a failed or interrupted dispatcher cannot keep the preferred turn.
 * The UPDATE is the arbitration point, including for overlapping invocations. */
export async function claimResearchSchedulerTurn(database: D1Database): Promise<ResearchSchedulerTurn> {
  const db = primaryD1(database);
  const installed = await db.prepare(`SELECT
    (SELECT count(*) FROM sqlite_schema WHERE type='table' AND name IN
      ('file_job_runtime_guard','file_job_cleanup_grants','file_authority_runtime_guard','file_authority_control')) AS file_tables,
    EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='research_package_jobs') AS packages,
    EXISTS(SELECT 1 FROM pragma_table_info('file_job_runtime_guard') WHERE name='next_queue') AS cursor`)
    .first<{ file_tables: number; packages: number; cursor: number }>();
  if (installed?.file_tables !== 4) return { outcome: "unsupported" };
  // Historical FP3 installations have only one queue and need no fair cursor.
  if (installed.packages === 0) return { outcome: "migration_only" };
  // Do not pretend that an in-memory or timestamp fallback is durable fairness.
  if (installed.cursor !== 1) return { outcome: "unsupported" };
  const runtime = await db.prepare(`SELECT j.enabled,j.incarnation,c.mode,g.enabled AS file_enabled
    FROM file_job_runtime_guard j JOIN file_authority_control c ON c.singleton=j.singleton
    JOIN file_authority_runtime_guard g ON g.singleton=j.singleton WHERE j.singleton=1`)
    .first<{ enabled: number; incarnation: string | null; mode: string; file_enabled: number }>();
  if (runtime?.enabled !== 1 || !runtime.incarnation) return { outcome: "disabled" };
  if (runtime.mode !== "active" || runtime.file_enabled !== 1) return { outcome: "paused" };
  const turn = await db.prepare(`UPDATE file_job_runtime_guard
    SET next_queue=CASE next_queue WHEN 'package' THEN 'migration' ELSE 'package' END
    WHERE singleton=1 AND enabled=1 AND incarnation=? AND next_queue IN('package','migration')
      AND EXISTS(SELECT 1 FROM file_authority_control c JOIN file_authority_runtime_guard g
        ON g.singleton=c.singleton AND g.enabled=1 WHERE c.singleton=1 AND c.mode='active')
    RETURNING incarnation,CASE next_queue WHEN 'migration' THEN 'package' ELSE 'migration' END AS queue`)
    .bind(runtime.incarnation).first<{ incarnation: string; queue: Queue }>();
  // Enablement/authority can change after the primary read. Never carry a turn
  // selected under the old incarnation into the newly configured executor.
  if (!turn) return { outcome: "reconfigured" };
  return { outcome: "selected", ...turn };
}

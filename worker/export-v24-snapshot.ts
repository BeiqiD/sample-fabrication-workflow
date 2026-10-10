import { buildFullExportV24FromSnapshot, nativeV24SnapshotSql } from "./export-v24-core";
import type { FullExportManifestV24 } from "../shared/contracts/export";

/** The historical V24 composer retains its exact primary batch and schema
 * projection. Current portable readers use a separately checked checkpoint. */
export async function snapshotFullExportV24(database: D1Database, options: { backupHoldOwner?: string | null } = {}): Promise<FullExportManifestV24> {
  const db = typeof database.withSession === "function" ? database.withSession("first-primary") : database;
  const results = await db.batch(nativeV24SnapshotSql().map(sql => db.prepare(sql)));
  return buildFullExportV24FromSnapshot(results, options);
}

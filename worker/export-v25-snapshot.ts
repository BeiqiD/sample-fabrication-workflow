import { primaryD1 } from "./d1-primary";
import { buildFullExportV24FromSnapshot, nativeV24SnapshotSql, NATIVE_V24_SNAPSHOT_TABLE_NAMES,
  type NativeExportSnapshotResult } from "./export-v24-core";
import { inspectCurrentCloudflareSchema } from "./recovery/current-cloudflare-schema";
import { createFullExportV25, portableBusinessSchema, type FullExportManifestV25 } from "../shared/contracts/export-portable-runtime";
import type { ExportSchemaObject } from "../shared/contracts/export";

/** Actual current research snapshot: only existing business cells and observed
 * schema enter the one primary batch. Protected account/verifier/authority cells
 * are absent from the query inventory and the resulting archive. */
export async function snapshotFullExportV25(database: D1Database): Promise<FullExportManifestV25> {
  const db = primaryD1(database);
  const results = await db.batch(nativeV24SnapshotSql().map(sql => db.prepare(sql)));
  const schema = results[NATIVE_V24_SNAPSHOT_TABLE_NAMES.length];
  if (!schema?.success) throw new Error("Current research schema snapshot unavailable");
  const observed = await inspectCurrentCloudflareSchema(schema.results as ExportSchemaObject[]);
  const business = await buildFullExportV24FromSnapshot(results as NativeExportSnapshotResult[], {
    projectSchema: () => portableBusinessSchema(observed.applicationObjects),
  });
  return createFullExportV25(business, observed.applicationObjects);
}

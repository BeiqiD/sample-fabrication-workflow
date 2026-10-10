import type { ReadSqlDatabase } from "../runtime/read-sql";
import { configurationSqlInteger } from "../runtime/configuration-sql";

export type FileAuthorityMode = "legacy" | "overlap" | "active";

export class FileAuthorityUnavailableError extends Error {
  constructor() { super("File storage is unavailable"); this.name = "FileAuthorityUnavailableError"; }
}

/** Metadata-only authority admission. Each read selects its real primary owner;
 * actual table absence retains contracted S1/S2 behavior, every other failure
 * stays unavailable. No provider location or byte stream is opened here. */
export async function readSqlFileAuthorityMode(selectDatabase: () => ReadSqlDatabase): Promise<FileAuthorityMode> {
  try {
    const row = await selectDatabase().prepare("SELECT mode FROM file_authority_control WHERE singleton=1")
      .first();
    if (row?.mode === "legacy" || row?.mode === "overlap" || row?.mode === "active") return row.mode;
  } catch {
    // The contracted Worker remains compatible with the S1/S2 schema. Check
    // actual schema absence rather than treating a failed authority read as legacy.
    try {
      const schema = await selectDatabase().prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name IN ('file_authority_control','storage_profiles')",
      ).first();
      if (schema && configurationSqlInteger(schema.count, "fileAuthority.schemaTableCount") === 0) return "legacy";
    } catch { /* Database failure is still unavailable. */ }
  }
  throw new FileAuthorityUnavailableError();
}

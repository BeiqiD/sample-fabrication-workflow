import type { FilePurpose } from "../../shared/contracts/files";
import { primaryD1 } from "../d1-primary";
import type { Env } from "../types";
import type { ByteReadResult } from "./byte-reader";
import { openShadowProfile } from "./shadow-profile";

export type FileAuthorityMode = "legacy" | "overlap" | "active";

export class FileAuthorityUnavailableError extends Error {
  constructor() { super("File storage is unavailable"); this.name = "FileAuthorityUnavailableError"; }
}

/** Pre-FP1 databases retain legacy behavior. An installed but unavailable or
 * invalid authority never grants permission to use a legacy locator. */
export async function readFileAuthorityMode(db: D1Database): Promise<FileAuthorityMode> {
  try {
    const row = await primaryD1(db).prepare("SELECT mode FROM file_authority_control WHERE singleton=1")
      .first<{ mode: string }>();
    if (row?.mode === "legacy" || row?.mode === "overlap" || row?.mode === "active") return row.mode;
  } catch {
    // The contracted Worker remains compatible with the S1/S2 schema. Check
    // actual schema absence rather than treating a failed authority read as legacy.
    try {
      const schema = await primaryD1(db).prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name IN ('file_authority_control','storage_profiles')",
      ).first<{ count: number }>();
      if (schema?.count === 0) return "legacy";
    } catch { /* Database failure is still unavailable. */ }
  }
  throw new FileAuthorityUnavailableError();
}

/** The caller authorizes the business occurrence and supplies its typed binding.
 * Read admission uses its published active location, never a legacy locator or
 * the currently configured upload destination. Stream ownership passes to the
 * caller; opening a stream does not claim new content verification. */
export async function readPublishedFile(
  env: Env,
  input: { fileId: string | null; purpose: FilePurpose },
): Promise<ByteReadResult> {
  if (!input.fileId) return { outcome: "missing" };
  try {
    const row = await primaryD1(env.DB).prepare(`
      SELECT l.storage_profile_id, l.object_key, p.configuration_revision
      FROM file_usable_publications f
      JOIN file_location_publications l ON l.location_id=f.active_location_id AND l.file_id=f.file_id
      JOIN storage_profiles p ON p.id=l.storage_profile_id
      JOIN file_authority_control a ON a.singleton=1 AND a.mode='active'
      WHERE f.file_id=? AND f.purpose=? AND f.access_scope='system'
        AND l.verified_byte_size=f.verified_byte_size AND l.verified_sha256=f.verified_sha256
    `).bind(input.fileId, input.purpose).first<{
      storage_profile_id: string; object_key: string; configuration_revision: number;
    }>();
    if (!row) return { outcome: "missing" };
    const profile = await openShadowProfile(env, {
      profileId: row.storage_profile_id, configurationRevision: row.configuration_revision,
    }, "read");
    return await profile.reader.read(row.object_key);
  } catch { return { outcome: "unavailable" }; }
}

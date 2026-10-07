import type { FilePurpose } from "../../shared/contracts/files";
import { primaryD1 } from "../d1-primary";
import type { Env } from "../types";
import type { ByteReadResult } from "./byte-reader";
import { openShadowProfile } from "./shadow-profile";

export type FileAuthorityMode = "legacy" | "overlap" | "active";

export class FileAuthorityUnavailableError extends Error {
  constructor() { super("File storage is unavailable"); this.name = "FileAuthorityUnavailableError"; }
}

export const FILE_READ_MAX_LIFETIME_MS = 2 * 60_000;
export const FILE_READ_HOLD_MS = 15 * 60_000;

/** Stream delivery ends before its durable location hold can expire. A lost
 * process leaves a conservative hold; EOF/cancellation releases it explicitly. */
function heldReadBody(body: ReadableStream, deadline: number, release: () => Promise<void>) {
  const reader = body.getReader();
  let ended = false, timer: ReturnType<typeof setTimeout>, controller: ReadableStreamDefaultController;
  const finish = async (cancel: boolean) => {
    if (ended) return;
    ended = true; clearTimeout(timer);
    try { if (cancel) await reader.cancel().catch(() => undefined); }
    finally { reader.releaseLock(); await release().catch(() => undefined); }
  };
  return new ReadableStream({
    start(output) {
      controller = output;
      timer = setTimeout(() => {
        if (!ended) { controller.error(new FileAuthorityUnavailableError()); void finish(true); }
      }, Math.max(0, deadline - Date.now()));
    },
    async pull(output) {
      try {
        const next = await reader.read();
        if (ended) return;
        if (Date.now() >= deadline) { output.error(new FileAuthorityUnavailableError()); await finish(true); return; }
        if (next.done) { output.close(); await finish(false); } else output.enqueue(next.value);
      } catch (error) { if (!ended) output.error(error); await finish(true); }
    },
    cancel() { return finish(true); },
  }, { highWaterMark: 0 });
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
  const database = env.DB, holdId = crypto.randomUUID(), acquired = Date.now();
  const deadline = acquired + FILE_READ_MAX_LIFETIME_MS;
  const abort = new AbortController();
  const requestTimer = setTimeout(() => abort.abort(), FILE_READ_MAX_LIFETIME_MS);
  (requestTimer as unknown as { unref?: () => void }).unref?.();
  let acquiredHold = false;
  const release = async () => {
    clearTimeout(requestTimer);
    if (!acquiredHold) return;
    await primaryD1(database).prepare("UPDATE file_location_holds SET released_at=? WHERE id=? AND released_at IS NULL")
      .bind(new Date().toISOString(), holdId).run();
  };
  try {
    // Capture pointer and acquire its location hold in one primary SQL command.
    // A cutover after this statement retains the old stream's exact location;
    // the native hold guard arbitrates a concurrent GC deletion claim.
    await primaryD1(database).prepare(`INSERT INTO file_location_holds(id,location_id,hold_kind,operation_id,reason,acquired_at,expires_at)
      SELECT ?,f.active_location_id,'read',?,'Published File read',?,? FROM file_usable_publications f
      JOIN file_authority_control a ON a.singleton=1 AND a.mode='active'
      WHERE f.file_id=? AND f.purpose=? AND f.access_scope='system'`)
      .bind(holdId, holdId, new Date(acquired).toISOString(), new Date(acquired + FILE_READ_HOLD_MS).toISOString(), input.fileId, input.purpose).run();
    const row = await primaryD1(database).prepare(`
      SELECT l.storage_profile_id, l.object_key, p.configuration_revision
      FROM file_location_holds h
      JOIN file_location_publications l ON l.location_id=h.location_id
      JOIN storage_profiles p ON p.id=l.storage_profile_id
      WHERE h.id=? AND h.released_at IS NULL AND julianday(h.expires_at)>julianday('now')
    `).bind(holdId).first<{
      storage_profile_id: string; object_key: string; configuration_revision: number;
    }>();
    if (!row) { clearTimeout(requestTimer); return { outcome: "missing" }; }
    acquiredHold = true;
    const profile = await openShadowProfile(env, {
      profileId: row.storage_profile_id, configurationRevision: row.configuration_revision,
    }, "read", { signal: abort.signal, beforeRequest: async () => !abort.signal.aborted && Date.now() < deadline });
    const read = await profile.reader.read(row.object_key);
    if (read.outcome !== "available") { await release(); return read; }
    if (Date.now() >= deadline) { await read.body.cancel(); await release(); return { outcome: "unavailable" }; }
    return { ...read, body: heldReadBody(read.body, deadline, release) };
  } catch { await release().catch(() => undefined); return { outcome: "unavailable" }; }
}

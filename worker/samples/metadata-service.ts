import { HTTPException } from "hono/http-exception";
import { DEFAULT_SAMPLE_STATUS, isSampleStatus } from "../../shared/types";
import { validateCreateSampleInput, validateUpdateSampleInput } from "../sample-input";
import { titleChangeAudit } from "../sample-update";
import { configurationSqlInteger, type ConfigurationSqlDatabase, type ConfigurationSqlRow } from "../runtime/configuration-sql";

/** Reuses the reviewed exact-cell, top-level-mutation capability. This slice
 * does not admit execution CTEs, RETURNING batches, schema or provider work. */
export type SampleMetadataDatabase = ConfigurationSqlDatabase;
export interface SampleMetadataCapabilities {
  database(): SampleMetadataDatabase;
  /** Required trusted composer policy: current authenticated account and
   * installation write admission. Actor spelling never supplies permission. */
  admit(actor: string): Promise<void>;
  now(): number;
  randomId(): string;
}
export type SampleMetadataWrite = { ok: true; updatedAt: string };
export type SampleMetadataDeletion = SampleMetadataWrite & {
  deleted: { runs: number; steps: number; events: number; verifications: number; childrenDetached: 0 };
};
function text(row: ConfigurationSqlRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError(`Invalid sample metadata: ${field}`);
  return value;
}
function nullableText(row: ConfigurationSqlRow, field: string): string | null {
  return row[field] === null ? null : text(row, field);
}
function pinnedFlag(row: ConfigurationSqlRow): boolean {
  // The retained schema has permissive INTEGER affinity, without a 0/1 CHECK.
  // Preserve the original Boolean rule on an already-validated exact SQL cell;
  // no integer, decimal, text or blob is globally converted to Number.
  if (!("pinned" in row)) throw new TypeError("Invalid sample metadata: pinned");
  return Boolean(row.pinned);
}
function confirmation(value: unknown): { confirmationCode: string; expectedUpdatedAt: string } {
  if (!value || typeof value !== "object" || !("confirmationCode" in value) || !("expectedUpdatedAt" in value)
    || typeof value.confirmationCode !== "string" || typeof value.expectedUpdatedAt !== "string") {
    throw new HTTPException(400, { message: "The sample code and current revision are required" });
  }
  return { confirmationCode: value.confirmationCode, expectedUpdatedAt: value.expectedUpdatedAt };
}

/** Four existing Samples metadata mutations. SQL owns each atomic write;
 * uncertain acknowledgements propagate as before, without guessing a replay. */
export function createSampleMetadataService(capabilities: SampleMetadataCapabilities) {
  return {
    async create(value: unknown, actor: string): Promise<{ id: string }> {
      const validation = validateCreateSampleInput(value);
      if (!validation.ok) throw new HTTPException(400, { message: validation.error });
      const input = validation.input, code = input.code.trim(), title = input.title.trim();
      const id = capabilities.randomId(), eventId = capabilities.randomId(), now = new Date(capabilities.now()).toISOString();
      await capabilities.admit(actor);
      const db = capabilities.database();
      const statements = [
        db.prepare(`INSERT INTO samples (id, code, title, description, status, location, created_by, updated_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, code, title, input.description?.trim() || null,
          input.status ?? DEFAULT_SAMPLE_STATUS, input.location?.trim() || null, actor, actor, now, now),
        db.prepare("INSERT INTO events (id, sample_id, kind, body, actor_email, created_at) VALUES (?, ?, 'created', ?, ?, ?)")
          .bind(eventId, id, `Sample ${code} created`, actor, now),
      ];
      await capabilities.admit(actor);
      try { await db.batch(statements); }
      catch (error) {
        if (String(error).includes("UNIQUE")) throw new HTTPException(409, { message: `Sample code ${code} already exists` });
        throw error;
      }
      return { id };
    },
    async update(id: string, value: unknown, actor: string): Promise<SampleMetadataWrite> {
      const validation = validateUpdateSampleInput(value);
      if (!validation.ok) throw new HTTPException(400, { message: validation.error });
      const input = validation.input;
      await capabilities.admit(actor);
      const db = capabilities.database();
      const current = await db.prepare(`SELECT title, description, status, location, pinned, updated_at
        FROM samples WHERE id = ? AND deleted_at IS NULL`).bind(id).first();
      if (!current) throw new HTTPException(404, { message: "Sample not found" });
      const updatedAt = text(current, "updated_at");
      if (updatedAt !== input.expectedUpdatedAt) {
        throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before saving." });
      }
      const title = text(current, "title"), description = nullableText(current, "description"), location = nullableText(current, "location");
      const status = text(current, "status"), pinned = pinnedFlag(current);
      if (!isSampleStatus(status)) throw new TypeError("Invalid sample metadata state");
      const nextTitle = input.title === undefined ? title : input.title.trim();
      const nextDescription = input.description === undefined ? description : input.description.trim() || null;
      const nextStatus = input.status ?? status;
      const nextLocation = input.location === undefined ? location : input.location.trim() || null;
      const nextPinned = input.pinned === undefined ? pinned : input.pinned;
      const changed = nextTitle !== title || nextDescription !== description || nextLocation !== location || nextStatus !== status || nextPinned !== pinned;
      if (!changed) {
        await capabilities.admit(actor);
        return { ok: true, updatedAt };
      }
      const now = new Date(capabilities.now()).toISOString(), mutationId = capabilities.randomId(), titleAudit = titleChangeAudit(title, nextTitle);
      const statements = [db.prepare(`UPDATE samples SET title = ?, description = ?, status = ?, location = ?, pinned = ?, updated_by = ?, last_mutation_id = ?, updated_at = ?
        WHERE id = ? AND updated_at = ? AND deleted_at IS NULL`).bind(nextTitle, nextDescription, nextStatus, nextLocation,
        nextPinned ? 1 : 0, actor, mutationId, now, id, input.expectedUpdatedAt)];
      if (titleAudit) statements.push(db.prepare(`INSERT INTO events (id, sample_id, kind, body, metadata_json, actor_email, created_at)
        SELECT ?, id, 'comment', ?, ?, ?, ? FROM samples WHERE id = ? AND last_mutation_id = ? AND deleted_at IS NULL`)
        .bind(capabilities.randomId(), titleAudit.body, JSON.stringify(titleAudit.metadata), actor, now, id, mutationId));
      await capabilities.admit(actor);
      const results = await db.batch(statements);
      if (!results[0]?.directChanges) throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before saving." });
      if (titleAudit && !results[1]?.directChanges) throw new Error("Sample title audit event was not created");
      return { ok: true, updatedAt: now };
    },
    async remove(id: string, value: unknown, actor: string): Promise<SampleMetadataDeletion> {
      const input = confirmation(value);
      await capabilities.admit(actor);
      const db = capabilities.database();
      const sample = await db.prepare(`SELECT s.code, s.updated_at,
        (SELECT COUNT(*) FROM runs r WHERE r.sample_id = s.id) AS run_count,
        (SELECT COUNT(*) FROM run_steps rs JOIN runs r ON r.id = rs.run_id WHERE r.sample_id = s.id) AS step_count,
        (SELECT COUNT(*) FROM events e WHERE e.sample_id = s.id) AS event_count,
        (SELECT COUNT(*) FROM state_verifications sv WHERE sv.sample_id = s.id) AS verification_count,
        (SELECT COUNT(*) FROM samples child WHERE child.parent_id = s.id) AS child_count
        FROM samples s WHERE s.id = ? AND s.deleted_at IS NULL`).bind(id).first();
      if (!sample) throw new HTTPException(404, { message: "Sample not found" });
      const code = text(sample, "code"), updatedAt = text(sample, "updated_at");
      if (input.confirmationCode !== code) throw new HTTPException(400, { message: "The confirmation code does not match the sample code" });
      if (input.expectedUpdatedAt !== updatedAt) throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before deleting." });
      // Only these public count fields cross to Number. Other exact cells,
      // including child_count, remain untouched; deletion never detaches rows.
      const deleted = { runs: configurationSqlInteger(sample.run_count, "sample deletion run_count"),
        steps: configurationSqlInteger(sample.step_count, "sample deletion step_count"),
        events: configurationSqlInteger(sample.event_count, "sample deletion event_count"),
        verifications: configurationSqlInteger(sample.verification_count, "sample deletion verification_count"), childrenDetached: 0 as const };
      const now = new Date(Math.max(capabilities.now(), Date.parse(updatedAt) + 1)).toISOString();
      const statement = db.prepare(`UPDATE samples SET deleted_at = ?, deleted_by = ?, updated_by = ?, last_mutation_id = ?, updated_at = ?
        WHERE id = ? AND code = ? AND updated_at = ? AND deleted_at IS NULL`)
        .bind(now, actor, actor, capabilities.randomId(), now, id, code, updatedAt);
      await capabilities.admit(actor);
      const [result] = await db.batch([statement]);
      if (!result?.directChanges) throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before deleting." });
      return { ok: true, updatedAt: now, deleted };
    },
    async restore(id: string, value: unknown, actor: string): Promise<SampleMetadataWrite> {
      const input = confirmation(value);
      await capabilities.admit(actor);
      const db = capabilities.database();
      const sample = await db.prepare("SELECT code, updated_at, deleted_at FROM samples WHERE id = ? AND deleted_at IS NOT NULL").bind(id).first();
      if (!sample) throw new HTTPException(404, { message: "Deleted sample not found" });
      const code = text(sample, "code"), updatedAt = text(sample, "updated_at"), deletedAt = text(sample, "deleted_at");
      if (input.confirmationCode !== code) throw new HTTPException(400, { message: "The confirmation code does not match the sample code" });
      if (input.expectedUpdatedAt !== updatedAt) throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before restoring." });
      const now = new Date(Math.max(capabilities.now(), Date.parse(updatedAt) + 1)).toISOString();
      const statement = db.prepare(`UPDATE samples SET deleted_at = NULL, deleted_by = NULL, updated_by = ?, last_mutation_id = ?, updated_at = ?
        WHERE id = ? AND code = ? AND updated_at = ? AND deleted_at = ?`)
        .bind(actor, capabilities.randomId(), now, id, code, updatedAt, deletedAt);
      await capabilities.admit(actor);
      const [result] = await db.batch([statement]);
      if (!result?.directChanges) throw new HTTPException(409, { message: "This sample changed elsewhere. Reload it before restoring." });
      return { ok: true, updatedAt: now };
    },
  };
}
export type SampleMetadataService = ReturnType<typeof createSampleMetadataService>;

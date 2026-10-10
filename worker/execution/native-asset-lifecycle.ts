import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import { primaryD1 } from "../d1-primary";
import { consumerFileBindingFence, resolveConsumerFileId } from "../files/consumer-binding";

/** Native execution occurrences are addressed by their real asset alias. The
 * occurrence, exact typed File, event metadata and parent revisions move together. */
export async function changeNativeExecutionAsset(env: Env, input: {
  sampleId: string; runId: string; stepId: string; assetId: string; actor: string; restore: boolean;
}) {
  if (!input.assetId || input.assetId.length > 256 || input.assetId.includes("\0")) throw new HTTPException(400, { message: "A valid image attachment is required" });
  const db = primaryD1(env.DB);
  const row = await db.prepare(`SELECT rsa.id,rsa.file_id,rsa.deleted_at,rs.updated_at,s.updated_at sample_updated_at
    FROM run_step_assets rsa JOIN run_steps rs ON rs.id=rsa.run_step_id JOIN runs r ON r.id=rs.run_id
    JOIN samples s ON s.id=r.sample_id JOIN assets a ON a.id=rsa.asset_id
    JOIN file_authority_control control ON control.singleton=1 AND control.mode='active'
    WHERE rsa.run_step_id=? AND r.id=? AND s.id=? AND a.id=? AND a.r2_key IS NULL AND a.status='ready'
      AND rsa.role='execution' AND rsa.superseded_by_occurrence_id IS NULL
      AND s.deleted_at IS NULL AND r.deleted_at IS NULL AND rs.deleted_at IS NULL
      AND ${input.restore ? "rsa.deleted_at IS NOT NULL" : "rsa.deleted_at IS NULL"}`)
    .bind(input.stepId, input.runId, input.sampleId, input.assetId)
    .first<{ id: string; file_id: string; deleted_at: string | null; updated_at: string; sample_updated_at: string }>();
  if (!row) throw new HTTPException(404, { message: "Execution image not found" });
  const binding = { assetId: input.assetId, nativeAsset: true, purpose: "embedded_content" as const };
  if (input.restore && await resolveConsumerFileId(db, binding) !== row.file_id) throw new HTTPException(409, { message: "The original image is unavailable" });
  const now = new Date(Math.max(Date.now(), Date.parse(row.updated_at) + 1, Date.parse(row.sample_updated_at) + 1,
    row.deleted_at ? Date.parse(row.deleted_at) + 1 : 0)).toISOString();
  const mutationId = crypto.randomUUID();
  const statements = [
    ...(input.restore ? [consumerFileBindingFence(db, binding, row.file_id)] : []),
    db.prepare(`UPDATE run_step_assets SET deleted_at=?,deleted_by=?,last_mutation_id=?
      WHERE id=? AND run_step_id=? AND asset_id=? AND file_id=? AND deleted_at IS ? AND superseded_by_occurrence_id IS NULL
        AND EXISTS(SELECT 1 FROM run_steps rs JOIN runs r ON r.id=rs.run_id JOIN samples s ON s.id=r.sample_id
          WHERE rs.id=? AND r.id=? AND s.id=? AND rs.updated_at=? AND s.updated_at=?
            AND rs.deleted_at IS NULL AND r.deleted_at IS NULL AND s.deleted_at IS NULL)`)
      .bind(input.restore ? null : now, input.restore ? null : input.actor, mutationId, row.id, input.stepId,
        input.assetId, row.file_id, row.deleted_at, input.stepId, input.runId, input.sampleId, row.updated_at, row.sample_updated_at),
    db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('Execution image changed') END"),
    db.prepare(`UPDATE events SET metadata_json=${input.restore
      ? "json_remove(metadata_json,'$.assetDeletedAt','$.assetDeletedBy','$.assetMutationId')"
      : "json_set(metadata_json,'$.assetDeletedAt',?,'$.assetDeletedBy',?,'$.assetMutationId',?)"}
      WHERE sample_id=? AND asset_file_id=? AND asset_key IS NULL AND json_valid(metadata_json)
        AND json_extract(metadata_json,'$.runId')=? AND json_extract(metadata_json,'$.stepId')=?
        AND json_extract(metadata_json,'$.runStepAssetId')=?`)
      .bind(...(input.restore ? [] : [now, input.actor, mutationId]), input.sampleId, row.file_id, input.runId, input.stepId, row.id),
    db.prepare("UPDATE run_steps SET updated_at=?,updated_by=? WHERE id=? AND run_id=? AND updated_at=?")
      .bind(now, input.actor, input.stepId, input.runId, row.updated_at),
    db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('Execution step changed') END"),
    db.prepare("UPDATE samples SET updated_at=?,updated_by=? WHERE id=? AND updated_at=?")
      .bind(now, input.actor, input.sampleId, row.sample_updated_at),
    db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('Execution sample changed') END"),
    db.prepare(`INSERT INTO events(id,sample_id,kind,body,metadata_json,actor_email,created_at) VALUES(?,?,'image',?,?,?,?)`)
      .bind(crypto.randomUUID(), input.sampleId, input.restore ? "Restored execution image attachment" : "Deleted execution image attachment",
        JSON.stringify({ action: input.restore ? "execution_attachment_restored" : "execution_attachment_deleted",
          runId: input.runId, stepId: input.stepId, runStepAssetId: row.id, assetId: input.assetId, hadAsset: true }), input.actor, now),
  ];
  try { await db.batch(statements); } catch { throw new HTTPException(409, { message: "The execution image changed before this action completed" }); }
  return { ok: true, updatedAt: now };
}

import { HTTPException } from "hono/http-exception";
import { readFileAuthorityMode } from "./authority-reader";

const active = "EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='active')";

// Select in JS so contracted S1/S2 databases never parse future schema names.
export async function fileAuthorityActiveSql(db: D1Database): Promise<"1" | "0"> {
  return await readFileAuthorityMode(db) === "active" ? "1" : "0";
}
/** Deletion changes visibility; an active typed binding keeps its legacy alias. */
export async function deletedEventAssetSql(db: D1Database) {
  return await readFileAuthorityMode(db) === "active" ? "asset_key" : "NULL";
}
export async function deletedVerificationAssetSql(db: D1Database) {
  return await readFileAuthorityMode(db) === "active" ? "evidence_asset_id" : "NULL";
}
export async function deletedEventMetadataSql(db: D1Database) {
  return await readFileAuthorityMode(db) === "active"
    ? `json_patch(?, CASE WHEN json_type(metadata_json, '$.thumbnailKey')='text'
      THEN json_object('thumbnailKey', json_extract(metadata_json, '$.thumbnailKey')) ELSE '{}' END)` : "?";
}

type RestoreKind = "execution" | "legacy_comment_asset" | "legacy_comment" | "comment_item" | "comment_submission" | "project_attachment" | "metrology_reference";

/** Restore exact recorded occurrences, never infer a replacement File from bytes.
 * The returned assertion runs before mutation in the same transaction. */
export async function prepareFileRestoration(db: D1Database, kind: RestoreKind, ids: string[]): Promise<D1PreparedStatement[]> {
  if (!ids.length || await readFileAuthorityMode(db) !== "active") return [];
  const placeholders = ids.map(() => "?").join(",");
  const ordinary = (table: string, id = "id", where = "1", purpose = "'embedded_content'") =>
    `SELECT file_id,${purpose} purpose FROM ${table} WHERE ${id} IN (${placeholders}) AND ${where}`;
  const rows = kind === "execution" ? ordinary("run_step_assets")
    : kind === "legacy_comment_asset" ? ordinary("run_step_comments", "id", "asset_id IS NOT NULL")
    : kind === "legacy_comment" ? ordinary("run_step_comments", "id", "asset_id IS NOT NULL AND asset_deleted_at IS NULL")
    : kind === "project_attachment" ? ordinary("project_content_attachments", "project_content_id", "1", "'research_source'")
    : kind === "metrology_reference" ? ordinary("metrology_template_references", "id", "1", "'research_source'")
    : ordinary("comment_submission_items", kind === "comment_item" ? "id" : "submission_id",
      `kind<>'link' AND status='ready'${kind === "comment_submission" ? " AND deleted_at IS NULL" : ""}`,
      "CASE WHEN kind='attachment' THEN 'research_source' WHEN related_item_id IS NOT NULL THEN 'derived_preview' ELSE 'embedded_content' END");
  const available = `NOT EXISTS(SELECT 1 FROM (${rows}) target WHERE NOT EXISTS(
    SELECT 1 FROM file_usable_publications f WHERE f.file_id=target.file_id
      AND f.purpose=target.purpose AND f.access_scope='system'))`;
  const result = await db.prepare(`SELECT ${available} AS available`).bind(...ids).first<{ available: number }>();
  if (!result?.available) throw new HTTPException(409, { message: "The attachment File is unavailable for restoration" });
  return [db.prepare(`SELECT CASE WHEN ${active} AND ${available} THEN 1
    ELSE json('Attachment File changed before restoration') END`).bind(...ids)];
}

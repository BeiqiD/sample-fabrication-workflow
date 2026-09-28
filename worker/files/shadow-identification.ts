import { checkedFileShadowIdentification, MAX_FILE_SHADOW_IDENTIFICATION_LABEL_BYTES, MAX_FILE_SHADOW_REVIEW_KEY_BYTES } from "../../shared/contracts/file-shadow-evidence-review";

// Static aliases shared by both read paths. Labels identify a reference; they
// never enter a baseline digest, purpose classifier, or namespace evidence.
export const SHADOW_IDENTIFICATION_JOINS_SQL = `LEFT JOIN project_content_attachments review_attachment
  ON h.consumer_kind='project_content_attachment' AND h.file_slot='primary' AND h.consumer_sub_id=''
  AND review_attachment.project_content_id=h.consumer_id
  LEFT JOIN project_contents review_content ON review_content.id=review_attachment.project_content_id
  LEFT JOIN projects review_project ON review_project.id=review_content.project_id`;
const identification = `CASE WHEN review_project.id IS NULL THEN NULL
  WHEN typeof(review_project.id)='text' AND length(CAST(review_project.id AS BLOB))<=${MAX_FILE_SHADOW_REVIEW_KEY_BYTES}
    AND typeof(review_project.title)='text' AND length(CAST(review_project.title AS BLOB))<=${MAX_FILE_SHADOW_IDENTIFICATION_LABEL_BYTES}
    AND typeof(review_attachment.original_name)='text' AND length(CAST(review_attachment.original_name AS BLOB))<=${MAX_FILE_SHADOW_IDENTIFICATION_LABEL_BYTES}
  THEN json_object('projectId',review_project.id,'projectTitle',review_project.title,'attachmentName',review_attachment.original_name)
  ELSE NULL END`;
export const SHADOW_IDENTIFICATION_COLUMN_SQL = `${identification} identification_json`;
export const SHADOW_IDENTIFICATION_EXACT_SQL = `(SELECT ${identification} FROM file_shadow_heads h ${SHADOW_IDENTIFICATION_JOINS_SQL}
  WHERE h.consumer_kind=?2 AND h.consumer_id=?3 AND h.consumer_sub_id=?4 AND h.file_slot=?5 AND h.present=1) identification_json,`;
export function readShadowIdentification(value: unknown) {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Invalid File shadow identification snapshot");
  // JSON escaping can exceed the optional label envelope even when every raw
  // SQL field is bounded. Omit those hints without breaking exact-key review.
  if (new TextEncoder().encode(value).length > 80 * 1024) return null;
  return checkedFileShadowIdentification(JSON.parse(value));
}

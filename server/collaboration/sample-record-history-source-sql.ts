/** Fixed original legacy deletion provenance, never a Request or read grant.
 * The caller still denies every canonical/media/submission source and captures
 * all actual event cells before its original projection in the same BEGIN. */
type Alias = "audit" | "record" | "deletionAudit";
const metadata = (alias: Alias) => `(CASE WHEN json_valid(${alias}.metadata_json) THEN ${alias}.metadata_json ELSE '{}' END)`;
const field = (alias: Alias, key: string) => `json_extract(${metadata(alias)},'$.${key}')`;
const type = (alias: Alias, key: string) => `json_type(${metadata(alias)},'$.${key}')`;
function exactObject(alias: Alias, keys: readonly string[]) {
  return `(json_valid(${alias}.metadata_json) AND json_type(${metadata(alias)})='object'
    AND (SELECT count(*) FROM json_each(${metadata(alias)}))=${keys.length}
    AND (SELECT count(DISTINCT key) FROM json_each(${metadata(alias)}))=${keys.length}
    AND NOT EXISTS(SELECT 1 FROM json_each(${metadata(alias)}) cell WHERE cell.key NOT IN(${keys.map(key => `'${key}'`).join(",")})))`;
}
const mediaFree = (alias: Alias) => `${alias}.kind='comment' AND ${alias}.asset_key IS NULL
  AND ${alias}.asset_file_id IS NULL AND ${alias}.thumbnail_file_id IS NULL`;
function deletedRecord(alias: Alias) {
  const operation = field(alias, "deletionOperationId");
  return `(${mediaFree(alias)}
    AND ${exactObject(alias, ["action", "deletedAt", "deletedBy", "deletionOperationId", "hadAsset"])}
    AND ${type(alias, "action")}='text' AND ${field(alias, "action")} IS 'sample_record'
    AND ${type(alias, "deletedAt")}='text' AND length(${field(alias, "deletedAt")}) BETWEEN 1 AND 64
    AND ${type(alias, "deletedBy")}='text' AND length(${field(alias, "deletedBy")}) BETWEEN 1 AND 512
    AND ${type(alias, "hadAsset")}='false'
    AND ${type(alias, "deletionOperationId")}='text' AND length(${operation})=36
    AND substr(${operation},9,1)='-' AND substr(${operation},14,1)='-'
    AND substr(${operation},19,1)='-' AND substr(${operation},24,1)='-'
    AND length(replace(${operation},'-',''))=32 AND replace(${operation},'-','') NOT GLOB '*[^0-9a-f]*'
    AND typeof(${alias}.body)='text' AND length(${alias}.body) BETWEEN 1 AND 10000)`;
}
function deletionAudit(alias: Alias) {
  return `(${mediaFree(alias)}
    AND ${exactObject(alias, ["action", "originalEventId", "hadAsset"])}
    AND ${type(alias, "action")}='text' AND ${field(alias, "action")} IS 'sample_record_deleted'
    AND ${type(alias, "originalEventId")}='text' AND ${field(alias, "originalEventId")}<>${alias}.id
    AND ${type(alias, "hadAsset")}='false')`;
}
function pair(record: Alias, audit: Alias) {
  return `(${deletedRecord(record)} AND ${deletionAudit(audit)}
    AND ${audit}.sample_id=${record}.sample_id AND ${field(audit, "originalEventId")}=${record}.id
    AND ${audit}.actor_email IS ${field(record, "deletedBy")}
    AND ${audit}.created_at IS ${field(record, "deletedAt")}
    AND ${audit}.body IS ('Deleted sample record · '||COALESCE(NULLIF(trim(${record}.body),''),'Empty record')))`;
}

/** Closed caller alias. The three branches are the original sole-action
 * record, its precisely paired original deletion, or that deletion's audit.
 * No generic deleted/unknown metadata or canonical lineage is accepted. */
export function sampleRecordHistoryCommentEligibilitySql(alias: "audit") {
  if (alias !== "audit") throw new Error("Closed Sample record history alias required");
  return `(
    (${exactObject("audit", ["action"])} AND ${type("audit", "action")}='text'
      AND ${field("audit", "action")} IS 'sample_record')
    OR (${deletedRecord("audit")} AND
      (SELECT count(*) FROM events deletionAudit WHERE ${pair("audit", "deletionAudit")})=1)
    OR (${deletionAudit("audit")} AND EXISTS(SELECT 1 FROM events record
      WHERE record.id=${field("audit", "originalEventId")} AND ${pair("record", "audit")}
        AND (SELECT count(*) FROM events deletionAudit WHERE ${pair("record", "deletionAudit")})=1))
  )`;
}

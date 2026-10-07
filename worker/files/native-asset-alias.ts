import type { StagedAuthorityCandidate } from "./authority-candidates";
import type { VerifiedAuthorityPublication } from "./authority-publication";

const recoveryAliasColumns = ["id", "import_id", "r2_key", "original_name", "mime_type", "byte_size", "status", "sha256",
  "actor_email", "created_at", "file_id", "storage_profile_id", "storage_profile_revision", "object_key"] as const;
const recoveryLocatorColumns = ["sourceId", "locatorId", "storeKind", "provider", "byteAuthority", "storageProfileId",
  "storageProfileRevision", "locationId", "objectKey", "expectedByteSize", "expectedSha256"] as const;
function checkedAlias(alias: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error("Invalid recovery alias SQL identifier");
  return alias;
}
function closedRecoveryJson(expression: string, columns: readonly string[]) {
  return `(SELECT count(*)=${columns.length} AND count(DISTINCT key)=${columns.length}
    AND sum(key NOT IN(${columns.map(column => `'${column}'`).join(",")}))=0 FROM json_each(${expression}))`;
}
/** D1 counts the depth of expanded views as well as this predicate. Preserve
 * every reviewed comparison while keeping conjunction depth logarithmic. */
function balancedRecoveryConjunction(conditions: readonly string[]): string {
  if (conditions.length === 1) return conditions[0];
  const middle = Math.floor(conditions.length / 2);
  return `(${balancedRecoveryConjunction(conditions.slice(0, middle))} AND ${balancedRecoveryConjunction(conditions.slice(middle))})`;
}

/** Historical schemas retain their original query: even an OR expression
 * cannot refer to an absent table during SQLite statement preparation. */
export async function hasRecoveryAssetAliasEvidence(database: {
  prepare(sql: string): { first<T>(): Promise<T | null> };
}): Promise<boolean> {
  const row = await database.prepare(`SELECT count(*) installed FROM sqlite_schema WHERE type='table'
    AND name IN('recovery_file_evidence','recovery_file_alias_evidence','recovery_file_binding_evidence')`).first<{ installed: number }>();
  return row?.installed === 3;
}

/** A recovered legacy alias retains every original metadata cell except its
 * nullable File binding. Its independently verified recovery publication
 * authenticates that identity; delivery still follows the current usable File,
 * including a later migration and GC of the historical recovery placement.
 * Callers provide only reviewed SQL aliases, never request-supplied SQL. */
export function qualifiedRecoveryLegacyAssetAliasSql(assetAlias = "a", fileAlias = "f", binding?: { stateAlias: string }): string {
  const asset = checkedAlias(assetAlias), file = checkedAlias(fileAlias);
  const locator = (column: string) => `json_extract(rfe.source_locator_json,'$.${column}')`;
  const original = (column: string) => `json_extract(rae.original_json,'$.${column}')`;
  const state = binding ? checkedAlias(binding.stateAlias) : null;
  const conditions = [
    "rae.table_name='assets'", `rae.alias_id=${asset}.id`, `rae.destination_file_id=${asset}.file_id`,
    `${asset}.r2_key IS NOT NULL`, `${asset}.storage_profile_id IS NULL`,
    `${asset}.storage_profile_revision IS NULL`, `${asset}.object_key IS NULL`,
    `${file}.file_id=${asset}.file_id`, `${file}.purpose=rfe.purpose`, `${file}.access_scope='system'`,
    `${file}.verified_sha256=rfe.sha256`, `${file}.verified_byte_size=rfe.byte_size`,
    "(rfi.expected_sha256 IS NULL OR rfi.expected_sha256=rfe.sha256)",
    "(rfi.expected_byte_size IS NULL OR rfi.expected_byte_size=rfe.byte_size)",
    "(rfe.source_file_id IS NULL OR rfe.source_file_id=rfe.destination_file_id)",
    "rfp.verified_sha256=rfe.sha256", "rfp.verified_byte_size=rfe.byte_size",
    "rfp.verification_method='full_read_sha256'", "rfp.verification_operation_id=rfe.verification_operation_id",
    "rfe.verification_operation_id='fp5:'||rfe.id", "rfp.verified_at=rfe.verified_at", "rfp.published_at=rfe.published_at",
    "rfe.producer_trust=CASE WHEN rfe.purpose='derived_preview' THEN 'untrusted_import' ELSE 'opaque_recovery' END",
    closedRecoveryJson("rae.original_json", recoveryAliasColumns),
    "json_type(rae.original_json,'$.byte_size')='integer'", "json_type(rae.original_json,'$.sha256') IN('null','text')",
    ...recoveryAliasColumns.filter(column => column !== "file_id").map(column => `${original(column)} IS ${asset}.${column}`),
    `(json_type(rae.original_json,'$.file_id')='null' OR(${original("file_id")}=rfe.source_file_id AND rfe.source_file_id IS NOT NULL))`,
    `${asset}.byte_size=rfe.byte_size`, `(${asset}.sha256 IS NULL OR ${asset}.sha256=rfe.sha256)`,
    closedRecoveryJson("rfe.source_locator_json", recoveryLocatorColumns),
    "json_type(rfe.source_locator_json,'$.sourceId')='text'", "json_type(rfe.source_locator_json,'$.locatorId')='text'",
    "json_type(rfe.source_locator_json,'$.objectKey')='text'",
    "json_type(rfe.source_locator_json,'$.expectedByteSize') IN('null','integer')",
    "json_type(rfe.source_locator_json,'$.expectedSha256') IN('null','text')",
    `(${locator("expectedByteSize")} IS NULL OR ${locator("expectedByteSize")}=rfe.byte_size)`,
    `(${locator("expectedSha256")} IS NULL OR ${locator("expectedSha256")}=rfe.sha256)`,
    `((${locator("storeKind")}='r2' AND ${original("r2_key")}=${locator("objectKey")})
      OR(${original("file_id")}=rfe.source_file_id AND rfe.source_file_id IS NOT NULL))`,
    `(${balancedRecoveryConjunction([
      `${locator("byteAuthority")}='legacy'`, `${locator("storeKind")}='r2'`, `${locator("provider")}='r2'`,
      `${locator("storageProfileId")} IS NULL`, `${locator("storageProfileRevision")} IS NULL`, `${locator("locationId")} IS NULL`,
    ])} OR ${balancedRecoveryConjunction([
      `${locator("byteAuthority")}='file_location'`, `${locator("storageProfileRevision")}=1`, "rfe.source_file_id IS NOT NULL",
      `((${locator("storeKind")}='r2' AND ${locator("provider")}='r2') OR(${locator("storeKind")}='file' AND ${locator("provider")}='s3')
        OR(${locator("storeKind")}='managed' AND ${locator("provider")}='switchdrive'))`,
      `EXISTS(SELECT 1 FROM file_locations rsl JOIN storage_profiles rssp ON rssp.id=rsl.storage_profile_id WHERE ${balancedRecoveryConjunction([
        `rsl.id=${locator("locationId")}`, "rsl.file_id=rfe.source_file_id", `rsl.storage_profile_id=${locator("storageProfileId")}`,
        `rsl.object_key=${locator("objectKey")}`, `rssp.configuration_revision=${locator("storageProfileRevision")}`, `rssp.adapter_type=${locator("provider")}`,
      ])})`,
    ])})`,
    ...(state ? [`EXISTS(SELECT 1 FROM recovery_file_binding_evidence rbe WHERE ${balancedRecoveryConjunction([
      "rbe.evidence_id=rfe.id", "rbe.consumer_kind='state_representation_asset'", `rbe.consumer_id=${state}.state_hash`,
      `rbe.consumer_sub_id=${state}.asset_id`, "rbe.file_slot='primary'", `rbe.purpose=${file}.purpose`, `${state}.file_id=${file}.file_id`,
      "length(rbe.row_sha256)=64", "rbe.row_sha256 NOT GLOB '*[^0-9a-f]*'",
      "json_extract(rbe.preview_origin_json,'$.kind')='none'", closedRecoveryJson("rbe.preview_origin_json", ["kind"]),
    ])})`] : []),
  ];
  return `EXISTS(SELECT 1 FROM recovery_file_alias_evidence rae
    JOIN recovery_file_evidence rfe ON rfe.id=rae.evidence_id AND rfe.destination_file_id=rae.destination_file_id
    JOIN file_locations rfl ON rfl.id=rfe.location_id AND rfl.file_id=rfe.destination_file_id
      AND rfl.storage_profile_id=rfe.profile_id AND rfl.object_key=rfe.object_key
    JOIN file_location_publications rfp ON rfp.location_id=rfe.location_id AND rfp.file_id=rfe.destination_file_id
      AND rfp.storage_profile_id=rfe.profile_id AND rfp.object_key=rfe.object_key
    JOIN storage_profiles rsp ON rsp.id=rfe.profile_id AND rsp.configuration_revision=rfe.profile_revision
      AND rsp.namespace_identity=rfe.namespace_identity AND rsp.adapter_type IN('r2','s3')
    JOIN files rfi ON rfi.id=rfe.destination_file_id AND rfi.purpose=rfe.purpose AND rfi.access_scope='system'
    WHERE ${balancedRecoveryConjunction(conditions)})`;
}

/** A native alias is an exact File placement receipt. Its R2 locator is NULL. */
export function nativeAssetAliasPredicate(alias = "a"): string {
  return `${alias}.r2_key IS NULL AND ${alias}.file_id=? AND ${alias}.storage_profile_id=?
    AND ${alias}.storage_profile_revision=? AND ${alias}.object_key=? AND ${alias}.status='ready'
    AND ${alias}.byte_size=? AND ${alias}.sha256=?`;
}
export function nativeAssetAliasBindings(candidate: StagedAuthorityCandidate, result: VerifiedAuthorityPublication["result"]) {
  return [result.fileId, candidate.profile.profileId, candidate.profile.configurationRevision, result.objectKey,
    candidate.expectedBytes.byteSize, candidate.expectedBytes.sha256];
}

/** Place after verified publication statements in the same business batch.
 * Reuse requires the exact published File/profile/key; equal hash alone is insufficient. */
export function nativeAssetAliasInsert(db: D1Database, input: {
  assetId: string; importId?: string; originalName: string; mimeType: string; actorEmail: string; createdAt: string;
  candidate: StagedAuthorityCandidate; result: VerifiedAuthorityPublication["result"];
}): D1PreparedStatement {
  const { candidate, result } = input;
  return db.prepare(`INSERT INTO assets(id,import_id,r2_key,file_id,storage_profile_id,storage_profile_revision,object_key,
    original_name,mime_type,byte_size,status,sha256,actor_email,created_at)
    SELECT ?,?,NULL,?,?,?,?,?,?,?,'ready',?,?,? WHERE NOT EXISTS(
      SELECT 1 FROM assets a WHERE ${nativeAssetAliasPredicate()})`)
    .bind(input.assetId, input.importId ?? null, result.fileId, candidate.profile.profileId, candidate.profile.configurationRevision,
      result.objectKey, input.originalName, input.mimeType, candidate.expectedBytes.byteSize, candidate.expectedBytes.sha256,
      input.actorEmail, input.createdAt, ...nativeAssetAliasBindings(candidate, result));
}

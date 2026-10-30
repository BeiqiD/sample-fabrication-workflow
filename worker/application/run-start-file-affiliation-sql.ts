import { publishedAssetSql } from "../template-publication";

/** Scalar source inventory only. ?1 is the captured Sample and ?2 the selected
 * published Template. These strings issue no Request/root/File/body/provider
 * authority. The Node issuer adds current dual-root admission and genuine
 * captured physical profile fences in the same actual Native BEGIN. */
export const RUN_START_SCOPED_FILE_BINDINGS_SQL = `WITH scoped_state_hashes(hash) AS (
  SELECT inherited_state_hash FROM samples WHERE id=?1
  UNION SELECT initial_state_hash FROM runs WHERE sample_id=?1
  UNION SELECT rs.expected_state_hash FROM run_steps rs JOIN runs r ON r.id=rs.run_id WHERE r.sample_id=?1
  UNION SELECT initial_state_hash FROM template_versions WHERE id=?2
  UNION SELECT expected_state_hash FROM template_steps WHERE template_version_id=?2
), scoped_file_bindings(kind,source_id,asset_id,position,file_id,purpose,legacy_key) AS (
  SELECT 'state',sra.state_hash,sra.asset_id,sra.position,sra.file_id,'embedded_content',NULL
  FROM state_representation_assets sra WHERE sra.state_hash IN(SELECT hash FROM scoped_state_hashes WHERE hash IS NOT NULL)
  UNION ALL
  SELECT 'execution',rsa.id,rsa.asset_id,rsa.position,rsa.file_id,'embedded_content',NULL
  FROM run_step_assets rsa JOIN run_steps rs ON rs.id=rsa.run_step_id JOIN runs r ON r.id=rs.run_id
  WHERE r.sample_id=?1 AND rsa.role='execution' AND rsa.deleted_at IS NULL
  UNION ALL
  SELECT 'source',tv.id,NULL,0,tv.source_file_id,'provenance',tv.source_asset_key FROM template_versions tv
  WHERE tv.id=?2 AND (tv.source_file_id IS NOT NULL OR tv.source_asset_key IS NOT NULL)
), valid_native_bindings AS (
  SELECT b.kind,b.source_id,b.asset_id,b.position,b.file_id,b.purpose,
    fp.active_location_id,fp.verified_byte_size,fp.verified_sha256,fp.published_at,
    flp.storage_profile_id,flp.object_key,flp.verification_operation_id,flp.verified_at,flp.published_at location_published_at,
    p.configuration_revision,p.namespace_identity,runtime.state runtime_state,runtime.activated_at
  FROM scoped_file_bindings b JOIN file_usable_publications fp ON fp.file_id=b.file_id AND fp.purpose=b.purpose AND fp.access_scope='system'
  JOIN file_location_publications flp ON flp.location_id=fp.active_location_id AND flp.file_id=fp.file_id
    AND flp.verified_byte_size=fp.verified_byte_size AND flp.verified_sha256=fp.verified_sha256
  JOIN storage_profiles p ON p.id=flp.storage_profile_id AND p.adapter_type='local'
    AND p.configuration_source='installation' AND p.credential_reference IS NULL AND p.configuration_revision=1
  JOIN storage_profile_runtime runtime ON runtime.storage_profile_id=p.id
    AND runtime.state IN('read_only','read_write') AND runtime.retired_at IS NULL
  WHERE b.file_id IS NOT NULL AND b.legacy_key IS NULL AND (
    (b.kind='source' AND b.asset_id IS NULL)
    OR EXISTS(SELECT 1 FROM assets a WHERE a.id=b.asset_id AND a.status='ready' AND a.r2_key IS NULL
      AND a.file_id=b.file_id AND a.storage_profile_id=p.id AND a.storage_profile_revision=p.configuration_revision
      AND a.object_key=flp.object_key AND a.byte_size=fp.verified_byte_size AND a.sha256=fp.verified_sha256
      AND ${publishedAssetSql("a")}))
)`;

export const RUN_START_ACTIVE_FILE_AFFILIATION_SQL = `${RUN_START_SCOPED_FILE_BINDINGS_SQL}
SELECT 1 admitted WHERE NOT EXISTS(SELECT 1 FROM scoped_file_bindings b WHERE NOT EXISTS(
  SELECT 1 FROM valid_native_bindings actual WHERE actual.kind=b.kind AND actual.source_id=b.source_id
    AND actual.asset_id IS b.asset_id AND actual.position=b.position AND actual.file_id=b.file_id AND actual.purpose=b.purpose))`;

/** State hashes are deduplicated before bindings are selected. A new Run that
 * references the already selected Template states therefore does not invent
 * new media rows or change this captured source set merely from its new IDs.
 * The original Sample/Template snapshots independently cover their graph/CAS. */
export const RUN_START_ACTIVE_FILE_STATE_SQL = `${RUN_START_SCOPED_FILE_BINDINGS_SQL}
SELECT COALESCE(json_group_array(json(tuple)),'[]') state FROM (
  SELECT json_array(kind,source_id,asset_id,position,file_id,purpose,active_location_id,
    verified_byte_size,verified_sha256,published_at,storage_profile_id,object_key,verification_operation_id,
    verified_at,location_published_at,configuration_revision,namespace_identity,runtime_state,activated_at) tuple
  FROM valid_native_bindings ORDER BY kind,source_id,asset_id,position,file_id)`;

export const RUN_START_ACTIVE_FILE_PROFILES_SQL = `${RUN_START_SCOPED_FILE_BINDINGS_SQL}
SELECT DISTINCT storage_profile_id profileId FROM valid_native_bindings ORDER BY storage_profile_id`;

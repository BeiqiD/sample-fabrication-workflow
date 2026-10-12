import { publishedAssetSql, publishedTemplateVersionSql } from "../template-publication";

/** Fixed scalar source inventory. ?1 is the captured local issuer, ?2 the
 * captured subject, and ?3 the detail version id or NULL for the nonarchived
 * list. Detail selects initial/step state media and references; the mature
 * list selects initial-state media only. These constants issue no Request,
 * root, File, byte or provider grant.
 * The separate Node owner supplies fresh session/control/member admission,
 * bounded source validation and genuine physical profile fences in the same
 * actual Native BEGIN. Detail retains the mature archived-version behavior. */
const SELECTED_TEMPLATE_SOURCE_SQL = `WITH selected_versions AS (
  SELECT tv.* FROM main.template_versions tv
  WHERE tv.deleted_at IS NULL AND ${publishedTemplateVersionSql("tv")}
    AND ((?3 IS NOT NULL AND tv.id=?3) OR (?3 IS NULL AND tv.archived_at IS NULL))
    AND EXISTS(SELECT 1 FROM main.recipe_families rf
      JOIN main.collaboration_resources r ON r.root_kind='template' AND r.root_id=rf.id
      JOIN main.collaboration_identities i ON i.provider='local' AND i.issuer=?1 AND i.subject=?2
      JOIN main.collaboration_members m ON m.member_id=i.member_id
      WHERE rf.id=tv.recipe_family_id AND rf.archived_at IS NULL AND i.enabled=1 AND m.state='active'
        AND (r.visibility='workspace' OR EXISTS(SELECT 1 FROM main.collaboration_grants g
          WHERE g.root_kind=r.root_kind AND g.root_id=r.root_id AND g.member_id=i.member_id
            AND g.enabled=1 AND g.capability IN('read','edit','manage'))))
), selected_steps AS (
  SELECT ts.* FROM main.template_steps ts JOIN selected_versions tv ON tv.id=ts.template_version_id
), selected_version_state_hashes(template_version_id,hash) AS (
  SELECT id,initial_state_hash FROM selected_versions WHERE initial_state_hash IS NOT NULL
  UNION SELECT template_version_id,expected_state_hash FROM selected_steps WHERE ?3 IS NOT NULL AND expected_state_hash IS NOT NULL
), selected_state_hashes(hash) AS (
  SELECT DISTINCT hash FROM selected_version_state_hashes
), selected_states AS (
  SELECT h.hash selected_state_hash,sr.hash actual_state_hash,sr.hash_scheme,sr.representation_type,
    sr.logical_state_key,sr.content_json,sr.created_at
  FROM selected_state_hashes h LEFT JOIN main.state_representations sr ON sr.hash=h.hash
), selected_state_assets AS (
  SELECT sra.* FROM main.state_representation_assets sra
  JOIN selected_state_hashes h ON h.hash=sra.state_hash
), selected_ready_state_assets AS (
  SELECT sra.* FROM selected_state_assets sra JOIN main.assets a ON a.id=sra.asset_id
  WHERE a.status='ready' AND ${publishedAssetSql("a")}
), selected_references AS (
  SELECT mtr.* FROM main.metrology_template_references mtr
  JOIN selected_versions tv ON tv.id=mtr.template_version_id
  JOIN main.assets a ON a.id=mtr.asset_id
  WHERE ?3 IS NOT NULL AND mtr.deleted_at IS NULL AND a.status='ready' AND ${publishedAssetSql("a")}
), selected_asset_ids(asset_id) AS (
  SELECT asset_id FROM selected_state_assets UNION SELECT asset_id FROM selected_references
), selected_aliases AS (
  SELECT wanted.asset_id selected_asset_id,a.* FROM selected_asset_ids wanted
  LEFT JOIN main.assets a ON a.id=wanted.asset_id
), scoped_file_bindings(kind,source_id,asset_id,position,file_id,purpose,legacy_key) AS (
  SELECT 'source',tv.id,NULL,0,tv.source_file_id,'provenance',tv.source_asset_key
  FROM selected_versions tv WHERE tv.source_file_id IS NOT NULL OR tv.source_asset_key IS NOT NULL
  UNION ALL
  SELECT 'state',sra.state_hash,sra.asset_id,sra.position,sra.file_id,'embedded_content',a.r2_key
  FROM selected_ready_state_assets sra JOIN main.assets a ON a.id=sra.asset_id
  UNION ALL
  SELECT 'reference',mtr.id,mtr.asset_id,mtr.position,mtr.file_id,'research_source',a.r2_key
  FROM selected_references mtr JOIN main.assets a ON a.id=mtr.asset_id
), valid_native_bindings AS (
  SELECT b.kind,b.source_id,b.asset_id,b.position,b.file_id,b.purpose,
    fp.access_scope,fp.active_location_id,fp.verified_byte_size,fp.verified_sha256,
    fp.state publication_state,fp.published_at,fp.retired_at publication_retired_at,
    flp.storage_profile_id,flp.object_key,flp.verification_method,flp.verification_operation_id,
    flp.verified_at,flp.published_at location_published_at,
    p.configuration_revision,p.namespace_identity,p.adapter_type,p.configuration_source,p.credential_reference,
    p.state profile_state,runtime.state runtime_state,runtime.activated_at,runtime.retired_at runtime_retired_at,
    a.id alias_id,a.import_id alias_import_id,a.r2_key alias_legacy_key,a.file_id alias_file_id,
    a.storage_profile_id alias_profile_id,a.storage_profile_revision alias_profile_revision,
    a.object_key alias_object_key,a.status alias_status,a.byte_size alias_byte_size,a.sha256 alias_sha256
  FROM scoped_file_bindings b
  JOIN main.file_usable_publications fp ON fp.file_id=b.file_id AND fp.purpose=b.purpose AND fp.access_scope='system'
  JOIN main.file_location_publications flp ON flp.location_id=fp.active_location_id AND flp.file_id=fp.file_id
    AND flp.verified_byte_size=fp.verified_byte_size AND flp.verified_sha256=fp.verified_sha256
  JOIN main.storage_profiles p ON p.id=flp.storage_profile_id AND p.adapter_type='local'
    AND p.configuration_source='installation' AND p.credential_reference IS NULL AND p.configuration_revision=1
  JOIN main.storage_profile_runtime runtime ON runtime.storage_profile_id=p.id
    AND runtime.state IN('read_only','read_write') AND runtime.retired_at IS NULL
  LEFT JOIN main.assets a ON a.id=b.asset_id
  WHERE b.file_id IS NOT NULL AND b.legacy_key IS NULL AND (
    (b.kind='source' AND b.asset_id IS NULL)
    OR (a.id=b.asset_id AND a.status='ready' AND a.r2_key IS NULL AND a.file_id=b.file_id
      AND a.storage_profile_id=p.id AND a.storage_profile_revision=p.configuration_revision
      AND a.object_key=flp.object_key AND a.byte_size=fp.verified_byte_size AND a.sha256=fp.verified_sha256
      AND ${publishedAssetSql("a")}))
)`;

/** Match exactly the media rows selected by the mature reader: ready/published
 * initial/step aliases and live ready/published metrology references. Legacy
 * source keys and selected legacy aliases are refused, never rewritten. */
export const TEMPLATE_READ_ACTIVE_FILE_AFFILIATION_SQL = `${SELECTED_TEMPLATE_SOURCE_SQL}
SELECT 1 admitted WHERE NOT EXISTS(SELECT 1 FROM selected_states WHERE actual_state_hash IS NULL)
  AND NOT EXISTS(SELECT 1 FROM scoped_file_bindings b WHERE NOT EXISTS(
    SELECT 1 FROM valid_native_bindings actual WHERE actual.kind=b.kind AND actual.source_id=b.source_id
      AND actual.asset_id IS b.asset_id AND actual.position=b.position
      AND actual.file_id=b.file_id AND actual.purpose=b.purpose))`;

/** Complete ordered source witness, including a selected state with no media.
 * Raw all-SRA rows and aliases retain source changes even when not currently
 * ready/published; their mere presence never admits a File or profile. Exact
 * source JSON remains text, so the Node owner validates canonical/hash facts. */
export const TEMPLATE_READ_ACTIVE_FILE_STATE_SQL = `${SELECTED_TEMPLATE_SOURCE_SQL}
SELECT json_object(
  'versions',json((SELECT COALESCE(json_group_array(json(tuple)),'[]') FROM (
    SELECT json_array(id,recipe_family_id,name,template_type,version,manifest_hash,initial_state_hash,
      source_filename,source_asset_key,content_json,created_by,created_at,locked_at,locked_by,
      archived_at,archived_by,template_kind,metrology_notes,deleted_at,deleted_by,source_file_id) tuple
    FROM selected_versions ORDER BY id))),
  'steps',json((SELECT COALESCE(json_group_array(json(tuple)),'[]') FROM (
    SELECT json_array(id,template_version_id,logical_step_key,position,source_row,step_number,
      section_name,definition_hash,expected_state_hash,raw_json) tuple
    FROM selected_steps ORDER BY template_version_id,position,id))),
  'definitions',json((SELECT COALESCE(json_group_array(json(tuple)),'[]') FROM (
    SELECT json_array(sd.hash,sd.hash_scheme,sd.name,sd.tool_name,sd.parameters_text,
      sd.comments_text,sd.canonical_json,sd.created_at) tuple FROM main.step_definitions sd
    WHERE sd.hash IN(SELECT definition_hash FROM selected_steps) ORDER BY sd.hash))),
  'states',json((SELECT COALESCE(json_group_array(json(tuple)),'[]') FROM (
    SELECT json_array(selected_state_hash,actual_state_hash,hash_scheme,representation_type,
      logical_state_key,content_json,created_at) tuple FROM selected_states ORDER BY selected_state_hash))),
  'stateAssets',json((SELECT COALESCE(json_group_array(json(tuple)),'[]') FROM (
    SELECT json_array(state_hash,asset_id,position,file_id) tuple
    FROM selected_state_assets ORDER BY state_hash,position,asset_id))),
  'references',json((SELECT COALESCE(json_group_array(json(tuple)),'[]') FROM (
    SELECT json_array(id,template_version_id,asset_id,display_name,position,actor_email,created_at,
      deleted_at,deleted_by,superseded_by_occurrence_id,superseded_at,superseded_by,
      supersession_operation_id,file_id) tuple
    FROM selected_references ORDER BY template_version_id,position,created_at,id))),
  'aliases',json((SELECT COALESCE(json_group_array(json(tuple)),'[]') FROM (
    SELECT json_array(selected_asset_id,id,import_id,r2_key,original_name,mime_type,byte_size,
      status,sha256,actor_email,created_at,file_id,storage_profile_id,storage_profile_revision,object_key) tuple
    FROM selected_aliases ORDER BY selected_asset_id))),
  'bindings',json((SELECT COALESCE(json_group_array(json(tuple)),'[]') FROM (
    SELECT json_array(kind,source_id,asset_id,position,file_id,purpose,legacy_key) tuple
    FROM scoped_file_bindings ORDER BY kind,source_id,position,asset_id,file_id))),
  'native',json((SELECT COALESCE(json_group_array(json(tuple)),'[]') FROM (
    SELECT json_array(kind,source_id,asset_id,position,file_id,purpose,access_scope,active_location_id,
      verified_byte_size,verified_sha256,publication_state,published_at,publication_retired_at,
      storage_profile_id,object_key,verification_method,verification_operation_id,verified_at,location_published_at,
      configuration_revision,namespace_identity,adapter_type,configuration_source,credential_reference,
      profile_state,runtime_state,activated_at,runtime_retired_at,alias_id,alias_import_id,alias_legacy_key,
      alias_file_id,alias_profile_id,alias_profile_revision,alias_object_key,alias_status,alias_byte_size,alias_sha256) tuple
    FROM valid_native_bindings ORDER BY kind,source_id,position,asset_id,file_id)))
) state`;

export const TEMPLATE_READ_ACTIVE_FILE_PROFILES_SQL = `${SELECTED_TEMPLATE_SOURCE_SQL}
SELECT DISTINCT storage_profile_id profileId FROM valid_native_bindings ORDER BY storage_profile_id`;

/** One row per selected version and deduplicated referenced initial/step state.
 * A version with no states still has one null-state row. A missing referenced
 * state keeps its requested stateHash and exposes NULL scheme/type/content;
 * the Node owner must reject it. Actual selected aliases remain positional:
 * publication derivation can collapse duplicate asset ids while canonical
 * assetHashes retains duplicates. No SQL DISTINCT collapses these positions. */
export const TEMPLATE_READ_ACTIVE_FILE_SUBSTRATE_ROWS_SQL = `${SELECTED_TEMPLATE_SOURCE_SQL}
SELECT tv.id templateVersionId,tv.content_json templateContentJson,tv.initial_state_hash initialStateHash,
  selected.hash stateHash,sr.hash_scheme stateHashScheme,sr.representation_type stateType,
  sr.content_json stateContentJson,
  (SELECT COALESCE(json_group_array(json(tuple)),'[]') FROM (
    SELECT json_object('position',sra.position,'sha256',a.sha256) tuple
    FROM selected_ready_state_assets sra JOIN main.assets a ON a.id=sra.asset_id
    WHERE sra.state_hash=selected.hash ORDER BY sra.position,sra.asset_id)) assetHashesJson
FROM selected_versions tv
LEFT JOIN selected_version_state_hashes selected ON selected.template_version_id=tv.id
LEFT JOIN main.state_representations sr ON sr.hash=selected.hash
ORDER BY tv.id,selected.hash`;

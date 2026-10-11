// Installation-owned fixture metadata only. The future separately reviewed
// controller supplies a genuine fresh isolated current24 D1 and deployment
// namespaces after validating its original artifact, native custody and roots.
// This module grants no role/operator rights and never activates authority.
import assert from 'node:assert/strict';

export async function prepareHistoricalR2Profiles(db, namespaces, capturedAt, recordPhase = () => {}) {
  recordPhase('historical-profile-input-admission');
  assert.deepEqual(Object.keys(namespaces).sort(), ['source', 'target']);
  assert.equal(typeof namespaces.source, 'string');
  assert.equal(typeof namespaces.target, 'string');
  assert.notEqual(namespaces.source, namespaces.target);
  // These strings are produced by the deployment-owned controller and later
  // validated by original canonicalR2ProfileNamespace/openShadowProfile.
  assert.equal(new Date(capturedAt).toISOString(), capturedAt);
  recordPhase('historical-profile-original-catalog-before');
  const before = await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all();
  assert.equal(before.success, true);
  recordPhase('historical-profile-original-atomic-admission');
  await db.batch([
    db.prepare("SELECT CASE WHEN (SELECT count(*) FROM storage_profiles)=0 AND EXISTS(SELECT 1 FROM file_authority_control WHERE singleton=1 AND mode='legacy') AND EXISTS(SELECT 1 FROM file_shadow_runtime_guard WHERE singleton=1 AND enabled=0) THEN 1 ELSE json('Fresh isolated profile preparation boundary changed') END"),
    ...[['storage-profile:r2:bootstrap', namespaces.source], ['storage-profile:r2:qa-migration-target', namespaces.target]].map(([id, namespace]) =>
      db.prepare("INSERT INTO storage_profiles(id,adapter_type,namespace_identity,configuration_source,credential_reference,configuration_revision,state,created_at) VALUES(?,'r2',?,'bootstrap',NULL,1,'historical',?)").bind(id, namespace, capturedAt)),
    db.prepare("SELECT CASE WHEN (SELECT count(*) FROM storage_profiles)=2 AND (SELECT count(*) FROM storage_profile_runtime WHERE state='read_only' AND activated_at IS NULL AND retired_at IS NULL)=2 AND (SELECT count(*) FROM file_shadow_profile_enablements)=0 THEN 1 ELSE json('Original historical profile admission did not complete') END"),
  ]);
  recordPhase('historical-profile-original-catalog-after');
  const after = await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all();
  assert.equal(after.success, true);
  assert.deepEqual(after.results, before.results, 'All original tables/indexes/triggers/views stay installed byte-exact.');
  recordPhase('historical-profile-original-row-verification');
  const rows = await db.prepare("SELECT p.id,p.adapter_type,p.namespace_identity,p.configuration_source,p.credential_reference,p.configuration_revision,p.state,p.created_at,r.state runtime_state,r.registered_at,r.activated_at,r.retired_at FROM storage_profiles p JOIN storage_profile_runtime r ON r.storage_profile_id=p.id ORDER BY p.id").all();
  assert.equal(rows.success, true);assert.equal(rows.results.length, 2);
  for (const row of rows.results) {
    assert.equal(row.adapter_type, 'r2');assert.equal(row.configuration_source, 'bootstrap');
    assert.equal(row.credential_reference, null);assert.equal(row.configuration_revision, 1);
    assert.equal(row.state, 'historical');assert.equal(row.runtime_state, 'read_only');
    assert.equal(row.created_at, capturedAt);assert.equal(row.registered_at, capturedAt);
    assert.equal(row.activated_at, null);assert.equal(row.retired_at, null);
    assert.equal(row.namespace_identity, row.id === 'storage-profile:r2:bootstrap' ? namespaces.source : namespaces.target);
  }
  return { originalCatalogExact: true, historicalProfiles: rows.results };
}

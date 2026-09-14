import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const migration = "0007_fp1_file_authority_transition.sql";
const migrationSql = read(`migrations/${migration}`);
const preceding = readdirSync(new URL("migrations/", root))
  .filter((name) => name.endsWith(".sql") && name < migration).sort();
const fixtureSql = read("worker/fixtures/reference-graph.sql");
const hash = (character) => character.repeat(64);
const plain = (value) => JSON.parse(JSON.stringify(value));
const authorityTables = [
  "file_acceptance_candidates", "file_consumer_migration_decisions", "file_derivations",
  "file_holds", "file_location_gc_ledger", "file_location_holds",
  "file_location_integrity_quarantine", "file_location_publications", "file_publications",
];
const withoutRowidTables = ["file_authority_control", "storage_profile_runtime", ...authorityTables];
const typedColumns = {
  state_representation_assets: ["file_id"], run_step_assets: ["file_id"],
  metrology_template_references: ["file_id"], run_step_comments: ["file_id"],
  state_verifications: ["evidence_file_id"], comment_submission_items: ["file_id"],
  project_content_attachments: ["file_id"], attachment_derivatives: ["derived_file_id"],
  events: ["asset_file_id", "thumbnail_file_id"],
  imports: ["workbook_file_id", "manifest_file_id"], template_versions: ["source_file_id"],
};

function hostAdapter(database) {
  return {
    async all(sql) { return plain(database.prepare(sql).all()); },
    async batch(statements) {
      database.exec("BEGIN");
      try { for (const statement of statements) database.exec(statement); database.exec("COMMIT"); }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
}

function d1Adapter(database) {
  return {
    async all(sql) { return (await database.prepare(sql).all()).results; },
    async batch(statements) { await database.batch(statements.map((statement) => database.prepare(statement))); },
  };
}

async function apply(db, sql) { await db.batch(splitSql(sql)); }

async function snapshotOldState(db) {
  const schema = await db.all("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name <> '_cf_METADATA' ORDER BY type, name");
  const rows = {};
  for (const { name } of schema.filter(({ type }) => type === "table")) {
    rows[name] = (await db.all(`SELECT * FROM "${name}"`))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return {
    schema,
    rows,
    retention: await db.all("SELECT * FROM blob_retention_edges ORDER BY store_kind, provider, object_key, occurrence_id"),
    retentionSql: (await db.all("SELECT name, sql FROM sqlite_schema WHERE type = 'view' AND name LIKE 'blob_retention_edges%' ORDER BY name")),
  };
}

async function seedBeforeUpgrade(db) {
  for (const name of preceding) await apply(db, read(`migrations/${name}`));
  await apply(db, fixtureSql);
  await db.batch([
    "INSERT INTO storage_profiles (id, adapter_type, namespace_identity, configuration_source, credential_reference, configuration_revision, state, created_at) VALUES ('authority-profile', 'r2', 'authority-fixture-bucket', 'bootstrap', NULL, 1, 'historical', '2026-09-14T00:00:00.000Z')",
    "INSERT INTO storage_profiles (id, adapter_type, namespace_identity, configuration_source, credential_reference, configuration_revision, state, created_at) VALUES ('legacy-long-time-profile', 'r2', 'legacy-long-time-bucket', 'bootstrap', NULL, 1, 'historical', substr(hex(zeroblob(101)), 1, 201))",
    "INSERT INTO storage_profiles (id, adapter_type, namespace_identity, configuration_source, credential_reference, configuration_revision, state, created_at) VALUES ('legacy-nul-time-profile', 'r2', 'legacy-nul-time-bucket', 'bootstrap', NULL, 1, 'historical', char(0) || 'legacy')",
    "CREATE TABLE d1_migrations (name TEXT PRIMARY KEY)",
    ...preceding.map((name) => `INSERT INTO d1_migrations VALUES ('${name}')`),
  ]);
}

async function verifyLegacyExpand(db) {
  await seedBeforeUpgrade(db);
  const before = await snapshotOldState(db);
  const statements = splitSql(migrationSql);
  assert(statements.length > 100, "the complete substrate is Wrangler-split into bounded statements");
  assert(statements.every((statement) => Buffer.byteLength(statement) < 100_000));

  await assert.rejects(
    db.batch([...statements, `INSERT INTO d1_migrations VALUES ('${preceding[0]}')`]),
    /UNIQUE|unique/i,
  );
  assert.deepEqual(await snapshotOldState(db), before, "failed migration transaction preserves populated schema, rows, and legacy retention");

  await db.batch([...statements, `INSERT INTO d1_migrations VALUES ('${migration}')`]);
  assert.deepEqual(await db.all("SELECT * FROM file_authority_control"), [{
    singleton: 1, mode: "legacy", revision: 1,
    updated_at: "2026-09-14T00:00:00.000Z", activated_at: null,
  }]);
  assert.deepEqual(await db.all("SELECT storage_profile_id, state, activated_at, retired_at FROM storage_profile_runtime WHERE storage_profile_id = 'authority-profile'"), [{
    storage_profile_id: "authority-profile", state: "read_only", activated_at: null, retired_at: null,
  }]);
  assert.deepEqual(await db.all(`SELECT COUNT(*) AS count FROM storage_profile_runtime runtime
    JOIN storage_profiles profile ON profile.id = runtime.storage_profile_id
    WHERE runtime.registered_at IS profile.created_at`), [{ count: 3 }]);
  for (const table of authorityTables) assert.deepEqual(await db.all(`SELECT * FROM ${table}`), [], `${table} is not backfilled`);
  for (const table of withoutRowidTables) {
    await assert.rejects(db.all(`SELECT rowid FROM ${table}`), /no such column.*rowid/i,
      `${table} has no hidden replacement identity`);
  }
  for (const [table, columns] of Object.entries(typedColumns)) {
    const predicate = columns.map((column) => `${column} IS NOT NULL`).join(" OR ");
    assert.deepEqual(await db.all(`SELECT 1 FROM ${table} WHERE ${predicate}`), [], `${table} typed slots remain null`);
  }
  const projectionSql = (await db.all("SELECT group_concat(sql, char(10)) AS sql FROM sqlite_schema WHERE type = 'view' AND name LIKE 'file_consumer_%_projection'"))[0].sql;
  for (const [table, columns] of Object.entries(typedColumns)) {
    assert.match(projectionSql, new RegExp(`\\b${table}\\b`), `${table} is in the typed projection`);
    for (const column of columns) assert.match(projectionSql, new RegExp(`\\b${column}\\b`), `${table}.${column} is projected`);
  }
  const typedReplaceGuards = (await db.all("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE '%file_replace_guard' ORDER BY name"))
    .map(({ name }) => name);
  assert.deepEqual(typedReplaceGuards, [
    "attachment_derivatives_file_replace_guard", "comment_submission_items_file_replace_guard",
    "events_file_replace_guard", "imports_file_replace_guard",
    "metrology_template_references_file_replace_guard", "project_content_attachments_file_replace_guard",
    "run_step_assets_file_replace_guard", "run_step_comments_file_replace_guard",
    "state_representation_assets_file_replace_guard", "state_verifications_file_replace_guard",
    "template_versions_file_replace_guard",
  ]);
  for (const leaf of ["file_consumer_relational_projection", "file_consumer_content_projection", "file_consumer_direct_projection",
    "file_relational_retention_edges", "file_content_retention_edges", "file_direct_retention_edges"]) {
    const [{ sql }] = await db.all(`SELECT sql FROM sqlite_schema WHERE name = '${leaf}'`);
    assert((sql.match(/UNION ALL/g) ?? []).length <= 4, `${leaf} has at most five compound terms`);
  }
  assert.deepEqual(await db.all("SELECT * FROM file_retention_edges"), []);
  assert.deepEqual(await db.all("SELECT * FROM file_location_retention_edges"), []);
  assert.deepEqual(await db.all("SELECT * FROM blob_retention_edges ORDER BY store_kind, provider, object_key, occurrence_id"), before.retention);
  assert.deepEqual(await db.all("SELECT name, sql FROM sqlite_schema WHERE type = 'view' AND name LIKE 'blob_retention_edges%' ORDER BY name"), before.retentionSql);

  // A preceding Worker names all old columns. Nullable expand columns and the
  // profile AFTER trigger therefore preserve its exact write behavior.
  await db.batch([
    "INSERT INTO storage_profiles (id, adapter_type, namespace_identity, configuration_source, credential_reference, configuration_revision, state, created_at) VALUES ('post-upgrade-profile', 'r2', 'post-upgrade-bucket', 'bootstrap', NULL, 1, 'historical', '2026-09-14T00:00:01.000Z')",
    "INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at) VALUES ('post-upgrade-event', 'reference-sample-a', 'image', NULL, 'authority/embed', '{}', 'owner@example.com', '2026-09-14T00:00:01.000Z')",
    `INSERT INTO files VALUES ('legacy-gated-file', 'embedded_content', 'system', 5, '${hash("a")}', NULL, 'unresolved', NULL, '2026-09-14T00:00:01.000Z')`,
    "INSERT INTO file_locations VALUES ('legacy-gated-location', 'legacy-gated-file', 'authority-profile', 'authority/embed', 'unresolved', '2026-09-14T00:00:01.000Z')",
  ]);
  assert.deepEqual(await db.all("SELECT storage_profile_id, state FROM storage_profile_runtime WHERE storage_profile_id = 'post-upgrade-profile'"),
    [{ storage_profile_id: "post-upgrade-profile", state: "read_only" }]);
  assert.deepEqual(await db.all("SELECT asset_file_id, thumbnail_file_id FROM events WHERE id = 'post-upgrade-event'"),
    [{ asset_file_id: null, thumbnail_file_id: null }]);
  await assert.rejects(db.batch(["UPDATE events SET asset_file_id = 'legacy-gated-file' WHERE id = 'post-upgrade-event'"]), /Legacy File authority/);
  await assert.rejects(db.batch([`INSERT INTO file_location_publications VALUES ('legacy-gated-location', 'legacy-gated-file', 'authority-profile', 'authority/embed', 5, '${hash("a")}', 'full_read_sha256', 'verify-legacy', '2026-09-14T00:00:02.000Z', '2026-09-14T00:00:02.000Z')`]), /Legacy File authority/);
  await assert.rejects(db.batch([
    "INSERT OR REPLACE INTO storage_profile_runtime SELECT storage_profile_id, state, registered_at || 'rewritten', activated_at, retired_at FROM storage_profile_runtime WHERE storage_profile_id = 'authority-profile'",
  ]), /created with profile identities|already exists/i);
  await assert.rejects(db.batch(["UPDATE file_authority_control SET mode = 'overlap', activated_at = '2026-09-14T00:00:02.000Z'"]), /forward migration/);

  const explicitLegacyGates = (await db.all("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND (name LIKE '%legacy%guard' OR sql LIKE '%Legacy File authority%') ORDER BY name"))
    .map(({ name }) => name);
  for (const required of [
    "file_acceptance_candidates_legacy_guard", "file_consumer_decisions_legacy_guard",
    "file_derivations_legacy_guard", "file_holds_legacy_guard", "file_location_gc_legacy_insert_guard",
    "file_location_holds_legacy_guard", "file_location_publications_legacy_guard",
    "file_location_quarantine_legacy_guard", "file_publications_legacy_insert_guard",
  ]) assert(explicitLegacyGates.includes(required), required);

  assert.deepEqual(await db.all("PRAGMA foreign_key_check"), []);
  assert.deepEqual(await db.all("PRAGMA quick_check"), [{ quick_check: "ok" }]);
}

function baseFile(id, purpose, size, digest, profile, key) {
  return [
    `INSERT INTO files VALUES ('${id}', '${purpose}', 'system', ${size}, '${digest}', NULL, 'unresolved', NULL, '2026-09-14T01:00:00.000Z')`,
    `INSERT INTO file_locations VALUES ('loc-${id}', '${id}', '${profile}', '${key}', 'unresolved', '2026-09-14T01:00:00.000Z')`,
  ];
}

function locationPublication(id, profile, key, size, digest) {
  return `INSERT INTO file_location_publications VALUES ('loc-${id}', '${id}', '${profile}', '${key}', ${size}, '${digest}', 'full_read_sha256', 'verify-${id}', '2026-09-14T01:00:01.000Z', '2026-09-14T01:00:01.000Z')`;
}

function filePublication(id, purpose, size, digest) {
  return `INSERT INTO file_publications VALUES ('${id}', '${purpose}', 'system', ${size}, '${digest}', 'loc-${id}', 'ready', '2026-09-14T01:00:02.000Z', NULL)`;
}

function r2Receipt({ id, clientId, operationId, candidateAssetId, key, size, digest }) {
  const input = JSON.stringify({
    schema: "r2-upload-request/1", ingress: "ordinary_image", purpose: "embedded_content", scope: "system",
    file: { originalName: "candidate.png", mimeType: "image/png", byteSize: size, sha256: digest },
  });
  return `INSERT INTO r2_upload_requests (id, actor_email, client_request_id, operation_id, ingress, purpose,
    request_sha256, request_input_json, request_scope, storage_profile_id, storage_profile_revision,
    storage_policy_revision, candidate_asset_id, candidate_object_key, status, accepted_result_json,
    created_at, completed_at, expires_at)
    VALUES ('${id}', 'candidate@example.com', '${clientId}', '${operationId}', 'ordinary_image',
      'embedded_content', '${hash("1")}', '${input}', 'system', 'authority-profile', 1, 1,
      '${candidateAssetId}', '${key}', 'pending', NULL, '2026-09-14T01:00:00.000Z', NULL,
      '2026-09-15T01:00:00.000Z')`;
}

async function verifyLatentGuards(db) {
  // This emulates the future reviewed overlap migration only for exercising
  // the already-installed guards. The shipped migration itself cannot do this.
  await db.batch([
    "DROP TRIGGER file_authority_control_update_guard",
    "UPDATE file_authority_control SET mode = 'overlap', updated_at = '2026-09-14T01:00:00.000Z', activated_at = '2026-09-14T01:00:00.000Z'",
    "INSERT INTO storage_profiles (id, adapter_type, namespace_identity, configuration_source, credential_reference, configuration_revision, state, created_at) VALUES ('isolated-profile', 'r2', 'isolated-fixture-bucket', 'bootstrap', NULL, 1, 'historical', '2026-09-14T01:00:00.000Z')",
    "INSERT INTO blob_integrity_quarantine VALUES ('r2', 'r2', 'reference/private/comment.png', 'reference-comment-asset', 'missing', 10, NULL, 'legacy-quarantine', '2026-09-14T01:00:00.000Z', '2026-09-14T01:00:00.000Z')",
    ...baseFile("profile-isolated", "embedded_content", 10, hash("a"), "isolated-profile", "reference/private/comment.png"),
    ...baseFile("profile-alias", "embedded_content", 11, hash("b"), "isolated-profile", "reference/private/execution.png"),
    ...baseFile("embed", "embedded_content", 5, hash("b"), "authority-profile", "authority/embed-ready"),
    ...baseFile("provenance", "provenance", 6, hash("c"), "authority-profile", "authority/provenance"),
    ...baseFile("preview", "derived_preview", 7, hash("d"), "authority-profile", "authority/preview"),
    ...baseFile("preview2", "derived_preview", 11, hash("6"), "authority-profile", "authority/preview2"),
    ...baseFile("research", "research_source", 10, hash("a"), "authority-profile", "authority/research"),
    locationPublication("embed", "authority-profile", "authority/embed-ready", 5, hash("b")),
    locationPublication("profile-isolated", "isolated-profile", "reference/private/comment.png", 10, hash("a")),
    locationPublication("profile-alias", "isolated-profile", "reference/private/execution.png", 11, hash("b")),
    locationPublication("provenance", "authority-profile", "authority/provenance", 6, hash("c")),
    locationPublication("preview", "authority-profile", "authority/preview", 7, hash("d")),
    locationPublication("preview2", "authority-profile", "authority/preview2", 11, hash("6")),
    locationPublication("research", "authority-profile", "authority/research", 10, hash("a")),
  ]);
  assert.deepEqual(await db.all("SELECT availability FROM file_location_availability WHERE location_id = 'loc-profile-isolated'"),
    [{ availability: "available" }], "legacy quarantine is bridged only through the exact legacy location identity");
  await assert.rejects(db.batch([
    `INSERT INTO file_publications VALUES ('embed', 'embedded_content', 'system', 5, '${hash("b")}', 'loc-provenance', 'ready', '2026-09-14T01:00:02.000Z', NULL)`,
  ]), /FOREIGN KEY|owned|constraint/i);
  await assert.rejects(db.batch([
    `INSERT INTO file_publications VALUES ('embed', 'embedded_content', 'system', 5, '${hash("b")}', 'loc-embed', 'ready', '2026-09-14T01:00:00.000Z', NULL)`,
  ]), /active location|ready/i, "File publication cannot predate its full-read location evidence");
  await db.batch([
    filePublication("embed", "embedded_content", 5, hash("b")),
    filePublication("provenance", "provenance", 6, hash("c")),
    filePublication("preview", "derived_preview", 7, hash("d")),
    filePublication("preview2", "derived_preview", 11, hash("6")),
    filePublication("research", "research_source", 10, hash("a")),
  ]);
  await db.batch([
    `INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at)
      VALUES (substr(hex(zeroblob(2501)), 1, 5001) || char(0), 'reference-sample-a', 'image', NULL,
        substr(hex(zeroblob(2502)), 1, 5002) || char(0), '{}', 'owner@example.com',
        '2026-09-14T01:00:02.000Z')`,
    `INSERT INTO file_consumer_migration_decisions
      (id, consumer_kind, consumer_id, consumer_sub_id, file_slot, decision, file_id, reason,
        source_row_sha256, legacy_store_kind, legacy_provider, legacy_object_key, legacy_location_id,
        operation_id, evidence_json, decided_by, decided_at)
      SELECT 'pathological-legacy-decision', 'event', id, '', 'primary', 'admitted_unresolved', NULL,
        'legacy identity and locator require exact evidence', '${hash("0")}', 'r2', 'r2', asset_key,
        NULL, 'pathological-legacy-admission', '{}', 'operator@example.com',
        '2026-09-14T01:00:02.000Z'
      FROM events WHERE instr(id, char(0)) > 0`,
  ]);
  assert.deepEqual(await db.all(`SELECT length(CAST(consumer_id AS BLOB)) AS consumer_bytes,
      instr(consumer_id, char(0)) AS consumer_nul, length(CAST(legacy_object_key AS BLOB)) AS locator_bytes,
      instr(legacy_object_key, char(0)) AS locator_nul
    FROM file_consumer_migration_decisions WHERE id = 'pathological-legacy-decision'`), [{
    consumer_bytes: 5002, consumer_nul: 5002, locator_bytes: 5003, locator_nul: 5003,
  }], "terminal decisions preserve pathological legacy identity and locator evidence exactly");

  await db.batch([
    ...baseFile("cancel-before", "embedded_content", 4, hash("e"), "authority-profile", "authority/cancel-before"),
    ...baseFile("dedup-candidate", "embedded_content", 5, hash("b"), "authority-profile", "authority/dedup-candidate"),
    ...baseFile("quarantined-candidate", "embedded_content", 5, hash("b"), "authority-profile", "authority/quarantined-candidate"),
    r2Receipt({
      id: "10000000-0000-4000-8000-000000000001", clientId: "10000000-0000-4000-8000-000000000002",
      operationId: "10000000-0000-4000-8000-000000000003", candidateAssetId: "10000000-0000-4000-8000-000000000004",
      key: "authority/cancel-before", size: 4, digest: hash("e"),
    }),
    r2Receipt({
      id: "20000000-0000-4000-8000-000000000001", clientId: "20000000-0000-4000-8000-000000000002",
      operationId: "20000000-0000-4000-8000-000000000003", candidateAssetId: "20000000-0000-4000-8000-000000000004",
      key: "authority/dedup-candidate", size: 5, digest: hash("b"),
    }),
    r2Receipt({
      id: "30000000-0000-4000-8000-000000000001", clientId: "30000000-0000-4000-8000-000000000002",
      operationId: "30000000-0000-4000-8000-000000000003", candidateAssetId: "30000000-0000-4000-8000-000000000004",
      key: "authority/quarantined-candidate", size: 5, digest: hash("b"),
    }),
    `INSERT INTO file_acceptance_candidates VALUES ('r2_upload', '10000000-0000-4000-8000-000000000001', '',
      'embedded_content', 'system', 'authority-profile', 4, '${hash("e")}', 'cancel-before',
      'loc-cancel-before', 'authority/cancel-before', 'candidate', NULL, NULL,
      '2026-09-14T01:00:00.000Z', NULL)`,
    `INSERT INTO file_acceptance_candidates VALUES ('r2_upload', '20000000-0000-4000-8000-000000000001', '',
      'embedded_content', 'system', 'authority-profile', 5, '${hash("b")}', 'dedup-candidate',
      'loc-dedup-candidate', 'authority/dedup-candidate', 'candidate', NULL, NULL,
      '2026-09-14T01:00:00.000Z', NULL)`,
    `INSERT INTO file_acceptance_candidates VALUES ('r2_upload', '30000000-0000-4000-8000-000000000001', '',
      'embedded_content', 'system', 'authority-profile', 5, '${hash("b")}', 'quarantined-candidate',
      'loc-quarantined-candidate', 'authority/quarantined-candidate', 'candidate', NULL, NULL,
      '2026-09-14T01:00:00.000Z', NULL)`,
    locationPublication("dedup-candidate", "authority-profile", "authority/dedup-candidate", 5, hash("b")),
    locationPublication("quarantined-candidate", "authority-profile", "authority/quarantined-candidate", 5, hash("b")),
    "UPDATE file_acceptance_candidates SET state = 'cancelled', completed_at = '2026-09-14T01:00:01.000Z' WHERE candidate_file_id = 'cancel-before'",
    `INSERT INTO file_location_integrity_quarantine VALUES ('loc-cancel-before', 'missing', 4, NULL,
      '${hash("e")}', NULL, 'candidate-missing', '2026-09-14T01:00:01.000Z', '2026-09-14T01:00:01.000Z')`,
    `INSERT INTO file_location_integrity_quarantine VALUES ('loc-quarantined-candidate', 'hash_mismatch', 5, 5,
      '${hash("b")}', '${hash("c")}', 'candidate-quarantine', '2026-09-14T01:00:01.000Z', '2026-09-14T01:00:01.000Z')`,
  ]);
  await assert.rejects(db.batch([
    locationPublication("cancel-before", "authority-profile", "authority/cancel-before", 4, hash("e")),
  ]), /immutable File evidence|cancel/i, "cancelled candidate cannot publish late bytes");
  await db.batch([
    `INSERT INTO assets (id, import_id, r2_key, original_name, mime_type, byte_size, status, sha256, actor_email, created_at)
      VALUES ('pca-legacy-asset', NULL, 'authority/research', 'source.pdf', 'application/pdf', 10, 'ready', '${hash("a")}', 'owner@example.com', '2026-09-14T01:00:02.000Z')`,
    "INSERT INTO projects (id, title, revision, next_created_sequence, last_mutation_id, created_by, updated_by, created_at, updated_at) VALUES ('authority-project', 'Authority project', 1, 1, 'project-create', 'owner@example.com', 'owner@example.com', '2026-09-14T01:00:02.000Z', '2026-09-14T01:00:02.000Z')",
    "INSERT INTO project_contents (id, project_id, content_type, markdown_source, attachment_caption, attachment_source_url, format_version, revision, last_mutation_id, created_by, updated_by, created_at, updated_at) VALUES ('authority-content', 'authority-project', 'attachment', NULL, NULL, NULL, 1, 1, 'content-create', 'owner@example.com', 'owner@example.com', '2026-09-14T01:00:02.000Z', '2026-09-14T01:00:02.000Z')",
    "INSERT INTO project_content_attachments (project_content_id, asset_id, storage_object_id, original_name, mime_type, byte_size, created_by, created_at, creation_operation_id) VALUES ('authority-content', 'pca-legacy-asset', NULL, 'source.pdf', 'application/pdf', 10, 'owner@example.com', '2026-09-14T01:00:02.000Z', 'content-create')",
    "UPDATE project_content_attachments SET file_id = 'research' WHERE project_content_id = 'authority-content'",
  ]);
  assert.deepEqual(await db.all("SELECT file_id FROM project_content_attachments WHERE project_content_id = 'authority-content'"), [{ file_id: "research" }]);
  await assert.rejects(db.batch([
    "INSERT OR REPLACE INTO project_content_attachments SELECT * FROM project_content_attachments WHERE project_content_id = 'authority-content'",
  ]), /replacement writes/i);

  await assert.rejects(db.batch(["UPDATE events SET asset_file_id = 'provenance' WHERE id = 'post-upgrade-event'"]), /purpose|readiness/i);
  await db.batch(["UPDATE events SET asset_file_id = 'embed' WHERE id = 'post-upgrade-event'"]);
  await assert.rejects(db.batch(["UPDATE events SET asset_file_id = NULL WHERE id = 'post-upgrade-event'"]), /fill-once/i);
  await assert.rejects(db.batch([
    "INSERT OR REPLACE INTO events SELECT * FROM events WHERE id = 'post-upgrade-event'",
  ]), /replacement writes/i);
  await assert.rejects(db.batch([
    `INSERT OR REPLACE INTO events (rowid, id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at)
      VALUES ((SELECT rowid FROM events WHERE id = 'post-upgrade-event'), 'rowid-insert-attacker',
        'reference-sample-a', 'image', NULL, 'authority/attacker', '{}', 'owner@example.com',
        '2026-09-14T01:00:02.000Z')`,
  ]), /replacement writes/i, "hidden rowid replacement cannot erase a typed consumer");
  await db.batch([
    "INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at) VALUES ('rowid-update-attacker', 'reference-sample-a', 'image', NULL, 'authority/attacker', '{}', 'owner@example.com', '2026-09-14T01:00:02.000Z')",
  ]);
  await assert.rejects(db.batch([
    "UPDATE OR REPLACE events SET rowid = (SELECT rowid FROM events WHERE id = 'post-upgrade-event') WHERE id = 'rowid-update-attacker'",
  ]), /conflicts with replacement update/i, "hidden rowid update conflict cannot erase a typed consumer");
  await db.batch([
    "INSERT INTO events (rowid, id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at) VALUES (-1, 'negative-rowid-event', 'reference-sample-a', 'image', NULL, 'authority/embed-ready', '{}', 'owner@example.com', '2026-09-14T01:00:02.000Z')",
  ]);
  await assert.rejects(db.batch([
    "UPDATE events SET asset_file_id = 'embed' WHERE id = 'negative-rowid-event'",
  ]), /rowid -1/i, "ambiguous pre-insert rowid cannot become a typed authority anchor");
  await assert.rejects(db.batch([
    `INSERT INTO file_consumer_migration_decisions (id, consumer_kind, consumer_id, consumer_sub_id, file_slot, decision, file_id, reason, source_row_sha256, legacy_store_kind, legacy_provider, legacy_object_key, legacy_location_id, operation_id, evidence_json, decided_by, decided_at)
      VALUES ('negative-rowid-decision', 'event', 'negative-rowid-event', '', 'primary', 'admitted_unresolved', NULL,
        'rowid cannot be distinguished before insert', '${hash("7")}', 'r2', 'r2', 'authority/embed-ready', NULL,
        'negative-rowid-check', '{}', 'operator@example.com', '2026-09-14T01:00:02.000Z')`,
  ]), /rowid -1/i, "ambiguous pre-insert rowid cannot anchor a terminal decision");
  await db.batch([
    "INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at) VALUES ('ordinary-after-negative-rowid', 'reference-sample-a', 'image', NULL, 'authority/ordinary', '{}', 'owner@example.com', '2026-09-14T01:00:02.000Z')",
  ]);
  assert.deepEqual(await db.all("SELECT file_id, occurrence_id FROM file_direct_retention_edges WHERE occurrence_id = 'post-upgrade-event'"),
    [{ file_id: "embed", occurrence_id: "post-upgrade-event" }]);

  await assert.rejects(db.batch([
    "UPDATE events SET thumbnail_file_id = 'preview' WHERE id = 'post-upgrade-event'",
  ]), /purpose|readiness/i, "derived preview binding requires verified derivation evidence");

  await assert.rejects(db.batch([
    `INSERT INTO file_derivations VALUES ('false-proof', 'embed', 'preview', 'previewer', '1', '${hash("e")}', 'verified', '${hash("f")}', '${hash("d")}', 'derive-1', '{}', '2026-09-14T01:00:03.000Z')`,
  ]), /exact ready/i);
  await db.batch([
    `INSERT INTO file_derivations VALUES ('verified-proof', 'embed', 'preview', 'browser_preview', '1', '${hash("e")}', 'verified', '${hash("b")}', '${hash("d")}', 'derive-2', '{}', '2026-09-14T01:00:03.000Z')`,
    "UPDATE events SET thumbnail_file_id = 'preview' WHERE id = 'post-upgrade-event'",
    `INSERT INTO file_consumer_migration_decisions (id, consumer_kind, consumer_id, consumer_sub_id, file_slot, decision, file_id, reason, source_row_sha256, legacy_store_kind, legacy_provider, legacy_object_key, legacy_location_id, operation_id, evidence_json, decided_by, decided_at)
      VALUES ('event-resolution', 'event', 'post-upgrade-event', '', 'primary', 'resolved', 'embed', NULL, '${hash("9")}', 'r2', 'r2', 'authority/embed', NULL, 'resolve-event', '{}', 'operator@example.com', '2026-09-14T01:00:04.000Z')`,
  ]);
  await db.batch([
    `INSERT INTO assets (id, import_id, r2_key, original_name, mime_type, byte_size, status, sha256, actor_email, created_at)
      VALUES ('authority-preview-asset', NULL, 'authority/preview', 'preview.png', 'image/png', 7, 'ready',
        '${hash("d")}', 'owner@example.com', '2026-09-14T01:00:03.000Z')`,
    `INSERT INTO attachment_derivatives
      (id, source_sha256, source_byte_size, derivative_kind, generator_version, derived_asset_id, status,
        error_code, retain_until, actor_email, created_at, updated_at)
      VALUES ('mismatched-version-derivative', '${hash("b")}', 5, 'browser_preview', '2',
        'authority-preview-asset', 'ready', NULL, '2026-09-15T01:00:03.000Z', 'owner@example.com',
        '2026-09-14T01:00:03.000Z', '2026-09-14T01:00:03.000Z')`,
    `INSERT INTO attachment_derivatives
      (id, source_sha256, source_byte_size, derivative_kind, generator_version, derived_asset_id, status,
        error_code, retain_until, actor_email, created_at, updated_at)
      VALUES ('matched-version-derivative', '${hash("b")}', 5, 'browser_preview', '1',
        'authority-preview-asset', 'ready', NULL, '2026-09-15T01:00:03.000Z', 'owner@example.com',
        '2026-09-14T01:00:03.000Z', '2026-09-14T01:00:03.000Z')`,
  ]);
  await assert.rejects(db.batch([
    "UPDATE attachment_derivatives SET derived_file_id = 'preview' WHERE id = 'mismatched-version-derivative'",
  ]), /purpose|readiness/i, "derivation evidence must match the consumer's generator version");
  await db.batch([
    "UPDATE attachment_derivatives SET derived_file_id = 'preview' WHERE id = 'matched-version-derivative'",
  ]);
  await assert.rejects(db.batch([
    `INSERT INTO file_consumer_migration_decisions (id, consumer_kind, consumer_id, consumer_sub_id, file_slot, decision, file_id, reason, source_row_sha256, legacy_store_kind, legacy_provider, legacy_object_key, legacy_location_id, operation_id, evidence_json, decided_by, decided_at)
      VALUES ('wrong-event-resolution', 'event', 'post-upgrade-event', '', 'thumbnail', 'admitted_unresolved', NULL, 'unclassified', '${hash("8")}', 'r2', 'r2', 'wrong/key', NULL, 'resolve-wrong', '{}', 'operator@example.com', '2026-09-14T01:00:04.000Z')`,
  ]), /ownership|locator/i);
  await db.batch([
    "INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at) VALUES ('admitted-event', 'reference-sample-a', 'image', NULL, 'authority/embed-ready', '{}', 'owner@example.com', '2026-09-14T01:00:04.000Z')",
    `INSERT INTO file_consumer_migration_decisions (id, consumer_kind, consumer_id, consumer_sub_id, file_slot, decision, file_id, reason, source_row_sha256, legacy_store_kind, legacy_provider, legacy_object_key, legacy_location_id, operation_id, evidence_json, decided_by, decided_at)
      VALUES ('admitted-event-decision', 'event', 'admitted-event', '', 'primary', 'admitted_unresolved', NULL, 'verification unavailable', '${hash("3")}', 'r2', 'r2', 'authority/embed-ready', NULL, 'admit-event', '{}', 'operator@example.com', '2026-09-14T01:00:04.000Z')`,
  ]);
  await assert.rejects(db.batch([
    "UPDATE events SET asset_file_id = 'embed' WHERE id = 'admitted-event'",
  ]), /Admitted-unresolved/i);
  await assert.rejects(db.batch([
    "UPDATE events SET asset_key = 'authority/drifted' WHERE id = 'admitted-event'",
  ]), /locator is immutable/i);
  await assert.rejects(db.batch([
    "INSERT OR REPLACE INTO events SELECT id, sample_id, kind, body, 'authority/replaced', metadata_json, actor_email, created_at, asset_file_id, thumbnail_file_id FROM events WHERE id = 'admitted-event'",
  ]), /replacement writes/i);
  await db.batch([
    "INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at) VALUES ('replace-attacker', 'reference-sample-a', 'image', NULL, 'authority/attacker', '{}', 'owner@example.com', '2026-09-14T01:00:04.000Z')",
  ]);
  await assert.rejects(db.batch([
    "UPDATE OR REPLACE events SET id = 'admitted-event' WHERE id = 'replace-attacker'",
  ]), /conflicts with replacement update/i);
  await assert.rejects(db.batch([
    "DELETE FROM events WHERE id = 'admitted-event'",
  ]), /physically deleted/i);
  await assert.rejects(db.batch([
    "UPDATE events SET asset_key = 'authority/drifted' WHERE id = 'post-upgrade-event'",
  ]), /locator is immutable/i);
  await assert.rejects(db.batch([
    "UPDATE events SET rowid = 9000000000000000000 WHERE id = 'post-upgrade-event'",
  ]), /locator is immutable/i, "typed consumer hidden identity is immutable");
  await assert.rejects(db.batch([
    "UPDATE events SET rowid = 8999999999999999999 WHERE id = 'admitted-event'",
  ]), /locator is immutable/i, "decided consumer hidden identity is immutable");
  await db.batch([
    "INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at) VALUES ('wrong-profile-event', 'reference-sample-a', 'image', NULL, 'reference/private/execution.png', '{}', 'owner@example.com', '2026-09-14T01:00:04.000Z')",
  ]);
  await assert.rejects(db.batch([
    `INSERT INTO file_consumer_migration_decisions (id, consumer_kind, consumer_id, consumer_sub_id, file_slot, decision, file_id, reason, source_row_sha256, legacy_store_kind, legacy_provider, legacy_object_key, legacy_location_id, operation_id, evidence_json, decided_by, decided_at)
      VALUES ('wrong-profile-decision', 'event', 'wrong-profile-event', '', 'primary', 'admitted_unresolved', NULL, 'verification unavailable', '${hash("2")}', 'r2', 'r2', 'reference/private/execution.png', 'loc-profile-alias', 'admit-wrong-profile', '{}', 'operator@example.com', '2026-09-14T01:00:04.000Z')`,
  ]), /ownership|locator/i, "legacy decision location evidence cannot alias another profile with the same key");
  await db.batch([
    "INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at) VALUES ('quarantine-resolution-event', 'reference-sample-a', 'image', NULL, 'authority/embed-ready', '{\"thumbnailKey\":\"authority/preview\"}', 'owner@example.com', '2026-09-14T01:00:04.000Z')",
    "UPDATE events SET asset_file_id = 'embed' WHERE id = 'quarantine-resolution-event'",
    "UPDATE events SET thumbnail_file_id = 'preview' WHERE id = 'quarantine-resolution-event'",
  ]);

  // A File hold follows only the ready publication's active location. Older
  // verified copies require their own location hold and remain GC-eligible.
  await db.batch([
    ...baseFile("held", "job_output", 9, hash("7"), "authority-profile", "authority/held-active"),
    "INSERT INTO file_locations VALUES ('loc-held-inactive', 'held', 'authority-profile', 'authority/held-inactive', 'unresolved', '2026-09-14T01:00:00.000Z')",
    locationPublication("held", "authority-profile", "authority/held-active", 9, hash("7")),
    `INSERT INTO file_location_publications VALUES ('loc-held-inactive', 'held', 'authority-profile', 'authority/held-inactive', 9, '${hash("7")}', 'full_read_sha256', 'verify-held-inactive', '2026-09-14T01:00:01.000Z', '2026-09-14T01:00:01.000Z')`,
    filePublication("held", "job_output", 9, hash("7")),
    "INSERT INTO file_holds VALUES ('held-file-hold', 'held', 'read', 'read-held', 'active read', '2026-09-14T01:00:04.000Z', NULL, NULL)",
  ]);
  assert.deepEqual(await db.all("SELECT location_id FROM file_location_retention_edges WHERE occurrence_id = 'held-file-hold'"),
    [{ location_id: "loc-held" }]);
  await assert.rejects(db.batch([
    "INSERT INTO file_location_gc_ledger VALUES ('loc-held-inactive', 'orphaned', NULL, '2026-09-14T01:00:05.000Z', NULL, NULL, 0, NULL, '2026-09-14T01:00:05.000Z')",
  ]), /Only active File authority/i, "overlap cannot run destructive location GC");
  await db.batch([
    "UPDATE file_authority_control SET mode = 'active', updated_at = '2026-09-14T01:00:05.000Z'",
  ]);
  await assert.rejects(db.batch([
    "INSERT INTO file_location_gc_ledger VALUES ('loc-dedup-candidate', 'orphaned', NULL, '2026-09-14T01:00:05.000Z', NULL, NULL, 0, NULL, '2026-09-14T01:00:05.000Z')",
  ]), /retained|held/i, "in-flight candidate registration is a location retention edge");
  await assert.rejects(db.batch([
    filePublication("dedup-candidate", "embedded_content", 5, hash("b")),
    "UPDATE file_acceptance_candidates SET state = 'ready', result_file_id = 'embed', result_location_id = 'loc-embed', completed_at = '2026-09-14T01:00:05.000Z' WHERE candidate_file_id = 'dedup-candidate'",
  ]), /transition is invalid/i, "a published candidate cannot later be reclassified as a dedup loser");
  await db.batch([
    "UPDATE file_acceptance_candidates SET state = 'ready', result_file_id = 'embed', result_location_id = 'loc-embed', completed_at = '2026-09-14T01:00:05.000Z' WHERE candidate_file_id = 'dedup-candidate'",
  ]);
  assert.deepEqual(await db.all("SELECT candidate_file_id, result_file_id FROM file_acceptance_candidates WHERE candidate_file_id = 'dedup-candidate'"),
    [{ candidate_file_id: "dedup-candidate", result_file_id: "embed" }], "same-purpose acceptance may resolve to a distinct verified winner");
  await assert.rejects(db.batch([
    "UPDATE file_acceptance_candidates SET state = 'ready', result_file_id = 'embed', result_location_id = 'loc-embed', completed_at = '2026-09-14T01:00:05.000Z' WHERE candidate_file_id = 'quarantined-candidate'",
  ]), /transition is invalid/i, "client-declared hashes cannot deduplicate an unverified candidate");
  await db.batch([
    "UPDATE file_acceptance_candidates SET state = 'cancelled', completed_at = '2026-09-14T01:00:05.000Z' WHERE candidate_file_id = 'quarantined-candidate'",
  ]);
  await assert.rejects(db.batch([
    filePublication("quarantined-candidate", "embedded_content", 5, hash("b")),
  ]), /active location|cancel/i, "a quarantined candidate can cancel and cannot publish late");
  await db.batch([
    "INSERT INTO file_location_gc_ledger VALUES ('loc-held-inactive', 'orphaned', NULL, '2026-09-14T01:00:05.000Z', NULL, NULL, 0, NULL, '2026-09-14T01:00:05.000Z')",
    "INSERT INTO file_location_gc_ledger VALUES ('loc-profile-isolated', 'orphaned', NULL, '2026-09-14T01:00:05.000Z', NULL, NULL, 0, NULL, '2026-09-14T01:00:05.000Z')",
    "INSERT INTO file_location_gc_ledger VALUES ('loc-cancel-before', 'orphaned', NULL, '2026-09-14T01:00:05.000Z', NULL, NULL, 0, NULL, '2026-09-14T01:00:05.000Z')",
    "INSERT INTO file_location_gc_ledger VALUES ('loc-dedup-candidate', 'orphaned', NULL, '2026-09-14T01:00:05.000Z', NULL, NULL, 0, NULL, '2026-09-14T01:00:05.000Z')",
    "INSERT INTO file_location_gc_ledger VALUES ('loc-quarantined-candidate', 'orphaned', NULL, '2026-09-14T01:00:05.000Z', NULL, NULL, 0, NULL, '2026-09-14T01:00:05.000Z')",
  ]);

  await db.batch([
    ...baseFile("orphan", "job_output", 8, hash("e"), "authority-profile", "authority/orphan"),
    locationPublication("orphan", "authority-profile", "authority/orphan", 8, hash("e")),
    "INSERT INTO file_location_holds VALUES ('orphan-hold', 'loc-orphan', 'cleanup', 'cleanup-1', 'race fence', '2026-09-14T01:00:05.000Z', NULL, NULL)",
  ]);
  await assert.rejects(db.batch([
    "INSERT INTO file_location_gc_ledger VALUES ('loc-orphan', 'orphaned', NULL, '2026-09-14T01:00:06.000Z', NULL, NULL, 0, NULL, '2026-09-14T01:00:06.000Z')",
  ]), /retained|held/i);
  await assert.rejects(db.batch([
    "INSERT INTO file_location_holds VALUES ('invalid-time-hold', 'loc-orphan', 'cleanup', 'invalid-time', 'must parse', 'a', 'z', NULL)",
  ]), /CHECK|constraint/i, "lexically ordered non-timestamps cannot create invisible holds");
  await assert.rejects(db.batch([
    "INSERT INTO file_location_holds VALUES ('nul-time-hold', 'loc-orphan', 'cleanup', 'nul-time', 'must be canonical', '2026-09-14T01:00:06.000Z' || char(0) || 'hidden', NULL, NULL)",
  ]), /CHECK|constraint/i, "parseable prefixes with hidden NUL suffixes cannot become authority evidence");
  await db.batch([
    "UPDATE file_location_holds SET released_at = '2026-09-14T01:00:07.000Z' WHERE id = 'orphan-hold'",
    "INSERT INTO file_location_gc_ledger VALUES ('loc-orphan', 'orphaned', NULL, '2026-09-14T01:00:06.000Z', NULL, NULL, 0, NULL, '2026-09-14T01:00:06.000Z')",
  ]);
  await assert.rejects(db.batch([
    "INSERT OR REPLACE INTO file_location_gc_ledger SELECT * FROM file_location_gc_ledger WHERE location_id = 'loc-orphan'",
  ]), /history already exists/i);
  await assert.rejects(db.batch([
    "UPDATE file_location_gc_ledger SET state = 'deleting', operation_id = 'delete-orphan', deletion_started_at = '2026-09-14T01:00:08.000Z', attempt_count = 2, updated_at = '2026-09-14T01:00:08.000Z' WHERE location_id = 'loc-orphan'",
  ]), /invalid location deletion transition/i, "first claim increments exactly once");
  await db.batch([
    "UPDATE file_location_gc_ledger SET state = 'deleting', operation_id = 'delete-orphan', deletion_started_at = '2026-09-14T01:00:08.000Z', attempt_count = 1, updated_at = '2026-09-14T01:00:08.000Z' WHERE location_id = 'loc-orphan'",
  ]);
  for (const sql of [
    "UPDATE file_location_gc_ledger SET operation_id = 'swapped-operation', last_error = 'failed', updated_at = '2026-09-14T01:00:09.000Z' WHERE location_id = 'loc-orphan'",
    "UPDATE file_location_gc_ledger SET attempt_count = 3, last_error = 'inflated', updated_at = '2026-09-14T01:00:09.000Z' WHERE location_id = 'loc-orphan'",
    "UPDATE file_location_gc_ledger SET attempt_count = 2, deletion_started_at = '2026-09-14T01:00:07.000Z', last_error = NULL, updated_at = '2026-09-14T01:00:07.000Z' WHERE location_id = 'loc-orphan'",
    "UPDATE file_location_gc_ledger SET state = 'deleted', deleted_at = '2026-09-14T01:00:09.000Z', updated_at = '2026-09-14T01:00:08.500Z' WHERE location_id = 'loc-orphan'",
  ]) await assert.rejects(db.batch([sql]), /invalid location deletion transition|CHECK|constraint/i, sql);
  await db.batch([
    "UPDATE file_location_gc_ledger SET last_error = 'provider timeout', updated_at = '2026-09-14T01:00:09.000Z' WHERE location_id = 'loc-orphan'",
  ]);
  await assert.rejects(db.batch([
    "UPDATE file_location_gc_ledger SET attempt_count = 2, deletion_started_at = '2026-09-14T01:00:08.500Z', last_error = NULL, updated_at = '2026-09-14T01:00:08.500Z' WHERE location_id = 'loc-orphan'",
  ]), /invalid location deletion transition/i, "retry evidence cannot move behind the last recorded event");
  await db.batch([
    "UPDATE file_location_gc_ledger SET attempt_count = 2, deletion_started_at = '2026-09-14T01:00:09.500Z', last_error = NULL, updated_at = '2026-09-14T01:00:09.500Z' WHERE location_id = 'loc-orphan'",
  ]);
  await assert.rejects(db.batch([
    "INSERT INTO file_location_holds VALUES ('late-hold', 'loc-orphan', 'read', 'read-late', 'too late', '2026-09-14T01:00:09.000Z', NULL, NULL)",
  ]), /deletion begins/i);
  await db.batch([
    "UPDATE file_location_gc_ledger SET last_error = 'provider retry timeout', updated_at = '2026-09-14T01:00:10.000Z' WHERE location_id = 'loc-orphan'",
  ]);
  await assert.rejects(db.batch([
    "UPDATE file_location_gc_ledger SET state = 'deleted', deleted_at = '2026-09-14T01:00:09.750Z', last_error = NULL, updated_at = '2026-09-14T01:00:09.750Z' WHERE location_id = 'loc-orphan'",
  ]), /invalid location deletion transition/i, "completion evidence cannot move behind the last recorded event");
  await db.batch([
    "UPDATE file_location_gc_ledger SET state = 'deleted', deleted_at = '2026-09-14T01:00:10.500Z', last_error = NULL, updated_at = '2026-09-14T01:00:10.500Z' WHERE location_id = 'loc-orphan'",
  ]);
  for (const sql of [
    `INSERT INTO file_location_integrity_quarantine VALUES ('loc-preview', 'missing', 7, 7, '${hash("d")}', NULL, 'false-missing', '2026-09-14T01:00:11.000Z', '2026-09-14T01:00:11.000Z')`,
    `INSERT INTO file_location_integrity_quarantine VALUES ('loc-preview', 'size_mismatch', 7, 7, '${hash("d")}', NULL, 'false-size', '2026-09-14T01:00:11.000Z', '2026-09-14T01:00:11.000Z')`,
    `INSERT INTO file_location_integrity_quarantine VALUES ('loc-preview', 'hash_mismatch', 7, 7, '${hash("d")}', '${hash("d")}', 'false-hash', '2026-09-14T01:00:11.000Z', '2026-09-14T01:00:11.000Z')`,
    `INSERT INTO file_location_integrity_quarantine VALUES ('loc-preview', 'external_modification', 7, NULL, '${hash("d")}', '${hash("0")}', 'false-external', '2026-09-14T01:00:11.000Z', '2026-09-14T01:00:11.000Z')`,
  ]) await assert.rejects(db.batch([sql]), /CHECK|constraint/i, sql);
  await db.batch([
    `INSERT INTO file_location_integrity_quarantine VALUES ('loc-preview', 'hash_mismatch', 7, 7, '${hash("d")}', '${hash("0")}', 'quarantine-preview', '2026-09-14T01:00:11.000Z', '2026-09-14T01:00:11.000Z')`,
  ]);
  await assert.rejects(db.batch([
    "INSERT INTO events (id, sample_id, kind, body, asset_key, metadata_json, actor_email, created_at) VALUES ('quarantine-bind-event', 'reference-sample-a', 'image', NULL, 'authority/embed-ready', '{\"thumbnailKey\":\"authority/preview\"}', 'owner@example.com', '2026-09-14T01:00:11.000Z')",
    "UPDATE events SET asset_file_id = 'embed' WHERE id = 'quarantine-bind-event'",
    "UPDATE events SET thumbnail_file_id = 'preview' WHERE id = 'quarantine-bind-event'",
  ]), /purpose|readiness/i, "quarantined active locations cannot gain typed bindings");
  await assert.rejects(db.batch([
    `INSERT INTO file_consumer_migration_decisions (id, consumer_kind, consumer_id, consumer_sub_id, file_slot, decision, file_id, reason, source_row_sha256, legacy_store_kind, legacy_provider, legacy_object_key, legacy_location_id, operation_id, evidence_json, decided_by, decided_at)
      VALUES ('quarantined-event-resolution', 'event', 'quarantine-resolution-event', '', 'thumbnail', 'resolved', 'preview', NULL, '${hash("5")}', 'r2', 'r2', 'authority/preview', NULL, 'resolve-quarantined', '{}', 'operator@example.com', '2026-09-14T01:00:11.000Z')`,
  ]), /ownership|locator/i, "quarantined publications cannot authorize a resolved migration decision");
  await assert.rejects(db.batch([
    `INSERT INTO file_derivations VALUES ('quarantined-source-proof', 'preview', 'preview2', 'previewer', '1', '${hash("4")}', 'verified', '${hash("d")}', '${hash("6")}', 'derive-quarantined', '{}', '2026-09-14T01:00:11.000Z')`,
  ]), /exact ready/i, "quarantined source publications cannot certify derivations");
  await assert.rejects(db.batch([
    "INSERT INTO file_location_gc_ledger VALUES ('loc-preview', 'orphaned', NULL, '2026-09-14T01:00:12.000Z', NULL, NULL, 0, NULL, '2026-09-14T01:00:12.000Z')",
  ]), /retained|held/i);

  assert.deepEqual(await db.all("SELECT location_id, availability FROM file_location_availability WHERE location_id IN ('loc-orphan', 'loc-preview') ORDER BY location_id"), [
    { location_id: "loc-orphan", availability: "deleted" },
    { location_id: "loc-preview", availability: "quarantined" },
  ]);
  for (const table of authorityTables) {
    assert.notDeepEqual(await db.all(`SELECT * FROM ${table} LIMIT 1`), [], `${table} has a replace-fence fixture`);
    await assert.rejects(db.batch([
      `INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} LIMIT 1`,
    ]), /already exists|immutable|history|exact ready|constraint|deletion begins/i, `${table} rejects INSERT OR REPLACE`);
  }
  assert.deepEqual(await db.all("PRAGMA foreign_key_check"), []);
  assert.deepEqual(await db.all("PRAGMA quick_check"), [{ quick_check: "ok" }]);
  return {
    control: await db.all("SELECT singleton, mode, revision FROM file_authority_control"),
    publications: await db.all("SELECT file_id, purpose, active_location_id FROM file_publications ORDER BY file_id"),
    derivations: await db.all("SELECT id, trust_state FROM file_derivations"),
    decisions: await db.all("SELECT id, decision, file_id FROM file_consumer_migration_decisions"),
    availability: await db.all("SELECT location_id, availability FROM file_location_availability ORDER BY location_id"),
  };
}

test("0007 is an atomic populated expand with strict legacy gates and latent ownership/lifecycle guards on SQLite and D1", { timeout: 90_000 }, async () => {
  const host = new DatabaseSync(":memory:");
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("file authority qualification") } }',
    compatibilityDate: "2026-07-20",
    d1Databases: ["DB"],
    log: new Log(LogLevel.ERROR),
  });
  try {
    const hostDb = hostAdapter(host);
    const d1Db = d1Adapter(await mf.getD1Database("DB"));
    await verifyLegacyExpand(hostDb);
    await verifyLegacyExpand(d1Db);
    assert.deepEqual(await verifyLatentGuards(d1Db), await verifyLatentGuards(hostDb));
    assert.deepEqual(plain(host.prepare("PRAGMA integrity_check").all()), [{ integrity_check: "ok" }]);
  } finally {
    host.close();
    await mf.dispose();
  }
});

test("0007 fresh installation creates only legacy control and read-only profile runtime state", { timeout: 60_000 }, async () => {
  const host = new DatabaseSync(":memory:");
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("fresh authority qualification") } }',
    compatibilityDate: "2026-07-20",
    d1Databases: ["FRESH"],
    log: new Log(LogLevel.ERROR),
  });
  try {
    for (const db of [hostAdapter(host), d1Adapter(await mf.getD1Database("FRESH"))]) {
      for (const name of preceding) await apply(db, read(`migrations/${name}`));
      await apply(db, migrationSql);
      assert.deepEqual(await db.all("SELECT singleton, mode, revision, activated_at FROM file_authority_control"),
        [{ singleton: 1, mode: "legacy", revision: 1, activated_at: null }]);
      assert.deepEqual(await db.all("SELECT * FROM storage_profile_runtime"), []);
      for (const table of authorityTables) assert.deepEqual(await db.all(`SELECT * FROM ${table}`), []);
      assert.deepEqual(await db.all("PRAGMA foreign_key_check"), []);
    }
  } finally {
    host.close();
    await mf.dispose();
  }
});

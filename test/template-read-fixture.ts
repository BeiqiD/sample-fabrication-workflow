/** Private synthetic records only. Shared by genuine native SQLite and actual
 * Miniflare D1 qualification; never a provider/mock/production fixture. */
export const TEMPLATE_READ_FIXTURE_SQL = `
INSERT INTO recipe_families(id,name,template_type,created_at) VALUES
 ('qa-family-a','QA family A','process','2026-08-01T00:00:00.000Z'),
 ('qa-family-b','QA family B','process','2026-08-01T00:00:00.000Z'),
 ('qa-family-m','QA family M','module','2026-08-01T00:00:00.000Z'),
 ('qa-family-z','QA family Z','module','2026-08-01T00:00:00.000Z');
INSERT INTO state_representations(hash,content_json,created_at) VALUES
 ('qa-initial','{}','2026-08-01T00:00:00.000Z'),('qa-expected','{}','2026-08-01T00:00:00.000Z');
INSERT INTO step_definitions(hash,name,tool_name,parameters_text,comments_text,canonical_json,created_at) VALUES
 ('qa-definition','Etch','RIE','power=5','notes','{}','2026-08-01T00:00:00.000Z'),
 ('qa-afm-definition','AFM','Dimension 3100','Flatten order 1','  ','{}','2026-08-01T00:00:00.000Z'),
 ('qa-empty-definition','Zulu','  ','   ','  ','{}','2026-08-01T00:00:00.000Z');
INSERT INTO template_versions(id,recipe_family_id,name,template_type,template_kind,version,manifest_hash,
 initial_state_hash,source_filename,content_json,created_at,archived_at,deleted_at,metrology_notes) VALUES
 ('qa-a1','qa-family-a','QA Alpha old','process','process',1,'qa-a1-manifest',NULL,'legacy_wafer.xlsx','{}','2026-08-01T00:00:00.000Z',NULL,NULL,NULL),
 ('qa-a2','qa-family-a','QA Alpha etch','process','process',2,'qa-a2-manifest','qa-initial','current.xlsx','{"initialSubstrateStep":{"stepNumber":"0","name":"Substrate Stack"}}','2026-08-02T00:00:00.000Z',NULL,NULL,NULL),
 ('qa-a3','qa-family-a','QA Alpha archived','process','process',3,'qa-a3-manifest',NULL,NULL,'{}','2026-08-03T00:00:00.000Z','2026-08-03T01:00:00.000Z',NULL,NULL),
 ('qa-a4','qa-family-a','QA Alpha deleted','process','process',4,'qa-a4-manifest',NULL,NULL,'{}','2026-08-04T00:00:00.000Z',NULL,'2026-08-04T01:00:00.000Z',NULL),
 ('qa-a5','qa-family-a','QA Alpha pending','process','process',5,'qa-a5-manifest',NULL,NULL,'{}','2026-08-05T00:00:00.000Z',NULL,NULL,NULL),
 ('qa-b1','qa-family-b','QA Beta mask','process','process',1,'qa-b1-manifest',NULL,NULL,'{}','2026-08-01T00:00:00.000Z',NULL,NULL,NULL),
 ('qa-m1','qa-family-m','QA AFM %_','module','metrology',1,'qa-m1-manifest',NULL,NULL,'{}','2026-08-01T00:00:00.000Z',NULL,NULL,'Measured notes'),
 ('qa-z1','qa-family-z','QA Zulu','module','metrology',1,'qa-z1-manifest',NULL,NULL,'{}','2026-08-01T00:00:00.000Z',NULL,NULL,NULL);
INSERT INTO template_steps(id,template_version_id,logical_step_key,position,source_row,step_number,definition_hash,expected_state_hash) VALUES
 ('qa-a1-step','qa-a1','qa-old',0,1,'1','qa-definition',NULL),
 ('qa-a2-step-last','qa-a2','qa-last',1,12,'2','qa-definition',NULL),
 ('qa-a2-step-first','qa-a2','qa-first',0,5,'1','qa-definition','qa-expected'),
 ('qa-m-step','qa-m1','qa-metrology',0,NULL,NULL,'qa-afm-definition',NULL),
 ('qa-z-step','qa-z1','qa-empty',0,NULL,NULL,'qa-empty-definition',NULL);
INSERT INTO imports(id,status,source_filename,source_sha256,sheet_name,template_type,template_version_id,created_at) VALUES
 ('qa-pending-import','pending','pending.xlsx','qa-pending-sha','Sheet 1','process','qa-a5','2026-08-01T00:00:00.000Z'),
 ('qa-hidden-asset-import','ready','hidden.xlsx','qa-hidden-sha','Sheet 1','process',NULL,'2026-08-01T00:00:00.000Z'),
 ('qa-ready-import','ready','ready.xlsx','qa-ready-sha','Sheet 1','process',NULL,'2026-08-01T00:00:00.000Z');
INSERT INTO assets(id,import_id,r2_key,original_name,mime_type,byte_size,status,created_at) VALUES
 ('qa-asset-a',NULL,'qa/initial-a.png','a.png','image/png',4,'ready','2026-08-01T00:00:00.000Z'),
 ('qa-asset-b','qa-ready-import','qa/initial-b.png','b.png','image/png',8,'ready','2026-08-01T00:00:00.000Z'),
 ('qa-asset-pending','qa-hidden-asset-import','qa/unpublished.png','pending.png','image/png',4,'ready','2026-08-01T00:00:00.000Z'),
 ('qa-asset-not-ready',NULL,'qa/not-ready.png','pending.png','image/png',4,'ready','2026-08-01T00:00:00.000Z');
INSERT INTO state_representation_assets(state_hash,asset_id,position) VALUES
 ('qa-initial','qa-asset-b',1),('qa-initial','qa-asset-a',0),('qa-initial','qa-asset-pending',2),
 ('qa-initial','qa-asset-not-ready',3),('qa-expected','qa-asset-b',0),('qa-expected','qa-asset-pending',1);
INSERT INTO metrology_template_references(id,template_version_id,asset_id,display_name,position,created_at) VALUES
 ('qa-ref-b','qa-m1','qa-asset-b','b.png',1,'2026-08-01T00:00:00.000Z'),
 ('qa-ref-a','qa-m1','qa-asset-a','a.png',0,'2026-08-02T00:00:00.000Z'),
 ('qa-ref-pending','qa-m1','qa-asset-pending','pending.png',2,'2026-08-01T00:00:00.000Z');
-- Attach only currently published/ready metadata under every existing guard.
-- Ordinary later status demotion then exercises the mature read filters;
-- no File-authority or consumer guard is removed, replaced or bypassed.
UPDATE imports SET status='failed' WHERE id='qa-hidden-asset-import';
UPDATE assets SET status='pending' WHERE id='qa-asset-not-ready';
`;
export const TEMPLATE_READ_FIXTURE_TABLES = ["recipe_families", "template_versions", "template_steps", "step_definitions",
  "state_representations", "state_representation_assets", "assets", "imports", "metrology_template_references"] as const;

-- INACTIVE 0025/V27 paired-checkpoint candidate; not an installed migration.
-- This design input is absent from migrations/ and every operational selector.
-- Group enforcement remains disabled; recovery discards every source authority row.

CREATE TABLE collaboration_control (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 schema_version INTEGER NOT NULL CHECK(schema_version=1),
 enforcement TEXT NOT NULL CHECK(enforcement='disabled')
) WITHOUT ROWID;
INSERT INTO collaboration_control VALUES(1,1,'disabled');
CREATE TRIGGER collaboration_control_update_guard BEFORE UPDATE ON collaboration_control
 BEGIN SELECT RAISE(ABORT,'Collaboration enforcement requires a reviewed forward migration'); END;
CREATE TRIGGER collaboration_control_delete_guard BEFORE DELETE ON collaboration_control
 BEGIN SELECT RAISE(ABORT,'Collaboration control is installation owned'); END;
CREATE TRIGGER collaboration_control_insert_guard BEFORE INSERT ON collaboration_control
 BEGIN SELECT RAISE(ABORT,'Collaboration control is installation owned'); END;

-- One deployment/lab, no tenant/database/provider ownership column.
CREATE TABLE collaboration_members (
 member_id TEXT PRIMARY KEY CHECK(typeof(member_id)='text' AND length(member_id)=36 AND instr(member_id,char(0))=0),
 display_name TEXT NOT NULL CHECK(typeof(display_name)='text' AND length(display_name) BETWEEN 1 AND 200 AND instr(display_name,char(0))=0),
 state TEXT NOT NULL CHECK(state IN('active','suspended','left')),
 workspace_role TEXT NOT NULL CHECK(workspace_role IN('member','membershipAdministrator')),
 can_create_samples INTEGER NOT NULL DEFAULT 0 CHECK(can_create_samples IN(0,1)),
 can_create_projects INTEGER NOT NULL DEFAULT 0 CHECK(can_create_projects IN(0,1)),
 can_create_templates INTEGER NOT NULL DEFAULT 0 CHECK(can_create_templates IN(0,1)),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991)
) WITHOUT ROWID;
CREATE TRIGGER collaboration_member_revision_guard BEFORE UPDATE ON collaboration_members BEGIN
 SELECT RAISE(ABORT,'Membership identity is immutable') WHERE NEW.member_id IS NOT OLD.member_id;
 SELECT RAISE(ABORT,'Membership requires an exact next revision') WHERE NEW.revision<>OLD.revision+1;
END;

-- Only explicitly reconciled verified issuer+subject maps. No email, creator,
-- importer, filename, storage profile, actor-syntax or archive grants.
CREATE TABLE collaboration_identities (
 provider TEXT NOT NULL CHECK(provider IN('access','local')),
 issuer TEXT NOT NULL CHECK(typeof(issuer)='text' AND length(issuer) BETWEEN 1 AND 2048 AND instr(issuer,char(0))=0),
 subject TEXT NOT NULL CHECK(typeof(subject)='text' AND length(subject) BETWEEN 1 AND 256 AND instr(subject,char(0))=0),
 member_id TEXT NOT NULL REFERENCES collaboration_members(member_id) ON DELETE RESTRICT,
 enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY(provider,issuer,subject)
) WITHOUT ROWID;
CREATE INDEX collaboration_identities_member_idx ON collaboration_identities(member_id);
CREATE TRIGGER collaboration_identity_revision_guard BEFORE UPDATE ON collaboration_identities BEGIN
 SELECT RAISE(ABORT,'Verified identity binding is immutable') WHERE NEW.provider IS NOT OLD.provider OR NEW.issuer IS NOT OLD.issuer
  OR NEW.subject IS NOT OLD.subject OR NEW.member_id IS NOT OLD.member_id;
 SELECT RAISE(ABORT,'Identity binding requires an exact next revision') WHERE NEW.revision<>OLD.revision+1;
END;

-- Template is a recipe_family root; process/metrology revisions inherit it.
CREATE TABLE collaboration_resources (
 root_kind TEXT NOT NULL CHECK(root_kind IN('sample','project','template')),
 root_id TEXT NOT NULL CHECK(typeof(root_id)='text' AND length(root_id) BETWEEN 1 AND 256 AND instr(root_id,char(0))=0),
 visibility TEXT NOT NULL CHECK(visibility IN('restricted','workspace')),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY(root_kind,root_id)
) WITHOUT ROWID;
CREATE TRIGGER collaboration_resource_insert_guard BEFORE INSERT ON collaboration_resources BEGIN
 SELECT RAISE(ABORT,'Collaboration root must be a genuine existing resource') WHERE
  (NEW.root_kind='sample' AND NOT EXISTS(SELECT 1 FROM samples WHERE id=NEW.root_id)) OR
  (NEW.root_kind='project' AND NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.root_id)) OR
  (NEW.root_kind='template' AND NOT EXISTS(SELECT 1 FROM recipe_families WHERE id=NEW.root_id));
END;
CREATE TRIGGER collaboration_resource_revision_guard BEFORE UPDATE ON collaboration_resources BEGIN
 SELECT RAISE(ABORT,'Collaboration root identity is immutable') WHERE NEW.root_kind IS NOT OLD.root_kind OR NEW.root_id IS NOT OLD.root_id;
 SELECT RAISE(ABORT,'Root policy requires an exact next revision') WHERE NEW.revision<>OLD.revision+1;
END;

CREATE TABLE collaboration_grants (
 root_kind TEXT NOT NULL,
 root_id TEXT NOT NULL,
 member_id TEXT NOT NULL REFERENCES collaboration_members(member_id) ON DELETE RESTRICT,
 capability TEXT NOT NULL CHECK(capability IN('read','operate','edit','manage')),
 enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 CHECK(capability<>'operate' OR root_kind='sample'),
 PRIMARY KEY(root_kind,root_id,member_id),
 FOREIGN KEY(root_kind,root_id) REFERENCES collaboration_resources(root_kind,root_id) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE INDEX collaboration_grants_member_idx ON collaboration_grants(member_id,enabled,root_kind,root_id);
CREATE TRIGGER collaboration_grant_revision_guard BEFORE UPDATE ON collaboration_grants BEGIN
 SELECT RAISE(ABORT,'Resource grant identity is immutable') WHERE NEW.root_kind IS NOT OLD.root_kind OR NEW.root_id IS NOT OLD.root_id OR NEW.member_id IS NOT OLD.member_id;
 SELECT RAISE(ABORT,'Resource grant requires an exact next revision') WHERE NEW.revision<>OLD.revision+1;
END;
-- Departure never removes shared resources or their File/provider bindings.
-- A later rejoin does not reactivate old restricted grants implicitly.
CREATE TRIGGER collaboration_member_departure AFTER UPDATE OF state ON collaboration_members
 WHEN OLD.state<>'left' AND NEW.state='left' BEGIN
 UPDATE collaboration_grants SET enabled=0,revision=revision+1 WHERE member_id=NEW.member_id AND enabled=1;
END;

-- Retain policy identities and their revision history. Explicit UPDATE with an
-- exact next revision is the only reconciliation path; INSERT OR REPLACE and
-- UPSERT must not remove/recreate a key at revision 1. No physical DELETE path.
CREATE TRIGGER collaboration_member_insert_guard BEFORE INSERT ON collaboration_members BEGIN
 SELECT RAISE(ABORT,'Membership identity is retained') WHERE EXISTS(SELECT 1 FROM collaboration_members WHERE member_id=NEW.member_id);
 SELECT RAISE(ABORT,'Membership starts at revision one') WHERE NEW.revision<>1;
END;
CREATE TRIGGER collaboration_member_delete_guard BEFORE DELETE ON collaboration_members
 BEGIN SELECT RAISE(ABORT,'Membership identity is retained'); END;
CREATE TRIGGER collaboration_identity_insert_guard BEFORE INSERT ON collaboration_identities BEGIN
 SELECT RAISE(ABORT,'Verified identity binding is retained') WHERE EXISTS(SELECT 1 FROM collaboration_identities WHERE provider=NEW.provider AND issuer=NEW.issuer AND subject=NEW.subject);
 SELECT RAISE(ABORT,'Identity binding starts at revision one') WHERE NEW.revision<>1;
END;
CREATE TRIGGER collaboration_identity_delete_guard BEFORE DELETE ON collaboration_identities
 BEGIN SELECT RAISE(ABORT,'Verified identity binding is retained'); END;
CREATE TRIGGER collaboration_resource_reinsert_guard BEFORE INSERT ON collaboration_resources BEGIN
 SELECT RAISE(ABORT,'Collaboration root policy is retained') WHERE EXISTS(SELECT 1 FROM collaboration_resources WHERE root_kind=NEW.root_kind AND root_id=NEW.root_id);
 SELECT RAISE(ABORT,'Root policy starts at revision one') WHERE NEW.revision<>1;
END;
CREATE TRIGGER collaboration_resource_delete_guard BEFORE DELETE ON collaboration_resources
 BEGIN SELECT RAISE(ABORT,'Collaboration root policy is retained'); END;
CREATE TRIGGER collaboration_grant_insert_guard BEFORE INSERT ON collaboration_grants BEGIN
 SELECT RAISE(ABORT,'Resource grant identity is retained') WHERE EXISTS(SELECT 1 FROM collaboration_grants WHERE root_kind=NEW.root_kind AND root_id=NEW.root_id AND member_id=NEW.member_id);
 SELECT RAISE(ABORT,'Resource grant starts at revision one') WHERE NEW.revision<>1;
END;
CREATE TRIGGER collaboration_grant_delete_guard BEFORE DELETE ON collaboration_grants
 BEGIN SELECT RAISE(ABORT,'Resource grant identity is retained'); END;

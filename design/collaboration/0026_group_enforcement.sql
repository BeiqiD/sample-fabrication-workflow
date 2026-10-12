-- SOURCE-ONLY 0026/V28 forward candidate, absent from migrations/ and defaults.
-- Installing this metadata NEVER activates permissions or enrolls a principal.
-- V27 remains byte-exact; V28 recovery requires its own closed image/records V5.

DROP TRIGGER collaboration_control_update_guard;
DROP TRIGGER collaboration_control_delete_guard;
DROP TRIGGER collaboration_control_insert_guard;
PRAGMA legacy_alter_table=ON;
ALTER TABLE collaboration_control RENAME TO collaboration_control_v27;
CREATE TABLE collaboration_control (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 schema_version INTEGER NOT NULL CHECK(schema_version=2),
 enforcement TEXT NOT NULL CHECK(enforcement IN('disabled','enabled')),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991)
) WITHOUT ROWID;
-- Previously inert V27 authority records are not grandfathered into grants.
-- A missing/invalid/nonempty predecessor fails the NOT NULL primary key instead of
-- yielding an apparently installed checkpoint with no destination control.
INSERT INTO collaboration_control(singleton,schema_version,enforcement,revision)
 SELECT CASE WHEN COUNT(*)=1 AND MIN(singleton)=1 AND MIN(schema_version)=1
   AND MIN(enforcement)='disabled'
   AND NOT EXISTS(SELECT 1 FROM collaboration_members)
   AND NOT EXISTS(SELECT 1 FROM collaboration_identities)
   AND NOT EXISTS(SELECT 1 FROM collaboration_resources)
   AND NOT EXISTS(SELECT 1 FROM collaboration_grants) THEN 1 ELSE NULL END,2,'disabled',1
 FROM collaboration_control_v27;
DROP TABLE collaboration_control_v27;
PRAGMA legacy_alter_table=OFF;
CREATE TRIGGER collaboration_control_update_guard BEFORE UPDATE ON collaboration_control BEGIN
 SELECT RAISE(ABORT,'Collaboration control identity is immutable')
  WHERE NEW.singleton IS NOT OLD.singleton OR NEW.schema_version IS NOT OLD.schema_version;
 SELECT RAISE(ABORT,'Collaboration control requires an exact next revision')
  WHERE NEW.revision<>OLD.revision+1;
END;
CREATE TRIGGER collaboration_control_delete_guard BEFORE DELETE ON collaboration_control
 BEGIN SELECT RAISE(ABORT,'Collaboration control is installation owned'); END;
CREATE TRIGGER collaboration_control_insert_guard BEFORE INSERT ON collaboration_control
 BEGIN SELECT RAISE(ABORT,'Collaboration control is installation owned'); END;

-- Ordinary local-account provisioning is an explicit stopped-writer operation,
-- separate from installation bootstrap and every administrator/resource grant.
-- Retain original local audit provenance while admitting one precise new kind.
PRAGMA legacy_alter_table=ON;
ALTER TABLE local_auth_events RENAME TO local_auth_events_v27;
CREATE TABLE local_auth_events (
    sequence INTEGER PRIMARY KEY,
    principal_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('bootstrap','destination_bootstrap','login','login_denied','session_rotated','password_reset','account_disabled','administrator_revoked','account_created')),
    happened_at INTEGER NOT NULL CHECK(happened_at >= 0)
  ) STRICT;
INSERT INTO local_auth_events(sequence,principal_id,kind,happened_at)
 SELECT sequence,principal_id,kind,happened_at FROM local_auth_events_v27 ORDER BY sequence;
DROP TABLE local_auth_events_v27;
PRAGMA legacy_alter_table=OFF;

// Inactive, code-owned 0025/V27 candidate. No operational selector imports it.
// Static candidate pins require genuine native/recovery qualification before publication.
import type { InstallationSchemaObject } from "./node-installation-schema";
import type { RecoveryTableSpec, SystemRecoveryTable } from "./system-recovery-image";
export const COLLABORATION_MIGRATION_NAME_V27 = "0025_group_authorization.sql" as const;
export const COLLABORATION_MIGRATION_RAW_SHA256_V27 = "b2050cb78c1dc4a6004f4d22f2a4fd6ae873c9ce27fe8bc7e4c8ae2d16a0e60d" as const;
export const COLLABORATION_MIGRATION_SQL_V27 = "-- INACTIVE 0025/V27 paired-checkpoint candidate; not an installed migration.\n-- This design input is absent from migrations/ and every operational selector.\n-- Group enforcement remains disabled; recovery discards every source authority row.\n\nCREATE TABLE collaboration_control (\n singleton INTEGER PRIMARY KEY CHECK(singleton=1),\n schema_version INTEGER NOT NULL CHECK(schema_version=1),\n enforcement TEXT NOT NULL CHECK(enforcement='disabled')\n) WITHOUT ROWID;\nINSERT INTO collaboration_control VALUES(1,1,'disabled');\nCREATE TRIGGER collaboration_control_update_guard BEFORE UPDATE ON collaboration_control\n BEGIN SELECT RAISE(ABORT,'Collaboration enforcement requires a reviewed forward migration'); END;\nCREATE TRIGGER collaboration_control_delete_guard BEFORE DELETE ON collaboration_control\n BEGIN SELECT RAISE(ABORT,'Collaboration control is installation owned'); END;\nCREATE TRIGGER collaboration_control_insert_guard BEFORE INSERT ON collaboration_control\n BEGIN SELECT RAISE(ABORT,'Collaboration control is installation owned'); END;\n\n-- One deployment/lab, no tenant/database/provider ownership column.\nCREATE TABLE collaboration_members (\n member_id TEXT PRIMARY KEY CHECK(typeof(member_id)='text' AND length(member_id)=36 AND instr(member_id,char(0))=0),\n display_name TEXT NOT NULL CHECK(typeof(display_name)='text' AND length(display_name) BETWEEN 1 AND 200 AND instr(display_name,char(0))=0),\n state TEXT NOT NULL CHECK(state IN('active','suspended','left')),\n workspace_role TEXT NOT NULL CHECK(workspace_role IN('member','membershipAdministrator')),\n can_create_samples INTEGER NOT NULL DEFAULT 0 CHECK(can_create_samples IN(0,1)),\n can_create_projects INTEGER NOT NULL DEFAULT 0 CHECK(can_create_projects IN(0,1)),\n can_create_templates INTEGER NOT NULL DEFAULT 0 CHECK(can_create_templates IN(0,1)),\n revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991)\n) WITHOUT ROWID;\nCREATE TRIGGER collaboration_member_revision_guard BEFORE UPDATE ON collaboration_members BEGIN\n SELECT RAISE(ABORT,'Membership identity is immutable') WHERE NEW.member_id IS NOT OLD.member_id;\n SELECT RAISE(ABORT,'Membership requires an exact next revision') WHERE NEW.revision<>OLD.revision+1;\nEND;\n\n-- Only explicitly reconciled verified issuer+subject maps. No email, creator,\n-- importer, filename, storage profile, actor-syntax or archive grants.\nCREATE TABLE collaboration_identities (\n provider TEXT NOT NULL CHECK(provider IN('access','local')),\n issuer TEXT NOT NULL CHECK(typeof(issuer)='text' AND length(issuer) BETWEEN 1 AND 2048 AND instr(issuer,char(0))=0),\n subject TEXT NOT NULL CHECK(typeof(subject)='text' AND length(subject) BETWEEN 1 AND 256 AND instr(subject,char(0))=0),\n member_id TEXT NOT NULL REFERENCES collaboration_members(member_id) ON DELETE RESTRICT,\n enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),\n revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),\n PRIMARY KEY(provider,issuer,subject)\n) WITHOUT ROWID;\nCREATE INDEX collaboration_identities_member_idx ON collaboration_identities(member_id);\nCREATE TRIGGER collaboration_identity_revision_guard BEFORE UPDATE ON collaboration_identities BEGIN\n SELECT RAISE(ABORT,'Verified identity binding is immutable') WHERE NEW.provider IS NOT OLD.provider OR NEW.issuer IS NOT OLD.issuer\n  OR NEW.subject IS NOT OLD.subject OR NEW.member_id IS NOT OLD.member_id;\n SELECT RAISE(ABORT,'Identity binding requires an exact next revision') WHERE NEW.revision<>OLD.revision+1;\nEND;\n\n-- Template is a recipe_family root; process/metrology revisions inherit it.\nCREATE TABLE collaboration_resources (\n root_kind TEXT NOT NULL CHECK(root_kind IN('sample','project','template')),\n root_id TEXT NOT NULL CHECK(typeof(root_id)='text' AND length(root_id) BETWEEN 1 AND 256 AND instr(root_id,char(0))=0),\n visibility TEXT NOT NULL CHECK(visibility IN('restricted','workspace')),\n revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),\n PRIMARY KEY(root_kind,root_id)\n) WITHOUT ROWID;\nCREATE TRIGGER collaboration_resource_insert_guard BEFORE INSERT ON collaboration_resources BEGIN\n SELECT RAISE(ABORT,'Collaboration root must be a genuine existing resource') WHERE\n  (NEW.root_kind='sample' AND NOT EXISTS(SELECT 1 FROM samples WHERE id=NEW.root_id)) OR\n  (NEW.root_kind='project' AND NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.root_id)) OR\n  (NEW.root_kind='template' AND NOT EXISTS(SELECT 1 FROM recipe_families WHERE id=NEW.root_id));\nEND;\nCREATE TRIGGER collaboration_resource_revision_guard BEFORE UPDATE ON collaboration_resources BEGIN\n SELECT RAISE(ABORT,'Collaboration root identity is immutable') WHERE NEW.root_kind IS NOT OLD.root_kind OR NEW.root_id IS NOT OLD.root_id;\n SELECT RAISE(ABORT,'Root policy requires an exact next revision') WHERE NEW.revision<>OLD.revision+1;\nEND;\n\nCREATE TABLE collaboration_grants (\n root_kind TEXT NOT NULL,\n root_id TEXT NOT NULL,\n member_id TEXT NOT NULL REFERENCES collaboration_members(member_id) ON DELETE RESTRICT,\n capability TEXT NOT NULL CHECK(capability IN('read','operate','edit','manage')),\n enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),\n revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),\n CHECK(capability<>'operate' OR root_kind='sample'),\n PRIMARY KEY(root_kind,root_id,member_id),\n FOREIGN KEY(root_kind,root_id) REFERENCES collaboration_resources(root_kind,root_id) ON DELETE RESTRICT\n) WITHOUT ROWID;\nCREATE INDEX collaboration_grants_member_idx ON collaboration_grants(member_id,enabled,root_kind,root_id);\nCREATE TRIGGER collaboration_grant_revision_guard BEFORE UPDATE ON collaboration_grants BEGIN\n SELECT RAISE(ABORT,'Resource grant identity is immutable') WHERE NEW.root_kind IS NOT OLD.root_kind OR NEW.root_id IS NOT OLD.root_id OR NEW.member_id IS NOT OLD.member_id;\n SELECT RAISE(ABORT,'Resource grant requires an exact next revision') WHERE NEW.revision<>OLD.revision+1;\nEND;\n-- Departure never removes shared resources or their File/provider bindings.\n-- A later rejoin does not reactivate old restricted grants implicitly.\nCREATE TRIGGER collaboration_member_departure AFTER UPDATE OF state ON collaboration_members\n WHEN OLD.state<>'left' AND NEW.state='left' BEGIN\n UPDATE collaboration_grants SET enabled=0,revision=revision+1 WHERE member_id=NEW.member_id AND enabled=1;\nEND;\n\n-- Retain policy identities and their revision history. Explicit UPDATE with an\n-- exact next revision is the only reconciliation path; INSERT OR REPLACE and\n-- UPSERT must not remove/recreate a key at revision 1. No physical DELETE path.\nCREATE TRIGGER collaboration_member_insert_guard BEFORE INSERT ON collaboration_members BEGIN\n SELECT RAISE(ABORT,'Membership identity is retained') WHERE EXISTS(SELECT 1 FROM collaboration_members WHERE member_id=NEW.member_id);\n SELECT RAISE(ABORT,'Membership starts at revision one') WHERE NEW.revision<>1;\nEND;\nCREATE TRIGGER collaboration_member_delete_guard BEFORE DELETE ON collaboration_members\n BEGIN SELECT RAISE(ABORT,'Membership identity is retained'); END;\nCREATE TRIGGER collaboration_identity_insert_guard BEFORE INSERT ON collaboration_identities BEGIN\n SELECT RAISE(ABORT,'Verified identity binding is retained') WHERE EXISTS(SELECT 1 FROM collaboration_identities WHERE provider=NEW.provider AND issuer=NEW.issuer AND subject=NEW.subject);\n SELECT RAISE(ABORT,'Identity binding starts at revision one') WHERE NEW.revision<>1;\nEND;\nCREATE TRIGGER collaboration_identity_delete_guard BEFORE DELETE ON collaboration_identities\n BEGIN SELECT RAISE(ABORT,'Verified identity binding is retained'); END;\nCREATE TRIGGER collaboration_resource_reinsert_guard BEFORE INSERT ON collaboration_resources BEGIN\n SELECT RAISE(ABORT,'Collaboration root policy is retained') WHERE EXISTS(SELECT 1 FROM collaboration_resources WHERE root_kind=NEW.root_kind AND root_id=NEW.root_id);\n SELECT RAISE(ABORT,'Root policy starts at revision one') WHERE NEW.revision<>1;\nEND;\nCREATE TRIGGER collaboration_resource_delete_guard BEFORE DELETE ON collaboration_resources\n BEGIN SELECT RAISE(ABORT,'Collaboration root policy is retained'); END;\nCREATE TRIGGER collaboration_grant_insert_guard BEFORE INSERT ON collaboration_grants BEGIN\n SELECT RAISE(ABORT,'Resource grant identity is retained') WHERE EXISTS(SELECT 1 FROM collaboration_grants WHERE root_kind=NEW.root_kind AND root_id=NEW.root_id AND member_id=NEW.member_id);\n SELECT RAISE(ABORT,'Resource grant starts at revision one') WHERE NEW.revision<>1;\nEND;\nCREATE TRIGGER collaboration_grant_delete_guard BEFORE DELETE ON collaboration_grants\n BEGIN SELECT RAISE(ABORT,'Resource grant identity is retained'); END;\n";
export const COLLABORATION_TABLE_NAMES_V27 = [
  "collaboration_control",
  "collaboration_members",
  "collaboration_identities",
  "collaboration_resources",
  "collaboration_grants"
] as const;
export const COLLABORATION_SCHEMA_OBJECTS_V27: readonly InstallationSchemaObject[] = Object.freeze([
  {
    "type": "index",
    "name": "collaboration_grants_member_idx",
    "tableName": "collaboration_grants",
    "sql": "CREATE INDEX collaboration_grants_member_idx ON collaboration_grants(member_id,enabled,root_kind,root_id)"
  },
  {
    "type": "index",
    "name": "collaboration_identities_member_idx",
    "tableName": "collaboration_identities",
    "sql": "CREATE INDEX collaboration_identities_member_idx ON collaboration_identities(member_id)"
  },
  {
    "type": "table",
    "name": "collaboration_control",
    "tableName": "collaboration_control",
    "sql": "CREATE TABLE collaboration_control (\n singleton INTEGER PRIMARY KEY CHECK(singleton=1),\n schema_version INTEGER NOT NULL CHECK(schema_version=1),\n enforcement TEXT NOT NULL CHECK(enforcement='disabled')\n) WITHOUT ROWID"
  },
  {
    "type": "table",
    "name": "collaboration_grants",
    "tableName": "collaboration_grants",
    "sql": "CREATE TABLE collaboration_grants (\n root_kind TEXT NOT NULL,\n root_id TEXT NOT NULL,\n member_id TEXT NOT NULL REFERENCES collaboration_members(member_id) ON DELETE RESTRICT,\n capability TEXT NOT NULL CHECK(capability IN('read','operate','edit','manage')),\n enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),\n revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),\n CHECK(capability<>'operate' OR root_kind='sample'),\n PRIMARY KEY(root_kind,root_id,member_id),\n FOREIGN KEY(root_kind,root_id) REFERENCES collaboration_resources(root_kind,root_id) ON DELETE RESTRICT\n) WITHOUT ROWID"
  },
  {
    "type": "table",
    "name": "collaboration_identities",
    "tableName": "collaboration_identities",
    "sql": "CREATE TABLE collaboration_identities (\n provider TEXT NOT NULL CHECK(provider IN('access','local')),\n issuer TEXT NOT NULL CHECK(typeof(issuer)='text' AND length(issuer) BETWEEN 1 AND 2048 AND instr(issuer,char(0))=0),\n subject TEXT NOT NULL CHECK(typeof(subject)='text' AND length(subject) BETWEEN 1 AND 256 AND instr(subject,char(0))=0),\n member_id TEXT NOT NULL REFERENCES collaboration_members(member_id) ON DELETE RESTRICT,\n enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),\n revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),\n PRIMARY KEY(provider,issuer,subject)\n) WITHOUT ROWID"
  },
  {
    "type": "table",
    "name": "collaboration_members",
    "tableName": "collaboration_members",
    "sql": "CREATE TABLE collaboration_members (\n member_id TEXT PRIMARY KEY CHECK(typeof(member_id)='text' AND length(member_id)=36 AND instr(member_id,char(0))=0),\n display_name TEXT NOT NULL CHECK(typeof(display_name)='text' AND length(display_name) BETWEEN 1 AND 200 AND instr(display_name,char(0))=0),\n state TEXT NOT NULL CHECK(state IN('active','suspended','left')),\n workspace_role TEXT NOT NULL CHECK(workspace_role IN('member','membershipAdministrator')),\n can_create_samples INTEGER NOT NULL DEFAULT 0 CHECK(can_create_samples IN(0,1)),\n can_create_projects INTEGER NOT NULL DEFAULT 0 CHECK(can_create_projects IN(0,1)),\n can_create_templates INTEGER NOT NULL DEFAULT 0 CHECK(can_create_templates IN(0,1)),\n revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991)\n) WITHOUT ROWID"
  },
  {
    "type": "table",
    "name": "collaboration_resources",
    "tableName": "collaboration_resources",
    "sql": "CREATE TABLE collaboration_resources (\n root_kind TEXT NOT NULL CHECK(root_kind IN('sample','project','template')),\n root_id TEXT NOT NULL CHECK(typeof(root_id)='text' AND length(root_id) BETWEEN 1 AND 256 AND instr(root_id,char(0))=0),\n visibility TEXT NOT NULL CHECK(visibility IN('restricted','workspace')),\n revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),\n PRIMARY KEY(root_kind,root_id)\n) WITHOUT ROWID"
  },
  {
    "type": "trigger",
    "name": "collaboration_control_delete_guard",
    "tableName": "collaboration_control",
    "sql": "CREATE TRIGGER collaboration_control_delete_guard BEFORE DELETE ON collaboration_control\n BEGIN SELECT RAISE(ABORT,'Collaboration control is installation owned'); END"
  },
  {
    "type": "trigger",
    "name": "collaboration_control_insert_guard",
    "tableName": "collaboration_control",
    "sql": "CREATE TRIGGER collaboration_control_insert_guard BEFORE INSERT ON collaboration_control\n BEGIN SELECT RAISE(ABORT,'Collaboration control is installation owned'); END"
  },
  {
    "type": "trigger",
    "name": "collaboration_control_update_guard",
    "tableName": "collaboration_control",
    "sql": "CREATE TRIGGER collaboration_control_update_guard BEFORE UPDATE ON collaboration_control\n BEGIN SELECT RAISE(ABORT,'Collaboration enforcement requires a reviewed forward migration'); END"
  },
  {
    "type": "trigger",
    "name": "collaboration_grant_delete_guard",
    "tableName": "collaboration_grants",
    "sql": "CREATE TRIGGER collaboration_grant_delete_guard BEFORE DELETE ON collaboration_grants\n BEGIN SELECT RAISE(ABORT,'Resource grant identity is retained'); END"
  },
  {
    "type": "trigger",
    "name": "collaboration_grant_insert_guard",
    "tableName": "collaboration_grants",
    "sql": "CREATE TRIGGER collaboration_grant_insert_guard BEFORE INSERT ON collaboration_grants BEGIN\n SELECT RAISE(ABORT,'Resource grant identity is retained') WHERE EXISTS(SELECT 1 FROM collaboration_grants WHERE root_kind=NEW.root_kind AND root_id=NEW.root_id AND member_id=NEW.member_id);\n SELECT RAISE(ABORT,'Resource grant starts at revision one') WHERE NEW.revision<>1;\nEND"
  },
  {
    "type": "trigger",
    "name": "collaboration_grant_revision_guard",
    "tableName": "collaboration_grants",
    "sql": "CREATE TRIGGER collaboration_grant_revision_guard BEFORE UPDATE ON collaboration_grants BEGIN\n SELECT RAISE(ABORT,'Resource grant identity is immutable') WHERE NEW.root_kind IS NOT OLD.root_kind OR NEW.root_id IS NOT OLD.root_id OR NEW.member_id IS NOT OLD.member_id;\n SELECT RAISE(ABORT,'Resource grant requires an exact next revision') WHERE NEW.revision<>OLD.revision+1;\nEND"
  },
  {
    "type": "trigger",
    "name": "collaboration_identity_delete_guard",
    "tableName": "collaboration_identities",
    "sql": "CREATE TRIGGER collaboration_identity_delete_guard BEFORE DELETE ON collaboration_identities\n BEGIN SELECT RAISE(ABORT,'Verified identity binding is retained'); END"
  },
  {
    "type": "trigger",
    "name": "collaboration_identity_insert_guard",
    "tableName": "collaboration_identities",
    "sql": "CREATE TRIGGER collaboration_identity_insert_guard BEFORE INSERT ON collaboration_identities BEGIN\n SELECT RAISE(ABORT,'Verified identity binding is retained') WHERE EXISTS(SELECT 1 FROM collaboration_identities WHERE provider=NEW.provider AND issuer=NEW.issuer AND subject=NEW.subject);\n SELECT RAISE(ABORT,'Identity binding starts at revision one') WHERE NEW.revision<>1;\nEND"
  },
  {
    "type": "trigger",
    "name": "collaboration_identity_revision_guard",
    "tableName": "collaboration_identities",
    "sql": "CREATE TRIGGER collaboration_identity_revision_guard BEFORE UPDATE ON collaboration_identities BEGIN\n SELECT RAISE(ABORT,'Verified identity binding is immutable') WHERE NEW.provider IS NOT OLD.provider OR NEW.issuer IS NOT OLD.issuer\n  OR NEW.subject IS NOT OLD.subject OR NEW.member_id IS NOT OLD.member_id;\n SELECT RAISE(ABORT,'Identity binding requires an exact next revision') WHERE NEW.revision<>OLD.revision+1;\nEND"
  },
  {
    "type": "trigger",
    "name": "collaboration_member_delete_guard",
    "tableName": "collaboration_members",
    "sql": "CREATE TRIGGER collaboration_member_delete_guard BEFORE DELETE ON collaboration_members\n BEGIN SELECT RAISE(ABORT,'Membership identity is retained'); END"
  },
  {
    "type": "trigger",
    "name": "collaboration_member_departure",
    "tableName": "collaboration_members",
    "sql": "CREATE TRIGGER collaboration_member_departure AFTER UPDATE OF state ON collaboration_members\n WHEN OLD.state<>'left' AND NEW.state='left' BEGIN\n UPDATE collaboration_grants SET enabled=0,revision=revision+1 WHERE member_id=NEW.member_id AND enabled=1;\nEND"
  },
  {
    "type": "trigger",
    "name": "collaboration_member_insert_guard",
    "tableName": "collaboration_members",
    "sql": "CREATE TRIGGER collaboration_member_insert_guard BEFORE INSERT ON collaboration_members BEGIN\n SELECT RAISE(ABORT,'Membership identity is retained') WHERE EXISTS(SELECT 1 FROM collaboration_members WHERE member_id=NEW.member_id);\n SELECT RAISE(ABORT,'Membership starts at revision one') WHERE NEW.revision<>1;\nEND"
  },
  {
    "type": "trigger",
    "name": "collaboration_member_revision_guard",
    "tableName": "collaboration_members",
    "sql": "CREATE TRIGGER collaboration_member_revision_guard BEFORE UPDATE ON collaboration_members BEGIN\n SELECT RAISE(ABORT,'Membership identity is immutable') WHERE NEW.member_id IS NOT OLD.member_id;\n SELECT RAISE(ABORT,'Membership requires an exact next revision') WHERE NEW.revision<>OLD.revision+1;\nEND"
  },
  {
    "type": "trigger",
    "name": "collaboration_resource_delete_guard",
    "tableName": "collaboration_resources",
    "sql": "CREATE TRIGGER collaboration_resource_delete_guard BEFORE DELETE ON collaboration_resources\n BEGIN SELECT RAISE(ABORT,'Collaboration root policy is retained'); END"
  },
  {
    "type": "trigger",
    "name": "collaboration_resource_insert_guard",
    "tableName": "collaboration_resources",
    "sql": "CREATE TRIGGER collaboration_resource_insert_guard BEFORE INSERT ON collaboration_resources BEGIN\n SELECT RAISE(ABORT,'Collaboration root must be a genuine existing resource') WHERE\n  (NEW.root_kind='sample' AND NOT EXISTS(SELECT 1 FROM samples WHERE id=NEW.root_id)) OR\n  (NEW.root_kind='project' AND NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.root_id)) OR\n  (NEW.root_kind='template' AND NOT EXISTS(SELECT 1 FROM recipe_families WHERE id=NEW.root_id));\nEND"
  },
  {
    "type": "trigger",
    "name": "collaboration_resource_reinsert_guard",
    "tableName": "collaboration_resources",
    "sql": "CREATE TRIGGER collaboration_resource_reinsert_guard BEFORE INSERT ON collaboration_resources BEGIN\n SELECT RAISE(ABORT,'Collaboration root policy is retained') WHERE EXISTS(SELECT 1 FROM collaboration_resources WHERE root_kind=NEW.root_kind AND root_id=NEW.root_id);\n SELECT RAISE(ABORT,'Root policy starts at revision one') WHERE NEW.revision<>1;\nEND"
  },
  {
    "type": "trigger",
    "name": "collaboration_resource_revision_guard",
    "tableName": "collaboration_resources",
    "sql": "CREATE TRIGGER collaboration_resource_revision_guard BEFORE UPDATE ON collaboration_resources BEGIN\n SELECT RAISE(ABORT,'Collaboration root identity is immutable') WHERE NEW.root_kind IS NOT OLD.root_kind OR NEW.root_id IS NOT OLD.root_id;\n SELECT RAISE(ABORT,'Root policy requires an exact next revision') WHERE NEW.revision<>OLD.revision+1;\nEND"
  }
].map(value => Object.freeze(value as InstallationSchemaObject)));
export const COLLABORATION_RECOVERY_TABLES_V27: readonly (RecoveryTableSpec & { classification: "local" })[] = [
  {
    "name": "collaboration_control",
    "columns": [
      "singleton",
      "schema_version",
      "enforcement"
    ],
    "withoutRowid": true,
    "local": true,
    "classification": "local",
    "primaryKeyColumns": [
      "singleton"
    ]
  },
  {
    "name": "collaboration_members",
    "columns": [
      "member_id",
      "display_name",
      "state",
      "workspace_role",
      "can_create_samples",
      "can_create_projects",
      "can_create_templates",
      "revision"
    ],
    "withoutRowid": true,
    "local": true,
    "classification": "local",
    "primaryKeyColumns": [
      "member_id"
    ]
  },
  {
    "name": "collaboration_identities",
    "columns": [
      "provider",
      "issuer",
      "subject",
      "member_id",
      "enabled",
      "revision"
    ],
    "withoutRowid": true,
    "local": true,
    "classification": "local",
    "primaryKeyColumns": [
      "provider",
      "issuer",
      "subject"
    ]
  },
  {
    "name": "collaboration_resources",
    "columns": [
      "root_kind",
      "root_id",
      "visibility",
      "revision"
    ],
    "withoutRowid": true,
    "local": true,
    "classification": "local",
    "primaryKeyColumns": [
      "root_kind",
      "root_id"
    ]
  },
  {
    "name": "collaboration_grants",
    "columns": [
      "root_kind",
      "root_id",
      "member_id",
      "capability",
      "enabled",
      "revision"
    ],
    "withoutRowid": true,
    "local": true,
    "classification": "local",
    "primaryKeyColumns": [
      "root_kind",
      "root_id",
      "member_id"
    ]
  }
];
export const COLLABORATION_SEED_TABLE_ROWS_V27: Readonly<Record<string, SystemRecoveryTable>> = {
  "collaboration_control": {
    "columns": [
      "singleton",
      "schema_version",
      "enforcement"
    ],
    "rows": [
      {
        "rowid": null,
        "cells": [
          {
            "type": "integer",
            "value": "1"
          },
          {
            "type": "integer",
            "value": "1"
          },
          {
            "type": "text",
            "value": "disabled"
          }
        ]
      }
    ]
  },
  "collaboration_members": {
    "columns": [
      "member_id",
      "display_name",
      "state",
      "workspace_role",
      "can_create_samples",
      "can_create_projects",
      "can_create_templates",
      "revision"
    ],
    "rows": []
  },
  "collaboration_identities": {
    "columns": [
      "provider",
      "issuer",
      "subject",
      "member_id",
      "enabled",
      "revision"
    ],
    "rows": []
  },
  "collaboration_resources": {
    "columns": [
      "root_kind",
      "root_id",
      "visibility",
      "revision"
    ],
    "rows": []
  },
  "collaboration_grants": {
    "columns": [
      "root_kind",
      "root_id",
      "member_id",
      "capability",
      "enabled",
      "revision"
    ],
    "rows": []
  }
};
export const COLLABORATION_RECOVERY_POLICY_V27 = "installation-local-omitted-no-imported-authority/1" as const;

// SOURCE-ONLY forward candidate; migration/restore always leaves enforcement disabled.
import type { InstallationSchemaObject } from "./node-installation-schema";
import type { RecoveryTableSpec, SystemRecoveryTable } from "./system-recovery-image";
import { COLLABORATION_TABLE_NAMES_V27 } from "./collaboration-schema-v27";
export const COLLABORATION_MIGRATION_NAME_V28 = "0026_group_enforcement.sql" as const;
export const COLLABORATION_MIGRATION_RAW_SHA256_V28 = "9b0702724f9cebbd2676ee69e0902b0bc9c5618887f47b59b6130af51ae7ba23" as const;
export const COLLABORATION_MIGRATION_SQL_V28 = "-- SOURCE-ONLY 0026/V28 forward candidate, absent from migrations/ and defaults.\n-- Installing this metadata NEVER activates permissions or enrolls a principal.\n-- V27 remains byte-exact; V28 recovery requires its own closed image/records V5.\n\nDROP TRIGGER collaboration_control_update_guard;\nDROP TRIGGER collaboration_control_delete_guard;\nDROP TRIGGER collaboration_control_insert_guard;\nALTER TABLE collaboration_control RENAME TO collaboration_control_v27;\nCREATE TABLE collaboration_control (\n singleton INTEGER PRIMARY KEY CHECK(singleton=1),\n schema_version INTEGER NOT NULL CHECK(schema_version=2),\n enforcement TEXT NOT NULL CHECK(enforcement IN('disabled','enabled')),\n revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991)\n) WITHOUT ROWID;\n-- Previously inert V27 authority records are not grandfathered into grants.\n-- A missing/invalid/nonempty predecessor fails the NOT NULL primary key instead of\n-- yielding an apparently installed checkpoint with no destination control.\nINSERT INTO collaboration_control(singleton,schema_version,enforcement,revision)\n SELECT CASE WHEN COUNT(*)=1 AND MIN(singleton)=1 AND MIN(schema_version)=1\n   AND MIN(enforcement)='disabled'\n   AND NOT EXISTS(SELECT 1 FROM collaboration_members)\n   AND NOT EXISTS(SELECT 1 FROM collaboration_identities)\n   AND NOT EXISTS(SELECT 1 FROM collaboration_resources)\n   AND NOT EXISTS(SELECT 1 FROM collaboration_grants) THEN 1 ELSE NULL END,2,'disabled',1\n FROM collaboration_control_v27;\nDROP TABLE collaboration_control_v27;\nCREATE TRIGGER collaboration_control_update_guard BEFORE UPDATE ON collaboration_control BEGIN\n SELECT RAISE(ABORT,'Collaboration control identity is immutable')\n  WHERE NEW.singleton IS NOT OLD.singleton OR NEW.schema_version IS NOT OLD.schema_version;\n SELECT RAISE(ABORT,'Collaboration control requires an exact next revision')\n  WHERE NEW.revision<>OLD.revision+1;\nEND;\nCREATE TRIGGER collaboration_control_delete_guard BEFORE DELETE ON collaboration_control\n BEGIN SELECT RAISE(ABORT,'Collaboration control is installation owned'); END;\nCREATE TRIGGER collaboration_control_insert_guard BEFORE INSERT ON collaboration_control\n BEGIN SELECT RAISE(ABORT,'Collaboration control is installation owned'); END;\n\n-- Ordinary local-account provisioning is an explicit stopped-writer operation,\n-- separate from installation bootstrap and every administrator/resource grant.\n-- Retain original local audit provenance while admitting one precise new kind.\nALTER TABLE local_auth_events RENAME TO local_auth_events_v27;\nCREATE TABLE local_auth_events (\n    sequence INTEGER PRIMARY KEY,\n    principal_id TEXT,\n    kind TEXT NOT NULL CHECK(kind IN ('bootstrap','destination_bootstrap','login','login_denied','session_rotated','password_reset','account_disabled','administrator_revoked','account_created')),\n    happened_at INTEGER NOT NULL CHECK(happened_at >= 0)\n  ) STRICT;\nINSERT INTO local_auth_events(sequence,principal_id,kind,happened_at)\n SELECT sequence,principal_id,kind,happened_at FROM local_auth_events_v27 ORDER BY sequence;\nDROP TABLE local_auth_events_v27;\n" as const;
export const COLLABORATION_TABLE_NAMES_V28 = COLLABORATION_TABLE_NAMES_V27;
export const COLLABORATION_REPLACEMENT_SCHEMA_OBJECTS_V28: readonly InstallationSchemaObject[] = Object.freeze([
  {
    "type": "table",
    "name": "collaboration_control",
    "tableName": "collaboration_control",
    "sql": "CREATE TABLE collaboration_control (\n singleton INTEGER PRIMARY KEY CHECK(singleton=1),\n schema_version INTEGER NOT NULL CHECK(schema_version=2),\n enforcement TEXT NOT NULL CHECK(enforcement IN('disabled','enabled')),\n revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991)\n) WITHOUT ROWID"
  },
  {
    "type": "trigger",
    "name": "collaboration_control_update_guard",
    "tableName": "collaboration_control",
    "sql": "CREATE TRIGGER collaboration_control_update_guard BEFORE UPDATE ON collaboration_control BEGIN\n SELECT RAISE(ABORT,'Collaboration control identity is immutable')\n  WHERE NEW.singleton IS NOT OLD.singleton OR NEW.schema_version IS NOT OLD.schema_version;\n SELECT RAISE(ABORT,'Collaboration control requires an exact next revision')\n  WHERE NEW.revision<>OLD.revision+1;\nEND"
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
    "type": "table",
    "name": "local_auth_events",
    "tableName": "local_auth_events",
    "sql": "CREATE TABLE local_auth_events (\n    sequence INTEGER PRIMARY KEY,\n    principal_id TEXT,\n    kind TEXT NOT NULL CHECK(kind IN ('bootstrap','destination_bootstrap','login','login_denied','session_rotated','password_reset','account_disabled','administrator_revoked','account_created')),\n    happened_at INTEGER NOT NULL CHECK(happened_at >= 0)\n  ) STRICT"
  }
].map(value => Object.freeze(value as InstallationSchemaObject)));
export const COLLABORATION_RECOVERY_TABLES_V28: readonly (RecoveryTableSpec & { classification: "local" })[] = [
  {
    "name": "collaboration_control",
    "columns": [
      "singleton",
      "schema_version",
      "enforcement",
      "revision"
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
export const COLLABORATION_SEED_TABLE_ROWS_V28: Readonly<Record<string, SystemRecoveryTable>> = {
  "collaboration_control": {
    "columns": [
      "singleton",
      "schema_version",
      "enforcement",
      "revision"
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
            "value": "2"
          },
          {
            "type": "text",
            "value": "disabled"
          },
          {
            "type": "integer",
            "value": "1"
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
export const COLLABORATION_RECOVERY_POLICY_V28 = "installation-local-omitted-no-imported-authority/2" as const;

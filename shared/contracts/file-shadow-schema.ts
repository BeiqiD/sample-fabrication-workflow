/** Reviewed V15 shadow tables. Business File columns remain NULL until activation. */
export const FILE_SHADOW_EXPORT_COLUMNS = {
  file_shadow_dependency_versions: ["dependency_kind", "dependency_key", "revision", "present", "snapshot_json"],
  file_shadow_control: ["singleton", "epoch"],
  file_shadow_enablements: ["singleton", "expected_epoch", "enabled_by", "enabled_at"],
  file_shadow_profile_enablements: ["storage_profile_id", "configuration_revision", "enabled_by", "enabled_at"],
  file_shadow_occurrences: ["id", "consumer_kind", "consumer_id", "consumer_sub_id", "file_slot", "generation", "present", "source_rowid", "source_json", "legacy_store_kind", "legacy_provider", "legacy_object_key", "expected_purpose", "observed_epoch", "observed_at"],
  file_shadow_heads: ["consumer_kind", "consumer_id", "consumer_sub_id", "file_slot", "generation", "occurrence_id", "present", "source_rowid", "source_json", "observed_epoch"],
  file_shadow_closures: ["occurrence_id", "successor_occurrence_id", "closed_epoch", "closed_at"],
  file_shadow_operations: ["id", "occurrence_id", "captured_epoch", "baseline_sha256", "purpose", "access_scope", "source_store_kind", "source_provider", "source_object_key", "source_profile_id", "source_profile_revision", "source_expected_byte_size", "source_expected_sha256", "destination_profile_id", "destination_profile_revision", "status", "created_by", "created_at", "completed_at"],
  file_shadow_attempts: ["id", "operation_id", "attempt_number", "owner_token", "runtime_incarnation", "candidate_file_id", "candidate_location_id", "candidate_object_key", "verified_byte_size", "verified_sha256", "source_verified_at", "state", "lease_expires_at", "created_at", "write_started_at", "verified_at", "completed_at", "last_error"],
  file_shadow_decisions: ["occurrence_id", "operation_id", "decision", "file_id", "location_id", "baseline_sha256", "reason", "decided_by", "decided_at"],
  file_shadow_legacy_holds: ["id", "operation_id", "store_kind", "provider", "object_key", "storage_profile_id", "profile_revision", "acquired_at", "released_at"],
  file_shadow_reconciliations: ["id", "attempt_id", "runtime_incarnation", "verified_epoch", "verified_byte_size", "verified_sha256", "source_verified_at", "destination_verified_at", "created_by", "created_at"],
  file_shadow_legacy_deletion_claims: ["store_kind", "provider", "object_key", "first_state", "operation_id", "observed_at"],
  file_shadow_checkpoints: ["id", "captured_epoch", "current_count", "resolved_count", "unresolved_count", "pending_count", "captured_by", "captured_at"],
} as const;

/** This local execution gate is rebuilt disabled by recovery, never restored from an archive. */
export const FILE_SHADOW_RUNTIME_GUARD_COLUMNS = ["singleton", "incarnation", "enabled", "enabled_by", "updated_at"] as const;
export const FILE_SHADOW_RUNTIME_INCARNATION_COLUMNS = ["incarnation", "enabled_by", "enabled_at"] as const;
export const FILE_SHADOW_LOCAL_TABLE_NAMES = ["file_shadow_runtime_guard", "file_shadow_runtime_incarnations"] as const;
export const FILE_SHADOW_SCHEMA_TABLE_NAMES = [...Object.keys(FILE_SHADOW_EXPORT_COLUMNS), ...FILE_SHADOW_LOCAL_TABLE_NAMES] as const;
export const FILE_SHADOW_EXPORTED_VIEW_COLUMNS = {} as const;
export const FILE_SHADOW_SLOT_KEYS = [
  ["state_representation_asset", "primary"], ["run_step_asset", "primary"],
  ["metrology_template_reference", "primary"], ["run_step_comment", "primary"],
  ["state_verification", "evidence"], ["comment_submission_item", "primary"],
  ["project_content_attachment", "primary"], ["attachment_derivative", "derived"],
  ["event", "primary"], ["event", "thumbnail"], ["import", "workbook"],
  ["import", "manifest"], ["template_version", "source"],
] as const;

/** Canonical non-secret dependency metadata, generated with migration 0008. */
export const FILE_SHADOW_DEPENDENCY_SPECS = {
  "assets": {
    "keyColumns": [
      "id"
    ],
    "snapshotColumns": [
      "id",
      "import_id",
      "r2_key",
      "status",
      "sha256",
      "byte_size",
      "created_at"
    ]
  },
  "imports": {
    "keyColumns": [
      "id"
    ],
    "snapshotColumns": [
      "id",
      "status",
      "operation_id",
      "lease_expires_at",
      "recovery_operation_id",
      "completed_at",
      "storage_profile_id",
      "storage_profile_revision",
      "request_sha256",
      "request_scope",
      "accepted_result_json"
    ]
  },
  "samples": {
    "keyColumns": [
      "id"
    ],
    "snapshotColumns": [
      "id",
      "status",
      "deleted_at",
      "updated_at"
    ]
  },
  "runs": {
    "keyColumns": [
      "id"
    ],
    "snapshotColumns": [
      "id",
      "sample_id",
      "status",
      "deleted_at",
      "completed_at",
      "last_mutation_id"
    ]
  },
  "run_steps": {
    "keyColumns": [
      "id"
    ],
    "snapshotColumns": [
      "id",
      "run_id",
      "status",
      "plan_status",
      "deleted_at",
      "updated_at",
      "last_mutation_id"
    ]
  },
  "comment_submissions": {
    "keyColumns": [
      "id"
    ],
    "snapshotColumns": [
      "id",
      "context_kind",
      "sample_id",
      "scope",
      "status",
      "updated_at",
      "completed_at",
      "cancelled_at",
      "deleted_at",
      "deletion_operation_id",
      "retry_until",
      "retry_closed_at",
      "last_mutation_id"
    ]
  },
  "comment_submission_targets": {
    "keyColumns": [
      "submission_id",
      "run_step_id"
    ],
    "snapshotColumns": [
      "submission_id",
      "sample_id",
      "run_id",
      "run_step_id",
      "expected_updated_at"
    ]
  },
  "state_representations": {
    "keyColumns": [
      "hash"
    ],
    "snapshotColumns": [
      "hash",
      "hash_scheme",
      "representation_type",
      "logical_state_key",
      "created_at"
    ]
  },
  "r2_upload_requests": {
    "keyColumns": [
      "id"
    ],
    "snapshotColumns": [
      "id",
      "status",
      "purpose",
      "request_scope",
      "request_sha256",
      "storage_profile_id",
      "storage_profile_revision",
      "candidate_object_key",
      "accepted_result_json",
      "completed_at",
      "expires_at"
    ]
  },
  "metrology_reference_upload_requests": {
    "keyColumns": [
      "id"
    ],
    "snapshotColumns": [
      "id",
      "status",
      "purpose",
      "request_scope",
      "request_sha256",
      "storage_profile_id",
      "storage_profile_revision",
      "candidate_object_key",
      "accepted_result_json",
      "completed_at",
      "expires_at"
    ]
  },
  "comment_item_acceptances": {
    "keyColumns": [
      "item_id"
    ],
    "snapshotColumns": [
      "item_id",
      "submission_id",
      "status",
      "purpose",
      "expected_sha256",
      "expected_byte_size",
      "storage_profile_id",
      "storage_profile_revision",
      "candidate_object_key",
      "accepted_result_json",
      "started_at"
    ]
  },
  "comment_submission_acceptances": {
    "keyColumns": [
      "submission_id"
    ],
    "snapshotColumns": [
      "submission_id",
      "status",
      "request_sha256",
      "created_at",
      "completed_at",
      "expires_at"
    ]
  },
  "blob_gc_ledger": {
    "keyColumns": [
      "store_kind",
      "provider",
      "object_key"
    ],
    "snapshotColumns": [
      "store_kind",
      "provider",
      "object_key",
      "state",
      "operation_id",
      "deletion_started_at",
      "deleted_at",
      "attempt_count",
      "updated_at"
    ]
  },
  "blob_integrity_quarantine": {
    "keyColumns": [
      "store_kind",
      "provider",
      "object_key"
    ],
    "snapshotColumns": [
      "store_kind",
      "provider",
      "object_key",
      "reason",
      "expected_byte_size",
      "observed_byte_size",
      "operation_id",
      "detected_at",
      "last_checked_at"
    ]
  },
  "legacy_file_mappings": {
    "keyColumns": [
      "store_kind",
      "provider",
      "object_key"
    ],
    "snapshotColumns": [
      "store_kind",
      "provider",
      "object_key",
      "file_id",
      "location_id",
      "classification",
      "observed_at"
    ]
  },
  "storage_profiles": {
    "keyColumns": [
      "id"
    ],
    "snapshotColumns": [
      "id",
      "adapter_type",
      "namespace_identity",
      "configuration_source",
      "configuration_revision",
      "state",
      "created_at"
    ]
  },
  "storage_profile_runtime": {
    "keyColumns": [
      "storage_profile_id"
    ],
    "snapshotColumns": [
      "storage_profile_id",
      "state",
      "registered_at",
      "activated_at",
      "retired_at"
    ]
  },
  "template_versions": {
    "keyColumns": [
      "id"
    ],
    "snapshotColumns": [
      "id",
      "template_kind",
      "source_asset_key",
      "archived_at",
      "deleted_at",
      "locked_at"
    ]
  },
  "managed_storage_objects": {
    "keyColumns": [
      "id"
    ],
    "snapshotColumns": [
      "id",
      "provider",
      "object_key",
      "status",
      "sha256",
      "byte_size",
      "orphaned_at",
      "created_at"
    ]
  },
  "comment_submission_items": {
    "keyColumns": [
      "id"
    ],
    "snapshotColumns": [
      "id",
      "submission_id",
      "kind",
      "status",
      "asset_id",
      "storage_object_id",
      "sha256",
      "byte_size",
      "related_item_id",
      "updated_at",
      "deleted_at"
    ]
  },
  "project_contents": {
    "keyColumns": [
      "id"
    ],
    "snapshotColumns": [
      "id",
      "project_id",
      "content_type",
      "revision",
      "last_mutation_id",
      "updated_at",
      "deleted_at",
      "deletion_operation_id"
    ]
  },
  "projects": {
    "keyColumns": [
      "id"
    ],
    "snapshotColumns": [
      "id",
      "revision",
      "last_mutation_id",
      "updated_at",
      "deleted_at",
      "deletion_operation_id"
    ]
  },
  "project_items": {
    "keyColumns": [
      "id"
    ],
    "snapshotColumns": [
      "id",
      "project_id",
      "project_content_id",
      "deleted_at",
      "revision",
      "last_mutation_id"
    ]
  }
} as const;

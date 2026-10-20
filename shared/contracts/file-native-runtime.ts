/** Portable FP2 native File generation. These names are independent of the
 * frozen V7–V20 inventories. Installation bindings remain system data. */
export const FILE_NATIVE_RUNTIME_TABLE_COLUMNS = {
  storage_profile_activations: ["operation_id", "storage_profile_id", "configuration_revision", "action",
    "candidate_profile_id", "candidate_revision", "envelope_revision", "check_id", "configuration_sha256",
    "namespace_sha256", "binding_revision", "actor", "created_at"],
  storage_role_policy_revisions: ["policy_revision", "role", "storage_profile_id", "storage_profile_revision",
    "operation_id", "actor", "created_at"],
  import_file_acceptances: ["import_id", "item_id", "purpose", "storage_profile_id", "storage_profile_revision",
    "role_policy_revision", "expected_sha256", "expected_byte_size", "candidate_asset_id", "candidate_object_key",
    "status", "result_file_id", "result_location_id", "created_at", "completed_at"],
} as const;

export const FILE_NATIVE_RUNTIME_ADDED_COLUMNS = {
  assets: ["file_id", "storage_profile_id", "storage_profile_revision", "object_key"],
  imports: ["file_targets_protocol", "role_policy_revision"],
  r2_upload_requests: ["role_policy_revision"],
  metrology_reference_upload_requests: ["role_policy_revision"],
  comment_submission_acceptances: ["role_selection_revision"],
  comment_item_acceptances: ["role_selection_revision"],
} as const;

export const FILE_NATIVE_RUNTIME_LOCAL_TABLES = ["system_storage_native_bindings"] as const;
export const FILE_NATIVE_IMPORT_TARGETS_PROTOCOL = 1;
export const FILE_NATIVE_COMMENT_POLICY_FORMAT = 3;
export const FILE_NATIVE_MIN_ROLE_POLICY_REVISION = 3;

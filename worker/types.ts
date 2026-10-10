export interface Env {
  DB: D1Database;
  /** Operator-provisioned, isolated FP5 target; never a replacement for DB. */
  RECOVERY_DB?: D1Database;
  RECOVERY_TARGET_ID?: string;
  ASSETS: R2Bucket;
  R2_BOOTSTRAP_NAMESPACE?: string;
  /** Deployment-owned registered profile → exact namespace/bucket binding map. */
  R2_PROFILE_BINDINGS?: string;
  MANAGED_STORAGE_PROVIDER?: string;
  SWITCHDRIVE_WEBDAV_URL?: string;
  SWITCHDRIVE_USERNAME?: string;
  SWITCHDRIVE_APP_PASSWORD?: string;
  SWITCHDRIVE_ROOT?: string;
  AUTH_MODE: "access" | "disabled";
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ALLOWED_EMAILS?: string;
  FILE_EVIDENCE_OPERATOR_EMAILS?: string;
  SYSTEM_ADMIN_EMAILS?: string;
  STORAGE_CREDENTIAL_KEYRING?: string;
}

export interface Env {
  DB: D1Database;
  ASSETS: R2Bucket;
  MANAGED_STORAGE_PROVIDER?: string;
  SWITCHDRIVE_WEBDAV_URL?: string;
  SWITCHDRIVE_USERNAME?: string;
  SWITCHDRIVE_APP_PASSWORD?: string;
  SWITCHDRIVE_ROOT?: string;
  AUTH_MODE: "access" | "disabled";
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ALLOWED_EMAILS?: string;
}

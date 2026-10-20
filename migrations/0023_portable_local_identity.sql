-- Portable runtime V25: local identity schema only. No imported authority is
-- activated by this migration. Recovery classifies accounts/audit as protected
-- and destination bootstrap/grants/sessions/throttles as installation-local.
-- Node platform receipts are separately admitted, never canonical content DDL.

CREATE TABLE local_identity_installation (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    bootstrap_principal_id TEXT NOT NULL UNIQUE,
    catalog_id TEXT NOT NULL CHECK(catalog_id = 'local-identity-v1'),
    initialized_at INTEGER NOT NULL CHECK(initialized_at >= 0)
  ) STRICT;

CREATE TABLE local_accounts (
    principal_id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_verifier TEXT NOT NULL,
    credential_revision INTEGER NOT NULL CHECK(credential_revision >= 1),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    created_at INTEGER NOT NULL CHECK(created_at >= 0)
  ) STRICT;

CREATE TABLE local_admin_grants (
    principal_id TEXT PRIMARY KEY REFERENCES local_accounts(principal_id),
    granted_at INTEGER NOT NULL CHECK(granted_at >= 0)
  ) STRICT;

CREATE TABLE local_sessions (
    token_hash TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL REFERENCES local_accounts(principal_id),
    credential_revision INTEGER NOT NULL CHECK(credential_revision >= 1),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    absolute_expires_at INTEGER NOT NULL CHECK(absolute_expires_at > created_at),
    last_seen_at INTEGER NOT NULL CHECK(last_seen_at >= created_at AND last_seen_at < absolute_expires_at),
    revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at >= created_at)
  ) STRICT;

CREATE INDEX local_sessions_principal ON local_sessions(principal_id);

CREATE TABLE local_login_throttle (
    bucket_hash TEXT PRIMARY KEY,
    window_started_at INTEGER NOT NULL CHECK(window_started_at >= 0),
    attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 20)
  ) STRICT;

CREATE TABLE local_auth_events (
    sequence INTEGER PRIMARY KEY,
    principal_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('bootstrap','destination_bootstrap','login','login_denied','session_rotated','password_reset','account_disabled','administrator_revoked')),
    happened_at INTEGER NOT NULL CHECK(happened_at >= 0)
  ) STRICT;

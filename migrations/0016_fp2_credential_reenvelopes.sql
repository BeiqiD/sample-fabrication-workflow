-- Installation-only receipts for credential encryption-key maintenance. These
-- rows contain no key material or encrypted payload and are excluded from
-- ordinary content archives. Historical descriptors can be maintained without
-- changing their configuration revision or any captured candidate-check data.
CREATE TABLE system_storage_credential_reenvelopes (
  operation_id TEXT PRIMARY KEY NOT NULL CHECK (length(operation_id) = 36),
  profile_id TEXT NOT NULL,
  configuration_revision INTEGER NOT NULL CHECK (typeof(configuration_revision) = 'integer' AND configuration_revision > 0),
  credential_ref TEXT NOT NULL,
  previous_envelope_revision INTEGER NOT NULL CHECK (typeof(previous_envelope_revision) = 'integer' AND previous_envelope_revision > 0),
  envelope_revision INTEGER NOT NULL CHECK (typeof(envelope_revision) = 'integer' AND envelope_revision > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('reenveloped','already_current')),
  previous_key_id TEXT NOT NULL CHECK (length(previous_key_id) BETWEEN 1 AND 64),
  key_id TEXT NOT NULL CHECK (length(key_id) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 254),
  CHECK ((outcome = 'reenveloped' AND envelope_revision = previous_envelope_revision + 1 AND key_id <> previous_key_id)
    OR (outcome = 'already_current' AND envelope_revision = previous_envelope_revision AND key_id = previous_key_id)),
  FOREIGN KEY (profile_id,configuration_revision,credential_ref) REFERENCES system_storage_credential_descriptors(profile_id,configuration_revision,credential_ref) ON DELETE RESTRICT
);
CREATE INDEX system_storage_credential_reenvelopes_history ON system_storage_credential_reenvelopes(profile_id,created_at,operation_id);
CREATE TRIGGER system_storage_credential_reenvelopes_insert_guard BEFORE INSERT ON system_storage_credential_reenvelopes BEGIN
  SELECT RAISE(ABORT,'FP2 credential re-envelope conflict')
    WHERE NOT EXISTS (SELECT 1 FROM system_storage_credential_descriptors d
      JOIN system_storage_credential_payloads p ON p.credential_ref = d.credential_ref
      WHERE d.profile_id = NEW.profile_id AND d.configuration_revision = NEW.configuration_revision AND d.credential_ref = NEW.credential_ref
        AND p.envelope_revision = NEW.envelope_revision AND p.key_id = NEW.key_id);
END;
CREATE TRIGGER system_storage_credential_reenvelopes_immutable BEFORE UPDATE ON system_storage_credential_reenvelopes BEGIN
  SELECT RAISE(ABORT,'FP2 credential re-envelope receipts are immutable');
END;
CREATE TRIGGER system_storage_credential_reenvelopes_delete_guard BEFORE DELETE ON system_storage_credential_reenvelopes BEGIN
  SELECT RAISE(ABORT,'FP2 credential re-envelope receipts are immutable');
END;

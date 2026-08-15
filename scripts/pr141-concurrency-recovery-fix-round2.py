from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:120]!r}")
    target.write_text(text.replace(old, new, 1))


def replace_between(path: str, start: str, end: str, replacement: str) -> None:
    target = Path(path)
    text = target.read_text()
    start_index = text.find(start)
    if start_index < 0:
        raise SystemExit(f"{path}: start marker not found: {start!r}")
    end_index = text.find(end, start_index)
    if end_index < 0:
        raise SystemExit(f"{path}: end marker not found: {end!r}")
    target.write_text(text[:start_index] + replacement + text[end_index:])


migration = "migrations/0028_blob_registration_and_recovery_reconciliation.sql"
replace_between(
    migration,
    "CREATE TRIGGER assets_reject_live_sha_duplicate_update\n",
    "CREATE TRIGGER assets_reject_pending_import_sha_publication_insert\n",
    """DROP TRIGGER assets_reject_live_sha_duplicate;
DROP TRIGGER assets_reject_live_sha_duplicate_update;

-- Standalone registrations may have multiple non-public candidates while
-- concurrent requests are in flight. Only one candidate may become ready.
-- Import-owned candidates retain their stronger private hash reservation.
CREATE TRIGGER assets_reject_live_sha_duplicate
BEFORE INSERT ON assets
WHEN NEW.sha256 IS NOT NULL AND (
  (
    NEW.import_id IS NULL AND NEW.status = 'ready'
    AND EXISTS (
      SELECT 1 FROM assets a
      WHERE a.sha256 = NEW.sha256 AND a.status = 'ready'
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
    )
  ) OR (
    NEW.import_id IS NOT NULL AND NEW.status IN ('pending', 'ready')
    AND EXISTS (
      SELECT 1 FROM assets a
      WHERE a.sha256 = NEW.sha256 AND a.status IN ('pending', 'ready')
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE live asset sha256 already registered');
END;

CREATE TRIGGER assets_reject_live_sha_duplicate_update
BEFORE UPDATE OF sha256, status, r2_key, import_id ON assets
WHEN NEW.sha256 IS NOT NULL AND (
  (
    NEW.import_id IS NULL AND NEW.status = 'ready'
    AND EXISTS (
      SELECT 1 FROM assets a
      WHERE a.id <> OLD.id AND a.sha256 = NEW.sha256
        AND a.status = 'ready'
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
    )
  ) OR (
    NEW.import_id IS NOT NULL AND NEW.status IN ('pending', 'ready')
    AND EXISTS (
      SELECT 1 FROM assets a
      WHERE a.id <> OLD.id AND a.sha256 = NEW.sha256
        AND a.status IN ('pending', 'ready')
        AND NOT EXISTS (
          SELECT 1 FROM blob_gc_ledger bg
          WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
            AND bg.object_key = a.r2_key
            AND bg.state IN ('deleting', 'deleted')
        )
        AND NOT EXISTS (
          SELECT 1 FROM blob_integrity_quarantine biq
          WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
            AND biq.object_key = a.r2_key
        )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE live asset sha256 already registered');
END;

""",
)

replace_once(
    migration,
    "WHEN NEW.import_id IS NULL\n  AND NEW.status = 'ready'\n  AND NEW.sha256 IS NOT NULL",
    "WHEN NEW.import_id IS NULL\n  AND NEW.status IN ('pending', 'ready')\n  AND NEW.sha256 IS NOT NULL",
)
replace_once(
    migration,
    "WHEN NEW.import_id IS NULL\n  AND NEW.status = 'ready'\n  AND NEW.sha256 IS NOT NULL",
    "WHEN NEW.import_id IS NULL\n  AND NEW.status IN ('pending', 'ready')\n  AND NEW.sha256 IS NOT NULL",
)

replace_once(
    "worker/fabublox-import-recovery.test.ts",
    '''    seedSharedImportState(database, {
      importAStatus: "failed",
      importBStatus: "pending",
      assetStatus: "ready",
      assetSha256: null,
      assetByteSize: bytes.byteLength,
    });
    database.exec(`
      UPDATE template_versions
''',
    '''    seedSharedImportState(database, {
      importAStatus: "failed",
      importBStatus: "pending",
      assetStatus: "ready",
      assetSha256: null,
      assetByteSize: bytes.byteLength,
    });
    // This fixture represents a relationship written before 0024 introduced
    // the provider-availability insert guard.
    database.exec("DROP TRIGGER project_content_attachments_guard_integrity_insert;");
    database.exec(`
      UPDATE template_versions
''',
)

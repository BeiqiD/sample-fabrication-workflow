from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:120]!r}")
    target.write_text(text.replace(old, new, 1))


def replace_exact_count(
    path: str,
    old: str,
    new: str,
    expected: int,
) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != expected:
        raise SystemExit(
            f"{path}: expected {expected} matches, found {count}: {old[:120]!r}"
        )
    target.write_text(text.replace(old, new, expected))


registration = "worker/blob-lifecycle/registration.ts"
replace_once(
    registration,
    'import type { ReusableManagedObject, ReusableR2Asset } from "./reuse";',
    'import {\n  BlobReuseProviderUnavailableError,\n  type ReusableManagedObject,\n  type ReusableR2Asset,\n} from "./reuse";',
)
replace_once(
    registration,
    '''export class BlobRegistrationAuthorityUnavailableError extends Error {
  constructor(detail: string) {
    super(`Blob registration authority is unavailable: ${detail}`);
    this.name = "BlobRegistrationAuthorityUnavailableError";
  }
}
''',
    '''export class BlobRegistrationAuthorityUnavailableError extends Error {
  constructor(
    detail: string,
    readonly publicMessage =
      "Asset registration outcome could not be verified. Retry later.",
  ) {
    super(`Blob registration authority is unavailable: ${detail}`);
    this.name = "BlobRegistrationAuthorityUnavailableError";
  }
}
''',
)
replace_once(
    registration,
    '''function authorityUnavailable(error: unknown) {
  return new BlobRegistrationAuthorityUnavailableError(
    error instanceof Error ? error.message : String(error),
  );
}
''',
    '''function authorityUnavailable(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return new BlobRegistrationAuthorityUnavailableError(
    detail,
    error instanceof BlobReuseProviderUnavailableError
      ? error.message
      : undefined,
  );
}
''',
)

replace_exact_count(
    "worker/index.ts",
    '          message: "Asset registration outcome could not be verified. Retry later.",',
    "          message: error.publicMessage,",
    2,
)
replace_once(
    "worker/project-foundation-routes.ts",
    '          message: "Asset registration outcome could not be verified. Retry later.",',
    "          message: error.publicMessage,",
)
replace_once(
    "worker/comment-submission-routes.ts",
    '              message: "Asset registration outcome could not be verified. Retry later.",',
    "              message: error.publicMessage,",
)
replace_once(
    "worker/comment-submission-routes.ts",
    '            message: "Managed attachment registration outcome could not be verified. Retry later.",',
    "            message: error.publicMessage,",
)

replace_once(
    "worker/blob-integrity.test.ts",
    '''      INSERT INTO imports (
        id, status, source_filename, source_sha256, sheet_name,
        template_type, warning_count, created_at
      ) VALUES (
        'import-pending-reuse', 'pending', 'pending.xlsx', ?, 'Process',
        'process', 0, ?
      )
''',
    '''      INSERT INTO imports (
        id, status, source_filename, source_sha256, sheet_name,
        template_type, warning_count, workbook_asset_key,
        manifest_asset_key, created_at
      ) VALUES (
        'import-pending-reuse', 'pending', 'pending.xlsx', ?, 'Process',
        'process', 0, 'imports/pending/source.xlsx',
        'imports/pending/source.xlsx', ?
      )
''',
)

replace_once(
    "worker/blob-integrity-routes.test.ts",
    'it("keeps its own committed upload when the D1 INSERT response is lost"',
    'it("keeps its own committed upload when the ready-promotion response is lost"',
)
replace_once(
    "worker/blob-integrity-routes.test.ts",
    '''        if (!lostResponseInjected
          && query.includes("INSERT INTO assets (id, r2_key")) {
          lostResponseInjected = true;
          throw new Error("injected committed asset INSERT response loss");
        }
''',
    '''        if (!lostResponseInjected
          && /UPDATE\\s+assets\\s+SET\\s+status\\s*=\\s*'ready'/i.test(query)) {
          lostResponseInjected = true;
          throw new Error("injected committed asset ready-promotion response loss");
        }
''',
)

migration = "migrations/0028_blob_registration_and_recovery_reconciliation.sql"
replace_once(
    migration,
    '''BEGIN
  SELECT RAISE(ABORT, 'project attachment intrinsic metadata is immutable');
END;
''',
    '''BEGIN
  SELECT RAISE(ABORT, 'blob locator is quarantined')
  WHERE (
    NEW.asset_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM assets a
      JOIN blob_integrity_quarantine biq
        ON biq.store_kind = 'r2' AND biq.provider = 'r2'
       AND biq.object_key = a.r2_key
      WHERE a.id = NEW.asset_id
    )
  ) OR (
    NEW.storage_object_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM managed_storage_objects mso
      JOIN blob_integrity_quarantine biq
        ON biq.store_kind = 'managed'
       AND biq.provider = mso.provider
       AND biq.object_key = mso.object_key
      WHERE mso.id = NEW.storage_object_id
    )
  );

  SELECT RAISE(ABORT, 'blob locator is unavailable')
  WHERE NEW.asset_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM assets a
      LEFT JOIN imports i ON i.id = a.import_id
      WHERE a.id = NEW.asset_id
        AND a.status = 'ready'
        AND (a.import_id IS NULL OR i.status = 'ready')
    );

  SELECT RAISE(ABORT, 'blob locator is unavailable')
  WHERE (
    NEW.asset_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM assets a
      JOIN blob_gc_ledger bg
        ON bg.store_kind = 'r2' AND bg.provider = 'r2'
       AND bg.object_key = a.r2_key
       AND bg.state IN ('deleting', 'deleted')
      WHERE a.id = NEW.asset_id
    )
  ) OR (
    NEW.storage_object_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM manaed_storage_objects mso
      JOIN blob_gc_ledger bg
        ON bg.store_kind = 'managed'
       AND bg.provider = mso.provider
       AND bg.object_key = mso.object_key
       AND bg.state IN ('deleting', 'deleted')
      WHERE mso.id = NEW.storage_object_id
    )
  );

  SELECT RAISE(ABORT, 'project attachment intrinsic metadata is immutable');
END;
''',
)

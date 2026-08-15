#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one replacement target, found {count}")
    path.write_text(text.replace(old, new, 1))


recovery = ROOT / "worker/fabublox-import-recovery.ts"
replace_once(
    recovery,
    '''import { inspectFabubloxRecoveryAssets } from "./fabublox-recovery-assets";
import type { Env } from "./types";
''',
    '''import { inspectFabubloxRecoveryAssets } from "./fabublox-recovery-assets";
import { primaryD1 } from "./d1-primary";
import type { Env } from "./types";
''',
)
replace_once(
    recovery,
    '''// A recovery read must reach the primary database. The fallback keeps the
// local SQLite/D1 test adapters small while production uses D1 Sessions.
export function primaryD1(db: D1Database): D1Database {
  const candidate = db as D1Database & {
    withSession?: (constraint?: "first-primary") => unknown;
  };
  if (typeof candidate.withSession !== "function") return db;
  return candidate.withSession("first-primary") as unknown as D1Database;
}

''',
    '',
)

index_path = ROOT / "worker/index.ts"
replace_once(
    index_path,
    '''import {
  fabubloxImportLeaseExpiresAt,
  primaryD1,
  queueFabubloxImportCleanup,
  readFabubloxImportState,
} from "./fabublox-import-recovery";
''',
    '''import {
  fabubloxImportLeaseExpiresAt,
  queueFabubloxImportCleanup,
  readFabubloxImportState,
} from "./fabublox-import-recovery";
''',
)
replace_once(
    index_path,
    '''import {
  BlobReuseProviderUnavailableError,
  findReusableR2Asset,
} from "./blob-lifecycle/reuse";
''',
    '''import {
  BlobReuseProviderUnavailableError,
  findReusableR2Asset,
} from "./blob-lifecycle/reuse";
import { reconcileCommittedR2Asset } from "./blob-lifecycle/registration";
''',
)
replace_once(
    index_path,
    '''      // The INSERT may have committed even when D1 lost the response. Reconcile
      // the exact stable ID/key on the primary before treating another row as a
      // deduplication winner or deleting the uploaded provider object.
      const committed = await primaryD1(c.env.DB).prepare(`
        SELECT a.id, a.r2_key
        FROM assets a
        WHERE a.id = ? AND a.r2_key = ? AND a.sha256 = ?
          AND a.status = 'ready' AND a.import_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM blob_integrity_quarantine biq
            WHERE biq.store_kind = 'r2' AND biq.provider = 'r2'
              AND biq.object_key = a.r2_key
          )
          AND NOT EXISTS (
            SELECT 1 FROM blob_gc_ledger bg
            WHERE bg.store_kind = 'r2' AND bg.provider = 'r2'
              AND bg.object_key = a.r2_key
              AND bg.state IN ('deleting', 'deleted')
          )
      `).bind(id, key, sha256).first<{ id: string; r2_key: string }>();
''',
    '''      // The INSERT may have committed even when D1 lost the response. Reconcile
      // the exact stable ID/key on the primary before treating another row as a
      // deduplication winner or deleting the uploaded provider object.
      const committed = await reconcileCommittedR2Asset(c.env.DB, {
        id,
        objectKey: key,
        sha256,
      });
''',
)

comment_path = ROOT / "worker/comment-submission-routes.ts"
replace_once(
    comment_path,
    '''import {
  BlobReuseProviderUnavailableError,
  findReusableManagedObject,
  findReusableR2Asset,
} from "./blob-lifecycle/reuse";
''',
    '''import {
  BlobReuseProviderUnavailableError,
  findReusableManagedObject,
  findReusableR2Asset,
} from "./blob-lifecycle/reuse";
import {
  reconcileCommittedManagedObject,
  reconcileCommittedR2Asset,
} from "./blob-lifecycle/registration";
''',
)
replace_once(
    comment_path,
    '''          } catch (error) {
            let winner;
            try {
              winner = await reusableCommentR2Asset(c.env, sha256);
            } catch (verificationError) {
              await c.env.ASSETS.delete(key);
              throw verificationError;
            }
            if (winner) {
              await c.env.ASSETS.delete(key);
              asset = winner;
              deduplicated = true;
              break;
            }
            if (attempt === 1) {
              await c.env.ASSETS.delete(key);
              throw error;
            }
          }
''',
    '''          } catch (error) {
            const committed = await reconcileCommittedR2Asset(c.env.DB, {
              id: assetId,
              objectKey: key,
              sha256,
            });
            if (committed) {
              asset = committed;
              deduplicated = false;
              break;
            }

            let winner;
            try {
              winner = await reusableCommentR2Asset(c.env, sha256);
            } catch (verificationError) {
              await c.env.ASSETS.delete(key);
              throw verificationError;
            }
            if (winner) {
              await c.env.ASSETS.delete(key);
              asset = winner;
              deduplicated = true;
              break;
            }
            if (attempt === 1) {
              await c.env.ASSETS.delete(key);
              throw error;
            }
          }
''',
)
replace_once(
    comment_path,
    '''        } catch (error) {
          let winner;
          try {
            winner = await reusableCommentManagedObject(
              c.env,
              storage.provider,
              sha256,
              item.byte_size,
            );
          } catch (verificationError) {
            await storage.delete(key);
            throw verificationError;
          }
          if (winner) {
            await storage.delete(key);
            storageObject = winner;
            deduplicated = true;
            break;
          }
          if (attempt === 1) {
            await storage.delete(key);
            throw error;
          }
        }
''',
    '''        } catch (error) {
          const committed = await reconcileCommittedManagedObject(c.env.DB, {
            id: storageObjectId,
            provider: storage.provider,
            objectKey: key,
            sha256,
            byteSize: item.byte_size,
          });
          if (committed) {
            storageObject = committed;
            deduplicated = false;
            break;
          }

          let winner;
          try {
            winner = await reusableCommentManagedObject(
              c.env,
              storage.provider,
              sha256,
              item.byte_size,
            );
          } catch (verificationError) {
            await storage.delete(key);
            throw verificationError;
          }
          if (winner) {
            await storage.delete(key);
            storageObject = winner;
            deduplicated = true;
            break;
          }
          if (attempt === 1) {
            await storage.delete(key);
            throw error;
          }
        }
''',
)

package_path = ROOT / "package.json"
replace_once(
    package_path,
    '''    "test:blob-lifecycle": "vitest run worker/blob-reachability.test.ts worker/blob-gc.test.ts worker/blob-export.test.ts worker/permanent-delete-protection.test.ts worker/blob-lifecycle-review-fixes.test.ts worker/blob-lifecycle-migration-safety.test.ts worker/blob-lifecycle-legacy-managed-migration.test.ts",
    "test:storage-integrity": "vitest run worker/blob-integrity.test.ts worker/blob-integrity-routes.test.ts worker/switchdrive-storage.test.ts",
''',
    '''    "test:blob-lifecycle": "vitest run worker/blob-reachability.test.ts worker/blob-gc.test.ts worker/blob-export.test.ts worker/permanent-delete-protection.test.ts worker/blob-lifecycle-review-fixes.test.ts worker/blob-lifecycle-migration-safety.test.ts worker/blob-lifecycle-legacy-managed-migration.test.ts worker/fabublox-import-recovery.test.ts",
    "test:storage-integrity": "vitest run worker/blob-integrity.test.ts worker/blob-integrity-routes.test.ts worker/blob-registration-reconciliation.test.ts worker/switchdrive-storage.test.ts",
''',
)

appenditions = [
    (
        ROOT / "docs/BLOB_LIFECYCLE_CONTRACT.md",
        "## Uncertain registration outcomes",
        '''

## Uncertain registration outcomes

An uploaded provider object and its stable database identity form one registration attempt. If the INSERT response is uncertain, the writer must first read the exact `(id, provider, object_key, sha256)` record from primary D1. An exact committed record is the writer's own successful result and its provider object must not be deleted. Only after that reconciliation returns no record may the writer select a different content-addressed winner and delete the redundant upload.

This rule applies uniformly to ordinary R2 assets, Comment images, and managed Comment attachments. A content-hash lookup alone cannot distinguish the writer's own committed row from a competing winner.
''',
    ),
    (
        ROOT / "docs/BLOB_LIFECYCLE_IMPLEMENTATION_PLAN.md",
        "## Shared registration reconciliation",
        '''

## Shared registration reconciliation

`worker/blob-lifecycle/registration.ts` owns primary-authoritative exact-record reconciliation for both R2 and managed objects. Ordinary assets and both Comment upload paths use it before calling the provider-verified reusable-winner lookup. This keeps the uncertain-outcome ordering identical across storage backends and prevents a committed upload from deleting its own locator.
''',
    ),
    (
        ROOT / "docs/BLOB_LIFECYCLE_OPERATIONS.md",
        "## Registration response-loss diagnostics",
        '''

## Registration response-loss diagnostics

A response-loss retry that finds its exact stable record returns the original non-deduplicated success and leaves the provider key intact. A retry that finds a different verified winner may delete only the newly uploaded redundant key. Fault-injection coverage exists for ordinary R2 assets, Comment images, and SWITCHdrive Comment attachments.
''',
    ),
]
for path, marker, addition in appenditions:
    text = path.read_text()
    if marker not in text:
        path.write_text(text.rstrip() + addition)

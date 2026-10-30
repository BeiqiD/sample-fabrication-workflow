PRAGMA foreign_keys = ON;

-- Before the shared blob lifecycle exists, legacy Cancel/cleanup logic may
-- have marked a managed object orphaned even though an unfinished submission
-- still referenced it. Because the old content-uniqueness index only covered
-- status = 'ready', a later upload of the same bytes could then create a second
-- ready object with the same provider/hash/size.
--
-- Migration 0016 promotes reachable orphaned objects back to ready. Rewire
-- occurrences to an already-ready content-identical winner first so that
-- promotion cannot violate managed_storage_objects_content_idx. Stable
-- submission/item identities remain unchanged; the redundant orphan locator is
-- left for the ordinary blob GC ledger introduced by 0016.
WITH replacements AS (
  SELECT
    orphan.id AS orphan_id,
    (
      SELECT winner.id
      FROM managed_storage_objects winner
      WHERE winner.provider = orphan.provider
        AND winner.sha256 = orphan.sha256
        AND winner.byte_size = orphan.byte_size
        AND winner.status = 'ready'
        AND winner.id <> orphan.id
      ORDER BY winner.created_at, winner.id
      LIMIT 1
    ) AS winner_id
  FROM managed_storage_objects orphan
  WHERE orphan.status = 'orphaned'
)
UPDATE comment_submission_items
SET storage_object_id = (
  SELECT replacements.winner_id
  FROM replacements
  WHERE replacements.orphan_id = comment_submission_items.storage_object_id
)
WHERE storage_object_id IN (
  SELECT replacements.orphan_id
  FROM replacements
  WHERE replacements.winner_id IS NOT NULL
);

PRAGMA foreign_keys = ON;

-- Comment previews are client-uploaded occurrence assets. Filename, MIME, size,
-- and reciprocal Comment-item relationships cannot prove that the preview bytes
-- were generated from the paired original, so they must not populate the trusted
-- shared derivative registry.
--
-- Earlier revisions of this Draft PR may already have applied 0033/0034 to a
-- local, preview, or review database. Remove that SQL-side adoption adapter and
-- purge its registrations so already-migrated databases converge on the same
-- trust boundary as fresh installs. Future rows may be written only by a trusted
-- server producer after it reads and validates the source bytes.
DROP TRIGGER IF EXISTS comment_submission_items_adopt_derivative_after_update;
DROP VIEW IF EXISTS attachment_derivative_comment_candidates;

DELETE FROM attachment_derivatives;

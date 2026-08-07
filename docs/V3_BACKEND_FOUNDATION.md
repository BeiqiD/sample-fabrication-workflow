# v3 backend foundation

This document locks the identity and lifecycle boundaries used by the
Project-ready backend rebuild. The v3 database is new and empty; no alpha-v2
data migration or compatibility import is provided.

## Scope of the foundation

The first backend stage establishes stable source identities before adding
Projects, a reference resolver, backlinks, or search. Existing frontend routes
and response shapes remain the compatibility boundary while the backend is
converted in small changes.

Initial reference target types are:

| Target | Stable identity |
|---|---|
| Sample | `samples.id` |
| Run | `runs.id` |
| Run step | `run_steps.id` |
| Logical comment | ready `comment_submissions.id` |
| Step comment occurrence | `run_step_comments.id` |
| Comment attachment occurrence | `comment_submission_items.id` |
| Execution image occurrence | `run_step_assets.id` |
| Metrology reference occurrence | `metrology_template_references.id` |
| Recipe revision | `template_versions.id` |

Project, Project content, and Project attachment identities will be added only
after these source lifecycles are enforced.

## Canonical comments

A ready `comment_submissions` row is the canonical logical comment. Its body,
author, timestamps, and attached items are stored once even when a common
comment targets multiple steps.

`run_step_comments` represents the occurrence of that comment in a particular
run step. Its `submission_id` links to the canonical comment. The duplicated
`body` column remains temporarily for frontend compatibility and must not
become an independently editable source. A future read conversion will resolve
the body from the canonical submission. Context-specific deep links use the
occurrence ID; references to the logical comment use the submission ID.

The v3 database starts empty, so legacy `events` notes and step comments without
a submission identity are not migration targets. `events` remains an audit
timeline rather than a canonical comment store.

## Attachment occurrences and blobs

Projects and search results reference the occurrence of an attachment in its
source context, never an R2 key or shared blob row.

- `comment_submission_items`, `run_step_assets`, and
  `metrology_template_references` are stable occurrence records.
- `assets` and `managed_storage_objects` are storage/blob records used for
  content addressing, deduplication, retrieval, and garbage collection.
- Renaming or changing an occurrence description keeps the occurrence ID.
- Replacing file bytes creates a new occurrence identity.
- Deleting one occurrence never deletes a blob still reachable from another
  active, deleted, archived, or referenced occurrence.

Project-owned attachments will follow the same occurrence-to-blob boundary but
will not be routed through comment submission finalization.

## Lifecycle language

The following terms are distinct:

| Action/state | Meaning |
|---|---|
| Delete / Move to trash | Set `deleted_at` and `deleted_by`; hide from ordinary lists and new-reference search. |
| Restore | Clear deletion metadata and expose the same ID again. |
| Permanently delete | Later privileged operation; blocked while referenced and leaves a minimal tombstone if ever forced. |
| Archive recipe | Prevent future assignment while preserving revisions and run history. |
| Cancel run | Experimental outcome; not deletion and not trash. |
| Remove from Project | Remove only that Project item and its local edges/placements. |

Deleting an upper-level source must not physically cascade through Sample → Run
→ Step → Comment/Attachment. Existing references continue to resolve deleted
sources as read-only records.

## Isolated preview deployment

The integration branch `v2/backend-foundation` is deployed only to the
isolated `sample-workflow-v3` Worker. Its D1 database and R2 bucket are
separate from the frozen site on `main`; non-production branch builds remain
disabled.

The Worker name, D1 database name and ID, R2 bucket name, hostname, and Access
audience are deployment-specific identifiers. A fork or another Cloudflare
account must replace every one of them before its first remote migration or
deployment. Credentials and Access secrets must never be committed.

## Delivery sequence

The additive foundation introduced lifecycle columns, visible-row indexes,
schema tests, and this contract without changing route behavior. The first
route conversion now applies those boundaries to Runs:

- ordinary Run deletion sets `deleted_at` and `deleted_by` without removing or
  rewiring steps, comments, attachment occurrences, plan revisions,
  verifications, or successor links;
- ordinary reads and mutations exclude deleted Runs and deleted steps;
- restoration clears the deletion metadata on the same Run identity and
  rejects an active process conflict;
- live-run uniqueness and lifecycle triggers ignore deleted Runs;
- the five historical built-in metrology presets are retired; referenced
  presets are archived so existing Run history remains valid.

The remaining sequence is:

1. convert Sample, Comment, attachment-occurrence, and Recipe deletion paths;
2. add cleanup reachability guards and permanent-delete protection;
3. add `reference_targets`, backlinks, and the batch read-only resolver;
4. add object-level deep links and deterministic reference search;
5. add Project-owned data and views.

Project UI, semantic search, source editing from Project, fixed Project
hierarchies, and LLM write access are outside this foundation.

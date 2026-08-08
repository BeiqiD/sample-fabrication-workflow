# v3 backend foundation

Status: source identity and lifecycle contract

This document locks the source identities and recoverable lifecycle boundaries
used by the Project-ready backend rebuild. The v3 database is new and empty; no
alpha-v2 data migration or compatibility import is provided.

The product model and full phase order are defined in
[Project design foundation](./PROJECT_DESIGN_FOUNDATION.md). Physical byte
retention, complete export, and permanent-delete safety are defined
normatively in
[blob lifecycle contract](./BLOB_LIFECYCLE_CONTRACT.md). The concrete next
implementation is specified in
[blob lifecycle implementation plan](./BLOB_LIFECYCLE_IMPLEMENTATION_PLAN.md).

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
| Logical Comment | ready `comment_submissions.id` |
| Step Comment occurrence | `run_step_comments.id` |
| Comment attachment occurrence | `comment_submission_items.id` |
| Execution image occurrence | `run_step_assets.id` |
| Metrology reference occurrence | `metrology_template_references.id` |
| Recipe revision | `template_versions.id` |

Project, Project content, and Project attachment identities are added only after
these source lifecycles and the blob lifecycle gate are enforced.

## Why the lifecycle conversion preceded Project

A Project item is a durable reference, not a copied snapshot. It therefore
cannot safely target a source that ordinary Delete physically removes or
rewires. PR #120 came before Project work so that:

- ordinary deletion preserves stable source and occurrence IDs;
- Restore exposes the same IDs again;
- canonical Comments are not reconstructed from duplicated occurrences;
- attachment occurrences remain distinct from deduplicated physical bytes;
- deleted sources can later resolve read-only instead of becoming accidental
  `404`s;
- permanent deletion can be guarded by backlinks rather than foreign-key
  cascade.

The next blob lifecycle slice is the remaining prerequisite: hidden and
unfinished sources may still protect physical bytes, so cleanup and export must
share one reachability definition before Project attachments add more edges.

## Canonical Comments

A ready `comment_submissions` row is the canonical logical Comment. Its body,
author, timestamps, and attached items are stored once even when a common
Comment targets multiple steps.

`run_step_comments` represents the occurrence of that Comment in a particular
Run step. Its `submission_id` links to the canonical Comment. The duplicated
`body` column remains temporarily for frontend compatibility and must not
become an independently editable source. A future read conversion resolves the
body from the canonical submission.

Context-specific deep links use the occurrence ID; references to the logical
Comment use the submission ID.

The v3 database starts empty, so legacy `events` notes and step Comments without
a submission identity are not migration targets. `events` remains an audit
timeline rather than a canonical Comment store.

## Attachment occurrences and blobs

Projects and search results reference the occurrence of an attachment in its
source context, never an R2 key or shared blob row.

- `comment_submission_items`, `run_step_assets`, and
  `metrology_template_references` are stable occurrence records.
- `assets` and `managed_storage_objects` are storage/blob records used for
  content addressing, deduplication, retrieval, and garbage collection.
- Renaming or changing occurrence description keeps the occurrence ID.
- Replacing file bytes creates a new occurrence identity.
- Soft-deleting one occurrence does not release shared bytes.

Project-owned attachments follow the same occurrence-to-blob boundary but do
not pass through Comment-specific finalization routes. They must emit the same
retention-edge shape defined in
[blob lifecycle contract](./BLOB_LIFECYCLE_CONTRACT.md).

## Lifecycle language

The following terms are distinct:

| Action/state | Meaning |
|---|---|
| Delete / Move to trash | Set `deleted_at` and `deleted_by`; hide from ordinary lists and new-reference search. |
| Restore | Clear deletion metadata and expose the same ID again. |
| Permanently delete | Later privileged operation; conflict-first and never ordinary cascade. |
| Archive Recipe | Prevent future assignment while preserving revisions and Run history. |
| Cancel Run | Experimental outcome; not deletion and not trash. |
| Cancel submission | Terminal or retry-closing upload action; not source deletion. |
| Remove from Project | Remove only that Project item and its local edges/placements. |

Deleting an upper-level source must not physically cascade through
Sample → Run → Step → Comment/Attachment. Existing references continue to
resolve deleted sources as read-only records.

## Source lifecycle invariants implemented by PR #120

- ordinary Run deletion sets `deleted_at` and `deleted_by` without removing or
  rewiring Steps, Comments, attachment occurrences, plan revisions,
  verifications, or successor links;
- ordinary reads and mutations exclude deleted Runs and deleted Steps;
- restoration clears deletion metadata on the same Run identity and returns
  `409` when its predecessor already has another visible successor;
- a deleted active process Run can be restored only when it would again be the
  latest visible process Run for the Sample;
- live active-Run and successor uniqueness ignore deleted Runs without
  weakening uniqueness among visible Runs;
- the historical built-in metrology presets are archived and renamed without
  deleting stable IDs, Template steps, reference files, or Run history;
- deleting a Sample preserves its Runs, events, verifications, and parent/child
  links while ordinary directory, detail, and mutation routes hide it;
- deleting a canonical Comment preserves target occurrences, attachment items,
  and managed storage;
- canonical Comment Restore restores only occurrences marked by that exact
  deletion operation;
- an occurrence or legacy image cannot bypass a deleted canonical Comment;
- Comment attachment Delete and Restore share author, target-visibility, and
  TIFF dependency checks;
- execution-image and metrology-reference Delete hides only the selected
  occurrence and Restore exposes the same occurrence ID again;
- execution-image timeline entries bind to `runStepAssetId`;
- common-Comment group mutations are atomic across their target graph;
- deleting a Recipe revision prevents new assignment without removing its
  family, provenance, or historical Run references.

All restoration routes clear deletion metadata in place. Exports and existing
Run history retain deleted source identities so later reference resolution can
surface them as read-only records.

## Blob lifecycle dependency

Source lifecycle is complete, but the physical-byte lifecycle remains a hard
prerequisite for Project and deployment.

The dedicated contract fixes:

- the exact active, unfinished, retryable, archived, and soft-deleted states
  that retain bytes;
- one shared retention-edge surface for Cancel, scheduled cleanup, export, and
  future permanent-delete planning;
- a concurrency-safe orphan/deletion state machine;
- non-fatal missing-blob export warnings;
- conflict-first permanent-delete behavior and physical-delete protection;
- the required shared-object, race, missing-object, export, and deletion tests.

Do not duplicate those rules in this document. The normative definition is
[BLOB_LIFECYCLE_CONTRACT.md](./BLOB_LIFECYCLE_CONTRACT.md).

## Permanent deletion boundary

Ordinary Delete remains recoverable. The next backend slice hard-disables
accidental physical deletion of stable source tables and adds blocker
infrastructure, but it does not expose a privileged destructive endpoint.

A future permanent-delete endpoint remains disabled until all of the following
exist:

- `reference_targets` and Project backlinks;
- source-specific reverse-reference checks;
- privileged authorization;
- minimal tombstone creation;
- concurrency-safe final blocker checks.

Any blocker returns `409`. Parent deletion cannot be used as a shortcut for
physical cascade. Blob bytes released by a later authorized source deletion are
handled by the ordinary blob GC flow, not deleted in the request.

## v3 deployment gate

Do not run a remote v3 migration or deploy the integration branch until all of
the following are true:

- the blob lifecycle contract has an implementation and dedicated test suite;
- Cancel and scheduled cleanup use the same reachability surface;
- unfinished, retryable, shared, archived, and soft-deleted ready sources are
  protected;
- complete export packages available blobs and records unavailable bytes as
  warnings without losing table data;
- accidental physical source deletion is blocked;
- the dedicated blob-lifecycle check, complete test suite, and deployment build
  pass against the exact integration head.

The repository must expose a dedicated gate such as
`npm run verify:blob-lifecycle`, and remote migration/deployment commands must
run it before touching remote resources.

This gate applies even though the v3 Worker, D1 database, and R2 bucket are
isolated from `main`.

## Isolated preview deployment

After the v3 deployment gate is satisfied, `v2/backend-foundation` may be
deployed only to the isolated `sample-workflow-v3` Worker. Its D1 database and
R2 bucket are separate from the frozen site on `main`; non-production branch
builds remain disabled.

The Worker name, D1 database name and ID, R2 bucket name, hostname, Access
audience, and managed-storage credentials are deployment-specific. A fork or
another Cloudflare account must replace every identifier before its first
remote migration or deployment. Credentials and Access secrets are never
committed.

## Delivery sequence

The remaining sequence is:

1. implement the shared blob reachability, cleanup, export, physical-delete
   protection, and deployment gate in
   [the next backend PR](./BLOB_LIFECYCLE_IMPLEMENTATION_PLAN.md);
2. add `reference_targets`, backlinks, and the batch read-only resolver;
3. add object-level deep links and deterministic reference search;
4. add Project-owned data, Text, and Inspector;
5. add the dynamically loaded Map after its data model and read paths are
   stable.

Project UI, semantic search, source editing from Project, fixed Project
hierarchies, force delete, and LLM write access are outside this foundation.

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

The product model and complete implementation sequence are defined in
[Project design foundation](./PROJECT_DESIGN_FOUNDATION.md). This document is
the source-lifecycle contract that Project relies on.

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

## Blob reachability contract

Blob cleanup is part of the reference lifecycle, not an independent storage
optimization. Cancel, scheduled cleanup, export, and any future permanent-delete
path must use one shared definition of reachability for both R2 `assets` and
`managed_storage_objects`.

A blob is reachable while at least one of the following holds:

1. A ready canonical source or stable attachment occurrence refers to it. This
   includes archived and soft-deleted sources that remain part of history or a
   complete export.
2. A non-cancelled submission that may still finalize or retry refers to it.
   Current `draft`, `uploading`, and retryable `failed` submissions therefore
   protect shared bytes; canonical `ready` submissions protect them regardless
   of source deletion metadata.
3. Another stable source record refers to it, including Recipe/state assets,
   Run-step occurrences, Comment occurrences, verification evidence, import
   provenance, or an audit record that still promises access to the bytes.
4. A registered Project or Project-content attachment reference protects it.
   This source is added when Project data is introduced, without redefining the
   cleanup algorithm.

Soft-deleting an occurrence never makes its blob unreachable by itself. A
failed submission also cannot be treated as unreachable while the API still
allows retry or finalize. If a retention policy expires an unfinished
submission, it must first make an explicit, authoritative transition to a
terminal non-retryable state; cleanup cannot infer that transition from age
alone.

Cleanup follows a two-stage guarded lifecycle:

1. identify a candidate and prove no reachability in the same authoritative
   mutation that marks it orphaned;
2. wait through the retention interval;
3. re-check the same reachability predicate immediately before provider
   deletion;
4. delete the physical object;
5. record the terminal storage status while preserving audit metadata.

Concurrent finalize, retry, restore, Project insertion, or a second deduplicated
submission must either protect the object or make the cleanup mutation fail.
The check cannot exclude the current submission or protect only canonical
`ready` Comments. Mutation markers or an equivalent transactional proof are
required anywhere a preflight decision has dependent writes.

Minimum regression coverage before this contract is considered implemented:

- two unfinished submissions share one managed object; cancelling either one
  does not break finalization or download for the other;
- the same race is covered for deduplicated R2 assets;
- a retryable failed submission remains protected until an explicit terminal
  transition;
- archived and soft-deleted ready sources remain exportable;
- Project attachment occurrences protect their blobs once those tables exist;
- a source becomes reachable between cleanup preflight and mutation;
- a source becomes reachable during the orphan retention interval;
- repeated cleanup is idempotent after partial provider or database failure.

## Permanent-delete contract

Ordinary delete remains recoverable and never invokes physical cascade. No
permanent-delete endpoint may be enabled until `reference_targets`, backlinks,
source-specific reverse-reference checks, and tombstone creation are present.

The default privileged permanent-delete behavior is:

- return `409` while a Project item or another retained source references the
  target;
- report enough backlink information for an operator to understand the block;
- refuse database cascades that would bypass descendant checks;
- evaluate affected blob occurrences through the shared reachability contract;
- preserve audit identity even when content is later removed.

If a future force-delete mode is deliberately added, it must create a minimal
tombstone before deleting the source. The tombstone retains stable identity,
target type, last-known source path, and deletion metadata, but not the removed
body or file bytes. Existing Project items and edges continue to point to that
tombstone instead of disappearing or silently retargeting.

## Complete-export blob behavior

Full export preserves every database row, including failed, orphaned, deleted,
or missing blob metadata needed for audit. It attempts to package bytes only
for objects that are expected to be available under the reachability contract.

Storage drift or an already-missing object must not abort the complete ZIP
without explanation. The export manifest must distinguish packaged blobs from
missing blobs and include a warning with stable row/occurrence identity, storage
kind, and reason. Tables JSON remains complete even when bytes are unavailable.
Export-only authenticated routes may read retained soft-deleted sources; normal
UI download routes continue to enforce ordinary source visibility.

The current exporter still collects every R2 key from `assets`, including rows
whose status is no longer `ready`, and aborts when one fetch fails. Replacing
that behavior and adding missing-blob warnings is a required part of the next
cleanup/reachability change, not a completed guarantee.

## v3 deployment gate

Do not run a remote v3 migration or deploy the integration branch until all of
the following are true:

- the shared reachability predicate protects ready, archived, soft-deleted,
  unfinished/retryable, and shared-object references;
- cancel and scheduled cleanup use that predicate with concurrency guards;
- permanent delete is either disabled or implements the guard and tombstone
  contract above;
- complete export packages available blobs and records missing-blob warnings
  without losing table data;
- shared-object, retry, cleanup race, export, and permanent-delete-disabled or
  guard regression tests pass;
- the complete verification suite and deployment build pass against the exact
  integration head.

This gate applies even though the v3 Worker, D1 database, and R2 bucket are
isolated from `main`.

## Isolated preview deployment

After the v3 deployment gate is satisfied, the integration branch
`v2/backend-foundation` may be deployed only to the isolated
`sample-workflow-v3` Worker. Its D1 database and R2 bucket are separate from the
frozen site on `main`; non-production branch builds remain disabled.

The Worker name, D1 database name and ID, R2 bucket name, hostname, and Access
audience are deployment-specific identifiers. A fork or another Cloudflare
account must replace every one of them before its first remote migration or
deployment. Credentials and Access secrets must never be committed.

## Delivery sequence

The additive foundation introduced lifecycle columns, visible-row indexes,
schema tests, and this contract. The source route conversion now applies those
boundaries to Runs, Samples, Comments, attachment occurrences, and Recipe
revisions:

- ordinary Run deletion sets `deleted_at` and `deleted_by` without removing or
  rewiring steps, comments, attachment occurrences, plan revisions,
  verifications, or successor links;
- ordinary reads and mutations exclude deleted Runs and deleted steps;
- restoration clears the deletion metadata on the same Run identity and
  returns `409` when its predecessor already has another visible successor;
- a deleted active process Run can be restored only when it would again be the
  latest visible process Run for the Sample;
- live active-Run and successor uniqueness, plus lifecycle triggers, ignore
  deleted Runs without weakening uniqueness among visible Runs;
- the five historical built-in metrology presets are archived and renamed with
  deterministic retired titles; their stable IDs, template steps, reference
  files, and historical Run links are never physically deleted by this change;
- deleting a Sample preserves its Runs, events, verifications, and parent/child
  links while ordinary directory, detail, and mutation routes hide it;
- deleting a canonical Comment preserves its target occurrences, attachment
  items, and managed storage; deleting one occurrence does not delete the
  canonical Comment or shared bytes;
- restoring a canonical Comment restores only occurrences marked by that
  canonical delete operation; an independently deleted occurrence stays in
  trash;
- an occurrence or legacy image cannot be restored while its canonical Comment
  remains deleted, and ordinary Sample reads defensively hide any such
  inconsistent row;
- comment attachment delete and restore share the same author and target
  visibility checks; a TIFF preview cannot be visible while its required
  original occurrence remains deleted;
- execution-image and metrology-reference deletion hides only the selected
  occurrence and restoration exposes the same occurrence ID again;
- execution-image timeline entries carry `runStepAssetId`, so restoring one
  occurrence cannot repoint another deleted image event from the same step;
- common-comment group mutations are atomic across their target graph: if any
  target Sample, Run, or Run step is deleted, the entire mutation returns
  `409` without changing visible or hidden targets; the visibility and target
  count gates are repeated inside the mutation batch before audit events or
  timestamps are written;
- deleting a Recipe revision prevents new assignment without removing its
  family, import links, or historical Run references; restoration re-enables
  the same revision when it was not independently archived.

All restoration routes clear deletion metadata in place. Exports and existing
Run history retain deleted source identities so later reference resolution can
surface them as read-only records.

The verification workflow runs for pull requests targeting both `main` and
`v2/backend-foundation`, so an integration PR is rechecked when either its head
or its integration base changes.

The remaining sequence is:

1. add cleanup reachability guards and permanent-delete protection;
2. add `reference_targets`, backlinks, and the batch read-only resolver;
3. add object-level deep links and deterministic reference search;
4. add Project-owned data, Text, and Inspector;
5. add the dynamically loaded Map after its data model and read paths are
   stable.

Project UI, semantic search, source editing from Project, fixed Project
hierarchies, and LLM write access are outside this foundation.

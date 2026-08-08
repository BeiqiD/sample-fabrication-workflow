# v3 backend foundation

Status: source identity, recoverable lifecycle, blob safety, and base reference-resolution contract

This document locks the source identities and recoverable lifecycle boundaries
used by the Project-ready backend rebuild. The v3 database is new and empty; no
alpha-v2 data migration or compatibility import is provided.

The product model and full phase order are defined in
[Project design foundation](./PROJECT_DESIGN_FOUNDATION.md). Physical byte
retention, complete export, and permanent-delete safety are defined normatively
in
[blob lifecycle contract](./BLOB_LIFECYCLE_CONTRACT.md). The blob implementation
is recorded in
[blob lifecycle implementation record](./BLOB_LIFECYCLE_IMPLEMENTATION_PLAN.md),
and activation/operations are defined in
[blob lifecycle activation and operations](./BLOB_LIFECYCLE_OPERATIONS.md). The
base registry and resolver boundary is defined in
[reference registry and batch resolver implementation plan](./REFERENCE_RESOLUTION_IMPLEMENTATION_PLAN.md).

## Scope of the foundation

The completed backend-foundation stages establish stable source identities,
safe byte retention, a sparse reference registry, and bounded read-only
resolution before adding Projects, Project backlinks, deep-link destinations,
or deterministic search. Existing frontend routes and response shapes remain
the compatibility boundary while the backend is converted in small changes.

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
these source lifecycles, the blob lifecycle gate, and the base registry/resolver
are enforced.

## Why lifecycle conversion preceded Project

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

PR #123 closed the corresponding physical-byte boundary: hidden, unfinished,
archived, soft-deleted, and shared sources may still protect bytes, so cleanup
and export share one reachability definition before Project attachments add more
edges. PR #124 corrected the D1/workerd migration shape without weakening that
contract. PR #125 builds the first reference registry and base resolver on top
of those completed prerequisites.

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

Projects and search results reference an attachment occurrence in its source
context, never an R2 key or shared blob row.

- `comment_submission_items`, `run_step_assets`, and
  `metrology_template_references` are stable occurrence records.
- `assets` and `managed_storage_objects` are blob records used for content
  addressing, deduplication, retrieval, and garbage collection.
- Sample-record primary images and thumbnails remain compatibility event edges;
  the thumbnail key is independently retained and guarded.
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
- historical built-in metrology presets are archived and renamed without
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
Run history retain deleted source identities so reference resolution can
surface them as read-only records.

## Blob lifecycle foundation

The physical-byte lifecycle implementation establishes:

- exact active, unfinished, retryable, archived, and soft-deleted states that
  retain bytes;
- one `blob_retention_edges` surface for Cancel, scheduled cleanup, export, and
  future permanent-delete planning;
- a concurrency-safe `orphaned → deleting → deleted` ledger;
- guarded edge creation and deduplication around claimed/terminal locators;
- Sample-record thumbnail retention;
- non-fatal missing/unavailable/integrity export warnings;
- hard physical-delete protection and total internal blocker queries;
- migration repairs for malformed historical metadata and legacy managed-object
  duplicate states;
- dedicated lifecycle, migration, race, export, and deletion tests.

Do not duplicate those rules in this document. The normative definition is
[BLOB_LIFECYCLE_CONTRACT.md](./BLOB_LIFECYCLE_CONTRACT.md).

## Reference registry and base resolver foundation

PR #125 added the first reference read boundary without adding Project data or
frontend behavior:

- `reference_targets` is sparse and idempotent under
  `UNIQUE(target_type, target_id)`;
- the registry ID, registry version, target type, target ID, and first
  registration time are immutable, so a durable registry identity cannot be
  silently retargeted;
- normal resolution reads source tables instead of copied registry content;
- the domain resolver accepts at most 200 targets, validates runtime target
  shape, groups by type, and preserves caller order and duplicate requests;
- adapters use bounded D1-safe queries with JSON-array ID bindings;
- soft-deleted sources, deleted ancestors, and archived Recipe revisions remain
  resolvable with lifecycle metadata;
- common Comments and their attachments preserve every deterministic context;
- resolver responses expose no R2 key, managed-storage object key, or provider
  locator;
- `reference_targets` is exported in the same D1 table-snapshot batch as all
  current source tables;
- actual Project backlinks are deferred until
  `project_items.reference_target_id` exists.

The Phase 2A completion slice mounts `/api/references/*` directly into this
core Hono app, so reference resolution inherits the same error, same-origin,
Access-authentication, identity, and future authorization middleware as the
rest of the API. Its focused gate also executes every v1 resolver adapter and a
200-target request through the bundled Worker against Wrangler local D1 in
Miniflare/workerd.

This is a base resolver. Deep-link URLs, archived read-only destinations,
expandable Inspector children, and Project backlink counts are later enriched
read-model fields rather than hidden requirements of PR #125.

## Permanent deletion boundary

Ordinary Delete remains recoverable. The blob-lifecycle implementation
hard-disables accidental physical deletion of stable source tables and adds
blocker infrastructure. PR #125 added the registry and exact target-type mapping,
but it still does not expose a privileged destructive endpoint.

A future permanent-delete endpoint remains disabled until all of the following
exist:

- Project backlinks through `project_items.reference_target_id`;
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

- the exact integration-head commit passes `npm run verify:v3-deployment`;
- the blob-lifecycle and reference-foundation focused gates pass;
- Cancel and scheduled cleanup use the same reachability surface;
- unfinished, retryable, shared, archived, and soft-deleted ready sources are
  protected;
- complete export packages available blobs, records unavailable bytes as
  warnings, and reads every table snapshot—including `reference_targets`—in
  one D1 batch;
- accidental physical source and registry deletion is blocked;
- registry identities cannot be retargeted through UPDATE;
- the complete ordered migration set, including compatibility repairs, has
  passed both host SQLite and Wrangler local D1/workerd verification;
- all nine v1 resolver adapters, the shared middleware path, and the
  200-target boundary have passed the local Worker/D1 workerd smoke;
- a fresh full-system backup and the applicable D1 recovery bookmark have been
  recorded;
- generated configuration points only to isolated v3 resources.

Remote migration/deployment commands run the blob-lifecycle gate, the detailed
reference suite, Wrangler migration verification, the local Worker/D1 resolver
smoke, the complete test suite, and the deployment build before touching remote
resources. This requirement applies even though the v3 Worker, D1 database,
and R2 bucket are isolated from `main`.

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

Repository history does not by itself prove that an isolated activation has
occurred. Deployment state must be recorded explicitly through the operations
runbook rather than inferred from a merged PR.

## Delivery sequence

The remaining sequence after Phase 2B is:

1. validate the exact merged `v2/backend-foundation` integration head and,
   when intentionally activating v3, follow
   [the blob operations runbook](./BLOB_LIFECYCLE_OPERATIONS.md);
2. complete Phase 2C1: deterministic read-only reference search,
   lifecycle filtering, explainable ranking, and resolver revalidation;
3. complete Phase 2C2: the URL-owned global Search page and reusable
   result-selection surface;
4. add Project-owned data, authoritative target registration and
   `project_items` insertion/backlinks, Text, and Inspector;
5. add the dynamically loaded Map after its data model and read paths are
   stable.

Project UI, semantic search, source editing from Project, fixed Project
hierarchies, force delete, and LLM write access remain outside this
foundation.

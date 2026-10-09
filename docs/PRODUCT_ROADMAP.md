# Product goal and roadmap

Status: canonical product direction and active implementation roadmap

Last reviewed: 2026-10-09 against integration commit
`474a038e3eb79b4251b949458e252805f7851cac` (merged PR #249).
This planning revision changes sequencing and release scope; it implements no
runtime, schema, provider, default, deployment or compatibility transition.

## Current checkpoint

Repository state was read on 2026-10-09. Deployment and browser observations below
retain their actual observation dates; they are not a new live acceptance run.

| Area | Verified position | Remaining boundary |
| --- | --- | --- |
| Integration | `v2/backend-foundation` at `474a038`; #249 is the latest merged PR. `main` is `1788c19`, 238 commits behind the integration line and one commit ahead of its common ancestor. | The main-only commit adds Apache-2.0; both branches already contain the identical LICENSE blob. Reconcile ancestry in the eventual release PR, rather than treating this as a conflicting product change. |
| Verification/deployment | [The merge-head Verify run](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/37147477245) passed 2,533 source and 625 mounted tests; all 14 commit statuses passed. The Cloudflare check for [#249](https://github.com/BeiqiD/sample-fabrication-workflow/pull/249) reports a successful build on 2026-10-03 and Worker `faa8a01b-0fc8-47d7-b59e-81e038bc4310`. | Passing CI and a deployment check do not establish today's provider health or real-browser latency. |
| FP1 | File authority was activated; both new-upload roles use R2. The [2026-10-01 R2 acceptance](./FP1_R2_ROLE_DEFAULTS.md#live-acceptance--2026-10-01) passed the 6 MiB HTTP round trip and V19 recovery of 15/15 byte entries. | Preserve historical accepted destinations, supported recovery and explicit unavailable-provider results. |
| FP2 | Configuration/admin/credential handling, candidate checks, AWS owner binding, native identity admission with V20, internal registered S3 reads and exact-profile File GC are merged through #249. | Native S3 File routes, accepted writes, lifecycle integration, activation and independent defaults remain incomplete. S3 transport/admission is not usable S3 upload support. |
| Frontend/stabilization | Project work through #185 and 6A1–3 ownership/contracts are delivered. The selected S2 baseline is deployed. | Remaining C4, 6A6, 5D/5E/5F and final 6B acceptance are open; completed shortcuts, panels and IME handling are the regression baseline. |
| Old Drafts | #199/#200 remain open and inactive; the selected direct-S2 path shipped in #202. | Review their disposition as superseded alternatives; closing them is housekeeping, not implementing another migration path. |

The latest recorded browser readback, after #249 on 2026-10-03, reported
File authority **Active / execution Enabled**, both roles on R2, and historical
shadow maintenance at **4 resolved / 5 current references / 1 pending / 0 unfinished
attempts**. The pending source was not identified. The earlier 4/4 state remains
valid historical activation evidence, not a current all-clear. One bounded
read-only diagnosis must identify the source and whether it affects active reads,
retention, recovery or only historical reporting before deciding on a repair.
A changed count alone is not permission to convert, delete or reactivate data.

Detailed historical evidence belongs in the [S2 activation checkpoint](./CLOUDFLARE_S2_ACTIVATION_CHECKPOINT.md),
[FP1 role-default acceptance](./FP1_R2_ROLE_DEFAULTS.md), and the focused FP1/FP2
delivery records. Their successful cases and explicitly waived live V20 ZIP
exercise remain accepted. Routine unrelated work does not repeat a live ZIP
export/download/restore; material persistence/addressing/archive/recovery changes
or an actual export defect require the relevant new evidence.

This is the single high-level roadmap. The [File implementation plan](./FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md)
owns FP contracts and exits; [V3 stabilization](./V3_ARCHITECTURE_STABILIZATION_PLAN.md)
owns backend cleanup; [frontend refinement](./FRONTEND_REFINEMENT_IMPLEMENTATION_PLAN.md)
owns Phase 5. Focused documents keep immutable historical details rather than
copying the entire latest-PR narrative into every plan.

## Near-term order and first integrated release

The October revision introduces a bounded performance/maintenance tranche and
an explicit release checkpoint. It preserves FP2 → FP3 → FP4 → FP5 dependencies,
but removes the assumption that all five must finish before the first integrated
V3 release can reach `main`. These are release boundaries, not replacement phase
numbers or a new long-lived branch.

| Order | Outcome | Exit and scope |
| --- | --- | --- |
| 1 | Measured, maintainable current baseline | Record Active/Enabled end-to-end performance and CI cost attribution; repair the pending-reference diagnostic if it exposes a real defect. Remove proven duplicate work, preserving current behavior. Time-box this tranche to the measured highest-return changes. |
| 2 | Complete configurable storage (FP2) | Deliver native File byte addressing/read/write/accepted publication/lifecycle with paired recovery, then qualified activation and independent internal/original defaults. Exercise R2 plus a real qualified AWS S3 instance. |
| 3 | First integrated V3 release | Close 6A6 and remaining C4, complete 5D → 5E → 5F for enabled surfaces, then run 6B. Default scope is existing product + accepted FP1 + completed FP2. FP3–FP5, Docker, group permissions and optional insights remain later commitments. |
| 4 | Verified migration (FP3) | Persisted bounded jobs, dry run, copy/verify/conditional location switch, progress/retry/cancel and retained source cleanup for all file purposes. |
| 5 | Portable research packages (FP4) | Sample/Project export and matching website import ship together, with offline readable projection and a report-only option. Import creates a new copy with explicit identity/provider mapping. |
| 6 | Full system recovery (FP5) | Bounded complete backups and privileged website recovery into a fresh target, preserving promised IDs/history, explicit completeness, protected settings policy and paused recovered jobs. |
| Later | Self-hosting and small-group sharing | Node/Docker + SQLite + persistent local defaults, then membership/resource authorization; see the long-term plan. |

Performance instrumentation and demonstrably safe cleanup can proceed alongside
FP2 preparation. Avoid a general rewrite or an open-ended optimization phase.
Each change must name the affected cost and the behavior it preserves. Broader
frontend redesign remains at the stated checkpoint; targeted correctness and
performance fixes may happen sooner.

If real-provider setup blocks FP2 acceptance, do not manufacture success or keep
adding prerequisite-only panels. A separately reviewed R2-only first-release
scope may defer FP2 activation while retaining its disabled groundwork. That is
an explicit scope decision, not the default plan and not a claim that FP2 passed.
Likewise, unsupported SWITCHdrive live cases remain documented; they do not block
unrelated R2/AWS development or become qualified when another default changes.

### Performance and redundancy programme

The [existing Map performance contract](./PROJECT_MAP_PERFORMANCE_IMPLEMENTATION_PLAN.md)
already provides lazy route/React Flow loading, memoized nodes, selection-only
object reuse, visible-element rendering, contextual zoom and 250/400 plus 500/800
structural fixtures. TIFF decoding already runs in a bounded Worker queue.
These are delivered foundations, not new backlog items. jsdom checks establish
structure and interaction, not frame rate, network latency or browser memory.

Use a named browser/device/network profile and fixed small, 250-node/400-edge and
500-node/800-edge Projects. Include rich Markdown/MathML, images, an eight-sample
Processing workspace, reference search, and non-empty exports. Record cold/warm
open time, long tasks/frame distribution, React commits, request count/bytes,
save acknowledgement time, D1 queries/rows read, export memory and total bytes.
Existing September host/legacy-authority SQL figures remain dated evidence;
measure the current Active/Enabled middleware and real request path again.
Set budgets from that reproducible baseline and state the tested envelope.

| Priority | Concrete candidate and evidence | Acceptance / decision rule |
| --- | --- | --- |
| First | Multi-card save amplification: [placement service](../worker/projects/service.ts) and [single-placement route](../worker/project-routes.ts); the [historical scale record](./BACKEND_RELIABILITY_ACCEPTANCE.md) retains 250/500 serial PATCHes for 250/500 moved cards. | Measure the current path. If confirmed dominant, introduce a bounded geometry batch contract in its own reviewed API change. Requests scale with bounded chunks; revisions, conflict disposition, lost responses, retry identity, undo and final Saved acknowledgement remain correct. Do not merely launch all writes concurrently. |
| First | [ProjectPage](../src/pages/ProjectPage.tsx) computes Map and Reading descriptors separately; [projectReadingNodes](../src/lib/project-map-model.ts) invokes the Map derivation again. Geometry commits recreate descriptor identities. | Derive canonical descriptors once and reuse unchanged nodes; Reading keeps immutable creation order. Measure geometry/content changes, not just selection. Do not claim the parent recomputes on every pointer event. |
| First | [ProcessingWorkspacePage](../src/pages/ProcessingWorkspacePage.tsx) reloads all displayed samples after single-sample operations; its main detail reload and plan-update preview lack the cancellation/generation checks already used in Project. | Refresh the true affected sample set, including shared operations. An isolated one-sample change in an eight-sample workspace avoids seven unrelated reads; stale responses cannot overwrite a changed route/selection. |
| Baseline-dependent | [Alignment guide](../src/lib/project-canvas-productivity.ts) compares moving and stationary anchors in nested loops; [ProjectMapSurface](../src/components/project/ProjectMapSurface.tsx) invokes it during drag. | Compare 1/25/250 selected nodes. Add a drag-scoped index or frame-coalesced work only if traces justify it, preserving threshold and tie-breaking semantics. |
| First, maintenance | [V19](../worker/export-v19-snapshot.ts) and [V20](../worker/export-v20-snapshot.ts) duplicate snapshot mechanics. | Share proven-equivalent mechanics under explicit version descriptors. Preserve frozen catalogs, validators, schema filtering, nonsecret V20 admissions and historical recovery. This is maintainability work, not a demonstrated speedup. |
| Baseline-dependent | Project snapshot already batches its base reads and resolves deduplicated targets in bounded groups; [search](../worker/references/search.ts) still scans text before ranked LIMIT. | Measure query plans, rows read, response size and actual latency. Optimize the offending query/projection first. FTS5 remains conditional on measured need. |
| Staged | [Full export](../src/lib/exportAll.ts) downloads and hashes complete files serially, retains their buffers and creates a complete ZIP Blob. | Measure and declare byte/memory limits, add cancellation and resource bounds where needed, and preserve existing progress and explicit per-file outcomes. FP3 jobs supply the durable execution base for FP4/FP5 streaming/staged packaging. Parallel fetch alone does not solve memory use or snapshot consistency. |

The exact #249 CI run used **1,031 seconds** for shared verification inside a
**17 minute 31 second** job with a 20-minute timeout. Leaf times were 512.146 s
for source tests, 371.322 s for native verification scripts, 69.398 s for mounted
tests and 4.460 s for the build. This is one observed run, not an average.
The [verification plan](../scripts/verification-plan.mjs) already runs shared
leaves once per complete gate; statement/SQL-split caches also already exist.
Measure fixture creation, migration, seeding and scenario execution before choosing
isolated prepared baselines or independent job sharding. Retain migration replay
in migration/upgrade/recovery tests, real guards, all required fault cases and
exact-commit status mapping. Evaluate duplicate push/PR execution and stale-run
cancellation separately. Compare equivalent runs; deleting risk coverage or only
raising timeouts is not a performance result.

### Redundancy removal boundaries

Remove repeated work in layers:

1. **Now:** duplicate pure projections, unnecessarily broad refetches, equivalent
   snapshot mechanics, stale current-status prose and superseded Draft clutter.
   This roadmap update consolidates current progress here; historical records
   remain linked from focused documents.
2. **Where a measured/maintenance boundary warrants it:** extract Project
   controllers and shared transport primitives without merging distinct uncertain,
   rejected, conflict and accepted-operation state machines. File size alone is
   not evidence that a module is slow or redundant.
3. **After native File adoption:** retire runtime legacy aliases and bridges only
   after inventorying every reader, writer, accepted retry, retention/GC root,
   export and supported recovery consumer. Use a populated forward migration and
   explicit old-client treatment. Keep historical migrations and archive readers.

Repeated final authorization/lease/retention checks protect changes that can occur
between asynchronous steps. They are not removable duplicate reads without a
proof that the replacement preserves those races. Trigger/table count is not a
performance target. Keep the single modular Worker and D1/SQLite; current evidence
does not call for a new database engine, cache server or distributed scheduler.

### FP2 completion units

Prefer two coherent delivery outcomes, split into focused reviewable PRs only
where dependency boundaries require it:

1. **Native File runtime and persistence:** one reviewed successor schema/archive
   generation for S3 byte locations, File-only business bindings, accepted writes,
   media/download/export reads, purpose-aware reuse, deletion/GC and paired recovery.
   The [FabuBlox whole-import destination](./FP2_STORAGE_ROLE_SELECTION.md) must
   become per-purpose/per-item frozen targets before internal/original roles can
   differ. Retain historical receipts, recovery and exact profile identities.
2. **Working storage choice:** qualify a real AWS instance, activate atomically,
   then expose independent defaults through existing Settings. Test new writes,
   same-provider distinct instances, old File reads, in-flight accepted retries,
   provider failure, permissions, restart and non-empty successor recovery.

Changing a default chooses the destination of **newly accepted** writes only.
Existing files and already accepted operations stay bound to their recorded
locations. Moving old files is the explicit FP3 job. External credentials remain
encrypted application settings; root keys, Cloudflare bindings and later local
mounts remain installation bootstrap, and ordinary content packages contain no
usable credentials. Generic S3/WebDAV identity and live support are qualified
separately; AWS-specific admission does not certify every S3-compatible service.

## North star

Sample Fabrication Workflow should become a **sample-centered source of truth
with a Project-centered research workspace** for small research groups.

The finished product has two deliberately different layers:

1. **Experimental source record** — Samples, Recipes, Runs, Steps, Comments,
   attachments, metrology records, structures, and timelines record what was
   planned and what actually happened.
2. **Project workspace** — a Project combines read-only references to those
   records with Project-owned Markdown and generic attachments so a researcher
   can spatially organize, explain, connect, and linearly review a body of work
   without copying or rewriting the source record.

The source layer answers:

> What happened to this physical sample, and what is the durable evidence?

The Project layer answers:

> What belongs to this research question, how do the pieces relate spatially,
> and how should another researcher read them in sequence?

Neither layer replaces the other.

## Intended final interaction

Map is the primary Project creation and organization interface. Reading is a
linear projection of the same Project-local item occurrences; it is not an
independent document or second content model.

```text
Project
├─ Map
│  ├─ reference sidebar / search
│  ├─ drag references to exact positions
│  ├─ double-click empty space to create Markdown
│  ├─ add generic attachments
│  ├─ resize and move nodes
│  └─ connect nodes with basic directed/undirected edges
├─ Reading
│  ├─ render the same occurrences in one linear order
│  ├─ edit existing Project-owned Markdown
│  ├─ edit allowed attachment metadata
│  └─ add occurrences through Add and follow immutable insertion order
└─ Inspector
   └─ detail, source hierarchy, exact navigation, and local actions
```

A user should remain in one Project, find any eligible referenceable object in
the sidebar, drag or place it onto the Map, and receive a new Project-local
occurrence only after one authoritative server operation succeeds.

The temporary `/search` page from Phase 2C2 is an integration harness and
reference browser. It is not a commitment to keep Search as a permanent primary
navigation destination. The first Project workspace replaces that destination;
`/search` may then redirect into Project discovery, remain development-only, or
be removed.

## Product boundaries

The product is not intended to become:

- a general LIMS, MES, inventory suite, or enterprise workflow platform;
- a task, approval, progress, or Project-status manager;
- a second editor for source Samples, Runs, Steps, Comments, or Recipes;
- a data-analysis notebook or simulation database;
- a fixed Project folder tree;
- a Canvas whose serialized frontend state is the database model;
- a page-layout or desktop-publishing application;
- a real-time collaborative whiteboard in the initial release;
- an autonomous LLM-operated experimental system.

Project-owned content is initially limited to Markdown and generic attachment
occurrences. All existing experimental records and source attachments remain
read-only references.

## Durable architectural invariants

All future phases preserve these rules:

1. **Source data remains authoritative.** Project stores occurrences,
   Project-owned content, placements, and local relationships; it does not copy
   external source records into editable snapshots.
2. **Identity layers remain separate.** Source/content identity,
   `reference_targets`, Project-item occurrence identity, and Map placement
   identity are not collapsed into one row or one React Flow node.
3. **Map and Reading share content.** Every committed active Project item
   occurrence has a Map placement and automatically appears in Reading by
   immutable creation sequence. SQLite constrains placement cardinality to zero
   or one; the authoritative item-creation transaction provides the stronger
   exactly-one product guarantee. Editing content once updates both projections.
4. **Repeated references are allowed.** One reference target may have several
   independent occurrences in the same Project; no Project-level uniqueness
   constraint is added.
5. **References have no local annotation override.** Interpretation is expressed
   through separate Markdown occurrences or optional edge labels.
6. **Search is a shared capability.** Project discovery, directories, and future
   pickers may use different eligibility profiles but should not grow unrelated
   matching/ranking engines.
7. **Search indexes are derived.** A future FTS5 or other index can be rebuilt
   from authoritative rows and does not own lifecycle or identity.
8. **Delete remains recoverable by default.** Permanent deletion stays disabled
   until Project reverse relations, privileged authorization, tombstones, and
   final concurrency checks exist.
9. **Export and import evolve with the model.** Preserve existing complete-export
   coverage as schemas change. A native Sample/Project package is human-readable
   and has a matching website importer in the same milestone; report export and
   privileged full backup/restore share infrastructure but have different identity
   and authorization semantics.
10. **Platform contracts stay portable.** Cloudflare is the current deployment,
    not the domain model. New code avoids unnecessary D1, R2, Access, Queue, or
    Worker coupling outside adapters and runtime boundaries.
11. **Collaboration is reserved, not implemented.** Stable IDs, monotonic
    optimistic revisions, idempotent operations, and conflict responses preserve
    a future path without introducing CRDT/OT or live presence now.
12. **All managed persistent files are portable.** Purpose determines the `internal`/`originals` write
    policy, not whether a file is migratable. Logical file identity is separate
    from physical locations and configured storage profiles. Changing defaults
    affects new writes; verified migration is explicit and preserves references.
13. **Storage does not grant access.** Domain authorization governs every file
    read, export and mutation. Storage/secret/migration/restore administration
    requires an explicit administrator boundary before write endpoints ship.
14. **LLM capability is read-only and explicit.** A later insight feature may
    summarize or connect user-selected Project content, but it does not mutate
    source records or silently add Project items.

## Current position

### Completed foundation

The following prerequisites are complete on `v2/backend-foundation`:

- stable source and occurrence identities;
- recoverable source deletion and restoration;
- canonical Comment and attachment-occurrence semantics;
- shared blob reachability, GC ledger, export integrity, physical-delete
  protection, and provider-verified deduplication with integrity quarantine;
- sparse immutable reference registry;
- bounded batch resolver over nine existing target types;
- lifecycle-aware canonical Reference URLs;
- exact Step, Comment, attachment, execution-image, and metrology source focus;
- deterministic read-only reference search with portable candidate backend,
  stable ranking, lifecycle filtering, and real Worker/D1 verification;
- reusable `ReferenceSearchSurface`, stable `ReferenceTarget` selection,
  controlled request/filter state, and the temporary `/search` integration
  browser implemented in PR #130;
- normalized Project schema, bounded placement and safe-integer contracts,
  attachment/blob retention, and complete export schema version 4 implemented
  in PR #131;
- authoritative Project CRUD, normalized active and Trash snapshots,
  rollback-safe item-plus-placement creation, bounded retry idempotency,
  attachment media, and basic graph mutations implemented in PR #132;
- desktop React Flow Map kernel, normalized geometry save/undo state,
  navigation protection, and mobile occurrence projection implemented and
  squash-merged in PR #133;
- Project reference sidebar, exact Map placement, repeated occurrence handling,
  uncertain-result reconciliation, Project-local removal, and the permanent
  `pre-pr/project-reference-placement` gate completed in PR #134.

These foundation and discovery-enabling phases are closed. They should receive
correctness fixes but must not continue expanding into independent product areas.
Phase 3B3 Project-owned Markdown and generic attachment creation is complete in
squash-merged PR #135. Phase 3B4 basic Project-local edges are complete in
squash-merged PR #136. Phase 3C Reading projection is complete in squash-merged
PR #138. The bounded Project-stability work in PRs #139/#140 and the storage-
integrity/recovery track in PR #141 are also complete. Phase 3D Markdown/TeX,
mixed-media presentation, save/conflict behavior, and human-readable export are
complete in PR #143, with the shared safe renderer extended to Comment read
surfaces in PR #144. Phase 4A1 canonical Project occurrence focus is complete in
PR #145, Phase 4A2 Inspector hierarchy, provenance, type-specific detail, and
exact source navigation are complete in PR #146, and Phase 4A3 authoritative child-
reference insertion is complete in PR #147. It adds authoritative direct-child
discovery inside the Inspector while reusing the existing Project placement
transaction and retry/reconciliation state machine. Phase 4B1 Canvas
multi-selection and grouped geometry are complete in PR #148. Phase 4B2 authoritative copy/paste is complete in PR #149. Phase 4B3 alignment assistance and explicit z-order are complete in PR #150.
Phase 4C representative-scale Map performance, contextual zoom, and final v1
include/defer decisions are complete in PR #151. Attachment lifecycle Slice A,
shared ingestion Slice B, and occurrence-metadata Slice C are complete in PRs
#152/#153/#154. The bounded shared-derivative registry/resolver/export foundation
is complete in PR #155, including the client-preview trust boundary and complete
export schema v7. Trusted server-side generation remains a separately justified
follow-up. Phase 5 execution planning is complete in PR #156. Phase 5A Project
workspace shell and state hierarchy is complete in PR #157; its exact-head review
found no concrete A2 follow-up. Phase 5B1 occurrence identity language and
Phase 5B2 edge theme/mutation-state language and Phase 5B3 Project-owned editor
outcome feedback are complete in PRs #158/#159/#160; no B4 is currently required.
The materially larger Project composition gap is authorized as Phase 5C. Its C0
contract is complete in PR #161, and its C1 viewport-frame implementation is
complete in PR #162. Phase 5C2a floating panels and context-aware Canvas commands
are complete in PR #163; Phase 5C2b.1 Reference discovery and Inspector hierarchy
is complete in PR #166. C2b.2 Add/workspace controls and C2b.3 quick actions merged
in PR #168, which also incorporates the user-authorized
Markdown/math, editing, placement, reconnection and Trash recovery repairs.
C3 Reading details and responsive panels merged in PR #169. PR #170 merged the
whole-card gesture, interrupted-interaction, mathematical-reference preview and
first-activation repairs. Historical evidence remains in
[Project interaction repair acceptance](./PROJECT_UX_REPAIR_ACCEPTANCE.md),
[C3 acceptance](./PROJECT_C3_ACCEPTANCE.md), and
[card gesture acceptance](./PROJECT_CARD_GESTURE_ACCEPTANCE.md).
[C4 integration acceptance](./PROJECT_C4_ACCEPTANCE.md) is now in progress;
these merges do not complete C4 or establish a release milestone.
The completed Reference and rich-content foundations remain correctness baselines.
The newly planned FP track deliberately extends file/storage and export behavior;
it preserves the lifecycle, integrity, concurrency and ownership guarantees
already delivered, while replacing provider-specific persistence where required.
It does not mark any earlier storage feature as unimplemented.

## Active implementation roadmap

### Phase 2C2 — reusable Project discovery surface

**Status:** complete in PR #130.

**Delivered:**

- reusable browse/select search surface;
- stable target selection output;
- deterministic server-order result presentation;
- filters, retry, cancellation, empty/error/truncation states;
- temporary `/search` integration harness;
- no registration, Project write, or `Add to project` success state.

**Exit:** complete. Work moves directly to Project schema and Canvas contracts,
not additional standalone Search features.

### Phase 3A — Project core persistence

**Goal:** establish normalized Project identities, complete export, and the
single authoritative save protocol required by both Map and Reading before React
Flow or a Markdown editor is introduced.

Phase 3A is deliberately split at the schema/service boundary.

#### Phase 3A1 — schema, export, and blob-safety foundation

**Status:** implemented in PR #131.

**Scope:**

- `projects` with stable identity and recoverable deletion;
- `project_contents` for Markdown and generic attachment ownership;
- revisioned attachment caption/source URL on the content record;
- immutable intrinsic attachment locator/name/type/size metadata using existing
  blob/storage contracts;
- `project_items` as repeatable Project-local occurrences targeting content XOR
  `reference_targets`;
- immutable per-Project `created_sequence` on each item occurrence for Reading;
- zero-or-one `project_map_placements` row per item at the database layer, with
  finite bounded coordinates, dimensions, and z-index;
- `project_edges` with fixed four-side handles, endpoint marker direction, and
  optional short label;
- no uniqueness constraint on `(project_id, reference_target_id)`;
- monotonic revisions that cannot be rewound, pre-bumped, or reused;
- complete-export schema-version bump and Project table/blob coverage;
- migration, host SQLite, D1/workerd, route, and export gates;
- no Project mutation routes.

**Exit:** the schema, export snapshot, and blob graph can be deployed safely, and
every invariant that belongs in SQLite is executable before application writes
are exposed.

#### Phase 3A2 — authoritative Project persistence service

**Status:** implemented in PR #132.

**Scope:**

- Project list, create, open, rename, recoverable delete, and restore;
- one Project snapshot/read model for Map and Reading, plus an explicit
  `includeDeleted=1` Trash snapshot that keeps recoverable child rows discoverable;
- object-owned expected revisions, bounded retry idempotency through stable IDs
  and current-row operation IDs, and explicit `409` conflict behavior;
- one authoritative reference insertion operation that re-resolves, registers,
  allocates `created_sequence`, creates the occurrence, and creates its Map
  placement in one rollback-safe transaction;
- Project-owned Markdown creation and save APIs;
- Project-owned attachment creation plus caption/source-URL update APIs;
- local occurrence removal without source mutation;
- placement and basic-edge mutation APIs;
- normalized delta/save APIs and explicit-save/autosave flush boundaries;
- transaction, concurrency, route, workerd, and exact-head deployment gates.

**Not yet:** React Flow, rich Markdown editor, PDF preview, advanced Inspector,
real-time collaboration, or permanent delete.

**Phase 3A exit:** the backend can create a Project, create owned content, insert
repeated references, persist Map placements and basic edges, derive Reading from
creation sequence, save safely, reopen the Project, and export it completely.

### Phase 3B1 — Map kernel

**Status:** complete; squash-merged in PR #133.

**Goal:** deliver the primary Project interaction surface without yet combining
all creation modes.

**Scope:**

- replace the temporary Search navigation destination with Project;
- Project list/create/open shell;
- dynamically load `@xyflow/react` only for desktop Map editing;
- pan, zoom, selection, fit view, and optional lightweight MiniMap;
- lightweight Markdown, attachment, and reference node renderers;
- move and border resize with unchanged font size;
- one active editor at most;
- local draft plus explicit Save and bounded autosave state;
- persist placement at drag stop/resize end rather than per frame;
- client-session undo/redo for move/resize/selectable local commands;
- simple Inspector selection shell;
- Reading-only default on mobile.

**Exit:** complete. Existing Project item occurrences can be viewed, moved,
resized, saved, and reopened through the desktop Map without React Flow state
becoming the database.

### Phase 3B2 — reference sidebar and Map placement

**Status:** complete; squash-merged in PR #134.

**Goal:** make reference discovery and spatial placement the core Project
creation flow.

**Scope:**

- mount `ReferenceSearchSurface` in the Project sidebar/operation area;
- desktop drag result to exact Map coordinate;
- keyboard-equivalent `Place at Map center` action;
- pending ghost node and explicit known-failure/uncertain-result behavior;
- authoritative server insertion after drop, never at drag start;
- exact replay/reconciliation before an uncertain insertion may be cancelled;
- Project-local removal with exact retry identity and Map geometry freeze while
  the removal outcome is unresolved;
- hover/selected/focused `Open reference` action;
- node body selects rather than navigates;
- allow repeated occurrences of the same reference target;
- make the new occurrence appear in Reading automatically through creation sequence;
- permanent `pre-pr/project-reference-placement` CI coverage.

**Exit:** complete. A user can stay inside a Project, find any supported source
object, place it on the Map, safely reconcile response-loss cases, reopen the
Project, and remove the local occurrence without changing source data or racing
stale geometry writes.

This milestone is the first useful **Project reference-workspace alpha**.

### Phase 3B3 — Project-owned Markdown and generic attachments

**Status:** complete; squash-merged in PR #135.

**Goal:** allow the Map to create the only two Project-owned content classes.

**Scope:**

- double-click empty Map space to create and focus a local Markdown draft;
- cancel unsaved empty drafts and persist valid content;
- explicit `Add attachment` and context-menu insertion at a coordinate;
- generic file metadata and image-rich rendering;
- editable Project-owned caption and optional source URL without changing the
  immutable stored-file locator or intrinsic name/type/size metadata;
- existing source attachments continue to enter through Reference search;
- same occurrence automatically appears in Reading by creation sequence;
- no complex page layout, floating images, or embedded Reference editor nodes.

**Exit:** a Project can spatially combine read-only experimental references,
editable Markdown, images, PDFs as file cards, and other generic files.

### Phase 3B4 — basic Project-local edges

**Status:** complete; squash-merged in PR #136.

**Goal:** support Obsidian-Canvas-like relationship drawing without advanced
routing complexity.

**Scope:**

- Bezier edges only;
- top/right/bottom/left handles;
- fixed endpoints and handles after connection;
- undirected, forward, reverse, and bidirectional endpoint markers;
- optional short free-text label;
- delete/recreate to change endpoints;
- no self-loop, obstacle avoidance, control-point editing, or relation ontology;
- client-session undo/redo and save/conflict behavior for edge changes.

**Exit:** the Map expresses complex Project-local relationships using a bounded,
normalized edge model.

This milestone is the **Map-first Project workspace alpha**.

### Phase 3C — Reading projection

**Status:** complete; squash-merged in PR #138, with Markdown removal lifecycle
wiring completed in the subsequent storage-integrity maintenance slice.

**Goal:** provide a mobile-friendly and linear review/editing projection over the
same occurrences without creating a second content system.

**Scope:**

- render every active occurrence in one linear order;
- no creation controls in Reading;
- edit and recoverably remove existing Project-owned Markdown;
- edit attachment caption and optional source URL, but never retarget attachment
  bytes or intrinsic file metadata;
- references remain read-only;
- fixed deterministic insertion-order presentation;
- Map coordinates and edges remain intact;
- mobile defaults to Reading with limited editing only.

Reading initially uses immutable insertion sequence only. Phase 3A adds no
Reading-placement table, manual reorder, edge-order field, topological sort, or
cycle UX. A later dedicated design may add custom or edge-informed ordering if
real Project use demonstrates the need.

**Exit:** the complete Project can be read and lightly edited linearly without
losing or duplicating Map content.

### Phase 3D — Markdown/TeX, media, and save UX hardening

**Status:** complete in PR #143; shared Project/Comment presentation reuse completed in PR #144.

**Goal:** make owned content comfortable for real research narrative.

**Scope:**

- canonical Markdown storage with CommonMark/GFM-style behavior;
- TeX math rendering;
- lazy editor loading for only the active node/block;
- complete Reading rendering independent of Map node size;
- image preview and caption UX;
- generic file cards;
- conflict resolution and save-status UX;
- coarse Project checkpoints/version snapshots only if needed;
- human-readable export with relative attachment paths.

**Exit:** the Project supports durable mixed-media research narrative without a
mega-editor or page-layout system.

This milestone is the **Project MVP**.

### Phase 4 — complete the v1 functional shape

**Goal:** finish the interaction-shaping features that would otherwise force major
page or component restructuring after visual refinement begins.

Phase 4 is deliberately about **functional completeness**, not final visual polish.
Candidate features do not automatically become release blockers: only capabilities
that real use shows are necessary for the v1 interaction model must land before the
feature freeze.

#### Phase 4A — Inspector and navigation completeness

**Status:** complete through PR #147; Phase 4A1, Phase 4A2, and Phase 4A3 are complete.

**Scope:**

- deeper Inspector with clear source hierarchy and Project-local context;
- Project/item canonical destinations and exact focus/navigation;
- child-reference insertion through the existing authoritative reference path;
- fuller Inspector/modal media preview where it materially improves research use;
- PDF first-page thumbnail if it proves useful for routine inspection;
- webpage screenshot capture only after a security review; no live iframe contract.

**Exit:** inspection and navigation no longer require a later structural redesign of
the Project workspace.

#### Phase 4B — Canvas productivity

**Status:** complete in PRs #148–#150. Phase 4B1 delivered multi-selection and grouped geometry, Phase 4B2 delivered authoritative copy/paste, and Phase 4B3 delivered transient alignment assistance plus explicit z-order without changing the normalized persistence model.

The detailed slice boundaries and persistence constraints are recorded in
[Project Canvas productivity implementation plan](./PROJECT_CANVAS_PRODUCTIVITY_IMPLEMENTATION_PLAN.md), with the frozen Phase 4B2 authorization and retry model in
[Project Canvas authoritative copy/paste contract](./PROJECT_CANVAS_COPY_PASTE_CONTRACT.md).

**Scope:**

- multi-select;
- copy/paste;
- keyboard shortcuts;
- helper/alignment lines;
- explicit z-order controls;
- groups/frames only if real Project use demonstrates a need;
- preserve the normalized occurrence/placement/edge model and existing save
  contracts rather than introducing a frontend-owned Canvas document.

**Exit:** common spatial editing workflows are efficient enough for sustained daily
use without adding general-purpose whiteboard complexity.

#### Phase 4C — performance and final functional gaps

**Status:** complete in PR #151.

**Delivered:**

- contextual `overview`, `compact`, and `full` node/edge presentation with zoom
  hysteresis and no persistence effect;
- memoized node rendering and selection projection that preserves untouched node
  object identity;
- target/envelope-only visible-element rendering for 200–300 node / 300–500 edge
  Projects and the 500-node / 800-edge envelope;
- mounted representative-scale contracts plus a permanent
  `pre-pr/project-map-performance` gate;
- explicit v1 decisions to defer groups/frames, richer non-image previewers, custom
  Reading order, JSON Canvas integration, semantic search, and automatic layout.

The detailed performance and decision boundary is recorded in
[Project Map performance and v1 functional-shape plan](./PROJECT_MAP_PERFORMANCE_IMPLEMENTATION_PLAN.md).

**Exit:** implemented. The same Project occurrences support the intended v1 spatial,
inspection, navigation, and linear-reading workflow at representative scale.

This milestone is the **Project v1 functional shape**.

### V1 feature freeze

**Status:** complete after merged PR #152. Slices B/C and the bounded Slice D
foundation are internal post-freeze backend work and do not reopen the
interaction feature set.

After Phase 4, freeze the interaction-shaping v1 feature set before systematic
frontend refinement begins.

"Feature complete" here means that the capabilities which determine the main page
structure and interaction model are present and stable: Samples/Processing/Recipes,
Project Map, Reading, Inspector, Markdown/media, References, edges, and the selected
v1 Canvas productivity operations. It does **not** mean every future optional
capability has been implemented.

After the freeze:

- avoid adding features that require major page/component restructuring during the
  refinement pass;
- continue correctness, accessibility, performance, and release-blocking fixes;
- defer optional integrations and speculative capabilities instead of reopening the
  v1 interaction model.

The proposed FP track, after review, is a separately scoped exception for file/data-control
capabilities and Settings. It does not reopen Project Map/Reading identities or
Canvas composition. Its necessary UI ships with the capability; remaining Phase 5
work refines the integrated surfaces without reimplementing their backend.

### Phase 5 — frontend refinement

**Status:** new refinement paused for the backend-first track; Phase 5A and Phase 5B are complete in PRs
#157–#160, Phase 5C0 is complete in PR #161, Phase 5C1 is complete in PR #162,
and Phase 5C2a is complete in PR #163. Phase 5C2b and C3 have merged through
PRs #166/#168/#169. Project refinements through #185 are merged and deployed;
C4 integration acceptance remains in progress for the explicitly unverified
workflow, viewport and physical-device cases.

The bounded slice order and review contract are recorded in
[frontend refinement implementation plan](./FRONTEND_REFINEMENT_IMPLEMENTATION_PLAN.md).

**Goal:** refine the complete product as one visual and interaction system after its
functional shape is stable.

Phase 5 is intentionally separate from Phase 3D. Phase 3D still owns **functional
UX** required for correctness and usability, such as editor loading, Markdown/TeX
rendering, save/conflict behavior, and media presentation. Phase 5 owns the
systematic whole-product refinement that would be wasteful while major features are
still changing.

**Scope:**

- typography and information hierarchy;
- spacing, density, surfaces, borders, shadows, and panel composition;
- final button, icon, status, and semantic-color consistency;
- hover, selected, focused, disabled, loading, empty, error, and conflict states;
- final Map-node, edge, Inspector, sidebar, dialog, and Reading visual language;
- desktop/mobile responsive consistency across realistic content sizes;
- restrained transitions and interaction feedback where they improve comprehension;
- keyboard/focus/accessibility polish;
- wording, labels, and microcopy consistency across the whole product;
- cross-page visual review so old and new UI conventions cannot coexist unnoticed.

**Current Project priority:** Phase 5C is a deliberate Project-scoped layout and
control rebuild, not a functional feature phase. The merged slices replace the
centered page-within-a-card composition with a workspace-first shell, give Map
the complete desktop workspace below Project chrome, give Reading an independent
document layout, and float References/Inspector above the Canvas without resizing
it. Desktop Map panels remain non-modal so visible Canvas drag and selection
continue; only mobile Reading-first sheets use modal behavior. The detailed boundary is recorded in the
[Project workspace layout and control contract](./PROJECT_WORKSPACE_LAYOUT_CONTRACT.md).
The implemented C2b controls make Reference discovery useful before search,
prioritize Inspector content and give mode, toolbar, panel, content, destructive
and overflow actions explicit roles. The 2026-09-11 user-authorized repair amendment
extends that slice to safe editing, placement, endpoint reconnection and recovery;
see the implementation plan for its bounded exceptions to the earlier freeze.
C3 implements Reading detail composition and modal mobile panels; its automated
and browser evidence is recorded in `PROJECT_C3_ACCEPTANCE.md`. The PR #170
follow-up is recorded in `PROJECT_CARD_GESTURE_ACCEPTANCE.md`. C4 records the
integrated Project workflow and served version, with results and remaining limits
in `PROJECT_C4_ACCEPTANCE.md`. Shortcuts and help were delivered in #175; #176 and
#183 corrected history availability and native panel key ownership. They are
implemented baseline behavior, not an unstarted work item. Subsequent refinements
cover editing resize (#180), Markdown composition (#181), the leave dialog and
Inspector disclosures (#182/#183), shared panel state and combined Markdown
double-click (#184), and equal panel widths plus Sample note source-focus layout
(#185). Desktop browser evidence is recorded per deployed version; physical OS
IME, wider device/viewport and other unverified C4 cases remain explicit. Existing
identity, source hierarchy and performance contracts continue to govern this review.

The previously planned attachment/media, source-record/directory, and
cross-product integration work moves to Phase 5D, Phase 5E, and Phase 5F
respectively; its product scope is unchanged. On resuming the frontend track,
the next frontend implementation slice after C4 acceptance is **Phase 5D —
attachment and media surfaces**. Phase 5D has not started. The bounded
performance/maintenance tranche and FP2 completion take priority under the
near-term order above; completed Worker extraction is not repeated.
File upload/download, location health, migration and
Settings functionality belongs to FP; Phase 5D later owns consistent attachment
presentation and states across existing pages. Phase 5F includes the new enabled
Settings/export/import surfaces in final cross-product acceptance. Appearance
personalization is a separate later feature, not a prerequisite.

**Exit:** the frozen v1 feature set reads and behaves as one coherent product rather
than a sequence of independently implemented phases.

### Phase 6 — architecture stabilization and release hardening

Backend Phase 6A precedes the remaining frontend refinement. Its late S2/6A6
acceptance remains open. FP is a separate, reviewed capability track; Phase 6B
requires the completed stabilization result, all enabled FP scope and Phase 5F's
final frontend baseline. The two gates remain distinct so early backend probes cannot
be mistaken for final release qualification.

#### Phase 6A — V3 architecture stabilization

The scope below records the delivered ownership/extraction and selected S2
baseline work. The remaining task is the 6A6 exit review and integrated
qualification of that baseline plus forward migrations, not a second extraction
or replacement baseline.

**Goal:** preserve the verified v1 behavior while establishing explicit module
ownership, a bounded Web/Worker contract surface, a final pre-release schema, and
one clean V3 migration baseline before persistent V3 activation.

**Scope:**

- characterize the current dependency, route, SQL, compatibility-field, and
  migration boundaries, including Project command/journal/snapshot ownership;
- extract remaining Sample, Execution, Process-definition, import, export, and
  asset routes from `worker/index.ts` through behavior-preserving PRs;
- separate stable contracts and pure shared algorithms without requiring a
  repository-wide monorepo conversion;
- remove only explicitly verified compatibility fields;
- build and verify `0001_v3_baseline.sql` against the expected final schema;
- distinguish disposable integration-test databases from retained-data targets,
  and verify the appropriate rebuild/recovery or upgrade path for each;
- update migration, export, deployment, backup, and recovery gates without remote
  side effects.

The bounded sequence, protected invariants, decision gates, and explicit
non-goals are defined in
[V3 architecture stabilization plan](./V3_ARCHITECTURE_STABILIZATION_PLAN.md).

**Exit:** the existing V3 implementation is modularized without a rewrite, the
approved compatibility state is removed and the S2 baseline is qualified. Final
integrated acceptance also verifies the baseline plus any reviewed FP forward
migrations from empty and populated databases; it does not replace the baseline.
Every permanent gate and required browser check must pass for the tested scope.

#### Phase 6B — release validation and operational rehearsal

**Goal:** validate the stabilized and refined v1 with realistic use before
treating it as a release candidate.

**Scope:**

- sustained testing with representative real research data and Projects;
- desktop/mobile and supported-browser regression passes;
- performance regression and large-Project checks;
- version-appropriate backup/recovery, human-readable reports, native package
  export/website import and privileged restore rehearsal for enabled FP scope;
- non-empty file cases across configured storage roles, destination verification,
  reference preservation and deletion protection; migration/job interruption is
  qualified in the later release that enables FP3;
- isolated migration/deployment/runbook verification;
- recovery when an old tab requests an unavailable lazy route/editor chunk after
  deployment or a temporary network failure: clear retry/refresh without reload
  loops, lost dirty drafts or discarded accepted-operation checkpoints;
- accessibility and security review of the final interaction surface;
- release-blocking bug fixing without reopening optional feature development.

**Exit:** a release candidate is functionally stable, visually coherent,
architecturally bounded, operationally rehearsed, and suitable for longer
real-world use.

## Save, history, and collaboration direction

The initial editor uses:

```text
local draft
+ pending normalized deltas
+ explicit Save
+ bounded autosave at idle and semantic operation boundaries
```

Drag/resize do not write per frame. Reference drop and creation are high-priority
save operations. Undo/redo is client-session only.

Permanent operation history is not required. A later coarse checkpoint/version
feature may retain meaningful Project snapshots, but it is distinct from session
undo and does not promise restoration to every intermediate drag or keystroke.

Real-time collaboration is deferred. Stable IDs, optimistic revisions,
`updated_by`, idempotent operation IDs, and explicit `409` conflicts are required
now so a future collaboration project does not need to replace the data model.

## Parallel platform and quality tracks

### Portability and Docker distribution

The FP design establishes runtime-neutral file, configuration, job and package
contracts now. Its Cloudflare implementation uses D1 and the existing R2 binding
as both initial file-role defaults. External S3/WebDAV profiles are optional;
no ordinary image or original is permanently tied to R2.

The later portability milestone implements the same application on Node with
ordinary SQLite and persistent local storage, with both roles defaulting to
local storage. It covers streaming, bounded job scheduling/recovery,
authentication, encrypted secrets, backups, volume persistence and deployment
upgrades. Keep platform adapters explicit; do not build a second domain model.

Design acceptance can establish that packages identify logical files rather than
Cloudflare addresses. **Actual Cloudflare ↔ Docker restore/import parity requires
both runnable deployments and non-empty validation at that later milestone.**
FP does not claim Node/local availability merely because its interfaces allow it.
For the intended individual/research-group scale, PostgreSQL, Redis, Kubernetes
and distributed workers are not prerequisites. The longer-term order is in
[Long-term application roadmap](./LONG_TERM_ROADMAP.md).

### Search performance

Do not add FTS5 merely because source scanning is theoretically less scalable.
Add it when representative Project sidebar datasets or measured latency show a
real need.

The preferred optimization remains a rebuildable SQLite FTS5 candidate backend
that preserves existing ranking, lifecycle, resolver, and stable-target
contracts in D1 and compatible self-hosted SQLite.

### Permanent deletion and backlinks

Permanent deletion remains disabled through Project MVP. `project_items` creates
the natural reverse relation needed for future safety, but backlink counts and UI
are not required for alpha or MVP.

A later safety review may count distinct Projects, add conflict reporting,
privileged authorization, final concurrency checks, and tombstone creation.
Repeated occurrences in one Project must not be misrepresented as several
Projects.

### Quality and operations

Every schema phase preserves:

- fresh ordered migrations in host SQLite and D1/workerd;
- focused contract tests and complete test/build gates;
- complete export integrity;
- provider-verified content-addressed reuse with fail-closed outage behavior;
- no physical locator exposure;
- no unauthorized cross-layer mutation;
- isolated remote deployment requirements;
- an initial performance target around 200–300 nodes and 300–500 edges, with
  stress testing around 500 nodes and 800 edges.

## Later capabilities

Only after Project MVP and the deterministic read model are stable should the
roadmap consider:

- optional manual or edge-informed Reading ordering after real use;
- revision pinning to real source history;
- semantic or hybrid search;
- read-only LLM insight over explicit user-selected Project scope;
- suggested connections that require user confirmation;
- advanced consistency dashboards;
- real-time multi-user collaboration;
- advanced automatic layout and edge routing.

LLM insight is not an experimental-record editor, not an autonomous agent, and
not a hidden data-analysis subsystem. Any saved output becomes ordinary
Project-owned Markdown or attachment content only through explicit user action.

## Release milestones

| Milestone | Required capabilities |
|---|---|
| Foundation complete | Source/blob lifecycle, registry, resolver, deep links, exact focus, deterministic search, reusable Project discovery surface |
| Project reference-workspace alpha | Project identity/save model, Map kernel, authoritative repeated-reference placement, reopen/remove behavior |
| Map-first Project workspace alpha | Alpha plus Markdown/attachment creation and basic directed/undirected edges |
| Project MVP | Map-first alpha plus Reading projection, Markdown/TeX, media/save hardening, complete export |
| Project v1 functional shape | MVP plus mature Inspector/navigation, selected Canvas productivity, previews where justified, and representative-scale performance |
| V1 feature freeze | Interaction-shaping v1 scope is fixed; optional future capabilities no longer block refinement |
| First integrated V3 release | Existing product, accepted FP1 and completed FP2; remaining C4/5D/5E/5F, 6A6 and scoped 6B pass. A reviewed R2-only scope is possible only as an explicit FP2 deferral. |
| File/data portability follow-ups | FP3 verified migration, FP4 paired native packages/website import, then FP5 full backup/privileged restore. These remain required later milestones, not gates on the first integrated V3 release. |
| Refined release candidate | Frozen v1 plus enabled reviewed FP scope, systematic frontend refinement, V3 architecture stabilization, and final integrated release validation |
| Portable release | Later milestone: Node/SQLite/local defaults and the same product contracts, including non-empty Cloudflare ↔ Docker import/restore and storage remapping, pass in documented deployments |
| Insight experiments | Optional read-only semantic/LLM features after the deterministic product is stable |

## Immediate next PR order

1. Review this consolidated roadmap and current README. Record a disposition for
   inactive #199/#200 without merging their historical bridge paths. Identify the
   single pending shadow reference through a bounded read-only diagnostic.
2. Establish the current Active/Enabled browser/API/CI baseline. Publish the
   workload and measurements once so subsequent fixes compare the same scenarios.
3. Implement the highest-return measured save/data-loading fix and the proven
   duplicate Project derivation; keep API-contract and behavior-preserving changes
   separately reviewable. Consolidate V19/V20 mechanics and optimize test setup
   only to the extent justified by evidence and maintenance value.
4. Complete the two [FP2 outcomes](#fp2-completion-units). Each enabled persistence
   generation ships with its matching archive/recovery contract. Extra internal
   evidence screens are not substitutes for an end-to-end storage feature.
5. Close remaining 6A6/C4 and complete 5D → 5E → 5F for enabled product scope;
   qualify 6B and prepare the first integrated V3 release PR to `main`. Preserve
   the license, existing deployment separation and a documented populated upgrade
   path. Reconcile current operational controls, not historical assumed state.
6. Continue FP3 → paired FP4 → FP5 after that release checkpoint. Keep current
   export/recovery working throughout; later backup UX is not deferred data safety.
7. Schedule Node/Docker/local portability and then small-group resource sharing
   as separate milestones, with their actual runtime and authorization evidence.

A trusted server-side derivative producer remains optional and separately scoped.
Neither automatic replication nor a distributed task system is required to make
migration, export and import reliable for the intended small-group deployment.

## Work that should not happen next

The next phase should not be:

- more standalone Search-page product polish;
- a Text-first Project editor disconnected from Map occurrences;
- a mega-editor that owns references, attachments, and Canvas nodes internally;
- FTS5 synchronization before measured scale requires it;
- permanent-delete endpoints before the later safety review;
- live webpage iframe preview;
- real-time collaboration before the single-user save/revision model is stable;
- one unbounded whole-product visual mega-PR or global selector-normalization
  pass;
- treating the additive FP1k schema as runtime authority, skipping the shadow/
  catch-up ledger, or hiding capability changes inside behavior-preserving Phase
  6A/remaining Phase 5 PRs;
- a replacement V3 implementation or another long-lived integration branch;
- a repository-wide `apps/` / `packages/` / workspaces move without an independent
  build or distribution requirement;
- a Docker-specific fork or premature full deployment work before the reviewed
  file/configuration/job contracts;
- LLM features before the deterministic Project workflow is usable.

# Project Canvas authoritative copy/paste contract

Status: Phase 4B2 implemented in Draft PR #149; pending independent review

Last reviewed: 2026-08-17 after closing the uncertain-abandon late-commit race, completing selection locking, and hardening verification status publication for PR #149

## Goal

Copy/paste duplicates a bounded selection without turning the Canvas into a frontend-owned document. The clipboard freezes one transient projection of authoritative Project records, while paste is an ordered journal of ordinary item and edge mutations.

This contract defines the Phase 4B2 identity, authorization, geometry, retry, partial-result, and interaction boundaries. `PROJECT_CANVAS_PRODUCTIVITY_IMPLEMENTATION_PLAN.md` records the wider Phase 4B sequence.

## Identity semantics

The selected Project item occurrence is the copy unit, but each item kind has different duplication semantics:

- **Reference**: create a fresh Project item and placement while preserving the resolved `ReferenceTarget`. The source item, registry row, and placement identities are never cloned.
- **Markdown**: create a fresh Project content row, item, placement, and operation identity carrying the Markdown source captured at copy time.
- **Attachment**: create a fresh Project content row, attachment binding, item, placement, and operation identity. The browser supplies only the source Project content ID and copied metadata; the Worker authorizes that source occurrence and resolves its existing asset or managed-storage locator internally.
- **Edge**: create a fresh edge and operation identity only when both source endpoints are included in the copied selection. Boundary edges are excluded.

A copied attachment may reuse the same physical blob because each Project attachment binding is an independent reachability edge. The copy route must not expose, trust, or accept a client-selected asset ID, managed-storage ID, provider, or object key.

## Clipboard boundary

The clipboard is client-session state only:

- it is not stored in D1, R2, Project export, browser storage, or URL state;
- it records source item IDs only for local mapping and diagnostics;
- it freezes Reference targets, Markdown source, attachment caption/source URL, geometry, and internal edge shapes from one accepted `ProjectSnapshot`;
- it is currently same-Project only, because attachment reuse is authorized against a source Project content occurrence;
- malformed or incomplete selected occurrences fail the copy operation rather than producing a silent partial clipboard;
- pending reference/attachment ghosts and unsaved Markdown drafts are not copy candidates.

## Attachment authorization and transaction boundary

A source attachment read before mutation may be used to construct an exact replay candidate, but it is not sufficient authorization for a new destination.

For a new attachment copy, one D1 batch must:

1. reserve the destination Project creation sequence and revision;
2. insert the fresh destination content row;
3. insert the destination attachment binding through `INSERT ... SELECT` from the source content, active source item, authoritative source placement, and current blob record;
4. create the destination item only when the destination attachment binding exists in the same transaction;
5. create the destination placement.

The source-selection query requires all of the following at the write boundary:

- the source Project and content are active;
- at least one active source item in the same Project owns that content;
- the source item still has its authoritative placement;
- an asset is `ready`, and any owning import is `ready`;
- a managed-storage object is `ready` or `orphaned`;
- no matching GC ledger row is `deleting` or `deleted`;
- no matching integrity-quarantine row exists.

If source removal, Project removal, blob state, import publication, GC, quarantine, or binding availability changes after the preliminary read but before the batch executes, the binding SELECT produces no row. The destination item then cannot obtain a valid creation sequence under its binding precondition, so the whole D1 batch rolls back. Project revision and `next_created_sequence` are not consumed by a failed copy.

This is the authoritative TOCTOU boundary. A Project revision check alone is not sufficient because source item/content lifecycle mutations own their child revisions and do not advance the Project revision.

## Exact replay boundary

Exact replay is destination-owned once the destination item exists. The service verifies the same destination item, content, binding, placement, geometry, metadata, and operation identity through the existing attachment-creation replay contract.

Therefore:

- a lost response can be retried after the source occurrence is later removed;
- exact replay can still succeed after the shared blob subsequently enters GC or quarantine, because no new binding is created;
- reusing any destination identity or operation ID with a different payload returns conflict;
- a new destination copy from an inactive source or unavailable blob is rejected.

The preliminary source lookup is still same-Project and type-safe. It cannot authorize content from another Project.

## Geometry

Paste preserves every selected node's width, height, and relative x/y/z differences. The default offset is 32 Canvas units multiplied by a transient paste ordinal. Translation is clamped as one group at authoritative coordinate bounds so relative geometry is not distorted. The copied group is shifted above the current highest z-index when bounded integer space remains; otherwise the largest valid common z-offset is used.

No clipboard or paste ordinal becomes persistent Project state.

## Ordered paste journal

Before the first network write, the client allocates and freezes:

- one transient journal ID;
- every destination item, content, placement, edge, and operation ID;
- every copied geometry;
- the ordered expected Project revision for each item create;
- every remapped edge endpoint and expected endpoint revision.

Item creation is sequential in source creation order. Edges are created only after all item steps have acknowledged a response. The backend remains unchanged at the aggregate boundary: each item or edge mutation is independently authoritative, and no bulk endpoint claims atomic behavior that D1 does not provide.

## Retry, abandonment, and reconciliation

A journal step becomes `acknowledged` only after its response is received. If a request committed but its response was lost, that step stays pending and is retried with exactly the same IDs, payload, expected revision, and operation ID, allowing the existing service replay contract to resolve it.

On any rejected write:

1. execution pauses immediately;
2. acknowledged steps are retained;
3. the failing and later steps remain unchanged;
4. retry resumes the same journal instead of allocating replacement identities;
5. external revision conflicts are surfaced for explicit authoritative reconciliation rather than silently rebasing a partially committed paste.

A partial paste is not rolled back across already acknowledged independent API calls and must never be presented as an atomic success.

Failure certainty controls abandonment:

- a network failure, malformed/lost success response, HTTP `408`, `425`, `429`, or `5xx` is **outcome-uncertain**;
- another received HTTP `4xx` is a **deterministic rejection**.

`Reload and abandon remaining paste` may immediately reload after a deterministic rejection because the failed request is known not to have committed. It must not do that after an outcome-uncertain failure. Instead, it first replays **only the failed pending step** using the exact frozen destination IDs, payload, expected revision, and operation ID. It does not execute later pending items or edges.

The uncertain step is considered settled only when that exact replay either:

- acknowledges the same destination mutation or exact server replay; or
- receives a deterministic rejection that the original exact request could no longer commit past.

Only after settlement may the client perform the authoritative GET, retain any destination rows that actually committed, abandon the later unattempted steps, and clear the journal. If exact replay remains outcome-uncertain, the same journal, failed-step identity, selection lock, navigation blocker, and `beforeunload` protection remain active. A GET alone can never clear an uncertain journal because it could race an earlier request that commits after the read.

If the post-settlement authoritative reload fails, the journal remains as reconciliation state. The abandoned later steps are not restarted; retry repeats the authoritative reload. If all writes acknowledge but the final authoritative reload fails, the page enters a separate reconciliation-error state and offers an authoritative-reload retry rather than treating the paste as complete.

## Interaction boundary

Desktop Map keyboard integration uses `Ctrl/Command+C` and `Ctrl/Command+V` only outside inputs, textareas, selects, contenteditable regions, textbox-like roles, and IME composition. Mobile remains Reading-first.

Copy is accepted only from committed selectable Project occurrences while the Project is in a saved, operation-safe state. Paste immediately moves into an unsafe session state so geometry edits, selection changes, projection switches, conflicting Project operations, and navigation cannot race the frozen journal.

During every unsafe paste state, the Map and Inspector selection surfaces are inert and capture-block pointer, mouse, touch, click, context-menu, and keyboard selection events. This includes clearing the item selection and selecting or clearing an edge. Programmatic projection of acknowledged destination items is still allowed, so the visible selection accurately follows committed partial results.

Each acknowledged item or edge response is projected into the local snapshot as it arrives, so an honestly partial result is visible rather than hidden. After all journal writes complete, the client reloads the authoritative Project snapshot and selects the destination item occurrences that are actually active in that snapshot.

While a paste is unresolved, navigation and `beforeunload` protection remain active. If navigation was already requested when a paused paste is recovered successfully, the blocker automatically proceeds only after the paste has completed and authoritative reconciliation has cleared the unsafe state.

## Verification boundary

The permanent `pre-pr/project-canvas-productivity` and Project-persistence gates cover:

- authoritative clipboard classification for Reference, Markdown, and attachment occurrences;
- fresh identity allocation and source identity non-reuse;
- internal-edge copying and boundary-edge exclusion;
- deterministic grouped geometry mapping;
- ordered Project-revision expectations and fresh endpoint identities;
- pause/resume behavior and lost-response exact replay;
- source-authorized attachment blob reuse without a client locator;
- an interleaved source removal between preliminary read and D1 batch, with zero partial destination rows and no consumed Project sequence;
- same-Project and active-source enforcement;
- asset binding and exact replay after source removal;
- managed-storage `ready` and genuine pre-copy `orphaned` coverage;
- managed-storage GC/quarantine rejection for new copies while exact destination replay remains valid;
- mounted `Ctrl/Command+C` and `Ctrl/Command+V` complete-paste behavior;
- fresh destination identity and ordered Project-revision use through the mounted page;
- acknowledged-result projection and final destination selection;
- response-loss pause, exact request replay without repeating acknowledged earlier steps, authoritative reload, and blocked-navigation continuation;
- deterministic-rejection abandonment without an unnecessary replay;
- uncertain-abandon exact replay of only the failed step before any GET, including an original request that commits after the user starts abandonment;
- later pending edge/item exclusion during abandon settlement;
- item-clear and edge-selection locking throughout the unsafe paste state;
- Worker route, client route, production build, Project worker smoke, Map bundle boundary, and existing mounted Canvas regressions.

The verification workflow treats commit-status publication as reporting, not as a prerequisite for later tests. Status writes retry transient server failures and remain `continue-on-error`, while the actual contract, full-test, and build steps retain their ordinary failure semantics.

# Project Canvas authoritative copy/paste contract

Status: Phase 4B2 implementation contract; active in the Draft PR following PR #148

Last reviewed: 2026-08-17 after Phase 4B1 multi-selection completion

## Goal

Copy/paste duplicates a bounded selection without turning the Canvas into a frontend-owned document. The clipboard freezes one transient projection of authoritative Project records, while paste is an ordered journal of ordinary item and edge mutations.

## Identity semantics

The selected Project item occurrence is the copy unit, but each item kind has different duplication semantics:

- **Reference**: create a fresh Project item and placement while preserving the resolved `ReferenceTarget`. The source item, registry row, and placement identities are never cloned.
- **Markdown**: create a fresh Project content row, item, placement, and operation identity carrying the Markdown source captured at copy time.
- **Attachment**: create a fresh Project content row, attachment binding, item, placement, and operation identity. The browser supplies only the source Project content ID and copied metadata; the Worker authorizes that source occurrence and resolves its existing asset or managed-storage locator internally.
- **Edge**: create a fresh edge and operation identity only when both source endpoints are included in the copied selection. Boundary edges are excluded.

A copied attachment may reuse the same physical blob because the Project attachment binding is itself a reachability edge. It must not expose, trust, or accept a client-selected physical locator through the copy route.

## Clipboard boundary

The clipboard is client-session state only:

- it is not stored in D1, R2, Project export, browser storage, or URL state;
- it records source item IDs only for local mapping and diagnostics;
- it freezes Reference targets, Markdown source, attachment caption/source URL, geometry, and internal edge shapes from one accepted `ProjectSnapshot`;
- it is currently same-Project only, because attachment reuse is authorized against a source Project content occurrence;
- malformed or incomplete selected occurrences fail the copy operation rather than producing a silent partial clipboard.

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

## Retry and reconciliation

A journal step becomes `acknowledged` only after its response is received. If a request committed but its response was lost, that step stays pending and is retried with exactly the same IDs, payload, expected revision, and operation ID, allowing the existing service replay contract to resolve it.

On any rejected write:

1. execution pauses immediately;
2. acknowledged steps are retained;
3. the failing and later steps remain unchanged;
4. retry resumes the same journal instead of allocating replacement identities;
5. external revision conflicts are surfaced for explicit authoritative reconciliation rather than silently rebasing a partially committed paste.

An exact attachment-copy replay remains valid after the source occurrence is removed because the already-created destination can be verified through its stable identities and the retained source binding. A new copy from an inactive source is rejected.

## Interaction boundary

Desktop Map keyboard integration will use `Ctrl/Command+C` and `Ctrl/Command+V` only outside inputs, textareas, selects, contenteditable regions, textbox-like roles, and IME composition. Mobile remains Reading-first. Pending placement ghosts and unsaved drafts are not copy candidates.

After a complete paste, the newly created item occurrences become the transient selection. Partial paste must remain visibly recoverable and must not be presented as an atomic success.

## Verification boundary

The permanent `pre-pr/project-canvas-productivity` gate covers:

- authoritative clipboard classification for Reference, Markdown, and attachment occurrences;
- fresh identity allocation and source identity non-reuse;
- internal-edge copying and boundary-edge exclusion;
- deterministic grouped geometry mapping;
- ordered project-revision expectations and fresh endpoint identities;
- pause/resume behavior and lost-response exact replay;
- source-authorized attachment blob reuse without a client locator;
- same-Project and active-source enforcement;
- exact replay after source removal;
- Worker route, client route, build, and existing mounted Canvas regressions.

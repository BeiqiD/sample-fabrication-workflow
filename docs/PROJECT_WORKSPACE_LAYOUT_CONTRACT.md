# Project workspace layout and control contract

Status: Phase 5C0 layout/control contract; Draft PR #161

Last reviewed: 2026-08-27 after the current Project workspace source audit and
comparison against mature canvas/workspace composition patterns

This document freezes the Project-specific layout and control decisions required
before Phase 5C1 begins. The high-level phase order remains in
[Product goal and roadmap](./PRODUCT_ROADMAP.md), the bounded frontend sequence
and acceptance gates remain in
[Phase 5 frontend refinement implementation plan](./FRONTEND_REFINEMENT_IMPLEMENTATION_PLAN.md),
and authoritative Map, Reading, persistence, selection, edge, retry, and mobile
behavior remains in
[Project Canvas interaction contract](./PROJECT_CANVAS_INTERACTION_CONTRACT.md).

Where this document changes presentation but not behavior, the existing
functional contract remains authoritative. Phase 5C is a workspace-composition
rewrite, not a Project feature expansion.

## Why the current composition is insufficient

The current desktop Project is structurally a centered document page containing
a second framed three-column workspace. The shell has four concrete problems:

1. the page is constrained by a centered maximum width and large document-style
   title region before the user reaches the working surface;
2. the Map shares the remaining width with permanently mounted Reference and
   Inspector columns, so empty or low-value side content continuously reduces the
   primary Canvas;
3. Project navigation, mode, save state, history, ordinary content commands, and
   destructive Project lifecycle actions compete in the same header/action area;
4. the immutable `created_sequence` used to derive Reading order is rendered as
   visible `#N` metadata in Map and Reading, so removal creates apparent numbering
   gaps even though the underlying ordering contract is correct.

The problem is therefore structural. It must not be treated as a spacing-only or
button-color pass.

## Product-level workspace rule

Desktop Project is a **Canvas-first application workspace**.

- Map is the primary creation and spatial-organization surface.
- Map owns all viewport area that is not actively required by Project chrome or
  an open docked panel.
- References and Inspector are optional workspace panels, not permanent columns.
- Reading is a separate document composition over the same occurrences, not a
  replacement cell inside Map geometry.
- mobile remains Reading-first and does not receive a compressed editable Map.

The Project route must no longer read visually as a normal centered content page
with a large card embedded inside it.

## Target desktop anatomy

The intended shell is:

```text
Global application navigation
Project top bar
┌────┬───────────────────────┬──────────────────────────────┬──────────────┐
│rail│ optional source panel │             Map              │ Inspector    │
│    │                       │                              │ optional     │
│    │                       │ selection/edge toolbars      │              │
│    │                       │                              │              │
│    │                       │               Canvas nav     │              │
└────┴───────────────────────┴──────────────────────────────┴──────────────┘
```

The shell must not add a second rounded outer card around the Map. Borders may
separate top bar, rail, and docked panels, while the Canvas itself remains the
workspace background.

## Project top bar

The Project top bar is a compact, single-row workspace bar. Its exact pixel
height is measured in Phase 5C1; the initial design target is approximately
`48–52px`, not the current document-title block.

### Left group — location and identity

- back to Projects;
- Project title, with ellipsis/truncation where necessary and an accessible full
  name;
- no persistent `PROJECT WORKSPACE` eyebrow merely to restate the route type.

### Center group — projection mode

- `Map | Reading` remains one explicit segmented mode control;
- the control changes projection only and does not imply separate content state.

### Right group — save and workspace state

- save state remains visible;
- Undo and Redo remain explicit workspace-history actions;
- Save remains available under the existing save-state rules;
- low-frequency Project actions move into a Project overflow menu;
- `Move to trash` is not a permanently exposed red header button and remains a
  guarded lifecycle action through the existing confirmation flow.

Error, conflict, uncertain-outcome, navigation-blocked, and reconciliation
feedback that requires explanatory text may occupy a bounded status strip below
the top bar. Moving that feedback must not merge semantically different states.

## Left workspace rail and Add flow

A narrow Project-local rail provides entry points for operations that should not
consume permanent Canvas width. The starting design range is approximately
`44–48px`; the final value belongs to Phase 5C2 measurement.

The first-version rail needs only a small command set, for example:

- Add;
- Research record / References;
- optional help/shortcut entry only if real use justifies it.

The rail is not a second application navigation bar and must not duplicate the
global product navigation.

### Add popover

The primary Add entry opens a small anchored menu with the three existing Project
content paths:

```text
Add to Project
- Note / Markdown
- Attachment
- Reference from research record
```

Behavior remains the existing behavior expressed through a clearer entry point:

- Markdown creates a draft at a deterministic visible Canvas position unless the
  existing exact-position gesture is used;
- Attachment invokes the existing file path and deterministic placement default;
- Reference opens the research-record panel;
- double-click empty Map space continues to create Markdown at the pointer;
- Map context-menu insertion continues to support exact-position insertion.

No new content type or creation transaction is introduced.

## Research-record / Reference panel

Reference discovery becomes an explicit source panel opened from the workspace
rail. The starting docked-width target is approximately `320px`; Phase 5C2 must
measure the final width against real search results and the protected Canvas
minimum.

The panel owns:

- search query;
- filters;
- search results;
- drag/place actions;
- pending, retry, conflict, uncertain, and reconciliation states required by the
  existing insertion protocol.

It does not permanently own:

- Markdown creation instructions;
- a generic `Add attachment` button;
- long explanatory empty-state copy that can instead be expressed by first-use
  Canvas guidance.

For an empty Project, first-use guidance may appear in the Canvas itself with
bounded entry actions such as Add note, Add attachment, and Search research
record. It disappears once it is no longer useful.

## Inspector panel

Inspector is selection context, not permanent page chrome.

The starting docked-width target is approximately `360–400px`; the exact value is
measured in Phase 5C2.

### Default behavior

- no selected occurrence/edge and no pin: Inspector is closed and consumes no
  Canvas width;
- selecting one occurrence or edge opens the Inspector as temporary selection
  context;
- clearing selection closes an unpinned Inspector;
- a user may pin the Inspector open;
- panel open/pin state is interface preference only and must not mutate the
  Project, Project revision, placement rows, or export.

### Narrow/intermediate behavior

When a docked Inspector would violate the protected Canvas-width rule, Inspector
becomes an overlay/drawer over the Canvas rather than continuously reducing the
Map. Opening an overlay may adjust only the React Flow viewport if necessary to
keep the selected occurrence visible. It must never rewrite persisted item
coordinates or sizes.

### Information hierarchy

Existing Inspector capability is preserved but reorganized by priority:

1. selected type and title;
2. primary item action such as Open reference, Edit Markdown, or Open attachment;
3. ordinary summary, relationships, children, and source hierarchy;
4. provenance/identity detail;
5. advanced Project-local technical metadata such as occurrence ID, revision,
   geometry, and immutable insertion sequence.

The Inspector remains read-only for external source records.

## Canvas chrome

The Canvas should remain visually dominant.

- zoom, fit-view, and related Canvas-navigation controls belong near the lower
  right of the Canvas rather than in Project identity chrome;
- a MiniMap is optional and must not become permanent until representative-scale
  performance and actual navigation value justify it;
- the current React Flow dependency remains sufficient for Phase 5C; no new
  Canvas/whiteboard framework is authorized by this contract;
- panel and toolbar changes must preserve the permanent Project Map performance
  gate.

## Selection and edge toolbars

Selection-local commands should appear close to the selected object or selection
rather than being promoted into the Project top bar.

### Single occurrence

A small selection toolbar may expose only the highest-frequency actions, for
example:

- Markdown: Edit, More;
- Attachment: Open, Edit metadata, More;
- Reference: Open reference, More.

The complete command set remains available through the Inspector and/or a More
menu. Identity, provenance, geometry, stable-link detail, and low-frequency
commands do not belong in the small toolbar.

### Multi-selection

Alignment, z-order, and other existing bulk Canvas commands belong to a bounded
selection toolbar or selection Inspector context. They remain transient UI state
and do not introduce a new selection persistence model.

### Edge selection

Edit/Delete/More may appear at a bounded toolbar near the selected edge while
full edge detail remains available in Inspector.

## Unified command model

Phase 5C2 should stop treating every visible control site as an independent
button decision. Project commands should be modeled by role so the same command
can be projected into a quick toolbar, context menu, overflow menu, Inspector, or
keyboard path without four independent implementations.

A suitable Project-local command shape may include:

```text
id
scope: project | workspace | node | edge | selection
label
icon
priority
semantic role
availability / disabled reason
run
```

This is a frontend command projection only. It must not become persisted Project
data or a new backend command protocol.

## Secondary-menu placement contract

The following placement rules are frozen for Phase 5C implementation:

| Trigger | Secondary surface | Placement |
|---|---|---|
| Project overflow | Project-level low-frequency actions, export, lifecycle | below/end-aligned to the top-bar overflow control |
| Add | Markdown, attachment, research-record entry | anchored beside the left-rail Add control |
| Reference rail entry | search/discovery surface | left docked panel or overlay drawer |
| Node body click | inspection | Inspector; body click itself does not navigate |
| Selected node quick actions | frequent item commands | bounded toolbar above/adjacent to the selected node |
| Node More / context menu | full node command set | anchored to More or the pointer position |
| Selected edge | frequent edge commands | bounded toolbar near the edge midpoint |
| Multi-selection | alignment/z-order/bulk commands | one toolbar for the selection, not per-node duplicate toolbars |
| Multi-field editing | editor/detail workflow | Inspector or dedicated editor, not a tiny popover |
| Destructive confirmation | guarded confirmation | existing modal/dialog pattern |
| Mobile detail/action | selection/detail operations | accessible bottom sheet/drawer |

Menus, drawers, and toolbars must restore focus to a sensible originating control
or selected object after close.

## Visible sequence and numbering contract

`created_sequence` remains immutable authoritative Project data. Phase 5C must
not renumber, reuse, compact, or rewrite it when an occurrence is removed.

Presentation changes instead:

### Map

- ordinary Map nodes do not display `#<created_sequence>`;
- node identity is communicated by visible type, title, source context, and
  selection state;
- internal insertion sequence remains available to Inspector/diagnostics when it
  is useful.

### Reading

- Reading order continues to be derived by immutable `created_sequence` with the
  existing deterministic tie-breaker;
- Reading does not present the immutable sequence as a user-facing continuous
  item number;
- if a visible position indicator proves useful, it is a derived dense display
  value such as `3 of 12`, computed from the current active ordered projection and
  never persisted or used as identity;
- removing/restoring an occurrence may therefore change only the derived visible
  position of neighboring items, never their immutable stored sequence.

### Inspector

- immutable insertion sequence may remain visible in an advanced Project
  occurrence section because there it is correctly labeled as technical ordering
  metadata rather than a reader-facing ordinal.

Stable links continue to use Project item identity/focus navigation and never a
visible ordinal.

## Reading composition

Reading receives an independent document shell rather than inheriting the Map
three-column workspace.

The starting desktop content-width target is approximately `760–840px`; Phase
5C3 measures the final width against Markdown, media, long titles, and editing.

- Markdown should read as long-form document content rather than a sequence of
  unnecessarily heavy nested cards;
- attachments and references remain structured occurrence blocks where their
  different semantics require it;
- item-local actions appear on hover/focus/More or in Inspector instead of
  permanently competing with body content;
- readable export remains available but may move to Reading or Project overflow
  chrome;
- clicking/focusing a Reading occurrence may open the same Inspector projection
  used by Map without changing occurrence identity;
- Reading order and content ownership remain unchanged.

Mobile stays Reading-first. Operations that are already permitted on mobile may
use accessible sheets/drawers, but this contract does not authorize mobile Map
editing or new mobile mutations.

## Responsive composition rule

The protected quantity is the usable Map, not a historical fixed column layout.

Phase 5C starts with a design target that a docked desktop Map should retain
approximately `720–760px` of usable width. Exact thresholds must be measured in
implementation and verified on both adjacent widths before becoming contract.

The intended transformation is:

- wide desktop: both side panels may dock when the Map remains above the measured
  minimum;
- medium desktop: at most one side panel docks and the other becomes overlay;
- narrower desktop above the functional Map boundary: side panels are overlays so
  Map retains the working viewport;
- below the existing functional desktop-Map boundary: preserve Reading-first
  mobile behavior unless a separate functional proposal changes that boundary.

The current `560px`, `860px`, and `1180px` Project thresholds are starting
baselines, not presumed final layout thresholds. Every changed threshold requires
adjacent-boundary verification and must remain Project-local.

Panel width, open/closed state, and pin preference may be remembered locally in
the browser if useful. They are UI preferences and must not enter authoritative
Project persistence, mutation identity, revision, or export.

## Phase ownership

### Phase 5C1 — viewport workspace frame

Owns:

- removal of the centered document-page/outer-card composition for Project;
- compact Project top bar;
- Map filling the remaining desktop viewport;
- top-bar grouping for identity, projection mode, save/history, and Project
  overflow;
- moving low-frequency Project lifecycle actions out of permanent primary chrome;
- shell-only state/status-strip placement needed by the new frame.

Does not own:

- Reference/Inspector panel behavior beyond compatibility hooks;
- selection command migration;
- Reading document redesign;
- new breakpoints unless required solely to make the frame valid and measured.

### Phase 5C2 — panels and control hierarchy

Owns:

- left rail and Add popover;
- Research-record panel;
- Inspector temporary/pinned/docked/overlay behavior;
- unified Project command roles and major button-family migration;
- node, edge, and multi-selection quick-toolbar placement;
- removal of visible immutable `#created_sequence` from Map nodes;
- panel focus restoration and keyboard access.

Does not change the underlying creation, selection, edge, removal, save, or
navigation protocols.

### Phase 5C3 — Reading and responsive composition

Owns:

- independent centered Reading document shell;
- Reading action density and Inspector integration;
- removal of user-facing immutable `#created_sequence` from Reading;
- optional derived dense reading-position display if evidence supports it;
- measured dock/overlay transformations across intermediate widths;
- mobile Reading-first sheets/drawers for already-authorized operations.

Does not add custom Reading order or mobile Canvas editing.

### Phase 5C4 — Project integration review

Owns only evidenced gaps after C1–C3:

- Project directory-to-workspace transition;
- cross-mode command and focus consistency;
- empty/ordinary/large Project review;
- measured final Project layout baseline and documentation update.

It must not become a catch-all visual mega-PR.

## Protected behavior and data boundaries

Phase 5C does not change:

- Project, content, item, placement, reference-target, edge, or attachment
  identity;
- authoritative creation/removal/update transaction boundaries;
- expected revisions, idempotent operation IDs, exact retry, uncertain outcome,
  reconciliation, conflict, or navigation blocking;
- stored node coordinates, dimensions, z-order, edge endpoints, marker direction,
  or Reading sort semantics;
- repeated-reference behavior;
- stable focus links;
- attachment trust/lifecycle/storage/export contracts;
- contextual-zoom bands or representative-scale Map policy except through a
  separately measured correctness/performance defect;
- source mutation boundaries;
- mobile Map-editing boundary;
- backend, schema, migration, export version, or external dependency set merely
  for layout.

## Acceptance matrix

Every Phase 5C implementation head must cover the relevant subset of:

- `1440px`, `1024px`, `390px`, and `360px`;
- both adjacent widths for every Project threshold added, removed, or changed;
- empty Project, ordinary mixed-content Project, long-title Project, and the
  representative large Project;
- Map and Reading;
- References closed/open and Inspector closed/temporary/pinned where applicable;
- saved, unsaved, saving, uncertain, reconciling, error, conflict, and
  operation-blocked states where exposed by the changed shell;
- pointer and keyboard selection, menus, drawers, focus-visible state, Escape,
  and focus restoration;
- light and dark themes;
- full Verify, affected mounted/accessibility suites, production build, and the
  Project Map performance gate.

## Exit

Phase 5C is complete only when Project reads as one deliberate research workspace:
Map dominates desktop organization, optional panels appear only when they add
value, commands are placed by scope and frequency, Reading has a separate
long-form composition, visible numbering no longer leaks immutable storage
sequence, and every existing Project mutation, identity, accessibility, and
performance contract remains authoritative.

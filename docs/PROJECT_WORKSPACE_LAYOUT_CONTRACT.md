# Project workspace layout and control contract

Status: governing Phase 5C contract; C0 complete in PR #161, C1 complete in
merged PR #162, and C2 active through retargeted Draft PR #163

Last reviewed: 2026-08-30 during the retargeted Phase 5C2a floating-panel and
context-command implementation

This document governs the Project-specific layout and control decisions now being
implemented through the bounded Phase 5C sequence. The high-level phase order remains in
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
- Map owns all viewport area below Project chrome; opening a desktop panel never
  changes the Canvas box or persisted viewport coordinates.
- References and Inspector are optional floating workspace panels, not permanent
  columns, rails, or docked layout tracks.
- At every desktop width that retains editable Map, panels are non-modal workspace
  surfaces and the visible Canvas stays interactive outside panel bounds.
- Reading is a separate document composition over the same occurrences, not a
  replacement cell inside Map geometry.
- mobile remains Reading-first and does not receive a compressed editable Map;
  its sheets/drawers may use the ordinary modal pattern.

The Project route must no longer read visually as a normal centered content page
with a large card embedded inside it.

## Target desktop anatomy

The intended shell is:

```text
Global application navigation
Project top bar
┌─────────────────────────────────────────────────────────────────────────┐
│                         full-area Map Canvas                            │
│  ┌ floating References ┐                    ┌ floating Inspector ┐      │
│  │ search / placement  │                    │ selection context  │      │
│  └─────────────────────┘                    └────────────────────┘      │
│  Canvas navigation and context-aware pointer commands remain available │
└─────────────────────────────────────────────────────────────────────────┘
```

The shell must not add a second rounded outer card, grid column, or perimeter
border around the Map. The top bar may separate global chrome from the workspace;
floating panels use their own shadow/surface edge while the Canvas remains the
continuous workspace background.

## Project top bar

The Project top bar is a compact, single-row workspace bar. Its exact pixel
height is measured in Phase 5C1; the initial design target is approximately
`48–52px`, not the current document-title block. Ordinary top-bar controls retain
a `36px` minimum target and Map/Reading retain `34px`; compact composition does
not reuse the Dense Process action tier. Selection and clipboard counts are
Canvas-local transient status rather than permanent header width. Within the
existing `860–1180px` desktop range, lower-priority controls may use shorter
visible labels only when their full accessible names and target sizes remain
unchanged.

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

## Workspace entry and Add flow

Desktop Map adds no permanent left rail: the Canvas remains continuous beneath
the top bar. References/Inspector receive compact top-bar toggles, and blank
Canvas right-click provides exact-position creation plus panel entry. C2b may
consolidate the remaining creation buttons into one top-bar Add menu without
adding a layout track.

### Add menu

The Add entry and blank-Canvas context menu expose the three existing Project
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

Reference discovery becomes an explicit floating source panel opened from the
Project top bar or a context-aware Canvas command. Its starting width target is
approximately `300–320px`; Phase 5C2/C3 measure the final size against real
search results without shrinking the underlying Canvas.

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

The starting floating-width target is approximately `320–360px`; the exact value
is measured in Phase 5C2/C3 without creating a Canvas layout track.

### Default behavior

- no selected occurrence/edge and no pin: Inspector is closed and consumes no
  Canvas width;
- selecting one occurrence or edge opens the Inspector as temporary selection
  context;
- clearing selection closes an unpinned Inspector;
- a user may pin the Inspector open;
- panel open/pin state is interface preference only and must not mutate the
  Project, Project revision, placement rows, or export.

### Desktop behavior

Inspector always uses the desktop non-modal floating presentation. Opening it does
not resize the React Flow host or rewrite viewport, item coordinates, or sizes.
C3 may measure a narrower panel width before the mobile boundary, but may not
reintroduce a docked track that reduces Canvas area.

### Information hierarchy

Existing Inspector capability is preserved but reorganized by priority:

1. selected type and title;
2. primary item action such as Open reference, Edit Markdown, or Open attachment;
3. ordinary summary, relationships, children, and source hierarchy;
4. provenance/identity detail;
5. advanced Project-local technical metadata such as occurrence ID, revision,
   geometry, and immutable insertion sequence.

The Inspector remains read-only for external source records.

## Desktop Map panel modality and interaction contract

At every width that retains editable Map, an overlaid Research-record panel or
Inspector is a **non-modal workspace panel**, not an ordinary modal drawer. This
is a product and interaction boundary, not an implementation preference.

Desktop Map overlays must:

- add no backdrop that intercepts pointer input over the visible Canvas;
- never mark the Canvas or Project workspace `inert`;
- use no modal focus trap and no document/body scroll lock;
- allow focus to move between panel controls and the Canvas through the existing
  keyboard paths;
- preserve drag of a Reference result across the panel boundary to an exact
  visible Map coordinate; `Place at Map center` remains the keyboard-equivalent
  path and is not a replacement for exact pointer placement;
- allow a user to select a different node or edge while Inspector remains open,
  updating the same temporary/pinned Inspector rather than requiring close and
  reopen;
- provide a close control and contextual Escape behavior, then restore focus to
  the top-bar panel trigger, prior Canvas selection, or another sensible surviving origin;
- scroll long panel content internally without creating Project-page scroll.

Panel state is independent from the responsive mobile presentation boundary:

- Research-record state is closed/open and Inspector state is
  closed/temporary/pinned;
- desktop presentation is always floating/non-modal; mobile Reading-first
  presentation may become a modal sheet only in C3;
- changing available width may adjust floating panel size but must not silently
  clear open/pin state, selection, search input, pending placement, or
  reconciliation;
- presentation changes never alter Project persistence or mutation identity.

Only mobile/Reading-first sheets and drawers use the ordinary modal contract,
including backdrop, background inertness, focus containment, background scroll
lock, Escape close, and focus restoration.

## Canvas chrome

The Canvas should remain visually dominant.

- zoom, fit-view, and related Canvas-navigation controls belong near the lower
  Canvas edge rather than in Project identity chrome and shift clear of an open
  floating panel without changing the React Flow viewport;
- a MiniMap is optional and must not become permanent until representative-scale
  performance and actual navigation value justify it;
- the current React Flow dependency remains sufficient for Phase 5C; no new
  Canvas/whiteboard framework is authorized by this contract;
- panel and toolbar changes must preserve the permanent Project Map performance
  gate.

### Context command surface

The desktop context menu is a workspace-level command overlay, not content trapped
inside the Map panel stacking context. It renders above floating panels while its
coordinates remain clamped to the Canvas/workspace rectangle.

- stored attachment files and optional source URLs are separate commands with
  destination-accurate labels and the existing safe-link projection;
- each creation, selection, alignment, layer, edge, and panel item reflects that
  command's actual route availability rather than a coarse shared disabled flag;
- an edge menu opens only after the route/controller accepts its target selection;
  Inspect, Edit, and Delete expose separate availability, and edge mutation
  availability includes pending Reference insertion/removal through the existing
  controller capability;
- Escape restores Canvas focus; ordinary activation falls back to Canvas only when
  the command did not open an editor or panel destination;
- while a menu item owns focus, document-level Canvas shortcuts are consumed by
  the menu and must not change selection, history, clipboard, or save state behind
  the still-open target-specific command surface;
- commands that open References/Inspector focus that panel, while an unpinned
  Inspector removed by selection clearing restores a surviving trigger when its
  focused descendant would otherwise be removed.

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
| Add | Markdown, attachment, research-record entry | top-bar Add menu or exact-position blank-Canvas context menu |
| References top-bar/context entry | search/discovery surface | left floating desktop non-modal panel |
| Node body click | inspection | Inspector; body click itself does not navigate |
| Selected node quick actions | frequent item commands | bounded toolbar above/adjacent to the selected node |
| Blank Canvas context menu | exact-position creation, paste, select/fit, panel entry | pointer position clamped inside Canvas |
| Node More / context menu | inspect/edit/open/copy/layer/remove as applicable | anchored to More or the pointer position |
| Selected edge | frequent edge commands | bounded toolbar near the edge midpoint |
| Multi-selection | alignment/z-order/bulk commands | one toolbar for the selection, not per-node duplicate toolbars |
| Multi-field editing | editor/detail workflow | Inspector or dedicated editor, not a tiny popover |
| Destructive confirmation | guarded confirmation | existing modal/dialog pattern |
| Mobile detail/action | selection/detail operations | accessible bottom sheet/drawer |

Menus, panels, drawers, and toolbars must restore focus to a sensible originating
control or selected object after close. Desktop Map overlays follow the non-modal
workspace-panel contract above; only mobile Reading-first sheets/drawers use
modal focus containment and background inertness.

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
use accessible modal sheets/drawers, but this contract does not authorize mobile
Map editing or new mobile mutations.

## Vertical viewport and scroll ownership

Desktop Map mode occupies the viewport available below global application
navigation. It must not recreate the current `100vh - fixed constant` shell under
a different selector.

- Project top bar and any bounded status strip consume their intrinsic content
  height; the workspace row owns all remaining height.
- The height chain from the Project route to the workspace row must permit
  shrinking (for example through `min-height: 0` semantics) rather than forcing
  ordinary document overflow.
- Map/React Flow fills the workspace row and does not create Project-page vertical
  scrolling in desktop Map mode.
- Floating Research-record/Inspector panels scroll independently
  inside that row; long search results or Inspector detail never increase route
  height.
- A multi-line status strip must be height-bounded and internally scrollable or
  expandable when necessary instead of pushing the Canvas below the viewport.
- At short desktop heights, workspace content shrinks within the available row;
  controls and panel content remain reachable through their owned internal
  scrolling.
- Reading mode and mobile Reading-first composition return to ordinary document
  scrolling. A modal mobile sheet may lock that document scroll only while open.

C1 owns this vertical frame and scroll chain. C2 must preserve it while adding
panel internals, and C3 must preserve it while choosing responsive presentations.

## Responsive composition rule

The protected quantity is the usable Map, not a historical fixed column layout.

Desktop Map keeps a full-size Canvas at every editable width. C2 establishes
floating panel widths; C3 may measure smaller widths or spacing at adjacent
desktop sizes, but no desktop panel may become a docked layout track.

The intended transformation is:

- wide desktop: both side panels may float above the full Canvas simultaneously;
- medium and narrower desktop above the functional Map boundary: panels remain
  floating/non-modal, may use measured narrower widths, and never resize Canvas;
- below the existing functional desktop-Map boundary: preserve Reading-first
  mobile behavior and use ordinary modal sheets only when C3 implements them,
  unless a separate functional proposal changes that boundary.

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
- shell-only state/status-strip placement needed by the new frame;
- vertical viewport ownership below global navigation, the shrinking height chain,
  Map page-scroll suppression, and the `1366×768`, `1024×768`, and `1024×600`
  height cases.

Does not own:

- Reference/Inspector panel behavior beyond compatibility hooks;
- selection command migration;
- Reading document redesign;
- new breakpoints unless required solely to make the frame valid and measured.

### Phase 5C2 — panels and control hierarchy

C2a owns:

- Research-record closed/open state and Inspector closed/temporary/pinned state;
- left/right floating desktop non-modal panel presentation over the full Canvas;
- close/Escape/focus behavior, internal scrolling, selection continuity, and
  simultaneous-panel operation without backdrop, inertness, or focus trap;
- exact Reference drag from a floating panel to visible Canvas coordinates, with
  `Place at Map center` retained as the keyboard-equivalent path;
- one route-owned command adapter shared by keyboard, top-bar, Inspector, and
  target-aware blank/node/selection/edge context menus;
- keeping exact-position Markdown/attachment creation and hidden file input
  available even when the left panel is closed.

C2b owns:

- the remaining Project button-family, Add/overflow, and quick-toolbar migration;
- node, edge, and multi-selection quick-toolbar placement;
- removal of visible immutable `#created_sequence` from Map nodes.

C2a must directly mount and verify both panels open simultaneously, each context
target, menu keyboard/focus behavior, and preserved Canvas interaction. C2 does
not change the underlying creation, selection, edge, removal, save, or navigation
protocols.

### Phase 5C3 — Reading and responsive composition

Owns:

- independent centered Reading document shell;
- Reading action density and Inspector integration;
- removal of user-facing immutable `#created_sequence` from Reading;
- optional derived dense reading-position display if evidence supports it;
- measured desktop floating-panel widths/spacing and the resolver that switches
  from desktop non-modal panels to mobile modal presentation;
- mobile Reading-first modal sheets/drawers for already-authorized operations.

C3 may choose measured panel sizes and the mobile transition, but must not
redefine panel state, commands, desktop floating modality, exact Reference drag
behavior, Inspector selection continuity, or focus semantics. It revalidates
those C2 contracts at adjacent desktop widths and the mobile boundary. It
does not add custom Reading order or mobile Canvas editing.

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
- `1366×768`, `1024×768`, and a `1024×600` short-height desktop case;
- both adjacent widths for every Project threshold added, removed, or changed;
- empty Project, ordinary mixed-content Project, long-title Project, and the
  representative large Project;
- Map and Reading;
- References closed/open and Inspector closed/temporary/pinned where applicable;
- desktop Map page-scroll suppression, internal panel/status scrolling, and
  ordinary Reading/mobile document scrolling;
- exact Reference drag from a desktop non-modal overlay to visible Canvas,
  `Place at Map center`, and Inspector selection changes while its overlay stays
  open;
- absence of desktop overlay backdrop, Canvas `inert`, modal focus trap, and
  document scroll lock; modal containment remains verified for mobile sheets;
- saved, unsaved, saving, uncertain, reconciling, error, conflict, and
  operation-blocked states where exposed by the changed shell;
- pointer and keyboard selection, menus, panels, drawers, focus-visible state,
  Escape, and focus restoration;
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

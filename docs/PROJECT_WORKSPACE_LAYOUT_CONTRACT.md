# Project workspace layout and control contract

Status: governing Phase 5C contract; C0 complete in PR #161, C1 complete in
merged PR #162, C2a complete in PR #163, C2b.1 complete in PR #166; C2b.2/C2b.3
merged in PR #168, C3 merged in PR #169, and the gesture/reference follow-up merged
in PR #170. C4 integration acceptance is in progress.

Last reviewed: 2026-09-12 after PRs #168/#169/#170 merged and C4 review began

This document governs the Project-specific layout and control decisions now being
implemented through the bounded Phase 5C sequence. The high-level phase order remains in
[Product goal and roadmap](./PRODUCT_ROADMAP.md), the bounded frontend sequence
and acceptance gates remain in
[Phase 5 frontend refinement implementation plan](./FRONTEND_REFINEMENT_IMPLEMENTATION_PLAN.md),
and authoritative Map, Reading, persistence, selection, edge, retry, and mobile
behavior remains in
[Project Canvas interaction contract](./PROJECT_CANVAS_INTERACTION_CONTRACT.md).

Where this document changes presentation but not behavior, the existing
functional contract remains authoritative. The completed Phase 5 slices remain
historical records. On 2026-09-11 the user explicitly authorized repairs from the
whole-workflow UX review, beyond the original PR's presentation scope. The active
revision below therefore also covers shared editor/save behavior, Reading/mobile
Add, recoverable bulk removal, and edge reconnection. These changes preserve
identity, revision, exact-retry, and storage guarantees. Integrated verification
and historical acceptance boundaries are recorded in `PROJECT_UX_REPAIR_ACCEPTANCE.md`,
`PROJECT_C3_ACCEPTANCE.md`, and `PROJECT_CARD_GESTURE_ACCEPTANCE.md`.
The merged slices remain subject to integrated C4 review, now in progress in
`PROJECT_C4_ACCEPTANCE.md`.

## Baseline that motivated the Phase 5C composition

The pre-Phase-5C desktop Project is structurally a centered document page containing
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
- Save applies to the active content/edge editor first, otherwise it flushes
  placement deltas; the visible status must include an unsaved editor draft;
- correctable input rejection keeps the draft editable; conflict and uncertain
  outcomes retain their distinct reconciliation or exact-retry paths;
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

No new content type or creation transaction is introduced. Add is also available
in desktop Reading and mobile Reading. Those entries reuse the same route-owned
Markdown, upload, and reference-placement operations with a deterministic default
Map placement; they do not mount an editable mobile Canvas. Expanding an editor
moves the same draft into the larger editing surface, with no replacement draft,
second save controller, or additional content identity.

## Research-record / Reference panel

Reference discovery is closed by default and opens explicitly from the Project
top bar, Add > Reference, related-record entry, or a context-aware Canvas command.
Note selection and attachment upload do not implicitly open References. Its starting width target is
approximately `300–320px`; Phase 5C2/C3 measure the final size against real
search results without shrinking the underlying Canvas.

The panel owns:

- search query;
- a small semantic type-scope row and query-only advanced filters;
- a default Suggested state derived from the current Project context;
- search results;
- drag/place actions;
- pending, retry, conflict, uncertain, and reconciliation states required by the
  existing insertion protocol.

Search is a refinement path, not the panel's empty prerequisite. With no committed
query, the panel deterministically loads a bounded set of direct related records
through the existing Reference-children contract:

1. the currently selected reference context is the first seed when eligible;
2. a small number of active Project reference occurrences, newest insertion first,
   provide fallback seeds;
3. leaf references may use their deepest eligible resolved context as a seed;
4. duplicate targets are removed, but a target already on the Map remains visible
   with its active occurrence count because repeated occurrences are valid;
5. every suggestion identifies why it appears, such as `Selected · Sample A` or
   `From Etch run`.

This is deterministic hierarchy expansion, not semantic/LLM inference. It adds no
ranking store, source mutation, Project mutation, or new API. Clearing a search
returns to Suggested and clears query-only advanced constraints.

Successful placement first adds the bounded drag preview, then loads authoritative
Reference details through the existing resolver. Only those details can qualify a
new recommendation seed. This read is independent of the completed insertion:
failure offers a read-only retry, concurrent placements remain independent, and
late responses cannot overwrite another Project session or a reloaded snapshot.
Hydration updates Reference metadata only, preserving unsaved Map geometry.

The default panel filter is a compact semantic scope row: All, Samples, Process,
Comments, Files & data, and Recipes. Exact Sample/date constraints remain behind
`More filters` and appear only in search context. The historical one-column list
of every internal target type must not occupy the placement panel.

Suggested and searched placement results share one compact card hierarchy:

- stable type and title;
- match or suggestion reason and active `On Map` count;
- short subtitle/excerpt/context where available;
- a generous draggable non-interactive card area and one primary `Place` action;
- explicit Open source, with provenance/detail destinations behind More.

Apply the selected type scope before the bounded presentation cap. Child queries
remain bounded; a truncated or partially failed hierarchy read must be described
as incomplete, not as proof that no matching records exist. Preserve successful
seed results and provide search as the route to further matches.

A click-based placement uses a deterministic free position near the visible
viewport center, avoiding overlap with existing or pending cards where bounded
space allows. Exact pointer placement remains exact. This is an insertion default,
not automatic rearrangement of existing Project geometry.

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
- selecting an occurrence or edge selects it and exposes a compact local toolbar;
  it updates an already open Inspector but does not open a closed Inspector;
- Details, an explicit Inspector trigger, or a multi-field editor opens Inspector;
- clearing selection closes an unpinned Inspector;
- opening Inspector does not pin it; only the explicit Pin control changes pin
  preference;
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
3. a bounded, internally scrollable preview and clickable relationships that focus
   the related card; Expand note reveals the complete Markdown without text or
   formula truncation;
4. a related-record entry that opens References in the selected source context,
   rather than rendering a second result browser inside Inspector;
5. one collapsed Details group containing source hierarchy, provenance, occurrence
   identity, revision, geometry, and immutable insertion sequence;
6. More actions containing low-frequency Map arrangement, stable-link utilities,
   and clearly separated recoverable removal commands.

The collapsed preview retains complete rendered mathematical structures. Do not
cut Markdown source, MathML, or a formula with line-clamping or text ellipsis.
Short or empty Inspector content must not force a full-height information column.

An active editor replaces or follows the primary action at the top of the content
hierarchy. It must not be stranded beneath provenance and geometry. Edge inspection
uses the same hierarchy: title, Edit, connection summary, collapsed technical
handles/identity, with Delete under More.

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
  visible Map coordinate; click/keyboard Place uses the bounded free-position
  default near the viewport center and does not replace exact pointer placement;
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
  pickers and expanded editors use the ordinary modal contract when presented
  as a sheet or dialog;
- narrower editable desktop widths prefer one visible panel: explicitly opening
  References hides an unpinned Inspector, and opening Inspector hides References;
  an explicitly pinned Inspector remains respected;
- resizing or changing presentation must preserve selection, pin preference,
  search/draft input, pending placement, and reconciliation state;
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

A small selection toolbar exposes the highest-frequency actions and a More
entry. It uses the same route-owned commands as the context menu, for example:

- Markdown: Edit, More;
- Attachment: Open, Edit metadata, More;
- Reference: Open source, More; unavailable sources retain their reference-record fallback.

The complete command set remains available through the Inspector and/or a More
menu. Identity, provenance, geometry, stable-link detail, and low-frequency
commands do not belong in the small toolbar.

### Multi-selection

Bulk removal and other Canvas commands belong to one bounded selection toolbar.
Alignment and z-order use grouped secondary entries instead of ten permanent
flat menu rows. Selection remains transient UI state. A bulk removal is a journal
of independently acknowledged lifecycle operations, not an atomic bulk API.

### Edge selection

Edit and More appear near the selected edge while full edge detail remains in
Inspector. Dragging an endpoint or handle reconnects the same edge through its
revisioned update operation. A pointer selection anchors the bounded toolbar near
the actual click, clamped within the visible Canvas and clear of endpoint controls;
keyboard/programmatic selection uses the endpoint-based fallback. Double-clicking
a line/label opens Inspector, matching every committed card. Edit is an explicit
action after selection or inspection.

A single click selects a committed card or edge and updates an already-open
Inspector. A double-click opens Inspector for Markdown, references, attachments
and edges alike. An unchanged existing editor in ordinary `editing` state exits
when the user starts a primary Canvas click or drag outside editor controls, then
allows that same gesture to continue. The draft must exactly match its persisted
content/metadata, and focus follows the new Canvas action. New or changed drafts,
rejected saves, saving, uncertain and conflict outcomes keep their guards; pending
operations, reloads, navigation decisions and modal controls are not dismissed.
This follow-up leaves keyboard shortcut organization unchanged.

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
| Committed node or edge click | selection | local quick actions; update Inspector only if already open |
| Committed card or edge double-click | inspection | open Inspector consistently; use an explicit Edit action to edit |
| Selected node quick actions | frequent item commands | bounded toolbar above/adjacent to the selected node |
| Blank Canvas context menu | exact-position creation, paste, select/fit, panel entry | pointer position clamped inside Canvas |
| Node More / context menu | inspect/edit/open/copy/layer/remove as applicable | anchored to More or the pointer position |
| Selected edge | frequent edge commands | bounded toolbar near the actual pointer click, clamped to the visible Canvas; endpoint-based fallback for keyboard/programmatic selection |
| Multi-selection | alignment/z-order/bulk commands | one toolbar for the selection, not per-node duplicate toolbars |
| Multi-field editing | editor/detail workflow | Inspector or dedicated editor, not a tiny popover |
| Recoverable item removal | removal and recovery | More/context/selection command; Undo or Trash restore |
| Project lifecycle confirmation | guarded confirmation | existing modal/dialog pattern |
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

- Reading the selected content and its relationships is the default task. A
  persistent, compact pencil-and-Edit control sits at the right of the occurrence
  type row, with an explicit accessible name for Markdown, attachment metadata,
  or edge editing. It is not a full-width primary action or a hover-only icon.
- Content, named relationship endpoints and readable direction follow the summary.
  Source navigation remains explicit and compact. Technical identity stays in
  Details; infrequent removal stays under More actions, including edge deletion.
- Save is visually primary only while editing. Cancel has a plain visible label;
  its Escape behavior remains available through keyboard metadata and the shared
  help reference, rather than text appended to the button.
- The keyboard icon beside Save opens shortcut help without replacing selection,
  changing an editor draft, or enabling commands behind the dialog. The reference
  separates workspace Save/Escape from Canvas-only commands and explains native
  text-editor ownership. It stays usable in Reading and on short/narrow screens.
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
- frequent Edit/Open actions sit at the card header so long text cannot push them
  below the fold; low-frequency removal and export stay behind More;
- readable export remains available but may move to Reading or Project overflow
  chrome;
- clicking/focusing a Reading occurrence may open the same Inspector projection
  used by Map without changing occurrence identity;
- Reading order and content ownership remain unchanged.

Mobile stays Reading-first. Add, existing-content edits, recoverable removal,
and restoration reuse the same authoritative operations as desktop. Sheets or
larger editors use the ordinary accessible modal pattern when applicable. This
revision authorizes those entry points, not touch Map placement, resize, or edge
editing on a compressed mobile Canvas.

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
  floating/non-modal and never resize Canvas; explicit panel opening prefers one
  visible panel unless Inspector is explicitly pinned;
- below the existing functional desktop-Map boundary: use Reading and its Add /
  edit / recovery entries, with ordinary modal containment for sheets and expanded
  editing; no mobile Map is introduced.

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
  a click/keyboard Place path retained alongside exact pointer placement;
- one route-owned command adapter shared by keyboard, top-bar, Inspector, and
  target-aware blank/node/selection/edge context menus;
- keeping exact-position Markdown/attachment creation and hidden file input
  available even when the left panel is closed.

C2b owns:

- the Reference panel's default Suggested state, bounded explainable hierarchy
  expansion, compact semantic scopes, and compact placement-card hierarchy;
- removal of persistent Markdown/attachment creation content from References
  while preserving Canvas gestures, context commands, the hidden attachment input,
  and pending attachment feedback;
- Inspector priority/disclosure hierarchy for occurrences and edges, including
  top primary actions, visible relationships/related records, collapsed provenance
  and Project detail, and separated utility/danger regions;
- the remaining Project button-family, Add/overflow, and quick-toolbar migration;
- node, edge, and multi-selection quick-toolbar placement;
- removal of visible immutable `#created_sequence` from Map nodes.

C2a's completed verification covered simultaneous panels and context targets.
The current authorized follow-up additionally verifies explicit panel opening,
narrow-width single-panel preference, and the shared editor, removal-recovery,
and edge-reconnection paths documented in the interaction contract. Existing
identity, retry, and navigation protections still govern each operation.

### Phase 5C3 — Reading and responsive composition

Merged in PR #169; implementation and browser evidence:
`PROJECT_C3_ACCEPTANCE.md`. C3 keeps the
existing desktop breakpoint lock, occurrence selection, commands and recovery
controllers. Its merge does not complete C4 integration acceptance.

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

Status: in progress after merged PRs #168/#169/#170. Current evidence and remaining
acceptance limits are recorded in `PROJECT_C4_ACCEPTANCE.md`.

Owns only evidenced gaps after C1–C3:

- Project directory-to-workspace transition;
- cross-mode command and focus consistency;
- empty/ordinary/large Project review;
- measured final Project layout baseline and documentation update.

It must not become a catch-all visual mega-PR.

## Protected behavior and data boundaries

The original layout-only slices did not change the following boundaries. The
2026-09-11 user-authorized UX follow-up adds only the explicit exceptions below;
all other guarantees remain protected:

- Project, content, item, placement, reference-target, edge, or attachment
  identity;
- authoritative creation/removal/update transaction boundaries;
- expected revisions, idempotent operation IDs, exact retry, uncertain outcome,
  reconciliation, conflict, or navigation blocking;
- stored node coordinates, dimensions, z-order, or Reading sort semantics through
  presentation alone; reconnection may change edge endpoints only through the
  guarded update contract and migration `0036_project_edge_reconnection.sql`;
- repeated-reference behavior;
- stable focus links;
- attachment trust/lifecycle/storage/export contracts;
- contextual-zoom bands or representative-scale Map policy except through a
  separately measured correctness/performance defect;
- source mutation boundaries;
- mobile Map-editing boundary;
- backend, schema, export version, or external dependency set merely for layout;
  migration 0036 is the separately authorized functional edge-reconnection change,
  not permission to weaken identity or lifecycle guards.

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
- exact Reference drag, collision-aware click placement, and type filtering before
  the display cap with honest truncated/partial-result feedback;
- explicit panel opening, separate Pin, narrow-panel preference, local toolbars,
  body text selection, and title-triggered editing;
- shared expanded drafts, active-editor Save, correctable metadata failure,
  uncertain exact retry, and Reading/mobile Add;
- single/bulk removal, partial/uncertain acknowledgement, Undo and Trash restore,
  edge reconnection, and pointer-anchored Paste here;
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

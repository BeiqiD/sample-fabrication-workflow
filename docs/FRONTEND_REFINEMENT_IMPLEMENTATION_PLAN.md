# Phase 5 frontend refinement implementation plan

Status: active execution plan; Phase 5A and Phase 5B are complete in PRs
#157–#160, Phase 5C0 is complete in PR #161, Phase 5C1 is complete in PR #162,
and Phase 5C2 is active through retargeted PR #163

Last reviewed: 2026-08-30

Execution base: `v2/backend-foundation` at
`a929f4f37f085056d3fdbe31bf4e62a02710b4a9`; PR #162 is merged, and PR
#163 is retargeted directly to this base

This document turns the whole-product Phase 5 goal in
[Product goal and roadmap](./PRODUCT_ROADMAP.md) into bounded, independently
reviewable frontend slices. Phase 5C explicitly authorizes a Project-scoped
layout and control rewrite; it does not authorize a whole-product visual rewrite
or reopen the v1 interaction feature set.

The governing principle remains the one frozen in
[Frontend interface guidelines](./FRONTEND_GUIDELINES.md):

> **Consistency by role, not uniformity by selector.**

A whole-product refinement pass means that the complete product is reviewed
against one visual, interaction, responsive, and accessibility system over a
sequence of focused PRs. It does not mean that all pages, stylesheets, or
component families should change in one PR.

## Why a dedicated execution plan is required

The product now has a stable functional shape across source records, Project
Map, Reading, Inspector, References, Markdown/TeX, media, attachments, and the
selected Canvas productivity operations. Those capabilities were implemented in
separate phases with different correctness and performance constraints.

The existing frontend baseline deliberately rejects speculative normalization:
visual differences are not automatically defects, Dense workspaces must not be
expanded into Comfortable forms, and mature geometry must not be changed without
a concrete problem and representative verification.

Phase 5 therefore starts by freezing its review and sequencing rules before any
systematic visual work begins. Each implementation PR must identify a real
hierarchy, state, responsive, accessibility, wording, or maintainability problem
and must preserve unrelated mature geometry.

## Normative source order

Phase 5 work follows these documents in order:

1. [Product goal and roadmap](./PRODUCT_ROADMAP.md) for product scope and phase
   boundaries;
2. [Frontend interface guidelines](./FRONTEND_GUIDELINES.md) for normative
   density, typography, controls, responsive, overlay, ownership, and validation
   rules;
3. [Frontend implementation baseline](./FRONTEND_AUDIT.md) for measured current
   geometry and protected component-family behavior;
4. [Color system](./COLOR_SYSTEM.md) for grayscale hierarchy, interaction
   accent, semantic colors, and contrast;
5. [Responsive layout](./RESPONSIVE_LAYOUT.md) for established global tiers,
   Project-specific functional boundaries, and page/mobile transformations;
6. focused Project, Canvas, rich-content, attachment, and blob-lifecycle
   contracts for domain-specific invariants.

When a local visual preference conflicts with a focused functional contract, the
functional contract wins. A Phase 5 PR may clarify a stale document, but it must
not silently weaken an identity, lifecycle, save, retry, conflict, retention, or
performance guarantee.

## Hard boundaries

Phase 5 preserves the following boundaries unless a separately authorized
correctness fix proves that one is invalid.

### Product and backend boundary

- no new source-record or Project content type;
- no schema migration, export-version change, persistence rewrite, or new domain
  mutation API merely for visual refinement;
- no change to Project occurrence, content, placement, edge, or Reading-order
  identity;
- no groups/frames, custom Reading order, automatic layout, semantic search,
  permanent delete, live collaboration, LLM feature, or live webpage iframe;
- no trusted derivative producer, PDF renderer, or upload-transport convergence
  bundled into a visual PR;
- no attempt to turn Comment or Project into a general rich-text/page-layout
  editor.

Correctness defects discovered during Phase 5 may be fixed, but backend and
frontend changes with different failure modes should remain separate whenever
practical.

### Visual-system boundary

- preserve the Comfortable, Compact, and Dense density profiles;
- do not introduce one universal button height, card padding, label style, or
  thumbnail size;
- preserve the grayscale-first interface and slate-blue interaction-only accent;
- preserve workflow semantic colors and Process-grid state meaning;
- do not add a new hard-coded interface palette or component-local color system;
- do not create a late override stylesheet whose main purpose is to cancel an
  earlier selector;
- Phase 5C may replace Project-local layout and control selectors when ownership
  is explicit and superseded rules are removed in the same slice; it does not
  authorize whole-product selector consolidation.

### Geometry and performance boundary

- preserve the global `1200px` / `720px` viewport-tier baseline for ordinary
  application surfaces;
- treat the Project workspace's current `min-width: 860px` functional
  desktop-Map/Reading boundary and local `1180px` / `560px` thresholds as the
  measured starting baseline rather than the Phase 5C target;
- Phase 5C may replace Project-local layout thresholds only through an explicit,
  measured responsive slice with adjacent-boundary verification; global
  `1200px` / `720px` tiers remain unchanged;
- preserve Project placement coordinates, node dimensions, edge endpoints,
  z-order, save boundaries, and React Flow/database separation;
- preserve the representative Project Map target and envelope and its permanent
  performance gate;
- preserve Process-grid sample-count width logic, horizontal overflow, control
  ladder, status scanning, and Jump-to-current behavior;
- preserve task-specific dialog/drawer widths and specialized image-lightbox
  interaction unless that surface is explicitly targeted;
- preserve natural read-only layout and established View/Edit geometry on mature
  forms.

## Required PR contract

Every Phase 5 implementation PR must state all of the following before merge:

1. **Concrete problem** — the reproducible hierarchy, interaction-state,
   accessibility, responsive, wording, or maintainability issue being solved.
2. **Affected role and density** — the surface role and whether it is
   Comfortable, Compact, or Dense.
3. **Protected geometry** — the dimensions, layout behavior, performance
   boundary, and neighboring surfaces that remain unchanged.
4. **Before/after evidence** — only measurements or observations relevant to the
   problem; pixel equality without product meaning is not a goal.
5. **Verification matrix** — viewport, content, state, theme, and input cases
   exercised.
6. **Ownership** — the component or focused stylesheet that owns the final rule;
   no anonymous compatibility override.
7. **Exact-head validation** — full Verify success and every additional
   permanent gate affected by the changed surface.

A PR should remain Draft until its exact head has been independently reviewed.
Large cross-surface observations may be recorded together, but implementation
must be split when the surfaces have different geometry, behavior, or regression
risk.

## Shared verification matrix

Each PR uses the relevant subset of this matrix and records omissions explicitly.

### Viewports

- `1440px` ordinary desktop;
- `1024px` intermediate reflow;
- `390px` common mobile;
- `360px` narrow mobile;
- `320px` minimum-width stress case where the surface is intended to support it;
- `1600–1920px` only for wide Processing and representative large-Project checks;
- the adjacent widths around every documented global or component-local threshold
  touched by the PR. Global responsive work uses `720px` / `721px` and `1200px`
  / `1201px`; Phase 5C must verify the current `560px`, `860px`, and `1180px`
  boundaries and every proposed replacement threshold on both adjacent widths.

### Content

- empty and first-use state;
- ordinary representative content;
- long names, labels, metadata, and wrapped body text;
- missing optional metadata;
- multiple attachments or images where the surface supports them;
- representative large Project and multi-sample Processing data when those
  surfaces are touched.

### Interaction and asynchronous state

- default, hover, pressed/open, selected/current, and focus-visible;
- keyboard navigation and focus restoration;
- disabled and permission/lifecycle-limited state;
- loading, empty, retryable error, and terminal error;
- the complete save state owned by the surface: Project uses `saved`, `unsaved`,
  `saving`, `error`, and `conflict`;
- operation/navigation blocking separately from save state;
- outcome-uncertain and reconciling states where the current operation exposes
  them;
- light and dark themes;
- mouse, keyboard, and touch-relevant behavior without requiring pixel identity
  between input modes.

### Automated verification

- focused source/model/component tests for the changed contract;
- mounted tests for behavior that depends on real component state, focus, or
  Project integration;
- no brittle screenshot or markup snapshot that merely freezes incidental CSS;
- `npm test` and `npm run build` through the repository Verify workflow;
- the existing Project Map performance gate for changes that can affect Map
  projection, rendering, node identity, visibility, or bundle behavior.

## Bounded implementation sequence

The sequence below is ordered by structural leverage and regression isolation.
A slice may use more than one PR. Completing a slice does not require changing a
mature component that already satisfies its role.

A numbered sub-slice does not automatically complete its parent slice. Phase 5A
satisfied this gate after the independent exact-head review of PR #157 found no
remaining concrete shell defect that justified A2. Phase 5B1/B2/B3 are complete
in PRs #158/#159/#160; no additional B4 content-language defect is currently
justified. The larger Project composition gap is intentionally tracked as the
separate Phase 5C layout and control rebuild. Its C0 contract is complete in PR
#161, and its C1 viewport-frame implementation is complete in PR #162.

### Phase 5A — Project workspace shell and state hierarchy

Status: complete in PR #157 after A1; no A2 is currently required.

Goal: make Project entry and workspace chrome establish one clear hierarchy
before refining the content rendered inside Map, Reading, and Inspector.

Candidate scope:

- Project directory/list, create/open entry, and first-use state;
- workspace title, primary/secondary actions, and Map/Reading mode control;
- Reference sidebar and Inspector panel composition;
- complete Project save-state placement and wording for saved, unsaved, saving,
  error, and conflict;
- separate operation/navigation blocked, outcome-uncertain, and reconciling
  feedback where the current shell or pending-operation surfaces expose it;
- panel empty, loading, and error states;
- hover, current, selected, disabled, and focus-visible treatment for shell
  controls;
- desktop/mobile shell consistency without making mobile an editable Map.

Protected boundary:

- no node, edge, placement, Reference insertion, Reading-order, or persistence
  change;
- no change to React Flow viewport behavior or Project Map performance;
- preserve the synchronized `860px` Map/Reading interaction boundary and the
  current `1180px` / `560px` Project layout thresholds unless a separate measured
  responsive PR explicitly changes them;
- no new navigation destination or Project feature;
- no global button or panel selector rewrite.

Exit: Project entry, mode selection, sidebar, Inspector, save state, and separate
operation feedback communicate one coherent hierarchy while all authoritative
behavior remains unchanged.

### Phase 5B — Project Map, Reading, and Inspector content language

Status: complete after Phase 5B3 in PR #160; Phase 5B1/B2 are complete in PRs
#158/#159 and no B4 is currently required.

Goal: make the same Project occurrence read consistently across spatial,
linear, and detailed projections while preserving the different information
density of each projection.

Candidate scope:

- Map node surface hierarchy at overview, compact, and full detail bands;
- selected/focused/editing/pending/blocked presentation without changing stored
  geometry;
- edge label, marker, selection, and focus treatment within the frozen edge
  model;
- Reading card hierarchy, long-form rhythm, metadata, and local actions;
- Inspector section hierarchy, source/Project identity distinction, provenance,
  relationships, and navigation actions;
- Markdown/TeX overflow, code/table/media containment, and edit/read parity;
- consistent empty, unavailable, deleted-source, and conflict presentation.

Protected boundary:

- no new detail band, node type, edge type, or Inspector capability;
- no manual Reading reorder or text-first content model;
- no stored frontend Canvas document;
- contextual zoom thresholds and performance contracts change only for a measured
  defect and require focused performance requalification.

Exit: one occurrence is recognizable across Map, Reading, and Inspector without
forcing those projections into identical layouts.

### Phase 5C — Project workspace layout and control architecture

Status: Phase 5C0 is complete in PR #161; Phase 5C1 is complete in PR #162,
and Phase 5C2 is active through its retargeted C2a PR #163.

Goal: rebuild Project as a workspace-first interface whose Map, Reading,
References, Inspector, and controls use deliberate composition rather than a
centered document page containing a framed three-column card, without changing
authoritative Project behavior.

The detailed anatomy, panel modality, scroll ownership, and slice boundaries are
frozen in the
[Project workspace layout and control contract](./PROJECT_WORKSPACE_LAYOUT_CONTRACT.md).

Current evidence:

- the shell is constrained to a centered `1600px` page, uses a large document
  heading, and places the desktop workspace inside a second framed surface;
- the Map competes with fixed `250–300px` and `270px` side columns instead of
  owning the remaining workspace viewport;
- the Project page, Map, and Reading source currently contain 83 `button` sites
  (73 / 3 / 7 respectively) and 70 `compact-button` class usages. These are
  source-level audit counts, not the number mounted simultaneously, but they
  demonstrate that Project controls need explicit architecture rather than more
  ad hoc compact variants.

Target anatomy:

- a compact Project top bar owns navigation, project identity, mode, save state,
  and the highest-priority workspace actions;
- Map owns the remaining desktop viewport instead of being nested in a
  page-within-a-card composition;
- References and Inspector become explicit, independently collapsible floating
  workspace panels over a full-area Canvas at every editable desktop Map width;
  they never resize, inert, or block the visible Canvas outside their own bounds;
- Reading uses its own centered document shell and reading rhythm rather than
  inheriting Map geometry;
- mobile remains Reading-first, with operations and detail exposed through modal,
  accessible drawers or sheets instead of a compressed desktop Map.

Control architecture:

- define Project-local roles for mode controls, workspace toolbar actions, panel
  actions, content actions, destructive actions, and overflow actions;
- give each role deliberate height, density, label/icon rule, grouping, priority,
  disabled/loading treatment, tooltip or accessible name, and focus-visible state;
- preserve text where it carries decision meaning; collapse lower-priority actions
  to icon-only or overflow only at measured widths and never without an accessible
  name;
- keep semantic danger separate from primary interaction accent and avoid turning
  every visible action into a filled primary button;
- replace generic Project `compact-button` accumulation incrementally with
  Project-owned primitives or explicit role classes; do not globally rewrite
  unrelated product controls.

Bounded sequence:

- **C0 — layout and control contract:** freeze the current audit, target anatomy,
  control taxonomy, protected behavior, responsive matrix, and PR sequence;
- **C1 — viewport workspace frame:** introduce the compact top bar and
  full-viewport desktop Map frame without changing Map data or interaction;
- **C2 — panels and control hierarchy:** C2a owns floating desktop panel state,
  non-modal behavior, exact Canvas interaction, and the complete context-aware
  right-click command surface; C2b completes the major Project button-family and
  quick-toolbar migration without creating a second command implementation;
- **C3 — Reading and responsive composition:** establish the document shell,
  measure desktop floating-panel sizing and the mobile transition, and own mobile
  Reading-first modal transformations without redefining C2 panel behavior;
- **C4 — Project integration review:** reconcile the Project directory and
  workspace entry, close only evidenced cross-slice gaps, and record the measured
  final baseline.

Protected boundary:

- no backend, API, schema, migration, export-version, dependency, or domain-model
  change;
- no change to Project occurrence, content, placement, source, revision, save,
  retry, conflict, reconciliation, attachment-trust, or Reading-order semantics;
- no change to Map node/edge stored geometry, endpoints, direction, selection,
  copy/paste, z-order, contextual-zoom bands, or performance policy without a
  separately measured and authorized defect;
- no new workspace mode, Inspector capability, automatic layout, mobile editable
  Map, or source-record feature;
- no site-wide button rewrite: new control primitives stay Project-scoped until a
  separate cross-product audit proves broader reuse;
- layout slices may replace Project-local thresholds, but must preserve the
  desktop-only Map editing boundary unless a separate functional proposal is
  approved.

Required acceptance:

- `1440px`, `1024px`, `390px`, and `360px`, plus both adjacent widths for
  every threshold added, removed, or changed;
- `1366×768`, `1024×768`, and a `1024×600` short-height desktop case for vertical
  viewport and scroll ownership;
- empty, ordinary mixed-content, long-title, and representative large Projects;
- Map and Reading; References and Inspector open/closed; light and dark themes;
- desktop Map overlays preserve exact Reference drag-to-Canvas and live Inspector
  selection without a backdrop, `inert`, focus trap, or document scroll lock;
- saved, unsaved, saving, uncertain, reconciling, error, conflict, and
  operation-blocked states where exposed;
- normal, hover, pressed/current, disabled, loading, danger, focus-visible, and
  keyboard focus-restoration behavior for changed controls;
- full Verify, affected mounted/accessibility gates, production build, and Project
  Map performance qualification on every implementation head.

Exit: Project reads as one purpose-built workspace at desktop, intermediate, and
mobile widths; controls communicate role and priority before color or proximity;
and every existing mutation, navigation, accessibility, and performance contract
remains authoritative.

### Phase 5D — attachment and media surfaces

Goal: expose the stable shared attachment semantics through one clear visual and
wording system while preserving separate Project, Comment, and Run ownership.

Candidate scope:

- consistent generic file cards and image-preview affordances by density role;
- filename, contextual title/caption, MIME/size metadata, and source-link
  hierarchy;
- progress, cancellation, retry, failed, unavailable, and empty states;
- clear distinction among `Remove attachment`, `Move Comment to trash`,
  `Move Project to trash`, and `Delete run attachment`;
- accurate 24-hour and 30-day recovery wording where the product exposes it;
- keyboard, focus, mobile, confirmation, and lightbox transitions;
- generic-card fallback when no trusted browser preview exists.

Protected boundary:

- client-uploaded Comment previews remain untrusted occurrence assets;
- no server-side derivative generator, PDF renderer, source parser, or new upload
  protocol;
- no owner deletion from an attachment-child action;
- no universal thumbnail geometry across Comfortable, Compact, and Dense
  contexts.

Exit: attachment actions and states are understandable across domains without
misrepresenting lifecycle or preview trust.

### Phase 5E — source-record and directory coherence

Goal: complete evidence-driven refinement of Samples, Templates, Processing,
Comments, Timeline, and Settings/Export after the Project visual language is
stable.

Candidate scope:

- directory title/filter/row/action hierarchy;
- Comfortable Sample and Template read/edit surfaces;
- Timeline and Comment metadata/action hierarchy;
- Settings/Export sections and operational warnings;
- shared wording for loading, empty, error, retry, Trash, and restore states;
- local accessibility and responsive issues found with representative data.

Protected boundary:

- Process grid remains Dense and keeps its sample-count geometry, status colors,
  and action ladder;
- Sample and Template View/Edit field order and natural geometry remain stable;
- Comment body rendering remains separate from attachment controls;
- no broad legacy stylesheet rewrite merely to reduce file count.

Exit: mature source-record surfaces use the same role definitions while retaining
their intentional density and workflow differences.

### Phase 5F — cross-product integration review

Goal: prove that the completed slices form one product and close only concrete
cross-surface gaps.

Scope:

- cross-page typography, icon, button-role, status, and microcopy audit;
- complete keyboard/focus route and overlay review;
- desktop/mobile and light/dark review with realistic content;
- reduced-motion and restrained-transition review where transitions exist;
- final hard-coded color, accidental accent, stale compatibility override, and
  ownership audit;
- final representative large-Project and multi-sample Processing regression;
- documentation update to the measured post-Phase-5 baseline.

Exit: every remaining difference is either role-appropriate, documented, or
backed by a concrete follow-up defect rather than accidental coexistence of old
and new conventions.

## Authorized implementation slices

### Phase 5A1 — Project workspace shell and state hierarchy

Status: complete in PR #157.

A1 was deliberately narrower than all of Phase 5A.

#### Concrete problem to verify

Project directory, workspace header, Map/Reading control, Reference sidebar,
Inspector shell, and save/conflict feedback were introduced across several
functional phases. They must be reviewed together to confirm that primary
location, mode, operation state, and selection context are understandable before
Map nodes or source-record pages are visually changed.

The implementation may change only problems demonstrated by that review; it
must not assume that every difference needs normalization.

#### In scope

- Project directory first-use/loading/error and open/create hierarchy;
- workspace header and Map/Reading mode affordance;
- Reference sidebar and Inspector container headings, boundaries, and empty
  states;
- save-state grouping and concise microcopy for Saved, Unsaved, Saving, Error,
  and Conflict;
- operation/navigation blocked feedback separately from save state, plus existing
  uncertain/reconciling feedback where a shared shell or banner hierarchy is
  touched;
- shell-control hover, current, disabled, and focus-visible states;
- responsive shell behavior at the established global and Project-specific
  boundaries;
- focused tests and a short measured before/after record in the PR description.

#### Out of scope

- Map node and edge restyling;
- attachment card or preview changes;
- Markdown renderer changes;
- source-page restyling;
- Project API, persistence, operation, retry, or conflict semantics;
- changing or adding global or Project-specific viewport thresholds;
- new design tokens unless an existing role cannot express a demonstrated need;
- new workspace modes, panels, or actions.

#### Required acceptance cases

- Project with no items and Project with representative mixed content;
- long Project name and narrow available header width;
- Reference sidebar present/absent according to the existing Map/Reading
  projection, and Inspector empty/selected states;
- Map and Reading current-mode indication;
- save states: saved, unsaved, saving, error, and conflict;
- separate operation/navigation blocked state;
- at least one existing outcome-uncertain and reconciling flow when shared
  feedback or banner hierarchy is changed;
- representative widths `1440px`, `1024px`, `390px`, and `360px`;
- Project boundary widths `559px` / `560px` / `561px`, `859px` / `860px`, and
  `1180px` / `1181px`;
- global `720px` / `721px` and `1200px` / `1201px` when shared global responsive
  rules are touched;
- light and dark themes;
- keyboard focus order, focus-visible treatment, and focus restoration for any
  changed overlay.

#### Exit

The workspace shell now establishes location, mode, complete save state, separate
operation state, and selection context clearly, with no change to Project data
or Map geometry. Independent exact-head review of PR #157 found no remaining
concrete Phase 5A defect that justified A2. Phase 5A is complete; a later shell
correctness bug remains maintenance unless the roadmap explicitly reopens the
slice.

### Phase 5B1 — occurrence identity language and semantic-color boundary

Status: complete in PR #158.

#### Concrete problem

Map and Reading expose raw lowercase `markdown`, `attachment`, and `reference`
implementation kinds while Inspector uses product-facing labels. Map also uses the
interaction accent and the info/warning semantic colors as permanent content-type
rails. This makes an ordinary Reference look cautionary and uses the selection
accent to describe ordinary Markdown, contrary to the frozen color contract.

#### In scope

- define one canonical visible vocabulary: `Project Markdown`, `Project
  attachment`, and `Reference`;
- reuse that vocabulary in Dense Map nodes, document-mode Reading cards, and the
  Compact Inspector;
- replace default kind-colored Map rails with one neutral structural rail;
- retain accent for selected/focused interaction and danger for actual
  error/conflict states;
- add focused model, mounted, and source-contract coverage.

#### Protected boundary

- no node or edge geometry, placement, z-order, detail-band, contextual-zoom, or
  performance-policy change;
- no selection, focus, editing, insertion, deletion, copy/paste, edge, or
  Reading-order behavior change;
- no new content type, Inspector capability, design token, breakpoint, backend
  route, persistence field, or attachment-preview behavior;
- no attempt to make Map, Reading, and Inspector use identical density.

#### Required acceptance cases

- all three occurrence kinds use the canonical label in every changed projection;
- ordinary nodes use no accent/info/warning classification color;
- selected and focus-visible nodes still expose interaction accent;
- pending error/conflict nodes still expose danger treatment;
- light and dark themes continue to consume existing tokens;
- the existing Project Map, Reading, Inspector, owned-content, build, and Map
  performance gates remain green;
- canonical labels and transient status metadata remain legible at the existing
  180px minimum node width through bounded header wrapping; node geometry,
  breakpoints, media queries, and projection rules remain unchanged.

#### Exit

Occurrence kinds read consistently across Map, Reading, and Inspector, and color
communicates interaction or real state rather than ordinary content category.
Phase 5B remains open for separately evidenced node, edge, Reading, Inspector, and
rich-content problems.


### Phase 5B2 — Project edge theme and mutation-state language

Status: complete in PR #159.

#### Concrete problem

Project Map nodes and surfaces already consume application theme tokens, but
React Flow still owns ordinary/selected edge strokes, connection lines, and edge
label colors through its light-mode defaults. The Map does not pass a React Flow
dark color mode, so those defaults do not follow the application theme. Pending
edges also expose `error` and `conflict` classes without danger treatment on
their paths or arrow markers.

#### In scope

- make the Dense Project Map own React Flow edge, selected-edge, connection-line,
  and edge-label colors through existing application tokens;
- keep ordinary paths and arrow markers structurally neutral;
- use accent for selected paths/markers and the active connection line;
- use danger for pending `error` and `conflict` paths/markers;
- qualify the actual mounted closed-arrow SVG markers as well as the stylesheet
  ownership contract.

#### Protected boundary

- no edge identity, endpoint, handle, direction, marker type, label value,
  Bezier-routing, persistence, retry, conflict, deletion, restore, or undo/redo
  change;
- no label-visibility, selection, keyboard, focus, creation, or connection
  behavior change;
- no node projection, placement, geometry, z-order, detail-band,
  contextual-zoom, viewport, or Map-performance-policy change;
- no design-token definition, breakpoint, Reading, Inspector, backend, schema,
  migration, or export change.

#### Required acceptance cases

- ordinary persisted edge path and arrow marker remain neutral in both themes;
- selected persisted edge path and arrow marker consume accent;
- focus-visible edge paths and the active connection line consume accent through
  the same Project-owned React Flow variables;
- edge-label background/text consume `--paper` and `--ink`, not library
  light-mode constants;
- pending `error` and `conflict` paths and arrow markers consume danger,
  while non-failure pending edges remain neutral and saving animation is
  unchanged;
- existing edge direction accessibility labels, keyboard selection, full Verify,
  Project edge, build, bundle, and Map performance gates remain green.

#### Exit

Project edges participate in the same light/dark, interaction-accent, and
semantic-failure language as the rest of the Map without changing the frozen
edge model or interaction behavior. Phase 5B remains open for separately
evidenced node, Reading, Inspector, and rich-content problems.


### Phase 5B3 — Project-owned editor outcome feedback

Status: complete in PR #160.

#### Concrete problem

The Project mutation model distinguishes an outcome-uncertain save from a
deterministic error or conflict: uncertain writes preserve exact mutation identity
and expose an exact retry. The existing editor feedback does not preserve that
distinction. Dense Map Markdown messages always use danger, while Reading Markdown
and Reading/Inspector attachment metadata render uncertain server detail through
the danger-only `error-banner`. Reading Markdown can therefore show the same
operation as warning and determined failure at once.

#### In scope

- project one shared visible/accessibility tone from the existing owned-content
  mutation status;
- use warning and a polite status live region for `uncertain`;
- use danger and an alert live region for `error` and `conflict`;
- keep Markdown summary and server detail in one coherent live region;
- reuse the projection in Dense Map Markdown, document-mode Reading Markdown,
  Reading attachment metadata, and Compact Inspector attachment metadata;
- add focused component, mounted, and source-contract coverage.

#### Protected boundary

- no request payload, expected revision, operation ID, retry identity,
  reconciliation, conflict, cancellation, or navigation-blocking change;
- no editor button, input-enabled state, creation, update, or removal behavior
  change;
- no node geometry, placement, z-order, detail band, contextual zoom, viewport,
  Reading order, or Inspector capability change;
- no attachment byte, preview trust, media, lifecycle, backend, schema, migration,
  export, breakpoint, token-definition, or Map-performance-policy change.

#### Required acceptance cases

- uncertain Markdown detail is warning, not danger, in Map and Reading;
- uncertain attachment metadata detail is warning in Reading and Inspector;
- error and conflict detail remain danger;
- uncertain feedback uses `role="status"`, while error/conflict use
  `role="alert"`;
- Markdown summary and server detail occupy one live region rather than competing
  warning/error announcements;
- existing exact retry, deterministic cancel/reopen, full Verify, owned-content,
  Reading, build, bundle, and Map performance gates remain green.

#### Exit

Project-owned editor feedback communicates whether an operation is unresolved or
determined to have failed without changing the authoritative mutation protocol.
The independent exact-head review found no further B4 content-language defect;
Phase 5B is complete, while the separately evidenced layout gap proceeds in
Phase 5C.

### Phase 5C0 — Project layout and control contract

Status: complete in PR #161.

#### Concrete problem

The current Project workspace is structurally a centered page with a large title
and a second framed three-column surface. Its Map does not own the viewport, side
panels reduce the central canvas continuously, and control priority is encoded
mainly through repeated generic `button`, `primary`, `wide`, and
`compact-button` combinations. This composition is materially different from
the intended Project experience and cannot be resolved through isolated spacing
or color adjustments.

#### In scope

- close Phase 5B after merged PR #160 and record that no B4 is currently required;
- authorize the Project-scoped layout and control rewrite as Phase 5C;
- record the workspace anatomy, desktop non-modal/mobile modal panel contract,
  vertical viewport and scroll ownership, Project control taxonomy, responsive
  strategy, protected behavior, acceptance matrix, and C1–C4 sequence;
- shift the unstarted attachment/media, source-record, and integration phases to
  Phase 5D, Phase 5E, and Phase 5F without changing their scope;
- keep this planning slice documentation-only.

#### Protected boundary

- no production component, stylesheet, test, dependency, backend, schema,
  migration, export, or runtime behavior change in C0;
- C0 does not pre-authorize a single giant implementation PR;
- Project actions, save/retry/conflict semantics, focus behavior, Map geometry,
  Reading order, and responsive behavior remain unchanged until the relevant
  implementation slice is independently reviewed;
- no global button or stylesheet rewrite.

#### Required acceptance cases

- Product roadmap and this execution plan agree that Phase 5B is complete and
  Phase 5C is active;
- C1–C4 each have distinct layout/behavior ownership and can be reviewed
  independently; C2 owns desktop floating panel state/presentation, while C3 owns
  only measured panel sizing, the mobile transition, and Reading/mobile composition;
- desktop Map overlays are explicitly non-modal and preserve Canvas drag,
  selection, Escape, close, and focus-restoration behavior;
- vertical viewport and scroll ownership is explicit for Map, panels, Reading,
  mobile, status content, and short-height desktops;
- the button-heavy control migration is explicit scope, not an incidental CSS
  side effect;
- all shifted future phase labels and immediate-order references remain coherent;
- the planning PR is exact-head reviewed before it becomes Ready.

#### Exit

The repository has one unambiguous authorization for the Project layout rebuild,
including substantial Project button changes, and Phase 5C1 can begin without
reopening functional product scope.

### Phase 5C1 — viewport workspace frame

Status: complete in PR #162.

#### Concrete problem

The desktop Map is still nested in a centered document page and a rounded
fixed-height card. Its `100vh - fixed constant` route formula and the Map
surface's separate `560px` minimum prevent the workspace from shrinking inside
the viewport on short desktop screens.

#### In scope

- replace the desktop Map route's height subtraction with an explicit shrinking
  height chain below global application navigation;
- introduce the compact single-row Project top bar, truncated accessible Project
  identity, unchanged Map/Reading mode control, save/history group, and a thin
  Project-actions overflow adapter;
- move Project lifecycle deletion out of permanent red chrome while preserving the
  existing guarded confirmation and mutation flow;
- bound explanatory route status below the top bar and give Map, References, and
  Inspector independent scroll ownership;
- remove the second rounded outer workspace card and the Map surface's fixed
  minimum height;
- return Reading and mobile to ordinary document scrolling without changing their
  content or mutation behavior.

#### Protected boundary

- no panel state, rail, dock/overlay presentation, Reference drag, Inspector,
  selection-toolbar, or responsive-threshold redesign owned by C2/C3;
- no Project mutation, save, retry, conflict, reconciliation, geometry, selection,
  edge, Reading-order, backend, schema, migration, dependency, or performance
  policy change;
- no site-wide shell or button rewrite; the root viewport class is active only for
  a mounted desktop Project in Map mode and is removed for Reading, mobile, and
  unmount.

#### Required acceptance cases

- mounted desktop Map applies the viewport-owned root class, projects the compact
  title bar, and removes that class on Reading switch and unmount;
- Project lifecycle deletion is absent from permanent chrome, remains reachable
  through Project actions, and the new overflow closes on Escape with focus
  restored;
- ordinary Project top-bar controls retain a `36px` minimum target and the
  Map/Reading mode controls retain `34px`; the compact frame does not reuse
  Dense Process action sizing;
- source contracts prohibit a Project `100vh - fixed constant` workspace and a
  fixed Map minimum height while retaining `min-height: 0`, bounded status
  overflow, and panel-owned scrolling;
- existing `560px`, `860px`, and `1180px` Project thresholds remain unchanged,
  so C1 adds no unmeasured horizontal breakpoint;
- `1366×768`, `1024×768`, and `1024×600` share the same intrinsic top-bar /
  status / remaining-workspace height chain;
- focused Project Map, Reading, lifecycle, full test/build, and Map performance
  gates pass on the exact head before Ready.

#### Exit

Desktop Map owns the viewport below global navigation without page scrolling or
fixed height subtraction; Project chrome is compact enough for C2 to add panel and
button hierarchy without rebuilding the route frame.

### Phase 5C2a — floating panels and context-aware Canvas commands

Status: active in retargeted PR #163, based on
`v2/backend-foundation` after PR #162.

#### Concrete problem

The C1 frame still projects References, Map, and Inspector through historical grid
columns, so closing a panel changes available Canvas area and open panels read as
page borders rather than workspace tools. The existing pointer context menu exposes
only one blank-Canvas attachment action and leaves occurrence, selection, edge,
navigation, and creation commands scattered across unrelated button sites.

#### In scope

- keep the Map surface mounted as the full workspace background with no outer
  Canvas border and project both desktop side regions as floating, independently
  scrollable, non-modal panels;
- add top-bar panel triggers, Reference open/closed state, and Inspector
  closed/temporary/pinned state without persisting UI preference;
- keep the attachment file input mounted when the Reference panel is closed and
  move React Flow navigation controls clear of an open left panel without changing
  viewport coordinates;
- replace the single-purpose context menu with target-aware blank Canvas,
  occurrence, multi-selection, and edge command sets;
- share the existing selection, copy/paste, alignment, z-order, edit, removal, edge,
  and panel commands between keyboard/top-bar/Inspector/context projections;
- provide menu focus entry, Arrow/Home/End navigation, Escape close, outside-click
  close, viewport clamping, disabled states, focus restoration, and isolation from
  document-level Canvas shortcuts while menu focus is active.

#### Protected boundary

- no backdrop, Canvas `inert`, modal focus trap, document scroll lock, or panel
  action that changes persisted geometry merely to reveal a panel;
- no backend, API, schema, migration, dependency, mutation identity, retry,
  conflict, reconciliation, attachment trust, edge model, selection model,
  Reading order, responsive threshold, or performance-policy change;
- no mobile drawer/Reading composition and no final C2b Project-wide button-family
  or quick-toolbar rewrite in this bounded slice.

#### Required acceptance cases

- both floating panels can be open at once while the full-size Canvas, visible
  selection, edge interaction, Reference drag target, and Canvas navigation remain
  operable;
- selecting a node/edge opens temporary Inspector context, clearing selection
  closes it when unpinned, explicit pin survives selection changes, and close/Escape
  restores a surviving trigger;
- the hidden attachment input and exact-position creation paths remain available
  with the Reference panel closed;
- mounted menus cover blank Canvas, single occurrence, multi-selection, and edge,
  including keyboard traversal, Escape focus return, and Ctrl/Cmd Canvas-shortcut
  isolation while a menu item owns focus;
- attachment commands keep the stored file and optional source URL as separate,
  safely projected destinations with labels that match the navigation target;
- the menu is a workspace-level overlay above floating panels; ordinary command
  activation restores Canvas focus when no editor/panel destination claims it;
- panel commands focus the opened panel, and automatic temporary-Inspector closure
  restores a surviving trigger when the prior focus would otherwise be removed;
- creation, selection, alignment, and z-order items project per-command
  availability from the route adapter rather than a coarse geometry flag;
- edge target selection returns an acceptance result; rejected selection does not
  open an edge menu or stale Inspector, while Edit/Delete consume the controller's
  interaction capability including pending Reference insertion/removal;
- selection/copy counts move to Canvas-local transient status, and the existing
  `860–1180px` desktop range uses shorter visible control labels with unchanged
  accessible names and the frozen `36px` targets; long titles, both panels,
  selected/copied state, and save outcomes keep every top-bar action reachable at
  `860px`, `861px`, and `1024px`;
- source contracts prohibit grid-owned Canvas columns, modal desktop panel
  semantics, and a second mutation/controller implementation;
- focused Map, Canvas productivity, Reference placement, owned-content, edge,
  lifecycle, full test/build, bundle, and Map performance gates pass on the exact
  head before Ready.

#### Exit

Desktop Map remains the sole full-area workspace background while optional side
surfaces float above it; every right-click target exposes the relevant existing
commands through one route-owned command adapter. C2b can now concentrate on the
remaining button-family and quick-toolbar visual hierarchy.

## Documentation and review discipline

Phase 5 documentation should remain compact:

- this file owns the sequence and acceptance boundaries;
- `PRODUCT_ROADMAP.md` owns high-level phase status and immediate order;
- `FRONTEND_GUIDELINES.md`, `FRONTEND_AUDIT.md`, and `COLOR_SYSTEM.md` change
  only when a durable rule or measured baseline changes;
- component-specific implementation details belong in the PR and focused tests,
  not in a new plan file for every visual adjustment.

At the completion of each major slice, update this plan and the product roadmap
in the same reviewed PR or in a bounded documentation follow-up. Do not leave a
Draft PR or old execution base presented as the current repository state.

## Phase 5 exit criteria

Phase 5 is complete only when:

- the frozen v1 surfaces use one role-based typography, spacing, surface, control,
  state, and microcopy system;
- Project Map, Reading, Inspector, source records, attachments, directories, and
  overlays remain recognizably different only where their roles require it;
- keyboard/focus behavior and state feedback are complete for the changed
  surfaces;
- desktop/mobile and light/dark behavior pass the representative matrices;
- Process-grid density and Project Map performance remain qualified;
- no accidental second palette, default-state interaction accent, or misleading
  lifecycle action remains;
- all exact-head CI and affected permanent gates are green;
- the measured frontend baseline and product roadmap are updated for Phase 6.

Phase 6 release hardening follows. Optional trusted derivative generation,
transport convergence, Docker distribution, semantic/LLM features, real-time
collaboration, and other deferred capabilities remain independent projects.

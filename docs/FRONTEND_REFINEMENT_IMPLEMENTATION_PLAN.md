# Phase 5 frontend refinement implementation plan

Status: active execution plan; Phase 5 is authorized after the v1 feature freeze
and the merge of PR #155

Last reviewed: 2026-08-25

Execution base: `v2/backend-foundation` at
`a63ba0903282575879b27868cb8410a2cf26d138`

This document turns the whole-product Phase 5 goal in
[Product goal and roadmap](./PRODUCT_ROADMAP.md) into bounded, independently
reviewable frontend slices. It does not authorize a visual rewrite or reopen the
v1 interaction feature set.

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
- do not perform mass selector moves or stylesheet consolidation as a Phase 5
  deliverable.

### Geometry and performance boundary

- preserve the global `1200px` / `720px` viewport-tier baseline for ordinary
  application surfaces;
- preserve the Project workspace's existing `min-width: 860px` functional
  desktop-Map/Reading boundary and its local `1180px` / `560px` layout
  thresholds during Phase 5A; these are scoped Project contracts rather than
  additional global viewport tiers;
- change any global or Project-specific threshold only through a separately
  measured responsive change with adjacent-boundary verification;
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
  / `1201px`; Project shell work also uses `559px` / `560px` / `561px`, `859px`
  / `860px`, and `1180px` / `1181px`.

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

A numbered sub-slice does not automatically complete its parent slice. Before
work moves from Phase 5A to Phase 5B, the active plan and roadmap must either
mark Phase 5A complete after A1 proves that no additional shell slice is needed,
or schedule and complete any required A2 follow-up.

### Phase 5A — Project workspace shell and state hierarchy

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

### Phase 5C — attachment and media surfaces

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

### Phase 5D — source-record and directory coherence

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

### Phase 5E — cross-product integration review

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

## First authorized implementation slice

After this planning PR is reviewed and merged, the next code PR is:

### Phase 5A1 — Project workspace shell and state hierarchy

The first code slice is deliberately narrower than all of Phase 5A.

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

The workspace shell establishes location, mode, complete save state, separate
operation state, and selection context clearly, with no change to Project data
or Map geometry. After A1, Phase 5A may be marked complete only if the review
shows that no additional Phase 5A implementation slice is required. Otherwise,
schedule and complete A2 first. Only after Phase 5A is complete should Phase 5B
begin changing the presentation of Project content itself.

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

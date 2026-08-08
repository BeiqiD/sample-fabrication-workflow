# Product goal and roadmap

Status: canonical product direction and active implementation roadmap

Last reviewed: 2026-08-09 after the reference/search foundation through PR #129
and the product-position correction in Draft PR #130

This document is the single high-level roadmap for Sample Fabrication Workflow.
Detailed identity, lifecycle, search, Project, export, and deployment contracts
remain in their focused documents, but their phase labels and priorities must
not contradict this roadmap.

## North star

Sample Fabrication Workflow should become a **sample-centered source of truth
with a Project-centered research workspace** for small research groups.

The finished product has two deliberately different layers:

1. **Experimental source record** — Samples, Recipes, Runs, Steps, Comments,
   attachments, metrology records, structures, and timelines record what was
   planned and what actually happened.
2. **Project workspace** — a Project combines read-only references to those
   records with Project-owned narrative content so a researcher can organize,
   explain, connect, and revisit a body of work without copying or rewriting the
   source record.

The source layer answers:

> What happened to this physical sample, and what is the durable evidence?

The Project layer answers:

> What belongs to this research question, how do the pieces relate, and how
> should another researcher read or inspect them?

Neither layer replaces the other.

## Intended final interaction

The normal long-term entry point for research organization is a Project, not a
standalone Search workspace.

```text
Project
├─ Text        deliberate narrative and reading order
├─ Inspector   detail, source hierarchy, child objects, backlinks, actions
├─ Map         spatial organization and Project-local relationships
└─ Add reference / Search
      └─ find any eligible Sample, Run, Step, Comment, attachment,
         execution image, metrology reference, Recipe revision,
         Project, or Project-owned content
```

A user should be able to remain in one Project, open discovery, find any
referenceable object, select it, and add it without leaving the Project context.
Search returns intent only. The server re-resolves and registers the target and
creates the owning Project item before the UI reports success.

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
- a canvas whose serialized UI state is the database model;
- an autonomous LLM-operated experimental system.

Project-owned narrative, images, and files are allowed. Experimental source
records remain editable only in their own source interfaces. Project previews,
Inspector, Search, and future insight features remain read-only with respect to
those sources.

## Durable architectural invariants

All future phases preserve these rules:

1. **Source data remains authoritative.** Project stores inclusions,
   Project-owned content, placements, and local relationships; it does not copy
   external source records into editable snapshots.
2. **Identity layers remain separate.** Source/content identity,
   `reference_targets`, Project-item identity, and Text/Map placement identity
   are not collapsed into one row or one browser node.
3. **Search is a shared capability.** Global browsing, Project discovery,
   Sample directories, and Recipe pickers may use different eligibility
   profiles but should not grow unrelated matching/ranking engines.
4. **Search indexes are derived.** A future FTS5 or other index can be rebuilt
   from authoritative rows and does not own lifecycle or identity.
5. **External references are read-only.** `Open source` navigates to source
   authority; it does not delegate mutation rights to Project.
6. **Delete remains recoverable by default.** Permanent deletion stays disabled
   until Project backlinks, privileged authorization, tombstones, and final
   concurrency checks exist.
7. **Export evolves with the model.** The first Project schema bumps the complete
   export version and includes Project rows and reachable Project-owned bytes.
8. **Platform contracts stay portable.** Cloudflare is the current deployment,
   not the domain model. New code must avoid unnecessary D1, R2, Access, Queue,
   or Worker coupling outside adapters and runtime boundaries.
9. **LLM capability is read-only and explicit.** A later insight feature may
   summarize or connect content selected by the user, but it does not mutate
   source records, silently add Project items, or become required for core use.

## Current position

### Completed foundation

The following prerequisites are complete on `v2/backend-foundation`:

- stable source and occurrence identities;
- recoverable source deletion and restoration;
- canonical Comment and attachment-occurrence semantics;
- shared blob reachability, GC ledger, export integrity, and physical-delete
  protection;
- sparse immutable reference registry;
- bounded batch resolver over nine existing target types;
- lifecycle-aware canonical Reference URLs;
- exact Step, Comment, attachment, execution-image, and metrology source focus;
- deterministic read-only reference search with portable candidate backend,
  stable ranking, lifecycle filtering, and real Worker/D1 verification.

These foundation phases are closed. They should receive correctness fixes but
must not continue expanding into independent product areas.

### Active PR

Draft PR #130 provides the reusable `ReferenceSearchSurface`, stable
`ReferenceTarget` selection contract, request lifecycle, filters, result
presentation, and a temporary route wrapper.

Its durable output is the Project-embeddable discovery surface. The standalone
page and navigation item are temporary scaffolding.

PR #130 is the final planned foundation/UI-enabling PR before Project data and
Project-owned behavior begin.

## Active implementation roadmap

### Phase 2C2 — reusable Project discovery surface

**Goal:** close the search-to-Project UI boundary without creating Project data.

**Scope:**

- reusable browse/select search surface;
- stable target selection output;
- deterministic server-order result presentation;
- filters, retry, cancellation, empty/error/truncation states;
- temporary `/search` integration harness;
- no registration, Project write, or `Add to project` success state.

**Exit:** Draft PR #130 is reviewed and merged. Work then moves directly to
Project, not to additional standalone Search features.

### Phase 3A — Project core backend and authoritative insertion

**Goal:** establish the identity and write boundary that the previous phases
were preparing for.

**Recommended PR scope:**

- `projects` with stable identity and recoverable deletion;
- the full `project_contents` / `project_items` target model needed to avoid a
  later incompatible table redesign, even if the first route primarily inserts
  external references;
- one authoritative server operation that:
  1. validates the Project and caller;
  2. re-resolves the selected stable target;
  3. registers or refreshes `reference_targets` idempotently;
  4. creates the Project item;
  5. returns the canonical inserted item;
- remove-from-Project behavior that removes only local inclusion data;
- Project backlinks from `project_items.reference_target_id`;
- duplicate-inclusion policy and concurrency tests;
- Project list/detail read APIs with bounded resolver enrichment;
- complete-export schema-version bump and Project table snapshots;
- migration, host SQLite, D1/workerd, route, and export gates.

**Not yet:** rich Text editing, Map, edges, FTS5, or permanent delete.

**Exit:** the backend can create a Project and safely add/remove an external
reference with authoritative backlinks and complete export coverage.

### Phase 3B — Project workspace shell and embedded discovery

**Goal:** deliver the first useful Project vertical slice.

**Recommended PR scope:**

- Project list, create, rename, trash, restore, and detail routes;
- replace the temporary Search primary-navigation item with Project;
- mount `ReferenceSearchSurface` inside the current Project through an
  `Add reference` panel, dialog, or command surface;
- pending, success, duplicate, stale-target, and failure states owned by the
  Project container;
- reference list/cards with exact source and canonical Reference actions;
- remove from Project without touching the source;
- refresh and Back/Forward behavior for Project selection and discovery;
- retire, redirect, or hide `/search` according to the chosen transition path.

**Exit:** a user can create a Project, stay inside it, find any supported source
object, add it authoritatively, reopen the Project, and remove the local
inclusion without changing source data.

This milestone is the **Project reference-workspace alpha**.

### Phase 3C — Project Text and Project-owned content

**Goal:** make Project useful for research narrative rather than only as a list
of references.

**Recommended PR sequence:**

1. Project-owned text/content identity and editing;
2. Text placements and insertion-friendly ordering;
3. read-only reference blocks in the same Text flow;
4. Project-owned image/file attachment occurrences using existing hashing,
   storage, retention, GC, and export boundaries;
5. continuous human-readable export with relative asset paths.

Text order is independent from Map geometry and Project edges. External source
content remains read-only. Autosave or explicit-save behavior must be chosen and
tested before implementation rather than inferred from component state.

**Exit:** a Project can combine editable narrative with ordered read-only source
references and preserve that material through complete export.

This milestone is the **Project MVP** and should be usable before Map exists.

### Phase 3D — Inspector, Project deep links, and enriched read model

**Goal:** make references understandable and navigable without making cards or
Text blocks excessively large.

**Recommended scope:**

- Project and Project-content canonical destinations;
- Inspector selection and exact Project location focus;
- complete source hierarchy and lifecycle detail;
- directly related child summaries where appropriate;
- add-child-as-reference action through the same authoritative insertion route;
- Project backlink and location counts;
- source edited/deleted/archived indications;
- remove-current-item action with local impact preview.

**Exit:** Project references are inspectable, deep-linkable, and backlink-aware;
no source mutation control appears in Inspector.

### Phase 4 — Map

**Goal:** add the complementary spatial view only after Project item and Text
identity are stable.

**Recommended PR sequence:**

1. Map route/tab, dynamic `@xyflow/react` loading, and compact node cards;
2. independent `project_map_placements` persistence with bounded move/resize
   writes;
3. Project-local edges between Project items and optional labels;
4. Inspector integration and exact item selection;
5. optional initial/local layout after manual placement semantics are stable.

React Flow is an interaction layer, not the persistence model. Map does not
create a second item identity, auto-expand source hierarchies, or define the
Text reading order.

**Exit:** the same Project items can be organized independently in Text and Map,
with persistent placements and local edges.

This milestone is the **Project v1 product shape**.

## Parallel platform and quality tracks

These tracks run alongside the product phases but do not replace them.

### Portability and Docker distribution

Portability is a continuous constraint and a later release milestone, not a
reason to delay Project indefinitely.

From Phase 3 onward, each backend PR must identify:

- domain logic that is runtime-neutral;
- D1-specific query/runtime adapters;
- R2 or managed-storage adapters;
- Access/authentication adapters;
- scheduled/background operation boundaries;
- export and configuration assumptions.

After Project Text stabilizes, perform a dedicated portability audit and build a
reference Docker deployment using ordinary SQLite and explicit local/object
storage adapters. This work may run in parallel with Map because it should not
change Project semantics.

A Docker deployment is successful only when the same migrations, identity,
search, lifecycle, export, and Project contracts pass against the self-hosted
runtime. It is not a separate product fork.

### Search performance

Do not add FTS5 merely because source scanning is theoretically less scalable.
Add it when representative Project discovery datasets or measured latency show
a real need.

The preferred first optimization is a rebuildable SQLite FTS5 candidate backend
that preserves the existing public ranking, internal specificity, lifecycle,
resolver, and stable-target contracts. The same path must work in D1 and in a
compatible self-hosted SQLite build.

### Permanent deletion

Permanent deletion remains disabled through the Project MVP. Once authoritative
Project backlinks exist, a separate safety review may add conflict reporting,
privileged authorization, final concurrency checks, and tombstone creation.
This is not required for ordinary Project use and must never be bundled casually
with Project insertion.

### Quality and operations

Every schema phase must preserve:

- fresh ordered migrations in host SQLite and D1/workerd;
- focused contract tests and complete test/build gates;
- complete export integrity;
- no physical locator exposure;
- no unauthorized cross-layer mutation;
- isolated remote deployment requirements.

## Later capabilities

Only after Project Text, Inspector, and the deterministic read model are stable
should the roadmap consider:

- revision pinning to real source history;
- semantic or hybrid search;
- read-only LLM insight over an explicit user-selected Project scope;
- suggested connections that require user confirmation;
- advanced consistency dashboards;
- optional layout assistance;
- multi-user authorization beyond the current small-group deployment model.

LLM insight is not an experimental-record editor, not an autonomous agent, and
not a hidden data-analysis subsystem. Any saved output becomes ordinary
Project-owned content only through an explicit user action.

## Release milestones

| Milestone | Required capabilities |
|---|---|
| Foundation complete | Source/blob lifecycle, registry, resolver, deep links, exact focus, deterministic search |
| Project reference-workspace alpha | Project identity, authoritative reference insertion, backlinks, embedded discovery, reopen/remove behavior |
| Project MVP | Alpha plus Project-owned Text/content, ordered references, attachments, complete export |
| Project v1 | MVP plus Inspector, exact Project deep links, Map placements and edges |
| Portable release | Project contracts also pass in a documented Docker/self-hosted deployment |
| Insight experiments | Optional read-only semantic/LLM features after the deterministic product is stable |

## Immediate next PR order

1. Finish review of Draft PR #130 as a reusable Project discovery surface.
2. Implement **Project core backend and authoritative reference insertion**.
3. Add the **Project workspace shell** and embed the existing discovery surface.
4. Add **Project Text and Project-owned content**.
5. Add **Inspector and enriched backlink/deep-link behavior**.
6. Add **Map placements**, then **Project-local edges**.
7. Run the dedicated **Docker portability implementation** after the Project
   data/Text model stabilizes, potentially in parallel with Map.
8. Introduce FTS5, semantic search, or LLM insight only in response to measured
   needs and after the core Project workflow is complete.

## Work that should not happen next

The next phase should not be:

- more standalone Search-page product polish;
- migrating every existing search box before Project proves the shared profile
  model;
- FTS5 synchronization before measured scale requires it;
- Map before Project item and Text identity are implemented;
- permanent-delete endpoints before backlinks and tombstone review;
- a Docker-specific fork that duplicates domain logic;
- LLM features before the deterministic Project workflow is usable.

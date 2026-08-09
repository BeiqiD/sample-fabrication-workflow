# Project reference search surface implementation plan

Status: implemented in PR #130; Phase 2C2 complete

Last reviewed: 2026-08-09 after completing the reusable Project discovery
surface and confirming that Search is a Project capability, not a permanent
standalone product area

This document defines the browser surface that consumes the deterministic
reference-search domain service completed in Phase 2C1. The service, ranking,
lifecycle, portability, and resolver contracts remain defined in
[deterministic reference search](./REFERENCE_SEARCH_IMPLEMENTATION_PLAN.md).
Project ownership and the authoritative insertion boundary remain defined in
[Project design foundation](./PROJECT_DESIGN_FOUNDATION.md).

## Product correction

Search is not intended to remain a separate top-level workspace beside Project.
Its long-term product role is:

> let a user working inside a Project quickly find any referenceable source
> object and choose it for the current Project context.

The durable Phase 2C2 deliverable is therefore the reusable search and selection
surface, its deterministic result presentation, and its controlled state/API
contract.

The current `/search` route and Search navigation item are temporary integration
scaffolding while Project identity and the Project workspace do not yet exist.
They provide a complete place to exercise URL state, history, filters,
responsive behavior, and all nine result types before Project writes are added.
They are not a commitment to preserve a standalone global Search page.

When the first Project workspace lands:

- the primary navigation destination becomes Project rather than Search;
- the search surface is mounted inside the Project page, panel, dialog, or
  Inspector flow;
- `/search` may redirect to the Project discovery surface, remain only as a
  development/reference browser, or be removed after migration;
- the search domain service and `ReferenceSearchSurface` remain unchanged;
- Project insertion remains an authoritative server write, not a browser-side
  consequence of searching or selecting.

## Phase boundary

### Durable Phase 2C2 output

Phase 2C2 delivered:

- one controlled, reusable `ReferenceSearchSurface` component;
- browse and single-selection result modes;
- stable `ReferenceTarget` selection output for the future Project consumer;
- type, Sample, and inclusive UTC-date filters;
- deterministic result presentation from the Phase 2C1 response;
- stale-request cancellation, explicit retry, and clear-to-idle behavior;
- explicit loading, empty, error, and truncation states;
- keyboard-accessible controls and responsive desktop/mobile layouts;
- pure state helpers that can be owned by either a route or a Project panel;
- focused state, mounted-component, history, and build verification.

### Temporary integration scaffolding

PR #130 also implemented:

- a discoverable `/search` reference-browser route;
- a temporary Search navigation item;
- URL-owned committed state for testing refresh, sharing, Back, and Forward;
- a browse-mode page wrapper around the reusable component.

This scaffolding must remain thin. Business logic must not migrate into
`SearchPage`, and Project must not later depend on the existence of `/search`.

### Explicit exclusions

Phase 2C2 did not add:

- `projects`, `project_items`, backlinks, Text, Inspector, or Map;
- target registration or any search-triggered D1 write;
- an `Add to project` action or wording that implies insertion occurred;
- a public registry-write endpoint;
- replacement of the existing Sample, Processing, or Recipe pickers;
- fuzzy, semantic, embedding, or model-ranked search;
- pagination, total counts, infinite scrolling, or a search-history table;
- FTS5 schema, index maintenance, Queues, Workflows, or another Worker;
- remote D1 migration or Worker deployment.

PR #130 targeted `v2/backend-foundation`, completed the Phase 2C2 contract, and
performed no remote D1 migration or Worker deployment.

## Intended Project interaction

The first Project workspace should expose search as a direct Project action,
for example through an `Add reference` button, command panel, or persistent
search field. The exact visual container remains a Phase 3 UI decision, but the
behavioral contract is fixed:

1. the user stays in the current Project context;
2. opening discovery does not navigate away from unsaved Project work;
3. the user searches all eligible source types through the shared service;
4. result cards preserve source hierarchy and exact destinations;
5. choosing a result returns its stable `ReferenceTarget`;
6. the Project insertion route re-resolves and registers that target;
7. only after the server creates `project_items.reference_target_id` may the UI
   report that the reference was added;
8. closing discovery returns to the same Project location and selection.

A search result does not silently include its Sample, Run, or Step ancestors as
separate Project items. Those remain source context. A Comment result selects
that Comment; an attachment result selects that occurrence.

The initial component supports single selection. Phase 3 may allow repeated
selection without closing the panel, or add an explicit multi-select wrapper,
but it must continue to pass exact stable targets to one authoritative server
operation rather than invent a browser-owned inclusion model.

## Temporary reference-browser behavior

The temporary `/search` page exercises the same nine current stable target
types:

```text
sample
run
run_step
comment
comment_occurrence
comment_attachment
execution_image
metrology_reference
recipe_revision
```

It is read-only. A result can open its canonical Reference page and, when the
resolver provides one, its exact source interface. The result card itself is not
a navigation target; explicit actions preserve keyboard clarity and avoid a
gesture conflict with selection mode.

An empty query shows guidance instead of issuing a request. Search uses an
explicit submit action rather than requesting on every keystroke because the
portable Phase 2C1 backend still performs source-table scans.

## Reusable component contract

`ReferenceSearchSurface` is controlled by a committed search value and exposes
two modes:

- `browse`: show `Open source` and `Reference details` actions;
- `select`: additionally show a single-selection action and return exactly the
  result's stable `ReferenceTarget` through `onSelect`.

Selection does not register the target, create a Project item, mutate the source,
or imply persistence. The component must never display `Added`, `Saved`, or
`Add to project` by itself.

The temporary page uses `browse` mode. The future Project discovery container
uses `select` mode and owns any pending/selected/inserted presentation around it.

## State ownership

The component separates committed state from form draft state.

- the host owns committed `ReferenceSearchUiState`;
- `ReferenceSearchSurface` receives that state through `value`;
- the surface keeps a local draft while the user edits query and filters;
- submit validates and emits one complete next state through `onChange`;
- only committed state triggers the API request;
- submitting unchanged committed state explicitly retries that request without
  mutating host state or browser history;
- Clear commits an empty query only when committed state actually changes;
  clearing an uncommitted draft remains local and history-neutral;
- host-state changes replace the draft, abort stale work, and restore the
  corresponding result set.

For the temporary route, `SearchPage` owns committed state through
`URLSearchParams`. A Project host may instead keep search state in Project URL
parameters, a route-owned panel state, or a restorable workspace state. It must
not fork the normalization, validation, request, or result contracts.

## Temporary URL contract

The temporary route uses:

```text
q=<trimmed query>
type=<target type>       repeated; omitted means all nine types
sample=<exact Sample stable ID>
from=YYYY-MM-DD          browser date; request uses 00:00:00.000Z
to=YYYY-MM-DD            browser date; request uses 23:59:59.999Z
```

Rules:

- parameter order is deterministic;
- repeated types are deduplicated and emitted in closed registry order;
- selecting all types removes every `type` parameter;
- an empty query removes `q` and produces the idle state;
- empty optional filters are omitted;
- invalid external type values are ignored;
- an external URL with no valid type leaves the all-type profile;
- browser dates are converted to complete UTC-day request bounds;
- programmatic API clients may continue using the wider RFC 3339 contract from
  Phase 2C1;
- `from > to`, an empty type selection, and a query beyond the shared 200-code-
  point bound are rejected before committed-state mutation;
- explicit changed-state submit creates a browser history entry so Back/Forward
  restores the previous committed search;
- unchanged retry and draft-only Clear do not create duplicate history entries.

These parameter names are not required to become permanent top-level product
URLs. A Project route may namespace or translate them while reusing the pure
state helpers.

## Request lifecycle

For each committed non-empty query:

1. normalize and validate the controlled UI state;
2. convert browser dates to complete UTC-day RFC 3339 bounds;
3. start one `POST /api/references/search` request;
4. abort the preceding request when committed state changes, the same state is
   explicitly retried, the query is cleared, or the component unmounts;
5. ignore `AbortError`;
6. render the newest successful response only;
7. preserve committed values when the request fails so the user can retry.

Visible states are:

- `idle`;
- `loading`;
- `success`;
- `empty`;
- `error`;
- `truncated`.

No client-side re-ranking, result filtering, or hidden fallback search is
allowed. The component renders the server order exactly.

## Filter behavior

### Target types

All nine types are selected by default. Checkboxes express a closed subset. The
final selected type cannot be removed, preventing the API's empty-array/all-types
ambiguity.

A future Project host may apply a named eligibility profile before rendering the
component. It must not hide eligibility rules in result-card code.

### Sample scope

The optional Sample field accepts one exact stable Sample ID. Recipe revisions
and metrology references naturally return no matches under a Sample filter. The
component does not reinterpret Sample code or title as an ID.

### Time range

The browser uses date inputs. The request adapter sends `from` at
`00:00:00.000Z` and `to` at `23:59:59.999Z`, so both selected UTC dates are fully
inclusive. Server validation remains authoritative.

### Reset

`Reset filters` restores all target types and clears Sample/from/to while keeping
the draft query. Clearing the query returns the host to `idle` when committed,
or clears only the local draft when the committed query is already empty.

## Result presentation

Each result card renders only resolver-safe fields:

- public target-type label;
- public match-tier label;
- `matchedAt` when available;
- source title, subtitle, and bounded excerpt when available;
- stable target ID;
- the first ordered source context as a breadcrumb;
- an additional-context count when more than one context exists;
- `Open source` only when `openSourceUrl` exists;
- `Reference details` through the canonical `referenceUrl`;
- `Select` or `Selected` only in selection mode.

Physical storage locators, provider paths, object keys, credentials, and
temporary URLs never enter the component contract.

Match-tier labels remain explanatory rather than score-like:

```text
exact_id         Exact ID
exact_primary    Exact title or filename
prefix_primary   Title or filename prefix
content          Content match
metadata         Context match
```

The private Phase 2C1 match specificity is not present in the response and is
not inferred in the browser.

## Accessibility and interaction

- Search uses a semantic `<form role="search">`.
- Every input has a visible or programmatic label.
- The filter trigger exposes `aria-expanded` and `aria-controls`.
- Type choices use native checkboxes and a fieldset legend.
- Loading and result counts use a polite live region.
- Error and validation messages remain associated with the form.
- Result actions are real links or buttons, not clickable containers.
- The selected result exposes `aria-pressed` in selection mode.
- Focus is not moved after results load.
- Page-load autofocus follows the existing device-aware helper.
- A future Project panel must return focus to its opening control when closed.

## Responsive layout

The component follows the repository's wide, medium, and narrow layout tiers.

- Wide: query and submit share one row; filters use a compact grid; result
  metadata and actions share the card header.
- Medium: type filters reduce columns and card actions may wrap.
- Narrow: query and submit stack, filter fields become one column, actions use
  the available width, and long IDs/context labels wrap.

The temporary fifth navigation destination would otherwise exceed the 320 px
minimum layout. While the placeholder exists, the theme toggle becomes an
accessible icon-only 40 px control at the narrow breakpoint. When Search is
replaced by Project, navigation width must be re-evaluated rather than preserving
this workaround by assumption.

## File and component plan

### Added files

```text
docs/REFERENCE_SEARCH_UI_IMPLEMENTATION_PLAN.md
src/lib/reference-search-ui.ts
src/lib/reference-search-ui.test.ts
src/components/ReferenceSearchSurface.tsx
src/pages/SearchPage.tsx
src/reference-search.css
src/reference-search-surface.mount.test.tsx
src/reference-search-page.mount.test.tsx
src/reference-search-page.test.ts
```

### Updated files

```text
src/lib/reference-api.ts
src/App.tsx
src/components/NavigationIcon.tsx
package.json
README.md
```

`ReferenceSearchSurface` owns request and presentation behavior, not routing or
Project persistence. `SearchPage` is a temporary URL adapter. Pure state and
validation helpers remain outside React so a Project panel can reuse them.

## Verification

Pure tests cover:

- parsing omitted/default filters;
- type deduplication and closed ordering;
- invalid external type handling;
- canonical temporary URL serialization;
- query trimming and shared length bounds;
- empty-type and reversed-date validation;
- complete UTC-day API bounds;
- normalized committed-state equality for explicit retry;
- stable target equality.

Mounted surface tests cover:

- no request before a committed query exists;
- exact POST payload;
- stale request cancellation;
- same-state retry after failure;
- committed clear-to-idle behavior;
- server result order preservation;
- source/reference actions;
- truncation and no-result states;
- selection returning the exact stable `ReferenceTarget`;
- no Project insertion wording or mutation behavior.

Mounted temporary-page tests cover:

- initial state restored from the URL;
- explicit changed-state submission pushing a history entry;
- browser Back restoring URL, input draft, request, and results;
- unchanged-query retry remaining history-neutral;
- draft-only Clear remaining history-neutral.

Static tests cover:

- lazy temporary `/search` route registration;
- placeholder navigation entry and Search icon;
- thin URL-owned page composition;
- narrow theme-toggle compaction while the placeholder exists.

The new tests join `test:reference-foundation`. Normal `npm test`, real
Worker/D1 search smoke, TypeScript compilation, and production build remain
required. No migration is added.

## Completion criteria

Phase 2C2 is complete because:

1. the reusable search surface is independent from `SearchPage` routing;
2. the component can browse and emit one exact stable `ReferenceTarget`;
3. committed state can be supplied by a route or future Project host;
4. empty queries issue no request;
5. stale requests cannot replace newer results;
6. unchanged state can be explicitly retried without host/history mutation;
7. committed Clear reaches idle while draft-only Clear remains local;
8. date filters cover both complete selected UTC dates;
9. result order exactly matches the service response;
10. all nine current target types can be filtered;
11. canonical Reference and exact source destinations are explicit actions;
12. selection performs no write and reports no false insertion success;
13. no registry row, source row, Project placeholder, or physical locator is
    created or exposed;
14. the temporary browser is refresh-safe and removable without changing the
    search component or service;
15. desktop and 320 px layouts remain usable;
16. focused reference tests, complete tests, and production build pass;
17. no remote D1 migration or Worker deployment was run.

## Phase 3 transition

Phase 3 creates Project identity, the Project workspace, and the authoritative
insertion path. It should:

- replace the temporary Search navigation destination with Project;
- mount `ReferenceSearchSurface` within the current Project context;
- preserve Project location while discovery is open;
- re-resolve and register selected targets server-side;
- create `project_items.reference_target_id` under one authoritative owner;
- report insertion success only after that write completes;
- decide whether `/search` redirects, remains a developer browser, or is removed.

Phase 3 must not invent a second search service or duplicate the result model.

# Global reference search UI implementation plan

Status: implementation contract for Phase 2C2; active Draft PR #130

Last reviewed: 2026-08-09 after PR #129 was squash-merged into
`v2/backend-foundation` as `6877fefbd41f38339d0af26c6cbe32258ba09710`

This document defines the browser surface that consumes the deterministic
reference-search domain service completed in Phase 2C1. The service, ranking,
lifecycle, portability, and resolver contracts remain defined in
[deterministic reference search](./REFERENCE_SEARCH_IMPLEMENTATION_PLAN.md).
Product ownership and the later Project insertion boundary remain defined in
[Project design foundation](./PROJECT_DESIGN_FOUNDATION.md).

## Phase boundary

Phase 2C2 adds:

- one discoverable global Search page at `/search`;
- URL-owned committed search state;
- one controlled, reusable `ReferenceSearchSurface` component;
- browse and single-selection result modes;
- type, Sample, and inclusive UTC-date filters;
- deterministic result presentation from the Phase 2C1 response;
- stale-request cancellation, explicit retry, and clear-to-idle behavior;
- explicit loading/empty/error/truncation states;
- keyboard-accessible controls and responsive desktop/mobile layouts;
- focused URL-state, mounted-component, routing, history, and build verification.

Phase 2C2 does not add:

- `projects`, `project_items`, backlinks, Text, Inspector, or Map;
- target registration or any search-triggered D1 write;
- an `Add to project` action or wording that implies insertion occurred;
- a public registry-write endpoint;
- replacement of the existing Sample, Processing, or Recipe pickers;
- fuzzy, semantic, embedding, or model-ranked search;
- pagination, total counts, infinite scrolling, or a search-history table;
- FTS5 schema, index maintenance, Queues, Workflows, or another Worker;
- remote D1 migration or Worker deployment.

The PR targets `v2/backend-foundation`. It stays Draft until the complete
repository suite and generated merge result pass.

## Product behavior

### Global Search page

The top navigation gains a Search destination. `/search` is a research discovery
surface over the nine current stable reference target types:

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

The page is read-only. A result can open its exact canonical Reference page and,
when the resolver provides one, its exact source interface. The result card
itself is not a navigation target; explicit actions avoid conflicts with later
selection behavior and make keyboard intent clear.

An empty query shows guidance instead of issuing a request. Search uses an
explicit submit action rather than requesting on every keystroke because the
portable Phase 2C1 backend still performs source-table scans.

### Reusable selection surface

`ReferenceSearchSurface` is controlled by a committed search value and exposes
one of two modes:

- `browse`: show `Open source` and `Reference details` actions;
- `select`: additionally show a single-selection action and return exactly the
  result's stable `ReferenceTarget` through `onSelect`.

Selection does not register the target, create a Project item, or mutate the
source. The component must never display `Added`, `Saved`, or `Add to project`.
A later Phase 3 Project picker supplies local controlled state and sends the
selected `ReferenceTarget` to the authoritative server insertion route.

The global Search page uses `browse` mode. The `select` contract is implemented
and mounted-tested now so Project work does not need a second result model.

## State ownership

The UI separates committed state from form draft state.

- `SearchPage` owns committed state through `URLSearchParams`.
- `ReferenceSearchSurface` receives that state as `value`.
- The surface keeps a local draft while the user edits query and filters.
- Submit validates and emits one complete next state through `onChange`.
- Only committed state triggers the API request.
- Submitting the unchanged committed state explicitly retries that request.
- Clear commits an empty query, aborts current work, and returns the controlled
  surface to `idle` while preserving the committed filter profile.
- Back/Forward changes the URL, replaces the controlled value, resets the draft,
  aborts stale work, and restores the corresponding result set.

This prevents partially edited filters from changing the visible results and
prevents one request per input event.

## URL contract

The canonical browser parameters are:

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
- an empty query removes `q` and produces the idle page state;
- empty optional filters are omitted;
- invalid external type values are ignored;
- an external URL with no valid type leaves the default all-type profile;
- the browser surface commits date-only values, then the request adapter converts
  `from` to the UTC start of that date and `to` to the UTC end of that date;
- programmatic API clients may continue using the wider RFC 3339 contract from
  Phase 2C1;
- `from > to`, an empty type selection, and a query beyond the shared 200-code-
  point bound are rejected before URL mutation;
- submitting creates a browser history entry; Back/Forward therefore restores
  the previous committed search rather than only changing local component state.

The URL stores the exact Sample stable ID because that is the domain filter.
The first Phase 2C2 slice labels this advanced field explicitly. A later
search-backed Sample chooser may improve input ergonomics without changing the
URL, API, or selection contract.

## Request lifecycle

For each committed non-empty query:

1. normalize and validate the controlled UI state;
2. convert browser dates to complete UTC-day RFC 3339 bounds;
3. start one `POST /api/references/search` request;
4. abort the preceding request when committed state changes, the same state is
   explicitly retried, the query is cleared, or the component unmounts;
5. ignore `AbortError`;
6. render the newest successful response only;
7. preserve the committed form values when the request fails so the user can
   retry without re-entering filters.

The visible states are:

- `idle`: no committed query;
- `loading`: current request in progress;
- `success`: one or more results;
- `empty`: successful request with no results;
- `error`: current request failed;
- `truncated`: success or empty response reports that a configured bound may
  have omitted further matches.

No client-side re-ranking, result filtering, or hidden fallback search is
allowed. The page renders the server order exactly.

## Filter behavior

### Target types

All nine types are selected by default. The filter panel uses checkboxes so a
user can express any closed subset. The final selected type cannot be removed;
this prevents a misleading state where the API would interpret an empty array as
all types.

### Sample scope

The optional Sample field accepts one exact stable Sample ID. Recipe revisions
and metrology references naturally return no matches under a Sample filter, as
defined by Phase 2C1. The UI does not reinterpret Sample code or title as an ID.

### Time range

The browser uses date inputs and stores date-only values in the URL. The request
adapter sends `from` at 00:00:00.000Z and `to` at 23:59:59.999Z so both selected
UTC dates are fully inclusive. The form checks ordering before committing.
Server validation remains authoritative.

### Reset

`Reset filters` restores all target types and clears Sample/from/to while keeping
the draft query. Clearing the complete search is done by submitting an empty
query or using the query clear control; it returns the page to `idle`.

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
- Page-load autofocus follows the existing device-aware autofocus helper.

## Responsive layout

The implementation keeps the repository's existing wide, medium, and narrow
layout philosophy.

- Wide: query and submit action share one row; filters use a compact grid;
  result metadata and actions share the card header.
- Medium: type filters reduce columns and card actions may wrap.
- Narrow: query and submit stack, filter fields become one column, actions use
  full available width, and long IDs/context labels wrap.

Adding the fifth primary navigation destination would otherwise exceed the
320 px minimum layout. At the narrow breakpoint the existing theme toggle
therefore becomes an icon-only 40 px control while preserving its accessible
name and tooltip.

## File and component plan

### New files

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

`ReferenceSearchSurface` owns request and presentation behavior but not browser
routing. `SearchPage` is the small URL adapter. Pure URL and validation helpers
remain outside React so they can be exhaustively unit-tested and later reused by
a modal Project picker.

## Verification

Pure tests cover:

- parsing omitted/default filters;
- type deduplication and closed ordering;
- ignoring invalid external type values;
- canonical URL serialization and omission of defaults;
- query trimming and shared length bounds;
- empty-type and reversed-date validation;
- conversion of browser dates to complete UTC-day API bounds;
- normalized committed-state equality for explicit retry;
- stable target equality.

Mounted surface tests cover:

- no request before a committed query exists;
- exact POST payload for committed query/filter state;
- stale request cancellation;
- same-state retry after a request failure;
- committed clear-to-idle behavior;
- server result order preservation;
- source/reference actions;
- truncation and no-result states;
- selection mode returning the exact stable `ReferenceTarget`;
- no Project insertion wording or mutation behavior.

Mounted page tests cover:

- initial committed state restored from the URL;
- explicit submission pushing a new URL history entry;
- browser Back restoring the previous URL, input draft, request, and result set.

Static page/routing tests cover:

- lazy `/search` route registration;
- primary navigation entry and Search icon;
- URL-owned page composition;
- narrow theme-toggle compaction required by the fifth navigation item.

The new pure and mounted tests join `test:reference-foundation`. Normal
`npm test`, the real Worker/D1 search smoke, TypeScript compilation, and the
production build remain required. No migration is added.

## Completion criteria

Phase 2C2 is complete when:

1. `/search` is discoverable and refresh-safe;
2. committed query/type/Sample/date state round-trips through the URL;
3. Back/Forward restores the corresponding controlled search;
4. empty queries issue no request;
5. stale requests are aborted and cannot replace newer results;
6. an unchanged committed state can be explicitly retried after failure;
7. clearing the query commits the idle state rather than only editing a draft;
8. browser date filters cover both complete selected UTC dates;
9. result order exactly matches the service response;
10. all nine target types can be selected and filtered;
11. canonical Reference and exact source destinations are explicit actions;
12. selection mode returns only a stable `ReferenceTarget` and performs no write;
13. no registry row, source row, Project placeholder, or physical locator is
    created or exposed;
14. desktop and 320 px mobile layouts remain usable;
15. focused reference tests, complete tests, and production build pass;
16. the PR remains Draft for review and performs no remote migration or deploy.

## Next phase

Phase 3 creates Project identity and the authoritative insertion path. A Project
picker reuses `ReferenceSearchSurface` in selection mode, then sends the selected
`ReferenceTarget` to a server operation that re-resolves the target, registers it
idempotently, and creates the owning `project_item` under one transaction-like
guarded workflow. Phase 3 does not add another search model.
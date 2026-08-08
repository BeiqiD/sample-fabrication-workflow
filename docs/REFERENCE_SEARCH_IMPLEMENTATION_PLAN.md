# Deterministic reference search implementation plan

Status: implementation contract for Phase 2C1

Last reviewed: 2026-08-08 after PR #128 merged into `v2/backend-foundation`

This document defines the first deterministic-search slice built on the stable
reference identity, resolver, canonical destinations, and exact source-focus
contracts completed in Phases 2A and 2B.

The product invariants remain in
[Project design foundation](./PROJECT_DESIGN_FOUNDATION.md). Source lifecycle is
defined in [v3 backend foundation](./V3_BACKEND_FOUNDATION.md). Reference
identity and base resolution are recorded in
[reference registry and batch resolver](./REFERENCE_RESOLUTION_IMPLEMENTATION_PLAN.md),
and lifecycle-aware navigation is recorded in
[reference deep links](./REFERENCE_DEEP_LINK_IMPLEMENTATION_PLAN.md) and
[reference source focus](./REFERENCE_SOURCE_FOCUS_IMPLEMENTATION_PLAN.md).

## Phase boundary

Phase 2C is split into two reviewable slices:

1. **Phase 2C1 — deterministic search foundation**: one read-only domain search
   service and authenticated API over the nine current reference target types,
   with explainable ranking, lifecycle filtering, stable selection payloads,
   bounded query count/bindings/candidates/resolver work, and focused verification.
2. **Phase 2C2 — global search and reusable picker UI**: one URL-owned Search
   page plus a reusable result-selection surface for later Project insertion.

Actual `Add to project` persistence does not belong in either slice because the
authoritative consumer identity does not exist until Phase 3 creates
`project_items.reference_target_id`. Phase 2C search results carry the exact
`ReferenceTarget` needed by that future route; Phase 3 performs registry
registration and Project-item creation server-side in one guarded operation.

This split avoids a placeholder usage table, a public registry-write endpoint,
or a UI action that pretends an insertion succeeded before there is a Project
item to own it.

## Pull-request boundary

The Phase 2C1 PR targets `v2/backend-foundation` after PR #128 and includes:

- shared search input/result types;
- a deterministic source-candidate service for all nine v1 target types;
- one authenticated read-only `POST /api/references/search` endpoint;
- exact-ID, exact-primary, primary-prefix, content, and metadata ranking tiers;
- type, Sample, and time filters;
- active-source lifecycle policy with historical Recipe support;
- resolver enrichment after candidate ranking;
- host SQLite and real Worker/D1 workerd verification;
- roadmap and architecture documentation updates.

It excludes:

- Project, Project content, Project items, backlinks, Text, Inspector, or Map;
- registry creation from search reads;
- a public registration endpoint;
- global Search-page UI or picker UI;
- source mutation from search results;
- semantic, embedding, fuzzy, or model-ranked search;
- FTS schema, denormalized search tables, background indexing, Queues,
  Workflows, Durable Objects, or a second Worker;
- remote migration or Worker deployment.

No migration is required for this slice. The initial deterministic search reads
the authoritative source tables directly. A later scale review may add an FTS
or materialized index only if real dataset size justifies the synchronization
cost.

## Unified-search and portability boundary

The search API, ranking tiers, lifecycle policy, stable `ReferenceTarget`
payload, and resolver revalidation are platform-neutral. Global search, Sample
or Recipe directories, and later Project pickers should reuse this domain
service through surface-specific profiles rather than grow unrelated matchers.
A profile may narrow types or add business eligibility: for example, global
research search may include an archived Recipe revision while a new-run
assignment picker must exclude it.

Candidate discovery is behind `ReferenceSearchCandidateBackend`. The current
`sqlite-source-scan` backend uses standard SQLite expressions and a narrow
`prepare -> bind -> all` query interface; Cloudflare D1 is one adapter, not the
search contract. A future Docker deployment can provide the same interface over
changing API or ranking semantics.

The preferred performance backend is a rebuildable SQLite FTS5 index behind the
same candidate interface. FTS5 is an open-source SQLite module available in D1
and in ordinary SQLite builds when enabled. The index remains derived data:
authoritative source rows, registry identity, lifecycle checks, and final
resolver results stay outside it. Restore imports source data first and rebuilds
the index; the virtual table is not a second source of truth. A non-SQLite
platform may implement the same backend contract with its own full-text engine.

Phase 2C1 deliberately keeps the source-scan backend so matcher semantics can be
reviewed independently of index synchronization. FTS5 maintenance, rebuild,
feature detection, and scale benchmarks belong to a later performance slice,
not to a Cloudflare-only branch in the domain service.

## Searchable targets and fields

The service covers the closed v1 target set:

| Type | Primary fields | Content fields | Context / metadata fields |
|---|---|---|---|
| `sample` | stable ID, code, title | description | location, status |
| `run` | stable ID, Template snapshot name/version | — | Run kind/status, Sample code/title |
| `run_step` | stable ID, exact Step title | notes, parameters, imported comments, deviation | tool, Run, Sample |
| `comment` | stable ID | canonical ready Comment body | scope and every Sample/Run/Step context |
| `comment_occurrence` | stable occurrence ID | legacy occurrence body only | exact Sample/Run/Step context |
| `comment_attachment` | stable item ID, title, filenames | description | URL, owning Comment body and contexts |
| `execution_image` | stable occurrence ID, original filename | — | Step, Run, Sample |
| `metrology_reference` | stable occurrence ID, display/original filename | — | exact Recipe revision |
| `recipe_revision` | stable revision ID, Recipe name/version, source filename | — | Template kind/type, archive state |

Canonical Comment occurrences do not produce duplicate body-search results.
They remain searchable by exact occurrence ID, while body search returns the
canonical logical `comment`. A legacy `run_step_comments` row with no canonical
submission remains searchable as a `comment_occurrence` because no logical
Comment identity exists for it.

Search targets occurrences, never R2 keys, managed-storage object keys,
provider paths, temporary URLs, or timeline events.

## Lifecycle and visibility policy

Search is a new-reference discovery surface, not an archive browser.

- a source with `deleted_at` is excluded;
- a Run, Step, Comment, attachment, or execution image whose required Sample,
  Run, or Step ancestor is deleted is excluded;
- a canonical common Comment remains searchable when at least one deterministic
  context is active;
- cancelled, failed, uploading, or draft Comment submissions/items are excluded;
- archived Recipe revisions remain searchable because archive prevents future
  process assignment but does not invalidate historical research references;
- metrology references owned by an archived-but-not-deleted Recipe revision
  remain searchable;
- missing, inconsistent, and tombstoned rows are not candidates, but existing
  canonical reference URLs continue to resolve them read-only through Phase 2B.

The final resolver pass rechecks lifecycle and structural consistency. A source
that changes between candidate discovery and resolution is dropped rather than
returned as a selectable result.

## Input contract

The domain service accepts:

```text
query              required non-empty string, at most 200 characters
types[]            optional closed v1 type subset; empty/omitted means all
sampleId           optional exact active Sample stable ID
from               optional inclusive YYYY-MM-DD or RFC 3339 timestamp with explicit timezone
to                 optional inclusive YYYY-MM-DD or RFC 3339 timestamp with explicit timezone
limit              optional integer, 1..50; default 30
```

The source-scan matcher uses a deterministic, portable token policy:

- trim outer whitespace and preserve the raw query for byte-exact `BINARY`
  identity/title matching;
- fold only ASCII `A` through `Z`, matching standard SQLite `LOWER()` behavior;
- treat non-ASCII code points as exact-case in this fallback backend;
- do not silently equate NFC and NFD normalization forms;
- split on whitespace, remove duplicate ASCII-folded tokens, and retain at most
  eight tokens;
- require every retained token to match literally; `\`, `%`, and `_` are data,
  not pattern syntax;
- accept the documented 200 Unicode-code-point query without silently
  truncating a token.

Full Unicode case folding and normalization may be supplied by a versioned FTS5
backend later, but it must not silently change exact stable-ID identity.

Date-only values mean midnight UTC. Datetimes must use `T`, seconds, and an
explicit `Z` or numeric timezone offset; natural-language dates, invalid
calendar dates, and timezone-less datetimes are rejected before `Date.parse()`
is used for normalization.

The service validates its own input and throws typed errors. The HTTP route only
parses JSON and maps those domain errors to `400`; future internal Project
callers cannot bypass the bound by skipping the route.

The time filter applies to the target's search timestamp:

| Type | Search timestamp |
|---|---|
| Sample | `samples.updated_at` |
| Run | `COALESCE(runs.completed_at, runs.created_at)` |
| Run Step | `run_steps.updated_at` |
| Comment | `comment_submissions.updated_at` |
| Comment occurrence | `COALESCE(run_step_comments.updated_at, created_at)` |
| Comment attachment | `comment_submission_items.updated_at` |
| Execution image | `run_step_assets.created_at` |
| Metrology reference | `metrology_template_references.created_at` |
| Recipe revision | `template_versions.created_at` |

A Sample filter returns only targets belonging to that Sample context. Recipe
revisions and metrology-template references have no Sample context and therefore
do not match when `sampleId` is present.

## Explainable ranking

Every candidate receives exactly one ranking tier:

1. `exact_id` — byte-exact stable-ID match, then ASCII-case-insensitive fallback;
2. `exact_primary` — byte-exact code/title/name/filename match, then ASCII-case-insensitive fallback;
3. `prefix_primary` — the primary field begins with the raw or ASCII-folded complete query;
4. `content` — every token matches the target-owned body/description/note fields;
5. `metadata` — every token matches only context or weaker metadata.

Results sort by:

```text
ranking tier ascending
search timestamp descending
closed target-type order
stable target ID ascending
```

This order is deterministic and testable. It does not use opaque weighted
scores, database row order, semantic similarity, or model judgement.

## Query architecture and bounds

Each selected target type owns one candidate query. Queries:

- use bound values for every user-controlled value;
- use literal `INSTR()` matching plus `BINARY` exact comparisons; no `LIKE` or
  `GLOB` pattern is constructed from user input;
- apply lifecycle, Sample, and time filters in SQL;
- return at most a small fixed candidate cap plus one overflow row;
- never issue one query per result;
- avoid a nine-term compound `UNION ALL`, preserving the D1/workerd lesson from
  PR #124.

The service runs candidate queries in parallel, merges and ranks candidates in
application code, resolves at most 200 top candidates through the existing
batch resolver, drops candidates that no longer resolve as active, and returns
at most the requested limit.

Query count, bound-parameter count, candidate output, and resolver work are
`O(number of selected target types)` with small fixed caps. The source-scan
backend still performs leading-substring scans whose CPU and rows examined grow
with source-table size. `LIMIT` bounds returned candidates, not scan cost. FTS5
is the planned portable optimization when measured scale requires it.

The response reports `truncated: true` when a per-type candidate cap or the
requested result limit may have omitted additional matches. The first version
is deliberately bounded and does not pretend to provide an exact total count.

## Shared output model

Each result contains:

```text
target
- type
- id

match
- tier
- matchedAt

resolution
- current source summary
- ordered contexts
- lifecycle state
- canonical reference destination
- safe ordinary/context source destinations
```

The embedded `target` is the stable selection payload for Phase 2C2 and Phase
3. Reading or selecting a result does not register it and does not write D1.
The future Project-item creation route re-resolves and registers the target at
write time so a stale browser result cannot bypass lifecycle or concurrency
checks.

## API boundary

The only new route is:

```text
POST /api/references/search
```

It inherits the core Hono middleware stack:

- Cloudflare Access authentication;
- validated `userEmail` context;
- same-origin protection for browser POST requests;
- shared error handling;
- the existing one-Worker runtime boundary.

The endpoint is read-only. Tests assert that `reference_targets` and every
source table remain unchanged after search.

## Verification

Focused host-SQLite tests cover:

- all nine target adapters and documented searchable fields;
- the five ranking tiers and deterministic tie-breaking;
- exact-ID access to canonical Comment occurrences without duplicate body
  results;
- type, Sample, and time filters;
- deleted source/ancestor exclusion;
- common Comment visibility through any active context;
- archived Recipe and metrology-reference behavior;
- invalid query/type/Sample/time/limit input, including natural-language,
  invalid-calendar, and timezone-less dates;
- literal `\`, `%`, and `_`, 49–200-byte tokens, and multibyte text;
- byte-exact Unicode IDs/titles, ASCII-only case folding, and distinct NFC/NFD
  forms;
- candidate and resolver bounds;
- query count independent of result count;
- no registry or source writes;
- no physical locator leakage;
- truncation behavior.

Route tests cover authenticated success, malformed JSON, typed `400` errors,
same-origin inheritance, result ordering, and read-only behavior.

A real Miniflare/workerd smoke applies the complete migration chain, loads the
reference fixture, runs representative exact, content, type, Sample, and time
searches through the Worker endpoint, and verifies canonical destinations plus
locator non-disclosure.

The focused search files become part of `test:reference-foundation`, and the
workerd smoke becomes part of both the reference CI gate and
`verify:v3-deployment`.

## Completion criteria

Phase 2C1 is complete when:

1. all nine v1 target types have deterministic candidate coverage;
2. search input is bounded and validated at the domain boundary;
3. deleted sources and deleted required ancestors cannot enter new-reference
   search;
4. archived historical Recipe references follow the documented policy;
5. ranking is explainable and stable under repeated runs;
6. query count grows with selected types, not matching rows;
7. results are revalidated through the existing resolver;
8. search produces no registry or source writes;
9. responses expose no physical storage locator;
10. matcher behavior is identical in host SQLite and real Worker/D1 workerd;
11. the candidate backend seam preserves the same domain contract for D1,
    self-hosted SQLite, and a later FTS5 implementation;
12. host SQLite, real Worker/D1 workerd, complete tests, and production build
    pass;
13. no remote D1 migration or Worker deployment is run.

## Next slice

Phase 2C2 adds the URL-owned global Search page and a reusable search/result
selection surface. It consumes this API without changing ranking or lifecycle
semantics. Phase 3 then creates Projects and performs actual server-side target
registration plus `project_items` insertion; it does not invent a second search
model.
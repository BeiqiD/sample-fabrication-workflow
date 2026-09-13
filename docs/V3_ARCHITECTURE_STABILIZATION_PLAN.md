# V3 architecture stabilization plan

Status: backend reliability corrections, Worker extraction and shared-contract
separation are merged. Compatibility schemas, recovery and local migration
staging are qualified; the final S2 application is prepared in an inactive Draft.
Current S0 browser checks and read-only remote observation transport qualification
are recorded. Live target observation, remote field contraction, baseline activation and final S2
browser acceptance remain open. New frontend refinement remains paused.

The inventory, isolated recovery rehearsal and scale measurements are tracked in
[Backend reliability acceptance](./BACKEND_RELIABILITY_ACCEPTANCE.md).

Last reviewed: 2026-09-13 for the user-authorized backend-first execution order

This document defines the bounded backend reliability, architecture and schema
stabilization work required before final v1 release validation. Backend work now
precedes the remaining frontend refinement. The high-level order remains in
[Product goal and roadmap](./PRODUCT_ROADMAP.md). Current source identity,
lifecycle, Reference, blob, Project, export, and deployment invariants remain
authoritative in their focused contracts.

This is not a second V3 implementation and does not authorize a product rewrite.
The current `v2/backend-foundation` branch remains the behavior reference and
integration line. Stabilization proceeds through small Draft PRs targeting that
branch, with exact-head review and the existing verification gates.

## Decision summary

Implementation checkpoint, 2026-09-13:

| Slice | Evidence and remaining work |
|---|---|
| 6A1 reliability | PRs [#187](https://github.com/BeiqiD/sample-fabrication-workflow/pull/187), [#188](https://github.com/BeiqiD/sample-fabrication-workflow/pull/188), [#189](https://github.com/BeiqiD/sample-fabrication-workflow/pull/189), [#190](https://github.com/BeiqiD/sample-fabrication-workflow/pull/190) and [#196](https://github.com/BeiqiD/sample-fabrication-workflow/pull/196) are merged: export identity, uncertain placement settlement, recovery/scale baselines, split image inheritance and trigger-aware Comment acknowledgement. |
| 6A2 ownership | PRs [#191](https://github.com/BeiqiD/sample-fabrication-workflow/pull/191) and [#192](https://github.com/BeiqiD/sample-fabrication-workflow/pull/192) are merged; root Worker composition, domain routes, settlement and scheduled coordination have explicit owners. |
| 6A3 contracts | [#193](https://github.com/BeiqiD/sample-fabrication-workflow/pull/193) is merged; shared contracts/domain modules and permanent AST/type gates enforce dependency direction. |
| 6A4 compatibility | Canonical reader A [#194](https://github.com/BeiqiD/sample-fabrication-workflow/pull/194), versioned export E [#197](https://github.com/BeiqiD/sample-fabrication-workflow/pull/197), and inactive S1/S2 schema/recovery qualification [#198](https://github.com/BeiqiD/sample-fabrication-workflow/pull/198) are merged. The C writer [#199](https://github.com/BeiqiD/sample-fabrication-workflow/pull/199) and B overlap bridge [#200](https://github.com/BeiqiD/sample-fabrication-workflow/pull/200) are implemented and locally qualified Drafts; B/C/D remote transitions remain inactive. |
| 6A5 baseline | Planner/observer/preflight [#195](https://github.com/BeiqiD/sample-fabrication-workflow/pull/195) and actual local Wrangler staging [#201](https://github.com/BeiqiD/sample-fabrication-workflow/pull/201) are merged. Draft [#202](https://github.com/BeiqiD/sample-fabrication-workflow/pull/202) qualifies the final S2 application's complete gate, default fresh baseline, preserved historical chain and recovery matrix; it is not eligible for the current S0 automatic deployment path. The read-only remote D1 transport in [#203](https://github.com/BeiqiD/sample-fabrication-workflow/pull/203) is merged after complete verification; no live remote observation is claimed. Remote admission and execution integration remain open. |
| 6A6 exit | Not complete. Browser access is restored; the exercised S0 Template/Run, split-image, canonical Comment/Reference and v8 download/restore checks pass. Final S2 deployed-browser acceptance remains outstanding. A deployed version allocation alone does not establish old-request retirement for destructive cleanup. |

See the [compatibility sequence](./BACKEND_COMPATIBILITY_CLEANUP_DESIGN.md),
[schema qualification](./BACKEND_COMPATIBILITY_SCHEMA_QUALIFICATION.md), and
[baseline evidence](./BACKEND_MIGRATION_BASELINE_DESIGN.md#inactive-final-baseline-qualification).
Passing an inactive candidate test does not close an activation or browser gate.

The [current S0 browser evidence](./BACKEND_BROWSER_RETRY_ACCEPTANCE.md) and
read-only observation PR #203 are complete. The next checkpoint obtains an actual target observation through an admitted
read-only connection. Observation identifies schema and ledger state; it cannot
prove that incompatible historical Worker requests have ended. The
[compatibility preflight](./COMPATIBILITY_STAGE_PREFLIGHT.md) still blocks remote
B/C/D because that retirement proof has no implemented bootstrap path. Choose
and qualify a safe activation path before building its executor: either satisfy
the existing-database retirement sequence or separately review an isolated
recovery/cutover path with consistent retained data. An executor, elapsed wait or
operator assertion alone cannot close this technical blocker. The three
inactive application Drafts must not enter the S0 automatic deployment path.

V3 keeps the current runtime shape:

```text
Browser
  -> Cloudflare Access
    -> one Hono Worker
      -> D1
      -> R2
      -> ManagedStorage adapter
```

The stabilization phase will:

- retain the single-Worker modular monolith;
- make module ownership and allowed dependencies explicit;
- reduce `worker/index.ts` to composition and cross-module application wiring by
  extracting one behavior-preserving domain slice at a time;
- separate stable Web/Worker contracts from shared pure algorithms without
  requiring a monorepo conversion;
- remove only compatibility fields whose replacement paths are complete and
  verified;
- replace the pre-release incremental migration chain with one clean V3 baseline
  for a new empty database;
- rebuild the fresh-install, migration, Worker/D1, export, and deployment gates
  around that baseline before any persistent V3 activation.

The stabilization phase will not:

- create another long-lived V3 branch from `main`;
- rewrite working domain behavior while moving it;
- introduce microservices, Queue, Workflow, Durable Object, or another Worker;
- require `apps/`, `packages/`, npm workspaces, or a repository-wide file move;
- impose repository interfaces or fixed route/command/query/model/policy files on
  every module;
- rename `events` to a generic audit table without first separating user-authored
  Sample records from timeline/audit projections;
- remove database triggers merely because their effects are not visible in route
  code;
- add integer revisions to every mutable table when no concurrent editing contract
  requires them;
- change Project occurrence, Map, Reading, Reference, blob, attachment, or export
  semantics.

## Relationship to Phase 5 and release hardening

The user has chosen to pause new frontend refinement and prioritize backend
review/correction. Phase 6A1 used the deployed PR #185 frontend behavior as the
initial regression reference. Complete export/restore and representative
large-Project characterization, demonstrated defect repairs, and Phase 6A2/6A3
Worker/contract ownership work are merged. Continue from the current late-stage
checkpoint above; do not repeat those completed slices. Phase 5F was not a
prerequisite for them.

Backend extraction preserves public API, source identity, revisions, idempotency,
transaction and export/retention behavior. Any intentional change to interface,
behavior or schema needs a separate design and review with its frontend impact
and verification made explicit. Do not combine frontend controller rewrites with
Worker extraction or repeat completed visual/shortcut work.

Compatibility cleanup and the database baseline remain the late Phase 6A4–6
sequence after affected consumers and contracts are stable. Their existing
design, schema-comparison and migration/resource gates remain in force.

At the backend review checkpoint, resume outstanding C4 acceptance and the
frontend 5D → 5E → 5F sequence with its unverified boundaries intact. Backend
probes cannot qualify physical-device or frontend usability claims. Phase 6B
release validation starts only after both the backend stabilization exit and
Phase 5F's final frontend baseline; earlier backend reliability evidence is
rechecked where later changes affect it.

The current V3 migration chain and deployment gate remain authoritative until the
baseline replacement slice is complete. No planning document, local schema dump,
or passing ordinary build authorizes remote migration or deployment.

An optional trusted server-side derivative producer remains an independent
feature decision. If an approved implementation requires schema changes, it must
either finish before the final V3 baseline is cut or be deferred to an ordinary
post-baseline migration. It is not silently included in architecture
stabilization.

## Preserved domain invariants

The current branch has already established the expensive parts of the domain
model. Refactoring must preserve at least:

- stable source and occurrence identities with ordinary soft delete and same-ID
  restore;
- canonical logical Comments distinct from their target occurrences;
- `source -> occurrence -> blob record -> provider object` identity separation;
- one shared blob-retention definition for cancellation, GC, export, recovery,
  and later permanent-delete planning;
- sparse immutable `reference_targets` registration and source-owned resolution;
- no provider locator in Reference or ordinary browser contracts;
- Project ownership limited to Project-local Markdown, attachments, placements,
  and edges;
- read-only Project references to external experimental records;
- Map and Reading as projections of the same Project item occurrences;
- normalized Project persistence rather than serialized React Flow state;
- immutable content-addressed process definitions and state representations;
- complete export of active, archived, failed, cancelled, and soft-deleted data;
- existing optimistic concurrency, idempotency, actor attribution, and conflict
  behavior.

Any slice that cannot demonstrate preservation of its affected invariants stops
and returns to design review. Directory placement is never evidence that a domain
boundary is correct.

## Module ownership model

The target distinguishes product domains from supporting/platform capabilities.
They are not all peer bounded contexts.

| Area | Owns | Does not own |
|---|---|---|
| Sample | physical identity, split lineage, location, lifecycle state | Run plans, Project content, provider bytes |
| Process definition | template family/version, ordered steps, immutable definitions and expected states | actual execution or Sample state |
| Execution | Runs, plan revisions, actual Steps, verification, execution evidence coordination | template authorship or Project presentation |
| Evidence | canonical Comments, Comment targets, attachment occurrences, observations | shared byte lifecycle or Project-local content |
| Project | Project-local content, item occurrences, placement, edges, Reading projection | mutation of referenced source records |
| Reference | stable cross-domain target registration, resolution, search, destinations | copied source titles/body/status or source mutation |
| Blob/storage | physical-byte metadata, ingestion, integrity, reachability, GC, provider adapters | source/occurrence meaning |
| Audit/timeline | append-oriented system history projection | canonical ownership of source state or user-authored content |
| Export | exhaustive extraction, manifests, and availability warnings | domain identity or lifecycle policy |
| Platform | authentication, request guards, D1/R2 bindings, media responses | product policy |

The expected dependency direction is:

```text
HTTP routes
  -> application commands and queries
    -> source-owning modules
      -> platform adapters
```

Cross-domain operations may use an explicit application service and one atomic D1
batch. They must not be forced through repository abstractions that hide required
transaction guards. Project reads external records through Reference services and
source read ports; it does not query or mutate Sample/Run tables as a shortcut.
The table expresses ownership direction, not permission to split the current
mixed `events` storage during this phase; that decision remains gated below.

## Repository-structure strategy

Stabilization starts inside the current repository layout. A suitable first
shape is:

```text
worker/
  app.ts
  modules/
    samples/
    process-definition/
    execution/
    evidence/
    projects/
    references/
    blobs/
    export/
  platform/

src/
  features/
  components/
  lib/

shared/
  contracts/
  domain/
```

This tree is directional, not a requirement to create every directory in the
first PR. A module creates only the files justified by its behavior. Existing
specialized modules may be moved or renamed only when the change makes ownership
clearer and the affected tests move with them.

`worker/index.ts` becomes a composition root through extraction, not replacement.
No line-count threshold is an acceptance criterion. The meaningful result is that
ordinary route handlers, source-owned SQL, serializers, and mutation policy no
longer accumulate in the root.

Frontend feature colocation is a maintenance direction after Phase 5, not a V3
database or release gate. New feature-specific code should prefer local ownership,
but a whole-repository `src/` relocation is deferred unless measured navigation,
dependency, or test-maintenance cost justifies it. `apps/web`, `apps/worker`, and
npm workspaces remain optional future packaging choices.

## Phase 6A bounded sequence

### Planning gate — roadmap and boundaries

This document and its roadmap links complete the planning gate. It records:

- the preserved behavior and domain invariants;
- the module-ownership hypothesis;
- the bounded implementation order;
- release-critical versus optional cleanup;
- explicit non-goals and decision gates.

The 2026-09-13 route revision began the backend Phase 6A1 sequence before the
remaining Phase 5 work. That planning decision did not itself establish audit,
repair or activation results; the current implementation checkpoint above now
records the subsequent bounded PRs and remaining gates.

The 2026-09-12 audit repair work is tracked in
[Architecture audit remediation](./ARCHITECTURE_AUDIT_REMEDIATION.md). The
user-authorized correctness fixes and verification repairs are separate from
the behavior-preserving extraction sequence below. They do not start a schema
baseline replacement or complete Phase 5 browser acceptance.

### 6A1 — exact inventory and characterization gate

Re-measure the current integration repository rather than treating historical
audit counts as a future contract:

- direct routes, SQL ownership, and cross-domain helpers still present in
  `worker/index.ts`;
- existing specialized route/service modules and their dependency direction;
- all Web/Worker imports from `shared/`, classified as API contract, pure domain
  algorithm, or accidental shared implementation;
- every read/write dependency on compatibility fields;
- Trigger-owned invariants and every application path that relies on them;
- current fresh-migration, export, Worker/D1, and representative behavior gates;
- Project command availability across buttons, menus, keyboard handlers and
  execution guards, including independently versioned geometry and edges;
- single-item, bulk-item and insertion-cancellation lifecycle protocols, with
  their exact-request journals, settlement proofs and navigation protection;
- snapshot, working geometry, hydration and mutation-acknowledgement write
  ownership, including stale responses after Project identity changes;
- entity-bound source-page drafts, detail-loader generations and Comment
  submission/recovery state ownership;
- the shared CI/deployment leaf-check inventory and the actual production
  artifacts covered by each smoke test.

#### First execution slice: backend reliability baseline

Start with an exact commit, existing routes and a reproducible synthetic fixture
in isolated local database/provider resources:

- exercise complete export and recovery into a separate destination, comparing
  stable IDs, normalized rows, source/Reference relationships, deleted state,
  attachment metadata, retention/quarantine state and available file hashes;
- record archive/schema/build identity, restore order and unavailable-byte
  outcomes. Inventory any missing recovery path explicitly; do not assume the
  current export implies a complete restore implementation or silently introduce
  a new public import protocol;
- measure representative large-Project snapshot reads and writes through final
  save acknowledgement, including query/request counts, latency, conflict and
  failed/uncertain retry behavior. Distinguish backend timings from browser frame
  rate and memory claims;
- report reproduced defects, verification gaps and measured limits with bounded
  follow-up PRs. Add characterization coverage only where a concrete boundary
  lacks it; reuse the existing migration/export/Worker checks.

This first slice does not rewrite application modules or modify the schema.
Actual corrections follow as focused PRs before the affected extraction. Its
exit is a reviewable reliability/inventory record and regression baseline, not
an assertion that every backend feature or final release rehearsal is complete.
The later baseline replacement must repeat affected recovery checks against the
final schema; no persistent resource is reset during this first slice.

Add characterization coverage only where an extraction would otherwise rely on
unstated behavior. This slice changes no production behavior or schema.
Prefer mounted/API behavior coverage for extraction boundaries; replace fragile
source-variable or callback-string assertions only in the affected area. Use
static import rules for dependency direction, and keep browser checks for hit
testing and layout. Moving mounted tests into feature directories must update
the test-discovery pattern so the tests continue to run.

### 6A2 — behavior-preserving Worker extraction

Extract source-owned routes and SQL through several independently reviewable PRs.
The expected order is:

1. Sample directory, Sample identity, lifecycle, and Sample records;
2. process Runs, plan updates, actual Steps, metrology execution, and state
   verification;
3. process-template and metrology-template definition routes;
4. imports, export delivery, and remaining asset routes;
5. final composition-root and cross-module dependency review.

Comment, Project, Reference, blob-lifecycle, and existing storage modules are
preserved and adjusted only where the dependency review proves a concrete
ownership violation.

The audit identified these bounded ownership follow-ups:

- Evidence owns both active legacy Comment commands and canonical submission
  commands. Inventory consumers before consolidating target policies; readable
  common evidence and whole-operation mutation have different visibility rules.
- Project application operations own execution, replay and settlement queries.
  HTTP maps their structured mutation disposition to headers/status; a failed
  proof must continue to mean uncertain.
- Export owns the complete catalog, manifest and delivery route. Move the
  all-system export out of the Project aggregate while preserving its single
  D1 batch snapshot boundary.
- Scheduled maintenance coordinates import recovery, Evidence retry-window
  closure and physical blob GC in the existing order. Keep domain timeout SQL
  with Evidence and retain atomic guards; no new Worker or queue is required.

Frontend ownership work remains separate, following the same small-slice
discipline after Phase 5F; it is not brought forward with Worker extraction:
first converge ordinary single/bulk item lifecycle execution, then use one
command-availability boundary, then introduce narrow acknowledgement reducers
and a dedicated placement-save queue. Preserve special insertion-cancellation
continuations and independent revision domains. Extract shared media display
from the Execution grid before moving larger UI modules. These are ownership
changes, not a requirement to move all of `src/` or create one large page hook.

Each extraction PR must preserve:

- public route path, method, request validation, response shape, and status code;
- SQL guard, binding order, D1 batch atomicity, and Trigger interaction;
- idempotency, optimistic concurrency, retry, and mutation identity;
- export and blob-retention coverage;
- focused tests plus the complete required verification gate.

Moving code and changing its behavior in the same PR is prohibited unless a
separately documented correctness defect makes separation impossible.

### 6A3 — contract and shared-code separation

Classify and relocate the existing shared surface without introducing a generic
common package:

- stable request and response schemas;
- runtime input validators;
- stable public enums, IDs, error codes, and Reference codecs;
- pure deterministic algorithms genuinely used by both Web and Worker.

Worker services, D1 queries, React components, mutable application policy, and
provider logic cannot enter the contract boundary. Runtime validation is required
for untrusted inputs. Runtime re-validation of every trusted internal output is
added only where it closes a demonstrated contract risk.

The first implementation remains within `shared/contracts` and `shared/domain`
unless an independent build or distribution requirement later justifies
`packages/contracts`.

Template request/response DTOs are a concrete first candidate: constrain Worker
serializers with the shared response contract rather than keeping independent
client-only types. A small common HTTP error may preserve status and cause;
Project-specific mutation disposition remains owned by Project. Do not turn
that transport error into a universal cross-domain retry policy.

### 6A4 — compatibility cleanup and vocabulary decision

This late slice follows backend reliability corrections and stable module/API
boundaries. It is not bundled into the initial inventory or extraction PRs.

Only explicitly identified compatibility state is release-critical by default.
Current candidates are:

| Candidate | Required decision |
|---|---|
| `samples.process_revision` | remove after all code and tests use the current concurrency contract |
| duplicated `run_step_comments.body` | complete canonical Comment reads/writes, then remove the duplicate authoritative-looking field |
| Recipe/Template naming | choose the public product vocabulary; rename database objects only if clarity justifies the query and migration churn |
| historical repair-only migrations | represent their final valid schema directly in the baseline; do not replay repair operations against a new empty database |

The following are audits, not pre-authorized schema changes:

- `events` currently contains both user-authored Sample records and system
  timeline/audit projections. A split requires a separate source-ownership and
  read-model plan; a generic `metadata_json` audit table is not an adequate
  replacement.
- Existing SQLite triggers remain database invariants unless a focused review
  proves that explicit command orchestration is safer across every write path.
- Project already uses monotonic integer revisions. Other aggregates adopt that
  contract only when actual concurrent editing semantics require it.

Every compatibility removal first converts all reads and writes, then proves
behavior through tests, and only then changes the schema.
The Execution grid still selects legacy Comment/asset deletion for records
without a canonical submission ID. Absence of UI calls to the old creation
endpoint alone does not prove that the old command family can be removed.

### 6A5 — clean V3 baseline and migration gate

After the final authorized schema cleanup, create `0001_v3_baseline.sql` as the
only active pre-release V3 migration. The old chain remains recoverable from Git
history and may be documented outside `migrations/`; Wrangler must not scan an
archive as active migrations.

Record baseline eligibility per target database. A deployed disposable
integration-test database is not production activation, but it can already have
an applied-migration ledger. Do not apply the new full baseline as an ordinary
increment to that ledger. Disposable test resources can be rebuilt in isolation;
if any data is retained, rehearse recovery into the new database or retain a
verified upgrade path. In that case verification also includes a copy of the
existing database, not only two empty databases. No remote data is reset by the
inventory or baseline comparison itself.

Baseline verification must:

1. apply the current chain plus the final cleanup migration to empty database A;
2. apply the proposed baseline to empty database B;
3. compare normalized tables, columns, constraints, indexes, views, and triggers;
4. record and review every intentional difference;
5. run `foreign_key_check`, integrity checks, and representative write/read
   transactions against both expected final schemas;
6. run host SQLite and Wrangler local D1/workerd migration verification;
7. run complete blob, Reference, Project, import, export, Worker, frontend, and
   production-build gates against a database created only from the baseline;
8. compare the actual migrated schema with the complete export catalog; every
   business table and public export view must be covered, and every excluded
   internal view must have an explicit reconstruction rationale;
9. update schema, architecture, deployment, backup, and recovery documentation.

Activating the replacement baseline on a remote V3 D1 database or deploying its
Worker requires this gate and the existing isolated-resource requirements to
pass. Once the baseline is
released or any persistent V3 database depends on it, it becomes immutable and
future changes resume as `0002_...`, `0003_...`, and later migrations.

### 6A6 — stabilization exit review

Run an exact-head review across the complete Phase 6A result. Confirm that:

- the integration branch, not a replacement implementation, remains the source of
  behavior;
- root composition no longer owns ordinary domain routes or SQL;
- dependency direction and contract ownership are understandable without a
  catch-all `shared` surface;
- approved compatibility fields are absent and deferred candidates remain
  explicitly documented;
- the baseline creates the complete final schema from an empty database;
- all permanent gates pass without remote side effects;
- Phase 6B can use isolated persistent resources without requiring another
  destructive baseline reset.

## PR and branch discipline

- All implementation branches start from the latest
  `v2/backend-foundation` and target it through Draft PRs.
- `main` and any existing deployment remain frozen except for explicitly reviewed
  repository-level maintenance that is synchronized back into the integration
  line.
- Every PR states whether it is characterization, behavior-preserving extraction,
  contract movement, intentional schema change, or migration-baseline work.
- A PR does not combine unrelated categories merely to reduce PR count.
- Every review locks the exact head SHA and lists focused plus complete gates.
- No remote migration, preview activation, production resource write, or provider
  cleanup is part of ordinary PR verification.
- Existing user-facing behavior wins over the proposed folder tree when they
  conflict; the plan must be amended before behavior changes.

## Phase 6A exit and Phase 6B handoff

Phase 6A is complete when the current V3 product behavior is represented by a
modular single Worker, explicit contract boundary, reviewed final schema, and one
fresh-install baseline without discarding the verified implementation.

Phase 6B follows only when this backend exit and Phase 5F's resumed frontend
baseline are both complete. It owns:

- sustained representative research-data use;
- desktop, mobile, and supported-browser regression;
- large-Project and performance qualification;
- complete export, human-readable export, backup, restore, and recovery rehearsal;
- isolated deployment and upgrade/runbook verification;
- accessibility and security review;
- release-blocking corrections without reopening optional feature development.

The representative-data rehearsal includes a 250/500-node Project's multi-card
move through the final save acknowledgement, measuring request count, elapsed
time and React commits. jsdom scale checks do not establish browser frame rate.
Measure before changing sequential writes or adding a bulk API.

The preliminary Phase 6A1 reliability checks do not complete this final rehearsal.
Backup qualification includes an archive-to-isolated-database/provider round
trip, comparing stable IDs, normalized rows, deleted state, Reference targets,
retention, quarantine, derivatives and file hashes. Record schema/build identity,
restore order and unavailable-byte outcomes. Add visible export results and
cancellation in the planned source-page refinement; measure browser ZIP memory
before choosing a streaming or desktop export implementation. Direct provenance
keys remain conservatively retained until a separate metadata migration is
justified by restore or storage-volume requirements.

Frontend-wide file relocation, a Sample-record/audit split, broader concurrency
normalization, Docker distribution, permanent delete, semantic/LLM features, and
real-time collaboration remain independent follow-ups unless a concrete Phase 6
release blocker proves otherwise.

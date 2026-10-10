# Product goal and roadmap

Status: canonical product direction and active implementation roadmap

Last reviewed: 2026-10-10 after [PR #251](https://github.com/BeiqiD/sample-fabrication-workflow/pull/251)
merged the reviewed implementation into `v2/backend-foundation` at
`aa497d9a1a304751ea7533548573a256799ef734` (13:30:26 UTC). Its source tree
`087749d12a3e3ad19473f1f4e63d29e1ecf1c269` equals the locally and remotely
qualified `af8f374cfbbade3282f2e686cc9f35d3c40adf4a` tree. Planning PR #250
remains merged at `541eedb1405678097675aac5eb1284bf3c8ef950`.
Post-merge Verify/Map checks and all 15 contexts at `aa497d9` succeeded,
as did Workers Build `114224522096`. Open [PR #252](https://github.com/BeiqiD/sample-fabrication-workflow/pull/252)
has the bounded [current browser checkpoint](PHASE_5F_CURRENT_BROWSER_ACCEPTANCE.md)
at `ee1713393f5dea1f6bbd7a856c7586a8e517591c`, tree
`8f37485feb0328094738ada55da46a2a9c38aeaf`. The later exercised source
`c06cb71ec5933cfb4d1721a5c1ac314b09a96ed8`, tree
`2466e71894298e90acdc5bd4b183d29fdd88b24f`, passed a fresh 20-case matrix,
both named Metrology cases and controlled-stop/physical proof. The final-head
complete remote gate remains pending. Earlier checkpoints retain their dated evidence.

The owner authorizes autonomous development, self-review and merges into the
development/test integration branch, including its existing Workers build path.
The [active development goal](ROADMAP_AUTONOMOUS_DEVELOPMENT_GOAL.md) and
[forward integration runbook](V3_DEVELOPMENT_INTEGRATION_RUNBOOK.md) govern this
work. Production `main`, real-provider admission and assisted recovery retain
their separate scope and qualification gates.

## Current checkpoint

Separate **implemented**, **locally qualified**, **remote CI passed**,
**integrated**, and **deployed / real-provider-qualified**. Local verification
is valuable evidence but is not a remote pass or production admission.

| Area | Synchronization and evidence as of 2026-10-10 | Remaining boundary |
| --- | --- | --- |
| Integration and deployment | Planning #250 and implementation #251 are merged. The qualified `af8f374` tree is preserved exactly at integration `aa497d9`. Post-merge Verify/Map and all 15 contexts succeeded; Workers Build `114224522096` succeeded. Three anonymous routes still returned Access 302. The last authenticated historical deployment evidence is the 2026-10-03 V20 Worker `faa8a01b-0fc8-47d7-b59e-81e038bc4310`. | Observe actual serving version/schema and authenticated readiness. Neither Access redirects nor a build establish those facts. `main` remains the separate production release target. |
| FP1 | File authority was activated on the historical deployment; new `internal` and `originals` roles use R2. The [2026-10-01 acceptance](./FP1_R2_ROLE_DEFAULTS.md#live-acceptance--2026-10-01) passed 6 MiB HTTP writes and 15/15 V19 restore bytes. | Historical accepted locations and missing-provider outcomes remain explicit. |
| FP2 | **Implemented, CI-qualified and integrated** through #251: native File R2/S3 byte access, verified publication and lifecycle, configured candidate activation, independent role defaults and frozen accepted destinations; `0018` / V21. [FP2/FP3 record](https://github.com/BeiqiD/sample-fabrication-workflow/blob/2060c745376862a379e8c952ee87c05d49982e02/docs/FP3_LOCAL_DEVELOPMENT_ACCEPTANCE.md). | Real AWS account/profile and deployed administration/provider/runtime acceptance. Fixture tests do not establish real-provider qualification. |
| FP3 | **Implemented, CI-qualified and integrated**: persisted bounded migration jobs, isolated execution, pause/resume/cancel/retry, verified cutover, read holds and explicit cleanup; `0019` / V22. | Deployed runner limits/invocation, provider interruption and actual deployed nonempty recovery rehearsal. |
| FP4 | **Implemented, CI-qualified and integrated**: paired **Sample and Project** package export, matching website **fresh-copy** import, separate readable reports, `0020` / V23. [FP4 record](https://github.com/BeiqiD/sample-fabrication-workflow/blob/2060c745376862a379e8c952ee87c05d49982e02/docs/FP4_RESEARCH_PACKAGES.md). | Deployed/provider and targeted manual acceptance; maintain bounded packages, complete dependencies and original-vs-copy identity. |
| FP5 | **Implemented, CI-qualified and integrated**: privileged full backup, identity-preserving fresh-target recovery, protected configuration, legacy archive conversion and assisted handoff; `0021`–`0022` / V24. [FP5 goal](https://github.com/BeiqiD/sample-fabrication-workflow/blob/2060c745376862a379e8c952ee87c05d49982e02/docs/FP5_DEVELOPMENT_GOAL.md). | Real target provisioning, provider-specific and deployed handoff evidence; restored execution remains disabled pending explicit local admission. |
| Frontend | **C4, 5D and 5E** and bounded #251 repairs are integrated. **5F remains in progress**. Open #252 implements owner-scoped refresh and the search label; `ee171339` passed the adopted 20-case built-Worker matrix, 84 API seed requests, six actual Processing cost cases, 12 additional Project scenario identities and controlled-stop/physical checks. [Current evidence](PHASE_5F_CURRENT_BROWSER_ACCEPTANCE.md) separates current and historical results. | The fresh `c06cb71` 20-case matrix and both named Metrology cases, awaited stop and physical proof passed; finish final-head complete gates. Next separate PRs address initial Project GET retry and three-owner group refresh. Physical input/authenticated/provider and whole-5F acceptance remain open. |
| CI | At `af8f374`, all **12 local default leaves** passed: native **355 tests**, source **366 files / 3,349 tests**, mounted **98 files / 945 tests**, with no skips. Four remote Verify/Map runs and all **15 final status contexts** succeeded. Integration `aa497d9` preserves that exact tree and its post-merge Verify/Map/all 15 contexts passed. Applied #252 UI source passed 100 mounted files / 966 tests and build; its final complete gate remains pending. The 40-minute job budget/default case deadlines are unchanged. | Later source/docs trees need their own checks. Earlier `3c1baf5`, `4b2c660` and 97-file/939-test receipts remain historical and are not summed. |
| Integration defect repairs | [FP3 actor admission](FP3_JOB_AUTHORIZATION_ACCEPTANCE.md), [FP5 recovery bootstrap](FP5_RECOVERY_BOOTSTRAP_ACCEPTANCE.md) and [explicit route recovery](PHASE_6_ROUTE_RECOVERY_ACCEPTANCE.md) are included in the qualified, merged tree. | Actual development rollout, provider and operational acceptance remain separate. No real provider was activated. |
| Stabilization | 6A1–6A5 selected ownership/S2 work is historical; #251 combined-tree review and complete local/default remote gates passed. | Remaining 6A6 serving/schema/device and enabled-scope 6B provider/operational release verification stay open. |
| Legacy Drafts | #199/#200 are inactive alternatives to the chosen S2 route. | Review closure as maintenance, not as new migrations or a release prerequisite. |

**Qualified development integration at `af8f374` / `aa497d9`.**
The full local default `npm run verify:ci` passed all 12 leaves, including
contracts, fresh/populated migrations, Worker checks, build and bundle checks.
[Push Verify 38054290373](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38054290373),
[PR Verify 38054322488](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38054322488),
[push Map 38054290357](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38054290357)
and [PR Map 38054322490](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/38054322490)
all succeeded on exact source `af8f374`. The observed #251 merge has the same
tree; its post-merge Verify/Map checks and all 15 contexts subsequently passed.
Workers Build `114224522096` succeeded, without establishing actual serving
traffic or D1 migration receipts. Browser evidence qualifies the isolated built-Worker
fixture, including real start/plan confirmations and explicit chunk-error
recovery; it does not qualify live providers or physical input. Open #252
implements owner-scoped Processing refresh and the search label. Its `ee171339` adopted matrix passed 20 cases after 84 real seed
requests. Actual cost phases passed **8, 0, 1, 8, 7, 8** Sample reads: one Save
now returns **1 GET / 3,329 bytes**, against **8 GETs / 26,170 bytes** before.
Twelve additional Project scenario IDs qualified across attempt 2 (**11 passed,
1 harness failure**) and one selected 1181 case (**1 passed, 0 UI writes**),
including dirty state, held ACK, lost ACK and exact retry; original Projects
remained unchanged. Awaited disposal exited 0; four physical SQLite checks,
FK checks, original-state byte preservation and exact PNG bytes passed.
A fresh `c06cb71` / tree `2466e718` fixture subsequently passed the full
20-case matrix and both named Metrology pending-flow cases, including computed
textbox names. Awaited stop, four SQLite/FK checks, unchanged original bytes
and exact PNG proof passed again. These checks do not claim current final-head
full remote qualification.

**Next separately reviewable product slices.** Initial Project GET recovery has
an explicit Retry gap: the bounded mounted characterization was **5 red /
1 pass**, with **6 green** for the candidate fix. Known three-owner group refresh
has a private **29-test/type** candidate for **8 → 3** reads; it has no actual
new production-artifact write qualification yet. Keep these separate from #252
and preserve accepted-operation identity, uncertain ACK and retained grid state.

**Historical qualified default remote CI at `3c1baf5`.** Implementation checkpoint
`3c1baf5fdb21994c0510754eb20919db8189a91a` adds
[acknowledged job-control/read-ownership repair](https://github.com/BeiqiD/sample-fabrication-workflow/commit/3c1baf5fdb21994c0510754eb20919db8189a91a)
to the preceding
[helpful research read-error repair](https://github.com/BeiqiD/sample-fabrication-workflow/commit/051276300a34a1fce4b0afaa901cd0c38559e6b4)
and [saved-intent receipt-ownership repair](https://github.com/BeiqiD/sample-fabrication-workflow/commit/b7c624637b61a087c415b31e4c67a355867a9a69).
Successful job-control acknowledgements now invalidate older background reads
in Research Packages and System Recovery; an old paused GET cannot restore
Paused/Resume after an acknowledged Cancel. Research control completions also
retain the current denied/read-owner guard. The final five-file focused run
passed **88 tests** in 5.36 seconds. The final-head complete mounted suite then
passed **93 files / 877 tests** in 137.10 seconds; the local `tsc -b`/Vite build
also passed. Read-only development-data comparison retained exact schema, typed
cells and physical rowids, with SQLite quick-check OK and zero foreign-key
violations.
[Map performance run 37984549655](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/37984549655)
passed; [Verify run 37984549600](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/37984549600)
completed successfully on this exact code commit. All **12 canonical leaf
checks** and **15 status contexts** succeeded under the default CI configuration.
Local mounted/build results retain their separate scope; the complete local
canonical gate was unqualified at that checkpoint. These client repairs do not change
backend/API/provider protocols.

This qualification applies to `3c1baf5`, not automatically to later development
tips, including documentation-only commits, or to an accepted merged code/docs
tree. The later `af8f374` tree has its own qualification above. Whole-5F, provider/device
and enabled-scope release acceptance remain open.
The later documentation-only development tip `4b2c660` preserves that code and
records the [bounded initial 5F acceptance](https://github.com/BeiqiD/sample-fabrication-workflow/blob/4b2c660267b794d09798f961efe8d11ba6e1df86/docs/PHASE_5F_INITIAL_ACCEPTANCE.md)
and [queued Metrology slice](https://github.com/BeiqiD/sample-fabrication-workflow/blob/4b2c660267b794d09798f961efe8d11ba6e1df86/docs/PHASE_5F_METROLOGY_GOAL.md).
Its exact-head CI must be checked separately; it does not inherit the `3c1baf5` qualification.

**Historical local leaves at `b7c6246`.** Forty-seven focused repair cases and a
separate combined three-file/56-case run passed locally; those runs overlap. On
that head, the complete mounted suite passed **92 files / 863 tests** in 142.16
seconds, and a two-CPU `tsc -b`/Vite rebuild passed. Those results do not qualify
the changed `3c1baf5` tree. Prior
[Verify run 37983032975](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/37983032975)
was still running at this checkpoint;
[Map performance run 37983032962](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/37983032962)
passed. The earlier local complete-gate run was deliberately interrupted and
remains unqualified.

The preceding [Verify run 37979239529](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/37979239529)
on `20176fc51d77301c58706d8ae0ff7d87ca6a8422` passed its source context but
failed mounted checks on the immutable-media/helpful-GET conflict. Its
[Map performance run 37979239617](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/37979239617)
passed in 30 seconds. Earlier `4479295` Verify
[run 37976554667](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/37976554667)
was cancelled at the 20-minute job budget, without a specific test failure
annotation. The 40-minute job budget introduced at `20176fc5` is retained; the
default Vitest deadline remains **5,000 ms**, with existing case-specific limits
unchanged. A larger whole-job budget is not itself a passing result.

The historical documentation-only PR #250 checks qualified its planning heads,
not the separate implementation. PR #250 is now merged at `541eedb`; the exact
merged documentation head's Verify, Map and Workers checks succeeded. The owner
also explicitly authorized the development branch's automatic build/deploy path.
That authorization resolved the earlier merge-boundary question; source
integration is now observed through #251, while serving version, schema and
provider acceptance remain distinct.

**Historical initial 5F checkpoint at `20176fc5`, not full 5F acceptance.**
[The initial 5F goal](https://github.com/BeiqiD/sample-fabrication-workflow/blob/20176fc51d77301c58706d8ae0ff7d87ca6a8422/docs/PHASE_5F_DEVELOPMENT_GOAL.md) records
21 passing Settings/data mounted tests, 57 passing preview/Process/Timeline/modal
tests, six passing positive/blocked **mocked** confirmation cases and a passing
local build. All 12 post-repair narrow-grid layout cases passed. Eight actual
local browser cases passed: four start-preview responses (200) with
`canConfirm: false`, and four historical plan-preview rejections (404). The fixture
has no plan revision; these cases do not qualify a successful real plan preview
or a real mutation. At that historical checkpoint, complete-gate and real
confirmation acceptance were open; the later `af8f374` gate and integrated
browser evidence qualify their own scope. Device/provider/deployed and release
acceptance remain open.

**Historical exact-head CI blocker at `2060c745`.** [Run 37918377223](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/37918377223)
on `2060c745376862a379e8c952ee87c05d49982e02` finished with one source test failing:
`worker/export-v21-protocol.test.ts`, “restores original registration and exact source
rowids with no local credentials or execution”, timed out at the default **5,000 ms**.
It recorded **3,335 passed / 1 failed** source tests (351/351 native script tests
passed). Later dependent checks were skipped; their red status contexts are not
separate demonstrated product defects. The 5E local source qualification explicitly
used two workers and a **15,000 ms** test timeout, and its staged results cannot be
equated with this default-CI run. The later qualified default `af8f374` gate
preserves its own successful result without erasing this failure. A larger
timeout alone is not a performance correction.

**Historical live state, not synchronized local state.** The 2026-10-03 browser
readback reported File authority Active/execution Enabled, both roles R2, and shadow
maintenance **4 resolved / 5 current / 1 pending / 0 unfinished**. The pending
source remains unidentified; investigate read-only before any corrective operation.
The development database, after its locally qualified upgrades, is recorded in
`legacy` mode with execution **disabled**. Do not copy authority/runtime state
between these environments. Source-specific evidence remains in
[the S2 checkpoint](./CLOUDFLARE_S2_ACTIVATION_CHECKPOINT.md),
[FP1 acceptance](./FP1_R2_ROLE_DEFAULTS.md) and the linked synchronized
acceptance records. The previously owner-waived live V20 ZIP exercise remains waived
for unrelated work; significant new persistence/recovery generations need their
own appropriate qualification.

## Near-term order and first integrated release

The former “performance → implement FP2 → first FP1/FP2 release → implement FP3–FP5”
sequence described the earlier integration branch, **not** the synchronized work.
FP2–FP5, C4, 5D and 5E are no longer pending development tasks.
Maintain a separate integration/release acceptance ledger for each capability;
an unqualified feature is implemented-but-not-approved, not “not started”.

| Order | Work | Finite exit / release rule |
| --- | --- | --- |
| Complete | Review and integrate implementation and accepted planning | #250 planning and #251 implementation are merged. Preserve the reviewed migrations/recovery pairs, qualified `af8f374` receipts and identical merged `aa497d9` tree; later changes need independent checks. |
| 2 | Continue Phase **5F**, in bounded integration slices | 5F-1 common cross-page language/action ownership; 5F-2 navigation, read/retry, uncertain-write and recovery boundaries; 5F-3 representative responsive/theme/input and mixed-record acceptance. Repair observed gaps, not every old style. |
| Parallel finite lane | Measured performance and redundancy cleanup | Attribute CI fixture cost, multi-card save requests, duplicate projections, Processing refresh and archive maintenance on the synchronized head. Preserve fault/retention/security coverage. No open-ended optimization phase. |
| 3 | **6A6** stabilization exit and **6B** release validation | Qualify a merged/reviewed tree, fresh and populated migrations, exact-head complete gates, realistic browser/device cases and explicit **enabled FP2–FP5** capability boundaries. Finish real-provider/deployed/operational acceptance **before enabling** a capability. |
| 4 | First integrated V3 release to `main` | Candidate scope includes implemented FP2–FP5 plus existing product. Release only capabilities whose actual enablement gates pass; others stay clearly labeled unavailable or deferred with effective server-side restrictions. Reconcile `main` ancestry and document deployment handoff. |
| Later | Node/Docker/local and small-group resource authorization | Complete application/runtime/SQLite/local volumes, real cross-deployment recovery, then membership and domain authorization. Node File job-runner tests alone are not complete self-hosting. |

The first release is **not automatically FP2–FP5 fully enabled**. Any missing
real-provider qualification, installed credential binding, deployed schedule,
device evidence or assisted recovery procedure must be documented and enforced
at the server boundary. Cloudflare resource provisioning and binding changes
remain deployment operations. Changing storage defaults selects only *newly
accepted* writes; it never moves previous File locations. FP3 provides explicit
verified migration. A fresh-copy FP4 import allocates new identities; FP5
identity-preserving recovery restores an installation into an empty qualified
target. Keep those operations visibly separate.

### Performance and redundancy programme

Keep the existing lazy Map bundle, memoized/culling node strategy, contextual
zoom, TIFF Worker queue and bounded native research archive engine as delivered
baseline. Measure named device/browser/network, cold/warm opens, long tasks,
React commits, network requests/bytes, save-ACK time, D1 reads/rows and peak
archive/job memory. Use fixed small, **250-node/400-edge**, **500-node/800-edge**
Projects and an eight-sample Processing workspace. Compare the same workload
before and after each change; local SQLite timings do not establish deployment
latency.

| Priority | Candidate | Exit and preservation rule |
| --- | --- | --- |
| P0 | Remote CI stability/fixture cost | Preserve the complete default local/remote qualification at `af8f374`, then measure remaining fixture cost; the default Vitest deadline stays at 5 seconds and existing case-specific limits are unchanged. Retain exact migration upgrades, corrupt-data failures, real native fixtures, test isolation and required status mapping. A larger whole-job budget alone is not a performance correction. |
| P1 | Multi-card placement save | Existing [scale acceptance](./BACKEND_RELIABILITY_ACCEPTANCE.md) records 250/500 serial placement PATCHes. Re-measure synchronized code; only if requests dominate, introduce independently reviewed bounded batch geometry preserving revision conflicts, lost ACKs, retry identities, undo and Saved state. |
| Delivered | Map/Reading repeated derivation | Shared canonical descriptors are integrated in #251; retain Reading order and stable geometry/object identities. Further changes require a new measured bottleneck. |
| Single-owner measured; next separate group slice | Processing reload scope | Actual `ee171339` single-owner Save reduced 8 GETs / 26,170 bytes to 1 GET / 3,329 bytes; six cost phases passed 8,0,1,8,7,8 reads. A three-owner group still refetches eight owners; private 29-test/type candidate targets 3 reads and needs actual new-artifact acceptance. Preserve shared-operation ownership, stale-read protection and grid/dialog state. |
| P2 | Export/version maintenance | Review repeated mechanics across frozen V19–V24 snapshot/validator generations. Extract only behaviorally identical utilities; preserve each immutable catalog/fingerprint, supported reader, exclusions and accepted receipt/hold invariants. |
| P2 | FP3–FP5 runner and archive efficiency | **Reuse** the already implemented bounded streaming and persistent job execution; profile hashing, source readback, provider latency, memory and per-step budgets. The legacy browser ZIP path may need its *own* memory ceiling; do not describe all native packages as in-memory ZIPs. |
| Conditional | Alignment, ranked reference search and FTS | Inspect traces and query plans first. New indexes/cache/FTS are not release gates without demonstrated benefit. |

Historical [#249 verification](https://github.com/BeiqiD/sample-fabrication-workflow/actions/runs/37147477245)
took 17 min 31 s with source, native and mounted suites consuming most time.
That is a dated **different-code** measurement, not the synchronized benchmark.
The historical `2060c745` remote source stage passed 3,335 tests but failed one;
`4479295` later exhausted the 20-minute job budget without a specific test-failure
annotation. Record new complete-gate resource use only after exact-head qualification.

### Redundancy removal boundaries

Eliminate repeated pure projections, unnecessary reloads, equivalent helpers
and stale moving-status paragraphs. Keep one current status matrix here;
companion plans own domain contracts and dated acceptance records.

Already implemented elsewhere: native S3 File read/write/default selection,
per-purpose accepted targets, persistent migration jobs, paired Sample+Project
packages, website recovery, 5D attachment/media controls, 5E read-state and
stale-response guards, and native bounded streaming. **Do not recreate them.**

Do **not** remove final asynchronous authority/lease/retention checks,
immutable receipts, source holds, historical migrations, versioned archive
readers or frozen compatibility checks as “duplicate code”. Retire live legacy
consumers only after an explicit reader/writer/retry/GC/export/recovery
inventory and populated forward-upgrade plan. Neither source-file size nor
SQL trigger count is an optimization KPI. Retain the modular Worker and
D1/SQLite unless measurements justify a fundamental alternative.

### FP2 completion units

**Historical implementation scope now satisfied locally**, not a new
implementation queue. The synchronized `0018`/V21 generation implements
native File access, read/write, publication and lifecycle with independent
internal/original defaults; the FabuBlox per-purpose frozen target distinction
is covered in the local implementation and acceptance records. Existing accepted
operations and old File locations remain exact. The synchronized FP3 migration
does not silently move bytes on default edits.

**Integrated through #251 with full local/default remote checks. Still open:**
real AWS account and deployed provider/namespace/credential qualification,
operational activation and actual deployed nonempty recovery. Generic S3/WebDAV support needs its own
proof; qualifying an AWS fixture does not certify every S3-compatible service.
The 2026-10-03 deployment still represents **V20 / 0017**, where the native S3
File capability was **not** available on that historical version. Treat FP2 as
**development integrated and CI-qualified, operational release admission open**.

## North star

Sample Fabrication Workflow should become a **sample-centered source of truth
with a Project-centered research workspace** for small research groups.

The finished product has two deliberately different layers:

1. **Experimental source record** — Samples, Recipes, Runs, Steps, Comments,
   attachments, metrology records, structures, and timelines record what was
   planned and what actually happened.
2. **Project workspace** — a Project combines read-only references to those
   records with Project-owned Markdown and generic attachments so a researcher
   can spatially organize, explain, connect, and linearly review a body of work
   without copying or rewriting the source record.

The source layer answers:

> What happened to this physical sample, and what is the durable evidence?

The Project layer answers:

> What belongs to this research question, how do the pieces relate spatially,
> and how should another researcher read them in sequence?

Neither layer replaces the other.

## Intended final interaction

Map is the primary Project creation and organization interface. Reading is a
linear projection of the same Project-local item occurrences; it is not an
independent document or second content model.

```text
Project
├─ Map
│  ├─ reference sidebar / search
│  ├─ drag references to exact positions
│  ├─ double-click empty space to create Markdown
│  ├─ add generic attachments
│  ├─ resize and move nodes
│  └─ connect nodes with basic directed/undirected edges
├─ Reading
│  ├─ render the same occurrences in one linear order
│  ├─ edit existing Project-owned Markdown
│  ├─ edit allowed attachment metadata
│  └─ add occurrences through Add and follow immutable insertion order
└─ Inspector
   └─ detail, source hierarchy, exact navigation, and local actions
```

A user should remain in one Project, find any eligible referenceable object in
the sidebar, drag or place it onto the Map, and receive a new Project-local
occurrence only after one authoritative server operation succeeds.

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
- a Canvas whose serialized frontend state is the database model;
- a page-layout or desktop-publishing application;
- a real-time collaborative whiteboard in the initial release;
- an autonomous LLM-operated experimental system.

Project-owned content is initially limited to Markdown and generic attachment
occurrences. All existing experimental records and source attachments remain
read-only references.

## Durable architectural invariants

All future phases preserve these rules:

1. **Source data remains authoritative.** Project stores occurrences,
   Project-owned content, placements, and local relationships; it does not copy
   external source records into editable snapshots.
2. **Identity layers remain separate.** Source/content identity,
   `reference_targets`, Project-item occurrence identity, and Map placement
   identity are not collapsed into one row or one React Flow node.
3. **Map and Reading share content.** Every committed active Project item
   occurrence has a Map placement and automatically appears in Reading by
   immutable creation sequence. SQLite constrains placement cardinality to zero
   or one; the authoritative item-creation transaction provides the stronger
   exactly-one product guarantee. Editing content once updates both projections.
4. **Repeated references are allowed.** One reference target may have several
   independent occurrences in the same Project; no Project-level uniqueness
   constraint is added.
5. **References have no local annotation override.** Interpretation is expressed
   through separate Markdown occurrences or optional edge labels.
6. **Search is a shared capability.** Project discovery, directories, and future
   pickers may use different eligibility profiles but should not grow unrelated
   matching/ranking engines.
7. **Search indexes are derived.** A future FTS5 or other index can be rebuilt
   from authoritative rows and does not own lifecycle or identity.
8. **Delete remains recoverable by default.** Permanent deletion stays disabled
   until Project reverse relations, privileged authorization, tombstones, and
   final concurrency checks exist.
9. **Export and import evolve with the model.** Preserve existing complete-export
   coverage as schemas change. A native Sample/Project package is human-readable
   and has a matching website importer in the same milestone; report export and
   privileged full backup/restore share infrastructure but have different identity
   and authorization semantics.
10. **Platform contracts stay portable.** Cloudflare is the current deployment,
    not the domain model. New code avoids unnecessary D1, R2, Access, Queue, or
    Worker coupling outside adapters and runtime boundaries.
11. **Collaboration is reserved, not implemented.** Stable IDs, monotonic
    optimistic revisions, idempotent operations, and conflict responses preserve
    a future path without introducing CRDT/OT or live presence now.
12. **All managed persistent files are portable.** Purpose determines the `internal`/`originals` write
    policy, not whether a file is migratable. Logical file identity is separate
    from physical locations and configured storage profiles. Changing defaults
    affects new writes; verified migration is explicit and preserves references.
13. **Storage does not grant access.** Domain authorization governs every file
    read, export and mutation. Storage/secret/migration/restore administration
    requires an explicit administrator boundary before write endpoints ship.
14. **LLM capability is read-only and explicit.** A later insight feature may
    summarize or connect user-selected Project content, but it does not mutate
    source records or silently add Project items.

## Current position

### Completed foundation

The following prerequisites are complete on `v2/backend-foundation`:

- stable source and occurrence identities;
- recoverable source deletion and restoration;
- canonical Comment and attachment-occurrence semantics;
- shared blob reachability, GC ledger, export integrity, physical-delete
  protection, and provider-verified deduplication with integrity quarantine;
- sparse immutable reference registry;
- bounded batch resolver over nine existing target types;
- lifecycle-aware canonical Reference URLs;
- exact Step, Comment, attachment, execution-image, and metrology source focus;
- deterministic read-only reference search with portable candidate backend,
  stable ranking, lifecycle filtering, and real Worker/D1 verification;
- reusable `ReferenceSearchSurface`, stable `ReferenceTarget` selection,
  controlled request/filter state, and the temporary `/search` integration
  browser implemented in PR #130;
- normalized Project schema, bounded placement and safe-integer contracts,
  attachment/blob retention, and complete export schema version 4 implemented
  in PR #131;
- authoritative Project CRUD, normalized active and Trash snapshots,
  rollback-safe item-plus-placement creation, bounded retry idempotency,
  attachment media, and basic graph mutations implemented in PR #132;
- desktop React Flow Map kernel, normalized geometry save/undo state,
  navigation protection, and mobile occurrence projection implemented and
  squash-merged in PR #133;
- Project reference sidebar, exact Map placement, repeated occurrence handling,
  uncertain-result reconciliation, Project-local removal, and the permanent
  `pre-pr/project-reference-placement` gate completed in PR #134.

These foundation and discovery-enabling phases are closed. They should receive
correctness fixes but must not continue expanding into independent product areas.
Phase 3B3 Project-owned Markdown and generic attachment creation is complete in
squash-merged PR #135. Phase 3B4 basic Project-local edges are complete in
squash-merged PR #136. Phase 3C Reading projection is complete in squash-merged
PR #138. The bounded Project-stability work in PRs #139/#140 and the storage-
integrity/recovery track in PR #141 are also complete. Phase 3D Markdown/TeX,
mixed-media presentation, save/conflict behavior, and human-readable export are
complete in PR #143, with the shared safe renderer extended to Comment read
surfaces in PR #144. Phase 4A1 canonical Project occurrence focus is complete in
PR #145, Phase 4A2 Inspector hierarchy, provenance, type-specific detail, and
exact source navigation are complete in PR #146, and Phase 4A3 authoritative child-
reference insertion is complete in PR #147. It adds authoritative direct-child
discovery inside the Inspector while reusing the existing Project placement
transaction and retry/reconciliation state machine. Phase 4B1 Canvas
multi-selection and grouped geometry are complete in PR #148. Phase 4B2 authoritative copy/paste is complete in PR #149. Phase 4B3 alignment assistance and explicit z-order are complete in PR #150.
Phase 4C representative-scale Map performance, contextual zoom, and final v1
include/defer decisions are complete in PR #151. Attachment lifecycle Slice A,
shared ingestion Slice B, and occurrence-metadata Slice C are complete in PRs
#152/#153/#154. The bounded shared-derivative registry/resolver/export foundation
is complete in PR #155, including the client-preview trust boundary and complete
export schema v7. Trusted server-side generation remains a separately justified
follow-up. Phase 5 execution planning is complete in PR #156. Phase 5A Project
workspace shell and state hierarchy is complete in PR #157; its exact-head review
found no concrete A2 follow-up. Phase 5B1 occurrence identity language and
Phase 5B2 edge theme/mutation-state language and Phase 5B3 Project-owned editor
outcome feedback are complete in PRs #158/#159/#160; no B4 is currently required.
The materially larger Project composition gap is authorized as Phase 5C. Its C0
contract is complete in PR #161, and its C1 viewport-frame implementation is
complete in PR #162. Phase 5C2a floating panels and context-aware Canvas commands
are complete in PR #163; Phase 5C2b.1 Reference discovery and Inspector hierarchy
is complete in PR #166. C2b.2 Add/workspace controls and C2b.3 quick actions merged
in PR #168, which also incorporates the user-authorized
Markdown/math, editing, placement, reconnection and Trash recovery repairs.
C3 Reading details and responsive panels merged in PR #169. PR #170 merged the
whole-card gesture, interrupted-interaction, mathematical-reference preview and
first-activation repairs. Historical evidence remains in
[Project interaction repair acceptance](./PROJECT_UX_REPAIR_ACCEPTANCE.md),
[C3 acceptance](./PROJECT_C3_ACCEPTANCE.md), and
[card gesture acceptance](./PROJECT_CARD_GESTURE_ACCEPTANCE.md).
[C4 integration acceptance](./PROJECT_C4_ACCEPTANCE.md) is now in progress;
these merges do not complete C4 or establish a release milestone.
The completed Reference and rich-content foundations remain correctness baselines.
The newly planned FP track deliberately extends file/storage and export behavior;
it preserves the lifecycle, integrity, concurrency and ownership guarantees
already delivered, while replacing provider-specific persistence where required.
It does not mark any earlier storage feature as unimplemented.

## Active implementation roadmap

### Phase 2C2 — reusable Project discovery surface

**Status:** complete in PR #130.

**Delivered:**

- reusable browse/select search surface;
- stable target selection output;
- deterministic server-order result presentation;
- filters, retry, cancellation, empty/error/truncation states;
- temporary `/search` integration harness;
- no registration, Project write, or `Add to project` success state.

**Exit:** complete. Work moves directly to Project schema and Canvas contracts,
not additional standalone Search features.

### Phase 3A — Project core persistence

**Goal:** establish normalized Project identities, complete export, and the
single authoritative save protocol required by both Map and Reading before React
Flow or a Markdown editor is introduced.

Phase 3A is deliberately split at the schema/service boundary.

#### Phase 3A1 — schema, export, and blob-safety foundation

**Status:** implemented in PR #131.

**Scope:**

- `projects` with stable identity and recoverable deletion;
- `project_contents` for Markdown and generic attachment ownership;
- revisioned attachment caption/source URL on the content record;
- immutable intrinsic attachment locator/name/type/size metadata using existing
  blob/storage contracts;
- `project_items` as repeatable Project-local occurrences targeting content XOR
  `reference_targets`;
- immutable per-Project `created_sequence` on each item occurrence for Reading;
- zero-or-one `project_map_placements` row per item at the database layer, with
  finite bounded coordinates, dimensions, and z-index;
- `project_edges` with fixed four-side handles, endpoint marker direction, and
  optional short label;
- no uniqueness constraint on `(project_id, reference_target_id)`;
- monotonic revisions that cannot be rewound, pre-bumped, or reused;
- complete-export schema-version bump and Project table/blob coverage;
- migration, host SQLite, D1/workerd, route, and export gates;
- no Project mutation routes.

**Exit:** the schema, export snapshot, and blob graph can be deployed safely, and
every invariant that belongs in SQLite is executable before application writes
are exposed.

#### Phase 3A2 — authoritative Project persistence service

**Status:** implemented in PR #132.

**Scope:**

- Project list, create, open, rename, recoverable delete, and restore;
- one Project snapshot/read model for Map and Reading, plus an explicit
  `includeDeleted=1` Trash snapshot that keeps recoverable child rows discoverable;
- object-owned expected revisions, bounded retry idempotency through stable IDs
  and current-row operation IDs, and explicit `409` conflict behavior;
- one authoritative reference insertion operation that re-resolves, registers,
  allocates `created_sequence`, creates the occurrence, and creates its Map
  placement in one rollback-safe transaction;
- Project-owned Markdown creation and save APIs;
- Project-owned attachment creation plus caption/source-URL update APIs;
- local occurrence removal without source mutation;
- placement and basic-edge mutation APIs;
- normalized delta/save APIs and explicit-save/autosave flush boundaries;
- transaction, concurrency, route, workerd, and exact-head deployment gates.

**Not yet:** React Flow, rich Markdown editor, PDF preview, advanced Inspector,
real-time collaboration, or permanent delete.

**Phase 3A exit:** the backend can create a Project, create owned content, insert
repeated references, persist Map placements and basic edges, derive Reading from
creation sequence, save safely, reopen the Project, and export it completely.

### Phase 3B1 — Map kernel

**Status:** complete; squash-merged in PR #133.

**Goal:** deliver the primary Project interaction surface without yet combining
all creation modes.

**Scope:**

- replace the temporary Search navigation destination with Project;
- Project list/create/open shell;
- dynamically load `@xyflow/react` only for desktop Map editing;
- pan, zoom, selection, fit view, and optional lightweight MiniMap;
- lightweight Markdown, attachment, and reference node renderers;
- move and border resize with unchanged font size;
- one active editor at most;
- local draft plus explicit Save and bounded autosave state;
- persist placement at drag stop/resize end rather than per frame;
- client-session undo/redo for move/resize/selectable local commands;
- simple Inspector selection shell;
- Reading-only default on mobile.

**Exit:** complete. Existing Project item occurrences can be viewed, moved,
resized, saved, and reopened through the desktop Map without React Flow state
becoming the database.

### Phase 3B2 — reference sidebar and Map placement

**Status:** complete; squash-merged in PR #134.

**Goal:** make reference discovery and spatial placement the core Project
creation flow.

**Scope:**

- mount `ReferenceSearchSurface` in the Project sidebar/operation area;
- desktop drag result to exact Map coordinate;
- keyboard-equivalent `Place at Map center` action;
- pending ghost node and explicit known-failure/uncertain-result behavior;
- authoritative server insertion after drop, never at drag start;
- exact replay/reconciliation before an uncertain insertion may be cancelled;
- Project-local removal with exact retry identity and Map geometry freeze while
  the removal outcome is unresolved;
- hover/selected/focused `Open reference` action;
- node body selects rather than navigates;
- allow repeated occurrences of the same reference target;
- make the new occurrence appear in Reading automatically through creation sequence;
- permanent `pre-pr/project-reference-placement` CI coverage.

**Exit:** complete. A user can stay inside a Project, find any supported source
object, place it on the Map, safely reconcile response-loss cases, reopen the
Project, and remove the local occurrence without changing source data or racing
stale geometry writes.

This milestone is the first useful **Project reference-workspace alpha**.

### Phase 3B3 — Project-owned Markdown and generic attachments

**Status:** complete; squash-merged in PR #135.

**Goal:** allow the Map to create the only two Project-owned content classes.

**Scope:**

- double-click empty Map space to create and focus a local Markdown draft;
- cancel unsaved empty drafts and persist valid content;
- explicit `Add attachment` and context-menu insertion at a coordinate;
- generic file metadata and image-rich rendering;
- editable Project-owned caption and optional source URL without changing the
  immutable stored-file locator or intrinsic name/type/size metadata;
- existing source attachments continue to enter through Reference search;
- same occurrence automatically appears in Reading by creation sequence;
- no complex page layout, floating images, or embedded Reference editor nodes.

**Exit:** a Project can spatially combine read-only experimental references,
editable Markdown, images, PDFs as file cards, and other generic files.

### Phase 3B4 — basic Project-local edges

**Status:** complete; squash-merged in PR #136.

**Goal:** support Obsidian-Canvas-like relationship drawing without advanced
routing complexity.

**Scope:**

- Bezier edges only;
- top/right/bottom/left handles;
- fixed endpoints and handles after connection;
- undirected, forward, reverse, and bidirectional endpoint markers;
- optional short free-text label;
- delete/recreate to change endpoints;
- no self-loop, obstacle avoidance, control-point editing, or relation ontology;
- client-session undo/redo and save/conflict behavior for edge changes.

**Exit:** the Map expresses complex Project-local relationships using a bounded,
normalized edge model.

This milestone is the **Map-first Project workspace alpha**.

### Phase 3C — Reading projection

**Status:** complete; squash-merged in PR #138, with Markdown removal lifecycle
wiring completed in the subsequent storage-integrity maintenance slice.

**Goal:** provide a mobile-friendly and linear review/editing projection over the
same occurrences without creating a second content system.

**Scope:**

- render every active occurrence in one linear order;
- no creation controls in Reading;
- edit and recoverably remove existing Project-owned Markdown;
- edit attachment caption and optional source URL, but never retarget attachment
  bytes or intrinsic file metadata;
- references remain read-only;
- fixed deterministic insertion-order presentation;
- Map coordinates and edges remain intact;
- mobile defaults to Reading with limited editing only.

Reading initially uses immutable insertion sequence only. Phase 3A adds no
Reading-placement table, manual reorder, edge-order field, topological sort, or
cycle UX. A later dedicated design may add custom or edge-informed ordering if
real Project use demonstrates the need.

**Exit:** the complete Project can be read and lightly edited linearly without
losing or duplicating Map content.

### Phase 3D — Markdown/TeX, media, and save UX hardening

**Status:** complete in PR #143; shared Project/Comment presentation reuse completed in PR #144.

**Goal:** make owned content comfortable for real research narrative.

**Scope:**

- canonical Markdown storage with CommonMark/GFM-style behavior;
- TeX math rendering;
- lazy editor loading for only the active node/block;
- complete Reading rendering independent of Map node size;
- image preview and caption UX;
- generic file cards;
- conflict resolution and save-status UX;
- coarse Project checkpoints/version snapshots only if needed;
- human-readable export with relative attachment paths.

**Exit:** the Project supports durable mixed-media research narrative without a
mega-editor or page-layout system.

This milestone is the **Project MVP**.

### Phase 4 — complete the v1 functional shape

**Goal:** finish the interaction-shaping features that would otherwise force major
page or component restructuring after visual refinement begins.

Phase 4 is deliberately about **functional completeness**, not final visual polish.
Candidate features do not automatically become release blockers: only capabilities
that real use shows are necessary for the v1 interaction model must land before the
feature freeze.

#### Phase 4A — Inspector and navigation completeness

**Status:** complete through PR #147; Phase 4A1, Phase 4A2, and Phase 4A3 are complete.

**Scope:**

- deeper Inspector with clear source hierarchy and Project-local context;
- Project/item canonical destinations and exact focus/navigation;
- child-reference insertion through the existing authoritative reference path;
- fuller Inspector/modal media preview where it materially improves research use;
- PDF first-page thumbnail if it proves useful for routine inspection;
- webpage screenshot capture only after a security review; no live iframe contract.

**Exit:** inspection and navigation no longer require a later structural redesign of
the Project workspace.

#### Phase 4B — Canvas productivity

**Status:** complete in PRs #148–#150. Phase 4B1 delivered multi-selection and grouped geometry, Phase 4B2 delivered authoritative copy/paste, and Phase 4B3 delivered transient alignment assistance plus explicit z-order without changing the normalized persistence model.

The detailed slice boundaries and persistence constraints are recorded in
[Project Canvas productivity implementation plan](./PROJECT_CANVAS_PRODUCTIVITY_IMPLEMENTATION_PLAN.md), with the frozen Phase 4B2 authorization and retry model in
[Project Canvas authoritative copy/paste contract](./PROJECT_CANVAS_COPY_PASTE_CONTRACT.md).

**Scope:**

- multi-select;
- copy/paste;
- keyboard shortcuts;
- helper/alignment lines;
- explicit z-order controls;
- groups/frames only if real Project use demonstrates a need;
- preserve the normalized occurrence/placement/edge model and existing save
  contracts rather than introducing a frontend-owned Canvas document.

**Exit:** common spatial editing workflows are efficient enough for sustained daily
use without adding general-purpose whiteboard complexity.

#### Phase 4C — performance and final functional gaps

**Status:** complete in PR #151.

**Delivered:**

- contextual `overview`, `compact`, and `full` node/edge presentation with zoom
  hysteresis and no persistence effect;
- memoized node rendering and selection projection that preserves untouched node
  object identity;
- target/envelope-only visible-element rendering for 200–300 node / 300–500 edge
  Projects and the 500-node / 800-edge envelope;
- mounted representative-scale contracts plus a permanent
  `pre-pr/project-map-performance` gate;
- explicit v1 decisions to defer groups/frames, richer non-image previewers, custom
  Reading order, JSON Canvas integration, semantic search, and automatic layout.

The detailed performance and decision boundary is recorded in
[Project Map performance and v1 functional-shape plan](./PROJECT_MAP_PERFORMANCE_IMPLEMENTATION_PLAN.md).

**Exit:** implemented. The same Project occurrences support the intended v1 spatial,
inspection, navigation, and linear-reading workflow at representative scale.

This milestone is the **Project v1 functional shape**.

### V1 feature freeze

**Status:** complete after merged PR #152. Slices B/C and the bounded Slice D
foundation are internal post-freeze backend work and do not reopen the
interaction feature set.

After Phase 4, freeze the interaction-shaping v1 feature set before systematic
frontend refinement begins.

"Feature complete" here means that the capabilities which determine the main page
structure and interaction model are present and stable: Samples/Processing/Recipes,
Project Map, Reading, Inspector, Markdown/media, References, edges, and the selected
v1 Canvas productivity operations. It does **not** mean every future optional
capability has been implemented.

After the freeze:

- avoid adding features that require major page/component restructuring during the
  refinement pass;
- continue correctness, accessibility, performance, and release-blocking fixes;
- defer optional integrations and speculative capabilities instead of reopening the
  v1 interaction model.

The proposed FP track, after review, is a separately scoped exception for file/data-control
capabilities and Settings. It does not reopen Project Map/Reading identities or
Canvas composition. Its necessary UI ships with the capability; remaining Phase 5
work refines the integrated surfaces without reimplementing their backend.

### Phase 5 — frontend refinement

**Status:** prior Phase 5A–5C implementation through #185 is merged/deployed.
The synchronized branch now also records **bounded local C4, 5D and 5E
development completion**, without claiming device/deployed acceptance. **5F is
in progress**, with bounded implementation and follow-up research/job-control
read-ownership repairs committed and pushed.
Complete 5F qualification remains open. See the dated acceptance records;
do not restart 5D or 5E because this integration-base document predates sync.

The bounded slice order and review contract are recorded in
[frontend refinement implementation plan](./FRONTEND_REFINEMENT_IMPLEMENTATION_PLAN.md).

**Goal:** refine the complete product as one visual and interaction system after its
functional shape is stable.

Phase 5 is intentionally separate from Phase 3D. Phase 3D still owns **functional
UX** required for correctness and usability, such as editor loading, Markdown/TeX
rendering, save/conflict behavior, and media presentation. Phase 5 owns the
systematic whole-product refinement that would be wasteful while major features are
still changing.

**Scope:**

- typography and information hierarchy;
- spacing, density, surfaces, borders, shadows, and panel composition;
- final button, icon, status, and semantic-color consistency;
- hover, selected, focused, disabled, loading, empty, error, and conflict states;
- final Map-node, edge, Inspector, sidebar, dialog, and Reading visual language;
- desktop/mobile responsive consistency across realistic content sizes;
- restrained transitions and interaction feedback where they improve comprehension;
- keyboard/focus/accessibility polish;
- wording, labels, and microcopy consistency across the whole product;
- cross-page visual review so old and new UI conventions cannot coexist unnoticed.

**Current Project priority:** Phase 5C is a deliberate Project-scoped layout and
control rebuild, not a functional feature phase. The merged slices replace the
centered page-within-a-card composition with a workspace-first shell, give Map
the complete desktop workspace below Project chrome, give Reading an independent
document layout, and float References/Inspector above the Canvas without resizing
it. Desktop Map panels remain non-modal so visible Canvas drag and selection
continue; only mobile Reading-first sheets use modal behavior. The detailed boundary is recorded in the
[Project workspace layout and control contract](./PROJECT_WORKSPACE_LAYOUT_CONTRACT.md).
The implemented C2b controls make Reference discovery useful before search,
prioritize Inspector content and give mode, toolbar, panel, content, destructive
and overflow actions explicit roles. The 2026-09-11 user-authorized repair amendment
extends that slice to safe editing, placement, endpoint reconnection and recovery;
see the implementation plan for its bounded exceptions to the earlier freeze.
C3 implements Reading detail composition and modal mobile panels; its automated
and browser evidence is recorded in `PROJECT_C3_ACCEPTANCE.md`. The PR #170
follow-up is recorded in `PROJECT_CARD_GESTURE_ACCEPTANCE.md`. C4 records the
integrated Project workflow and served version, with results and remaining limits
in `PROJECT_C4_ACCEPTANCE.md`. Shortcuts and help were delivered in #175; #176 and
#183 corrected history availability and native panel key ownership. They are
implemented baseline behavior, not an unstarted work item. Subsequent refinements
cover editing resize (#180), Markdown composition (#181), the leave dialog and
Inspector disclosures (#182/#183), shared panel state and combined Markdown
double-click (#184), and equal panel widths plus Sample note source-focus layout
(#185). Desktop browser evidence is recorded per deployed version; physical OS
IME, wider device/viewport and other unverified C4 cases remain explicit. Existing
identity, source hierarchy and performance contracts continue to govern this review.

Phase 5D and Phase 5E are **locally complete on the synchronized branch**,
with remaining real-device/deployment/cross-surface acceptance. Phase 5F is
in progress and also reviews enabled FP2–FP5 Settings,
migration, export and recovery entry points. This is not authorization for a
whole-product visual rewrite or a repeat of finished keyboard/panel work.
Functional provider, upload, migration and recovery engines stay owned by FP;
Phase 5 owns presentation consistency and operator comprehension.

The historical narrow four-column Process width override discrepancy is repaired
in the integrated 5F slice: at `<=720px`, `.sample-count-4` now shares the
88/270px recipe/Sample widths with counts 1–3. Phase 5E had preserved the earlier
230/300px four-column baseline. Twelve post-repair layout cases and the later
mixed light/dark 720/721/1200 built-Worker browser cases retain their separate
receipts. Preserve this bounded correction rather than schedule it again.

**Exit:** the frozen v1 feature set reads and behaves as one coherent product rather
than a sequence of independently implemented phases.

### Phase 6 — architecture stabilization and release hardening

Backend Phase 6A precedes the remaining frontend refinement. Its late S2/6A6
acceptance remains open. FP is a separate, reviewed capability track; Phase 6B
requires the completed stabilization result, all enabled FP scope and Phase 5F's
final frontend baseline. The two gates remain distinct so early backend probes cannot
be mistaken for final release qualification.

#### Phase 6A — V3 architecture stabilization

The scope below records the delivered ownership/extraction and selected S2
baseline work. The remaining task is the 6A6 exit review and integrated
qualification of that baseline plus forward migrations, not a second extraction
or replacement baseline.

**Goal:** preserve the verified v1 behavior while establishing explicit module
ownership, a bounded Web/Worker contract surface, a final pre-release schema, and
one clean V3 migration baseline before persistent V3 activation.

**Scope:**

- characterize the current dependency, route, SQL, compatibility-field, and
  migration boundaries, including Project command/journal/snapshot ownership;
- extract remaining Sample, Execution, Process-definition, import, export, and
  asset routes from `worker/index.ts` through behavior-preserving PRs;
- separate stable contracts and pure shared algorithms without requiring a
  repository-wide monorepo conversion;
- remove only explicitly verified compatibility fields;
- build and verify `0001_v3_baseline.sql` against the expected final schema;
- distinguish disposable integration-test databases from retained-data targets,
  and verify the appropriate rebuild/recovery or upgrade path for each;
- update migration, export, deployment, backup, and recovery gates without remote
  side effects.

The bounded sequence, protected invariants, decision gates, and explicit
non-goals are defined in
[V3 architecture stabilization plan](./V3_ARCHITECTURE_STABILIZATION_PLAN.md).

**Exit:** the existing V3 implementation is modularized without a rewrite, the
approved compatibility state is removed and the S2 baseline is qualified. Final
integrated acceptance also verifies the baseline plus any reviewed FP forward
migrations from empty and populated databases; it does not replace the baseline.
Every permanent gate and required browser check must pass for the tested scope.

#### Phase 6B — release validation and operational rehearsal

**Goal:** validate the stabilized and refined v1 with realistic use before
treating it as a release candidate.

**Scope:**

- sustained testing with representative real research data and Projects;
- desktop/mobile and supported-browser regression passes;
- performance regression and large-Project checks;
- version-appropriate backup/recovery, human-readable reports, native package
  export/website import and privileged restore rehearsal for enabled FP scope;
- non-empty file cases across configured storage roles, destination verification,
  reference preservation and deletion protection; migration/job interruption is
  a 6B gate **if FP3 is enabled in that release**, not an unstarted future implementation;
- isolated migration/deployment/runbook verification;
- recovery when an old tab requests an unavailable lazy route/editor chunk after
  deployment or a temporary network failure: clear retry/refresh without reload
  loops, lost dirty drafts or discarded accepted-operation checkpoints;
- accessibility and security review of the final interaction surface;
- release-blocking bug fixing without reopening optional feature development.

**Exit:** a release candidate is functionally stable, visually coherent,
architecturally bounded, operationally rehearsed, and suitable for longer
real-world use.

## Save, history, and collaboration direction

The initial editor uses:

```text
local draft
+ pending normalized deltas
+ explicit Save
+ bounded autosave at idle and semantic operation boundaries
```

Drag/resize do not write per frame. Reference drop and creation are high-priority
save operations. Undo/redo is client-session only.

Permanent operation history is not required. A later coarse checkpoint/version
feature may retain meaningful Project snapshots, but it is distinct from session
undo and does not promise restoration to every intermediate drag or keystroke.

Real-time collaboration is deferred. Stable IDs, optimistic revisions,
`updated_by`, idempotent operation IDs, and explicit `409` conflicts are required
now so a future collaboration project does not need to replace the data model.

## Parallel platform and quality tracks

### Portability and Docker distribution

The FP design establishes runtime-neutral file, configuration, job and package
contracts now. Its Cloudflare implementation uses D1 and the existing R2 binding
as both initial file-role defaults. External S3/WebDAV profiles are optional;
no ordinary image or original is permanently tied to R2.

The later portability milestone implements the same application on Node with
ordinary SQLite and persistent local storage, with both roles defaulting to
local storage. It covers streaming, bounded job scheduling/recovery,
authentication, encrypted secrets, backups, volume persistence and deployment
upgrades. Keep platform adapters explicit; do not build a second domain model.

Design acceptance can establish that packages identify logical files rather than
Cloudflare addresses. **Actual Cloudflare ↔ Docker restore/import parity requires
both runnable deployments and non-empty validation at that later milestone.**
FP does not claim Node/local availability merely because its interfaces allow it.
For the intended individual/research-group scale, PostgreSQL, Redis, Kubernetes
and distributed workers are not prerequisites. The longer-term order is in
[Long-term application roadmap](./LONG_TERM_ROADMAP.md).

### Search performance

Do not add FTS5 merely because source scanning is theoretically less scalable.
Add it when representative Project sidebar datasets or measured latency show a
real need.

The preferred optimization remains a rebuildable SQLite FTS5 candidate backend
that preserves existing ranking, lifecycle, resolver, and stable-target
contracts in D1 and compatible self-hosted SQLite.

### Permanent deletion and backlinks

Permanent deletion remains disabled through Project MVP. `project_items` creates
the natural reverse relation needed for future safety, but backlink counts and UI
are not required for alpha or MVP.

A later safety review may count distinct Projects, add conflict reporting,
privileged authorization, final concurrency checks, and tombstone creation.
Repeated occurrences in one Project must not be misrepresented as several
Projects.

### Quality and operations

Every schema phase preserves:

- fresh ordered migrations in host SQLite and D1/workerd;
- focused contract tests and complete test/build gates;
- complete export integrity;
- provider-verified content-addressed reuse with fail-closed outage behavior;
- no physical locator exposure;
- no unauthorized cross-layer mutation;
- isolated remote deployment requirements;
- an initial performance target around 200–300 nodes and 300–500 edges, with
  stress testing around 500 nodes and 800 edges.

## Later capabilities

Only after Project MVP and the deterministic read model are stable should the
roadmap consider:

- optional manual or edge-informed Reading ordering after real use;
- revision pinning to real source history;
- semantic or hybrid search;
- read-only LLM insight over explicit user-selected Project scope;
- suggested connections that require user confirmation;
- advanced consistency dashboards;
- real-time multi-user collaboration;
- advanced automatic layout and edge routing.

LLM insight is not an experimental-record editor, not an autonomous agent, and
not a hidden data-analysis subsystem. Any saved output becomes ordinary
Project-owned Markdown or attachment content only through explicit user action.

## Release milestones

| Milestone | Required capabilities and current state |
| --- | --- |
| Foundation → Project v1 shape | Earlier Project and backend fundamentals are delivered; retain their reference/Canvas/save/media regression behavior. |
| Integrated FP2–FP5 development | Native File/S3, bounded migration jobs, paired Sample+Project copy packages and system backup/restore **implemented, locally/remotely CI-qualified and merged** through #251; actual deployed/provider acceptance remains open. |
| C4 / 5D / 5E | Bounded local development completed; keep physical-device, OS-input and deployed-runtime acceptance gaps visible. |
| 5F integrated UX | In progress: ownership, narrow-grid, projection and explicit route-recovery repairs are integrated and qualified at `af8f374`. Built-Worker browser matrix passed 20 cases plus two Metrology pending-flow cases. Open #252 implements owner refresh and search-label corrections; current 20-case/cost/Project/physical evidence is recorded separately. `c06cb71` qualified the fresh 20-case matrix and both named Metrology cases plus stop/physical proof; final complete gates remain pending; initial Project GET Retry and three-owner refresh are the next separate product slices. Physical input/authenticated/provider acceptance stays open. |
| 6A6 / 6B | Combined-tree review, complete local/default remote gates and implementation merge passed at `af8f374` / `aa497d9`. Remaining serving/schema, physical-device, provider/operational and scoped release acceptance is open. |
| First integrated V3 release | Existing product plus **explicitly qualified enabled** FP2–FP5 scope. Capabilities awaiting live evidence remain unavailable/deferred rather than incorrectly marked unimplemented or enabled. |
| Portable runtime | Node/Docker/SQLite/local defaults with real volume/upgrade and cross-deployment recovery evidence. |
| Group collaboration | Small-group membership and complete resource authorization, after runtime/identity boundaries are qualified. |

## Immediate next PR order

1. Continue on merged **#251** integration `aa497d9`. Preserve exact validated
   `af8f374`/tree receipts, paired migrations `0018`–`0022` and V21–V24 readers,
   and historical failed/cancelled runs. #250 planning and inactive Drafts
   #199/#200 have been reviewed; do not adopt those old migration bridges.
2. Finish open **#252**: preserve `ee171339` matrix/cost/Project/physical receipts,
   preserve `c06cb71` fresh 20-case/named-pair/stop/physical qualification,
   then pass the final-head complete gate before reviewed integration.
   Follow with separate initial Project GET Retry and known three-owner group
   refresh PRs; their private candidate tests do not establish browser acceptance.
3. Continue remaining bounded **5F-1** (cross-page language/control), **5F-2** (read/retry, focus,
   uncertain-write and recovery identity), then **5F-3** (realistic integrated
   responsive/theme/accessibility and source-data workflows).
4. In parallel run the finite measured CI/performance/maintenance lane: first
   instrument cost, then address only demonstrated save, projection, refetch,
   archive or verification bottlenecks in separately reviewable changes.
5. Close **6A6**, then **6B** with a capability/acceptance matrix for every FP2–FP5
   feature proposed for enablement. Qualify exact real providers, migration
   execution, current-version nonempty recovery, fresh target provisioning,
   paused restored execution, physical input, live endpoints and handoff.
6. Prepare the integration-to-`main` release only for the **tested enabled scope**.
   Explicitly defer unsafe/unqualified capabilities at server-side gates; reconcile
   main ancestry, deployment runbook and unchanged previous File addresses.
7. After the release, plan complete Node/Docker local-volume distribution,
   cross-deployment portability, then group-wide resource authorization. Optional
   derivation/LLM/search features remain separate measured decisions.

## Work that should not happen next

The next phase should not be:

- more standalone Search-page product polish;
- a Text-first Project editor disconnected from Map occurrences;
- a mega-editor that owns references, attachments, and Canvas nodes internally;
- FTS5 synchronization before measured scale requires it;
- permanent-delete endpoints before the later safety review;
- live webpage iframe preview;
- real-time collaboration before the single-user save/revision model is stable;
- one unbounded whole-product visual mega-PR or global selector-normalization
  pass;
- treating the additive FP1k schema as runtime authority, skipping the shadow/
  catch-up ledger, or hiding capability changes inside behavior-preserving Phase
  6A/remaining Phase 5 PRs;
- a replacement V3 implementation or another long-lived integration branch;
- a repository-wide `apps/` / `packages/` / workspaces move without an independent
  build or distribution requirement;
- a Docker-specific fork or premature full deployment work before the reviewed
  file/configuration/job contracts;
- LLM features before the deterministic Project workflow is usable.

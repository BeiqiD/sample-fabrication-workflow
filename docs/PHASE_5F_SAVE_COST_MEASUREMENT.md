# Phase 5F synchronized placement-save measurement

Date: 2026-10-10. Status: the focused current-source 250/500-node save
characterization passes. This measurement does not qualify deployed latency,
complete Phase 5F, or authorize a new batch protocol by itself.

## Exact workload and command

Source HEAD at invocation:
`86369739160057f45ec8476b7778fdba9c79799d`. Concurrent unrelated Metrology edits
were present; the measured fixture, Project page and model files matched the
following committed blobs:

- `worker/backend-reliability-scale.test.ts`: `2ddab5f36c0719c99c239aca49f852eabf46be5e`
- `src/pages/ProjectPage.tsx`: `d77df0e7ce494ba48e46af8a6c86eb09f61cab7a`
- `src/lib/project-map-model.ts`: `9660772abe00ebb114299c99fbecbfd1d6de5969`

Command:

```sh
npx vitest run worker/backend-reliability-scale.test.ts --disableConsoleIntercept -t 'waits for every placement ACK'
```

The existing characterization builds fresh isolated in-memory SQLite databases
with the complete current ordered migrations and executes the actual Worker
routes through an instrumented D1 adapter. It mounts the real ProjectPage,
replacing only MapSurface with a semantic move-all button. It creates synthetic
Markdown Projects at 250 nodes/400 edges and 500 nodes/800 edges, moves every
placement once, explicitly saves, holds the final write response and then releases
it. `AUTH_MODE=disabled` is fixture-local. It uses no deployed endpoint, retained
development database, provider, storage activation or real researcher data.

Environment: cloud Linux x64, Node **v24.19.0**, Vitest **v4.1.10**, native
`node:sqlite`. `os.availableParallelism()` reported **4**. The default source
Vitest config was used, with **no worker-count or timeout override**; this one
selected file runs in one file worker. Its existing 30-second case limits and
20-second final-response wait limit were retained. The adapter executes every
SQL query and uses its existing 256-entry prepared-statement LRU. Migration and
fixture construction costs are outside the per-read/save timings below.

## Measured outcome

The selected leaf passed: **1 file / 2 tests**, with the three distinct-reference
characterization cases intentionally skipped by the title filter. Vitest start
time: **12:48:25 UTC**. Total run: **9.70 s**; measured test execution: **6.78 s**.

| Quantity | 250 nodes / 400 edges | 500 nodes / 800 edges |
| --- | ---: | ---: |
| HTTP-shaped requests through the local Worker | 251 | 501 |
| Placement PATCHes | 250 | 500 |
| Maximum save request concurrency | 1 | 1 |
| Snapshot GET SQL statements | 7 | 7 |
| Snapshot response bytes | 427,545 | 856,095 |
| Snapshot GET duration | 43.26 ms | 16.75 ms |
| Save SQL statements | 1,750 | 3,500 |
| Move/Save to held final response | 192.95 ms | 266.50 ms |
| Final ACK release to displayed Saved | 14.24 ms | 24.27 ms |

The tests assert exact response identity, every saved revision incrementing once,
every geometry change present in SQLite, one snapshot read, no extra placement
request, and no premature Saved while the final acknowledgement is held. These
assertions passed. The durations are one diagnostic run, not a statistical
browser/network performance budget. The 250-node read being slower than the
500-node read must not be converted into a monotonic scale claim.

The synchronized save path measured **7 SQL executions per PATCH**, versus the
historical earlier-code record's 3. Source inspection accounts for the current
path: the placement service reads its baseline, performs the conditional update
and reads the result; source maintenance checks schema presence, acquires a
request write lease and releases that lease; File execution admission reads the
installation's authority mode. This is source attribution consistent with the
measured total, not a separately captured per-statement timing trace. These
authority/recovery checks protect installed and restored execution and must not
be removed as redundant work.

Receipt: `/tmp/phase5f-save-cost-measurement.log`, SHA256
`e98fbdef433f375ea79680ed1afb408c9e656d29a440e5bc2d138e5120067246`.
Scratch receipts may disappear after environment replacement; actual counts and
conditions are preserved in this document.

## Decision boundary

The synchronized implementation still uses N serial placement PATCHes, with
per-placement revision and immutable operation identity. Local same-process
request cost is small in this run. It provides no actual browser-to-deployment
network trace, D1 round-trip latency or evidence that network requests dominate
current user-visible save time. Do not claim an improvement against the old
436/872 ms measurements, which used different source and measurement conditions.

Keep the existing serial contract while collecting an authenticated deployed or
representative named-network trace when available. A new batch geometry API
needs a separately reviewed bounded item limit, optimistic revisions, atomic or
partial-failure semantics, lost-ACK replay/settlement, stable retry identities,
edit-during-save behavior, undo and Saved/navigation ownership. Merely making
the current loop parallel changes its single attempted-mutation uncertainty
model and is not an accepted equivalent optimization.

## Next finite Processing instrumentation plan

This is a plan, **not implemented or tested scope reduction**. The current host
refresh reads primary plus additional Samples through Promise.all; the grid's
zero-target callback cannot distinguish isolated from shared operations.

1. Mount the actual ProcessingWorkspacePage and MultiSampleRunGrid at
   `/processing/sample-a?with=sample-b,sample-c,sample-d,sample-e,sample-f,sample-g,sample-h&run=run-a`.
   Build eight typed ProcessingSampleDetail fixtures with corresponding active
   runs, stable run group/family and matching logical Step keys. Keep unique
   Sample/run/Step identities, empty media and a known pending fabrication Step.
   Reuse existing actual-grid fixture shape and browser API stubs. Stub typed
   detail/mutation clients; reject any unplanned fetch.
2. Record API calls by operation phase and actual Sample ID. After the initial
   read, trigger the real individual Step Done action on one Sample, hold its
   write response, then return an updated detail fixture. Count the subsequent
   read identities and bytes/serialization separately. The baseline expected
   request count is eight; prove it with the actual host before narrowing.
3. Select an explicit three-Sample set and trigger the actual grouped Done
   control. Compare the frozen mutation targets with refresh read identities.
   Exercise a common comment submission/delete with a shared submission ID:
   deleting one displayed occurrence can affect other Samples. Unknown/shared
   deletion scope must continue using a full refresh unless its complete affected
   set is authoritatively known.
4. Measure an attachment-only change separately and preserve its strict refresh
   failure propagation, while ordinary `onSaved` keeps the existing read-error
   display plus resolved callback contract. Never pass a Sample ID to the current
   boolean `load(propagateError)` parameter.
5. Use deferred responses to qualify source changes, an older full read racing a
   narrower read, two simultaneous isolated changes and a current read failure.
   Verify unchanged Samples retain their existing objects/drafts, updated status
   reaches every affected column, old results cannot replace a newer workspace,
   and GET retries do not replay the write. Only then design an explicit affected
   Sample set with a full-refresh fallback and review it as another bounded slice.

This measurement introduced no production source changes and did not run another
complete verification gate.

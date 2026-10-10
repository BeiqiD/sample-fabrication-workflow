# Development goal: complete the roadmap through FP3

Status: completed for local development through FP3, 2026-10-05 (UTC).
Formal FP2/FP3 real-provider and deployed-runtime acceptance remains pending.
Owner direction received on 2026-10-05 (UTC).
Canonical scope remains [the product roadmap](./PRODUCT_ROADMAP.md) and
[the portability implementation plan](./FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md).
This document records execution and evidence; it does not redefine their exits.

## Goal and working authority

Continue independently through the remaining FP2 implementation and FP3 jobs
and migration, minimizing owner intervention. Work includes local code, additive
migrations, matched archive/recovery contracts, UI, documentation, meaningful
qualification, and fixes needed to obtain trustworthy development checks.

The owner has limited this environment to development. Production deployment,
remote production migrations, production data movement and messaging other people
are outside this goal. Local isolated provider fixtures are allowed. Real-provider
acceptance must remain explicitly pending until separately authorized test
resources are available; local mocks cannot close that roadmap evidence.

Resolve routine implementation choices from the reviewed architecture. Preserve
existing local work and historical data, frozen V7–V20 recovery, logical File and
business identities, authorization, exact target selection and full-byte hashing.
Record concrete blockers and continue unaffected work before requesting input.

## Ordered completion checklist

- [x] Inspect integration head `474a038` and preserve the FP2 lifecycle preparation.
- [x] Initialize the separate v2 local development database; preserve the main database.
- [x] Successor native File schema/address and accepted-target contracts, with matched
  nonempty export/offline recovery fixtures and paused restored execution.
- [x] Native exact-profile read/write/delete, verified publication and cleanup/GC.
- [x] Frozen per-file FabuBlox targets; all upload purposes survive default changes
  and lost responses without rerouting or replaying bytes.
- [x] FP2 tested-candidate activation, independent internal/original defaults,
  administrator authorization, failure reporting and Settings controls.
- [x] Record runtime/provider capability matrix and run the bounded transfer,
  streaming-hash and interrupted-output spike before implementing FP3 execution.
- [x] FP3 durable job/attempt/hold ledger, fresh-primary claims, fencing generations,
  independently invoked bounded dispatcher and explicit executor health.
- [x] Migration dry run, registered candidates, complete source/destination
  verification, guarded cutover, resumable per-file progress and safe cancellation.
- [x] Read/retention holds, source grace period, explicit cleanup, same-type and
  cross-type provider mapping, all five File purposes and concurrent read/delete.
- [x] Job APIs and usable administration UI; restart, missed dispatch, browser
  disconnect, lost acknowledgement, stale executor and revoked administrator tests.
- [x] Matched job recovery that preserves IDs/history and leaves execution paused.
- [x] Required development checks pass without weakened assertions or timeouts;
  roadmap/evidence distinguish implementation from external acceptance.

## Evidence history and final qualification

The preceding lifecycle slice passed 56 focused tests (37 new), all 625 mounted
UI tests and nine other CI leaves. Source qualification passed 2,558/2,570 tests
on its initial run under unintended process competition; all 99 tests in the
seven affected files passed sequentially with the original five-second limit.
The original failed command remains recorded.

The native-script gate initially cancelled metrology/archive and migration retry
tests at 240/120 seconds. Their independent fixture startup has since been fixed,
preserving the exact SQL, retained data/rowids and original assertions. Migration
staging now passes 6/6 in 109.35 seconds; metrology/archive passes 36/36 in 167.2
seconds with unchanged limits. Original failing command evidence is retained.

The native workerd transfer spike passed a 16 MiB R2-to-signed-S3 stream with
actual Crypto.DigestStream and FixedLengthStream, bounded 64 KiB hash writes,
independent destination hashing and corruption rejection (1/1, 5.08 seconds).
The persisted Node runner passed two separate process invocations against one
file-backed SQLite database, retained File IDs and current administrator
revocation (1/1, 2.72 seconds). Its disk transport is an isolated fixture, not a
Node R2 adapter or live-provider acceptance.

The initial local server on port 3000 and Samples/Projects/readiness requests returned
HTTP 200 against the v2 database with all 17 migrations. No production changes
or real-provider acceptance have occurred under this goal.

The remaining FP2/FP3 implementation and qualification are recorded in the
[local development checkpoint](./FP3_LOCAL_DEVELOPMENT_ACCEPTANCE.md). Actual
native populated D1 upgrade preserves old cells, rowids and pending receipts.
Six real-adapter migration fixtures pass, as do restored queued-job and cleanup
authorization tests. Independent cancellation review closed retry-after-cancel
and written-artifact hold-release gaps. Independent R2-instance workerd
qualification now passes, including unknown legacy retention and guarded source
deletion. The actual development upgrade preserves all original application
cells/rowids and the separate main database. Final check results are recorded below.

The first complete native-script gate recorded 347/349 passes; its two outdated
fixture expectations were repaired and independently reverified. The full source
run recorded 2,723/2,776 passes, exposing historical-schema compatibility,
admission projection and fixture defects. All 22 affected files then passed
271/271 tests. A final pre-File/native Sample compatibility block passed 16/16.
The native Comment byte comparison now checks the same complete 6 MiB payload
in 3.32 seconds instead of 29.45 seconds, without increasing its 30-second limit.
Original logs are `/tmp/fp3-full-ci.log` and `/tmp/fp3-source-full.log`; focused
results are `/tmp/fp3-source-affected-rerun.log` and
`/tmp/fp3-sample-compatibility-rerun.log`.

The canonical `npm run verify:ci`, with status publication disabled, recorded
11/12 successful leaves in `/tmp/fp3-full-ci-final.log` and
`/tmp/fp3-ci-summary-final.md`: native scripts 349/349, source 2,780/2,780 and
mounted UI 654/654. Its last artifact verifier still requested V20; correcting
that request to V22 exposed native D1's compound-SELECT limit in the combined
retention snapshot. The failed artifact rerun is retained in
`/tmp/fp3-project-worker-artifact-rerun.log`. The final repair materializes each
per-edge stream and combines it through indexed selector equality joins, retaining
every row and duplicate at the same source clock. It changes no migration DDL,
frozen identities, row limits, assertions or timeouts. Native D1 accepts the query;
15/15 retention regressions pass. A fresh build and the strict production-artifact
verifier pass in `/tmp/fp3-retention-selector-native-build.log` and
`/tmp/fp3-retention-selector-native-artifact.log`, including actual V22 export.
The final affected V21/V22 and business-route block passes 66/66 in
`/tmp/fp3-final-affected-export-routes.log`; contract typechecking and the Map
bundle check also pass against the final code/artifact.

All 12 required check categories have passing evidence, with the repaired final
leaf and affected regressions run separately after the canonical 11/12 run.
This records the failed full command honestly rather than claiming one clean
monolithic CI execution. The unchanged native/source/mounted full results remain
349/349, 2,780/2,780 and 654/654; new retention coverage is qualified separately.
Local development resumes on port 3000 with 19 migrations, intact original data,
disabled job execution and no cleanup grants. No production action occurred.

Update this checklist and append milestone evidence as work progresses. Do not
mark FP2 or FP3 accepted while an applicable exit remains unqualified.
